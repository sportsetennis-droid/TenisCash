'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const url=process.env.ROUND_TEST_DATABASE_URL;
if(!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/stock_replacement_'))throw Error('Only isolated localhost replacement database.');
process.env.DATABASE_URL=url;
const {PrismaClient}=require('@prisma/client'),db=new PrismaClient(),queues=require('../src/services/stockReplacementQueue'),photos=require('../src/services/scannerCapturePhoto');
const priority=1500000000+Math.floor(Math.random()*100000),list=[];
let mode='memory',meta;
const read={source:'archived-photo-local-ocr-v1',decodedBarcodes:['5901234123457'],size:'41',references:['THROUGH001'],text:'PUMA THROUGH001 BR 41'};
const q=queues.createQueue(db,{connectionString:url,work:false,jobPriority:priority,readImage:async()=>mode==='memory'?{pending:true,reason:'ocr_memory_limit'}:mode==='timeout'?{pending:true,reason:'ocr_timeout'}:mode==='busy'?{pending:true,reason:'ocr_busy'}:read,identify:async(_id,_photo,_code,m)=>{meta=m;}});list.push(q);
let f,photo;
async function piece(){const scanKey=f.round.id+':'+randomUUID();const bipe=await db.stocktakeBipe.create({data:{scanKey,roundId:f.round.id,storeId:f.store.id,sellerId:f.seller.id,barcode:f.size.barcode,productId:f.product.id,productSizeId:f.size.id,productSize:'41',found:true}});
 const saved=await photos.savePhoto(db,{scanKey,roundId:f.round.id,storeId:f.store.id,sellerId:f.seller.id,sellerName:f.seller.name,photo,barcode:f.size.barcode,photoRevision:'1'},
 {afterSave:async(tx,c)=>{const linked=await tx.productCapture.update({where:{id:c.id},data:{bipeId:bipe.id}});await q.enqueueCapture(linked,{tx});}});
 return {bipe,capture:await db.productCapture.findUnique({where:{id:saved.capture.id}})};}
const fetch=async options=>(await q.boss.fetch(queues.QUEUE,{batchSize:1,includeMetadata:true,minPriority:priority-10,maxPriority:priority+10,...options}))[0];
const rows=async id=>db.$queryRawUnsafe(`SELECT id::text,state::text,priority,data,output,start_after FROM ${queues.SCHEMA}.job WHERE name=$1 AND data->>'captureId'=$2 ORDER BY created_on`,queues.QUEUE,id);
const countStock=async()=>(await db.storeStock.findUnique({where:{storeId_productSizeId:{storeId:f.store.id,productSizeId:f.size.id}}}))?.stock||0;
(async()=>{
 await q.start();const suffix=randomUUID();
 const store=await db.store.create({data:{code:'TH-'+suffix,name:'Throughput test'}}),seller=await db.user.create({data:{name:'Operator',role:'seller',storeId:store.id,phone:'TH-'+suffix,pin:'test-only'}});
 const round=await db.stocktakeRound.create({data:{name:'Throughput',storeId:store.id,operationType:'replacement',status:'counting',activeReplacementStoreId:store.id,baseline:[],startedAt:new Date(Date.now()-60000)}});
 const product=await db.product.create({data:{sku:'THROUGH001-'+suffix,name:'Tênis throughput',brand:'PUMA',category:'Tênis',price:100,aiContext:{scannerReferences:['THROUGH001']}}});
 const size=await db.productSize.create({data:{productId:product.id,size:'41',barcode:'5901234123457',stock:0}});f={store,seller,round,product,size};
 photo='data:image/png;base64,'+(await require('sharp')({create:{width:20,height:20,channels:3,background:'#fff'}}).png().toBuffer()).toString('base64');
 const a=await piece(),job=await fetch();assert.equal(job.data.captureId,a.capture.id);assert.equal(job.priority,priority);
 // A send failure must roll back the pending record AND the acknowledged claim.
 const send=q.boss.send.bind(q.boss);q.boss.send=async()=>null;
 await assert.rejects(()=>q.processJob(job),/queue_reschedule_failed/);q.boss.send=send;
 assert.equal((await rows(a.capture.id))[0].state,'active');assert.equal(await db.stockReplacementCheck.count({where:{bipeId:a.bipe.id}}),0);
 const waiting=await q.processJob(job);assert.equal(waiting.autoReprocess,true);assert.equal(waiting.reason,'ocr_memory_limit');
 let jobs=await rows(a.capture.id);assert.equal(jobs.length,2);assert.equal(jobs[0].state,'completed');assert.equal(jobs[1].state,'created');assert.equal(jobs[1].priority,priority-10);
 assert.ok(new Date(jobs[1].start_after)>new Date(Date.now()+290000));assert.deepEqual(jobs[1].data.photoHash,jobs[0].data.photoHash);assert.equal(await countStock(),0);
 const diagnostics=(await queues.outcomes(db,[a.capture.id]))[0];assert.equal(diagnostics.autoReprocess,true);assert.ok(diagnostics.nextAttemptAt);
 console.log('PASS expensive failure commits pending, ACK and delayed job together; failed reschedule rolls all three back');

 const b=await piece(),c=await piece();let bj=(await rows(b.capture.id))[0],cj=(await rows(c.capture.id))[0];
 await q.boss.update(queues.QUEUE,undefined,{id:bj.id,priority:priority-10});await q.boss.update(queues.QUEUE,undefined,{id:cj.id,priority:priority-10});
 const activeOld=await fetch({ignoreStartAfter:true,maxPriority:priority-10});assert.ok(activeOld);
 // Promote untouched legacy backlog; the currently active row stays untouched.
 const prioritized=await q.prioritize();assert.ok(prioritized.promoted>=1);assert.equal((await rows(activeOld.data.captureId)).find(x=>x.id===activeOld.id).priority,priority-10);
 await q.boss.complete(queues.QUEUE,activeOld,{status:'obsolete',reason:'test_only'});
 const currentOutcomes=await queues.outcomes(db,[activeOld.data.captureId]);assert.equal(currentOutcomes[0].autoReprocess,false,'terminal obsolete must not inherit automatic flag');
 const next=await fetch();assert.ok(next);assert.equal(next.priority,priority);
 mode='read';await q.processJob(next);assert.equal(await countStock(),1);
 assert.equal(meta.captureId,next.data.captureId);assert.equal(meta.photoHash,next.data.photoHash);assert.deepEqual(meta.captureContext,{roundId:round.id,storeId:store.id,scanKey:next.data.scanKey,sellerId:seller.id});
 await q.processJob(next);assert.equal(await countStock(),1);
 console.log('PASS existing untouched jobs gain first-pass priority; active claim unchanged; complete evidence meta and one stock unit');

 // Two eligible rechecks coexist with fresh work: only one gets the aging lane.
 for(const cap of [a.capture.id,next.data.captureId]){const current=await db.productCapture.findUnique({where:{id:cap}});await q.enqueueCapture(current);}
 let all=await db.$queryRawUnsafe(`SELECT id::text FROM ${queues.SCHEMA}.job WHERE name=$1 AND priority=$2 AND state='created'`,queues.QUEUE,priority-10);
 for(const j of all)await q.boss.update(queues.QUEUE,undefined,{id:j.id,startAfter:new Date(Date.now()-1000)});
 const aging=await q.prioritize();assert.equal(aging.aged,1);const again=await q.prioritize();assert.equal(again.aged,0);
 const aged=await fetch();assert.equal(aged.priority,priority+10);mode='timeout';
 const agedResult=await q.processJob(aged);assert.ok(['pending','applied'].includes(agedResult.status));await q.boss.complete(queues.QUEUE,aged,agedResult);
 assert.equal((await q.prioritize()).aged,0,'two-minute quota survives acknowledged job');
 // Move only this fixture's durable timestamp across the two-minute boundary.
 await db.$executeRawUnsafe(`UPDATE ${queues.SCHEMA}.job SET started_on=now()-interval '121 seconds' WHERE id=$1::uuid AND priority=$2 AND state='completed'`,aged.id,priority+10);
 assert.equal((await q.prioritize()).aged,1,'another recheck progresses after the durable window');
 const nextAged=await fetch();assert.equal(nextAged.priority,priority+10);await q.boss.complete(queues.QUEUE,nextAged,{status:'obsolete',reason:'test_only'});
 console.log('PASS one eligible recheck aging promotion per durable two-minute window, without touching active claims');

 let remaining;while((remaining=await fetch({minPriority:priority,maxPriority:priority})))await q.boss.complete(queues.QUEUE,remaining,{status:'obsolete',reason:'test_only'});
 const d=await piece(),dj=await fetch({minPriority:priority,maxPriority:priority});mode='busy';
 await assert.rejects(()=>q.processJob(dj),/ocr_busy/);await q.boss.fail(queues.QUEUE,dj,{reason:'ocr_busy'});
 assert.equal((await rows(d.capture.id))[0].state,'retry');
 mode='read';const e=await piece(),ej=await fetch({minPriority:priority,maxPriority:priority});assert.equal(ej.data.captureId,e.capture.id);
 // Same photograph/revision but changed operator: no delayed identification.
 const oldRead=meta;await db.productCapture.update({where:{id:e.capture.id},data:{sellerId:null}});
 assert.equal((await q.processJob(ej)).status,'obsolete');assert.equal(meta,oldRead);assert.equal((await queues.outcomes(db,[e.capture.id])).length,0);
 await q.boss.complete(queues.QUEUE,ej,{status:'obsolete'});
 console.log('PASS busy retains short retry; stale context cannot identify or appear as current outcome');

 const g=await piece(),gj=await fetch({minPriority:priority,maxPriority:priority});
 const proof='\n[scanner-repeat-confirmed-v1:1:'+Date.now()+':'+'a'.repeat(64)+']';
 const changed=await db.productCapture.update({where:{id:g.capture.id},data:{note:'test-only syntactic marker'+proof+'\n[scanner-photo-revision:1]'}});
 assert.equal(queues.matches(changed,gj.data),false);assert.ok(await q.enqueueCapture(changed));assert.equal((await rows(g.capture.id)).length,2);
 assert.equal((await q.processJob(gj)).status,'obsolete');await q.boss.complete(queues.QUEUE,gj,{status:'obsolete'});
 const latest=(await queues.outcomes(db,[g.capture.id]))[0];assert.equal(latest.state,'created');
 const ownerProof='\n[scanner-repeat-owner-v1:1:'+Date.now()+':'+'b'.repeat(64)+':'+'c'.repeat(64)+']';
 const ownerChanged=await db.productCapture.update({where:{id:g.capture.id},data:{note:'test-only syntactic marker'+ownerProof+'\n[scanner-photo-revision:1]'}});
 // A populated database may need several bounded cursor pages. Put this proof
 // after a full page deliberately, so the test cannot pass on an empty DB alone.
 await db.productCapture.createMany({data:Array.from({length:101},(_,index)=>({id:'a-throughput-'+suffix+'-'+String(index).padStart(3,'0'),
  scanKey:round.id+':page:'+index,roundId:round.id,storeId:store.id,sellerId:seller.id,photo,barcode:size.barcode,note:'\n[scanner-photo-revision:1]'}))});
 const maxPages=Math.ceil(await db.productCapture.count()/100)+2,passes=[];
 for(let page=0;page<maxPages&&(await rows(g.capture.id)).length<3;page++)passes.push(await q.reconcile());
 assert.equal(passes[0].examined,100);assert.ok(passes.length>1,'fixture must cross a page boundary');
 assert.equal((await rows(g.capture.id)).length,3,'bounded sweep schedules new owner proof even with the old proof job still live');
 assert.equal((await rows(g.capture.id))[2].priority,priority,'new owner proof is a first attempt, not an old recheck');
 console.log('PASS owner proof scheduled across '+passes.length+' cursor pages ('+passes.map(x=>x.examined+'/'+x.queued).join(',')+')');
 assert.equal(await q.enqueueCapture(ownerChanged),null,'same owner proof stays idempotent');
 assert.equal((await queues.outcomes(db,[g.capture.id])).length,1,'owner marker SQL matches JS fingerprint');
 const duplicate=await db.productCapture.update({where:{id:g.capture.id},data:{note:'test-only duplicate'+proof+ownerProof+'\n[scanner-photo-revision:1]'}});
 assert.equal(queues.snapshot(duplicate).confirmationHash,'');assert.equal((await queues.outcomes(db,[g.capture.id])).length,1,'both marker types together are rejected in SQL and JS');
 assert.equal((await queues.outcomes(db,[g.capture.id]))[0].state,'completed','duplicate proof matches only the original unconfirmed snapshot');
 console.log('PASS changed confirmation fingerprint gets a separate singleton; old job is obsolete and excluded from current outcomes');
 await q.reconcile();assert.equal(await countStock(),1);
 console.log('PASS reconciliation preserves stock and skips live jobs');
 const h=await piece();
 for(const change of [{barcode:'4006381333931'},{scanKey:round.id+':corrected:'+randomUUID()}]){
  const before=(await rows(h.capture.id)).at(-1);await q.boss.update(queues.QUEUE,undefined,{id:before.id,priority:priority+5});
  const claim=await fetch({minPriority:priority+5,maxPriority:priority+5});assert.equal(claim.id,before.id);
  await q.boss.complete(queues.QUEUE,claim,{status:'pending',reason:'test_only'});
  const corrected=await db.productCapture.update({where:{id:h.capture.id},data:change});
  assert.equal((await queues.outcomes(db,[h.capture.id])).length,0,'old identity is not current status');
  assert.ok(await q.enqueueCapture(corrected));assert.equal((await rows(h.capture.id)).at(-1).priority,priority,'corrected barcode/context starts a new first attempt');
 }
 assert.equal(await countStock(),1);
 console.log('PASS corrected barcode and context do not inherit prior identity attempts or outcome');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{for(const q of list)await q.stop().catch(()=>{});await db.$disconnect();});
