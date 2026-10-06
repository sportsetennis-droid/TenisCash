// =====================================================================
// Routes: /api/admin/fiscal — Emissão de NFe / NFCe / CTe via Brasil NFe
// =====================================================================
// Endpoints administrativos pra emitir, consultar e cancelar documentos
// fiscais. Cada documento é vinculado a um FiscalIssuer (CNPJ emissor).
// =====================================================================

const express = require('express');
const path = require('node:path');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const fiscal = require('../services/fiscalApi');
const { applyStoreStockDelta } = require('../services/storeStockLedger');
const { ExchangeValidationError, normalizeAuthCode, sameSnapshot, exchangeRequest, priceExchange } = require('../services/exchangePricing');

const router = express.Router();
router.use(authMiddleware);

// Guard de papel: admin/superadmin/manager acessam tudo. O CAIXA (role store/seller),
// que opera o PDV (loja.html), só pode emitir o cupom da venda e imprimir o DANFE.
// Cancelar, CCe (correção), emissão avulsa e mexer em issuer continuam SÓ admin.
const CAIXA_FISCAL_OK = [
  ['POST', /^\/emit-nfce-from-sale\/?$/],
  ['GET', /^\/documents\/[^/]+\/print\/?$/],
  ['GET', /^\/documents\/[^/]+\/danfe\/?$/],
  // Botões do PDV (dono 2026-06-10): troca, cancelar cupom, 2ª via.
  // Cancelamento de caixa é restrito a NFC-e da própria loja (validado no handler).
  ['GET', /^\/troca\/cupons\/?$/],
  ['POST', /^\/troca\/?$/],
  ['POST', /^\/documents\/[^/]+\/cancel\/?$/],
  ['POST', /^\/documents\/[^/]+\/whatsapp\/?$/],
];
router.use((req, res, next) => {
  if (['admin', 'superadmin', 'manager'].includes(req.userRole)) return next();
  if (['seller', 'store'].includes(req.userRole) && CAIXA_FISCAL_OK.some(([m, re]) => m === req.method && re.test(req.path))) return next();
  return res.status(403).json({ error: 'Acesso restrito a administradores' });
});

// Dynamic import do módulo ESM fiscalSefazDirect (Node permite via import())
let _sefazDirect = null;
async function getSefazDirect() {
  if (!_sefazDirect) _sefazDirect = await import('../services/fiscalSefazDirect.mjs');
  return _sefazDirect;
}

// PFX path por CNPJ (resolve a partir do disco do servidor)
function pfxPathFor(cnpj) {
  // Convenção: o admin coloca em /c/Chianca/NFe_Emissao001/Certificado2026.pfx
  // Em produção pode-se mapear pra storage seguro via env
  if (cnpj === '44052617000126') return 'C:\\Chianca\\NFe_Emissao001\\Certificado2026.pfx';
  return process.env['PFX_PATH_' + cnpj] || null;
}
function pfxSenhaFor(cnpj) {
  if (cnpj === '44052617000126') return '123456';
  return process.env['PFX_SENHA_' + cnpj] || null;
}

// ============================================================
// Emissão NFCe a partir de uma Sale finalizada (vendedor pode usar)
// ============================================================
async function emitNfceFromSaleHandler(req, res) {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const { saleId, paymentMethod, cardBrand, cardAuthCode, tpIntegra, customerCpf, customerName } = req.body || {};
    let { acquirerKey } = req.body || {};
    if (!saleId) return res.status(400).json({ error: 'saleId obrigatório' });

    // Cartão (crédito 03 / débito 04): regras de conformidade SEFAZ-PB.
    const isCardPay = paymentMethod === '03' || paymentMethod === '04';
    // Auth/NSU do comprovante é OPCIONAL. Em maquininha NÃO integrada (tpIntegra=2) o
    // cAut é opcional no padrão NFC-e — se o vendedor digitar, entra na nota; se não,
    // o cupom emite sem cAut (buildDetPag OMITE o campo, nunca manda o placeholder
    // '000000' inválido). Assim a venda NUNCA trava por falta do código digitado.
    const _auth = normalizeAuthCode(cardAuthCode);
    if (isCardPay && !acquirerKey) {
      // DEFAULT da adquirente = PagBank/PagSeguro (pinpad físico das lojas). CNPJ 08561701000101.
      acquirerKey = 'PAGSEGURO';
    }

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        items: { include: { product: true } },
      },
    });
    if (!sale) return res.status(404).json({ error: 'Venda não encontrada' });

    // IDEMPOTÊNCIA — uma venda = no MÁXIMO um cupom. (Bug de dupla emissão pego na LOJA03 2026-06-04:
    // a mesma venda gerou #100001 e #100002.) Se já há cupom autorizado, devolve ele (não re-emite);
    // se há um 'processing' recente, outra emissão está em andamento → recusa o segundo.
    const existingDoc = await prisma.fiscalDocument.findFirst({
      where: { saleId: sale.id, docType: 'NFCE', status: { in: ['authorized', 'processing'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existingDoc) {
      if (existingDoc.status === 'authorized') {
        return res.json({ ok: true, alreadyEmitted: true, documentId: existingDoc.id, number: existingDoc.number, accessKey: existingDoc.accessKey, status: '100', message: 'Venda já possui cupom autorizado #' + existingDoc.number });
      }
      const ageMs = Date.now() - new Date(existingDoc.createdAt).getTime();
      if (ageMs < 95000) return res.status(409).json({ error: 'Emissão desta venda já está em andamento — aguarde alguns segundos', documentId: existingDoc.id });
      // 'processing' antigo (>95s, provavelmente travado): segue e tenta de novo
    }

    // Sale tem so o escalar `storeId` (nao a relacao `store`) — busca a Store separada.
    const store = sale.storeId
      ? await prisma.store.findUnique({ where: { id: sale.storeId }, include: { fiscalIssuer: true } })
      : null;

    // Resolve issuer pela loja da venda (Store → FiscalIssuer vinculado)
    let issuer = store?.fiscalIssuer;
    if (!issuer) {
      // Fallback: Baratão (matriz Meta Esportes) caso loja sem issuer vinculado
      issuer = await prisma.fiscalIssuer.findUnique({ where: { cnpj: '44052617000126' } });
    }
    if (!issuer || !issuer.active) return res.status(400).json({ error: 'Loja sem emissor fiscal vinculado' });
    if (!issuer.csc) return res.status(400).json({ error: 'Emissor ' + issuer.fantasyName + ' sem CSC cadastrado — gere no portal SEFAZ-PB primeiro' });

    // SEFAZ-PB: NFC-e >= R$500 EXIGE CPF/CNPJ do consumidor (rejeição "valor total
    // superior ao permitido p/ destinatário não identificado"). Trava aqui com
    // mensagem clara em vez de deixar a SEFAZ rejeitar.
    const _docCli = String(customerCpf || '').replace(/\D/g, '');
    const _docCliOk = _docCli.length === 11 || _docCli.length === 14;
    if (Number(sale.totalAmount) >= 500 && !_docCliOk) {
      return res.status(400).json({ needsCpf: true, error: 'Venda de R$ ' + Number(sale.totalAmount).toFixed(2) + ': a SEFAZ exige CPF/CNPJ do cliente na nota a partir de R$ 500. Peça o documento e preencha o campo CPF/CNPJ.' });
    }

    // NSU ÚNICO: um código de comprovante (cartão/PIX) só pode gerar UM cupom (1 transação = 1 nota).
    if (_auth) {
      const _nsu = _auth;
      const _nsuDup = await prisma.fiscalDocument.findFirst({ where: { issuerId: issuer.id, paymentAuthCode: _nsu, docType: 'NFCE', status: { in: ['authorized', 'processing'] }, saleId: { not: sale.id } } });
      if (_nsuDup) return res.status(409).json({ error: 'NSU/código ' + _nsu + ' já foi usado no cupom #' + _nsuDup.number + '. Cada transação de cartão/PIX gera UM cupom — passe de novo na maquininha pra um código novo.' });
    }

    // PFX só é necessário se a loja NÃO usa fiscal agent (agente tem PFX local)
    let pfxPath = null, pfxSenha = null;
    const willUseAgent = store?.fiscalAgentEnabled && store?.fiscalAgentUrl;
    if (!willUseAgent) {
      pfxPath = pfxPathFor(issuer.cnpj);
      pfxSenha = pfxSenhaFor(issuer.cnpj);
      if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado e Store sem Fiscal Agent — configure fiscalAgentUrl+Token na loja' });
    }

    // Items
    const items = sale.items.map((si) => ({
      sku: si.product?.sku || si.productId,
      name: si.product?.name || 'Produto',
      ncm: (si.product?.ncm && /^\d{8}$/.test(si.product.ncm)) ? si.product.ncm : '64041100',
      cfop: '5102', // NFC-e ao consumidor é venda interna — força 5102 (cadastro pode ter CFOP de compra/interestadual)
      unidade: si.product?.unidade || 'UN',
      qty: si.quantity,
      unitPrice: si.unitPrice,
    }));

    // Pagamento
    const tPagMap = paymentMethod || '01';
    const payment = {
      tPag: tPagMap,
      valor: sale.totalAmount,
      acquirerKey,
      tBand: cardBrand,
      cAut: _auth || undefined,
      tpIntegra: tpIntegra || 2,
    };

    // Número robusto: nunca abaixo do maior doc já gravado (blinda contra unique-constraint travado por fantasma)
    const maxDoc = await prisma.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFCE', serie: issuer.nfceSerie || 1 }, _max: { number: true } });
    const nNF = Math.max(issuer.nfceNextNumber || 1, (maxDoc._max.number || 0) + 1);

    // Pre-cria doc em processing
    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId: issuer.id,
        docType: 'NFCE',
        serie: issuer.nfceSerie || 1,
        number: nNF,
        status: 'processing',
        totalValue: sale.totalAmount,
        saleId: sale.id,
        productIds: items.map(i => i.sku),
        emittedById: req.userId,
        paymentMethod: tPagMap,
        paymentBrand: cardBrand || null,
        paymentAcquirer: acquirerKey || null,
        paymentAuthCode: _auth,
        paymentTpIntegra: tpIntegra || null,
        recipientCnpjCpf: _docCliOk ? _docCli : null,
        recipientName: _docCliOk && customerName ? String(customerName).slice(0, 60) : null,
      },
    });

    // Emite — via Fiscal Agent da loja (preferido) ou fallback SEFAZ direto
    const customerDest = _docCliOk ? { cpfCnpj: _docCli, name: customerName || null } : undefined;
    let result;
    const useAgent = store?.fiscalAgentEnabled && store?.fiscalAgentUrl;
    if (useAgent) {
      const agentClient = require('../services/fiscalAgentClient');
      result = await agentClient.emitNFCe(store, {
        issuer,
        items, payment,
        customer: customerDest,
        nNF,
      });
    } else {
      const { emitNFCe } = await getSefazDirect();
      result = await emitNFCe({
        issuer, pfxPath, pfxSenha, items, payment,
        customer: customerDest,
        nNF,
      });
    }

    // Sucesso: grava a nota e avanca a numeracao. Falha SEM chave (nunca chegou na SEFAZ):
    // apaga o doc pra LIBERAR o numero pro retry (nao acumula "fantasma" que trava o unique).
    let updated = doc;
    if (result.ok) {
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'authorized',
          accessKey: result.accessKey,
          protocol: result.protocol,
          xmlContent: result.xmlSigned,
          response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
        },
      });
      await prisma.fiscalIssuer.update({
        where: { id: issuer.id },
        data: { nfceNextNumber: nNF + 1 },
      });
      // Cupom NÃO vai mais sozinho pro WhatsApp — o vendedor envia pelo botão "📲 Enviar" (decisão do dono 2026-06-19).
    } else if (result.accessKey) {
      // Rejeitada PELA SEFAZ (tem chave) — mantem como rejected pra auditoria
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'rejected',
          accessKey: result.accessKey,
          rejectReason: result.motivo || 'Rejeitada',
          response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
        },
      });
    } else {
      // Falhou ANTES da SEFAZ (rede/agente) — apaga pra liberar o numero pro retry
      await prisma.fiscalDocument.delete({ where: { id: doc.id } }).catch(() => {});
    }

    res.json({
      ok: result.ok,
      documentId: updated.id,
      accessKey: result.accessKey,
      protocol: result.protocol,
      status: result.status,
      motivo: result.motivo,
      rejectReason: result.ok ? null : result.motivo,
      error: result.ok ? null : result.motivo,
    });
  } catch (err) {
    console.error('[fiscal/emit-nfce-from-sale]', err);
    res.status(500).json({ error: err.message });
  }
}
router.post('/emit-nfce-from-sale', emitNfceFromSaleHandler);

// ============================================================
// TROCA (PDV) — devolução NFe55 referenciada + cupom novo com
// Crédito Loja + diferença. A diferença negociada ajusta os preços apenas
// desta venda; o cupom e os pagamentos sempre refletem o mesmo total.
// ============================================================
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const TPAG_TO_SALEPAY = { '01': 'cash', '03': 'credit_card', '04': 'debit_card', '17': 'pix' };

// Cupons autorizados recentes da loja (pro caixa escolher o original da troca / cancelar / 2ª via)
router.get('/troca/cupons', async (req, res) => {
  try {
    const { storeId, q } = req.query;
    if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });
    const store = await prisma.store.findUnique({ where: { id: storeId }, include: { fiscalIssuer: true } });
    if (!store?.fiscalIssuer) return res.status(400).json({ error: 'Loja sem emissor fiscal' });
    const where = { issuerId: store.fiscalIssuer.id, docType: 'NFCE', status: 'authorized' };
    if (q && /^\d+$/.test(String(q).trim())) where.number = parseInt(String(q).trim(), 10);
    const docs = await prisma.fiscalDocument.findMany({ where, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, number: true, serie: true, accessKey: true, totalValue: true, createdAt: true, saleId: true, paymentMethod: true } });
    const saleIds = docs.map(d => d.saleId).filter(Boolean);
    const sales = saleIds.length ? await prisma.sale.findMany({ where: { id: { in: saleIds } }, include: { items: true } }) : [];
    const byId = Object.fromEntries(sales.map(s => [s.id, s]));
    const previousReturns = docs.length ? await prisma.fiscalDocument.findMany({
      where: { issuerId: store.fiscalIssuer.id, docType: 'NFE', status: { in: ['authorized', 'processing'] }, OR: docs.map(d => ({ response: { path: ['troca', 'originalDocId'], equals: d.id } })) },
      select: { response: true },
    }) : [];
    const returnedByItem = {};
    for (const d of previousReturns) for (const item of d.response?.troca?.returned || []) {
      returnedByItem[item.saleItemId] = (returnedByItem[item.saleItemId] || 0) + item.qty;
    }
    res.json({
      cupons: docs.filter(d => byId[d.saleId]?.storeId === store.id).map(d => ({
        docId: d.id, number: d.number, serie: d.serie, accessKey: d.accessKey,
        totalValue: d.totalValue, createdAt: d.createdAt, saleId: d.saleId, paymentMethod: d.paymentMethod,
        items: (byId[d.saleId]?.items || []).map(i => ({ saleItemId: i.id, productId: i.productId, productName: i.productName, size: i.size, quantity: i.quantity, unitPrice: i.unitPrice, returnedQuantity: returnedByItem[i.id] || 0, availableQuantity: Math.max(0, i.quantity - (returnedByItem[i.id] || 0)) })),
      })),
    });
  } catch (err) {
    console.error('[fiscal/troca/cupons]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/troca', async (req, res) => {
  const retryState = {};
  let pendingReturnId = null;
  try {
    const { storeId, originalDocId, returned, newItems, diffAmount, diffPayment, devolucaoDocId, saleId, customerCpf, customerName } = req.body || {};
    if (!storeId || !originalDocId) return res.status(400).json({ error: 'storeId e originalDocId obrigatórios' });
    if (!Array.isArray(returned) || !returned.length) return res.status(400).json({ error: 'Marque o que o cliente devolveu' });
    if (!Array.isArray(newItems) || !newItems.length) return res.status(400).json({ error: 'Bipe o que o cliente levou' });
    const requestSnapshot = exchangeRequest({ returned, newItems, diffAmount });
    if (['seller', 'store'].includes(req.userRole)) {
      const allowedStores = [req.authUser?.storeId, ...(req.authUser?.storeIds || [])].filter(Boolean);
      if (!allowedStores.includes(storeId)) return res.status(403).json({ error: 'Loja não autorizada para este operador' });
    }

    const store = await prisma.store.findUnique({ where: { id: storeId }, include: { fiscalIssuer: true } });
    const issuer = store?.fiscalIssuer;
    if (!issuer?.active) return res.status(400).json({ error: 'Loja sem emissor fiscal ativo' });
    if (!store.fiscalAgentEnabled || !store.fiscalAgentUrl || !store.fiscalAgentToken) return res.status(400).json({ error: 'Loja sem agente fiscal configurado' });

    const origDoc = await prisma.fiscalDocument.findUnique({ where: { id: originalDocId } });
    if (!origDoc || origDoc.docType !== 'NFCE' || origDoc.status !== 'authorized' || !origDoc.accessKey) {
      return res.status(400).json({ error: 'Cupom original precisa ser um NFC-e AUTORIZADO' });
    }
    if (origDoc.issuerId !== issuer.id) return res.status(403).json({ error: 'Cupom original é de outra loja' });
    if (!origDoc.saleId) return res.status(400).json({ error: 'Cupom original sem venda vinculada — troca manual só pelo admin' });
    const origSale = await prisma.sale.findUnique({ where: { id: origDoc.saleId }, include: { items: true } });
    if (!origSale) return res.status(400).json({ error: 'Venda do cupom original não encontrada' });
    if (origSale.storeId !== store.id) return res.status(403).json({ error: 'Venda original é de outra loja' });

    // Uma retomada só pode usar a própria devolução e o mesmo acordo já emitido.
    let devDoc = devolucaoDocId ? await prisma.fiscalDocument.findUnique({ where: { id: devolucaoDocId } }) : null;
    if (devolucaoDocId && (!devDoc || devDoc.issuerId !== issuer.id || devDoc.docType !== 'NFE' || devDoc.status !== 'authorized'
      || devDoc.response?.troca?.originalDocId !== originalDocId)) {
      return res.status(409).json({ error: 'A devolução informada não pertence a esta troca autorizada' });
    }
    if (saleId && !devDoc) return res.status(409).json({ error: 'Informe a devolução autorizada para retomar a venda da troca' });
    if (devDoc) retryState.devolucaoDocId = devDoc.id;
    const savedExchange = devDoc?.response?.troca;
    if (savedExchange) {
      const savedReturned = [...(savedExchange.returned || [])].sort((a, b) => a.saleItemId.localeCompare(b.saleItemId));
      if (!sameSnapshot(savedReturned, requestSnapshot.returned)
        || (savedExchange.request && !sameSnapshot(savedExchange.request, requestSnapshot))) {
        return res.status(409).json({ error: 'A devolução já foi autorizada. Retome com os mesmos produtos, quantidades e diferença' });
      }
      if (!savedExchange.request && diffAmount != null) return res.status(409).json({ error: 'Esta devolução antiga não permite alterar a diferença na retomada' });
    }
    const exchangeSaleKey = devDoc ? 'exchange:' + devDoc.id : null;
    let newSale = saleId
      ? await prisma.sale.findUnique({ where: { id: saleId }, include: { items: true } })
      : (exchangeSaleKey ? await prisma.sale.findUnique({ where: { idemKey: exchangeSaleKey }, include: { items: true } }) : null);
    if (saleId && (!newSale || newSale.storeId !== store.id || (newSale.idemKey !== exchangeSaleKey && savedExchange?.saleId !== newSale.id))) {
      return res.status(409).json({ error: 'A venda informada não pertence a esta troca e loja' });
    }
    if (newSale) retryState.saleId = newSale.id;

    // ---- DEVOLVIDOS: validar contra a venda original (preço NUNCA vem do cliente) ----
    // Cap anti-dupla-troca: o já devolvido em trocas anteriores deste cupom sai do saldo.
    const prevDevs = await prisma.fiscalDocument.findMany({
      where: { issuerId: issuer.id, docType: 'NFE', status: { in: ['authorized', 'processing'] }, ...(devDoc ? { id: { not: devDoc.id } } : {}), response: { path: ['troca', 'originalDocId'], equals: originalDocId } },
      select: { id: true, response: true },
    });
    const prevQty = {};
    for (const d of prevDevs) for (const it of (d.response?.troca?.returned || [])) prevQty[it.saleItemId] = (prevQty[it.saleItemId] || 0) + (it.qty || 0);

    const retItems = [];
    for (const r of requestSnapshot.returned) {
      const si = origSale.items.find(i => i.id === r.saleItemId);
      const qty = r.qty;
      if (!si || qty < 1) return res.status(400).json({ error: 'Item devolvido inválido' });
      const restante = si.quantity - (prevQty[si.id] || 0);
      if (qty > restante) return res.status(400).json({ error: si.productName + ': só ' + restante + ' un disponível pra devolver (vendido ' + si.quantity + ', já devolvido ' + (prevQty[si.id] || 0) + ')' });
      // SaleItem já contém o preço líquido. Uma devolução parcial absorve
      // somente o centavo restante da quantidade efetivamente devolvida.
      const savedReturn = savedExchange?.returnPrices?.find(item => item.saleItemId === si.id);
      const returnedValue = savedReturn ? savedReturn.total : r2(r2(((prevQty[si.id] || 0) + qty) * si.unitPrice) - r2((prevQty[si.id] || 0) * si.unitPrice));
      retItems.push({ saleItem: si, qty, unitPrice: returnedValue / qty, total: returnedValue });
    }
    const returnedTotal = r2(retItems.reduce((s, r) => s + r.total, 0));

    // ---- NOVOS: resolver pelo código de barras; preço = preço de VENDA do card ----
    let newResolved = [];
    for (const n of requestSnapshot.newItems) {
      const qty = n.qty;
      const code = n.barcode ? String(n.barcode).trim() : '';
      let ps = code ? await prisma.productSize.findFirst({ where: { barcode: code }, include: { product: true } }) : null;
      if (!ps && code) {
        const internalProduct = await prisma.product.findUnique({
          where: { internalBarcode: code },
          include: { sizes: { orderBy: { size: 'asc' } } },
        });
        if (internalProduct) {
          const requestedSize = n.size == null ? '' : String(n.size).trim().toLowerCase();
          const selectedSize = requestedSize
            ? internalProduct.sizes.find((s) => String(s.size || '').trim().toLowerCase() === requestedSize)
            : (internalProduct.sizes.length === 1 ? internalProduct.sizes[0] : null);
          if (!selectedSize) {
            return res.status(400).json({ error: 'CÃ³digo interno reconhecido para ' + internalProduct.name + '; informe o tamanho/numeraÃ§Ã£o para concluir a venda', needsSize: true, internalBarcode: code, sizes: internalProduct.sizes.map((s) => s.size) });
          }
          ps = { ...selectedSize, product: internalProduct };
        }
      }
      if (!ps?.product) return res.status(400).json({ error: 'Código ' + (n.barcode || '?') + ' não cadastrado — bipe um produto do catálogo' });
      const savedItem = savedExchange?.catalogItems?.find(item => item.productSizeId === ps.id);
      if (savedExchange?.catalogItems && !savedItem) return res.status(409).json({ error: 'O código agora aponta para outra variante. A retomada da troca foi bloqueada' });
      const price = savedItem ? savedItem.price : ((ps.product.promoPrice > 0 ? ps.product.promoPrice : ps.product.price) || 0);
      if (price <= 0) return res.status(400).json({ error: ps.product.name + ' sem preço de venda — ajuste o preço antes de vender' });
      newResolved.push({ ps, product: ps.product, qty, price: r2(price) });
    }
    const catalogItems = newResolved.map(n => ({ productId: n.product.id, productSizeId: n.ps.id, qty: n.qty, price: n.price }));
    const pricing = priceExchange(newResolved, returnedTotal, requestSnapshot.diffAmount);
    newResolved = pricing.items;
    const { newTotal, diff, credit, vale, ...pricingAudit } = pricing;
    delete pricingAudit.items;
    const exchangeAudit = {
      originalDocId, originalSaleId: origSale.id, storeId: store.id,
      returned: requestSnapshot.returned, request: requestSnapshot, catalogItems,
      returnPrices: retItems.map(r => ({ saleItemId: r.saleItem.id, qty: r.qty, total: r.total, unitPrice: r.unitPrice })),
      pricing: { ...pricingAudit, newTotal, diff, credit, vale },
      agreedById: savedExchange?.agreedById || req.userId,
    };
    if (savedExchange?.pricing && !sameSnapshot(savedExchange.pricing, exchangeAudit.pricing)) {
      return res.status(409).json({ error: 'Os valores da troca divergiram da devolução autorizada. A retomada foi bloqueada' });
    }
    if (newSale) {
      const key = item => [item.productSizeId, item.quantity, r2(item.unitPrice), r2(item.totalPrice)].join('|');
      const expected = newResolved.map(n => key({ productSizeId: n.ps.id, quantity: n.qty, unitPrice: n.price, totalPrice: r2(n.qty * n.price) })).sort();
      if (newSale.storeId !== store.id || newSale.status !== 'completed' || r2(newSale.totalAmount) !== newTotal
        || JSON.stringify(newSale.items.map(key).sort()) !== JSON.stringify(expected)) {
        return res.status(409).json({ error: 'Produtos ou valores diferentes da venda de troca já registrada' });
      }
      const existingCupom = await prisma.fiscalDocument.findFirst({ where: { saleId: newSale.id, docType: 'NFCE', status: { in: ['authorized', 'processing'] } }, orderBy: { createdAt: 'desc' } });
      if (existingCupom?.status === 'authorized') return res.json({
        ok: true, alreadyEmitted: true,
        devolucao: { docId: devDoc.id, number: devDoc.number, accessKey: devDoc.accessKey },
        cupom: { docId: existingCupom.id, number: existingCupom.number, accessKey: existingCupom.accessKey },
        saleId: newSale.id, valores: { devolvido: returnedTotal, novos: newTotal, diferenca: Math.max(0, diff), vale },
      });
      if (existingCupom) return res.status(409).json({ error: 'O cupom desta troca está em processamento. Consulte o documento antes de reenviar', documentId: existingCupom.id });
    }

    // SEFAZ-PB: cupom (mesmo de troca) >= R$500 exige CPF/CNPJ do consumidor.
    const _docCli = String(customerCpf || '').replace(/\D/g, '');
    const _docCliOk = _docCli.length === 11 || _docCli.length === 14;
    if (newTotal >= 500 && !_docCliOk) {
      return res.status(400).json({ needsCpf: true, error: 'Cupom novo de R$ ' + newTotal.toFixed(2) + ': a SEFAZ exige CPF/CNPJ do cliente na nota a partir de R$ 500. Preencha o campo CPF/CNPJ.' });
    }

    // ---- pagamentos do cupom novo: Crédito Loja (05) + diferença ----
    const payments = [{ tPag: '05', valor: credit }];
    const dp = diffPayment || {};
    const paymentAuthCode = diff > 0 ? normalizeAuthCode(dp.cardAuthCode) : null;
    if (diff > 0) {
      if (!dp.tPag) return res.status(400).json({ error: 'Diferença de ' + diff.toFixed(2) + ' — informe a forma de pagamento' });
      if (!TPAG_TO_SALEPAY[dp.tPag]) return res.status(400).json({ error: 'Forma de pagamento da diferença inválida' });
      const isCard = ['03', '04', '17'].includes(dp.tPag);
      // Auth/NSU opcional (igual ao cupom normal): se vier entra na nota, senão emite sem cAut.
      const _dpAuth = paymentAuthCode;
      if (_dpAuth) {
        const _nsuDup = await prisma.fiscalDocument.findFirst({ where: { issuerId: issuer.id, paymentAuthCode: _dpAuth, docType: 'NFCE', status: { in: ['authorized', 'processing'] }, ...(newSale ? { OR: [{ saleId: null }, { saleId: { not: newSale.id } }] } : {}) } });
        if (_nsuDup) return res.status(409).json({ error: 'NSU/código ' + _dpAuth + ' já foi usado no cupom #' + _nsuDup.number });
      }
      payments.push({ tPag: dp.tPag, valor: diff, tBand: dp.cardBrand, cAut: _dpAuth || undefined, acquirerKey: isCard ? (dp.acquirerKey || 'PAGSEGURO') : dp.acquirerKey, tpIntegra: 2 });
    }

    const agentClient = require('../services/fiscalAgentClient');

    // ============ PASSO 1 — NFe de DEVOLUÇÃO (entrada, referencia o cupom) ============
    if (!devDoc) {
      const retProdIds = retItems.map(r => r.saleItem.productId).filter(Boolean);
      const retProds = retProdIds.length ? await prisma.product.findMany({ where: { id: { in: retProdIds } } }) : [];
      const prodById = Object.fromEntries(retProds.map(p => [p.id, p]));
      devDoc = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${origSale.id} FOR UPDATE`;
        const reserved = await tx.fiscalDocument.findMany({ where: { issuerId: issuer.id, docType: 'NFE', status: { in: ['authorized', 'processing'] }, response: { path: ['troca', 'originalDocId'], equals: originalDocId } }, select: { response: true } });
        const reservedQty = {};
        for (const doc of reserved) for (const item of doc.response?.troca?.returned || []) reservedQty[item.saleItemId] = (reservedQty[item.saleItemId] || 0) + item.qty;
        for (const item of retItems) {
          if ((reservedQty[item.saleItem.id] || 0) !== (prevQty[item.saleItem.id] || 0)) throw new ExchangeValidationError('Outra troca alterou o saldo do cupom. Atualize os produtos devolvidos antes de emitir', 409);
        }
        const maxNfe = await tx.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFE', serie: issuer.nfeSerie || 1 }, _max: { number: true } });
        const nextNumber = Math.max(issuer.nfeNextNumber || 1, (maxNfe._max.number || 0) + 1);
        return tx.fiscalDocument.create({
        data: {
          issuerId: issuer.id, docType: 'NFE', serie: issuer.nfeSerie || 1, number: nextNumber,
          status: 'processing', totalValue: returnedTotal,
          recipientName: issuer.companyName, recipientCnpjCpf: issuer.cnpj,
          emittedById: req.userId, paymentMethod: '90',
          productIds: retItems.map(r => r.saleItem.productId || r.saleItem.productName),
          response: { troca: { ...exchangeAudit, stockApplied: false } },
        },
        });
      });
      const nNF55 = devDoc.number;
      pendingReturnId = devDoc.id;

      const devResult = await agentClient.emitNFe55(store, {
        issuer, nNF: nNF55, finNFe: 4, tpNF: 0, refNFe: origDoc.accessKey, natOp: 'DEVOLUCAO DE VENDA',
        customer: {
          cpfCnpj: issuer.cnpj, name: issuer.companyName, ie: issuer.ie, indIEDest: '1', indPres: 0,
          addr: { xLgr: issuer.street, nro: issuer.number, xBairro: issuer.neighborhood, cMun: issuer.cityCode, xMun: issuer.city, UF: issuer.state, CEP: issuer.zip },
        },
        items: retItems.map(r => {
          const p = r.saleItem.productId ? prodById[r.saleItem.productId] : null;
          return {
            sku: p?.sku || r.saleItem.productId || 'DEV', name: ('DEVOLUCAO ' + r.saleItem.productName).slice(0, 110),
            ncm: (p?.ncm && /^\d{8}$/.test(p.ncm)) ? p.ncm : '64041100',
            cfop: '1202', unidade: 'UN', qty: r.qty, unitPrice: r.unitPrice,
          };
        }),
        payment: { tPag: '90', valor: 0 },
      });

      if (!(devResult.ok && String(devResult.status) === '100')) {
        if (devResult.transmitError || devResult.error === 'agent timeout') {
          await prisma.fiscalDocument.update({ where: { id: devDoc.id }, data: { ...(devResult.accessKey ? { accessKey: devResult.accessKey } : {}), response: { ...devDoc.response, error: devResult.error || devResult.motivo || 'Resultado fiscal desconhecido' } } });
          return res.json({ ok: false, step: 'devolucao', pendingConfirmation: true, documentId: devDoc.id, error: 'Não foi possível confirmar a autorização da devolução. Consulte este documento antes de reenviar' });
        }
        if (devResult.accessKey) {
          await prisma.fiscalDocument.update({ where: { id: devDoc.id }, data: { status: 'rejected', accessKey: devResult.accessKey, rejectReason: devResult.motivo || devResult.error || 'Rejeitada', response: { status: devResult.status, motivo: devResult.motivo, troca: { ...exchangeAudit, stockApplied: false } } } });
        } else {
          await prisma.fiscalDocument.delete({ where: { id: devDoc.id } }).catch(() => {});
        }
        // 200 + ok:false de propósito: o api() do PDV descarta o corpo em HTTP de erro
        return res.json({ ok: false, step: 'devolucao', error: 'Devolução não autorizada: ' + (devResult.motivo || devResult.error || devResult.status) });
      }

      devDoc = await prisma.fiscalDocument.update({
        where: { id: devDoc.id },
        data: {
          status: 'authorized', accessKey: devResult.accessKey, protocol: devResult.protocol, xmlContent: devResult.xmlSigned,
          response: {
            status: devResult.status, motivo: devResult.motivo,
            troca: { ...exchangeAudit, stockApplied: false },
          },
        },
      });
      pendingReturnId = null;
      retryState.devolucaoDocId = devDoc.id;
      await prisma.fiscalIssuer.update({ where: { id: issuer.id }, data: { nfeNextNumber: nNF55 + 1 } });
    }

    // Estoque: devolvido volta pra LOCALIZAÇÃO da loja (StoreStock). Comprado intocado (regra do dono).
    if (!devDoc.response?.troca?.stockApplied) {
      await prisma.$transaction(async (tx) => {
        // A condição é reavaliada pelo banco depois do lock da linha. Dois
        // retries simultâneos não podem devolver a mesma unidade duas vezes.
        const claimed = await tx.fiscalDocument.updateMany({
          where: { id: devDoc.id, status: 'authorized', response: { path: ['troca', 'stockApplied'], equals: false } },
          data: { response: { ...devDoc.response, troca: { ...devDoc.response.troca, stockApplied: true } } },
        });
        if (!claimed.count) return;
        for (const r of retItems) {
          let productSizeId = r.saleItem.productSizeId;
          if (!productSizeId && r.saleItem.productId && r.saleItem.size) {
            const ps = await tx.productSize.findFirst({ where: { productId: r.saleItem.productId, size: r.saleItem.size }, select: { id: true } });
            productSizeId = ps?.id || null;
          }
          if (!productSizeId) continue;
          await applyStoreStockDelta(tx, {
            storeId: store.id,
            productSizeId,
            saleId: origSale.id,
            quantity: r.qty,
            type: 'exchange_return',
            source: 'fiscal_exchange_api',
            metadata: { originalDocId, devolucaoDocId: devDoc.id, saleItemId: r.saleItem.id },
          });
        }
      });
    }

    // ============ PASSO 2 — venda nova + cupom novo (preços acordados, Crédito Loja + diferença) ============
    if (!newSale) {
      newSale = await prisma.$transaction(async (tx) => {
        const created = await tx.sale.create({
          data: {
            sellerId: req.userId, storeId: store.id, totalAmount: newTotal,
            idemKey: 'exchange:' + devDoc.id,
            paymentMethod: diff > 0 ? (TPAG_TO_SALEPAY[diffPayment.tPag] || 'other') : 'troca',
            status: 'completed', tcUsed: 0, tcEarned: 0,
            note: 'TROCA do cupom #' + origDoc.number + ' — devolvido R$' + returnedTotal.toFixed(2) + (vale ? (' (vale R$' + vale.toFixed(2) + ')') : '')
              + (pricing.overridden ? ('; diferença informada R$' + diff.toFixed(2) + '; ajuste local R$' + pricing.adjustment.toFixed(2)) : ''),
            items: { create: newResolved.map(n => ({ productId: n.product.id, productSizeId: n.ps.id, productName: n.product.name, brand: n.product.brand || '', size: n.ps.size || null, quantity: n.qty, unitPrice: n.price, totalPrice: r2(n.qty * n.price), unitCost: n.product.costPrice > 0 ? n.product.costPrice : null })) },
          },
          include: { items: true },
        });
        for (const item of created.items) {
          await applyStoreStockDelta(tx, {
            storeId: store.id,
            productSizeId: item.productSizeId,
            saleId: created.id,
            saleItemId: item.id,
            quantity: -item.quantity,
            type: 'exchange_sale',
            source: 'fiscal_exchange_api',
            metadata: { originalSaleId: origSale.id, originalDocId, devolucaoDocId: devDoc.id },
          });
        }
        await tx.fiscalDocument.update({ where: { id: devDoc.id }, data: { response: { ...devDoc.response, troca: { ...exchangeAudit, stockApplied: true, saleId: created.id } } } });
        return created;
      });
    }
    retryState.saleId = newSale.id;

    const cupomReservation = await prisma.$transaction(async (tx) => {
      // A venda é o lock durável da emissão. A chamada ao agente só ocorre
      // depois de confirmar a reserva; nenhuma transação segura a rede aberta.
      await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${newSale.id} FOR UPDATE`;
      const existing = await tx.fiscalDocument.findFirst({ where: { saleId: newSale.id, docType: 'NFCE', status: { in: ['authorized', 'processing'] } }, orderBy: { createdAt: 'desc' } });
      if (existing) return { existing };
      const agreedPayment = diff > 0 ? TPAG_TO_SALEPAY[dp.tPag] : 'troca';
      if (newSale.paymentMethod !== agreedPayment) await tx.sale.update({ where: { id: newSale.id }, data: { paymentMethod: agreedPayment } });
      const maxNfce = await tx.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFCE', serie: issuer.nfceSerie || 1 }, _max: { number: true } });
      const nextNumber = Math.max(issuer.nfceNextNumber || 1, (maxNfce._max.number || 0) + 1);
      const doc = await tx.fiscalDocument.create({
      data: {
        issuerId: issuer.id, docType: 'NFCE', serie: issuer.nfceSerie || 1, number: nextNumber,
        status: 'processing', totalValue: newTotal, saleId: newSale.id,
        productIds: newResolved.map(n => n.product.sku || n.product.id),
        emittedById: req.userId,
        paymentMethod: diff > 0 ? diffPayment.tPag : '05',
        paymentBrand: diff > 0 ? (diffPayment.cardBrand || null) : null,
        paymentAcquirer: diff > 0 ? (diffPayment.acquirerKey || null) : null,
        paymentAuthCode,
        paymentTpIntegra: diff > 0 ? 2 : null,
        recipientCnpjCpf: _docCliOk ? _docCli : null,
        recipientName: _docCliOk && customerName ? String(customerName).slice(0, 60) : null,
        response: { troca: { ...exchangeAudit, devolucaoDocId: devDoc.id, saleId: newSale.id } },
      },
      });
      return { doc };
    });
    if (cupomReservation.existing) {
      const existing = cupomReservation.existing;
      if (existing.status !== 'authorized') return res.status(409).json({ error: 'O cupom desta troca está em processamento. Consulte o documento antes de reenviar', documentId: existing.id });
      return res.json({ ok: true, alreadyEmitted: true, devolucao: { docId: devDoc.id, number: devDoc.number, accessKey: devDoc.accessKey }, cupom: { docId: existing.id, number: existing.number, accessKey: existing.accessKey }, saleId: newSale.id, valores: { devolvido: returnedTotal, novos: newTotal, diferenca: Math.max(0, diff), vale } });
    }
    const cupomDoc = cupomReservation.doc;
    const nNF = cupomDoc.number;
    retryState.documentId = cupomDoc.id;

    const cupomResult = await agentClient.emitNFCe(store, {
      issuer, nNF,
      items: newResolved.map(n => ({ sku: n.product.sku || n.product.id, name: n.product.name, ncm: (n.product.ncm && /^\d{8}$/.test(n.product.ncm)) ? n.product.ncm : '64041100', cfop: '5102', unidade: 'UN', qty: n.qty, unitPrice: n.price })),
      payments,
      customer: _docCliOk ? { cpfCnpj: _docCli, name: customerName || null } : undefined,
    });

    if (!(cupomResult.ok && String(cupomResult.status) === '100')) {
      if (cupomResult.transmitError || cupomResult.error === 'agent timeout') {
        await prisma.fiscalDocument.update({ where: { id: cupomDoc.id }, data: { ...(cupomResult.accessKey ? { accessKey: cupomResult.accessKey } : {}), response: { ...cupomDoc.response, error: cupomResult.error || cupomResult.motivo || 'Resultado fiscal desconhecido' } } });
        return res.json({ ok: false, step: 'cupom', ...retryState, pendingConfirmation: true, error: 'Não foi possível confirmar a autorização do cupom da troca. Consulte este documento antes de reenviar' });
      }
      if (cupomResult.accessKey) {
        await prisma.fiscalDocument.update({ where: { id: cupomDoc.id }, data: { status: 'rejected', accessKey: cupomResult.accessKey, rejectReason: cupomResult.motivo || cupomResult.error || 'Rejeitada', response: { status: cupomResult.status, motivo: cupomResult.motivo, troca: { ...exchangeAudit, devolucaoDocId: devDoc.id, saleId: newSale.id } } } });
      } else {
        await prisma.fiscalDocument.delete({ where: { id: cupomDoc.id } }).catch(() => {});
      }
      // devolução JÁ saiu — devolve os ids pro PDV re-tentar SÓ o cupom (sem duplicar nada).
      // 200 + ok:false de propósito: o api() do PDV descarta o corpo em HTTP de erro.
      return res.json({ ok: false, step: 'cupom', devolucaoDocId: devDoc.id, saleId: newSale.id, error: 'Devolução OK, mas o cupom novo falhou: ' + (cupomResult.motivo || cupomResult.error || cupomResult.status) + ' — toque em EMITIR de novo (não duplica a devolução)' });
    }

    const cupomOk = await prisma.fiscalDocument.update({
      where: { id: cupomDoc.id },
      data: {
        status: 'authorized', accessKey: cupomResult.accessKey, protocol: cupomResult.protocol, xmlContent: cupomResult.xmlSigned,
        response: { status: cupomResult.status, motivo: cupomResult.motivo, troca: { ...exchangeAudit, devolucaoDocId: devDoc.id, saleId: newSale.id, credit, diff } },
      },
    });
    await prisma.fiscalIssuer.update({ where: { id: issuer.id }, data: { nfceNextNumber: nNF + 1 } });

    res.json({
      ok: true,
      devolucao: { docId: devDoc.id, number: devDoc.number, accessKey: devDoc.accessKey },
      cupom: { docId: cupomOk.id, number: cupomOk.number, accessKey: cupomOk.accessKey },
      saleId: newSale.id,
      valores: { devolvido: returnedTotal, novos: newTotal, diferenca: diff > 0 ? diff : 0, vale },
    });
  } catch (err) {
    console.error('[fiscal/troca]', err);
    if (pendingReturnId) return res.json({ ok: false, step: 'devolucao', pendingConfirmation: true, documentId: pendingReturnId, error: 'Não foi possível confirmar a autorização da devolução. Consulte este documento antes de reenviar. ' + err.message });
    if (retryState.devolucaoDocId && !(err instanceof ExchangeValidationError)) return res.json({ ok: false, step: 'cupom', ...retryState, pendingConfirmation: Boolean(retryState.documentId), error: 'A devolução já foi autorizada e a troca ficou pendente. ' + (retryState.documentId ? 'Consulte o cupom antes de reenviar. ' : 'Retome a mesma troca. ') + err.message });
    res.status(err instanceof ExchangeValidationError ? err.statusCode : 500).json({ error: err.message });
  }
});

// ============================================================
// Cancelamento — registrado ANTES do adminMiddleware pro caixa
// alcançar (o guard CAIXA_FISCAL_OK limita o papel; aqui limita
// o ESCOPO: caixa só cancela NFC-e). Janela legal quem valida é
// a SEFAZ (NFC-e ~30min) — o erro dela volta literal pro PDV.
// Emite o evento via AGENTE da loja (Railway não tem PFX local).
// ============================================================
router.post('/documents/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!reason || reason.length < 15) return res.status(400).json({ error: 'Justificativa deve ter 15+ caracteres (regra SEFAZ)' });

    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
    if (doc.status !== 'authorized') return res.status(400).json({ error: 'Só documentos autorizados podem ser cancelados (status atual: ' + doc.status + ')' });
    if (!doc.accessKey || !doc.protocol) return res.status(400).json({ error: 'Documento sem chave/protocolo — não pode cancelar' });
    if (doc.docType !== 'NFCE' && doc.docType !== 'NFE') return res.status(400).json({ error: 'Cancelamento direto SEFAZ suporta só NFCe e NFe (tipo: ' + doc.docType + ')' });
    if (!['admin', 'superadmin', 'manager'].includes(req.userRole) && doc.docType !== 'NFCE') {
      return res.status(403).json({ error: 'Caixa só cancela cupom (NFC-e) — NFe modelo 55 é com o admin' });
    }

    const store = await prisma.store.findFirst({ where: { fiscalIssuerId: doc.issuerId } });
    let result;
    if (store?.fiscalAgentEnabled && store?.fiscalAgentUrl) {
      const agentClient = require('../services/fiscalAgentClient');
      result = await agentClient.cancel(store, { issuer: doc.issuer, accessKey: doc.accessKey, protocol: doc.protocol, reason });
    } else {
      const pfxPath = pfxPathFor(doc.issuer.cnpj);
      const pfxSenha = pfxSenhaFor(doc.issuer.cnpj);
      if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado pra esse CNPJ' });
      const { cancelDocument } = await getSefazDirect();
      result = await cancelDocument({ issuer: doc.issuer, pfxPath, pfxSenha, accessKey: doc.accessKey, protocol: doc.protocol, reason });
    }

    if (result.ok) {
      await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: reason,
          cancelProtocol: result.cancelProtocol || null,
          response: { ...(doc.response || {}), cancel: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) } },
        },
      });
      return res.json({ ok: true, cancelProtocol: result.cancelProtocol, motivo: result.motivo });
    }
    res.status(400).json({
      error: result.motivo || result.error || 'Erro ao cancelar',
      status: result.status,
      detail: result.rawResponse?.slice(0, 1000),
    });
  } catch (err) {
    console.error('[fiscal/cancel]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Emissão NFe modelo 55 (B2C/B2B com destinatário) — payload livre.
// Útil pra ecommerce Nuvemshop, vendas a clubes/escolas, B2B.
// ============================================================
router.post('/emit-nfe55', async (req, res) => {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const b = req.body || {};
    const { issuerId, items, customer, payment, natOp, saleId, nuvemshopOrderId } = b;
    if (!items?.length) return res.status(400).json({ error: 'items obrigatório' });
    if (!customer?.cpfCnpj) return res.status(400).json({ error: 'customer.cpfCnpj obrigatório pra modelo 55' });
    if (!payment) return res.status(400).json({ error: 'payment obrigatório' });

    let issuer;
    if (issuerId) {
      issuer = await prisma.fiscalIssuer.findUnique({ where: { id: issuerId } });
    } else {
      // Default: Sports & Tennis ecommerce (filial 0004-79)
      issuer = await prisma.fiscalIssuer.findFirst({
        where: { cnpj: '44052617000479', active: true },
      });
    }
    if (!issuer || !issuer.active) return res.status(400).json({ error: 'Emissor não encontrado/inativo' });

    // Resolve a Store do issuer (Store → FiscalIssuer). Se a loja tem Fiscal Agent
    // habilitado, emite via agente (Tailscale + PFX local) — igual NFC-e. Senão,
    // mantém SEFAZ-direto com PFX em disco como fallback.
    const store = await prisma.store.findFirst({ where: { fiscalIssuerId: issuer.id } });
    const useAgent = store?.fiscalAgentEnabled && store?.fiscalAgentUrl && store?.fiscalAgentToken;

    // IDEMPOTÊNCIA — mesma venda/pedido = no MÁXIMO uma NFe 55. Se já há doc NFE
    // autorizado pra esse saleId (ou mesmo nuvemshopOrderId), devolve ele e NÃO re-emite.
    const dedupeOr = [];
    if (saleId) dedupeOr.push({ saleId });
    if (nuvemshopOrderId) dedupeOr.push({ payload: { path: ['nuvemshopOrderId'], equals: String(nuvemshopOrderId) } });
    if (dedupeOr.length) {
      const existingDoc = await prisma.fiscalDocument.findFirst({
        where: { docType: 'NFE', status: { in: ['authorized', 'processing'] }, OR: dedupeOr },
        orderBy: { createdAt: 'desc' },
      });
      if (existingDoc) {
        if (existingDoc.status === 'authorized') {
          return res.json({ ok: true, alreadyEmitted: true, documentId: existingDoc.id, number: existingDoc.number, accessKey: existingDoc.accessKey, status: '100', message: 'Pedido já possui NFe autorizada #' + existingDoc.number });
        }
        const ageMs = Date.now() - new Date(existingDoc.createdAt).getTime();
        if (ageMs < 95000) return res.status(409).json({ error: 'Emissão desta NFe já está em andamento — aguarde alguns segundos', documentId: existingDoc.id });
        // 'processing' antigo (>95s, provavelmente travado): segue e tenta de novo
      }
    }

    // PFX só é necessário se a loja NÃO usa fiscal agent (agente tem PFX local)
    let pfxPath = null, pfxSenha = null;
    if (!useAgent) {
      pfxPath = pfxPathFor(issuer.cnpj);
      pfxSenha = pfxSenhaFor(issuer.cnpj);
      if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado e Store sem Fiscal Agent — configure fiscalAgentUrl+Token na loja' });
    }

    // Número robusto: nunca abaixo do maior doc já gravado (blinda contra unique-constraint travado por fantasma)
    const maxDoc = await prisma.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFE', serie: issuer.nfeSerie || 1 }, _max: { number: true } });
    const nNF = Math.max(issuer.nfeNextNumber || 1, (maxDoc._max.number || 0) + 1);

    // Pre-cria doc em processing
    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId: issuer.id,
        docType: 'NFE',
        serie: issuer.nfeSerie || 1,
        number: nNF,
        status: 'processing',
        totalValue: items.reduce((acc, i) => acc + (Number(i.qty) || 1) * (Number(i.unitPrice) || 0), 0),
        saleId: saleId || null,
        productIds: items.map(i => i.sku || i.id),
        emittedById: req.userId,
        recipientName: customer.name || null,
        recipientCnpjCpf: String(customer.cpfCnpj).replace(/\D/g, ''),
        recipientEmail: customer.email || null,
        paymentMethod: payment.tPag || null,
        paymentBrand: payment.tBand || null,
        paymentAcquirer: payment.acquirerKey || null,
        paymentAuthCode: payment.cAut || null,
        paymentTpIntegra: payment.tpIntegra || null,
        payload: nuvemshopOrderId ? { nuvemshopOrderId: String(nuvemshopOrderId) } : null,
      },
    });

    // Emite — via Fiscal Agent da loja (preferido) ou fallback SEFAZ direto
    let result;
    if (useAgent) {
      const agentClient = require('../services/fiscalAgentClient');
      result = await agentClient.emitNFe55(store, {
        issuer, items,
        payment: { ...payment, nuvemshopOrderId },
        customer, natOp,
        nNF,
      });
    } else {
      const { emitNFe55 } = await getSefazDirect();
      result = await emitNFe55({
        issuer, pfxPath, pfxSenha, items,
        payment: { ...payment, nuvemshopOrderId },
        customer, natOp,
        nNF,
      });
    }

    // Sucesso: grava a nota e avanca a numeracao. Falha SEM chave (nunca chegou na SEFAZ):
    // apaga o doc pra LIBERAR o numero pro retry (nao acumula "fantasma" que trava o unique).
    let updated = doc;
    if (result.ok) {
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'authorized',
          accessKey: result.accessKey,
          protocol: result.protocol,
          xmlContent: result.xmlSigned,
          response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
        },
      });
      await prisma.fiscalIssuer.update({
        where: { id: issuer.id },
        data: { nfeNextNumber: nNF + 1 },
      });
    } else if (result.accessKey) {
      // Rejeitada PELA SEFAZ (tem chave) — mantem como rejected pra auditoria
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'rejected',
          accessKey: result.accessKey,
          rejectReason: result.motivo || 'Rejeitada',
          response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
        },
      });
    } else {
      // Falhou ANTES da SEFAZ (rede/agente) — apaga pra liberar o numero pro retry
      await prisma.fiscalDocument.delete({ where: { id: doc.id } }).catch(() => {});
    }

    res.json({
      ok: result.ok,
      documentId: updated.id,
      accessKey: result.accessKey,
      protocol: result.protocol,
      status: result.status,
      motivo: result.motivo,
      rejectReason: result.ok ? null : (result.motivo || result.error),
      error: result.ok ? null : (result.motivo || result.error),
    });
  } catch (err) {
    console.error('[fiscal/emit-nfe55]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Finalizar NFe modelo 55 que foi pré-criada como draft (vinda de webhook
// Nuvemshop). Pega o draft, monta items do Sale, customer do payload e
// emite via emitNFe55. 1-click pra operadora.
// ============================================================
router.post('/finalize-nfe-draft/:id', async (req, res) => {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: {
        issuer: true,
        sale: { include: { items: { include: { product: true } } } },
      },
    });
    if (!doc) return res.status(404).json({ error: 'FiscalDocument não encontrado' });
    if (doc.docType !== 'NFE') return res.status(400).json({ error: 'Endpoint só pra NFe modelo 55 (draft.docType=NFE)' });
    if (doc.status !== 'draft') return res.status(400).json({ error: 'Documento não está em draft (atual: ' + doc.status + ')' });
    if (!doc.sale?.items?.length) return res.status(400).json({ error: 'Draft sem itens vinculados (sale.items vazia)' });

    const issuer = doc.issuer;
    if (!issuer.active) return res.status(400).json({ error: 'Emissor inativo' });

    // Resolve a Store do issuer → roteia via Fiscal Agent (PFX local da loja) quando
    // habilitado; senão SEFAZ-direto com PFX em disco (fallback intacto).
    const store = await prisma.store.findFirst({ where: { fiscalIssuerId: issuer.id } });
    const useAgent = store?.fiscalAgentEnabled && store?.fiscalAgentUrl && store?.fiscalAgentToken;

    // IDEMPOTÊNCIA — se já existe OUTRA NFE autorizada pra essa mesma venda/pedido,
    // não finaliza o draft de novo (devolve a existente). Exclui o próprio doc.
    const dedupeOr = [];
    if (doc.saleId) dedupeOr.push({ saleId: doc.saleId });
    const orderId = doc.payload?.orderId;
    if (orderId) dedupeOr.push({ payload: { path: ['orderId'], equals: orderId } });
    if (dedupeOr.length) {
      const existingDoc = await prisma.fiscalDocument.findFirst({
        where: { id: { not: doc.id }, docType: 'NFE', status: 'authorized', OR: dedupeOr },
        orderBy: { createdAt: 'desc' },
      });
      if (existingDoc) {
        return res.json({ ok: true, alreadyEmitted: true, documentId: existingDoc.id, number: existingDoc.number, accessKey: existingDoc.accessKey, status: '100', message: 'Pedido já possui NFe autorizada #' + existingDoc.number });
      }
    }

    let pfxPath = null, pfxSenha = null;
    if (!useAgent) {
      pfxPath = pfxPathFor(issuer.cnpj);
      pfxSenha = pfxSenhaFor(issuer.cnpj);
      if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado e Store sem Fiscal Agent — configure fiscalAgentUrl+Token na loja' });
    }

    // Items vindos da Sale
    const items = doc.sale.items.map((si) => ({
      sku: si.product?.sku || si.productId,
      name: si.product?.name || 'Produto',
      ncm: si.product?.ncm || '64041100',
      cfop: si.product?.cfop || null, // emitNFe55 escolhe 5102/6102 conforme UF
      unidade: si.product?.unidade || 'UN',
      qty: si.quantity,
      unitPrice: si.unitPrice,
      ean: si.product?.ean || null,
    }));

    // Customer reconstruído do payload do webhook
    const recipientPayload = doc.payload?.recipient || {};
    const addrSrc = recipientPayload.address || {};
    if (!doc.recipientCnpjCpf) {
      return res.status(400).json({ error: 'Draft sem CPF/CNPJ do destinatário — necessário pra NFe 55' });
    }
    const customer = {
      cpfCnpj: doc.recipientCnpjCpf,
      name: doc.recipientName || recipientPayload.name,
      email: doc.recipientEmail || recipientPayload.email,
      addr: addrSrc.street ? {
        xLgr: addrSrc.street,
        nro: addrSrc.number || 'S/N',
        xCpl: addrSrc.complement,
        xBairro: addrSrc.neighborhood,
        xMun: addrSrc.city,
        UF: addrSrc.state,
        CEP: addrSrc.zip,
        cMun: addrSrc.cityCode, // emitNFe55 cai em 2507507 (JP) se vazio
      } : null,
      indPres: 2, // operação não-presencial pela internet
    };

    // Pagamento — Nuvemshop normalmente é cartão online; pega gateway pra tPag adequado
    const payment = {
      tPag: doc.paymentMethod || '99', // 99=outros se não souber
      valor: doc.totalValue,
      modFrete: 2, // por conta do destinatário (e-commerce)
      xPed: doc.payload?.orderNumber ? String(doc.payload.orderNumber) : null,
      nuvemshopOrderId: doc.payload?.orderId || null,
    };

    // Numeração robusta: recalcula no momento de emitir (não confia no doc.number congelado no webhook,
    // que pode colidir se 2 pedidos viraram draft com o mesmo nfeNextNumber). Espelha o NFC-e.
    const maxDoc = await prisma.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFE', serie: issuer.nfeSerie || 1 }, _max: { number: true } });
    const nNF = Math.max(issuer.nfeNextNumber || 1, (maxDoc._max.number || 0) + 1);

    // Marca processing antes de chamar SEFAZ (idempotência)
    await prisma.fiscalDocument.update({
      where: { id: doc.id },
      data: { status: 'processing' },
    });

    // Emite — via Fiscal Agent da loja (preferido) ou fallback SEFAZ direto
    let result;
    if (useAgent) {
      const agentClient = require('../services/fiscalAgentClient');
      result = await agentClient.emitNFe55(store, {
        issuer, items, customer, payment,
        nNF,
      });
    } else {
      const { emitNFe55 } = await getSefazDirect();
      result = await emitNFe55({
        issuer, pfxPath, pfxSenha, items, customer, payment,
        nNF,
      });
    }

    let updated = doc;
    if (result.ok || result.accessKey) {
      // Autorizada, ou rejeitada PELA SEFAZ (tem chave) → grava o desfecho
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          number: nNF,
          status: result.ok ? 'authorized' : 'rejected',
          accessKey: result.accessKey,
          protocol: result.protocol,
          rejectReason: result.ok ? null : (result.motivo || 'Erro desconhecido'),
          xmlContent: result.xmlSigned,
          response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
        },
      });
      if (result.ok) {
        await prisma.fiscalIssuer.update({
          where: { id: issuer.id },
          data: { nfeNextNumber: nNF + 1 },
        });
      }
    } else {
      // Falhou ANTES da SEFAZ (rede/agente) — volta pra draft pra permitir retry
      // (não deleta: preserva o payload do webhook Nuvemshop)
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: { status: 'draft', rejectReason: (result.motivo || result.error || 'Falha de transmissão').slice(0, 250) },
      });
    }

    res.json({
      ok: result.ok,
      documentId: updated.id,
      accessKey: result.accessKey,
      protocol: result.protocol,
      status: result.status,
      motivo: result.motivo,
      rejectReason: result.ok ? null : (result.motivo || result.error),
      error: result.ok ? null : (result.motivo || result.error),
    });
  } catch (err) {
    console.error('[fiscal/finalize-nfe-draft]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DANFE PDF — gera localmente a partir do XML autorizado (acessível por seller)
// ============================================================
let _spedPdf = null;
async function getSpedPdf() {
  if (!_spedPdf) _spedPdf = await import('node-sped-pdf');
  return _spedPdf;
}

// Monta o nfeProc (NFe assinada + protNFe) a partir do doc autorizado, pra a DANFE
// mostrar o PROTOCOLO. O xmlContent guarda só a NFe assinada (sem protNFe); o protocolo
// real fica em doc.protocol no banco. Sem isso, a DANFE sai com "Protocolo 00000000".
function buildNfeProcForDanfe(signedXml, doc) {
  try {
    if (!signedXml || signedXml.includes('<protNFe') || signedXml.includes('<nfeProc')) return signedXml;
    if (!doc || !doc.protocol || !doc.accessKey) return signedXml;
    const nfe = signedXml.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/i, '');
    const dig = (nfe.match(/<DigestValue>([^<]*)<\/DigestValue>/) || [])[1] || '';
    const tpAmb = (doc.issuer && doc.issuer.environment === 'production') ? '1' : '2';
    const dt = doc.createdAt ? new Date(doc.createdAt) : new Date();
    const dhRecbto = new Date(dt.getTime() - 3 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '-03:00');
    const protNFe = '<protNFe versao="4.00"><infProt><tpAmb>' + tpAmb + '</tpAmb><verAplic>SVRS</verAplic><chNFe>' + doc.accessKey + '</chNFe><dhRecbto>' + dhRecbto + '</dhRecbto><nProt>' + doc.protocol + '</nProt><digVal>' + dig + '</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>';
    return '<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' + nfe + protNFe + '</nfeProc>';
  } catch (e) { return signedXml; }
}

router.get('/documents/:id/danfe', async (req, res) => {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Não encontrado' });
    if (!doc.xmlContent) return res.status(400).json({ error: 'Documento sem XML armazenado' });
    if (doc.status !== 'authorized' && doc.status !== 'cancelled') {
      return res.status(400).json({ error: 'Documento não autorizado (status: ' + doc.status + ')' });
    }

    const { DANFCe, DANFe } = await getSpedPdf();
    const fn = doc.docType === 'NFCE' ? DANFCe : DANFe;
    // DANFE mostra o NOME FANTASIA (a marca, ex "Baratão dos Esportes") no cabeçalho,
    // no lugar da razão social — SÓ na impressão. O XML assinado/enviado à SEFAZ
    // mantém a razão social (xNome) intacta, como exige a lei.
    let renderXml = doc.xmlContent;
    const razao = doc.issuer?.companyName, fant = doc.issuer?.fantasyName;
    if (razao && fant && fant !== razao && renderXml.includes('<xNome>' + razao + '</xNome>')) {
      renderXml = renderXml.replace('<xNome>' + razao + '</xNome>', '<xNome>' + fant + '</xNome>');
    }
    // Envolve a NFe assinada num nfeProc com o protNFe (protocolo vem do banco) — sem isso
    // a DANFE imprime "Protocolo 000000000000000". Só afeta a impressão, não o XML da SEFAZ.
    renderXml = buildNfeProcForDanfe(renderXml, doc);
    const pdfBuffer = await fn({
      xml: renderXml,
      // logo: opcional — URL da logo Sports & Tennis se quiser
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="danfe-${doc.docType}-${doc.number}.pdf"`,
      'Cache-Control': 'private, max-age=300',
    });
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('[fiscal/danfe]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Cupom térmico em HTML (80mm) — ver src/services/cupomThermal.js.
// Imprime na altura do conteúdo (impressora corta no fim); área útil 62mm
// calibrada pra TM-T20X; números em negrito. O PDF legal continua em
// /documents/:id/danfe.
// ============================================================
const { buildCupomThermalHtml } = require('../services/cupomThermal');

router.get('/documents/:id/print', async (req, res) => {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const doc = await prisma.fiscalDocument.findUnique({ where: { id: req.params.id }, include: { issuer: true } });
    if (!doc) return res.status(404).send('Documento não encontrado');
    if (!doc.xmlContent) return res.status(400).send('Documento sem XML armazenado');
    if (doc.status !== 'authorized' && doc.status !== 'cancelled') return res.status(400).send('Documento não autorizado');
    const html = await buildCupomThermalHtml(doc);
    res.type('text/html').send(html);
  } catch (err) {
    console.error('[fiscal/print]', err);
    res.status(500).send('Erro ao gerar cupom: ' + err.message);
  }
});

// Enviar o cupom pro WhatsApp do cliente (o caixa toca o botão = aprovação humana).
// Manda a nota como LINK público /nota/<chave> (sem token; o cliente abre e salva/imprime).
router.post('/documents/:id/whatsapp', async (req, res) => {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 13) return res.status(400).json({ error: 'WhatsApp do cliente inválido — informe com DDD' });

    const doc = await prisma.fiscalDocument.findUnique({ where: { id: req.params.id }, include: { issuer: true } });
    if (!doc) return res.status(404).json({ error: 'Cupom não encontrado' });
    if (doc.status !== 'authorized' || !doc.accessKey) return res.status(400).json({ error: 'Só cupom autorizado pode ser enviado' });

    const { deliverCupom } = require('../services/cupomDelivery');
    const out = await deliverCupom(doc, phone, { prisma, force: true }); // botão = sempre manda
    if (!out.ok) return res.status(502).json({ ok: false, error: out.error || 'Falha ao enviar no WhatsApp' });
    res.json({ ok: true, via: out.via, provider: out.provider, phone: out.phone });
  } catch (err) {
    console.error('[fiscal/whatsapp]', err);
    res.status(500).json({ error: err.message });
  }
});

// As rotas a seguir são admin-only
router.use(adminMiddleware);

// ============================================================
// CRUD de emissores (FiscalIssuer)
// ============================================================

router.get('/issuers', async (_req, res) => {
  try {
    const issuers = await prisma.fiscalIssuer.findMany({
      orderBy: { companyName: 'asc' },
      select: {
        id: true, cnpj: true, companyName: true, fantasyName: true, ie: true, im: true,
        environment: true, crt: true, active: true,
        nfeSerie: true, nfeNextNumber: true, nfceSerie: true, nfceNextNumber: true,
        // NÃO retorna apiToken/csc por segurança
      },
    });
    res.json({ issuers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/issuers', async (req, res) => {
  try {
    const b = req.body || {};
    const cnpj = String(b.cnpj || '').replace(/\D/g, '');
    if (!/^\d{14}$/.test(cnpj)) return res.status(400).json({ error: 'CNPJ inválido (14 dígitos)' });
    const issuer = await prisma.fiscalIssuer.create({
      data: {
        cnpj,
        companyName: String(b.companyName || '').trim(),
        fantasyName: b.fantasyName || null,
        ie: b.ie || null,
        im: b.im || null,
        street: b.street || null,
        number: b.number || null,
        complement: b.complement || null,
        neighborhood: b.neighborhood || null,
        cityCode: b.cityCode || null,
        city: b.city || null,
        state: b.state || null,
        zip: b.zip || null,
        phone: b.phone || null,
        apiToken: b.apiToken || null,
        environment: b.environment === 'production' ? 'production' : 'homologation',
        csc: b.csc || null,
        cscId: b.cscId || null,
        crt: parseInt(b.crt, 10) || 1,
      },
    });
    res.json({ issuer: { ...issuer, apiToken: undefined, csc: undefined } });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'CNPJ já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/issuers/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    ['companyName','fantasyName','ie','im','street','number','complement','neighborhood','cityCode','city','state','zip','phone','apiToken','csc','cscId','notes'].forEach(k => {
      if (b[k] !== undefined) data[k] = b[k] ? String(b[k]) : null;
    });
    if (b.environment) data.environment = b.environment === 'production' ? 'production' : 'homologation';
    if (b.crt !== undefined) data.crt = parseInt(b.crt, 10) || 1;
    if (b.active !== undefined) data.active = !!b.active;
    const issuer = await prisma.fiscalIssuer.update({ where: { id: req.params.id }, data });
    res.json({ issuer: { ...issuer, apiToken: undefined, csc: undefined } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Listagem de documentos emitidos
// ============================================================

router.get('/documents', async (req, res) => {
  try {
    const { issuerId, docType, status, search } = req.query;
    const where = {
      ...(issuerId ? { issuerId } : {}),
      ...(docType ? { docType } : {}),
      ...(status ? { status } : {}),
      ...(search ? {
        OR: [
          { accessKey: { contains: search } },
          { recipientName: { contains: search, mode: 'insensitive' } },
          { recipientCnpjCpf: { contains: search } },
        ],
      } : {}),
    };
    const docs = await prisma.fiscalDocument.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { issuer: { select: { companyName: true, cnpj: true } } },
    });
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/documents/:id', async (req, res) => {
  try {
    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Emissão NFCe (venda presencial — loja física)
// ============================================================

router.post('/nfce', async (req, res) => {
  try {
    const { issuerId, saleId, items, customer, payment, total } = req.body || {};
    if (!issuerId) return res.status(400).json({ error: 'issuerId obrigatório' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items obrigatório' });

    const issuer = await prisma.fiscalIssuer.findUnique({ where: { id: issuerId } });
    if (!issuer || !issuer.active) return res.status(400).json({ error: 'Emissor inválido ou inativo' });
    if (!issuer.apiToken) return res.status(400).json({ error: 'Emissor sem token Brasil NFe — configure primeiro' });

    // Resolve produtos pra fiscal items
    const productIds = items.map(i => i.productId).filter(Boolean);
    const products = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } } })
      : [];
    const byId = Object.fromEntries(products.map(p => [p.id, p]));
    const fiscalItems = items.map(i => {
      const p = byId[i.productId] || { name: i.name, sku: i.sku };
      return fiscal.buildItemFromProduct(p, i.qty, i.unitPrice, i);
    });

    const payload = fiscal.buildNFCePayload(
      issuer,
      { customerCpf: customer?.cpf, customerName: customer?.name, total },
      fiscalItems,
      payment || { method: '01', amount: total },
    );

    // Pré-cria documento em status processing
    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId,
        docType: 'NFCE',
        serie: issuer.nfceSerie,
        number: issuer.nfceNextNumber,
        status: 'processing',
        recipientName: customer?.name || null,
        recipientCnpjCpf: customer?.cpf || null,
        totalValue: total,
        saleId: saleId || null,
        productIds: productIds,
        emittedById: req.userId,
        payload,
      },
    });

    // Chama Brasil NFe
    const resp = await fiscal.emitNFCe(issuer, payload);

    // Atualiza com resposta
    const updateData = { response: resp.data, status: resp.ok ? 'authorized' : 'rejected' };
    if (resp.ok && resp.data) {
      updateData.externalId = resp.data.id || resp.data.uuid || null;
      updateData.accessKey = resp.data.chave || resp.data.access_key || null;
      updateData.protocol = resp.data.protocolo || null;
      updateData.danfeUrl = resp.data.danfe_url || resp.data.pdf_url || null;
      updateData.xmlContent = resp.data.xml || null;
    } else {
      updateData.rejectReason = resp.data?.message || resp.data?.error || ('HTTP ' + resp.status);
    }
    const updated = await prisma.fiscalDocument.update({ where: { id: doc.id }, data: updateData });

    // Avança numeração se autorizou
    if (resp.ok) {
      await prisma.fiscalIssuer.update({
        where: { id: issuerId },
        data: { nfceNextNumber: issuer.nfceNextNumber + 1 },
      });
    }

    res.json({ document: updated, brasilNfeResponse: resp.data });
  } catch (err) {
    console.error('[fiscal/nfce]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Emissão NFe modelo 55 (online, B2B, transferência)
// ============================================================

router.post('/nfe', async (req, res) => {
  try {
    const { issuerId, saleId, items, recipient, total, natureza } = req.body || {};
    if (!issuerId) return res.status(400).json({ error: 'issuerId obrigatório' });
    if (!recipient || !(recipient.cnpj || recipient.cpf)) return res.status(400).json({ error: 'recipient.cnpj ou recipient.cpf obrigatório' });

    const issuer = await prisma.fiscalIssuer.findUnique({ where: { id: issuerId } });
    if (!issuer || !issuer.active) return res.status(400).json({ error: 'Emissor inválido ou inativo' });
    if (!issuer.apiToken) return res.status(400).json({ error: 'Emissor sem token Brasil NFe' });

    // IDEMPOTÊNCIA — mesma venda = no MÁXIMO uma NFe. Se já há doc NFE autorizado
    // pra esse saleId, devolve ele e NÃO re-emite. (Este caminho usa o provedor
    // Brasil NFe via apiToken — não passa por Fiscal Agent/PFX, então não sofre o
    // problema de path C:\Chianca no Railway.)
    if (saleId) {
      const existingDoc = await prisma.fiscalDocument.findFirst({
        where: { saleId, docType: 'NFE', status: { in: ['authorized', 'processing'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (existingDoc) {
        if (existingDoc.status === 'authorized') {
          return res.json({ ok: true, alreadyEmitted: true, document: existingDoc, message: 'Venda já possui NFe autorizada #' + existingDoc.number });
        }
        const ageMs = Date.now() - new Date(existingDoc.createdAt).getTime();
        if (ageMs < 95000) return res.status(409).json({ error: 'Emissão desta NFe já está em andamento — aguarde alguns segundos', documentId: existingDoc.id });
        // 'processing' antigo (>95s, provavelmente travado): segue e tenta de novo
      }
    }

    const productIds = items.map(i => i.productId).filter(Boolean);
    const products = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } } })
      : [];
    const byId = Object.fromEntries(products.map(p => [p.id, p]));
    const fiscalItems = items.map(i => {
      const p = byId[i.productId] || { name: i.name, sku: i.sku };
      return fiscal.buildItemFromProduct(p, i.qty, i.unitPrice, i);
    });

    const payload = fiscal.buildNFePayload(issuer, { total, natureza }, fiscalItems, recipient);

    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId, docType: 'NFE',
        serie: issuer.nfeSerie, number: issuer.nfeNextNumber,
        status: 'processing',
        recipientName: recipient.name || null,
        recipientCnpjCpf: recipient.cnpj || recipient.cpf || null,
        recipientEmail: recipient.email || null,
        totalValue: total,
        saleId: saleId || null,
        productIds,
        emittedById: req.userId,
        payload,
      },
    });

    const resp = await fiscal.emitNFe(issuer, payload);
    const updateData = { response: resp.data, status: resp.ok ? 'authorized' : 'rejected' };
    if (resp.ok && resp.data) {
      updateData.externalId = resp.data.id || resp.data.uuid || null;
      updateData.accessKey = resp.data.chave || resp.data.access_key || null;
      updateData.protocol = resp.data.protocolo || null;
      updateData.danfeUrl = resp.data.danfe_url || resp.data.pdf_url || null;
      updateData.xmlContent = resp.data.xml || null;
    } else {
      updateData.rejectReason = resp.data?.message || resp.data?.error || ('HTTP ' + resp.status);
    }
    const updated = await prisma.fiscalDocument.update({ where: { id: doc.id }, data: updateData });

    if (resp.ok) {
      await prisma.fiscalIssuer.update({
        where: { id: issuerId },
        data: { nfeNextNumber: issuer.nfeNextNumber + 1 },
      });
    }

    res.json({ document: updated, brasilNfeResponse: resp.data });
  } catch (err) {
    console.error('[fiscal/nfe]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Cancelamento (até 24h após emissão)
// ============================================================

// ============================================================
// Carta de Correção Eletrônica (CCe) — NFe modelo 55 apenas, até 30 dias
// após emissão, até 20 CCe por NFe.
// ============================================================
router.post('/documents/:id/correction', async (req, res) => {
  try {
    const { correction } = req.body || {};
    if (!correction || correction.length < 15) {
      return res.status(400).json({ error: 'Texto da correção deve ter 15+ caracteres (regra SEFAZ)' });
    }

    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
    if (doc.docType !== 'NFE') return res.status(400).json({ error: 'CCe só pra NFe modelo 55 (NFCe não suporta)' });
    if (doc.status !== 'authorized') return res.status(400).json({ error: 'Documento precisa estar autorizado (atual: ' + doc.status + ')' });
    if (!doc.accessKey) return res.status(400).json({ error: 'Documento sem chave de acesso' });

    // Verifica idade (30 dias máx)
    const days = (Date.now() - new Date(doc.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (days > 30) return res.status(400).json({ error: 'CCe expirada — NFe tem ' + Math.floor(days) + ' dias (limite SEFAZ: 30)' });

    // Determina próximo sequencial
    const previous = Array.isArray(doc.correctionLetter) ? doc.correctionLetter : (doc.correctionLetter ? [doc.correctionLetter] : []);
    const nSeq = previous.length + 1;
    if (nSeq > 20) return res.status(400).json({ error: 'Limite de 20 CCe por NFe atingido' });

    const pfxPath = pfxPathFor(doc.issuer.cnpj);
    const pfxSenha = pfxSenhaFor(doc.issuer.cnpj);
    if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado pra esse CNPJ' });

    const { sendCorrectionLetter } = await getSefazDirect();
    const result = await sendCorrectionLetter({
      issuer: doc.issuer, pfxPath, pfxSenha,
      accessKey: doc.accessKey,
      correction,
      nSeqEvento: nSeq,
    });

    if (result.ok) {
      const newEntry = {
        sequence: nSeq,
        reason: correction,
        protocol: result.correctionProtocol,
        date: new Date().toISOString(),
        status: result.status,
        motivo: result.motivo,
      };
      const newList = [...previous, newEntry];
      await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: { correctionLetter: newList },
      });
      return res.json({ ok: true, sequence: nSeq, protocol: result.correctionProtocol, motivo: result.motivo });
    }
    res.status(400).json({
      error: result.motivo || 'Erro ao enviar CCe',
      status: result.status,
      detail: result.rawResponse?.slice(0, 1000),
    });
  } catch (err) {
    console.error('[fiscal/correction]', err);
    res.status(500).json({ error: err.message });
  }
});

// (cancelamento mudou de lugar: está registrado ANTES do adminMiddleware,
// junto das rotas de troca — caixa cancela NFC-e, admin cancela tudo, e o
// evento sai via agente da loja em vez de PFX local.)

// DANFE legado (Brasil NFe) — removido. A rota /documents/:id/danfe está
// disponível antes do adminMiddleware acima usando node-sped-pdf local.

// ============================================================
// ROBÔ DO NCM (admin) — verifica o catálogo e preenche o NCM
// faltante/inválido pela NFe de entrada. Roda sozinho 1x/dia;
// aqui dá pra rodar na hora e ver o último resultado.
// ============================================================
const ncmRobot = require('../services/ncmRobot');

router.get('/ncm-robot/status', (_req, res) => {
  res.json({ ok: true, ultimoRelatorio: ncmRobot.lastReport() });
});

router.post('/ncm-robot/run', async (req, res) => {
  try {
    const apply = req.body?.apply !== false; // default aplica
    const rep = await ncmRobot.runNcmRobot({ apply });
    res.json({ ok: true, ...rep });
  } catch (err) {
    console.error('[ncm-robot/run]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.emitNfceFromSaleHandler = emitNfceFromSaleHandler;
