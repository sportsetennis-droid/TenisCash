'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),express=require('express'),jwt=require('jsonwebtoken');
const url=process.env.ROUND_TEST_DATABASE_URL;
if(!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/stock_replacement_'))throw Error('Somente banco PostgreSQL isolado na porta 55329.');
process.env.DATABASE_URL=url;
const mw=require('../src/middleware'),db=mw.prisma,queues=require('../src/services/stockReplacementQueue'),photos=require('../src/services/scannerCapturePhoto');
queues.get(db,{work:false});
const oldInterval=global.setInterval,oldTimeout=global.setTimeout;global.setInterval=global.setTimeout=()=>({unref(){}});
const router=require('../src/routes/stocktake');global.setInterval=oldInterval;global.setTimeout=oldTimeout;
const priority=4000000+Math.floor(Math.random()*1000000);
const q=queues.createQueue(db,{connectionString:url,work:false,jobPriority:priority,readImage:async(_bytes,barcode)=>({source:'archived-photo-local-ocr-v1',decodedBarcodes:[barcode],size:'41',references:['PENDING001'],text:'PUMA PENDING001 BR 41'})});
let server,photo,png;
function code(){const b='7'+randomUUID().replace(/\D/g,'').padEnd(11,'0').slice(0,11);return b+((10-[...b].reduce((s,n,i)=>s+Number(n)*(i%2?3:1),0)%10)%10);}
async function fixture({linked=true,footwear=false}={}){
 const id=randomUUID(),store=await db.store.create({data:{code:'PENDING-'+id,name:'Pending isolated'}}),seller=await db.user.create({data:{name:'Pending seller',phone:'PENDING-'+id,role:'seller',storeId:store.id,pin:'test-only'}});
 const round=await db.stocktakeRound.create({data:{name:'Pending isolated',storeId:store.id,operationType:'replacement',activeReplacementStoreId:store.id,baseline:[{imageUrl:'a'.repeat(50000)}],startedAt:new Date(Date.now()-5000)}});
 const p=await db.product.create({data:{sku:'PENDING001-'+id,name:footwear?'Tênis teste pendente':'SAPATO CASUAL FEMININO',brand:'PUMA',category:'Tênis',price:100,aiContext:{scannerReferences:['PENDING001']}}});
 const ps=await db.productSize.create({data:{productId:p.id,size:'41',barcode:code(),stock:0}}),clientScanId=randomUUID(),scanKey=round.id+':'+clientScanId;
 let bipe;if(linked)bipe=await db.stocktakeBipe.create({data:{roundId:round.id,storeId:store.id,sellerId:seller.id,barcode:ps.barcode,scanKey,productId:p.id,productSizeId:ps.id,productSize:'41',found:true}});
 const saved=await photos.savePhoto(db,{roundId:round.id,storeId:store.id,scanKey,photo,barcode:ps.barcode,sellerId:seller.id,sellerName:seller.name,photoRevision:'1'},
  {afterSave:async(tx,c)=>{if(bipe)c=await tx.productCapture.update({where:{id:c.id},data:{bipeId:bipe.id,status:'processando'}});await q.enqueueCapture(c,{tx});}});
 return {store,seller,round,p,ps,clientScanId,scanKey,bipe,capture:await db.productCapture.findUnique({where:{id:saved.capture.id}})};
}
async function job(){const list=await q.boss.fetch(queues.QUEUE,{batchSize:1,includeMetadata:true,minPriority:priority,maxPriority:priority,ignoreStartAfter:true});assert.equal(list.length,1);return list[0];}
async function callStatus(f){const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/stocktake/etiqueta-status?ids='+f.capture.id,{headers:{Authorization:'Bearer '+jwt.sign({userId:f.seller.id},mw.JWT_SECRET)}});assert.equal(r.status,200);return (await r.json()).rows[0];}
(async()=>{
 png=await require('sharp')({create:{width:40,height:40,channels:3,background:'#fff'}}).png().toBuffer();photo='data:image/png;base64,'+png.toString('base64');
 await q.start();const app=express();app.use(express.json());app.use('/api/stocktake',router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const orphan=await fixture({linked:false}),first=await job();const pending=await q.processJob(first);
 assert.equal(pending.reason,'photo_barcode_not_found');assert.equal((await db.productCapture.findUnique({where:{id:orphan.capture.id}})).status,'pendente');
 assert.equal((await queues.outcomes(db,[orphan.capture.id]))[0].reason,'photo_barcode_not_found');
 assert.equal((await callStatus(orphan)).reasonCode,'photo_barcode_not_found');
 // The normal HTTP registration can arrive after the queue has finished the
 // photo. It must keep the same terminal result and attach it to that bipe.
 const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'same-original.png');
 for(const [k,v]of Object.entries({roundId:orphan.round.id,storeId:orphan.store.id,sellerId:orphan.seller.id,clientScanId:orphan.clientScanId,eanLocal:orphan.ps.barcode,photoRevision:'1'}))form.append(k,String(v));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/stocktake/etiqueta',{method:'POST',headers:{Authorization:'Bearer '+jwt.sign({userId:orphan.seller.id},mw.JWT_SECRET)},body:form});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
 const late=await db.productCapture.findUnique({where:{id:orphan.capture.id}});assert.equal(late.status,'pendente');assert.ok(late.bipeId);assert.equal(queues.pendingReason(late.note),'photo_barcode_not_found');
 assert.equal((await db.stockReplacementCheck.findUnique({where:{bipeId:late.bipeId}})).reason,'photo_barcode_not_found');assert.equal((await callStatus(orphan)).status,'pendente');
 assert.equal(await db.stocktakeBipe.count({where:{scanKey:orphan.scanKey}}),1);console.log('PASS orphan conflict persists; late HTTP linking preserves pending reason and one bipe without stock.');
 const typed=await fixture(),typedJob=await job();assert.equal((await q.processJob(typedJob)).reason,'tipo_de_produto_pendente');
 assert.equal((await db.productCapture.findUnique({where:{id:typed.capture.id}})).status,'pendente');assert.equal((await db.stockReplacementCheck.findUnique({where:{bipeId:typed.bipe.id}})).reason,'tipo_de_produto_pendente');
 const typedStatus=await callStatus(typed);assert.equal(typedStatus.reasonCode,'tipo_de_produto_pendente');assert.equal(typedStatus.complete,false);assert.equal(typedStatus.appliedToStock,false);
 const context=await require('../src/services/stockReplacement').context(db,typed.bipe.id);assert.equal('baseline' in context.round,false);console.log('PASS existing bipe gets terminal review state; status includes reason; worker context excludes large baseline.');
  const revisedPhoto='data:image/png;base64,'+(await require('sharp')({create:{width:40,height:40,channels:3,background:'#999'}}).png().toBuffer()).toString('base64');
  const revised=await photos.savePhoto(db,{roundId:typed.round.id,storeId:typed.store.id,scanKey:typed.scanKey,sellerId:typed.seller.id,sellerName:typed.seller.name,photo:revisedPhoto,barcode:typed.ps.barcode,photoRevision:'2'});
  await q.enqueueCapture(revised.capture);assert.equal((await q.processJob(await job())).status,'pending');
  const revisedCheck=await db.stockReplacementCheck.findUnique({where:{bipeId:typed.bipe.id}});assert.equal(revisedCheck.evidence.photoRevision,'2');assert.equal(revisedCheck.evidence.photoHash,queues.snapshot(revised.capture).photoHash);assert.notEqual(revisedCheck.evidence.photoHash,queues.snapshot(typed.capture).photoHash);
  const admin=await db.user.create({data:{name:'Pending admin',role:'admin',phone:'PENDING-ADMIN-'+randomUUID(),pin:'test-only'}});
  const excludedResponse=await fetch('http://127.0.0.1:'+server.address().port+'/api/stocktake/rounds/'+typed.round.id+'/exclude/'+typed.bipe.id,{method:'POST',headers:{Authorization:'Bearer '+jwt.sign({userId:admin.id},mw.JWT_SECRET),'Content-Type':'application/json'},body:JSON.stringify({reason:'Teste de exclusão após resultado pendente'})});
  assert.equal(excludedResponse.status,200);const excludedStatus=await callStatus(typed);assert.equal(excludedStatus.status,'descartado');assert.ok(excludedStatus.excludedAt);assert.equal(excludedStatus.complete,false);
  console.log('PASS second pending revision replaces evidence; API exclusion remains discarded with excludedAt despite terminal pending job.');
  const success=await fixture({footwear:true}),successJob=await job();assert.equal((await q.processJob(successJob)).status,'applied');
  const successForm=new FormData();successForm.append('file',new Blob([png],{type:'image/png'}),'same-original.png');
  for(const [k,v]of Object.entries({roundId:success.round.id,storeId:success.store.id,sellerId:success.seller.id,clientScanId:success.clientScanId,eanLocal:success.ps.barcode,photoRevision:'1'}))successForm.append(k,String(v));
  const lateSuccessResponse=await fetch('http://127.0.0.1:'+server.address().port+'/api/stocktake/etiqueta',{method:'POST',headers:{Authorization:'Bearer '+jwt.sign({userId:success.seller.id},mw.JWT_SECRET)},body:successForm});assert.equal(lateSuccessResponse.status,200,JSON.stringify(await lateSuccessResponse.json()));
  assert.equal((await db.productCapture.findUnique({where:{id:success.capture.id}})).status,'vinculado');assert.equal((await callStatus(success)).status,'vinculado');assert.equal((await callStatus(success)).complete,true);
  await db.productCapture.update({where:{id:success.capture.id},data:{status:'processando'},select:{id:true}});assert.equal((await callStatus(success)).status,'vinculado','Applied check normalizes an already stale legacy status.');
  assert.equal(await db.storeStockMovement.count({where:{storeId:success.store.id,source:'stock-replacement-scan'}}),1);
  console.log('PASS success before late HTTP registration stays linked; applied check overrides stale processing without a second stock unit.');
 const stale=await fixture(),staleJob=await job();await db.productCapture.update({where:{id:stale.capture.id},data:{note:photos.photoNote('','new frame','2'),status:'processando'}});
 assert.equal((await q.processJob(staleJob)).status,'obsolete');assert.equal(await db.stockReplacementCheck.findUnique({where:{bipeId:stale.bipe.id}}),null);assert.equal((await db.productCapture.findUnique({where:{id:stale.capture.id}})).status,'processando');await q.boss.complete(queues.QUEUE,staleJob,{status:'obsolete'});
 assert.equal((await queues.outcomes(db,[stale.capture.id])).length,0);console.log('PASS stale revision cannot overwrite new capture state or create a check.');
 const fenced=await fixture(),expired=await job();await q.boss.fail(queues.QUEUE,expired,{reason:'test_expired'});const current=await job();
 await assert.rejects(()=>q.processJob(expired),/queue_claim_lost/);assert.equal(await db.stockReplacementCheck.findUnique({where:{bipeId:fenced.bipe.id}}),null);assert.equal((await db.productCapture.findUnique({where:{id:fenced.capture.id}})).status,'processando');
 assert.equal((await q.processJob(current)).status,'pending');console.log('PASS expired job lease rolls back pending capture/check; current lease commits both with job completion.');
 const closed=await fixture(),closedJob=await job();await db.stocktakeRound.update({where:{id:closed.round.id},data:{status:'cancelled',activeReplacementStoreId:null},select:{id:true}});
 assert.equal((await queues.persistPending(db,queues.snapshot(closed.capture),'photo_barcode_not_found')).reason,'round_inactive');assert.equal(await db.stockReplacementCheck.findUnique({where:{bipeId:closed.bipe.id}}),null);await q.boss.complete(queues.QUEUE,closedJob,{status:'obsolete'});
 assert.equal(await db.storeStockMovement.count({where:{storeId:{in:[orphan,typed,stale,fenced,closed].map(f=>f.store.id)}}}),0);console.log('PASS cancelled round stays untouched; all scenarios preserve zero stock movements.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await q.stop();await queues.stopAll();await require('../src/services/scannerImageBroker').shutdown();await db.$disconnect();});
