'use strict';
const {createHash}=require('node:crypto');
const scope=require('./stocktakeScope');
const images=require('./stockReplacementImages');
const policy=require('../../public/scanner-barcode-policy');
const {applyStoreStockDelta}=require('./storeStockLedger');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const photoDigest=value=>createHash('sha256').update(Buffer.from(value.slice(value.indexOf(',')+1),'base64')).digest('hex');
const normalized=value=>String(value||'').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');
const sizeKey=value=>String(value||'').replace(',','.').trim();
function reasonText(reason){if(reason==='photo_barcode_not_found')return 'O código de barras não ficou legível nesta foto. Reenquadre a mesma etiqueta.';if(reason==='photo_barcode_mismatch')return 'O código confirmado na foto é diferente do código lido. Confira a mesma peça.';return ({produto_ou_variante_pendente:'Produto ou variante ainda não identificados.',foto_ou_codigo_pendente:'Falta a foto arquivada com o código desta peça.',tipo_de_produto_pendente:'Conferir a classificação do produto para esta contagem de calçados.',codigo_da_foto_divergente:'O código da foto não confirmou o código lido.',tamanho_da_foto_divergente:'O tamanho BR da foto difere do cadastro. Conferir antes de incluir.',referencia_ou_marca_divergente:'A referência e a marca da etiqueta ainda precisam ser confirmadas.',photo_barcode_conflict:'A foto não permitiu confirmar um único código de barras.',photo_size_or_reference_pending:'Falta confirmar o tamanho BR e a referência na foto.',ocr_busy:'Conferência da foto na fila.',ocr_timeout:'A leitura da foto será tentada novamente.',ocr_unavailable:'Conferência local da foto temporariamente indisponível.',
 ocr_memory_limit:'A conferência da foto excedeu a memória disponível; leitura preservada.',
 photo_input_invalid:'O arquivo da foto não pôde ser processado. Confira a foto desta peça.',
 operator_not_authorized:'O operador original desta leitura está sem autorização para esta loja.',
 repeat_confirmation_required:'Código repetido. Falta confirmar que é outro par físico.',
 photo_decode_busy:'A conferência do código da foto está na fila.',
 photo_decode_timeout:'A conferência do código da foto excedeu o tempo disponível.',
 photo_decode_unavailable:'A conferência do código da foto está temporariamente indisponível.',
 photo_decode_memory_limit:'A conferência do código da foto excedeu a memória disponível.',
 photo_decode_failed:'Não foi possível conferir o código na foto desta peça.',
 leitura_encerrada:'Leitura encerrada ou excluída.'})[reason]||'Foto arquivada; aguardando conferência para entrar no novo estoque.';}
function fail(message,status=409){const e=Error(message);e.status=status;throw e;}
async function preview(db,storeId){
 const store=await db.store.findUnique({where:{id:storeId},select:{id:true,code:true,name:true,active:true}});
 if(!store?.active)fail('Selecione uma loja ativa.',400);
 const rows=await db.storeStock.findMany({where:{storeId},orderBy:{productSizeId:'asc'},include:{productSize:{include:{product:true}}}});
 const baseline=rows.map(row=>({productSizeId:row.productSizeId,stock:row.stock,productId:row.productSize.productId,size:row.productSize.size,
  barcode:row.productSize.barcode,name:row.productSize.product.name,brand:row.productSize.product.brand,sku:row.productSize.product.sku,
  category:row.productSize.product.category,imageUrl:row.productSize.product.imageUrl}));
 const active=await db.stocktakeRound.findFirst({where:{activeReplacementStoreId:storeId},select:{id:true,number:true,status:true}});
 return {store,baseline,active,variants:baseline.length,units:baseline.reduce((n,row)=>n+row.stock,0),reviewToken:hash({store,baseline})};
}
async function start(db,{storeId,requestId,reviewToken},actorId){
 if(!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId||''))fail('Identificação da substituição inválida.',400);
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock-replacement:${storeId}`}))::text`;
  const existing=await tx.stocktakeRound.findUnique({where:{id:requestId}});
  if(existing){if(existing.operationType!=='replacement'||existing.storeId!==storeId)fail('Identificação já utilizada em outra operação.');return {round:existing,alreadyStarted:true};}
  await tx.$executeRaw`LOCK TABLE "StoreStock" IN SHARE ROW EXCLUSIVE MODE`;
  const current=await preview(tx,storeId);
  if(current.active)fail('Já há uma substituição em andamento nesta loja. Abra a operação existente.');
  if(reviewToken!==current.reviewToken)fail('O estoque mudou. Atualize a conferência de início; nada foi substituído.');
  const productScope=await scope.build(tx,'footwear');
  const [clock]=await tx.$queryRaw`SELECT clock_timestamp() AS "startedAt"`;
  const round=await tx.stocktakeRound.create({data:{id:requestId,storeId,name:'Substituição de estoque · '+current.store.code,
   operationType:'replacement',activeReplacementStoreId:storeId,createdById:actorId,baseline:current.baseline,productScope,startedAt:clock.startedAt}});
  // The complete previous balance is committed with its archive, atomically.
  // No previous scans or balances are imported into the new stock.
  for(const row of current.baseline){if(!row.stock)continue;
   await applyStoreStockDelta(tx,{storeId,productSizeId:row.productSizeId,quantity:-row.stock,type:'inventory_adjustment',source:'stock-replacement-start',reason:'Novo estoque; saldo anterior arquivado na substituição #'+round.number,metadata:{roundId:round.id,actorId}});
  }
  return {round,archivedVariants:current.variants,archivedUnits:current.units};
 },{timeout:60000});
}
async function context(db,bipeId){
 const bipe=await db.stocktakeBipe.findUnique({where:{id:bipeId}});
 if(!bipe?.roundId)return null;
 const round=await db.stocktakeRound.findUnique({where:{id:bipe.roundId},select:{id:true,number:true,operationType:true,storeId:true,status:true}});
 if(round?.operationType!=='replacement')return null;
 const capture=await db.productCapture.findFirst({where:{bipeId,roundId:round.id,storeId:round.storeId,excludedAt:null},orderBy:{createdAt:'desc'}});
 const size=bipe.productSizeId?await db.productSize.findUnique({where:{id:bipe.productSizeId},include:{product:true}}):null;
 return {bipe,round,capture,size};
}
async function pending(db,c,reason,evidence){
 await db.stockReplacementCheck.createMany({data:[{bipeId:c.bipe.id,roundId:c.round.id,reason,evidence:evidence||undefined}],skipDuplicates:true});
 return db.stockReplacementCheck.updateMany({where:{bipeId:c.bipe.id,appliedAt:null},data:{reason,evidence:evidence||undefined,checkedAt:new Date()}});
}
function validateRead(c,read){
 const {bipe,capture,size}=c,p=size?.product;
 if(bipe.excludedAt||!['counting','review'].includes(c.round.status))return 'leitura_encerrada';
 if(!bipe.found||bipe.duplicate||!p?.active||size.productId!==bipe.productId)return 'produto_ou_variante_pendente';
 if(!policy.isScanCode(bipe.barcode)||!capture?.photo||policy.identity(capture.barcode)!==policy.identity(bipe.barcode))return 'foto_ou_codigo_pendente';
 if(scope.classification(p)!=='footwear')return 'tipo_de_produto_pendente';
 if(!read||read.pending)return read?.reason||'etiqueta_pendente';
 if(read.source!=='archived-photo-local-ocr-v1'||read.decodedBarcodes?.length!==1||policy.identity(read.decodedBarcodes[0])!==policy.identity(bipe.barcode))return 'codigo_da_foto_divergente';
 if(sizeKey(read.size)!==sizeKey(size.size))return 'tamanho_da_foto_divergente';
 return null;
}
async function referenceMatches(db,c,read){
 const p=c.size.product;let ctx=p.aiContext||{};if(typeof ctx==='string'){try{ctx=JSON.parse(ctx)}catch(_){ctx={}}}
 const catalogRefs=[p.sku,ctx.supplierRef].map(normalized).filter(Boolean);
 const refs=[...catalogRefs,...(Array.isArray(ctx.scannerReferences)?ctx.scannerReferences:[]).map(normalized)].filter(Boolean);
 const fiscal=await require('./scannerArchivedLabel').fiscalRows(db,c.bipe.barcode);
 for(const row of fiscal.filter(r=>r.productId===p.id)){
  refs.push(normalized(row.supplierCode));
  catalogRefs.push(normalized(row.supplierCode));
  const reebok=normalized(p.brand)==='REEBOK'&&normalized(row.supplierCode).match(/^(\d{9})[A-Z]{2,12}\d{2}$/);
  if(reebok)refs.push(reebok[1]);
 }
 let match;
 if(normalized(p.brand)==='SKECHERS'){
  // These catalog prefixes do not appear on the box. Keep the complete
  // printed model AND colour; never match a model-only or historical colour.
  const printedRef=value=>normalized(value).match(/^(?:GTM|GTW|T|R)?(\d{5,6}(?:BR)?[A-Z]{2,6})$/)?.[1];
  const expected=new Set(catalogRefs.map(printedRef).filter(Boolean));
  if(expected.size){
   if(expected.size!==1)return null;
   const candidates=(read.references||[]).map(ref=>({ref,key:printedRef(ref)})).filter(item=>item.key);
   if(candidates.some(item=>!expected.has(item.key)))return null;
   match=candidates.find(item=>expected.has(item.key))?.ref;
   if(!match)return null;
  }
 }
 // SKU prefixes used by the existing catalog are identifiers, not new models.
 for(const ref of [...refs])if(ref.startsWith('T')&&ref.length>5)refs.push(ref.slice(1));
 match=match||(read.references||[]).find(ref=>refs.includes(normalized(ref)));
 const brands=[...String(read.text||'').matchAll(/\b(REEBOK|NIKE|ADIDAS|PUMA|FILA|ASICS|SKECHERS|MIZUNO|OLYMPIKUS)\b/gi)].map(m=>normalized(m[1]));
 return match&&!brands.some(brand=>brand!==normalized(p.brand))?match:null;
}
// Only server-generated evidence is accepted here. No HTTP route accepts an OCR verdict.
async function applyVerified(db,c,read,reference,options={}){
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${c.round.id} FOR SHARE`;
  // Match late linking's round -> capture -> bipe order. savePhoto's UPDATE
  // must wait here, so its revision cannot change between verification and +1.
  if(!c.capture?.id)return {applied:false,reason:'foto_ou_codigo_pendente'};
  await tx.$queryRaw`SELECT id FROM "ProductCapture" WHERE id=${c.capture.id} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "StocktakeBipe" WHERE id=${c.bipe.id} FOR UPDATE`;
  const now=await context(tx,c.bipe.id), prior=await tx.stockReplacementCheck.findUnique({where:{bipeId:c.bipe.id}});
  if(prior?.appliedAt)return {applied:!prior.reversedAt,idempotent:true};
  const reason=now&&validateRead(now,read);
  if(!now||reason||!require('./stockReplacementQueue').matches(now.capture,require('./stockReplacementQueue').snapshot(c.capture))||now.size.id!==c.size.id||now.size.product.sku!==c.size.product.sku||now.size.product.brand!==c.size.product.brand)return {applied:false,reason:reason||'leitura_alterada'};
  if(options.beforeCommit&&!await require('./stockReplacementCaptureRecovery').authorized(tx,now.capture))return {applied:false,reason:'operator_not_authorized'};
  if(!await referenceMatches(tx,now,read))return {applied:false,reason:'referencia_ou_marca_divergente'};
  const snapshot={captureId:now.capture.id,photoSha256:photoDigest(now.capture.photo),barcode:now.bipe.barcode,reference,size:now.size.size,
   productId:now.size.productId,productSizeId:now.size.id,name:now.size.product.name,brand:now.size.product.brand,
   source:read.source,verifiedAt:new Date().toISOString()};
  const movement=await applyStoreStockDelta(tx,{storeId:now.round.storeId,productSizeId:now.size.id,quantity:1,type:'inventory_adjustment',source:'stock-replacement-scan',reason:'Bipe validado da substituição #'+now.round.number,metadata:{roundId:now.round.id,bipeId:now.bipe.id,captureId:now.capture.id}});
  const imageReview={status:'pending',reason:now.size.product.imageUrl?'Conferir correspondência visual da imagem de catálogo com este modelo e cor.':'Produto sem imagem de catálogo.',imageUrl:now.size.product.imageUrl||null};
  await tx.stockReplacementCheck.upsert({where:{bipeId:now.bipe.id},create:{bipeId:now.bipe.id,roundId:now.round.id,status:'applied',evidence:snapshot,imageReview,appliedProductSizeId:now.size.id,appliedAt:new Date()},update:{status:'applied',reason:null,evidence:snapshot,imageReview,appliedProductSizeId:now.size.id,appliedAt:new Date(),checkedAt:new Date()}});
  await tx.stocktakeBipe.update({where:{id:now.bipe.id},data:{applied:true,productName:now.size.product.name,productBrand:now.size.product.brand,productSize:now.size.size}});
  await tx.productCapture.update({where:{id:now.capture.id},data:{status:'vinculado',resolvedAt:new Date(),note:require('./scannerCapturePhoto').photoNote(now.capture.note,'etiqueta Uma peça incluída no novo estoque oficial.')},select:{id:true}});
  if(options.beforeCommit)await options.beforeCommit(tx);
  return {applied:true,stock:movement.stockAfter};
 },{timeout:20000});
}
async function check(db,bipeId,options={}){
 const c=await context(db,bipeId);if(!c||c.bipe.excludedAt||!['counting','review'].includes(c.round.status))return;
 const prior=await db.stockReplacementCheck.findUnique({where:{bipeId}});if(prior?.appliedAt){if(!prior.reversedAt)await images.check(db,bipeId);return {applied:!prior.reversedAt,idempotent:true};}
 if(options.evidenceCapture&&!require('./stockReplacementQueue').matches(c.capture,require('./stockReplacementQueue').snapshot(options.evidenceCapture)))return {applied:false,reason:'leitura_alterada'};
 const early=validateRead(c,{pending:true,reason:'aguardando_conferencia_da_etiqueta'});
 if(early!=='aguardando_conferencia_da_etiqueta'){if(!options.deferPending)await pending(db,c,early);return {applied:false,reason:early};}
 const bytes=Buffer.from(c.capture.photo.slice(c.capture.photo.indexOf(',')+1),'base64');
 const read=options.read||await require('./scannerArchivedLabel').readImage(bytes,c.bipe.barcode);
 // A busy worker has not examined this piece. Keep its queue age so an older
 // timed-out image cannot repeatedly push every untouched piece behind itself.
 if(read?.reason==='ocr_busy')return {applied:false,reason:'ocr_busy'};
 const reason=validateRead(c,read);if(reason){if(!options.deferPending)await pending(db,c,reason,{captureId:c.capture.id,photoSha256:photoDigest(c.capture.photo)});return {applied:false,reason};}
 const reference=await referenceMatches(db,c,read);
 if(!reference){if(!options.deferPending)await pending(db,c,'referencia_ou_marca_divergente',{captureId:c.capture.id,photoSha256:photoDigest(c.capture.photo)});return {applied:false,reason:'referencia_ou_marca_divergente'};}
 const result=await applyVerified(db,c,read,reference,options);if(result.applied)await images.check(db,bipeId);return result;
}
function enqueue(db,bipeId){return require('./stockReplacementQueue').enqueue(db,bipeId);}
async function resume(db){
 return require('./stockReplacementQueue').get(db).reconcile();
}
async function report(db,id){
 const round=await db.stocktakeRound.findUnique({where:{id}});if(round?.operationType!=='replacement')fail('Substituição não encontrada.',404);
 const [store,bipes,captures,checks,current,movements]=await Promise.all([
  db.store.findUnique({where:{id:round.storeId},select:{id:true,name:true,code:true}}),
  db.stocktakeBipe.findMany({where:{roundId:id},orderBy:{bipedAt:'asc'}}),
  db.productCapture.findMany({where:{roundId:id},select:{id:true,bipeId:true,excludedAt:true,status:true,barcode:true,createdAt:true}}),
  db.stockReplacementCheck.findMany({where:{roundId:id}}),
  db.storeStock.findMany({where:{storeId:round.storeId},include:{productSize:{include:{product:true}}}}),
  db.storeStockMovement.findMany({where:{storeId:round.storeId,createdAt:{gte:round.startedAt}},orderBy:{createdAt:'asc'}})
 ]);
 const active=bipes.filter(b=>!b.excludedAt),applied=checks.filter(c=>c.appliedAt&&!c.reversedAt),byId=new Map(checks.map(c=>[c.bipeId,c]));
 const pendingReads=active.filter(b=>!byId.get(b.id)?.appliedAt);
 const orphanPhotos=captures.filter(c=>!c.excludedAt&&c.status!=='descartado'&&!c.bipeId);
 const productsBySize=new Map(current.map(s=>[s.productSizeId,s.productSize.product]));
 const imagePending=applied.filter(c=>!productsBySize.has(c.appliedProductSizeId)||!images.matches(c.imageReview,productsBySize.get(c.appliedProductSizeId)));
 const newMovements=movements.filter(m=>m.source!=='stock-replacement-start');
 const expected=new Map();for(const m of newMovements)expected.set(m.productSizeId,(expected.get(m.productSizeId)||0)+m.quantity);
 const currentMap=new Map(current.map(s=>[s.productSizeId,s.stock]));
 const unexplained=[...new Set([...currentMap.keys(),...expected.keys()])].filter(id=>(currentMap.get(id)||0)!==(expected.get(id)||0));
 const blockers=[];if(pendingReads.length||orphanPhotos.length)blockers.push((pendingReads.length+orphanPhotos.length)+' leituras ainda não validadas.');
 if(imagePending.length)blockers.push(imagePending.length+' imagens de catálogo ainda sem conferência visual comprovada.');
 if(unexplained.length)blockers.push(unexplained.length+' saldos precisam de conciliação com as movimentações.');
 if(!active.length)blockers.push('Nenhuma peça foi contada.');
 const reviewToken=hash({id,status:round.status,bipes,checks,current:current.map(s=>[s.productSizeId,s.stock]),movements:movements.map(m=>m.id)});
 return {round,store,totals:{reads:active.length,applied:applied.length,pending:pendingReads.length+orphanPhotos.length,photos:captures.filter(c=>!c.excludedAt).length,imagePending:imagePending.length,stockUnits:current.reduce((n,s)=>n+s.stock,0)},
  bipes,captures,checks:checks.map(c=>({...c,reasonText:reasonText(c.reason),imageCurrentVerified:!!productsBySize.has(c.appliedProductSizeId)&&images.matches(c.imageReview,productsBySize.get(c.appliedProductSizeId)),imageFingerprint:productsBySize.has(c.appliedProductSizeId)?images.fingerprint(productsBySize.get(c.appliedProductSizeId)):null})),current:current.map(s=>({productSizeId:s.productSizeId,stock:s.stock,size:s.productSize.size,name:s.productSize.product.name,brand:s.productSize.product.brand,sku:s.productSize.product.sku,imageUrl:s.productSize.product.imageUrl})),movements,blockers,reviewToken,canFinish:!blockers.length};
}
async function exclude(tx,bipe,reason){
 const check=await tx.stockReplacementCheck.findUnique({where:{bipeId:bipe.id}});
 if(!check?.appliedAt||check.reversedAt)return;
 await applyStoreStockDelta(tx,{storeId:bipe.storeId,productSizeId:check.appliedProductSizeId,quantity:-1,type:'inventory_adjustment',source:'stock-replacement-correction',reason,metadata:{roundId:bipe.roundId,bipeId:bipe.id}});
 await tx.stockReplacementCheck.update({where:{bipeId:bipe.id},data:{status:'excluded',reversedAt:new Date(),reason}});
}
async function finish(db,id){
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${id} FOR UPDATE`;
  const r=await report(tx,id);if(r.round.status==='closed')return {ok:true,alreadyFinished:true};
  if(!r.canFinish)fail('A conferência ainda tem pendências: '+r.blockers.join(' '));
  await tx.$executeRaw`LOCK TABLE "StoreStock" IN SHARE ROW EXCLUSIVE MODE`;
  const final=await report(tx,id);if(!final.canFinish)fail('O saldo mudou durante a conferência. Confira as pendências.');
  await tx.stocktakeRound.update({where:{id},data:{status:'closed',activeReplacementStoreId:null,endedAt:new Date(),appliedAt:new Date(),result:{totals:final.totals,current:final.current,reviewToken:final.reviewToken}}});
  return {ok:true,totals:final.totals};
 },{timeout:30000});
}
module.exports={preview,start,context,check,enqueue,resume,report,finish,exclude,validateRead,referenceMatches,applyVerified,reasonText};
