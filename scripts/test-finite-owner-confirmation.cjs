'use strict';
const assert=require('node:assert/strict'),{randomUUID,randomBytes,createHash}=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const url=process.env.ROUND_TEST_DATABASE_URL;
if(!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/stock_replacement_'))throw Error('Use only an isolated stock_replacement_ database on localhost port 55329.');
process.env.DATABASE_URL=url;
const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url}}});
const finite=require('../src/services/finiteOwnerConfirmation'),proof=require('../src/services/scannerRepeatConfirmation');
const photos=require('../src/services/scannerCapturePhoto'),queues=require('../src/services/stockReplacementQueue');
const writer=require('zxing-wasm/writer');
writer.prepareZXingModule({overrides:{wasmBinary:fs.readFileSync(path.join(__dirname,'../node_modules/zxing-wasm/dist/writer/zxing_writer.wasm'))}});
const q=queues.createQueue(db,{connectionString:url,work:false}),initialSecret=process.env.JWT_SECRET;
const secret='isolated-finite-owner-confirmation-test-key',source='explicit-owner-chat-confirmation-v1';
const sha=x=>createHash('sha256').update(x).digest('hex');
let photo;
async function fixture({photoBytes=0}={}){
 const suffix=randomUUID(),store=await db.store.create({data:{code:'FINITE-'+suffix,name:'Finite isolated test'}});
 const seller=await db.user.create({data:{name:'Original isolated operator',role:'seller',storeId:store.id,phone:'FINITE-'+suffix,pin:'test-only'}});
 const round=await db.stocktakeRound.create({data:{name:'Finite isolated',storeId:store.id,operationType:'replacement',status:'counting',activeReplacementStoreId:store.id,baseline:[],startedAt:new Date(Date.now()-60000)}});
 const barcode='5901234123457',at=new Date(Date.now()-1000);
 // High-entropy padding prevents an unrealistically cheap TOAST-compressed
 // benchmark. Maintenance hashes these synthetic archived bytes;
 // it neither decodes the image nor treats a granted repeat as OCR validation.
 const capturePhoto=photoBytes?'data:image/png;base64,'+Buffer.concat([Buffer.from(photo.split(',')[1],'base64'),randomBytes(photoBytes)]).toString('base64'):photo;
 await db.productCapture.createMany({data:Array.from({length:48},(_,i)=>({id:'finite-'+suffix+'-'+String(i).padStart(2,'0'),
  roundId:round.id,storeId:store.id,scanKey:round.id+':'+randomUUID(),sellerId:seller.id,sellerName:seller.name,barcode,photo:capturePhoto,
  photos:[photo],createdAt:at,note:photos.photoNote('','Original isolated photo','1')}))});
 const captures=await db.productCapture.findMany({where:{roundId:round.id},orderBy:{id:'asc'}});
 // An already-counted different unit makes the repeat condition explicit.
 await db.stocktakeBipe.create({data:{roundId:round.id,storeId:store.id,scanKey:round.id+':prior-'+randomUUID(),sellerId:seller.id,sellerName:seller.name,barcode,bipedAt:new Date(at.getTime()-1000)}});
 const operationId='isolated-finite-'+suffix;
 const manifest={source,executor:'system-maintenance',operationId,confirmedBy:'Isolated test owner',userStatement:'These exact 48 synthetic test captures are distinct physical test units.',
  targets:captures.map(c=>({captureId:c.id,roundId:c.roundId,storeId:c.storeId,scanKey:c.scanKey,sellerId:c.sellerId,sellerName:c.sellerName,
   barcode:c.barcode,createdAt:c.createdAt.toISOString(),photoRevision:photos.revisionOf(c.note),photoDataUrlSha256:sha(c.photo)}))};
 const f={store,seller,round,captures,operationId,manifest,canaryId:captures[0].id};refresh(f);return f;
}
function refresh(f,overrides={}){
 f.manifestText=JSON.stringify(f.manifest);f.manifestSha256=sha(f.manifestText);
 f.definition={manifestSha256:f.manifestSha256,roundId:f.round.id,storeId:f.store.id,count:48,canaryId:f.canaryId,...overrides};
 f.service=finite.createService({definitions:{[f.operationId]:f.definition}});
}
async function request(f,stage,overrides={}){
 const row={id:randomUUID(),operation_id:f.operationId,stage,manifest_sha256:f.manifestSha256,manifest_text:f.manifestText,requested_by:'system-maintenance',source,...overrides};
 await db.$executeRawUnsafe(`INSERT INTO ${finite.REQUEST}(id,operation_id,stage,manifest_sha256,manifest_text,requested_by,source) VALUES($1,$2,$3,$4,$5,$6,$7)`,
  row.id,row.operation_id,row.stage,row.manifest_sha256,row.manifest_text,row.requested_by,row.source);return row;
}
async function state(id){return (await db.$queryRawUnsafe(`SELECT * FROM ${finite.REQUEST} WHERE id=$1`,id))[0];}
async function caps(f){return db.productCapture.findMany({where:{roundId:f.round.id},orderBy:{id:'asc'}});}
async function jobs(f){return db.$queryRawUnsafe(`SELECT id::text,data,state::text,output FROM ${queues.SCHEMA}.job WHERE name=$1 AND data->>'roundId'=$2 ORDER BY created_on,id`,queues.QUEUE,f.round.id);}
async function events(id){return db.$queryRawUnsafe(`SELECT event,detail FROM ${finite.EVENT} WHERE request_id=$1 ORDER BY id`,id);}
const enqueue=(capture,tx)=>q.enqueueCapture(capture,{tx});
async function noStock(f,expectedBipes=1){
 assert.equal(await db.stocktakeBipe.count({where:{roundId:f.round.id}}),expectedBipes);
 assert.equal(await db.storeStockMovement.count({where:{storeId:f.store.id}}),0);
 assert.equal(await db.storeStock.count({where:{storeId:f.store.id}}),0);
}
async function rejected(f,req,{reason,enqueueCapture=enqueue,before}={}){
 const original=before||await caps(f),originalJobs=await jobs(f);
 const result=await f.service.reconcile(db,{enqueueCapture}),row=await state(req.id);
 const deferred=reason==='canary_attestation_pending';
 assert.equal(row.status,deferred?'requested':'rejected',JSON.stringify(result));if(reason)assert.equal(row.result.reason,reason);
 assert.equal(result.status,deferred?'deferred':'rejected');if(deferred)assert.ok(new Date(result.nextAttemptAt)>new Date(Date.now()+25000));
 assert.deepEqual(await caps(f),original,'rejection must not change any capture');
 assert.deepEqual(await jobs(f),originalJobs,'rejection must not leave an enqueued job');
 assert.equal((await events(req.id)).filter(e=>e.event==='capture_confirmation').length,0,'rolled-back grants leave no success audit');
 assert.ok((await events(req.id)).some(e=>e.event===(deferred?'request_deferred':'request_rejected')));
 await noStock(f,original.filter(c=>c.bipeId).length+1);
 return result;
}
async function deferredAndRecovered(f,req,enqueueCapture,reason){
 const before=await caps(f),oldJobs=await jobs(f);
 const result=await f.service.reconcile(db,{enqueueCapture}),row=await state(req.id);
 assert.equal(result.status,'deferred');assert.equal(row.status,'requested');assert.equal(result.reason,reason);
 assert.ok(new Date(result.nextAttemptAt)>new Date(Date.now()+25000));
 assert.deepEqual(await caps(f),before);assert.deepEqual(await jobs(f),oldJobs);
 assert.equal((await events(req.id)).filter(e=>e.event==='capture_confirmation').length,0);
 assert.equal((await f.service.reconcile(db,{enqueueCapture:enqueue})).processed,0,'deferred request must wait for its retry time');
 // Advance only this isolated fixture's retry gate, without waiting 30 seconds.
 await db.$executeRawUnsafe(`UPDATE ${finite.REQUEST} SET result=result-'nextAttemptAt' WHERE id=$1`,req.id);
 const recovered=await f.service.reconcile(db,{enqueueCapture:enqueue});assert.equal(recovered.status,'completed');
 assert.equal((await state(req.id)).result.count,1);assert.equal((await jobs(f)).length,1);
 assert.equal((await caps(f)).filter(c=>proof.confirmed(c,0)?.manifestSha256===f.manifestSha256).length,1);
 await noStock(f);
}
async function acceptedCanary(f){
 const req=await request(f,'canary'),results=await Promise.all([f.service.reconcile(db,{enqueueCapture:enqueue}),f.service.reconcile(db,{enqueueCapture:enqueue})]);
 assert.equal((await state(req.id)).status,'completed',JSON.stringify(results));
 const current=await caps(f),signed=current.filter(c=>proof.confirmed(c,0)?.manifestSha256===f.manifestSha256);
 assert.equal(signed.length,1);assert.equal(signed[0].id,f.canaryId);assert.equal((await jobs(f)).length,1);
 assert.equal((await events(req.id)).filter(e=>e.event==='capture_confirmation').length,1);
 for(const c of current){const original=f.captures.find(x=>x.id===c.id),withoutNote=x=>Object.fromEntries(Object.entries(x).filter(([k])=>k!=='note'));assert.deepEqual(withoutNote(c),withoutNote(original));if(c.id!==f.canaryId)assert.equal(c.note,original.note);}
 const before=await caps(f),priorJobs=await jobs(f),priorEvents=await events(req.id);
 await f.service.reconcile(db,{enqueueCapture:enqueue});assert.deepEqual(await caps(f),before);assert.deepEqual(await jobs(f),priorJobs);assert.deepEqual(await events(req.id),priorEvents);
 await assert.rejects(()=>request(f,'canary'),'unique operation/stage must reject another request');
 await noStock(f);return req;
}
async function simulateCanaryWorker(f,{attestation=true,changeData,changeOutput}={}){
 const capture=await db.productCapture.findUnique({where:{id:f.canaryId}});
 const bipe=await db.stocktakeBipe.create({data:{scanKey:capture.scanKey,roundId:capture.roundId,storeId:capture.storeId,
  sellerId:capture.sellerId,sellerName:capture.sellerName,barcode:capture.barcode,bipedAt:capture.createdAt,applied:false}});
 await db.productCapture.update({where:{id:capture.id},data:{bipeId:bipe.id}});
 const job=(await jobs(f))[0],data={...job.data},output={status:'pending',reason:'isolated-test-only',captureId:capture.id,bipeId:bipe.id};
 if(attestation)output.ownerConfirmation={source,manifestSha256:f.manifestSha256,confirmationHash:sha(proof.marker(capture.note))};
 if(changeData)changeData(data);if(changeOutput)changeOutput(output);
 await db.$executeRawUnsafe(`UPDATE ${queues.SCHEMA}.job SET state='completed',started_on=clock_timestamp(),completed_on=clock_timestamp(),data=$2::jsonb,output=$3::jsonb WHERE id=$1::uuid`,job.id,JSON.stringify(data),JSON.stringify(output));
 return {bipe,job};
}
(async()=>{try{
 process.env.JWT_SECRET=secret;
 const generated=await writer.writeBarcode('5901234123457',{format:'EAN-13',scale:2,addQuietZones:true});assert.equal(generated.error,'');
 photo='data:image/png;base64,'+Buffer.from(await generated.image.arrayBuffer()).toString('base64');
 await q.start();await finite.ensure(db);
 // This dedicated isolated database may contain deferred fixtures from an
 // interrupted prior run; retire only those test requests before a fresh run.
 await db.$executeRawUnsafe(`UPDATE ${finite.REQUEST} SET status='rejected',result='{"reason":"isolated_fixture_cleanup"}'::jsonb WHERE operation_id LIKE 'isolated-finite-%' AND status='requested'`);
 assert.deepEqual(await finite.reconcile(db,{enqueueCapture:enqueue}),{processed:0},'no request cannot start maintenance');
 const badManifest=await fixture();await rejected(badManifest,await request(badManifest,'canary',{manifest_text:badManifest.manifestText+' '}),{reason:'manifest_not_allowed'});
 const badRound=await fixture();refresh(badRound,{roundId:randomUUID()});await rejected(badRound,await request(badRound,'canary'),{reason:'manifest_scope_invalid'});
 const duplicate=await fixture();duplicate.manifest.targets[1]={...duplicate.manifest.targets[0]};refresh(duplicate);await rejected(duplicate,await request(duplicate,'canary'),{reason:'manifest_scope_invalid'});
 const outside=await fixture();outside.canaryId='missing-'+randomUUID();outside.manifest.targets[0].captureId=outside.canaryId;refresh(outside);await rejected(outside,await request(outside,'canary'),{reason:'capture_missing'});
 const wrongOrigin=await fixture();await rejected(wrongOrigin,await request(wrongOrigin,'canary',{requested_by:'client-supplied'}),{reason:'request_origin_invalid'});
 console.log('PASS absent requests do nothing; wrong manifest, round, duplicate/missing target and client provenance cannot authorize units');

 for(const mutation of [{photo:photo.replace('base64,','base64,AAAA')},{note:photos.photoNote('','New physical photo','2')},{sellerName:'Changed original operator'}]){
  const f=await fixture();await db.productCapture.update({where:{id:f.canaryId},data:mutation});await rejected(f,await request(f,'canary'),{reason:'capture_snapshot_changed'});
 }
 const inactive=await fixture();await db.stocktakeRound.update({where:{id:inactive.round.id},data:{status:'closed'}});await rejected(inactive,await request(inactive,'canary'),{reason:'round_inactive'});
 console.log('PASS stale photo, new revision, changed operator and inactive round reject without changing photo/history or enqueueing');

 for(const key of [undefined,'teniscash-secret-change-in-production']){
  const f=await fixture(),req=await request(f,'canary');if(key===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=key;
  const result=await rejected(f,req,{reason:'secret_unavailable'});assert.equal(result.signingKeyAvailable,false);process.env.JWT_SECRET=secret;
 }
 console.log('PASS absent/default runtime signing secret gives secret_unavailable, no grant, job, bipe or stock');

 const replacedProof=await fixture();process.env.JWT_SECRET='isolated-rejected-prior-candidate';
 const oldGrant=await db.$transaction(tx=>proof.recordOwnerReview(tx,replacedProof.captures[0],{manifestText:replacedProof.manifestText}));
 process.env.JWT_SECRET=secret;assert.equal(proof.confirmed(oldGrant,0),null);
 const replacementRequest=await acceptedCanary(replacedProof),replacementAudit=(await events(replacementRequest.id)).find(e=>e.event==='capture_confirmation');
 assert.equal(replacementAudit.detail.beforeNote,oldGrant.note);assert.notEqual(replacementAudit.detail.afterNote,oldGrant.note);
 assert.equal(proof.confirmed(await db.productCapture.findUnique({where:{id:replacedProof.canaryId}}),0)?.manifestSha256,replacedProof.manifestSha256);
 console.log('PASS rejected prior candidate marker grants no authority; explicit database request signs with runtime key and preserves old note in audit');

 const failedQueue=await fixture(),failureRequest=await request(failedQueue,'canary');let called=0;
 await deferredAndRecovered(failedQueue,failureRequest,async(c,tx)=>{called++;await enqueue(c,tx);throw Error('isolated enqueue interruption');},'maintenance_retry');assert.equal(called,1);
 const missingJob=await fixture();await deferredAndRecovered(missingJob,await request(missingJob,'canary'),async()=>null,'queue_enqueue_failed');
 console.log('PASS enqueue interruption/null atomically rolls back note/job, defers for 30 seconds, and safely retries to exactly one grant/job');

 const early=await fixture();await acceptedCanary(early);const earlyRest=await request(early,'rest');await rejected(early,earlyRest,{reason:'canary_attestation_pending'});
 assert.equal((await early.service.reconcile(db,{enqueueCapture:enqueue})).processed,0);
 await simulateCanaryWorker(early);
 await db.$executeRawUnsafe(`UPDATE ${finite.REQUEST} SET result=result-'nextAttemptAt' WHERE id=$1`,earlyRest.id);
 assert.equal((await early.service.reconcile(db,{enqueueCapture:enqueue})).status,'completed');
 assert.equal((await state(earlyRest.id)).result.count,47);assert.equal((await jobs(early)).length,48);await noStock(early,2);
 const missingAttest=await fixture();await acceptedCanary(missingAttest);await simulateCanaryWorker(missingAttest,{attestation:false});await rejected(missingAttest,await request(missingAttest,'rest'),{reason:'canary_attestation_pending'});
 const foreignJob=await fixture();await acceptedCanary(foreignJob);await simulateCanaryWorker(foreignJob,{changeData:data=>{data.storeId=randomUUID();}});await rejected(foreignJob,await request(foreignJob,'rest'),{reason:'canary_attestation_pending'});
 const forgedOutput=await fixture();await acceptedCanary(forgedOutput);await simulateCanaryWorker(forgedOutput,{changeOutput:output=>{output.ownerConfirmation.manifestSha256='0'.repeat(64);}});await rejected(forgedOutput,await request(forgedOutput,'rest'),{reason:'canary_attestation_pending'});
 console.log('PASS missing canary attestation defers 47 without counting; later valid server evidence safely resumes; marker, job or bipe alone is insufficient');

 for(const change of ['photo','revision','proof-note']){
  const f=await fixture();await acceptedCanary(f);await simulateCanaryWorker(f);
  const c=await db.productCapture.findUnique({where:{id:f.canaryId}});
  const data=change==='photo'?{photo:c.photo+'AAAA'}:change==='revision'?{note:photos.photoNote(c.note,'New revision','2')}:{note:c.note.replace(/[a-f0-9]{64}\]/,'0'.repeat(64)+']')};
  await db.productCapture.update({where:{id:c.id},data});
  await rejected(f,await request(f,'rest'),{reason:change==='proof-note'?'canary_attestation_pending':'capture_snapshot_changed'});
 }
 const rotation=await fixture();await acceptedCanary(rotation);await simulateCanaryWorker(rotation);const rotationReq=await request(rotation,'rest');
 process.env.JWT_SECRET='other-isolated-runtime-key';await rejected(rotation,rotationReq,{reason:'canary_attestation_pending'});process.env.JWT_SECRET=secret;
 console.log('PASS canary photo/revision/proof changes or key rotation revoke the prerequisite and leave the other 47 untouched');

 const f=await fixture({photoBytes:500*1024}),first=await acceptedCanary(f);await simulateCanaryWorker(f);
 assert.ok(Buffer.from(f.captures[0].photo.split(',')[1],'base64').length>=500*1024);
 const rest=await request(f,'rest'),before=await caps(f),began=Date.now(),responses=await Promise.all([f.service.reconcile(db,{enqueueCapture:enqueue}),f.service.reconcile(db,{enqueueCapture:enqueue})]),elapsedMs=Date.now()-began;
 assert.ok(elapsedMs<30000,'47 synthetic photos with representative entropy/size must complete within the transaction budget: '+elapsedMs+'ms');
 assert.equal((await state(rest.id)).status,'completed',JSON.stringify(responses));
 const after=await caps(f);assert.equal(after.filter(c=>proof.confirmed(c,0)?.manifestSha256===f.manifestSha256).length,48);
 assert.equal((await jobs(f)).length,48);assert.equal((await events(rest.id)).filter(e=>e.event==='capture_confirmation').length,47);
 assert.equal((await state(first.id)).result.count,1);assert.equal((await state(rest.id)).result.count,47);
 for(const c of after){const previous=before.find(x=>x.id===c.id),withoutNote=x=>Object.fromEntries(Object.entries(x).filter(([k])=>k!=='note'));assert.deepEqual(withoutNote(c),withoutNote(previous));if(c.id===f.canaryId)assert.equal(c.note,previous.note);}
 const beforeRepeat={captures:after,jobs:await jobs(f),events:await events(rest.id)};
 await f.service.reconcile(db,{enqueueCapture:enqueue});assert.deepEqual(await caps(f),beforeRepeat.captures);assert.deepEqual(await jobs(f),beforeRepeat.jobs);assert.deepEqual(await events(rest.id),beforeRepeat.events);
 await noStock(f,2);
 console.log('PASS accepted 1+47 with 500KiB+ high-entropy synthetic photo bytes each in '+elapsedMs+'ms under concurrent/repeated sweeps: exactly 48 grants/jobs, immutable original IDs/photos/extras/operator/time, original canary bipe reused, zero direct stock');
 }finally{if(initialSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=initialSecret;}
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await q.stop().catch(()=>{});await db.$disconnect();});
