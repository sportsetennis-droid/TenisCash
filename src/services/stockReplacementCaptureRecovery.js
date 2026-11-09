'use strict';
const barcodePolicy=require('../../public/scanner-barcode-policy');
const photos=require('./scannerCapturePhoto');
const catalog=require('./scannerCatalog');
const staff=require('./scanTransfers');

function eligible(capture,round){
 if(!capture||capture.excludedAt||capture.status==='descartado')return 'capture_inactive';
 if(!round||round.operationType!=='replacement'||round.status!=='counting'||round.activeReplacementStoreId!==round.storeId)return 'round_inactive';
 if(capture.roundId!==round.id||capture.storeId!==round.storeId)return 'store_or_round_conflict';
 const prefix=round.id+':';
 if(!capture.scanKey?.startsWith(prefix)||!/^[a-zA-Z0-9_-]{8,80}$/.test(capture.scanKey.slice(prefix.length)))return 'scan_key_invalid';
 if(!photos.revisionOf(capture.note)||!capture.photo||!barcodePolicy.isScanCode(capture.barcode))return 'photo_or_barcode_pending';
 if(!capture.sellerId||new Date(capture.createdAt)<new Date(round.startedAt))return 'capture_origin_pending';
 return null;
}
async function authorized(db,capture){
 const store=await db.store.findUnique({where:{id:capture.storeId},select:{active:true}});
 if(!store?.active)return false;
 try{return staff.canSend(await staff.operator(db,capture.sellerId),capture.storeId)}catch(error){if(error.status===403)return false;throw error;}
}
function sameCapture(a,b){
 return ['roundId','storeId','scanKey','barcode','sellerId','sellerName','photo'].every(key=>a[key]===b[key])&&
  photos.revisionOf(a.note)===photos.revisionOf(b.note)&&new Date(a.createdAt).getTime()===new Date(b.createdAt).getTime();
}

// Only server-archived bytes are decoded. Dependency injection is for isolated
// service tests; no route accepts a barcode/OCR verdict or recovery identity.
function createRecovery({decode=photo=>require('./barcodeDecoder').decodeBarcodesFromDataUri(photo),enqueue=(db,id)=>require('./stockReplacement').enqueue(db,id)}={}){
 let running=false,lastId=null;
 async function recover(db,captureId){
  const original=await db.productCapture.findUnique({where:{id:captureId}});
  const originalRound=original?.roundId?await db.stocktakeRound.findUnique({where:{id:original.roundId}}):null;
  const early=eligible(original,originalRound);if(early)return {recovered:false,reason:early};
  if(!await authorized(db,original))return {recovered:false,reason:'operator_not_authorized'};
  let decoded;
  try{decoded=await decode(original.photo)}catch(_){return {recovered:false,reason:'photo_decode_failed'}}
  if(decoded?.length!==1||barcodePolicy.identity(decoded[0])!==barcodePolicy.identity(original.barcode))return {recovered:false,reason:'photo_barcode_conflict'};
  const result=await db.$transaction(async tx=>{
   // New scanner writes hold FOR SHARE on this row. The short update lock
   // serializes recovery with those writes before testing repeated codes.
   await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${original.roundId} FOR UPDATE`;
   await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${original.scanKey}))::text`;
   const capture=await tx.productCapture.findUnique({where:{id:captureId}});
   const round=await tx.stocktakeRound.findUnique({where:{id:original.roundId}});
   const reason=eligible(capture,round);if(reason)return {recovered:false,reason};
   if(!sameCapture(original,capture))return {recovered:false,reason:'capture_changed'};
   await tx.$queryRaw`SELECT id FROM "User" WHERE id=${capture.sellerId} FOR SHARE`;
   await tx.$queryRaw`SELECT id FROM "Store" WHERE id=${capture.storeId} FOR SHARE`;
   if(!await authorized(tx,capture))return {recovered:false,reason:'operator_not_authorized'};
   let bipe=await tx.stocktakeBipe.findUnique({where:{scanKey:capture.scanKey}});
   if(bipe){
    if(bipe.excludedAt||bipe.roundId!==capture.roundId||bipe.storeId!==capture.storeId||bipe.sellerId!==capture.sellerId||
     barcodePolicy.identity(bipe.barcode)!==barcodePolicy.identity(capture.barcode)||capture.bipeId&&capture.bipeId!==bipe.id)return {recovered:false,reason:'bipe_context_conflict'};
   }else{
    if(capture.bipeId)return {recovered:false,reason:'capture_already_linked'};
    const repeated=await tx.stocktakeBipe.findFirst({where:{roundId:round.id,storeId:capture.storeId,excludedAt:null,barcode:{in:barcodePolicy.variants(capture.barcode)}},select:{id:true}});
    if(repeated)return {recovered:false,reason:'repeat_confirmation_required'};
    let rows=await catalog.resolveBarcodeRows(tx,await tx.productSize.findMany({where:{barcode:{in:barcodePolicy.variants(capture.barcode)}},include:{product:true},take:3}));
    if(!rows.length)rows=await catalog.aliasRows(tx,capture.barcode);
    const chosen=rows.length===1&&rows[0].product?.active?rows[0]:null;
    bipe=await tx.stocktakeBipe.create({data:{roundId:round.id,scanKey:capture.scanKey,storeId:capture.storeId,
     barcode:capture.barcode,sellerId:capture.sellerId,sellerName:capture.sellerName,bipedAt:capture.createdAt,
     productId:chosen?.productId||null,productSizeId:chosen?.id||null,productName:chosen?.product.name||null,
     productSize:chosen?.size||null,productBrand:chosen?.product.brand||null,
     found:rows.length>0,duplicate:rows.length>1,applied:false}});
   }
   if(capture.bipeId!==bipe.id)await tx.productCapture.update({where:{id:capture.id},data:{bipeId:bipe.id,
    status:'pendente',note:photos.photoNote(capture.note,'etiqueta Código recuperado da foto arquivada. Aguardando conferência.')}});
   return {recovered:true,bipeId:bipe.id,scanKey:bipe.scanKey,applied:false};
  },{timeout:20000});
  // Recovery only restores the same scan record. Normal photo/BR/reference
  // verification remains the sole path that can add its unit to stock.
  if(result.recovered)enqueue(db,result.bipeId);
  return result;
 }
 async function resume(db){
  if(running)return {busy:true};running=true;
  try{
   const where={bipeId:null,excludedAt:null,status:{not:'descartado'},photo:{not:null},barcode:{not:null},
    round:{operationType:'replacement',status:'counting',activeReplacementStoreId:{not:null}}};
   // Fetch IDs only, then one photo at a time. Rotate the cursor so persistent
   // errors cannot keep newer captures behind the first page forever.
   let captures=await db.productCapture.findMany({where:{...where,...(lastId?{id:{gt:lastId}}:{})},orderBy:{id:'asc'},take:20,select:{id:true}});
   if(!captures.length&&lastId){lastId=null;captures=await db.productCapture.findMany({where,orderBy:{id:'asc'},take:20,select:{id:true}});}
   const results=[];
   for(const capture of captures){lastId=capture.id;try{results.push({captureId:capture.id,...await recover(db,capture.id)})}catch(error){console.warn('[replacement/capture-recovery]',capture.id,error.message);results.push({captureId:capture.id,recovered:false,reason:'recovery_failed'});}}
   return {results};
  }finally{running=false;}
 }
 return {recover,resume};
}
module.exports={...createRecovery(),createRecovery};
