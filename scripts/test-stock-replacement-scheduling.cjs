'use strict';
// No database: exercise the installed pg-boss Worker and its actual interval
// resolver with an in-memory fetcher, using the application's worker options.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),queue=require('../src/services/stockReplacementQueue');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 let workerOptions;
 const fakeBoss={on(){},async start(){},async createQueue(){},async stop(){},async work(_name,options){workerOptions=options;return 'isolated-worker';}};
 const q=queue.createQueue({async $executeRawUnsafe(){}},{boss:fakeBoss});await q.start();await q.stop();
 assert.equal(workerOptions.localConcurrency,1);assert.equal(workerOptions.batchSize,1);
 assert.equal(workerOptions.pollingIntervalSeconds,1);assert.equal(workerOptions.burstWhenReadyExceeds,1);
 const {default:Worker}=await import(pathToFileURL(path.join(root,'node_modules/pg-boss/dist/worker.js')));
 const {systemClock}=await import(pathToFileURL(path.join(root,'node_modules/pg-boss/dist/clock.js')));
 const manager=fs.readFileSync(path.join(root,'node_modules/pg-boss/dist/manager.js'),'utf8');
 const begin=manager.indexOf('const resolveInterval = (lastFetchCount) => {'),end=manager.indexOf('const createWorker =',begin);
 assert.ok(begin>=0&&end>begin,'installed pg-boss interval resolver must be found');
 const intervalSource=manager.slice(begin,end);
 function resolver(ready){return vm.runInNewContext(intervalSource+'\nresolveInterval;',{
  batchSize:workerOptions.batchSize,burstWhenReadyExceeds:workerOptions.burstWhenReadyExceeds,
  burstWhenBatchFull:false,getReadyCount:()=>ready.value,isNotifyActive:()=>false,
  notifyInterval:30000,interval:workerOptions.pollingIntervalSeconds*1000});}
 const ready={value:4},resolveInterval=resolver(ready);
 assert.equal(resolveInterval(1),0);assert.equal(resolveInterval(0),1000);
 ready.value=1;assert.equal(resolveInterval(1),1000);ready.value=4;
 async function scenario({handlerError=false,fetchError=false}={}){
  const jobs=[1,2,3,4],started=[],successful=[],errors=[];let active=0,maxActive=0,failFetch=fetchError,finished;
  const done=new Promise(resolve=>{finished=resolve;}),t0=Date.now();
  const worker=new Worker({id:'isolated',workId:'isolated',name:'isolated',options:workerOptions,clock:systemClock,
   resolveInterval,fetch:async()=>{
    if(failFetch){failFetch=false;throw Error('isolated-fetch-error');}
    const id=jobs.shift();if(!id){finished();return [];}
    return [{id}];
   },onFetch:async batch=>{
    if(!batch.length)return;
    const id=batch[0].id;active++;maxActive=Math.max(maxActive,active);started.push({id,at:Date.now()-t0});
    try{await sleep(5);if(handlerError&&id===2)throw Error('isolated-handler-error');successful.push(id);}finally{active--;}
   },onError:error=>errors.push(error.message)});
  worker.start();await done;await worker.stop();
  assert.equal(maxActive,1);assert.deepEqual(started.map(x=>x.id),[1,2,3,4]);assert.equal(active,0);
  return {started,successful,errors};
 }
 const backlog=await scenario();assert.deepEqual(backlog.successful,[1,2,3,4]);
 assert.ok(backlog.started[3].at-backlog.started[0].at<500,'known backlog must not sleep one second between jobs');
 const failed=await scenario({handlerError:true});assert.deepEqual(failed.successful,[1,3,4]);assert.equal(failed.errors.length,1);
 const failedFetch=await scenario({fetchError:true});assert.deepEqual(failedFetch.successful,[1,2,3,4]);
 assert.equal(failedFetch.errors.length,1);assert.ok(failedFetch.started[0].at>=850,'failed fetch must return to normal polling');
 console.log('PASS real pg-boss scheduler: one handler, backlog drain, empty/short fetch polling, next piece after handler error, and fetch-error backoff');

 const source=fs.readFileSync(path.join(root,'src/services/stockReplacementQueue.js'),'utf8');
 const transientSource=source.match(/const transient=new Set\(\[[^\]]+\]\);/)?.[0];assert.ok(transientSource);
 const functions=source.slice(source.indexOf('function failure('),source.indexOf('function snapshot('));
 const context={};vm.createContext(context);vm.runInContext(transientSource+'\n'+functions+'\nthis.codes=[...transient];',context);
 const {serializeError}=await import(pathToFileURL(path.join(root,'node_modules/serialize-error/index.js')));
 assert.equal(context.codes.length,8);
 for(const code of context.codes){const output=serializeError(context.failure(code));assert.equal(output.reason,code);assert.equal(output.code,code);}
 assert.equal(context.failure('queue_claim_lost').reason,undefined);
 for(const column of ['output','j.output']){
  const sql=context.outcomeReasonSql(column);
  assert.ok(sql.includes(`${column}->>'reason' ~ '^[a-z_]{1,80}$'`));
  for(const key of ['code','message']){
   const allowed=sql.match(new RegExp(`${column.replace('.','\\.')}->>'${key}' IN \\(([^)]+)\\)`))?.[1];
   assert.ok(allowed);assert.deepEqual(allowed.split(',').map(x=>x.slice(1,-1)),Array.from(context.codes));
  }
  assert.ok(sql.endsWith('ELSE NULL END'));assert.equal(sql.includes('stack'),false);
 }
 assert.ok(source.includes("${outcomeReasonSql('output')} AS reason"));
 assert.ok(source.includes("${outcomeReasonSql('j.output')} AS reason"));
 console.log('PASS eight transient errors retain machine reason through pg-boss serializer; historical code/message SQL fallback is restricted to the same eight codes');
})().catch(error=>{console.error(error);process.exitCode=1;});
