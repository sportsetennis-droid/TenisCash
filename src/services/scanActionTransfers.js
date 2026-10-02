'use strict';
const { createHash } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { operator, canSend } = require('./scanTransfers');
const { resolveBarcodeRows, aliasRows } = require('./scannerCatalog');
const { applyStoreStockDelta } = require('./storeStockLedger');

const SOURCE = 'bipar-actions-v1';
const MAX_SCANS = 500;
const storeSelect = { id: true, code: true, name: true, active: true };
const transferInclude = {
  fromStore: { select: storeSelect }, toStore: { select: storeSelect },
  items: { select: { productSizeId: true, productName: true, brand: true, size: true, barcode: true, quantity: true }, orderBy: { productSizeId: 'asc' } },
};
function fail(message, status = 409) { const error = new Error(message); error.status = status; throw error; }
function uuid(value) { return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function barcodeKey(value) { return String(value || '').replace(/^0+/, ''); }
function sizeKey(value) {
  const size = String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/^BR\s*/, '').replace(/\s+/g, ' ');
  return /^(U|UNICO)$/.test(size) ? 'UNICO' : (/^\d+,\d+$/.test(size) ? size.replace(',', '.') : size);
}
function validSize(value) { return !!sizeKey(value) && !/^(?:\?|T-|REF:|UNICO-|SEM TAMANHO|DESCONHECIDO|N\/A)/i.test(sizeKey(value)); }
function noteOf(transfer) { try { return JSON.parse(transfer.note || '{}'); } catch (_) { return {}; } }
function publicTransfer(t) {
  return { id: t.id, code: t.code, status: t.status, createdAt: t.createdAt, receivedAt: t.receivedAt,
    cancelledAt: t.cancelledAt, fromStore: t.fromStore, toStore: t.toStore, items: t.items,
    qtyTotal: t.qtyTotal, itemsCount: t.itemsCount };
}
async function actorFor(db, actor, storeId) {
  if (!actor?.id) fail('Entre com sua conta pessoal de vendedor ou gestor.', 403);
  const actual = await operator(db, actor.id);
  if (storeId && !canSend(actual, storeId)) fail('Esta loja não está vinculada à sua conta.', 403);
  return actual;
}
function scansInput(input, allowEmpty = false) {
  if (!Array.isArray(input.scans) || input.scans.length > MAX_SCANS || (!allowEmpty && !input.scans.length)) fail('Informe de 1 a ' + MAX_SCANS + ' leituras.', 400);
  const scans = input.scans.map(scan => {
    if (!scan || !uuid(scan.clientScanId) || !uuid(scan.productSizeId)) fail('Identificador de leitura inválido. Leia a peça novamente.', 400);
    const barcode = String(scan.barcode || '').trim();
    const confirmedSize = String(scan.confirmedSize || '').trim();
    if (!/^\d{8}$|^\d{12,14}$/.test(barcode) || !barcodeKey(barcode)) fail('Leia o código de barras EAN/UPC da própria peça.', 400);
    if (!confirmedSize || confirmedSize.length > 40) fail('Confirme o tamanho da etiqueta de cada peça.', 400);
    return { clientScanId: scan.clientScanId.toLowerCase(), barcode, productSizeId: scan.productSizeId.toLowerCase(), confirmedSize, duplicateConfirmed: scan.duplicateConfirmed === true };
  }).sort((a, b) => a.clientScanId.localeCompare(b.clientScanId));
  if (new Set(scans.map(scan => scan.clientScanId)).size !== scans.length) fail('A mesma leitura está repetida na sequência. Nenhuma quantidade foi acrescentada.', 400);
  return scans;
}
function sendInput(input = {}) {
  if (![input.sessionId, input.fromStoreId, input.toStoreId].every(uuid)) fail('Sessão ou loja inválida.', 400);
  if (input.fromStoreId.toLowerCase() === input.toStoreId.toLowerCase()) fail('Escolha um destino diferente da origem.', 400);
  return { sessionId: input.sessionId.toLowerCase(), fromStoreId: input.fromStoreId.toLowerCase(), toStoreId: input.toStoreId.toLowerCase(), scans: scansInput(input) };
}
function receiveInput(input = {}) {
  if (!uuid(input.storeId)) fail('Selecione a loja de recebimento.', 400);
  return { storeId: input.storeId.toLowerCase(), scans: scansInput(input, true) };
}
function confirmationInput(input) {
  if (!uuid(input.requestId) || !/^[a-f0-9]{64}$/.test(input.reviewToken || '')) fail('Confira o resumo antes de confirmar.', 400);
}
async function context(db, actor) {
  const user = await actorFor(db, actor);
  const stores = await db.store.findMany({ where: { active: true }, select: storeSelect, orderBy: { code: 'asc' } });
  return { user, stores, allowedStoreIds: stores.filter(store => canSend(user, store.id)).map(store => store.id) };
}
async function loadTransfer(db, id, actor, storeId) {
  if (!uuid(id)) fail('Transferência inválida.', 400);
  const transfer = await db.stockTransfer.findUnique({ where: { id }, include: transferInclude });
  if (!transfer || noteOf(transfer).source !== SOURCE) fail('Transferência não encontrada neste fluxo.', 404);
  if (transfer.toStoreId !== storeId || !canSend(actor, transfer.toStoreId)) fail('Selecione a loja de destino desta transferência.', 403);
  return transfer;
}
async function resolveCodes(db, scans, inactiveExpected = []) {
  const codes = [...new Set(scans.map(scan => scan.barcode))];
  const variants = [...new Set(codes.flatMap(code => [code, barcodeKey(code), code.padStart(13, '0'), code.padStart(14, '0')]))];
  const rows = variants.length ? await db.productSize.findMany({ where: { barcode: { in: variants } }, include: { product: true } }) : [];
  const result = new Map();
  for (const code of codes) {
    const key = barcodeKey(code);
    if (result.has(key)) continue;
    const direct = await resolveBarcodeRows(db, rows.filter(row => barcodeKey(row.barcode) === key));
    const aliases = await aliasRows(db, code);
    // A product disabled after dispatch remains receivable as the exact sent
    // variant. Its reviewed alias is evidence too; it never enables a new send.
    const inactiveAliases = inactiveExpected.filter(size => !size.product.active && size.product.aiContext?.scannerBarcodeAliases?.[key]?.size === size.size);
    result.set(key, [...new Map([...direct, ...aliases, ...inactiveAliases].map(row => [row.id, row])).values()]);
  }
  return result;
}
async function lookup(db, actor, input = {}) {
  const actual = await actorFor(db, actor, input.transferId ? input.storeId : undefined);
  const barcode = String(input.barcode || '').trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(barcode) || !barcodeKey(barcode)) fail('Leia o código de barras EAN/UPC da própria peça.', 400);
  let transfer = null, expectedSizes = [];
  if (input.transferId) {
    transfer = await loadTransfer(db, input.transferId, actual, input.storeId);
    if (transfer.status !== 'in_transit') fail('Esta transferência não está aguardando recebimento.');
    if (!transfer.fromStore.active || !transfer.toStore.active) fail('Origem ou destino não está disponível.');
    expectedSizes = await db.productSize.findMany({ where: { id: { in: transfer.items.map(item => item.productSizeId) } }, include: { product: true } });
  }
  const matches = (await resolveCodes(db, [{ barcode }], expectedSizes)).get(barcodeKey(barcode)) || [];
  if (!matches.length) fail('Código não identificado. Confira o cadastro antes de continuar.', 404);
  if (matches.length !== 1) fail('Código associado a mais de uma variante. Confira o cadastro.');
  const ps = matches[0], expected = transfer?.items.find(item => item.productSizeId === ps.id);
  if (transfer && !expected) fail('Esta peça não pertence à transferência selecionada.');
  if (!transfer && !ps.product.active) fail('Cadastro inativo. Confira o produto antes de enviar.');
  if (!validSize(ps.size) || (expected && sizeKey(expected.size) !== sizeKey(ps.size))) fail('O tamanho deste código está pendente ou mudou após o envio. Confira o cadastro.');
  return { product: { productSizeId: ps.id, name: expected?.productName || ps.product.name, brand: expected?.brand || ps.product.brand,
    size: ps.size, barcode, imageUrl: ps.product.imageUrl || null }, requiresSizeConfirmation: true };
}
function block(list, code, message, extra = {}) { list.push({ code, message, ...extra }); }
async function inspectScans(db, scans, blockers, expected = null) {
  if (scans.length) {
    const reused = await db.storeStockMovement.findFirst({ where: { source: SOURCE,
      OR: scans.map(scan => ({ metadata: { path: ['clientScanIds'], array_contains: [scan.clientScanId] } })) }, select: { id: true } });
    if (reused) block(blockers, 'already_used_scan', 'Uma leitura já foi usada em outra movimentação. Bipe cada peça novamente nesta operação.');
  }
  const sizes = await db.productSize.findMany({ where: { id: { in: [...new Set(scans.map(scan => scan.productSizeId))] } }, include: { product: true } });
  const matches = await resolveCodes(db, scans, expected ? sizes.filter(size => expected.some(item => item.productSizeId === size.id)) : []);
  const sizesById = new Map(sizes.map(size => [size.id, size]));
  const repeated = new Map();
  for (const scan of scans) {
    const size = sizesById.get(scan.productSizeId);
    const details = { clientScanId: scan.clientScanId, productSizeId: scan.productSizeId };
    const resolved = matches.get(barcodeKey(scan.barcode)) || [];
    if (!size || (!expected && !size.product.active)) block(blockers, 'unavailable_product', 'Há produto indisponível na sequência.', details);
    if (resolved.length !== 1 || resolved[0].id !== scan.productSizeId) block(blockers, 'barcode_conflict', 'O código lido não confirma uma única variante selecionada.', details);
    if (!size || !validSize(size.size) || !validSize(scan.confirmedSize) || sizeKey(size.size) !== sizeKey(scan.confirmedSize)) block(blockers, 'pending_size', 'O tamanho informado precisa corresponder à etiqueta e à variante cadastrada.', details);
    if (expected) {
      const sent = expected.find(item => item.productSizeId === scan.productSizeId);
      if (!sent) block(blockers, 'unexpected_item', 'Foi lida uma peça que não pertence à transferência.', details);
      else if (!size || sizeKey(sent.size) !== sizeKey(size.size)) block(blockers, 'changed_variant', 'O tamanho da variante mudou após o envio. Confira o cadastro antes de receber.', details);
    }
    const key = barcodeKey(scan.barcode);
    if (!repeated.has(key)) repeated.set(key, []);
    repeated.get(key).push(scan);
  }
  // Sorting by UUID does not preserve scanning order. Exactly one reading of
  // each code may omit confirmation; every additional piece needs consent.
  for (const group of repeated.values()) if (group.length > 1 && group.filter(scan => !scan.duplicateConfirmed).length > 1) block(blockers, 'duplicate_confirmation', 'Confirme que cada repetição do código corresponde a outra peça física.', { barcode: group[0].barcode });
  return { sizes, sizesById };
}
async function buildSendPreview(db, actor, selection) {
  const blockers = [];
  const stores = await db.store.findMany({ where: { id: { in: [selection.fromStoreId, selection.toStoreId] } }, select: storeSelect });
  const fromStore = stores.find(store => store.id === selection.fromStoreId) || null;
  const toStore = stores.find(store => store.id === selection.toStoreId) || null;
  if (!fromStore?.active || !toStore?.active) block(blockers, 'inactive_store', 'Origem ou destino não está disponível.');
  const { sizes, sizesById } = await inspectScans(db, selection.scans, blockers);
  const stocks = await db.storeStock.findMany({ where: { storeId: selection.fromStoreId, productSizeId: { in: sizes.map(size => size.id) } }, select: { productSizeId: true, stock: true }, orderBy: { productSizeId: 'asc' } });
  const quantities = new Map();
  for (const scan of selection.scans) quantities.set(scan.productSizeId, (quantities.get(scan.productSizeId) || 0) + 1);
  const items = [...quantities].sort(([a], [b]) => a.localeCompare(b)).map(([productSizeId, quantity]) => {
    const size = sizesById.get(productSizeId), available = stocks.find(stock => stock.productSizeId === productSizeId)?.stock || 0;
    if (available < quantity) block(blockers, 'insufficient_stock', (size?.product.name || 'Produto') + ': ' + quantity + ' peça(s) lida(s), mas somente ' + available + ' no estoque da origem.', { productSizeId });
    return { productSizeId, productName: size?.product.name || '', brand: size?.product.brand || '', size: size?.size || '',
      barcode: selection.scans.find(scan => scan.productSizeId === productSizeId).barcode, quantity, available, remaining: available - quantity };
  });
  const reviewToken = hash({ actorId: actor.id, selection, fromStore, toStore, items, blockers });
  return { reviewToken, fromStore, toStore, items, scanCount: selection.scans.length, blockers, canTransfer: blockers.length === 0 };
}
async function sendPreview(db, actor, input) {
  const selection = sendInput(input);
  return db.$transaction(async tx => buildSendPreview(tx, await actorFor(tx, actor, selection.fromStoreId), selection), { isolationLevel: 'RepeatableRead', timeout: 30000 });
}
async function lockRows(tx, table, ids) {
  if (ids.length) await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw('"' + table + '"')} WHERE id IN (${Prisma.join([...new Set(ids)].sort())}) ORDER BY id FOR UPDATE`);
}
async function lockStocks(tx, storeIds, sizeIds) {
  if (sizeIds.length) await tx.$queryRaw(Prisma.sql`SELECT id FROM "StoreStock" WHERE "storeId" IN (${Prisma.join(storeIds)}) AND "productSizeId" IN (${Prisma.join([...new Set(sizeIds)].sort())}) ORDER BY "storeId", "productSizeId" FOR UPDATE`);
}
async function serializable(db, fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(fn, { isolationLevel: 'Serializable', timeout: 30000 }); }
    catch (error) {
      const conflict = error.code === 'P2034' || error.code === 'P2002' || (error.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code));
      if (!conflict || attempt >= 9) throw error;
    }
  }
}
async function sendConfirm(db, actor, input = {}) {
  const selection = sendInput(input); confirmationInput(input);
  return serializable(db, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'camera-transfer-v1'}))::text`;
    const actual = await actorFor(tx, actor, selection.fromStoreId);
    const selectionHash = hash({ actorId: actual.id, selection });
    const existing = await tx.stockTransfer.findUnique({ where: { id: input.requestId }, include: transferInclude });
    if (existing) {
      const note = noteOf(existing);
      if (note.source !== SOURCE || existing.createdById !== actual.id || note.send?.selectionHash !== selectionHash) fail('Identificador já utilizado em outra transferência.');
      return { transfer: publicTransfer(existing), alreadySaved: true };
    }
    const sizeIds = selection.scans.map(scan => scan.productSizeId);
    await lockRows(tx, 'ProductSize', sizeIds);
    await lockStocks(tx, [selection.fromStoreId, selection.toStoreId], sizeIds);
    const report = await buildSendPreview(tx, actual, selection);
    if (!report.canTransfer) fail(report.blockers[0].message + ' Nenhuma peça foi enviada.');
    if (report.reviewToken !== input.reviewToken) fail('A leitura ou o estoque mudou. Confira o resumo atualizado antes de enviar.');
    const highest = await tx.stockTransfer.aggregate({ _max: { code: true } });
    const saved = await tx.stockTransfer.create({ data: {
      id: input.requestId, code: (highest._max.code || 0) + 1, fromStoreId: selection.fromStoreId, toStoreId: selection.toStoreId,
      status: 'in_transit', createdById: actual.id, itemsCount: report.items.length, qtyTotal: report.scanCount, fiscalStatus: 'skipped',
      note: JSON.stringify({ source: SOURCE, sessionId: selection.sessionId, send: { actorId: actual.id, selectionHash, scans: selection.scans, reviewToken: input.reviewToken } }),
      items: { create: report.items.map(({ available, remaining, ...item }) => item) },
    }, include: transferInclude });
    for (const item of report.items) await applyStoreStockDelta(tx, { storeId: selection.fromStoreId, productSizeId: item.productSizeId, quantity: -item.quantity,
      type: 'transfer_out', source: SOURCE, reason: 'Envio da transferência #' + saved.code,
      metadata: { transferId: saved.id, actorId: actual.id, sessionId: selection.sessionId, clientScanIds: selection.scans.filter(scan => scan.productSizeId === item.productSizeId).map(scan => scan.clientScanId) } });
    return { transfer: publicTransfer(saved), alreadySaved: false };
  });
}
async function pending(db, actor, input = {}) {
  if (!uuid(input.storeId)) fail('Selecione a loja de recebimento.', 400);
  await actorFor(db, actor, input.storeId);
  const store = await db.store.findUnique({ where: { id: input.storeId }, select: storeSelect });
  if (!store?.active) fail('Esta loja não está disponível.');
  const transfers = await db.stockTransfer.findMany({ where: { toStoreId: input.storeId, status: 'in_transit', note: { startsWith: '{"source":"' + SOURCE + '",' } },
    include: transferInclude, orderBy: { code: 'asc' }, take: 200 });
  return { transfers: transfers.map(publicTransfer) };
}
async function buildReceivePreview(db, actor, transfer, selection) {
  const blockers = [];
  if (transfer.status !== 'in_transit') block(blockers, 'not_pending', 'Esta transferência não está aguardando recebimento.');
  if (!transfer.fromStore.active || !transfer.toStore.active) block(blockers, 'inactive_store', 'Origem ou destino não está disponível.');
  await inspectScans(db, selection.scans, blockers, transfer.items);
  const expected = new Map();
  for (const item of transfer.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) block(blockers, 'invalid_transfer', 'Há quantidade inválida na transferência. Revise o envio.');
    const previous = expected.get(item.productSizeId);
    expected.set(item.productSizeId, { ...item, quantity: (previous?.quantity || 0) + item.quantity });
  }
  const quantities = new Map();
  for (const scan of selection.scans) quantities.set(scan.productSizeId, (quantities.get(scan.productSizeId) || 0) + 1);
  const ids = [...new Set([...expected.keys(), ...quantities.keys()])].sort();
  const items = ids.map(productSizeId => {
    const item = expected.get(productSizeId) || { productSizeId, productName: 'Peça fora da transferência', size: '', quantity: 0 };
    const scanned = quantities.get(productSizeId) || 0, missing = Math.max(0, item.quantity - scanned), excess = Math.max(0, scanned - item.quantity);
    if (missing) block(blockers, 'missing_items', 'Faltam ' + missing + ' peça(s) de ' + item.productName + ' · ' + item.size + '.', { productSizeId });
    if (excess) block(blockers, 'excess_items', 'Há ' + excess + ' peça(s) a mais de ' + item.productName + ' · ' + item.size + '.', { productSizeId });
    return { ...item, expected: item.quantity, scanned, missing, excess };
  });
  if (!transfer.items.length || transfer.qtyTotal !== transfer.items.reduce((total, item) => total + item.quantity, 0)) block(blockers, 'invalid_transfer', 'A quantidade total do envio precisa ser revisada.');
  const stocks = await db.storeStock.findMany({ where: { storeId: selection.storeId, productSizeId: { in: ids } }, select: { productSizeId: true, stock: true }, orderBy: { productSizeId: 'asc' } });
  const reviewToken = hash({ actorId: actor.id, transfer: publicTransfer(transfer), selection, items, stocks, blockers });
  return { reviewToken, transfer: publicTransfer(transfer), items, scanCount: selection.scans.length, blockers, canReceive: blockers.length === 0 };
}
async function receivePreview(db, actor, id, input) {
  const selection = receiveInput(input);
  return db.$transaction(async tx => {
    const actual = await actorFor(tx, actor, selection.storeId);
    const transfer = await loadTransfer(tx, id, actual, selection.storeId);
    return buildReceivePreview(tx, actual, transfer, selection);
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
}
async function receiveConfirm(db, actor, id, input = {}) {
  if (!uuid(id)) fail('Transferência inválida.', 400);
  const selection = receiveInput(input); confirmationInput(input);
  return serializable(db, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'camera-transfer-v1'}))::text`;
    const actual = await actorFor(tx, actor, selection.storeId);
    await lockRows(tx, 'StockTransfer', [id]);
    const transfer = await loadTransfer(tx, id, actual, selection.storeId);
    const note = noteOf(transfer), selectionHash = hash({ actorId: actual.id, transferId: id, selection });
    if (transfer.status === 'received') {
      if (note.receipt?.requestId !== input.requestId || note.receipt?.selectionHash !== selectionHash || transfer.receivedById !== actual.id) fail('Esta transferência já foi recebida. O estoque não foi acrescentado novamente.');
      return { transfer: publicTransfer(transfer), alreadySaved: true };
    }
    const sizeIds = [...new Set([...transfer.items.map(item => item.productSizeId), ...selection.scans.map(scan => scan.productSizeId)])];
    await lockRows(tx, 'ProductSize', sizeIds);
    await lockStocks(tx, [selection.storeId], sizeIds);
    const report = await buildReceivePreview(tx, actual, transfer, selection);
    if (!report.canReceive) fail(report.blockers[0].message + ' Nenhuma peça foi recebida.');
    if (report.reviewToken !== input.reviewToken) fail('A conferência ou o estoque mudou. Confira o resumo atualizado antes de receber.');
    // Request IDs are independent of the transfer ID, but never reusable for
    // receiving another remittance. The shared advisory lock serializes this.
    const reusedRequest = await tx.stockTransfer.findFirst({ where: { note: { contains: '"requestId":"' + input.requestId + '"' } }, select: { id: true } });
    if (reusedRequest) fail('Identificador de recebimento já utilizado em outra transferência.');
    const updatedNote = { ...note, receipt: { requestId: input.requestId, actorId: actual.id, selectionHash, scans: selection.scans, reviewToken: input.reviewToken } };
    const saved = await tx.stockTransfer.update({ where: { id }, data: { status: 'received', receivedById: actual.id, receivedAt: new Date(), note: JSON.stringify(updatedNote) }, include: transferInclude });
    for (const item of report.items) await applyStoreStockDelta(tx, { storeId: selection.storeId, productSizeId: item.productSizeId, quantity: item.expected,
      type: 'transfer_in', source: SOURCE, reason: 'Recebimento conferido da transferência #' + saved.code,
      metadata: { transferId: id, requestId: input.requestId, actorId: actual.id, clientScanIds: selection.scans.filter(scan => scan.productSizeId === item.productSizeId).map(scan => scan.clientScanId) } });
    return { transfer: publicTransfer(saved), alreadySaved: false };
  });
}
module.exports = { SOURCE, MAX_SCANS, context, lookup, sendPreview, sendConfirm, pending, receivePreview, receiveConfirm };
