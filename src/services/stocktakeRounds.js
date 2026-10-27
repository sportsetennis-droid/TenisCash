'use strict';
const { createHash } = require('node:crypto');
const RECONSTRUCTION_STORE_CODES = new Set(['LOJA02','LOJA03','LOJA04','LOJA05','LOJA06','LOJA07']);
const SEPARATE_COMPANY_STORE_CODES = new Set(['LOJA01']);
function fail(message, status = 409, details = null) { const e = new Error(message); e.status = status; if(details)e.details=details; throw e; }
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
  const {captureId,requireRepeatConfirmation,repeatConfirmedCount,...data}=input;
  return db.$transaction(async tx => {
    await roundForScan(tx, data.storeId, data.roundId, true);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${data.scanKey}))::text`;
    if (captureId) {
      const capture = await tx.productCapture.findUnique({ where: { id: captureId } });
      if (!capture || capture.excludedAt || capture.status === 'descartado' || capture.scanKey !== data.scanKey ||
          capture.roundId !== data.roundId || capture.storeId !== data.storeId ||
          String(capture.barcode || '').replace(/^0+/, '') !== String(data.barcode || '').replace(/^0+/, ''))
        fail('A foto desta leitura não está ativa nesta loja e rodada.');
    }
    const existing = await tx.stocktakeBipe.findUnique({ where: { scanKey: data.scanKey } });
    if (existing) {
      if (existing.storeId !== data.storeId || existing.roundId !== data.roundId || existing.barcode !== data.barcode) fail('Conflito no identificador da leitura.');
      return existing;
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
  const reconstruction=round.reconstructionId?await db.stocktakeReconstruction.findUnique({where:{id:round.reconstructionId},select:{id:true,number:true,name:true,status:true,appliedAt:true}}):null;
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
  return { round,reconstruction,store,totals,lines,bipes,captures,movements,stockChanged,reviewToken };
}
async function catalogFingerprint(db) {
  const sizes=await db.productSize.findMany({
    orderBy:{id:'asc'},
    select:{id:true,productId:true,size:true,barcode:true,product:{select:{sku:true,name:true,brand:true,active:true}}},
  });
  const snapshot=sizes.map(s=>[s.id,s.productId,s.size,s.barcode,s.product?.sku||'',s.product?.name||'',s.product?.brand||'',!!s.product?.active]);
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
async function reconstructionStoreScope(db) {
  const activeStores=await db.store.findMany({where:{active:true},select:{id:true,name:true,code:true},orderBy:{id:'asc'}});
  return {
    stores:activeStores.filter(store=>RECONSTRUCTION_STORE_CODES.has(store.code)),
    excludedStores:activeStores.filter(store=>SEPARATE_COMPANY_STORE_CODES.has(store.code)),
    unknownStores:activeStores.filter(store=>!RECONSTRUCTION_STORE_CODES.has(store.code)&&!SEPARATE_COMPANY_STORE_CODES.has(store.code)),
  };
}
async function startReconstruction(db,name,userId) {
  return db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('stock-reconstruction:active'))::text`;
    const active=await tx.stocktakeReconstruction.findFirst({where:{status:'counting'},select:{id:true,number:true,name:true}});
    if(active)fail(`Já existe reconstrução #${active.number} em andamento. Conclua ou arquive esse lote antes de iniciar outro.`);
    await tx.$executeRaw`LOCK TABLE "Store" IN SHARE MODE`;
    const scope=await reconstructionStoreScope(tx);
    if(scope.unknownStores.length)fail('Há loja(s) ativa(s) sem grupo empresarial confirmado. A reconstrução foi interrompida para não misturar empresas.',409,{unknownStores:scope.unknownStores});
    const {stores}=scope;
    if(!stores.length)fail('Não há lojas ativas da Sports & Tennis (LOJA02–LOJA07) para reconstruir.',400);
    const storeIds=stores.map(s=>s.id);
    for(const storeId of storeIds)await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${String(storeId)}))::text`;
    const conflicts=await tx.stocktakeRound.findMany({where:{activeStoreId:{in:storeIds}},select:{id:true,number:true,name:true,storeId:true,status:true}});
    if(conflicts.length)fail('Há rodadas antigas ainda abertas. Arquive ou conclua cada uma antes de começar a reconstrução do zero.',409,{conflicts});
    await tx.$executeRaw`LOCK TABLE "Product" IN SHARE MODE`;
    await tx.$executeRaw`LOCK TABLE "ProductSize" IN SHARE MODE`;
    await tx.$executeRaw`LOCK TABLE "StoreStock" IN SHARE ROW EXCLUSIVE MODE`;
    const startedAt=new Date();
    const fingerprint=await catalogFingerprint(tx);
    const batch=await tx.stocktakeReconstruction.create({data:{name:String(name||'Reconstrução física da rede').trim().slice(0,100),createdById:userId||null,storeIds,catalogFingerprint:fingerprint,startedAt}});
    const rounds=[];
    for(const store of stores){
      const baseline=await tx.storeStock.findMany({where:{storeId:store.id},select:{productSizeId:true,stock:true}});
      rounds.push(await tx.stocktakeRound.create({data:{storeId:store.id,activeStoreId:store.id,reconstructionId:batch.id,
        name:`${batch.name} · ${store.code||store.name}`.slice(0,100),createdById:userId||null,baseline,startedAt}}));
    }
    return {batch,stores,excludedStores:scope.excludedStores,rounds};
  },{timeout:30000});
}
async function reconstructionReport(db,id,{includeDetails=true}={}) {
  const batch=await db.stocktakeReconstruction.findUnique({where:{id}});
  if(!batch)fail('Reconstrução não encontrada.',404);
  const expectedIds=Array.isArray(batch.storeIds)?batch.storeIds.map(String).sort():[];
  const [rounds,scope,currentFingerprint]=await Promise.all([
    db.stocktakeRound.findMany({where:{reconstructionId:id},orderBy:{number:'asc'}}),
    reconstructionStoreScope(db),
    catalogFingerprint(db),
  ]);
  const reports=await Promise.all(rounds.map(r=>roundReport(db,r.id)));
  const currentIds=scope.stores.map(s=>s.id).sort();
  const roundStoreIds=rounds.map(r=>r.storeId).sort();
  const storeScopeChanged=JSON.stringify(currentIds)!==JSON.stringify(expectedIds);
  const roundScopeInvalid=JSON.stringify(roundStoreIds)!==JSON.stringify(expectedIds)||new Set(roundStoreIds).size!==expectedIds.length;
  const catalogChanged=currentFingerprint!==batch.catalogFingerprint;
  const blockers=[];
  if(batch.status!=='counting')blockers.push('Esta reconstrução não está aberta.');
  if(storeScopeChanged)blockers.push('O conjunto de lojas ativas mudou desde a abertura.');
  if(scope.unknownStores.length)blockers.push('Há loja(s) ativa(s) sem grupo empresarial confirmado; a aplicação está bloqueada para evitar misturar empresas.');
  if(roundScopeInvalid)blockers.push('O lote não contém exatamente uma rodada para cada loja prevista.');
  if(catalogChanged)blockers.push('O catálogo de produtos/tamanhos/códigos mudou durante a contagem.');
  for(const report of reports){
    const label=report.store?.code||report.store?.name||report.round.storeId;
    if(report.round.status!=='review')blockers.push(`${label}: coleta ainda não foi encerrada para conferência.`);
    if(report.totals.pending)blockers.push(`${label}: ${report.totals.pending} leitura(s) pendente(s).`);
    if(report.totals.barcodePending)blockers.push(`${label}: ${report.totals.barcodePending} item(ns) sem código de barras confirmado.`);
    if(report.movements||report.stockChanged)blockers.push(`${label}: houve movimento ou alteração no estoque oficial após o início.`);
    if(report.lines.some(line=>!line.active))blockers.push(`${label}: há variante inativa ou removida na conferência.`);
  }
  const responseReports=includeDetails?reports:reports.map(({bipes,captures,lines,...r})=>({
    ...r,lineCount:lines.length,differenceCount:lines.filter(line=>line.difference!==0).length,
    differenceUnits:lines.reduce((sum,line)=>sum+Math.abs(line.difference),0),
  }));
  return {batch,stores:scope.stores,excludedStores:scope.excludedStores,unknownStores:scope.unknownStores,expectedStoreIds:expectedIds,reports:responseReports,storeScopeChanged,roundScopeInvalid,catalogChanged,canApply:blockers.length===0,blockers};
}
async function applyReconstruction(db,id,roundReviews) {
  const confirmations=Array.isArray(roundReviews)?roundReviews:[];
  return db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "StocktakeReconstruction" WHERE id=${id} FOR UPDATE`;
    const batch=await tx.stocktakeReconstruction.findUnique({where:{id}});
    if(!batch)fail('Reconstrução não encontrada.',404);
    if(batch.status==='applied')return {ok:true,alreadyApplied:true,number:batch.number};
    if(batch.status!=='counting')fail('Reconstrução cancelada ou encerrada.');
    await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE "reconstructionId"=${id} ORDER BY id FOR UPDATE`;
    await tx.$executeRaw`LOCK TABLE "Store" IN SHARE MODE`;
    await tx.$executeRaw`LOCK TABLE "Product" IN SHARE MODE`;
    await tx.$executeRaw`LOCK TABLE "ProductSize" IN SHARE MODE`;
    await tx.$executeRaw`LOCK TABLE "StoreStock" IN SHARE ROW EXCLUSIVE MODE`;
    const report=await reconstructionReport(tx,id);
    const confirmationsById=new Map(confirmations.map(item=>[String(item?.roundId||''),item]));
    for(const storeReport of report.reports){
      const label=storeReport.store?.code||storeReport.store?.name||storeReport.round.storeId;
      const confirmation=confirmationsById.get(storeReport.round.id);
      if(confirmation?.fullStoreConfirmed!==true)fail(`Confirme a conferência completa da loja ${label}.`);
      if(storeReport.round.status!=='review')fail(`Encerre e confira a coleta da loja ${label}.`);
      if(confirmation.reviewToken!==storeReport.reviewToken)fail(`O relatório da loja ${label} mudou. Atualize e confira novamente.`);
    }
    if(confirmationsById.size!==report.reports.length)fail('A confirmação deve conter exatamente uma revisão para cada loja do lote.');
    if(!report.canApply)fail('A reconstrução não pode ser aplicada. Resolva todas as pendências antes de substituir o estoque.',409,{blockers:report.blockers});
    const appliedAt=new Date();
    const resultStores=[];
    for(const storeReport of report.reports){
      const {round,lines,totals,store}=storeReport;
      for(const line of lines){
        if(!line.difference)continue;
        await tx.storeStock.upsert({where:{storeId_productSizeId:{storeId:round.storeId,productSizeId:line.productSizeId}},
          create:{storeId:round.storeId,productSizeId:line.productSizeId,stock:line.counted},update:{stock:line.counted}});
        await tx.storeStockMovement.create({data:{storeId:round.storeId,productSizeId:line.productSizeId,type:'inventory_adjustment',
          quantity:line.difference,stockBefore:line.current,stockAfter:line.counted,source:'stocktake-reconstruction',
          reason:'Reconstrução completa da rede #'+batch.number,metadata:{reconstructionId:id,roundId:round.id}}});
      }
      await tx.stocktakeRound.update({where:{id:round.id},data:{status:'closed',activeStoreId:null,appliedAt,result:{totals,lines}}});
      resultStores.push({storeId:round.storeId,storeName:store?.name||null,roundId:round.id,totals,lines});
    }
    await tx.stocktakeReconstruction.update({where:{id},data:{status:'applied',endedAt:appliedAt,appliedAt,result:{stores:resultStores}}});
    return {ok:true,number:batch.number,stores:resultStores};
  },{timeout:60000});
}
async function cancelReconstruction(db,id) {
  return db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "StocktakeReconstruction" WHERE id=${id} FOR UPDATE`;
    const batch=await tx.stocktakeReconstruction.findUnique({where:{id}});
    if(!batch)fail('Reconstrução não encontrada.',404);
    if(batch.status==='cancelled')return {ok:true,alreadyCancelled:true};
    if(batch.status==='applied')fail('A reconstrução já foi aplicada e não pode ser arquivada como não aplicada.');
    await tx.stocktakeRound.updateMany({where:{reconstructionId:id,status:{in:['counting','review']}},data:{status:'cancelled',activeStoreId:null,endedAt:new Date()}});
    await tx.stocktakeReconstruction.update({where:{id},data:{status:'cancelled',endedAt:new Date()}});
    return {ok:true};
  },{timeout:30000});
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
    if (round.reconstructionId) fail('Esta rodada pertence a uma reconstrução de rede. O saldo só pode ser aplicado junto com todas as lojas do lote.');
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
module.exports={barcodePending,fail,scanKey,roundForScan,createRoundBipe,createRoundCapture,summarize,roundReport,catalogFingerprint,
  startReconstruction,reconstructionReport,applyReconstruction,cancelReconstruction,startRound,finishRound};

