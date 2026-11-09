'use strict';
const assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const url=process.env.ROUND_TEST_DATABASE_URL;
if(!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/stock_replacement_'))throw Error('Use exclusivamente banco stock_replacement_ local isolado na porta 55329.');
const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url}}});
const {createRecovery}=require('../src/services/stockReplacementCaptureRecovery');
const photos=require('../src/services/scannerCapturePhoto'),decoder=require('../src/services/barcodeDecoder');
const repeatConfirmation=require('../src/services/scannerRepeatConfirmation');
process.env.JWT_SECRET='isolated-capture-recovery-repeat-test-key';
const writer=require('zxing-wasm/writer');
writer.prepareZXingModule({overrides:{wasmBinary:fs.readFileSync(path.join(__dirname,'../node_modules/zxing-wasm/dist/writer/zxing_writer.wasm'))}});
const queued=[];
const service=createRecovery({enqueue:(_db,id)=>queued.push(id)});
const code=()=>{const base='9'+randomUUID().replace(/\D/g,'').padEnd(11,'0').slice(0,11);return base+((10-[...base].reduce((s,n,i)=>s+Number(n)*(i%2?3:1),0)%10)%10)};
async function image(barcode){const rendered=await writer.writeBarcode(barcode,{format:'EAN-13',scale:3,addQuietZones:true});assert.equal(rendered.error,'');return 'data:image/png;base64,'+Buffer.from(await rendered.image.arrayBuffer()).toString('base64');}
async function fixture(){
 const suffix=randomUUID(),store=await db.store.create({data:{code:'REC-'+suffix,name:'Recovery test'}});
 const seller=await db.user.create({data:{name:'Original operator '+suffix,role:'seller',storeId:store.id,phone:'REC-'+suffix,pin:'test-only'}});
 const round=await db.stocktakeRound.create({data:{name:'Recovery isolated',storeId:store.id,operationType:'replacement',status:'counting',activeReplacementStoreId:store.id,baseline:[],startedAt:new Date(Date.now()-60000)}});
 return {store,seller,round};
}
async function capture(f,override={}){
 const barcode=override.barcode||code();
 return db.productCapture.create({data:{roundId:f.round.id,storeId:f.store.id,sellerId:f.seller.id,sellerName:f.seller.name,
  scanKey:f.round.id+':'+randomUUID(),barcode,photo:await image(barcode),note:photos.photoNote('','Saved original','1'),createdAt:new Date(Date.now()-1000),...override}});
}
async function product(barcode,suffix=randomUUID()){
 const p=await db.product.create({data:{sku:'REC-'+suffix,name:'Tênis teste',brand:'PUMA',category:'Tênis',price:100}});
 const ps=await db.productSize.create({data:{productId:p.id,size:'41',barcode,stock:0}});return {p,ps};
}
async function unchanged(f,c,reason,s=service){
 const before=await db.stocktakeBipe.count({where:{roundId:f.round.id}}),result=await s.recover(db,c.id);
 assert.equal(result.recovered,false,JSON.stringify(result));if(reason)assert.equal(result.reason,reason);
 assert.equal(await db.stocktakeBipe.count({where:{roundId:f.round.id}}),before);
 assert.equal((await db.productCapture.findUnique({where:{id:c.id}})).bipeId,c.bipeId);
 return result;
}
(async()=>{
 const f=await fixture(),c=await capture(f),{p,ps}=await product(c.barcode);
 await db.storeStock.create({data:{storeId:f.store.id,productSizeId:ps.id,stock:0}});
 const copies=await Promise.all(Array.from({length:6},()=>service.recover(db,c.id)));
 assert.ok(copies.every(x=>x.recovered));assert.equal(new Set(copies.map(x=>x.bipeId)).size,1);
 const b=await db.stocktakeBipe.findUnique({where:{id:copies[0].bipeId}}),linked=await db.productCapture.findUnique({where:{id:c.id}});
 assert.equal(b.sellerId,f.seller.id);assert.equal(b.sellerName,c.sellerName);assert.equal(b.bipedAt.getTime(),c.createdAt.getTime());assert.equal(b.scanKey,c.scanKey);
 assert.equal(b.productSizeId,ps.id);assert.equal(b.productId,p.id);assert.equal(b.found,true);assert.equal(b.duplicate,false);assert.equal(b.applied,false);
 assert.equal(linked.photo,c.photo);assert.equal(photos.revisionOf(linked.note),'1');assert.equal(linked.bipeId,b.id);
 assert.equal((await db.storeStock.findUnique({where:{storeId_productSizeId:{storeId:f.store.id,productSizeId:ps.id}}})).stock,0);
 assert.equal(await db.storeStockMovement.count({where:{storeId:f.store.id}}),0);
 assert.equal(await db.stocktakeBipe.count({where:{roundId:f.round.id}}),1);assert.ok(queued.includes(b.id));
 console.log('PASS same archived capture: concurrent retries keep one bipe, original operator/time/photo/key and zero stock before verification');

 const repeated=await capture(f,{barcode:c.barcode});await unchanged(f,repeated,'repeat_confirmation_required');
 let blockedDecodeCalls=0;
 await unchanged(f,repeated,'repeat_confirmation_required',createRecovery({decode:async()=>{blockedDecodeCalls++;throw Error('blocked repeat must not decode')},enqueue:()=>{}}));
 assert.equal(blockedDecodeCalls,0);
 // Simulate an authenticated acceptance committed with the original photo,
 // followed by a lost request before createRoundBipe/HTTP acknowledgement.
 await photos.savePhoto(db,{...repeated,photoRevision:'1'}, {afterSave:(tx,cap)=>repeatConfirmation.record(tx,cap,
  {actorId:f.seller.id,confirmedCount:1,photo:repeated.photo,photoRevision:'1',barcode:repeated.barcode})});
 const resumed=await service.recover(db,repeated.id),resumedBipe=await db.stocktakeBipe.findUnique({where:{id:resumed.bipeId}});
 assert.equal(resumed.recovered,true);assert.equal(resumedBipe.scanKey,repeated.scanKey);assert.equal(resumedBipe.sellerId,repeated.sellerId);
 assert.equal(resumedBipe.bipedAt.getTime(),repeated.createdAt.getTime());assert.equal(resumedBipe.applied,false);
 assert.equal((await service.recover(db,repeated.id)).bipeId,resumed.bipeId);
 assert.equal(await db.stocktakeBipe.count({where:{roundId:f.round.id,barcode:c.barcode}}),2);
 assert.equal(await db.storeStockMovement.count({where:{storeId:f.store.id}}),0);
 console.log('PASS persisted explicit confirmation survives lost upload response; historical repeat avoids decoder; recovery reuses original key/time/photo and remains unapplied/idempotent');
 const ownerA=await capture(f,{barcode:c.barcode}),ownerB=await capture(f,{barcode:c.barcode}),ownerWrong=await capture(f,{barcode:c.barcode,photo:await image(code())});
 const ownerManifest=JSON.stringify({source:'explicit-owner-chat-confirmation-v1',executor:'system-maintenance',operationId:'isolated-owner-capture-recovery',
  confirmedBy:'Test owner',userStatement:'These exact three test capture IDs represent separate physical pairs',targets:[ownerA,ownerB,ownerWrong].map(cap=>({
   captureId:cap.id,roundId:cap.roundId,storeId:cap.storeId,scanKey:cap.scanKey,sellerId:cap.sellerId,sellerName:cap.sellerName,barcode:cap.barcode,
   createdAt:cap.createdAt.toISOString(),photoRevision:photos.revisionOf(cap.note),photoDataUrlSha256:createHash('sha256').update(cap.photo).digest('hex')}))});
 for(const cap of [ownerA,ownerB,ownerWrong])await db.$transaction(tx=>repeatConfirmation.recordOwnerReview(tx,cap,{manifestText:ownerManifest}));
 const ownerResults=await Promise.all([service.recover(db,ownerA.id),service.recover(db,ownerB.id)]);
 assert.ok(ownerResults.every(x=>x.recovered));assert.equal(new Set(ownerResults.map(x=>x.bipeId)).size,2);
 for(let i=0;i<2;i++){
  const cap=[ownerA,ownerB][i],result=ownerResults[i],bipe=await db.stocktakeBipe.findUnique({where:{id:result.bipeId}});
  assert.equal(bipe.sellerId,cap.sellerId);assert.equal(bipe.scanKey,cap.scanKey);assert.equal(bipe.bipedAt.getTime(),cap.createdAt.getTime());assert.equal(bipe.applied,false);
  assert.equal((await service.recover(db,cap.id)).bipeId,result.bipeId);
 }
 assert.equal(await db.stocktakeBipe.count({where:{roundId:f.round.id,barcode:c.barcode}}),4);
 await unchanged(f,ownerWrong,'photo_barcode_mismatch');
 const outsideOwner=await capture(f,{barcode:c.barcode});await unchanged(f,outsideOwner,'repeat_confirmation_required');
 await assert.rejects(()=>db.$transaction(tx=>repeatConfirmation.recordOwnerReview(tx,outsideOwner,{manifestText:ownerManifest})),e=>e.status===409);
 assert.equal(await db.storeStockMovement.count({where:{storeId:f.store.id}}),0);
 console.log('PASS explicit owner grants bind only finite manifest capture IDs; concurrent same-EAN recovery survives count growth, preserves original identities, remains idempotent and cannot bypass original-photo decode or stock verification');
 const race=await fixture(),raceCode=code(),raceA=await capture(race,{barcode:raceCode}),raceB=await capture(race,{barcode:raceCode});
 const raceResults=await Promise.all([service.recover(db,raceA.id),service.recover(db,raceB.id)]);
 assert.equal(raceResults.filter(x=>x.recovered).length,1);assert.equal(raceResults.filter(x=>x.reason==='repeat_confirmation_required').length,1);
 assert.equal(await db.stocktakeBipe.count({where:{roundId:race.round.id}}),1);
 const unknown=await db.stocktakeBipe.findFirst({where:{roundId:race.round.id}});assert.equal(unknown.found,false);assert.equal(unknown.productSizeId,null);assert.equal(unknown.applied,false);
 console.log('PASS two separate events with same code need repeat confirmation; unknown valid archived event stays pending without stock');

 const existingCapture=await capture(f),existing=await db.stocktakeBipe.create({data:{scanKey:existingCapture.scanKey,roundId:f.round.id,storeId:f.store.id,
  sellerId:f.seller.id,sellerName:f.seller.name,barcode:existingCapture.barcode,bipedAt:existingCapture.createdAt}});
 assert.equal((await service.recover(db,existingCapture.id)).bipeId,existing.id);
 assert.equal((await db.productCapture.findUnique({where:{id:existingCapture.id}})).bipeId,existing.id);
 const badExistingCapture=await capture(f);await db.stocktakeBipe.create({data:{scanKey:badExistingCapture.scanKey,roundId:f.round.id,storeId:f.store.id,sellerId:f.seller.id,barcode:badExistingCapture.barcode,excludedAt:new Date()}});
 await unchanged(f,badExistingCapture,'bipe_context_conflict');

 const ambiguous=await capture(f);await product(ambiguous.barcode);await product(ambiguous.barcode);
 const amb=await service.recover(db,ambiguous.id),ambB=await db.stocktakeBipe.findUnique({where:{id:amb.bipeId}});
 assert.equal(ambB.found,true);assert.equal(ambB.duplicate,true);assert.equal(ambB.productSizeId,null);assert.equal(ambB.applied,false);
 const consolidated=await capture(f),target=await product(null);
 const legacy=await db.product.create({data:{sku:'REC-OLD-'+randomUUID(),name:'Old product',brand:'PUMA',category:'Tênis',price:1,active:false,aiContext:{consolidatedInto:target.p.id}}});
 await db.productSize.create({data:{productId:legacy.id,size:'41',barcode:consolidated.barcode,stock:0}});
 const consolidatedResult=await service.recover(db,consolidated.id);assert.equal((await db.stocktakeBipe.findUnique({where:{id:consolidatedResult.bipeId}})).productSizeId,target.ps.id);
 const aliased=await capture(f),aliasTarget=await product(null);
 await db.product.update({where:{id:aliasTarget.p.id},data:{aiContext:{scannerBarcodeAliases:{[aliased.barcode.replace(/^0+/,'')]:{size:'41'}}}}});
 const aliasResult=await service.recover(db,aliased.id);assert.equal((await db.stocktakeBipe.findUnique({where:{id:aliasResult.bipeId}})).productSizeId,aliasTarget.ps.id);
 console.log('PASS existing event links without another bipe; excluded, ambiguous, consolidated and exact alias catalog paths preserve normal rules');

 const other=await fixture();
 for(const [overrides,reason] of [
  [{excludedAt:new Date()},'capture_inactive'],[{status:'descartado'},'capture_inactive'],
  [{storeId:other.store.id},'store_or_round_conflict'],[{scanKey:other.round.id+':'+randomUUID()},'scan_key_invalid'],
  [{scanKey:f.round.id+':short'},'scan_key_invalid'],[{note:'No photo revision'},'photo_or_barcode_pending'],
  [{photo:null},'photo_or_barcode_pending'],[{sellerId:null},'capture_origin_pending'],
  [{createdAt:new Date(f.round.startedAt.getTime()-1)},'capture_origin_pending'],
  [{sellerId:other.seller.id},'operator_not_authorized']]){
  await unchanged(f,await capture(f,overrides),reason);
 }
 const inactive=await fixture();await db.user.update({where:{id:inactive.seller.id},data:{active:false}});
 await unchanged(inactive,await capture(inactive),'operator_not_authorized');
 const inactiveStore=await fixture();await db.store.update({where:{id:inactiveStore.store.id},data:{active:false}});
 await unchanged(inactiveStore,await capture(inactiveStore),'operator_not_authorized');
 for(const fields of [{status:'closed'},{status:'review'},{operationType:'inventory'},{activeReplacementStoreId:null}]){
  const closed=await fixture(),cap=await capture(closed);await db.stocktakeRound.update({where:{id:closed.round.id},data:fields});await unchanged(closed,cap,'round_inactive');
 }
 console.log('PASS closed/non-replacement rounds, excluded captures, foreign stores/keys, missing evidence, inactive/foreign operators are untouched');

 const invalidPhoto=await capture(f,{photo:'data:image/png;base64,aW52YWxpZA=='});await unchanged(f,invalidPhoto);
 const wrongImage=await capture(f,{photo:await image(code())});await unchanged(f,wrongImage,'photo_barcode_mismatch');
 const multiple=await capture(f);await unchanged(f,multiple,'photo_barcode_conflict',createRecovery({decode:async()=>[multiple.barcode,code()],enqueue:()=>{throw Error('must not enqueue')}}));
 for(const mutation of [
  {note:photos.photoNote('','New photo','2')},{photo:await image(code())},{sellerName:'Changed name'},{sellerId:other.seller.id},
 ]){
  const stale=await capture(f),staleService=createRecovery({decode:async photo=>{const codes=await decoder.decodeBarcodesFromDataUri(photo);await db.productCapture.update({where:{id:stale.id},data:mutation});return codes},enqueue:()=>{throw Error('must not enqueue')}});
  await unchanged(f,stale,'capture_changed',staleService);
 }
 const lostPermission=await fixture(),lost=await capture(lostPermission);
 await unchanged(lostPermission,lost,'operator_not_authorized',createRecovery({decode:async photo=>{const codes=await decoder.decodeBarcodesFromDataUri(photo);await db.user.update({where:{id:lostPermission.seller.id},data:{active:false}});return codes},enqueue:()=>{throw Error('must not enqueue')}}));
 console.log('PASS invalid/mismatched/multiple barcode photos, changed revision/photo/operator and revoked authorization cannot create a bipe');
 assert.equal(await db.storeStockMovement.count({where:{storeId:f.store.id}}),0);

 // Resume owns one asynchronous sweep, even if a timer fires while decoding.
 let release,entered;const gate=new Promise(r=>release=r),begun=new Promise(r=>entered=r);
 const sweep=createRecovery({decode:async photo=>{entered();await gate;return decoder.decodeBarcodesFromDataUri(photo)},enqueue:()=>{}});
 const run=sweep.resume(db);await begun;assert.deepEqual(await sweep.resume(db),{busy:true});release();await run;
 console.log('PASS timer recovery has one in-flight sweep and no direct stock application');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>db.$disconnect());
