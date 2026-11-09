'use strict';
const {createHash}=require('node:crypto');
const photos=require('./scannerCapturePhoto');
const policy=require('../../public/scanner-barcode-policy');
const SCHEMA='stock_replacement_queue',QUEUE='replacement-capture-v1';
const instances=new Map();
const transient=new Set(['ocr_busy','ocr_timeout','ocr_unavailable','ocr_memory_limit','photo_decode_busy','photo_decode_timeout','photo_decode_unavailable','photo_decode_memory_limit']);
const fingerprint=photo=>createHash('sha256').update(String(photo||'')).digest('hex');
function adapter(tx){return {executeSql:async(text,values=[])=>({rows:await tx.$queryRawUnsafe(text,...values)})};}
function failure(code){const e=new Error(code);e.code=code;return e;}
function snapshot(capture){return {captureId:capture.id,roundId:capture.roundId,storeId:capture.storeId,scanKey:capture.scanKey,
 revision:photos.revisionOf(capture.note),photoHash:fingerprint(capture.photo),sellerId:capture.sellerId,barcodeHash:fingerprint(policy.identity(capture.barcode))};}
function matches(capture,data){return !!capture&&capture.id===data.captureId&&capture.roundId===data.roundId&&capture.storeId===data.storeId&&
 capture.scanKey===data.scanKey&&capture.sellerId===data.sellerId&&photos.revisionOf(capture.note)===data.revision&&
 fingerprint(capture.photo)===data.photoHash&&fingerprint(policy.identity(capture.barcode))===data.barcodeHash;}
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
async function persistPending(db,data,reason,{complete}={}){
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
   note:photos.photoNote(capture.note,'etiqueta '+require('./stockReplacement').reasonText(reason)+' [scanner-queue-pending:'+reason+']')},select:{id:true}});
  const result={status:'pending',reason,captureId:capture.id,bipeId};
  if(complete)await complete(tx,result);
  return result;
 },{timeout:20000});
}
function createQueue(db,options={}){
 let boss,starting,ready=false,workerId,lastErrorCode=null,identify=options.identify,stopping=false,lastId=null;
 const pendingAgeMs=options.pendingAgeMs??300000;
 const readImage=options.readImage||((bytes,barcode)=>require('./scannerArchivedLabel').readImage(bytes,barcode));
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
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS replacement_capture_job_age ON ${SCHEMA}.job (name,(data->>'captureId'),created_on)`);
    if(options.work!==false)workerId=await boss.work(QUEUE,{batchSize:1,localConcurrency:options.localConcurrency||1,
     pollingIntervalSeconds:1,...options.workerOptions},async jobs=>processJob(jobs[0]));
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
  return boss.send(QUEUE,data,{singletonKey:[data.captureId,data.revision,data.photoHash].join(':'),
   ...(tx?{db:adapter(tx)}:{}),...(startAfter?{startAfter}:{}),priority:options.jobPriority||0,group:{id:capture.storeId}});
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
  const recovery=require('./stockReplacementCaptureRecovery');
  const pending=reason=>persistPending(db,data,reason,{complete:async(tx,result)=>{
   const completed=await boss.complete(QUEUE,job,result,{db:adapter(tx)});if(completed.affected!==1)throw failure('queue_claim_lost');
  }});
  if(!await recovery.authorized(db,capture))return pending('operator_not_authorized');
  if(!capture.bipeId){
   const result=await recovery.recover(db,capture.id,{enqueue:false});
   if(!result.recovered){if(transient.has(result.reason))throw failure(result.reason);return pending(result.reason);}
   capture=await db.productCapture.findUnique({where:{id:data.captureId}});
  }
  if(!matches(capture,data))return {status:'obsolete',reason:'capture_changed'};
  const bipe=await db.stocktakeBipe.findUnique({where:{id:capture.bipeId}});
  if(!bipe||bipe.excludedAt||bipe.roundId!==data.roundId||bipe.storeId!==data.storeId||bipe.sellerId!==data.sellerId||policy.identity(bipe.barcode)!==policy.identity(capture.barcode))return {status:'obsolete',reason:'bipe_context_conflict'};
  const replacement=require('./stockReplacement');
  const beforeCommit=async tx=>{
   const completed=await boss.complete(QUEUE,job,{status:'applied',captureId:data.captureId,bipeId:bipe.id},{db:adapter(tx)});
   if(completed.affected!==1)throw failure('queue_claim_lost');
  };
  if(bipe.applied){await require('./stockReplacementImages').check(db,bipe.id);return {status:'applied',bipeId:bipe.id,idempotent:true};}
  // Decode and OCR entirely outside the short application transaction. The
  // observed frame is bound to the same revision again inside applyVerified.
  const bytes=Buffer.from(capture.photo.slice(capture.photo.indexOf(',')+1),'base64');
  const observed=await readImage(bytes,capture.barcode);
  if(transient.has(observed?.reason))throw failure(observed.reason);
  if(observed&&!observed.pending&&identify){
   await identify(capture.id,capture.photo,capture.barcode,{photoRevision:data.revision,ocrText:observed.text,serverRead:observed});
  }
  const result=await replacement.check(db,bipe.id,{read:observed,evidenceCapture:capture,beforeCommit,deferPending:true});
  if(transient.has(result?.reason))throw failure(result.reason);
  if(!result?.applied)return pending(result?.reason||'photo_size_or_reference_pending');
  return {status:'applied',reason:null,bipeId:bipe.id};
 }
 async function reconcile(){
  await start();
  // Recovery only schedules stored events. It does not decode, create bipes,
  // or alter balances. A pending piece is retried on its own schedule.
  const select=()=>db.$queryRawUnsafe(`SELECT c.id FROM "ProductCapture" c JOIN "StocktakeRound" r ON r.id=c."roundId"
   LEFT JOIN "StocktakeBipe" b ON b.id=c."bipeId" LEFT JOIN "StockReplacementCheck" v ON v."bipeId"=b.id
   WHERE c."excludedAt" IS NULL AND c.status<>'descartado' AND c.photo IS NOT NULL AND c.barcode IS NOT NULL
    AND r."operationType"='replacement' AND r.status IN ('counting','review')
    AND (c."bipeId" IS NULL OR (b."excludedAt" IS NULL AND (v."bipeId" IS NULL OR v."checkedAt"<$1)))
    AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.job j WHERE j.name=$3 AND j.data->>'captureId'=c.id AND j.created_on>$1)
    AND ($2::text IS NULL OR c.id>$2) ORDER BY c.id LIMIT 100`,new Date(Date.now()-pendingAgeMs),lastId,QUEUE);
  let captures=await select();
  if(!captures.length&&lastId){lastId=null;captures=await select();}
  let queued=0;
  for(const item of captures){lastId=item.id;const capture=await db.productCapture.findUnique({where:{id:item.id}});if(await enqueueCapture(capture))queued++;}
  return {examined:captures.length,queued};
 }
 async function stop(){stopping=true;if(starting)try{await starting}catch(_){}if(boss)await boss.stop({graceful:true,timeout:5000});ready=false;}
 const api={start,enqueueCapture,enqueueBipe,reconcile,processJob,stop,setIdentify:fn=>{identify=fn;},
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
   created_on AS "createdAt",started_on AS "startedAt",completed_on AS "completedAt",start_after AS "nextAttemptAt",
   CASE WHEN output->>'reason' ~ '^[a-z_]{1,80}$' THEN output->>'reason' ELSE NULL END AS reason
   FROM ${SCHEMA}.job WHERE ${where} ORDER BY created_on DESC LIMIT 250`,...args);
  const [oldest]=await db.$queryRawUnsafe(`SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(created_on)))::float8 AS seconds FROM ${SCHEMA}.job WHERE ${where} AND state IN ('created','retry','active')`,...args);
  return {available:true,queue:QUEUE,states:Object.fromEntries(groups.map(g=>[g.state,g.count])),totalJobs:groups.reduce((n,g)=>n+g.count,0),oldestPendingSeconds:oldest?.seconds??null,items,worker};
 }catch(_){return {available:false,queue:QUEUE,states:{},totalJobs:0,oldestPendingSeconds:null,items:[],worker:{...worker,lastErrorCode:'queue_status_unavailable'}};}
}
async function outcomes(db,captureIds){
 if(!captureIds?.length)return [];
 try{return await db.$queryRawUnsafe(`SELECT DISTINCT ON (c.id) c.id AS "captureId",j.state::text AS state,
  CASE WHEN j.output->>'reason' ~ '^[a-z_]{1,80}$' THEN j.output->>'reason' ELSE NULL END AS reason
  FROM ${SCHEMA}.job j JOIN "ProductCapture" c ON c.id=j.data->>'captureId'
  WHERE j.name=$1 AND c.id=ANY($2::text[])
   AND j.data->>'revision'=substring(c.note from '\\[scanner-photo-revision:([0-9]+)\\]$')
   AND j.data->>'photoHash'=encode(sha256(convert_to(COALESCE(c.photo,''),'UTF8')),'hex')
  ORDER BY c.id,j.created_on DESC`,QUEUE,captureIds);}catch(_){return [];}
}
async function stop(db){const queue=instances.get(db);if(queue){await queue.stop();instances.delete(db);}}
async function stopAll(){await Promise.allSettled([...instances.keys()].map(stop));}
module.exports={SCHEMA,QUEUE,createQueue,get,enqueue,health,outcomes,stop,stopAll,adapter,snapshot,matches,pendingReason,persistPending,syncPendingCheck};
