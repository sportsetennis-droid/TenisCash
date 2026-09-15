'use strict';
const { createHash } = require('node:crypto');
function fail(message, status = 409) { const e = new Error(message); e.status = status; throw e; }
function scanKey(roundId, clientScanId) {
  if (!roundId || !/^[a-zA-Z0-9_-]{8,80}$/.test(String(clientScanId || ''))) fail('Atualize o scanner: esta leitura precisa de rodada e identificador próprios.');
  return roundId + ':' + clientScanId;
}
async function roundForScan(db, storeId, roundId, lock = false) {
  if (!storeId || !roundId) fail('Nenhuma rodada selecionada. Abra o scanner atualizado e escolha a loja. Os bipes antigos não entram na nova contagem.');
  if (lock) await db.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id = ${roundId} FOR SHARE`;
  const round = await db.stocktakeRound.findUnique({ where: { id: roundId } });
  if (!round || round.storeId !== storeId) fail('A rodada não pertence à loja selecionada.');
  if (round.status !== 'counting') fail('A coleta desta rodada está encerrada. Esta leitura não foi transferida para outra rodada.');
  return round;
}
async function createRoundBipe(db, input) {
  const {requireRepeatConfirmation,repeatConfirmedCount,...data}=input;
  return db.$transaction(async tx => {
    await roundForScan(tx, data.storeId, data.roundId, true);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${data.scanKey}))::text`;
    const existing = await tx.stocktakeBipe.findUnique({ where: { scanKey: data.scanKey } });
    if (existing) {
      if (existing.storeId !== data.storeId || existing.roundId !== data.roundId || existing.barcode !== data.barcode) fail('Conflito no identificador da leitura.');
      return existing;
    }
    if(requireRepeatConfirmation){
      const code=String(data.barcode).replace(/^0+/,'');
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${data.roundId+'|'+data.storeId+'|'+code}))::text`;
      const retry=await tx.stocktakeBipe.findUnique({where:{scanKey:data.scanKey}});
      if(retry)return retry;
      const previous=await tx.stocktakeBipe.findMany({where:{storeId:data.storeId,roundId:data.roundId,excludedAt:null,barcode:{in:[code,code.padStart(13,'0'),code.padStart(14,'0')]}},select:{id:true,productName:true,productSize:true}});
      if(previous.length && Number(repeatConfirmedCount)!==previous.length){
        const e=new Error('Este código já foi bipado nesta loja e rodada. Confirme se é outro par.');e.status=409;e.repeat={count:previous.length,name:previous[0].productName,size:previous[0].productSize,barcode:data.barcode};throw e;
      }
    }
    return tx.stocktakeBipe.create({ data });
  });
}
async function createRoundCapture(db, data) {
  return db.$transaction(async tx => {
    await roundForScan(tx, data.storeId, data.roundId, true);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${data.scanKey}))::text`;
    if (data.bipeId) {
      const bipe = await tx.stocktakeBipe.findUnique({ where: { id: data.bipeId } });
      if (!bipe || bipe.roundId !== data.roundId || bipe.storeId !== data.storeId) fail('A foto não pertence à rodada do bipe.');
    }
    const existing = await tx.productCapture.findUnique({ where: { scanKey: data.scanKey } });
    if (existing) {
      if (existing.roundId !== data.roundId || existing.storeId !== data.storeId || existing.barcode !== data.barcode) fail('Conflito na foto reenviada.');
      return existing;
    }
    return tx.productCapture.create({ data });
  });
}
function barcodePending(bipe) {
  const code=String(bipe.barcode||'').trim();
  return !code || /^REF:/i.test(code) || /^SEM\s*GTIN$/i.test(code);
}
function summarize(bipes, captures) {
  const active = bipes.filter(b => !b.excludedAt);
  const valid = active.filter(b => b.found && !b.duplicate && b.productSizeId && b.productSize && b.productSize !== '?' && !/^T-/.test(b.productSize));
  const orphanPhotos = captures.filter(c => !c.excludedAt && c.status !== 'descartado' && (!c.bipeId || c.status === 'processando'));
  return { total: active.length + orphanPhotos.filter(c => !c.bipeId).length, matched: valid.length,
    barcodePending: valid.filter(barcodePending).length, pending: active.length - valid.length + orphanPhotos.length, excluded: bipes.length - active.length };
}
async function roundReport(db, id) {
  const round = await db.stocktakeRound.findUnique({ where: { id } });
  if (!round) fail('Rodada não encontrada.', 404);
  const [bipes, captures, stock, store] = await Promise.all([
    db.stocktakeBipe.findMany({ where: { roundId: id }, orderBy: { bipedAt: 'desc' } }),
    db.productCapture.findMany({ where: { roundId: id }, select: { id:true,bipeId:true,status:true,excludedAt:true } }),
    db.storeStock.findMany({ where: { storeId: round.storeId }, select: { productSizeId: true, stock: true } }),
    db.store.findUnique({ where: { id: round.storeId }, select: { id:true,name:true,code:true } }),
  ]);
  const totals = summarize(bipes, captures);
  const counts = new Map();
  for (const b of bipes) if (!b.excludedAt && b.found && !b.duplicate && b.productSizeId) counts.set(b.productSizeId, (counts.get(b.productSizeId) || 0) + 1);
  const before = new Map((Array.isArray(round.baseline) ? round.baseline : []).map(s => [s.productSizeId, s.stock]));
  const current = new Map(stock.map(s => [s.productSizeId, s.stock]));
  const sizeIds = [...new Set([...before.keys(), ...current.keys(), ...counts.keys()])].sort();
  const sizes = sizeIds.length ? await db.productSize.findMany({ where: { id: { in: sizeIds } }, include: { product: { select: { name:true,sku:true,active:true } } } }) : [];
  const sizeMap = new Map(sizes.map(s => [s.id,s]));
  const lines = sizeIds.map(id => ({ productSizeId:id, name:sizeMap.get(id)?.product.name || '(cadastro removido)',
    sku:sizeMap.get(id)?.product.sku || '', size:sizeMap.get(id)?.size || '', active:!!sizeMap.get(id)?.product.active,
    before:before.get(id)||0, current:current.get(id)||0, counted:counts.get(id)||0, difference:(counts.get(id)||0)-(current.get(id)||0) }));
  const movements = await db.storeStockMovement.count({ where: { storeId:round.storeId, createdAt:{gte:round.startedAt} } });
  const stockChanged = lines.some(l => l.before !== l.current);
  const reviewToken = createHash('sha256').update(JSON.stringify({ id, status:round.status, totals, lines, movements,
    reads:bipes.map(b=>[b.id,b.productSizeId,b.excludedAt]),captures })).digest('hex');
  return { round,store,totals,lines,bipes,captures,movements,stockChanged,reviewToken };
}
async function startRound(db, storeId, name, userId) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${String(storeId)}))::text`;
    const store = await tx.store.findUnique({ where: { id:storeId } });
    if (!store?.active) fail('Selecione uma loja ativa.',400);
    const existing = await tx.stocktakeRound.findFirst({ where: { activeStoreId:storeId } });
    if (existing) return existing; // Double click/retry never opens two rounds.
    const baseline = await tx.storeStock.findMany({ where: {storeId}, select:{productSizeId:true,stock:true} });
    return tx.stocktakeRound.create({ data:{ storeId,activeStoreId:storeId,name:String(name||'Inventário completo').trim().slice(0,100),
      createdById:userId||null,baseline } });
  });
}
async function finishRound(db,id,reviewToken,fullStoreConfirmed) {
  if (fullStoreConfirmed !== true) fail('Confirme a conferência completa da loja antes de atualizar o estoque.');
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id = ${id} FOR UPDATE`;
    const round = await tx.stocktakeRound.findUnique({ where:{id} });
    if (round?.status === 'closed') return {ok:true,alreadyClosed:true};
    if (round?.status !== 'review') fail('Encerre a coleta e confira o relatório primeiro.');
    // Prevent sales or manual adjustments racing the stock comparison and replacement.
    await tx.$executeRaw`LOCK TABLE "StoreStock" IN SHARE ROW EXCLUSIVE MODE`;
    const report = await roundReport(tx,id);
    if (reviewToken !== report.reviewToken) fail('O relatório mudou. Atualize e confira novamente.');
    if (!report.totals.total || report.totals.pending) fail('Resolva as leituras pendentes antes de fechar o inventário.');
    if (report.totals.barcodePending) fail('Há produtos identificados sem código de barras escaneado. Complete essas leituras antes de fechar o inventário.');
    if (report.movements || report.stockChanged) fail('Houve movimentação de estoque durante a coleta. É necessário reconciliar essas movimentações antes de aplicar; o estoque foi preservado.');
    if (report.lines.some(l=>!l.active)) fail('Há cadastro inativo ou removido. Revise antes de aplicar.');
    for (const line of report.lines) {
      if (!line.difference) continue;
      await tx.storeStock.upsert({ where:{storeId_productSizeId:{storeId:round.storeId,productSizeId:line.productSizeId}},
        create:{storeId:round.storeId,productSizeId:line.productSizeId,stock:line.counted}, update:{stock:line.counted} });
      await tx.storeStockMovement.create({ data:{storeId:round.storeId,productSizeId:line.productSizeId,type:'inventory_adjustment',
        quantity:line.difference,stockBefore:line.current,stockAfter:line.counted,source:'stocktake-round',
        reason:'Fechamento do inventário #'+round.number,metadata:{roundId:id}} });
    }
    await tx.stocktakeRound.update({ where:{id}, data:{status:'closed',activeStoreId:null,appliedAt:new Date(),
      result:{totals:report.totals,lines:report.lines}} });
    return {ok:true};
  },{timeout:30000});
}
module.exports={barcodePending,fail,scanKey,roundForScan,createRoundBipe,createRoundCapture,summarize,roundReport,startRound,finishRound};

