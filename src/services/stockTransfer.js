// =====================================================================
// stockTransfer.js — transferência de produto entre lojas (PDV)
// =====================================================================
// Move estoque de uma loja pra outra COM ACEITE do destino, espelhando o
// fluxo de venda. Só mexe em StoreStock (localização) via applyStoreStockDelta —
// NUNCA em ProductSize.stock (comprado). A NFe 55 de transferência é emitida em
// segundo plano (fire-and-forget) e NUNCA volta pro vendedor (tem o custo).
//
// Estados: in_transit (saiu da origem) → received (entrou no destino) | cancelled.
// Movimentos de estoque:
//   criar    → transfer_out  (−qtd na origem)
//   receber  → transfer_in   (+qtd no destino)
//   cancelar → transfer_cancel(+qtd de volta na origem)
// =====================================================================

const { prisma } = require('../middleware');
const { SaleStockError, resolveProductSize, applyStoreStockDelta } = require('./storeStockLedger');

// --------- helpers ---------
async function nextTransferCode(tx) {
  const max = await tx.stockTransfer.aggregate({ _max: { code: true } });
  return (max._max.code || 1000) + 1; // começa em 1001
}

// Carrega os produtos dos itens pedidos (com sizes) pra resolver o ProductSize
// exatamente como a venda faz (por productSizeId, barcode ou size).
async function loadItemsPlan(items) {
  if (!Array.isArray(items) || !items.length) throw new SaleStockError('Nenhum item na transferência.');
  const plan = [];
  for (const raw of items) {
    const qty = Math.trunc(Number(raw.quantity ?? raw.qty ?? 1));
    if (!Number.isInteger(qty) || qty <= 0) throw new SaleStockError('Quantidade inválida em um dos itens.');
    let product = null;
    if (raw.productId) {
      product = await prisma.product.findUnique({ where: { id: String(raw.productId) }, include: { sizes: true } });
    } else if (raw.barcode) {
      const ps = await prisma.productSize.findFirst({ where: { barcode: String(raw.barcode) }, select: { productId: true } });
      if (ps) product = await prisma.product.findUnique({ where: { id: ps.productId }, include: { sizes: true } });
    }
    if (!product) throw new SaleStockError('Produto não encontrado pra um dos itens (bipe/código).');
    const productSize = resolveProductSize(product, raw); // reaproveita a mesma resolução da venda
    plan.push({
      product, productSize, quantity: qty,
      snapshot: {
        productName: product.name || null,
        brand: product.brand || null,
        size: productSize.size || null,
        barcode: productSize.barcode || null,
        unitCost: product.costPrice ?? null,
        ncm: (product.ncm && /^\d{8}$/.test(product.ncm)) ? product.ncm : null,
      },
    });
  }
  return plan;
}

// --------- criar transferência (vendedor da origem) ---------
async function createTransfer({ fromStoreId, toStoreId, items, createdById, note }) {
  if (!fromStoreId) throw new SaleStockError('Loja de origem não informada.');
  if (!toStoreId) throw new SaleStockError('Escolha a loja de destino.');
  if (fromStoreId === toStoreId) throw new SaleStockError('Origem e destino não podem ser a mesma loja.');

  const [fromStore, toStore] = await Promise.all([
    prisma.store.findUnique({ where: { id: fromStoreId } }),
    prisma.store.findUnique({ where: { id: toStoreId } }),
  ]);
  if (!fromStore) throw new SaleStockError('Loja de origem inválida.');
  if (!toStore || !toStore.active) throw new SaleStockError('Loja de destino inválida ou inativa.');

  const plan = await loadItemsPlan(items);
  const qtyTotal = plan.reduce((s, p) => s + p.quantity, 0);

  const transfer = await prisma.$transaction(async (tx) => {
    const code = await nextTransferCode(tx);
    const t = await tx.stockTransfer.create({
      data: {
        code, fromStoreId, toStoreId, createdById,
        status: 'in_transit',
        note: note ? String(note).slice(0, 300) : null,
        itemsCount: plan.length, qtyTotal,
        fiscalStatus: 'pending',
        items: {
          create: plan.map((p) => ({
            productSizeId: p.productSize.id,
            quantity: p.quantity,
            ...p.snapshot,
          })),
        },
      },
      include: { items: true },
    });
    // Baixa da ORIGEM na hora (em trânsito). Destino só entra no aceite.
    for (const p of plan) {
      await applyStoreStockDelta(tx, {
        storeId: fromStoreId,
        productSizeId: p.productSize.id,
        quantity: -p.quantity,
        type: 'transfer_out',
        source: 'seller',
        reason: 'Transferência #' + code + ' → ' + (toStore.name || toStoreId),
        metadata: { transferId: t.id, code, toStoreId },
      });
    }
    return t;
  });

  // NOTA em segundo plano — NUNCA bloqueia, NUNCA volta pro vendedor.
  emitTransferNotaAsync(transfer.id).catch((e) => console.error('[stockTransfer] nota async erro:', e.message));

  return transfer;
}

// --------- receber (vendedor da loja destino) ---------
async function receiveTransfer({ transferId, receivedById, actorStoreIds }) {
  return prisma.$transaction(async (tx) => {
    const t = await tx.stockTransfer.findUnique({ where: { id: transferId }, include: { items: true } });
    if (!t) throw new SaleStockError('Transferência não encontrada.', 404);
    if (t.status !== 'in_transit') throw new SaleStockError('Essa transferência já foi ' + (t.status === 'received' ? 'recebida' : 'cancelada') + '.', 409);
    if (Array.isArray(actorStoreIds) && actorStoreIds.length && !actorStoreIds.includes(t.toStoreId)) {
      throw new SaleStockError('Só a loja de destino pode confirmar o recebimento.', 403);
    }
    for (const it of t.items) {
      await applyStoreStockDelta(tx, {
        storeId: t.toStoreId,
        productSizeId: it.productSizeId,
        quantity: it.quantity,
        type: 'transfer_in',
        source: 'seller',
        reason: 'Recebimento transferência #' + t.code,
        metadata: { transferId: t.id, code: t.code, fromStoreId: t.fromStoreId },
      });
    }
    return tx.stockTransfer.update({
      where: { id: t.id },
      data: { status: 'received', receivedById, receivedAt: new Date() },
      include: { items: true },
    });
  });
}

// --------- cancelar (origem, enquanto em trânsito) ---------
async function cancelTransfer({ transferId, actorStoreIds }) {
  return prisma.$transaction(async (tx) => {
    const t = await tx.stockTransfer.findUnique({ where: { id: transferId }, include: { items: true } });
    if (!t) throw new SaleStockError('Transferência não encontrada.', 404);
    if (t.status !== 'in_transit') throw new SaleStockError('Só dá pra cancelar enquanto está em trânsito.', 409);
    if (Array.isArray(actorStoreIds) && actorStoreIds.length && !actorStoreIds.includes(t.fromStoreId) && !actorStoreIds.includes(t.toStoreId)) {
      throw new SaleStockError('Só a loja de origem ou destino pode cancelar.', 403);
    }
    // Devolve o estoque pra ORIGEM (a baixa dela é desfeita).
    for (const it of t.items) {
      await applyStoreStockDelta(tx, {
        storeId: t.fromStoreId,
        productSizeId: it.productSizeId,
        quantity: it.quantity,
        type: 'transfer_cancel',
        source: 'seller',
        reason: 'Cancelamento transferência #' + t.code,
        metadata: { transferId: t.id, code: t.code },
      });
    }
    return tx.stockTransfer.update({
      where: { id: t.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
      include: { items: true },
    });
  });
}

// --------- NFe 55 de transferência (fire-and-forget, admin-only) ---------
// Emite pelo agente fiscal da loja ORIGEM (issuer da origem), destinatário = a
// loja DESTINO (CNPJ do grupo), CFOP transferência, valor = custo. Se qualquer
// coisa falhar, marca o motivo e SEGUE — a transferência já está valendo.
async function emitTransferNotaAsync(transferId) {
  const t = await prisma.stockTransfer.findUnique({ where: { id: transferId }, include: { items: true, fromStore: { include: { fiscalIssuer: true } }, toStore: { include: { fiscalIssuer: true } } } });
  if (!t) return;
  const fail = (status, msg) => prisma.stockTransfer.update({ where: { id: t.id }, data: { fiscalStatus: status, fiscalError: msg ? String(msg).slice(0, 300) : null } }).catch(() => {});

  const issuer = t.fromStore?.fiscalIssuer;
  const destIssuer = t.toStore?.fiscalIssuer;
  if (!issuer || !issuer.active) return fail('skipped', 'Loja origem sem emissor fiscal');
  if (!destIssuer?.cnpj) return fail('skipped', 'Loja destino sem CNPJ');
  const store = t.fromStore;
  const useAgent = store?.fiscalAgentEnabled && store?.fiscalAgentUrl && store?.fiscalAgentToken;
  if (!useAgent) return fail('skipped', 'Loja origem sem Fiscal Agent — transferência vale, nota pendente');

  // CFOP transferência: 5152 (mesmo estado) / 6152 (interestadual). Grupo é todo PB.
  const sameUf = (issuer.state || 'PB') === (destIssuer.state || 'PB');
  const cfop = sameUf ? '5152' : '6152';
  const items = t.items.map((it) => ({
    sku: it.barcode || it.productSizeId,
    name: it.productName || 'Produto',
    ncm: (it.ncm && /^\d{8}$/.test(it.ncm)) ? it.ncm : '64041100',
    cfop,
    unidade: 'UN',
    qty: it.quantity,
    unitPrice: Number(it.unitCost) > 0 ? Number(it.unitCost) : 0.01, // valor = custo (interno)
  }));
  if (items.some((i) => i.unitPrice <= 0.01)) {
    // Sem custo confiável a nota sai errada — melhor pendente do que nota errada.
    return fail('pending', 'Custo ausente em item(ns) — nota segura pra conferência');
  }

  try {
    const agentClient = require('./fiscalAgentClient');
    const maxDoc = await prisma.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFE', serie: issuer.nfeSerie || 1 }, _max: { number: true } });
    const nNF = Math.max(issuer.nfeNextNumber || 1, (maxDoc._max.number || 0) + 1);
    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId: issuer.id, docType: 'NFE', serie: issuer.nfeSerie || 1, number: nNF,
        status: 'processing',
        totalValue: items.reduce((s, i) => s + i.qty * i.unitPrice, 0),
        productIds: items.map((i) => i.sku),
        recipientName: (t.toStore?.name || destIssuer.companyName || 'Filial').slice(0, 60),
        recipientCnpjCpf: String(destIssuer.cnpj).replace(/\D/g, ''),
        payload: { transferId: t.id, transferCode: t.code, natOp: 'TRANSFERENCIA' },
      },
    });
    await prisma.stockTransfer.update({ where: { id: t.id }, data: { fiscalDocId: doc.id } });
    const result = await agentClient.emitNFe55(store, {
      issuer, nNF, tpNF: 1, natOp: 'TRANSFERENCIA ENTRE FILIAIS',
      customer: { cpfCnpj: String(destIssuer.cnpj).replace(/\D/g, ''), name: t.toStore?.name || destIssuer.companyName, indIEDest: destIssuer.ie ? '1' : '9', ie: destIssuer.ie || null, address: destIssuer },
      items,
      payment: { tPag: '90', valor: 0 }, // sem pagamento (transferência)
    });
    if (result.ok) {
      await prisma.fiscalDocument.update({ where: { id: doc.id }, data: { status: 'authorized', accessKey: result.accessKey, protocol: result.protocol, xmlContent: result.xmlSigned, response: { status: result.status, motivo: result.motivo } } });
      await prisma.fiscalIssuer.update({ where: { id: issuer.id }, data: { nfeNextNumber: nNF + 1 } });
      await prisma.stockTransfer.update({ where: { id: t.id }, data: { fiscalStatus: 'authorized', fiscalError: null } });
    } else if (result.accessKey) {
      await prisma.fiscalDocument.update({ where: { id: doc.id }, data: { status: 'rejected', accessKey: result.accessKey, rejectReason: result.motivo || 'Rejeitada', response: { status: result.status, motivo: result.motivo } } });
      await fail('rejected', result.motivo || 'Rejeitada pela SEFAZ');
    } else {
      await prisma.fiscalDocument.delete({ where: { id: doc.id } }).catch(() => {});
      await fail('error', result.motivo || result.error || 'Falha de transporte');
    }
  } catch (e) {
    await fail('error', e.message);
  }
}

module.exports = { createTransfer, receiveTransfer, cancelTransfer, emitTransferNotaAsync };
