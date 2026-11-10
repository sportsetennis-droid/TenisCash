'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{fork}=require('node:child_process'),{EventEmitter}=require('node:events');
const {createBroker,limits}=require('../src/services/scannerImageBroker');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await delay(10);}throw Error('Process did not exit');};
(async()=>{
 assert.equal(limits.maxRssBytes,384*1024*1024);assert.equal(limits.labelTimeoutMs,24000);assert.equal(limits.heapMb,128);
 const children=[];
 const broker=createBroker({spawn(){
  const child=new EventEmitter();Object.assign(child,{pid:100+children.length,ref(){},unref(){},channel:{ref(){},unref(){}},send(m){child.message=m;},kill(){child.killed=true;return true;}});
  children.push(child);setImmediate(()=>child.emit('message',{type:'ready'}));return child;
 }});
 const first=broker.run('label',Buffer.from('first'),'123');await delay(5);
 const queued=broker.run('barcode',Buffer.from('queued'),null,{queue:true});
 children[0].emit('message',{type:'result',id:children[0].message.id,result:{size:'41',references:['TEST001']}});
 assert.equal((await first).size,'41');assert.equal(children[0].killed,true);assert.equal(broker.getStatus().stopping,true);
 assert.equal(children.length,1,'Successful label must not overlap the next process');
 await assert.rejects(broker.run('label',Buffer.from('other'),'123'),e=>e.code==='SCANNER_IMAGE_BUSY');
 children[0].emit('message',{type:'result',id:children[0].message.id,result:{size:'99'}});
 assert.equal(children.length,1);children[0].emit('exit',0);await delay(5);assert.equal(children.length,2);
 children[1].emit('message',{type:'result',id:children[1].message.id,result:['queued']});assert.deepEqual(await queued,['queued']);
 assert.equal(broker.getStatus().stopping,false,'Barcode-only results still reuse the bounded process');
 const pending=broker.run('label',Buffer.from('pending'),'123');await delay(5);
 children[1].emit('message',{type:'result',id:children[1].message.id,result:{pending:true,reason:'photo_size_or_reference_pending'}});
 assert.equal((await pending).pending,true);assert.equal(broker.getStatus().stopping,true,'Pending label also releases retained OCR allocations');
 children[1].emit('exit',0);await broker.shutdown();
 let spawned=0,maxLive=0;const live=new Set();
 const actual=createBroker({limits:{idleMs:5000,maxJobs:12},spawn(){
  const child=fork(path.join(__dirname,'fixtures/scanner-image-worker.cjs'),[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',windowsHide:true,execArgv:['--max-old-space-size=64']});
  spawned++;live.add(child.pid);maxLive=Math.max(maxLive,live.size);child.once('exit',()=>live.delete(child.pid));return child;
 }});
 const pids=[];for(const text of ['one','two','three']){const promise=actual.run('label',Buffer.from(text),'123');pids.push(actual.getStatus().pid);assert.deepEqual(await promise,[text]);await until(()=>!actual.getStatus().stopping);}
 assert.equal(new Set(pids).size,3);assert.equal(spawned,3);assert.equal(maxLive,1);
 assert.deepEqual(await actual.run('barcode',Buffer.from('barcode-one'),null),['barcode-one']);const barcodePid=actual.getStatus().pid;
 assert.deepEqual(await actual.run('barcode',Buffer.from('barcode-two'),null),['barcode-two']);assert.equal(actual.getStatus().pid,barcodePid);assert.equal(spawned,4);
 for(let n=3;n<=12;n++){
  assert.equal(actual.getStatus().pid,barcodePid);
  assert.deepEqual(await actual.run('barcode',Buffer.from('barcode-'+n),null),['barcode-'+n]);
 }
 assert.equal(actual.getStatus().stopping,true,'The twelfth barcode retires the reused process');
 await until(()=>!actual.getStatus().stopping);assert.equal(spawned,4);
 assert.deepEqual(await actual.run('barcode',Buffer.from('barcode-13'),null),['barcode-13']);assert.notEqual(actual.getStatus().pid,barcodePid);assert.equal(spawned,5);
 await actual.shutdown();assert.equal(live.size,0);
 console.log('PASS every label result retires its process, including pending; next work waits for actual exit; stale result rejected; real child PIDs never overlap; barcode reuse and 384MiB/24s/128MiB limits preserved.');
})().catch(e=>{console.error(e);process.exitCode=1;});
