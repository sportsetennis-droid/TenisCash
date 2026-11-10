'use strict';
const assert=require('node:assert/strict'),Module=require('node:module'),{EventEmitter}=require('node:events');
const queues=require('../src/services/stockReplacementQueue');
const calls=[],warnings=[],originalRequire=Module.prototype.require,originalWarn=console.warn;
let mode='enqueue',sent;
const capture={id:'owner-hook-capture',roundId:'owner-hook-round',storeId:'owner-hook-store',sellerId:'owner-hook-seller',scanKey:'owner-hook-key',
 barcode:'5901234123457',photo:'data:image/png;base64,dGVzdA==',note:'\n[scanner-photo-revision:1]',excludedAt:null,status:'pendente'};
const maintenanceTx={stocktakeRound:{findUnique:async()=>({operationType:'replacement',status:'counting',storeId:capture.storeId})},
 $queryRawUnsafe:async sql=>{if(sql==='same-maintenance-transaction'){calls.push('enqueue-transaction');return [{same:true}]};return [{attempted:false}]}};
const service={ensure:async db=>{assert.equal(db,fakeDb);calls.push('ensure');if(mode==='ensure-throw')throw Error('secret-bootstrap-failure')},reconcile:async(db,{enqueueCapture})=>{
 assert.equal(db,fakeDb);calls.push('owner-reconcile');if(mode==='throw')throw Error('secret-not-for-logs');
 assert.equal(await enqueueCapture(capture,maintenanceTx),'same-transaction-job');}};
Module.prototype.require=function(request){if(request==='./finiteOwnerConfirmation'&&this.filename.endsWith('stockReplacementQueue.js'))return service;return originalRequire.apply(this,arguments)};
console.warn=message=>warnings.push(message);
const boss=Object.assign(new EventEmitter(),{start:async()=>{calls.push('boss-start')},createQueue:async()=>{calls.push('create-queue')},
 work:async()=>{throw Error('Local worker must not start in this test')},stop:async()=>{},send:async(name,data,options)=>{
  assert.equal(name,queues.QUEUE);assert.deepEqual(await options.db.executeSql('same-maintenance-transaction'),{rows:[{same:true}]});sent={data,options};return 'same-transaction-job';}});
const fakeDb={$executeRawUnsafe:async()=>{calls.push('queue-index')},$queryRawUnsafe:async()=>{calls.push('ordinary-reconcile');return []},
 $transaction:async callback=>{calls.push('prioritize');return callback({$queryRaw:async()=>[],$queryRawUnsafe:async()=>[]})}};
const q=queues.createQueue(fakeDb,{boss,work:false});
(async()=>{
 await q.start();assert.deepEqual(calls,['boss-start','create-queue','ensure','queue-index']);
 await q.reconcile();assert.ok(calls.indexOf('owner-reconcile')<calls.indexOf('prioritize'));assert.ok(calls.includes('ordinary-reconcile'));
 assert.equal(sent.data.captureId,capture.id);assert.equal(sent.options.priority,10);assert.equal(calls.filter(x=>x==='ensure').length,1);
 console.log('PASS finite request hook bootstraps after queue, runs before ordinary reconciliation and enqueues in its provided transaction');
 mode='throw';calls.length=0;await q.reconcile();assert.deepEqual(calls,['owner-reconcile','prioritize','ordinary-reconcile']);
 assert.deepEqual(warnings,['[replacement/queue] finite owner confirmation awaits retry']);assert.ok(!warnings.join('').includes('secret'));
 console.log('PASS unexpected maintenance error is sanitized and ordinary queue reconciliation continues without another worker');
 mode='enqueue';calls.length=0;await q.reconcile();assert.deepEqual(calls,['ensure','owner-reconcile','enqueue-transaction','prioritize','ordinary-reconcile']);
 mode='ensure-throw';calls.length=0;const second=queues.createQueue(fakeDb,{boss,work:false});
 try{
  await second.start();assert.equal(second.state.ready,true);assert.deepEqual(calls,['boss-start','create-queue','ensure','queue-index']);
  calls.length=0;await second.reconcile();assert.deepEqual(calls,['ensure','prioritize','ordinary-reconcile']);
  mode='enqueue';calls.length=0;await second.reconcile();assert.deepEqual(calls,['ensure','owner-reconcile','enqueue-transaction','prioritize','ordinary-reconcile']);
  assert.equal(second.state.ready,true);assert.ok(!warnings.join('').includes('secret'));
 }finally{await second.stop()}
 console.log('PASS finite bootstrap failure preserves ordinary queue startup and retries safely on a later reconciliation');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await q.stop();Module.prototype.require=originalRequire;console.warn=originalWarn});
