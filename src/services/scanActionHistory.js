'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { operator, canSend } = require('./scanTransfers');
const { resolveBarcodeRows, aliasRows } = require('./scannerCatalog');
const MAX_SCANS = 500;
const storeSelect = { id: true, code: true, name: true, active: true };
const id = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const key = value => String(value || '').replace(/^0+/, '');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message, status = 409) { const e = new Error(message); e.status = status; throw e; }
function sizeKey(value) { return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/^BR\s*/, '').replace(/\s+/g, ' ').replace(/^(?:U|UNICO)$/, 'UNICO').replace(/^(\d+),(\d+)$/, '$1.$2'); }
function validSize(value) { const s = sizeKey(value); return !!s && !/^(?:\?|T-|REF:|UNICO-|SEM TAMANHO|DESCONHECIDO|N\/A|(?:EAN|UPC|GTIN|BARCODE|CODIGO)(?:\b|\d))/.test(s) && !/^\d{8,}$/.test(s.replace(/\s/g, '')); }
function uuid(value, optional = false) { if (optional && !value) return null; if (!id(value)) fail('Identificador do lote ou loja inválido.', 400); return value.toLowerCase(); }
function clean(input = {}) {
  const sessionId = uuid(input.sessionId), mode = input.mode;
  if (!['transfer', 'receipt'].includes(mode)) fail('Escolha Transferência ou Recebimento.', 400);
  const fromStoreId = uuid(input.fromStoreId, mode === 'receipt'), toStoreId = uuid(input.toStoreId), transferId = uuid(input.transferId, true);
  if (mode === 'transfer' && transferId) fail('A remessa do envio só é criada ao confirmar a transferência.', 400);
  if (mode === 'receipt' && fromStoreId) fail('No recebimento, a origem é informada pela remessa selecionada.', 400);
  if (fromStoreId === toStoreId) fail('Origem e destino precisam ser diferentes.', 400);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail('Revisão inválida do lote.', 400);
  if (input.status && !['open', 'archived'].includes(input.status)) fail('Status inválido do lote.', 400);
  if (!Array.isArray(input.scans) || input.scans.length > MAX_SCANS) fail('O lote comporta até 500 leituras, incluindo removidas.', 400);
  const scans = input.scans.map(scan => {
    if (!scan || !id(scan.clientScanId)) fail('Identificador de leitura inválido.', 400);
    const barcode = String(scan.barcode || '').trim();
    // A failed read is still evidence. Numeric EAN validation belongs to stock confirmation.
    if (!barcode || barcode.length > 100) fail('Código lido inválido.', 400);
    const scannedAt = new Date(scan.createdAt);
    if (typeof scan.createdAt !== 'string' || !Number.isFinite(scannedAt.getTime()) || scannedAt > new Date(Date.now() + 300000) || scannedAt < new Date('2020-01-01T00:00:00Z')) fail('Data da leitura inválida.', 400);
    const productSizeId = uuid(scan.productSizeId || scan.product?.productSizeId, true);
    const confirmedSize = String(scan.confirmedSize || '').trim();
    if (confirmedSize.length > 40) fail('Tamanho informado inválido.', 400);
    return { clientScanId: scan.clientScanId.toLowerCase(), barcode, scannedAt, productSizeId, confirmedSize,
      removed: scan.removed === true, error: String(scan.error || '').slice(0, 500) };
  }).sort((a, b) => a.clientScanId.localeCompare(b.clientScanId));
  if (new Set(scans.map(s => s.clientScanId)).size !== scans.length) fail('Um identificador de bipe foi enviado duas vezes.', 400);
  return { sessionId, mode, fromStoreId, toStoreId, transferId, revision: input.revision, status: input.status || 'open', scans };
}
async function actualActor(db, actor) { if (!actor?.id) fail('Entre com sua conta pessoal.', 403); return operator(db, actor.id); }
async function validateContext(db, actor, value) {
  const currentStoreId = value.mode === 'transfer' ? value.fromStoreId : value.toStoreId;
  if (!canSend(actor, currentStoreId)) fail('Esta loja não está vinculada à sua conta.', 403);
  const stores = await db.store.findMany({ where: { id: { in: [value.fromStoreId, value.toStoreId].filter(Boolean) } }, select: storeSelect });
  if (stores.length !== (value.fromStoreId ? 2 : 1) || stores.some(store => !store.active)) fail('Origem ou destino não está disponível.');
  if (value.transferId) {
    const transfer = await db.stockTransfer.findUnique({ where: { id: value.transferId } });
    let source; try { source = JSON.parse(transfer?.note || '{}').source; } catch (_) { /* invalid note */ }
    if (!transfer || source !== 'bipar-actions-v1' || transfer.toStoreId !== value.toStoreId || (value.fromStoreId && transfer.fromStoreId !== value.fromStoreId)) fail('A remessa não corresponde às lojas deste lote.');
    if (transfer.status !== 'in_transit') fail('A remessa não está aguardando recebimento.');
  }
}
function sameContext(lot, actor, value) {
  if (lot.operatorId !== actor.id) fail('Somente o operador deste lote pode continuar a bipagem.', 403);
  if (lot.mode !== value.mode || lot.fromStoreId !== value.fromStoreId || lot.toStoreId !== value.toStoreId) fail('A ação e as lojas do lote não podem ser alteradas. Abra outro lote.');
}
async function resolveSnapshots(db, scans) {
  const ids = [...new Set(scans.map(s => s.productSizeId).filter(Boolean))];
  const sizes = ids.length ? await db.productSize.findMany({ where: { id: { in: ids } }, include: { product: true } }) : [];
  const cache = new Map();
  const output = [];
  for (const scan of scans) {
    let matches = [];
    if (/^(?:\d{8}|\d{12,14})$/.test(scan.barcode) && key(scan.barcode)) {
      if (!cache.has(key(scan.barcode))) {
        const codes = [...new Set([scan.barcode, key(scan.barcode), scan.barcode.padStart(13, '0'), scan.barcode.padStart(14, '0')])];
        const rows = await db.productSize.findMany({ where: { barcode: { in: codes } }, include: { product: true } });
        const direct = await resolveBarcodeRows(db, rows), aliases = await aliasRows(db, scan.barcode);
        cache.set(key(scan.barcode), [...new Map([...direct, ...aliases].map(row => [row.id, row])).values()]);
      }
      matches = cache.get(key(scan.barcode));
    }
    const ps = sizes.find(s => s.id === scan.productSizeId), exact = matches.length === 1 && matches[0].id === ps?.id;
    const requiresSizeConfirmation = /adidas/i.test(ps?.product?.brand || '');
    const confirmed = !requiresSizeConfirmation || (validSize(scan.confirmedSize) && sizeKey(scan.confirmedSize) === sizeKey(ps?.size));
    const recognized = !!(exact && ps.product.active && validSize(ps.size) && confirmed && (!scan.confirmedSize || sizeKey(scan.confirmedSize) === sizeKey(ps.size)) && !scan.error);
    output.push({ ...scan, recognized, productSizeId: exact ? ps.id : null, productName: exact ? ps.product.name : null,
      brand: exact ? ps.product.brand : null, size: exact ? ps.size : null, requiresSizeConfirmation,
      error: recognized ? null : scan.error || (!exact ? 'Código ou variante ainda não identificado.' : !validSize(ps.size) ? 'Tamanho pendente no cadastro.' : requiresSizeConfirmation ? 'Confira o tamanho BR da caixa Adidas.' : 'Tamanho divergente no cadastro.') });
  }
  return output;
}
function counts(scans) {
  const active = scans.filter(s => !s.removed), recognizedCount = active.filter(s => s.recognized).length;
  const dates = scans.map(s => s.scannedAt).sort((a, b) => a - b);
  return { scanCount: active.length, removedCount: scans.length - active.length, recognizedCount, pendingCount: active.length - recognizedCount,
    firstScannedAt: dates[0] || null, lastScannedAt: dates[dates.length - 1] || null };
}
async function publicLots(db, lots) {
  const transfers = await db.stockTransfer.findMany({ where: { id: { in: [...new Set(lots.map(l => l.transferId).filter(Boolean))] } }, select: { id: true, code: true, fromStoreId: true } });
  const storeIds = [...new Set([...lots.flatMap(l => [l.fromStoreId, l.toStoreId]), ...transfers.map(t => t.fromStoreId)].filter(Boolean))];
  const [stores, users] = await Promise.all([
    db.store.findMany({ where: { id: { in: storeIds } }, select: storeSelect }),
    db.user.findMany({ where: { id: { in: [...new Set(lots.map(l => l.operatorId))] } }, select: { id: true, name: true } }),
  ]);
  return lots.map(lot => ({ sessionId: lot.sessionId, mode: lot.mode, revision: lot.revision, status: lot.status,
    fromStoreId: lot.fromStoreId, toStoreId: lot.toStoreId, fromStore: stores.find(s => s.id === (lot.fromStoreId || transfers.find(t => t.id === lot.transferId)?.fromStoreId)) || null,
    toStore: stores.find(s => s.id === lot.toStoreId) || null, operator: users.find(u => u.id === lot.operatorId) || { id: lot.operatorId, name: '' },
    transferId: lot.transferId, transferCode: transfers.find(t => t.id === lot.transferId)?.code || null,
    createdAt: lot.createdAt, updatedAt: lot.updatedAt, confirmedAt: lot.confirmedAt,
    ...counts(lot.scans || []), totalScanCount: (lot.scans || []).filter(s => !s.removed).length,
  }));
}
async function transaction(db, work) {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(work, { isolationLevel: 'Serializable', timeout: 30000 }); }
    catch (error) { if (!['P2034', 'P2002'].includes(error.code) || attempt >= 5) throw error; }
  }
}
async function sync(db, actor, input) {
  const value = clean(input);
  return transaction(db, async tx => {
    const actual = await actualActor(tx, actor);
    return syncWithin(tx, actual, value, hash(value));
  });
}
async function syncWithin(tx, actual, value, payloadHash, options = {}) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'scan-action-lot:' + value.sessionId}))::text`;
    let lot = await tx.scanActionLot.findUnique({ where: { sessionId: value.sessionId }, include: { scans: true } });
    if (lot) sameContext(lot, actual, value);
    // Check current role/store on retries as well as writes. A confirmed transfer
    // is no longer pending, so only validate its store permission on that path.
    if (!canSend(actual, value.mode === 'transfer' ? value.fromStoreId : value.toStoreId)) fail('Esta loja não está vinculada à sua conta.', 403);
    if (lot?.status === 'confirmed' || (lot && value.revision < lot.revision)) return { lot: (await publicLots(tx, [lot]))[0], synced: false };
    if (lot && value.revision === lot.revision) {
      if (payloadHash !== lot.payloadHash) fail('Esta revisão possui leituras diferentes. Recarregue o lote antes de continuar.');
      return { lot: (await publicLots(tx, [lot]))[0], synced: true };
    }
    await validateContext(tx, actual, value);
    if (lot?.status === 'archived' && value.status !== 'archived') fail('Este lote foi arquivado. Abra um novo lote.');
    const inputIds = new Set(value.scans.map(s => s.clientScanId));
    if (lot?.scans.some(s => !inputIds.has(s.clientScanId))) fail('Há leituras já salvas ausentes. Recarregue o lote para preservar seu histórico.');
    const used = inputIds.size ? await tx.scanActionRead.findFirst({ where: { clientScanId: { in: [...inputIds] }, lotId: { not: value.sessionId } }, select: { clientScanId: true } }) : null;
    if (used) fail('Uma leitura já pertence a outro lote. Use uma nova leitura para outra peça.');
    for (const scan of value.scans) {
      const previous = lot?.scans.find(s => s.clientScanId === scan.clientScanId);
      if (previous && previous.scannedAt.getTime() !== scan.scannedAt.getTime()) fail('O horário original de um bipe não pode ser alterado.');
    }
    // Only resolve/write new or edited readings. Re-sending a growing 500-piece
    // lot must not perform 500 catalog lookups and writes for every new piece.
    const changed = value.scans.filter(scan => {
      const previous = lot?.scans.find(s => s.clientScanId === scan.clientScanId);
      if (options.preserveExisting && previous) return false;
      return previous?.payloadHash !== hash(scan);
    });
    const snapshots = await resolveSnapshots(tx, changed);
    const data = { mode: value.mode, operatorId: actual.id, fromStoreId: value.fromStoreId, toStoreId: value.toStoreId,
      transferId: value.transferId, revision: value.revision, payloadHash, status: value.status };
    if (lot && lot.transferId !== value.transferId) data.transferHistory = [...(Array.isArray(lot.transferHistory) ? lot.transferHistory : []),
      { from: lot.transferId, to: value.transferId, at: new Date().toISOString(), actorId: actual.id }];
    if (lot) await tx.scanActionLot.update({ where: { sessionId: value.sessionId }, data });
    else await tx.scanActionLot.create({ data: { sessionId: value.sessionId, ...data } });
    for (const scan of snapshots) {
      const previous = lot?.scans.find(s => s.clientScanId === scan.clientScanId);
      const history = Array.isArray(previous?.barcodeHistory) ? previous.barcodeHistory : [];
      const scanData = { ...scan, lotId: value.sessionId,
        payloadHash: hash(value.scans.find(s => s.clientScanId === scan.clientScanId)),
        originalBarcode: previous?.originalBarcode || previous?.barcode || scan.barcode,
        barcodeHistory: previous && previous.barcode !== scan.barcode ? [...history, { from: previous.barcode, to: scan.barcode, at: new Date().toISOString(), actorId: actual.id }] : history };
      await tx.scanActionRead.upsert({ where: { clientScanId: scan.clientScanId }, create: scanData, update: scanData });
    }
    lot = await tx.scanActionLot.findUnique({ where: { sessionId: value.sessionId }, include: { scans: true } });
    return { lot: (await publicLots(tx, [lot]))[0], synced: true };
}

// Restores an existing browser draft on behalf of its original operator. This
// grants no authority to confirm stock or edit somebody else's saved readings.
async function recover(db, actor, input = {}) {
  const value = clean(input), originalOperatorId = uuid(input.originalOperatorId);
  return transaction(db, async tx => {
    const recoveredBy = await actualActor(tx, actor);
    if (!['admin', 'superadmin'].includes(recoveredBy.role)) fail('Somente o administrador pode recuperar lotes de outros operadores.', 403);
    const original = await actualActor(tx, { id: originalOperatorId });
    // Both identities are current database identities, never client role claims.
    if (!canSend(original, value.mode === 'transfer' ? value.fromStoreId : value.toStoreId)) fail('A loja original não está vinculada ao operador deste lote.', 403);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'scan-action-lot:' + value.sessionId}))::text`;
    const before = await tx.scanActionLot.findUnique({ where: { sessionId: value.sessionId }, include: { scans: true } });
    let recoveryValue = value;
    if (before) {
      sameContext(before, original, value);
      if (before.status === 'confirmed') return { lot: (await publicLots(tx, [before]))[0], synced: false };
      if (before.transferId !== value.transferId) fail('A recuperação não pode trocar a remessa de um lote já salvo.');
      if (before.status !== value.status) fail('A recuperação não pode reabrir ou arquivar um lote já salvo.');
      // The public history can contain server-resolved fields that differ from
      // the original request hash (for example, the catalog error snapshot).
      // Rebuild every persisted read from the database and append only IDs that
      // are genuinely absent. Recovery must never rewrite an already-saved read.
      const savedIds = new Set(before.scans.map(scan => scan.clientScanId));
      const appended = value.scans.filter(scan => !savedIds.has(scan.clientScanId));
      if (!appended.length) return { lot: (await publicLots(tx, [before]))[0], synced: value.revision === before.revision };
      if (value.revision <= before.revision) fail('O histórico avançou antes da recuperação. Atualize o lote e tente recuperar novamente.');
      if (before.scans.length + appended.length > MAX_SCANS) fail('O lote comporta até 500 leituras, incluindo removidas.', 400);
      const persisted = before.scans.map(scan => ({ clientScanId: scan.clientScanId, barcode: scan.barcode,
        scannedAt: scan.scannedAt, productSizeId: scan.productSizeId, confirmedSize: scan.confirmedSize || '',
        removed: scan.removed === true, error: scan.error || '' }));
      recoveryValue = { ...value, scans: [...persisted, ...appended] };
    }
    const payloadHash = hash(recoveryValue);
    const result = await syncWithin(tx, original, recoveryValue, payloadHash, { preserveExisting: !!before });
    if (!result.synced) return result;
    const auditId = 'scan-recovery:' + hash({ sessionId: value.sessionId, originalOperatorId, revision: recoveryValue.revision, payloadHash });
    const metadata = { source: 'bipar-administrative-recovery-v1', recoveredById: recoveredBy.id, originalOperatorId,
      sessionId: value.sessionId, mode: value.mode, fromStoreId: value.fromStoreId, toStoreId: value.toStoreId,
      transferId: recoveryValue.transferId, revision: recoveryValue.revision, payloadHash, originalStatus: recoveryValue.status,
      previousReadCount: before?.scans.length || 0, readCount: recoveryValue.scans.length, activeCount: result.lot.scanCount,
      removedCount: result.lot.removedCount, pendingCount: result.lot.pendingCount, stockChanged: false };
    await tx.adminAction.upsert({ where: { id: auditId }, update: {}, create: { id: auditId, adminId: recoveredBy.id,
      action: 'scan_action_draft_recovered', description: 'Rascunho de bipagem recuperado com o operador, datas e leituras originais. Nenhum estoque alterado.', metadata: JSON.stringify(metadata) } });
    return result;
  });
}

function day(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) fail('Informe datas no formato AAAA-MM-DD.', 400);
  const date = new Date(value + 'T00:00:00-03:00');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('Data inválida.', 400);
  return date;
}
function period(input) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const from = day(input.from || today.slice(0, 8) + '01'), endDay = day(input.to || today), to = new Date(endDay.getTime() + 86400000);
  if (from >= to) fail('O início deve ser anterior ao fim do período.', 400);
  return { gte: from, lt: to };
}
function visibleWhere(actor, storeId) {
  const allowed = actor.role === 'seller' ? [actor.storeId, ...(actor.storeIds || [])].filter(Boolean) : null;
  if (storeId && (!id(storeId) || (allowed && !allowed.includes(storeId)))) fail('Loja não autorizada.', 403);
  return storeId ? { OR: [{ fromStoreId: storeId }, { toStoreId: storeId }] }
    : allowed ? { OR: [{ fromStoreId: { in: allowed } }, { toStoreId: { in: allowed } }] } : {};
}
async function history(db, actor, input = {}) {
  if (!['transfer', 'receipt'].includes(input.mode)) fail('Selecione Transferência ou Recebimento no histórico.', 400);
  if (input.status && !['all', 'open', 'archived', 'confirmed'].includes(input.status)) fail('Status inválido.', 400);
  const exportAll = input.export === '1';
  const page = exportAll ? 1 : Number(input.page || 1), pageSize = Number(input.pageSize || 50), range = period(input);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('Página inválida.', 400);
  return db.$transaction(async tx => {
    const actual = await actualActor(tx, actor), permission = visibleWhere(actual, input.storeId || '');
    const where = { AND: [permission, { mode: input.mode }, input.status && input.status !== 'all' ? { status: input.status } : {},
      { OR: [{ scans: { some: { scannedAt: range } } }, { confirmedAt: range }] }] };
    const totalLots = await tx.scanActionLot.count({ where });
    const groups = await tx.scanActionRead.groupBy({ by: ['removed', 'recognized'], where: { lot: where, scannedAt: range }, _count: { _all: true } });
    const confirmedWhere = { AND: [permission, { mode: input.mode, status: 'confirmed', confirmedAt: range }, input.status && !['all', 'confirmed'].includes(input.status) ? { sessionId: '__none__' } : {}] };
    const [confirmedLots, confirmedScans, rows] = await Promise.all([
      tx.scanActionLot.count({ where: confirmedWhere }), tx.scanActionRead.count({ where: { lot: confirmedWhere, removed: false } }),
      tx.scanActionLot.findMany({ where, include: { scans: true }, orderBy: [{ createdAt: 'desc' }, { sessionId: 'asc' }], ...(exportAll ? {} : { skip: (page - 1) * pageSize, take: pageSize }) }),
    ]);
    const lots = await publicLots(tx, rows);
    for (let index = 0; index < lots.length; index++) Object.assign(lots[index], counts(rows[index].scans.filter(s => s.scannedAt >= range.gte && s.scannedAt < range.lt)));
    const totals = { lots: totalLots, scans: 0, removed: 0, recognized: 0, pending: 0, confirmedLots, confirmedScans };
    for (const g of groups) { const n = g._count._all; if (g.removed) totals.removed += n; else { totals.scans += n; totals[g.recognized ? 'recognized' : 'pending'] += n; } }
    return { lots, totals, page, pageSize: exportAll ? totalLots : pageSize, totalLots, totalPages: exportAll ? (totalLots ? 1 : 0) : Math.ceil(totalLots / pageSize), from: range.gte.toISOString(), toExclusive: range.lt.toISOString(), exportedAt: exportAll ? new Date().toISOString() : undefined };
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
}
async function detail(db, actor, sessionId) {
  uuid(sessionId);
  return db.$transaction(async tx => {
    const actual = await actualActor(tx, actor), permission = visibleWhere(actual, '');
    const lot = await tx.scanActionLot.findFirst({ where: { AND: [permission, { sessionId }] }, include: { scans: { orderBy: [{ scannedAt: 'asc' }, { clientScanId: 'asc' }] } } });
    if (!lot) fail('Lote não encontrado nas lojas autorizadas.', 404);
    return { lot: (await publicLots(tx, [lot]))[0], scans: lot.scans.map(s => ({ clientScanId: s.clientScanId, barcode: s.barcode, originalBarcode: s.originalBarcode,
      createdAt: s.scannedAt, recordedAt: s.recordedAt, removed: s.removed, recognized: s.recognized, confirmedSize: s.confirmedSize || '',
      requiresSizeConfirmation: s.requiresSizeConfirmation, error: s.error || '', product: s.productSizeId ? { productSizeId: s.productSizeId, name: s.productName, brand: s.brand, size: s.size, barcode: s.barcode } : null })) };
  }, { isolationLevel: 'RepeatableRead', timeout: 30000 });
}

// Called only inside the stock confirmation transaction, after its authoritative
// catalog/quantity/stock validation. Legacy callers need not have synced first.
async function markConfirmed(tx, actor, value, transfer, items) {
  let sessionId = value.sessionId || null;
  if (!sessionId && value.scans.length) {
    const existing = await tx.scanActionRead.findMany({ where: { clientScanId: { in: value.scans.map(s => s.clientScanId) } }, select: { lotId: true } });
    const ids = [...new Set(existing.map(s => s.lotId))];
    if (ids.length > 1) fail('As leituras pertencem a lotes diferentes.');
    sessionId = ids[0] || null;
  }
  sessionId ||= randomUUID();
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'scan-action-lot:' + sessionId}))::text`;
  let lot = await tx.scanActionLot.findUnique({ where: { sessionId }, include: { scans: true } });
  const fromStoreId = value.mode === 'transfer' ? transfer.fromStoreId : (lot?.fromStoreId || null);
  const context = { mode: value.mode, fromStoreId, toStoreId: transfer.toStoreId, transferId: lot?.transferId || null };
  if (lot) {
    sameContext(lot, actor, context);
    if (lot.status !== 'open') fail('Este lote já foi confirmado ou arquivado.');
    const active = lot.scans.filter(s => !s.removed).map(s => s.clientScanId).sort();
    if (JSON.stringify(active) !== JSON.stringify(value.scans.map(s => s.clientScanId).sort())) fail('O lote salvo mudou. Atualize e confira todas as peças antes de confirmar.');
    if (lot.transferId && lot.transferId !== transfer.id) fail('Este recebimento está vinculado a outra remessa.');
  }
  const used = value.scans.length ? await tx.scanActionRead.findFirst({ where: { clientScanId: { in: value.scans.map(s => s.clientScanId) }, lotId: { not: sessionId } } }) : null;
  if (used) fail('Uma leitura já pertence a outro lote.');
  const now = value.mode === 'receipt' ? transfer.receivedAt : transfer.createdAt;
  if (!lot) lot = await tx.scanActionLot.create({ data: { sessionId, mode: value.mode, operatorId: actor.id, fromStoreId, toStoreId: transfer.toStoreId, payloadHash: '', revision: 0 } });
  for (const scan of value.scans) {
    const item = items.find(i => i.productSizeId === scan.productSizeId), prior = lot.scans?.find(s => s.clientScanId === scan.clientScanId);
    if (prior && (prior.barcode !== scan.barcode || (prior.productSizeId && prior.productSizeId !== scan.productSizeId))) fail('Uma leitura mudou desde a sincronização. Confira o lote novamente.');
    const data = { lotId: sessionId, barcode: scan.barcode, recognized: true, productSizeId: scan.productSizeId,
      productName: item.productName, brand: item.brand, size: item.size, confirmedSize: scan.confirmedSize || '', error: null, removed: false };
    await tx.scanActionRead.upsert({ where: { clientScanId: scan.clientScanId }, create: { clientScanId: scan.clientScanId, scannedAt: now, originalBarcode: scan.barcode, ...data }, update: data });
  }
  await tx.scanActionLot.update({ where: { sessionId }, data: { transferId: transfer.id, confirmedAt: now, status: 'confirmed' } });
  return sessionId;
}

module.exports = { MAX_SCANS, sync, recover, history, detail, markConfirmed };
