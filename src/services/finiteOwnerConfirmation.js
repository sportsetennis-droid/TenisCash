'use strict';
// Only a separately inserted database-administrator request can trigger this
// finite maintenance. There is no HTTP entry point or client-supplied approval.
const {createHash}=require('node:crypto');
const photos=require('./scannerCapturePhoto'),proof=require('./scannerRepeatConfirmation');
const policy=require('../../public/scanner-barcode-policy');
const SCHEMA='stock_replacement_queue',REQUEST=SCHEMA+'.finite_owner_confirmation_request_v1',EVENT=SCHEMA+'.finite_owner_confirmation_event_v1';
const SOURCE='explicit-owner-chat-confirmation-v1',EXECUTOR='system-maintenance';
const sha=x=>createHash('sha256').update(String(x||'')).digest('hex');
const definitions=Object.freeze({'douglas-explicit-48-physical-pairs-20261109':Object.freeze({
 manifestSha256:'5c08214c1f48d1d6d57725cb519828f9facb037d6483de7d035596d6630d1c50',
 roundId:'ca042063-2801-4613-a82c-a47f1e07f140',storeId:'01b5a498-4dce-49b9-b359-5b031936aae9',count:48,canaryId:'cmw9rvc5c017f35kgtkqwixvd'})});
function reject(code){const e=Error(code);e.maintenanceReason=code;throw e;}
async function ensure(db){
 await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
 await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${REQUEST} (
  id text PRIMARY KEY, operation_id text NOT NULL, stage text NOT NULL CHECK(stage IN ('canary','rest')),
  manifest_sha256 text NOT NULL, manifest_text text NOT NULL, requested_by text NOT NULL, source text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','completed','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, result jsonb,
  UNIQUE(operation_id,stage))`);
 await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${EVENT} (
  id bigserial PRIMARY KEY, request_id text NOT NULL REFERENCES ${REQUEST}(id),
  event text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
 await db.$executeRawUnsafe(`REVOKE ALL ON TABLE ${REQUEST},${EVENT} FROM PUBLIC`);
}
function validateRequest(request,allowed){
 const def=allowed[request.operation_id];
 if(!def||request.manifest_sha256!==def.manifestSha256||sha(request.manifest_text)!==def.manifestSha256)reject('manifest_not_allowed');
 if(request.requested_by!==EXECUTOR||request.source!==SOURCE||!['canary','rest'].includes(request.stage))reject('request_origin_invalid');
 let manifest;try{manifest=JSON.parse(request.manifest_text)}catch(_){reject('manifest_invalid');}
 if(manifest.operationId!==request.operation_id||manifest.source!==SOURCE||manifest.executor!==EXECUTOR||!manifest.confirmedBy||!manifest.userStatement||
  !Array.isArray(manifest.targets)||manifest.targets.length!==def.count||new Set(manifest.targets.map(t=>t.captureId)).size!==def.count||
  new Set(manifest.targets.map(t=>t.scanKey)).size!==def.count||!manifest.targets.some(t=>t.captureId===def.canaryId))reject('manifest_scope_invalid');
 for(const target of manifest.targets)if(target.roundId!==def.roundId||target.storeId!==def.storeId||!target.scanKey?.startsWith(def.roundId+':')||
  !target.sellerId||!target.createdAt||!target.photoRevision||!/^[a-f0-9]{64}$/.test(target.photoDataUrlSha256)||!policy.isScanCode(target.barcode))reject('manifest_scope_invalid');
 return {def,manifest,targets:manifest.targets.filter(t=>request.stage==='canary'?t.captureId===def.canaryId:t.captureId!==def.canaryId)};
}
async function metadata(tx,ids){return tx.$queryRawUnsafe(`SELECT id,"roundId","storeId","scanKey","sellerId","sellerName",barcode,"createdAt",note,status,"bipeId","excludedAt",
 encode(sha256(convert_to(COALESCE(photo,''),'UTF8')),'hex') AS "photoDataUrlSha256",
 substring(note from '\\[scanner-photo-revision:([0-9]+)\\]$') AS "photoRevision"
 FROM "ProductCapture" WHERE id=ANY($1::text[]) ORDER BY id`,ids);}
function assertTarget(c,t){
 if(!c||c.excludedAt||c.status==='descartado')reject('capture_inactive');
 for(const field of ['roundId','storeId','scanKey','sellerId','sellerName','barcode','photoDataUrlSha256','photoRevision'])if(c[field]!==t[field])reject('capture_snapshot_changed');
 if(new Date(c.createdAt).getTime()!==new Date(t.createdAt).getTime())reject('capture_snapshot_changed');
}
async function validCanary(tx,request,def){
 const [first]=await tx.$queryRawUnsafe(`SELECT status,manifest_sha256 FROM ${REQUEST} WHERE operation_id=$1 AND stage='canary'`,request.operation_id);
 if(first?.status!=='completed'||first.manifest_sha256!==def.manifestSha256)reject('canary_request_incomplete');
 const capture=await tx.productCapture.findUnique({where:{id:def.canaryId}}),grant=proof.confirmed(capture,0);
 if(grant?.source!==SOURCE||grant.manifestSha256!==def.manifestSha256||!capture.bipeId)reject('canary_attestation_pending');
 await tx.$queryRaw`SELECT id FROM "StocktakeBipe" WHERE id=${capture.bipeId} FOR UPDATE`;
 const bipe=await tx.stocktakeBipe.findUnique({where:{id:capture.bipeId}});
 if(!bipe||bipe.excludedAt||['roundId','storeId','scanKey','sellerId','sellerName','barcode'].some(k=>bipe[k]!==capture[k])||
  new Date(bipe.bipedAt).getTime()!==new Date(capture.createdAt).getTime())reject('canary_context_changed');
 const hash=sha(proof.marker(capture.note)),jobs=await tx.$queryRawUnsafe(`SELECT id::text,data,output,started_on FROM ${SCHEMA}.job
  WHERE name='replacement-capture-v1' AND state='completed' AND data->>'captureId'=$1 AND data->>'confirmationHash'=$2 ORDER BY created_on DESC LIMIT 20`,capture.id,hash);
 const job=jobs.find(j=>require('./stockReplacementQueue').matches(capture,j.data)&&j.output?.captureId===capture.id&&j.output?.bipeId===bipe.id&&
  ['pending','applied'].includes(j.output.status)&&j.output.ownerConfirmation?.source===SOURCE&&j.output.ownerConfirmation.manifestSha256===def.manifestSha256&&
  j.output.ownerConfirmation.confirmationHash===hash&&new Date(j.started_on)>=new Date(grant.confirmedAt));
 if(!job)reject('canary_attestation_pending');
 return {captureId:capture.id,bipeId:bipe.id,jobId:job.id,manifestSha256:def.manifestSha256,confirmationHash:hash};
}
async function audit(tx,id,event,detail){await tx.$executeRawUnsafe(`INSERT INTO ${EVENT}(request_id,event,detail) VALUES($1,$2,$3::jsonb)`,id,event,JSON.stringify(detail));}
function createService({definitions:allowed=definitions}={}){
 async function reconcile(db,{enqueueCapture}={}){
  const [request]=await db.$queryRawUnsafe(`SELECT * FROM ${REQUEST} WHERE status='requested'
   AND COALESCE(result->>'nextAttemptAt','')<=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ORDER BY requested_at,id LIMIT 1`);
  if(!request)return {processed:0};
  try{return await db.$transaction(async tx=>{
   const [lock]=await tx.$queryRawUnsafe(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`,SCHEMA+':finite-owner-confirmation-v1');
   if(!lock.acquired)return {processed:0,busy:true};
   const [current]=await tx.$queryRawUnsafe(`SELECT * FROM ${REQUEST} WHERE id=$1 FOR UPDATE`,request.id);
   if(!current||current.status!=='requested')return {processed:0,idempotent:true};
   if(current.result?.nextAttemptAt&&new Date(current.result.nextAttemptAt)>new Date())return {processed:0,deferred:true};
   if(current.manifest_text!==request.manifest_text||current.manifest_sha256!==request.manifest_sha256||current.operation_id!==request.operation_id||current.stage!==request.stage)reject('request_changed');
   const {def,manifest,targets}=validateRequest(current,allowed);
   if(!proof.signingAvailable())reject('secret_unavailable');
   if(typeof enqueueCapture!=='function')reject('queue_unavailable');
   await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${def.roundId} FOR UPDATE`;
   const round=await tx.stocktakeRound.findUnique({where:{id:def.roundId},select:{storeId:true,activeReplacementStoreId:true,status:true,operationType:true}});
   if(round?.storeId!==def.storeId||round.activeReplacementStoreId!==def.storeId||round.status!=='counting'||round.operationType!=='replacement')reject('round_inactive');
   const store=await tx.store.findUnique({where:{id:def.storeId},select:{active:true}});if(!store?.active)reject('store_inactive');
   const ids=targets.map(t=>t.captureId).sort();
   // The canary is a prerequisite of the rest stage. Lock it with the targets,
   // in the same order, so a concurrent note edit/exclusion cannot revoke the
   // evidence after the gate has been checked but before the other grants.
   const lockIds=current.stage==='rest'?[...ids,def.canaryId].sort():ids;
   await tx.$queryRawUnsafe(`SELECT id FROM "ProductCapture" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,lockIds);
   const before=await metadata(tx,lockIds);if(before.length!==lockIds.length)reject('capture_missing');
   for(const id of lockIds)assertTarget(before.find(c=>c.id===id),manifest.targets.find(t=>t.captureId===id));
   const canary=current.stage==='rest'?await validCanary(tx,current,def):null;
   const results=[];
   for(const target of targets){
    const capture=await tx.productCapture.findUnique({where:{id:target.captureId}}),existing=await tx.stocktakeBipe.findUnique({where:{scanKey:target.scanKey}});
    const grant=proof.confirmed(capture,0),already=grant?.source===SOURCE&&grant.manifestSha256===def.manifestSha256;
    if(!already&&(capture.bipeId||existing))reject('capture_already_linked');
    if(already&&(capture.bipeId||existing)&&(!existing||existing.excludedAt||existing.id!==capture.bipeId||
      ['roundId','storeId','scanKey','sellerId','sellerName','barcode'].some(k=>existing[k]!==capture[k])||new Date(existing.bipedAt).getTime()!==new Date(capture.createdAt).getTime()))reject('bipe_context_conflict');
    const saved=already?capture:await proof.recordOwnerReview(tx,capture,{manifestText:current.manifest_text});
    if(proof.confirmed(saved,0)?.manifestSha256!==def.manifestSha256)reject('grant_not_preserved');
    let jobId=await enqueueCapture(saved,tx);
    if(!jobId){
     const hash=sha(proof.marker(saved.note)),[live]=await tx.$queryRawUnsafe(`SELECT id::text,data FROM ${SCHEMA}.job WHERE name='replacement-capture-v1'
      AND data->>'captureId'=$1 AND data->>'confirmationHash'=$2 AND state IN ('created','retry','active') LIMIT 1`,saved.id,hash);
     if(!live||!require('./stockReplacementQueue').matches(saved,live.data))reject('queue_enqueue_failed');
     jobId=live.id;
    }
    const detail={captureId:saved.id,context:target,source:SOURCE,executor:EXECUTOR,confirmedBy:manifest.confirmedBy,manifestSha256:def.manifestSha256,
     beforeNote:capture.note,afterNote:saved.note,confirmationHash:sha(proof.marker(saved.note)),jobId:jobId||null,idempotent:already};
    await audit(tx,current.id,'capture_confirmation',detail);
    results.push({captureId:saved.id,confirmationHash:detail.confirmationHash,jobId:detail.jobId,idempotent:already});
   }
   const after=await metadata(tx,ids);for(const target of targets)assertTarget(after.find(c=>c.id===target.captureId),target);
   const result={status:'completed',stage:current.stage,operationId:current.operation_id,manifestSha256:def.manifestSha256,count:results.length,
    signingKeyAvailable:true,stockWrites:0,bipesCreated:0,canary,items:results};
   await tx.$executeRawUnsafe(`UPDATE ${REQUEST} SET status='completed',completed_at=now(),result=$2::jsonb WHERE id=$1`,current.id,JSON.stringify(result));
   await audit(tx,current.id,'request_completed',result);
   return {processed:1,requestId:current.id,...result};
  },{timeout:30000,maxWait:1500});}
  catch(error){
   const reason=error.maintenanceReason||(!proof.signingAvailable()?'secret_unavailable':error.status===503?'confirmation_signing_failed':'maintenance_failed');
   const deferred=['queue_unavailable','queue_enqueue_failed','maintenance_failed','canary_attestation_pending'].includes(reason);
   const result={status:deferred?'deferred':'rejected',reason:reason==='maintenance_failed'?'maintenance_retry':reason,stage:request.stage,operationId:request.operation_id,
    signingKeyAvailable:proof.signingAvailable(),stockWrites:0,bipesCreated:0,...(deferred?{nextAttemptAt:new Date(Date.now()+30000).toISOString()}:{})};
   await db.$transaction(async tx=>{
    const changed=await tx.$executeRawUnsafe(`UPDATE ${REQUEST} SET status=$5,completed_at=CASE WHEN $5='rejected' THEN now() ELSE NULL END,result=$2::jsonb
     WHERE id=$1 AND status='requested' AND manifest_sha256=$3 AND manifest_text=$4`,request.id,JSON.stringify(result),request.manifest_sha256,request.manifest_text,deferred?'requested':'rejected');
    if(changed)await audit(tx,request.id,deferred?'request_deferred':'request_rejected',result);
   },{timeout:10000});
   return {processed:1,requestId:request.id,...result};
  }
 }
 return {ensure,reconcile};
}
module.exports={...createService(),createService,definitions,REQUEST,EVENT};
