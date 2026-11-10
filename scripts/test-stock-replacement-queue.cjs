'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const url=process.env.ROUND_TEST_DATABASE_URL;
if(!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/stock_replacement_'))throw Error('Somente PostgreSQL isolado stock_replacement_ na porta 55329.');
process.env.DATABASE_URL=url;
const {PrismaClient}=require('@prisma/client'),db=new PrismaClient();
const queueModule=require('../src/services/stockReplacementQueue'),photos=require('../src/services/scannerCapturePhoto');
const priority=100000+Math.floor(Math.random()*1000000),queues=[];
const readFor=c=>({source:'archived-photo-local-ocr-v1',decodedBarcodes:[c.barcode],size:'41',references:['QUEUE001'],text:'PUMA QUEUE001 BR 41'});
const code=()=>{const b='9'+randomUUID().replace(/\D/g,'').padEnd(11,'0').slice(0,11);return b+((10-[...b].reduce((s,n,i)=>s+Number(n)*(i%2?3:1),0)%10)%10)};
let currentRead,readHook=async()=>currentRead;
function newQueue(){const q=queueModule.createQueue(db,{connectionString:url,work:false,jobPriority:priority,readImage:(...args)=>readHook(...args)});queues.push(q);return q;}
async function fixture(){const suffix=randomUUID();
 const store=await db.store.create({data:{code:'Q-'+suffix,name:'Durable queue test'}});
 const seller=await db.user.create({data:{name:'Queue operator',role:'seller',storeId:store.id,phone:'Q-'+suffix,pin:'test-only'}});
 const round=await db.stocktakeRound.create({data:{name:'Durable queue test',storeId:store.id,operationType:'replacement',status:'counting',activeReplacementStoreId:store.id,baseline:[],startedAt:new Date(Date.now()-60000)}});
 const p=await db.product.create({data:{sku:'QUEUE001-'+suffix,name:'Tênis teste de fila',brand:'PUMA',category:'Tênis',price:100,aiContext:{scannerReferences:['QUEUE001']}}});
 const ps=await db.productSize.create({data:{productId:p.id,size:'41',barcode:code(),stock:0}});
 return {store,seller,round,p,ps};
}
let photo;
async function piece(f,q,{rollback=false,orphan=false,revision='1'}={}){
 const scanKey=f.round.id+':'+randomUUID();let bipe;
 if(!orphan)bipe=await db.stocktakeBipe.create({data:{scanKey,roundId:f.round.id,storeId:f.store.id,sellerId:f.seller.id,barcode:f.ps.barcode,productId:f.p.id,productSizeId:f.ps.id,productSize:'41',found:true}});
 let cap;
 const run=()=>photos.savePhoto(db,{scanKey,roundId:f.round.id,storeId:f.store.id,sellerId:f.seller.id,sellerName:f.seller.name,photo,barcode:f.ps.barcode,photoRevision:revision},
  {afterSave:async(tx,c)=>{cap=c;if(bipe){cap=await tx.productCapture.update({where:{id:c.id},data:{bipeId:bipe.id}});}await q.enqueueCapture(cap,{tx});if(rollback)throw Error('rollback-test');}});
 if(rollback){await assert.rejects(run,/rollback-test/);return {scanKey,cap,bipe};}
 await run();return {scanKey,cap,bipe};
}
const stock=async f=>(await db.storeStock.findUnique({where:{storeId_productSizeId:{storeId:f.store.id,productSizeId:f.ps.id}}}))?.stock||0;
async function fetchJob(q){const jobs=await q.boss.fetch(queueModule.QUEUE,{batchSize:1,includeMetadata:true,minPriority:priority,maxPriority:priority,ignoreStartAfter:true});assert.equal(jobs.length,1);return jobs[0];}
async function settle(q,job){const result=await q.processJob(job);await q.boss.complete(queueModule.QUEUE,job,result);return result;}
async function activeJob(q,c){await q.enqueueCapture(c);return fetchJob(q);}
(async()=>{
 photo='data:image/png;base64,'+(await require('sharp')({create:{width:30,height:30,channels:3,background:'#fff'}}).png().toBuffer()).toString('base64');
 let q=newQueue();await q.start();const f=await fixture();
 const rolled=await piece(f,q,{rollback:true});assert.equal(await db.productCapture.count({where:{scanKey:rolled.scanKey}}),0);
 assert.equal((await queueModule.health(db,{roundId:f.round.id})).totalJobs,0);
 console.log('PASS original photo and durable job roll back together in the same PostgreSQL transaction');
 const one=await piece(f,q),results=await Promise.all(Array.from({length:8},()=>q.enqueueCapture(one.cap)));
 assert.equal(results.filter(Boolean).length,0);assert.equal((await queueModule.health(db,{roundId:f.round.id})).states.created,1);assert.equal(await stock(f),0);
 await q.stop();q=newQueue();await q.start();currentRead=readFor(one.cap);let job=await fetchJob(q);assert.equal(job.data.captureId,one.cap.id);
 const applied=await settle(q,job);assert.equal(applied.status,'applied');assert.equal(await stock(f),1);
 assert.equal((await queueModule.health(db,{roundId:f.round.id})).states.completed,1);
 assert.equal(await db.storeStockMovement.count({where:{storeId:f.store.id,source:'stock-replacement-scan'}}),1);
 // Lost HTTP response / process replay after commit does not add another unit.
 assert.equal((await q.processJob(job)).idempotent,true);assert.equal(await stock(f),1);
 console.log('PASS restart retains the job; eight re-enqueues and a lost-response replay preserve one unit and committed job acknowledgement');
 const two=await piece(f,q);currentRead=readFor(two.cap);job=await fetchJob(q);
 const [a,b]=await Promise.all([q.processJob(job),q.processJob(job)]);assert.equal(a.status,'applied');assert.equal(b.status,'applied');assert.equal(await stock(f),2);
 console.log('PASS concurrent processing of the same claimed event applies once; a separately registered physical pair counts one more');
 const stale=await piece(f,q);job=await fetchJob(q);await db.productCapture.update({where:{id:stale.cap.id},data:{note:photos.photoNote('','new revision','2')}});
 assert.equal((await settle(q,job)).status,'obsolete');assert.equal(await stock(f),2);
 console.log('PASS stale revisions cannot apply stock');
 const fenced=await piece(f,q);currentRead=readFor(fenced.cap);const expired=await fetchJob(q);
 await q.boss.fail(queueModule.QUEUE,expired,{reason:'test_expired_claim'});const fresh=await fetchJob(q);assert.ok(fresh.retryCount>expired.retryCount);
 await assert.rejects(()=>q.processJob(expired),/queue_claim_lost/);assert.equal(await stock(f),2);assert.equal((await db.stocktakeBipe.findUnique({where:{id:fenced.bipe.id}})).applied,false);
 await settle(q,fresh);assert.equal(await stock(f),3);
 console.log('PASS expired attempt fencing rolls back stock, movement and bipe; the current lease applies exactly once');
 const diagnostic=require('../src/services/scannerRuntimeDiagnostic');
 const measurement={source:diagnostic.SOURCE,phase:'ocr',platform:'linux',rssBytes:410000000,width:2026,height:3600,elapsedMs:17800,photo:'private-photo',text:'private-ocr',token:'private-token'};
 const failFirst=await piece(f,q),good=await piece(f,q);job=await fetchJob(q);readHook=async()=>({pending:true,reason:'ocr_memory_limit',scannerDiagnostic:measurement});
 const resourceWait=await q.processJob(job);assert.equal(resourceWait.reason,'ocr_memory_limit');assert.equal(resourceWait.autoReprocess,true);
 assert.deepEqual(resourceWait.scannerDiagnostic,diagnostic.sanitize(measurement));
 const completedResource=await q.boss.getJobById(queueModule.QUEUE,job.id);
 assert.deepEqual(completedResource.output.scannerDiagnostic,diagnostic.sanitize(measurement));assert.equal(await stock(f),3);
 assert.equal(completedResource.data.scannerDiagnostic,undefined,'No metric enters identity/job request data');
 const pendingCheck=await db.stockReplacementCheck.findUnique({where:{bipeId:failFirst.bipe.id}});
 assert.ok(!JSON.stringify(pendingCheck.evidence).includes('scannerDiagnostic'),'No metric becomes identity evidence');
 assert.ok(!JSON.stringify(await queueModule.health(db,{roundId:f.round.id})).includes('scannerDiagnostic'),'No metric enters HTTP health output');
 const scheduled=(await queueModule.health(db,{roundId:f.round.id})).items.find(x=>x.captureId===failFirst.cap.id&&x.state==='created');assert.ok(scheduled?.autoReprocess);assert.ok(new Date(scheduled.nextAttemptAt)>new Date());
 readHook=async()=>readFor(good.cap);let following=await fetchJob(q);
 if(following.data.captureId===failFirst.cap.id){await q.boss.fail(queueModule.QUEUE,following,{reason:'test_delay'});following=await q.boss.fetch(queueModule.QUEUE,{batchSize:1,includeMetadata:true,minPriority:priority,maxPriority:priority});following=following[0];}
 assert.equal(following.data.captureId,good.cap.id);await settle(q,following);assert.equal(await stock(f),4);
 console.log('PASS costly OCR failure commits sanitized diagnostic only to its internal pending job output, preserves stock/identity and public health, and schedules future work without blocking the next piece');
 const wrong=await piece(f,q);await db.user.update({where:{id:f.seller.id},data:{active:false}});readHook=async()=>readFor(wrong.cap);
 const revoked=await fetchJob(q);assert.equal((await settle(q,revoked)).reason,'operator_not_authorized');
 assert.equal(await stock(f),4);await db.user.update({where:{id:f.seller.id},data:{active:true}});
 const h=await queueModule.health(db,{roundId:f.round.id,storeId:f.store.id});assert.ok(h.available);assert.ok(h.items.every(x=>x.captureId));assert.ok(!JSON.stringify(h).includes('data:image'));assert.ok(!JSON.stringify(h).includes('test-only'));assert.equal(h.items.some(x=>'data' in x),false);
 console.log('PASS operator authorization is rechecked and status exposes only job metadata, without image, barcode payload or credentials');
 const locked=await fixture(),lockedPiece=await piece(locked,q),lockedJob=await fetchJob(q),replacement=require('../src/services/stockReplacement');
 let releaseCommit,enteredCommit;const committing=new Promise(r=>enteredCommit=r),allowCommit=new Promise(r=>releaseCommit=r);
 const apply=replacement.applyVerified(db,await replacement.context(db,lockedPiece.bipe.id),readFor(lockedPiece.cap),'QUEUE001',{beforeCommit:async tx=>{
  enteredCommit();await allowCommit;const ack=await q.boss.complete(queueModule.QUEUE,lockedJob,{status:'applied'},{db:queueModule.adapter(tx)});assert.equal(ack.affected,1);
 }});
 await committing;let recaptured=false;
 const recapture=photos.savePhoto(db,{roundId:locked.round.id,storeId:locked.store.id,scanKey:lockedPiece.scanKey,sellerId:locked.seller.id,
  sellerName:locked.seller.name,photo,barcode:locked.ps.barcode,photoRevision:'2'}).then(result=>{recaptured=true;return result});
 await new Promise(r=>setTimeout(r,30));const updatedBeforeCommit=recaptured;releaseCommit();await apply;await recapture;
 assert.equal(updatedBeforeCommit,false);assert.equal(await stock(locked),1);assert.equal(photos.revisionOf((await db.productCapture.findUnique({where:{id:lockedPiece.cap.id}})).note),'2');
 const staleLock=await fixture(),stalePiece=await piece(staleLock,q),staleJob=await fetchJob(q),oldContext=await replacement.context(db,stalePiece.bipe.id);
 let unlocked,hasLock;const canUnlock=new Promise(r=>unlocked=r),lockHeld=new Promise(r=>hasLock=r);
 const revise=db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${staleLock.round.id} FOR SHARE`;await tx.$queryRaw`SELECT id FROM "ProductCapture" WHERE id=${stalePiece.cap.id} FOR UPDATE`;hasLock();await canUnlock;await tx.productCapture.update({where:{id:stalePiece.cap.id},data:{note:photos.photoNote('','New revision','2')}});});
 await lockHeld;const rejected=replacement.applyVerified(db,oldContext,readFor(stalePiece.cap),'QUEUE001');unlocked();await revise;
 assert.equal((await rejected).applied,false);assert.equal(await stock(staleLock),0);await q.boss.complete(queueModule.QUEUE,staleJob,{status:'obsolete'});
 console.log('PASS recapture waits for stock commit; a revision committed before verification invalidates the old frame without deadlock or stock');
 const actual=await fixture();
 const worker=queueModule.createQueue(db,{connectionString:url,jobPriority:priority,readImage:async()=>readFor({barcode:actual.ps.barcode}),workerOptions:{minPriority:priority,maxPriority:priority,pollingIntervalSeconds:0.5}});queues.push(worker);await worker.start();
 const event=await piece(actual,worker);
 const deadline=Date.now()+10000;while(Date.now()<deadline&&!(await db.stocktakeBipe.findUnique({where:{id:event.bipe.id}})).applied)await new Promise(r=>setTimeout(r,50));
 assert.equal(await stock(actual),1);assert.equal((await queueModule.health(db,{roundId:actual.round.id})).states.completed,1);
 await worker.stop();console.log('PASS actual pg-boss polling worker applies and acknowledges atomically, then stops gracefully');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{for(const q of queues)await q.stop().catch(()=>{});await queueModule.stopAll();await db.$disconnect();});
