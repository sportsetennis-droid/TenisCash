'use strict';
const {createHash}=require('node:crypto');
const photos=require('./scannerCapturePhoto');
const policy=require('../../public/scanner-barcode-policy');
const SCHEMA='stock_replacement_queue',QUEUE='replacement-capture-v1';
const instances=new Map();
const transient=new Set(['ocr_busy','ocr_timeout','ocr_unavailable','ocr_memory_limit','photo_decode_busy','photo_decode_timeout','photo_decode_unavailable','photo_decode_memory_limit']);
const costly=new Set(['ocr_timeout','ocr_memory_limit','photo_decode_timeout','photo_decode_memory_limit']);
const fingerprint=photo=>createHash('sha256').update(String(photo||'')).digest('hex');
function confirmationHash(note){const marker=require('./scannerRepeatConfirmation').marker(note);return marker?fingerprint(marker):'';}
function ownerConfirmation(capture){const proof=require('./scannerRepeatConfirmation').confirmed(capture,0);
 return proof?.source==='explicit-owner-chat-confirmation-v1'?{source:proof.source,manifestSha256:proof.manifestSha256,confirmationHash:confirmationHash(capture.note)}:null;}
function singleton(data){return [data.captureId,data.revision,data.photoHash,...(data.confirmationHash?[data.confirmationHash]:[])].join(':');}
function currentSnapshotSql(){const proof=`substring(c.note from '(\\n\\[scanner-repeat-(?:confirmed-v1:[0-9]{1,16}:[0-9]{13}:[a-f0-9]{64}|owner-v1:[0-9]{1,16}:[0-9]{13}:[a-f0-9]{64}:[a-f0-9]{64})\\])')`;return `j.data->>'roundId'=c."roundId" AND j.data->>'storeId'=c."storeId"
 AND j.data->>'scanKey'=c."scanKey" AND j.data->>'sellerId'=c."sellerId"
 AND j.data->>'revision'=substring(c.note from '\\[scanner-photo-revision:([0-9]+)\\]$')
 AND j.data->>'photoHash'=encode(sha256(convert_to(COALESCE(c.photo,''),'UTF8')),'hex')
 AND j.data->>'barcodeHash'=encode(sha256(convert_to(CASE WHEN trim(COALESCE(c.barcode,'')) ~ '^[0-9]{16}$' AND trim(c.barcode) !~ '^0+$' THEN trim(c.barcode) ELSE ltrim(trim(COALESCE(c.barcode,'')),'0') END,'UTF8')),'hex')
 AND COALESCE(j.data->>'confirmationHash','')=CASE WHEN (SELECT count(*) FROM regexp_matches(COALESCE(c.note,''),'scanner-repeat-(?:confirmed|owner)-v1:','g'))=1 AND ${proof} IS NOT NULL THEN encode(sha256(convert_to(${proof},'UTF8')),'hex') ELSE '' END`;}
function adapter(tx){return {executeSql:async(text,values=[])=>({rows:await tx.$queryRawUnsafe(text,...values)})};}
function failure(code){const e=new Error(code);e.code=code;if(transient.has(code))e.reason=code;return e;}
// Older pg-boss failures stored Error.code/message rather than reason. Accept
// only our known transient codes from those fields, never arbitrary messages.
function outcomeReasonSql(column,dataColumn=column==='output'?'data':'j.data'){const known=[...transient].map(code=>`'${code}'`).join(',');return `CASE
 WHEN ${column}->>'reason' ~ '^[a-z_]{1,80}$' THEN ${column}->>'reason'
 WHEN ${column}->>'code' IN (${known}) THEN ${column}->>'code'
 WHEN ${column}->>'message' IN (${known}) THEN ${column}->>'message'
 WHEN ${dataColumn}->>'autoReprocess'='true' AND ${dataColumn}->>'reprocessReason' ~ '^[a-z_]{1,80}$' THEN ${dataColumn}->>'reprocessReason' ELSE NULL END`;}
function automaticSql(prefix=''){const o=prefix+'output',d=prefix+'data',s=prefix+'state';return `COALESCE(CASE WHEN ${s}='completed' THEN
 (${o}->>'status'='pending' AND ${o}->>'autoReprocess'='true' AND ${o}->>'nextAttemptAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$')
 WHEN ${s} IN ('created','retry','active') THEN (${d}->>'autoReprocess'='true' AND ${d}->>'nextAttemptAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$') ELSE false END,false)`;}
function snapshot(capture){return {captureId:capture.id,roundId:capture.roundId,storeId:capture.storeId,scanKey:capture.scanKey,
 revision:photos.revisionOf(capture.note),photoHash:fingerprint(capture.photo),confirmationHash:confirmationHash(capture.note),sellerId:capture.sellerId,barcodeHash:fingerprint(policy.identity(capture.barcode))};}
function matches(capture,data){return !!capture&&capture.id===data.captureId&&capture.roundId===data.roundId&&capture.storeId===data.storeId&&
 capture.scanKey===data.scanKey&&capture.sellerId===data.sellerId&&photos.revisionOf(capture.note)===data.revision&&
 fingerprint(capture.photo)===data.photoHash&&confirmationHash(capture.note)===(data.confirmationHash||'')&&fingerprint(policy.identity(capture.barcode))===data.barcodeHash;}
function pendingReason(note){return String(note||'').match(/\[scanner-queue-pending:([a-z_]{1,80})\]/)?.[1]||null;}
async function syncPendingCheck(tx,capture,bipeId,reason){
 if(!bipeId)return null;
 await tx.$queryRaw`SELECT id FROM "StocktakeBipe" WHERE id=${bipeId} FOR UPDATE`;
 const bipe=await tx.stocktakeBipe.findUnique({where:{id:bipeId}});
 if(!bipe||bipe.excludedAt||bipe.roundId!==capture.roundId||bipe.storeId!==capture.storeId||bipe.sellerId!==capture.sellerId||policy.identity(bipe.barcode)!==policy.identity(capture.barcode))return null;
 const prior=await tx.stockReplacementCheck.findUnique({where:{bipeId}});
 if(bipe.applied||prior?.appliedAt)return null;
 const evidence={captureId:capture.id,photoRevision:photos.revisionOf(capture.note),photoHash:fingerprint(capture.photo),source:'durable-queue'};
 await tx.stockReplacementCheck.upsert({where:{bipeId},create:{bipeId,roundId:capture.roundId,status:'pending',reason,evidence},update:{status:'pending',reason,evidence,checkedAt:new Date()}});
 return bipeId;
}
async function persistPending(db,data,reason,{complete,autoReprocess=false,nextAttemptAt,ownerConfirmation:owner,scannerDiagnostic:rawDiagnostic}={}){
 if(!/^[a-z_]{1,80}$/.test(reason||''))reason='photo_size_or_reference_pending';
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${data.roundId} FOR SHARE`;
  const round=await tx.stocktakeRound.findUnique({where:{id:data.roundId},select:{operationType:true,status:true,storeId:true}});
  if(round?.operationType!=='replacement'||!['counting','review'].includes(round.status)||round.storeId!==data.storeId)return {status:'obsolete',reason:'round_inactive'};
  await tx.$queryRaw`SELECT id FROM "ProductCapture" WHERE id=${data.captureId} FOR UPDATE`;
  const capture=await tx.productCapture.findUnique({where:{id:data.captureId}});
  if(!matches(capture,data)||capture.excludedAt||capture.status==='descartado')return {status:'obsolete',reason:'capture_changed'};
  const bipeId=await syncPendingCheck(tx,capture,capture.bipeId,reason);
  if(capture.bipeId&&!bipeId){
   const bipe=await tx.stocktakeBipe.findUnique({where:{id:capture.bipeId},select:{applied:true}});
   if(bipe?.applied)return {status:'applied',bipeId:capture.bipeId,idempotent:true};
   return {status:'obsolete',reason:'bipe_context_conflict'};
  }
  await tx.productCapture.update({where:{id:capture.id},data:{status:'pendente',resolvedAt:null,
   note:photos.photoNote(capture.note,'etiqueta '+require('./stockReplacement').reasonText(reason,{autoReprocess})+' [scanner-queue-pending:'+reason+']')},select:{id:true}});
  const scannerDiagnostic=require('./scannerRuntimeDiagnostic').sanitize(rawDiagnostic);
  const result={status:'pending',reason,captureId:capture.id,bipeId,...(autoReprocess?{autoReprocess:true,nextAttemptAt}:{}),...(owner?{ownerConfirmation:owner}:{}),...(scannerDiagnostic?{scannerDiagnostic}:{})};
  if(complete)await complete(tx,result);
  return result;
 },{timeout:20000});
}
function createQueue(db,options={}){
 let boss,starting,ready=false,ownerReady=false,workerId,lastErrorCode=null,identify=options.identify,stopping=false,lastId=null;
 const pendingAgeMs=options.pendingAgeMs??300000;
 const firstPriority=Number.isInteger(options.jobPriority)?options.jobPriority:10,recheckPriority=firstPriority-10,agedPriority=firstPriority+10;
 const recheckIntervalMs=options.recheckIntervalMs??120000;
 const readImage=options.readImage||((bytes,barcode)=>require('./scannerArchivedLabel').readImage(bytes,barcode));
 async function ensureOwnerRequests(){
  if(ownerReady)return true;
  try{await require('./finiteOwnerConfirmation').ensure(db);ownerReady=true;return true;}
  catch(_){console.warn('[replacement/queue] finite owner confirmation bootstrap awaits retry');return false;}
 }
 async function start(){
  if(stopping)throw failure('queue_stopping');
  if(ready)return api;
  if(starting)return starting;
  starting=(async()=>{
   const {PgBoss}=await import('pg-boss');
   boss=options.boss||new PgBoss({connectionString:options.connectionString||process.env.DATABASE_URL,schema:SCHEMA,
    max:4,connectionTimeoutMillis:10000,superviseIntervalSeconds:options.superviseIntervalSeconds||10,
    monitorIntervalSeconds:30,schedule:false,...options.bossOptions});
   boss.on('error',()=>{lastErrorCode='queue_database_error';});
   try{
    await boss.start();
    await boss.createQueue(QUEUE,{policy:'exclusive',retryLimit:8,retryDelay:15,retryBackoff:true,retryDelayMax:300,
     expireInSeconds:120,heartbeatSeconds:15,retentionSeconds:604800,deleteAfterSeconds:2592000,...options.queueOptions});
    await ensureOwnerRequests();
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS replacement_capture_job_age ON ${SCHEMA}.job (name,(data->>'captureId'),created_on)`);
    // Drain known backlog without an idle second between cheap jobs. This
    // retains one handler/photo at a time and returns to polling when empty.
    if(options.work!==false)workerId=await boss.work(QUEUE,{batchSize:1,localConcurrency:options.localConcurrency||1,
     pollingIntervalSeconds:1,burstWhenReadyExceeds:1,...options.workerOptions},async jobs=>processJob(jobs[0]));
    ready=true;lastErrorCode=null;return api;
   }catch(error){lastErrorCode='queue_start_failed';try{await boss.stop({graceful:false})}catch(_){}throw error;}
   finally{starting=null;}
  })();
  return starting;
 }
 async function enqueueCapture(capture,{tx,startAfter}={}){
  if(!capture?.id||!capture.roundId||!capture.photo||!policy.isScanCode(capture.barcode))return null;
  const round=await (tx||db).stocktakeRound.findUnique({where:{id:capture.roundId},select:{operationType:true,status:true,storeId:true}});
  if(round?.operationType!=='replacement'||!['counting','review'].includes(round.status)||round.storeId!==capture.storeId||capture.excludedAt||capture.status==='descartado')return null;
  // Bootstrap before opening the caller's transaction. Never migrate or wait
  // for a worker connection while a photo/stock transaction holds its locks.
  if(tx&&!ready)throw failure('queue_not_ready');
  await start();
  const data=snapshot(capture);
  const [history]=await (tx||db).$queryRawUnsafe(`SELECT EXISTS(SELECT 1 FROM ${SCHEMA}.job WHERE name=$1 AND data->>'captureId'=$2 AND data->>'revision'=$3 AND data->>'photoHash'=$4 AND COALESCE(data->>'confirmationHash','')=$5
   AND data->>'roundId'=$6 AND data->>'storeId'=$7 AND data->>'scanKey'=$8 AND data->>'sellerId'=$9 AND data->>'barcodeHash'=$10 AND started_on IS NOT NULL) AS attempted`,QUEUE,data.captureId,data.revision,data.photoHash,data.confirmationHash,data.roundId,data.storeId,data.scanKey,data.sellerId,data.barcodeHash);
  const recheck=!!history?.attempted;
  if(recheck)Object.assign(data,{autoReprocess:true,nextAttemptAt:new Date(startAfter||Date.now()).toISOString(),reprocessReason:pendingReason(capture.note)||'queue_recheck_wait'});
  return boss.send(QUEUE,data,{singletonKey:singleton(data),
   ...(tx?{db:adapter(tx)}:{}),...(startAfter?{startAfter}:{}),priority:recheck?recheckPriority:firstPriority,group:{id:capture.storeId}});
 }
 async function enqueueBipe(bipeId){
  if(!bipeId)return null;
  const capture=await db.productCapture.findFirst({where:{bipeId,excludedAt:null,round:{operationType:'replacement'}},orderBy:{createdAt:'desc'}});
  return enqueueCapture(capture);
 }
 async function processJob(job){
  const data=job.data;
  let capture=await db.productCapture.findUnique({where:{id:data.captureId}});
  if(!matches(capture,data)||capture.excludedAt||capture.status==='descartado')return {status:'obsolete',reason:'capture_changed'};
  const round=await db.stocktakeRound.findUnique({where:{id:data.roundId},select:{operationType:true,status:true,storeId:true}});
  if(round?.operationType!=='replacement'||!['counting','review'].includes(round.status)||round.storeId!==data.storeId)return {status:'obsolete',reason:'round_inactive'};
  // A marker hash identifies the revision; only a server-side HMAC validation
  // attests that this finite owner confirmation is authentic. Never expose HMAC.
  const owner=ownerConfirmation(capture),attestation=owner?{ownerConfirmation:owner}:{};
  const recovery=require('./stockReplacementCaptureRecovery');
  const pending=(reason,automatic=false,scannerDiagnostic)=>{const nextAttemptAt=new Date(Date.now()+pendingAgeMs).toISOString();return persistPending(db,data,reason,{autoReprocess:automatic,nextAttemptAt,ownerConfirmation:owner,scannerDiagnostic,complete:async(tx,result)=>{
   const completed=await boss.complete(QUEUE,job,result,{db:adapter(tx)});if(completed.affected!==1)throw failure('queue_claim_lost');
   if(automatic){const next={...data,autoReprocess:true,nextAttemptAt,reprocessReason:reason};
    const sent=await boss.send(QUEUE,next,{db:adapter(tx),singletonKey:singleton(data),startAfter:new Date(nextAttemptAt),priority:recheckPriority,group:{id:data.storeId}});
    if(!sent)throw failure('queue_reschedule_failed');}
  }});};
  if(!await recovery.authorized(db,capture))return pending('operator_not_authorized');
  if(!capture.bipeId){
   let recoveryDiagnostic;
   const result=await recovery.recover(db,capture.id,{enqueue:false,onRuntimeDiagnostic:value=>{recoveryDiagnostic=value;}});
   if(!result.recovered){if(costly.has(result.reason))return pending(result.reason,true,recoveryDiagnostic);if(transient.has(result.reason))throw failure(result.reason);return pending(result.reason);}
   capture=await db.productCapture.findUnique({where:{id:data.captureId}});
  }
  if(!matches(capture,data))return {status:'obsolete',reason:'capture_changed'};
  const bipe=await db.stocktakeBipe.findUnique({where:{id:capture.bipeId}});
  if(!bipe||bipe.excludedAt||bipe.roundId!==data.roundId||bipe.storeId!==data.storeId||bipe.sellerId!==data.sellerId||policy.identity(bipe.barcode)!==policy.identity(capture.barcode))return {status:'obsolete',reason:'bipe_context_conflict'};
  const replacement=require('./stockReplacement');
  const beforeCommit=async tx=>{
   const completed=await boss.complete(QUEUE,job,{status:'applied',captureId:data.captureId,bipeId:bipe.id,...attestation},{db:adapter(tx)});
   if(completed.affected!==1)throw failure('queue_claim_lost');
  };
  if(bipe.applied){await require('./stockReplacementImages').check(db,bipe.id);return {status:'applied',captureId:data.captureId,bipeId:bipe.id,idempotent:true,...attestation};}
  // Decode and OCR entirely outside the short application transaction. The
  // observed frame is bound to the same revision again inside applyVerified.
  const bytes=Buffer.from(capture.photo.slice(capture.photo.indexOf(',')+1),'base64');
  const observed=await readImage(bytes,capture.barcode);
  if(costly.has(observed?.reason))return pending(observed.reason,true,observed.scannerDiagnostic);
  if(transient.has(observed?.reason))throw failure(observed.reason);
  const fresh=await db.productCapture.findUnique({where:{id:data.captureId}});
  if(!matches(fresh,data)||fresh.excludedAt||fresh.status==='descartado')return {status:'obsolete',reason:'capture_changed'};
  if(observed&&!observed.pending&&identify){
   await identify(capture.id,capture.photo,capture.barcode,{captureId:data.captureId,photoHash:data.photoHash,photoRevision:data.revision,
    captureContext:{roundId:data.roundId,storeId:data.storeId,scanKey:data.scanKey,sellerId:data.sellerId},ocrText:observed.text,serverRead:observed});
  }
  const result=await replacement.check(db,bipe.id,{read:observed,evidenceCapture:capture,beforeCommit,deferPending:true});
  if(costly.has(result?.reason))return pending(result.reason,true);
  if(transient.has(result?.reason))throw failure(result.reason);
  if(!result?.applied)return pending(result?.reason||'photo_size_or_reference_pending');
  return {status:'applied',reason:null,captureId:data.captureId,bipeId:bipe.id,...attestation};
 }
 async function prioritize(){
  // Only pending-job metadata is edited through pg-boss. Its update() rechecks
  // state under the row lock, so a concurrently claimed job is never changed.
  return db.$transaction(async tx=>{
   await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${SCHEMA+':priority:'+firstPriority}))::text`;
   const valid=`JOIN "ProductCapture" c ON c.id=j.data->>'captureId' JOIN "StocktakeRound" r ON r.id=c."roundId"
    LEFT JOIN "StocktakeBipe" b ON b.id=c."bipeId" WHERE j.name=$1 AND c."excludedAt" IS NULL AND c.status<>'descartado'
    AND (c."bipeId" IS NULL OR b."excludedAt" IS NULL) AND r."operationType"='replacement' AND r.status IN ('counting','review')
    AND r."storeId"=c."storeId" AND ${currentSnapshotSql()}`;
   const prior=`EXISTS(SELECT 1 FROM ${SCHEMA}.job p WHERE p.name=j.name AND p.id<>j.id AND p.data->>'captureId'=j.data->>'captureId'
    AND p.data->>'revision'=j.data->>'revision' AND p.data->>'photoHash'=j.data->>'photoHash'
    AND p.data->>'roundId'=j.data->>'roundId' AND p.data->>'storeId'=j.data->>'storeId' AND p.data->>'scanKey'=j.data->>'scanKey'
    AND p.data->>'sellerId'=j.data->>'sellerId' AND p.data->>'barcodeHash'=j.data->>'barcodeHash'
    AND COALESCE(p.data->>'confirmationHash','')=COALESCE(j.data->>'confirmationHash','') AND p.started_on IS NOT NULL)`;
   const fresh=await tx.$queryRawUnsafe(`SELECT j.id::text FROM ${SCHEMA}.job j ${valid} AND j.state='created' AND j.started_on IS NULL AND j.retry_count=0
    AND j.priority=$2 AND NOT ${prior} ORDER BY j.created_on LIMIT 100`,QUEUE,recheckPriority);
   let promoted=0;for(const row of fresh)promoted+=(await boss.update(QUEUE,undefined,{id:row.id,priority:firstPriority,db:adapter(tx)})).updated;
   // At most one recheck receives the fast lane per two-minute window. This
   // durable queue history survives restarts and prevents perpetual starvation.
   const [gate]=await tx.$queryRawUnsafe(`SELECT EXISTS(SELECT 1 FROM ${SCHEMA}.job WHERE name=$1 AND priority=$2 AND
    (state IN ('created','retry','active') OR started_on>$3)) AS busy`,QUEUE,agedPriority,new Date(Date.now()-recheckIntervalMs));
   let aged=0;
   if(!gate?.busy){const rows=await tx.$queryRawUnsafe(`SELECT j.id::text FROM ${SCHEMA}.job j ${valid} AND j.state IN ('created','retry')
     AND j.priority=$2 AND j.start_after<=now() AND NOT j.blocked AND (j.retry_count>0 OR j.started_on IS NOT NULL OR ${prior})
     ORDER BY j.created_on LIMIT 1`,QUEUE,recheckPriority);
    if(rows[0])aged=(await boss.update(QUEUE,undefined,{id:rows[0].id,priority:agedPriority,db:adapter(tx)})).updated;}
   return {promoted,aged};
  },{timeout:20000});
 }
 async function reconcile(){
  await start();
  // Only the finite maintenance service may sign these pre-approved requests.
  // The queue is ready, so note and enqueue share its transaction; OCR remains
  // with the existing worker. A request failure must not block ordinary scans.
  if(await ensureOwnerRequests()){
   try{await require('./finiteOwnerConfirmation').reconcile(db,{enqueueCapture:(capture,tx)=>enqueueCapture(capture,{tx})});}
   catch(_){ownerReady=false;console.warn('[replacement/queue] finite owner confirmation awaits retry');}
  }
  const priorities=await prioritize();
  // Recovery only schedules stored events. It does not decode, create bipes,
  // or alter balances. A pending piece is retried on its own schedule.
  // Applied pieces still need catalog-image review refresh; processJob skips
  // OCR for those and never applies their unit again.
  const select=()=>db.$queryRawUnsafe(`SELECT c.id FROM "ProductCapture" c JOIN "StocktakeRound" r ON r.id=c."roundId"
   LEFT JOIN "StocktakeBipe" b ON b.id=c."bipeId" LEFT JOIN "StockReplacementCheck" v ON v."bipeId"=b.id
   WHERE c."excludedAt" IS NULL AND c.status<>'descartado' AND c.photo IS NOT NULL AND c.barcode IS NOT NULL
    AND r."operationType"='replacement' AND r.status IN ('counting','review')
    AND (c."bipeId" IS NULL OR (b."excludedAt" IS NULL AND (v."bipeId" IS NULL OR v."checkedAt"<$1)))
    AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.job j WHERE j.name=$3 AND j.data->>'captureId'=c.id AND ${currentSnapshotSql()} AND j.created_on>$1)
    AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.job j WHERE j.name=$3 AND j.data->>'captureId'=c.id AND ${currentSnapshotSql()} AND j.state IN ('created','retry','active'))
    AND ($2::text IS NULL OR c.id>$2) ORDER BY c.id LIMIT 100`,new Date(Date.now()-pendingAgeMs),lastId,QUEUE);
  let captures=await select();
  if(!captures.length&&lastId){lastId=null;captures=await select();}
  let queued=0;
  for(const item of captures){lastId=item.id;const capture=await db.productCapture.findUnique({where:{id:item.id}});if(await enqueueCapture(capture))queued++;}
  return {examined:captures.length,queued,...priorities};
 }
 async function stop(){stopping=true;if(starting)try{await starting}catch(_){}if(boss)await boss.stop({graceful:true,timeout:5000});ready=false;}
 const api={start,enqueueCapture,enqueueBipe,reconcile,prioritize,processJob,stop,setIdentify:fn=>{identify=fn;},
  get boss(){return boss;},get state(){return {ready,workerId,lastErrorCode};}};
 return api;
}
function get(db,options){if(!instances.has(db))instances.set(db,createQueue(db,options));return instances.get(db);}
async function enqueue(db,bipeId){try{return await get(db).enqueueBipe(bipeId)}catch(error){console.warn('[replacement/queue] schedule failed; archived event awaits reconciliation');return null;}}
async function health(db,{roundId,storeId}={}){
 const worker=instances.get(db)?.state||{ready:false,lastErrorCode:null};
 try{
  const [relation]=await db.$queryRawUnsafe(`SELECT to_regclass('${SCHEMA}.job')::text AS name`);
  if(!relation?.name)return {available:false,queue:QUEUE,states:{},totalJobs:0,oldestPendingSeconds:null,items:[],worker};
  const where=`name=$1 AND ($2::text IS NULL OR data->>'roundId'=$2) AND ($3::text IS NULL OR data->>'storeId'=$3)`;
  const args=[QUEUE,roundId||null,storeId||null];
  const groups=await db.$queryRawUnsafe(`SELECT state::text AS state,count(*)::int AS count FROM ${SCHEMA}.job WHERE ${where} GROUP BY state`,...args);
  const items=await db.$queryRawUnsafe(`SELECT id::text AS "jobId",data->>'captureId' AS "captureId",(SELECT c."bipeId" FROM "ProductCapture" c WHERE c.id=data->>'captureId') AS "bipeId",state::text AS state,retry_count+1 AS attempts,
   created_on AS "createdAt",started_on AS "startedAt",completed_on AS "completedAt",
   CASE WHEN state='completed' AND ${automaticSql()} THEN output->>'nextAttemptAt' ELSE start_after::text END AS "nextAttemptAt",${automaticSql()} AS "autoReprocess",
   ${outcomeReasonSql('output')} AS reason
   FROM ${SCHEMA}.job WHERE ${where} ORDER BY created_on DESC LIMIT 250`,...args);
  const [oldest]=await db.$queryRawUnsafe(`SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(created_on)))::float8 AS seconds FROM ${SCHEMA}.job WHERE ${where} AND state IN ('created','retry','active')`,...args);
  return {available:true,queue:QUEUE,states:Object.fromEntries(groups.map(g=>[g.state,g.count])),totalJobs:groups.reduce((n,g)=>n+g.count,0),oldestPendingSeconds:oldest?.seconds??null,items,worker};
 }catch(_){return {available:false,queue:QUEUE,states:{},totalJobs:0,oldestPendingSeconds:null,items:[],worker:{...worker,lastErrorCode:'queue_status_unavailable'}};}
}
async function outcomes(db,captureIds){
 if(!captureIds?.length)return [];
 try{return await db.$queryRawUnsafe(`SELECT DISTINCT ON (c.id) c.id AS "captureId",j.state::text AS state,
  ${outcomeReasonSql('j.output')} AS reason,${automaticSql('j.')} AS "autoReprocess",
  CASE WHEN ${automaticSql('j.')} THEN CASE WHEN j.state='completed' THEN j.output->>'nextAttemptAt' ELSE j.start_after::text END ELSE NULL END AS "nextAttemptAt"
  FROM ${SCHEMA}.job j JOIN "ProductCapture" c ON c.id=j.data->>'captureId'
  WHERE j.name=$1 AND c.id=ANY($2::text[])
   AND ${currentSnapshotSql()}
  ORDER BY c.id,j.created_on DESC`,QUEUE,captureIds);}catch(_){return [];}
}
async function stop(db){const queue=instances.get(db);if(queue){await queue.stop();instances.delete(db);}}
async function stopAll(){await Promise.allSettled([...instances.keys()].map(stop));}
module.exports={SCHEMA,QUEUE,createQueue,get,enqueue,health,outcomes,stop,stopAll,adapter,snapshot,matches,pendingReason,persistPending,syncPendingCheck};
