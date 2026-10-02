'use strict';
const { createHash } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { operator, canSend } = require('./scanTransfers');
const { resolveBarcodeRows, aliasRows } = require('./scannerCatalog');
const { applyStoreStockDelta } = require('./storeStockLedger');

const SOURCE = 'stocktake-transfer-v1';
const MAX_SCANS = 1000;
const storeSelect = { id: true, name: true, code: true, active: true };
const transferInclude = {
  fromStore: { select: { id: true, name: true, code: true } },
  toStore: { select: { id: true, name: true, code: true } },
  items: { select: { productSizeId: true, productName: true, brand: true, size: true, barcode: true, quantity: true } },
  stocktakeScans: { select: { bipeId: true } },
};
function fail(message, status = 409) { const error = new Error(message); error.status = status; throw error; }
function uuid(value) { return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function barcodeKey(value) { return String(value || '').replace(/^0+/, ''); }
function validSize(value) { return !!value && !/^(?:\?|T-|REF:|Único-)/i.test(value); }
function inputSelection(input = {}) {
  const { fromStoreId, toStoreId, roundId } = input;
  if (![fromStoreId, toStoreId, roundId].every(uuid)) fail('Loja ou rodada inválida. Atualize a seleção.', 400);
  if (fromStoreId === toStoreId) fail('Escolha uma loja de destino diferente da origem.', 400);
  for (const name of ['bipeIds', 'scanKeys']) {
    if (input[name] !== undefined && (!Array.isArray(input[name]) || input[name].length > MAX_SCANS)) fail('Selecione no máximo ' + MAX_SCANS + ' leituras por transferência.', 400);
    if ((input[name] || []).some(value => typeof value !== 'string' || !value || value.length > 140)) fail('Identificador de leitura inválido.', 400);
  }
  const bipeIds = [...new Set(input.bipeIds || [])].sort();
  const scanKeys = [...new Set(input.scanKeys || [])].sort();
  if (!bipeIds.length && !scanKeys.length) fail('Selecione as leituras desta sequência antes de transferir.', 400);
  if (bipeIds.length + scanKeys.length > MAX_SCANS * 2) fail('Muitas leituras selecionadas.', 400);
  return { fromStoreId, toStoreId, roundId, bipeIds, scanKeys };
}
async function actorFor(db, actor, fromStoreId) {
  if (!actor?.id) fail('Entre com sua conta pessoal para transferir.', 403);
  const actual = await operator(db, actor?.id);
  if (!canSend(actual, fromStoreId)) fail('Você só pode transferir a partir das lojas vinculadas à sua conta.', 403);
  return actual;
}
async function selectedReads(db, selection) {
  const { bipeIds, scanKeys } = selection;
  const bipes = await db.stocktakeBipe.findMany({
    where: { OR: [{ id: { in: bipeIds } }, { scanKey: { in: scanKeys } }] }, orderBy: { id: 'asc' },
  });
  if (bipes.length > MAX_SCANS) fail('Selecione no máximo ' + MAX_SCANS + ' leituras por transferência.', 400);
  const captures = await db.productCapture.findMany({
    where: { OR: [{ bipeId: { in: bipes.map(b => b.id) } }, { scanKey: { in: scanKeys } }] }, orderBy: { id: 'asc' },
    select: { id: true, bipeId: true, scanKey: true, roundId: true, storeId: true, barcode: true, status: true, excludedAt: true, matchedProductId: true, createdProductId: true, resolvedAt: true },
  });
  // A capture may have completed after its scan key was selected. Include its
  // original bipe, even when older clients used a different bipe scan key.
  const linkedIds = [...new Set(captures.filter(c => scanKeys.includes(c.scanKey) && c.bipeId).map(c => c.bipeId))];
  const extraIds = linkedIds.filter(id => !bipes.some(b => b.id === id));
  if (extraIds.length) {
    bipes.push(...await db.stocktakeBipe.findMany({ where: { id: { in: extraIds } } }));
    bipes.sort((a, b) => a.id.localeCompare(b.id));
    const extraCaptures = await db.productCapture.findMany({ where: { bipeId: { in: extraIds } }, orderBy: { id: 'asc' },
      select: { id: true, bipeId: true, scanKey: true, roundId: true, storeId: true, barcode: true, status: true, excludedAt: true, matchedProductId: true, createdProductId: true, resolvedAt: true } });
    for (const capture of extraCaptures) if (!captures.some(c => c.id === capture.id)) captures.push(capture);
    captures.sort((a, b) => a.id.localeCompare(b.id));
  }
  if (bipes.length > MAX_SCANS) fail('Selecione no máximo ' + MAX_SCANS + ' leituras por transferência.', 400);
  return { bipes, captures };
}
function missingSelection(selection, reads) {
  const blockers = [];
  for (const id of selection.bipeIds) if (!reads.bipes.some(b => b.id === id)) blockers.push({ code: 'missing_scan', bipeId: id, message: 'Uma leitura selecionada não foi encontrada. Atualize a sequência.' });
  for (const key of selection.scanKeys) if (!reads.bipes.some(b => b.scanKey === key) && !reads.captures.some(c => c.scanKey === key)) blockers.push({ code: 'missing_scan', scanKey: key, message: 'Uma leitura ainda não foi salva no servidor. Aguarde o envio antes de transferir.' });
  return blockers;
}
async function barcodeMatches(db, bipes) {
  const codes = [...new Set(bipes.map(b => b.barcode).filter(code => /^\d{8}$|^\d{12,14}$/.test(code || '')))];
  const alternatives = [...new Set(codes.flatMap(code => [code, barcodeKey(code), code.padStart(13, '0'), code.padStart(14, '0')]))];
  const rows = alternatives.length ? await db.productSize.findMany({ where: { barcode: { in: alternatives } }, include: { product: true } }) : [];
  const result = new Map();
  for (const code of codes) {
    const key = barcodeKey(code);
    if (result.has(key)) continue;
    let matches = await resolveBarcodeRows(db, rows.filter(row => barcodeKey(row.barcode) === key));
    if (!matches.length) matches = await aliasRows(db, code);
    result.set(key, matches.map(row => row.id).sort());
  }
  return result;
}
async function buildPreview(db, actor, selection, suppliedReads) {
  const reads = suppliedReads || await selectedReads(db, selection);
  const { bipes, captures } = reads;
  const sizeIds = [...new Set(bipes.map(b => b.productSizeId).filter(Boolean))].sort();
  const [round, stores, sizes, stocks, links, matches] = await Promise.all([
    db.stocktakeRound.findUnique({ where: { id: selection.roundId } }),
    db.store.findMany({ where: { id: { in: [selection.fromStoreId, selection.toStoreId] } }, select: storeSelect }),
    db.productSize.findMany({ where: { id: { in: sizeIds } }, include: { product: true } }),
    db.storeStock.findMany({ where: { storeId: { in: [selection.fromStoreId, selection.toStoreId] }, productSizeId: { in: sizeIds } }, select: { storeId: true, productSizeId: true, stock: true }, orderBy: [{ storeId: 'asc' }, { productSizeId: 'asc' }] }),
    db.stocktakeTransferScan.findMany({ where: { bipeId: { in: bipes.map(b => b.id) } }, select: { bipeId: true, transferId: true } }),
    barcodeMatches(db, bipes),
  ]);
  const fromStore = stores.find(s => s.id === selection.fromStoreId) || null;
  const toStore = stores.find(s => s.id === selection.toStoreId) || null;
  const blockers = missingSelection(selection, reads);
  const block = (code, message, extra = {}) => blockers.push({ code, message, ...extra });
  if (!fromStore?.active || !toStore?.active) block('inactive_store', 'Origem ou destino não está disponível.');
  if (!round || round.storeId !== selection.fromStoreId || !['counting', 'review'].includes(round.status)) block('invalid_round', 'A rodada precisa estar aberta ou em conferência na loja de origem.');
  const sizeMap = new Map(sizes.map(size => [size.id, size]));
  const quantities = new Map();
  for (const b of bipes) {
    const context = { bipeId: b.id };
    if (b.roundId !== selection.roundId || b.storeId !== selection.fromStoreId) { block('wrong_scope', 'Uma leitura pertence a outra loja ou rodada.', context); continue; }
    if (b.excludedAt) block('excluded_scan', 'Há uma leitura retirada da contagem.', context);
    if (b.applied) block('applied_scan', 'Há uma leitura já aplicada ao estoque. Revise antes de transferir.', context);
    if (links.some(link => link.bipeId === b.id)) block('already_transferred', 'Uma leitura desta sequência já foi transferida.', context);
    const size = sizeMap.get(b.productSizeId);
    if (!b.found || b.duplicate || !size || size.productId !== b.productId || !size.product.active) {
      block('unresolved_scan', 'Há produto não identificado, ambíguo ou inativo na sequência.', context); continue;
    }
    if (!/^\d{8}$|^\d{12,14}$/.test(b.barcode || '')) block('missing_barcode', 'Há leitura sem código de barras efetivamente escaneado.', context);
    else {
      const resolved = matches.get(barcodeKey(b.barcode)) || [];
      if (resolved.length !== 1 || resolved[0] !== size.id) block('barcode_conflict', 'O código da leitura não confirma uma única variante do cadastro.', context);
    }
    if (!validSize(size.size) || !validSize(b.productSize) || b.productSize !== size.size || (/adidas|nike/i.test(size.product.brand || '') && !size.sizeConfirmedAt) || (/adidas/i.test(size.product.brand || '') && +new Date(size.sizeConfirmedAt || 0) < +new Date(b.bipedAt))) block('pending_size', 'Há tamanho pendente de conferência na própria etiqueta.', context);
    quantities.set(size.id, (quantities.get(size.id) || 0) + 1);
  }
  for (const c of captures) {
    const bipe = bipes.find(b => b.id === c.bipeId);
    if (c.roundId !== selection.roundId || c.storeId !== selection.fromStoreId || c.excludedAt || c.status !== 'vinculado' || !bipe || c.barcode !== bipe.barcode || ![c.matchedProductId, c.createdProductId].includes(bipe.productId)) block('pending_capture', 'Há foto pendente, excluída ou divergente na sequência. Conclua a identificação antes de transferir.', { captureId: c.id, ...(c.bipeId ? { bipeId: c.bipeId } : {}) });
  }
  const items = [...quantities.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([productSizeId, quantity]) => {
    const size = sizeMap.get(productSizeId);
    const available = stocks.find(row => row.storeId === selection.fromStoreId && row.productSizeId === productSizeId)?.stock || 0;
    if (available < quantity) block('insufficient_stock', size.product.name + ' · ' + size.size + ': ' + quantity + ' bipado(s), mas somente ' + available + ' no estoque da origem.', { productSizeId });
    return { productSizeId, productName: size.product.name, brand: size.product.brand, size: size.size, barcode: bipes.find(b => b.productSizeId === productSizeId)?.barcode || '', quantity, available, remaining: available - quantity };
  });
  const orphanCount = captures.filter(c => !c.bipeId).length;
  const scanCount = bipes.length + orphanCount;
  if (scanCount > MAX_SCANS) fail('Selecione no máximo ' + MAX_SCANS + ' leituras por transferência.', 400);
  if (!scanCount) block('empty_selection', 'Nenhuma leitura foi encontrada nesta sequência.');
  const reviewToken = hash({ actorId: actor.id, selection, round: round && { id: round.id, status: round.status, storeId: round.storeId }, stores: stores.sort((a, b) => a.id.localeCompare(b.id)),
    bipes: bipes.map(b => [b.id, b.scanKey, b.barcode, b.roundId, b.storeId, b.productId, b.productSizeId, b.productSize, b.found, b.duplicate, b.applied, b.excludedAt, b.bipedAt]), captures,
    sizes: sizes.sort((a, b) => a.id.localeCompare(b.id)).map(s => [s.id, s.productId, s.size, s.sizeConfirmedAt, s.product.active, s.product.name, s.product.brand]), stocks, links: links.sort((a, b) => a.bipeId.localeCompare(b.bipeId)), items, blockers });
  return { reviewToken, fromStore, toStore, roundId: selection.roundId, scanCount, items, blockers, canTransfer: blockers.length === 0 };
}
async function preview(db, actor, input) {
  const selection = inputSelection(input);
  return db.$transaction(async tx => buildPreview(tx, await actorFor(tx, actor, selection.fromStoreId), selection), { isolationLevel: 'RepeatableRead', timeout: 30000 });
}
function publicTransfer(transfer, roundId) {
  return { id: transfer.id, code: transfer.code, status: transfer.status, createdAt: transfer.createdAt, fromStore: transfer.fromStore, toStore: transfer.toStore, items: transfer.items, qtyTotal: transfer.qtyTotal, roundId, scanCount: transfer.stocktakeScans.length };
}
async function lockRows(tx, table, ids) {
  if (!ids.length) return;
  // Table names are fixed by callers; all identifiers from requests stay bound.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw('"' + table + '"')} WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
}
async function confirmOnce(db, actor, input) {
  const selection = inputSelection(input);
  if (!uuid(input.requestId) || !/^[a-f0-9]{64}$/.test(input.reviewToken || '')) fail('Confirmação inválida. Confira o resumo novamente.', 400);
  return db.$transaction(async tx => {
    // Shared with the existing one-piece transfer service (max(code) + 1).
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'camera-transfer-v1'}))::text`;
    const actual = await actorFor(tx, actor, selection.fromStoreId);
    await lockRows(tx, 'StocktakeRound', [selection.roundId]);
    let reads = await selectedReads(tx, selection);
    await lockRows(tx, 'StocktakeBipe', reads.bipes.map(b => b.id));
    await lockRows(tx, 'ProductCapture', reads.captures.map(c => c.id));
    reads = await selectedReads(tx, selection);
    const existing = await tx.stockTransfer.findUnique({ where: { id: input.requestId }, include: transferInclude });
    if (existing) {
      let note; try { note = JSON.parse(existing.note || '{}'); } catch (_) { note = {}; }
      const sameScans = hash(existing.stocktakeScans.map(s => s.bipeId).sort()) === hash(reads.bipes.map(b => b.id).sort());
      if (existing.createdById !== actual.id || note.source !== SOURCE || note.roundId !== selection.roundId || existing.fromStoreId !== selection.fromStoreId || existing.toStoreId !== selection.toStoreId || !sameScans || missingSelection(selection, reads).length || reads.captures.some(c => !c.bipeId)) fail('Identificador já utilizado em outra transferência.');
      return { transfer: publicTransfer(existing, selection.roundId), alreadySaved: true };
    }
    const sizeIds = [...new Set(reads.bipes.map(b => b.productSizeId).filter(Boolean))].sort();
    await lockRows(tx, 'ProductSize', sizeIds);
    if (sizeIds.length) await tx.$queryRaw(Prisma.sql`SELECT id FROM "StoreStock" WHERE "productSizeId" IN (${Prisma.join(sizeIds)}) AND "storeId" IN (${selection.fromStoreId}, ${selection.toStoreId}) ORDER BY "storeId", "productSizeId" FOR UPDATE`);
    const report = await buildPreview(tx, actual, selection, reads);
    if (!report.canTransfer) fail(report.blockers[0].message + ' Nenhuma mercadoria foi transferida.');
    if (report.reviewToken !== input.reviewToken) fail('A sequência ou o estoque mudou. Confira o resumo atualizado antes de confirmar; nada foi transferido.');
    const highest = await tx.stockTransfer.aggregate({ _max: { code: true } });
    const saved = await tx.stockTransfer.create({ data: {
      id: input.requestId, code: (highest._max.code || 0) + 1, fromStoreId: selection.fromStoreId, toStoreId: selection.toStoreId,
      status: 'received', createdById: actual.id, receivedById: actual.id, receivedAt: new Date(), itemsCount: report.items.length, qtyTotal: report.scanCount, fiscalStatus: 'skipped',
      note: JSON.stringify({ source: SOURCE, roundId: selection.roundId, reviewToken: input.reviewToken }),
      items: { create: report.items.map(({ available, remaining, ...item }) => item) },
      stocktakeScans: { create: reads.bipes.map(b => ({ bipeId: b.id, roundId: b.roundId, storeId: b.storeId, productSizeId: b.productSizeId, barcode: b.barcode })) },
    }, include: transferInclude });
    for (const item of report.items) {
      const metadata = { transferId: saved.id, actorId: actual.id, roundId: selection.roundId, bipeIds: reads.bipes.filter(b => b.productSizeId === item.productSizeId).map(b => b.id) };
      await applyStoreStockDelta(tx, { storeId: selection.fromStoreId, productSizeId: item.productSizeId, quantity: -item.quantity, type: 'transfer_out', source: SOURCE, reason: 'Transferência dos bipes #' + saved.code, metadata });
      await applyStoreStockDelta(tx, { storeId: selection.toStoreId, productSizeId: item.productSizeId, quantity: item.quantity, type: 'transfer_in', source: SOURCE, reason: 'Transferência dos bipes #' + saved.code, metadata });
    }
    return { transfer: publicTransfer(saved, selection.roundId), alreadySaved: false };
  }, { isolationLevel: 'Serializable', timeout: 30000 });
}
async function confirm(db, actor, input) {
  // A Serializable transaction can lose a race to a sale, a review or another
  // request waiting on the shared transfer lock. Retry the complete validation;
  // the persisted request ID and unique bipe link still prevent a second move.
  for (let attempt = 0; ; attempt++) {
    try { return await confirmOnce(db, actor, input); }
    catch (error) {
      const conflict = error.code === 'P2034' || error.code === 'P2002' || (error.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code));
      if (!conflict || attempt >= 9) throw error;
    }
  }
}
module.exports = { preview, confirm, MAX_SCANS };
