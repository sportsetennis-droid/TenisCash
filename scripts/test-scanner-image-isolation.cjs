'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{fork}=require('node:child_process'),{EventEmitter}=require('node:events');
const {createBroker}=require('../src/services/scannerImageBroker');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(test)=>{for(let i=0;i<100;i++){if(test())return;await delay(10)}assert.fail('process did not settle');};
const failed=(promise,code)=>assert.rejects(promise,error=>error.code===code);
(async()=>{
  // Hold exit explicitly: deadline must not release process ownership early.
  const children=[];
  const mock=createBroker({limits:{labelTimeoutMs:35,idleMs:5000},spawn(){
    const child=new EventEmitter();Object.assign(child,{pid:100+children.length,ref(){},unref(){},channel:{ref(){},unref(){}},
      send(message){child.message=message},kill(){child.killed=true;return true}});children.push(child);
    setImmediate(()=>child.emit('message',{type:'ready'}));return child;
  }});
  const old=mock.run('label',Buffer.from('old'),'123');await failed(old,'SCANNER_IMAGE_TIMEOUT');
  assert.equal(children.length,1);assert.equal(mock.getStatus().stopping,true);assert.equal(children[0].killed,true);
  await failed(mock.run('label',Buffer.from('new'),'123'),'SCANNER_IMAGE_BUSY');
  children[0].emit('message',{type:'result',id:children[0].message.id,result:{size:'99'}});
  assert.equal(mock.getStatus().stopping,true,'late old result must not release ownership');
  children[0].emit('exit',9);
  const newer=mock.run('label',Buffer.from('new'),'123');await delay(5);
  assert.equal(children.length,2);children[1].emit('message',{type:'result',id:children[1].message.id,result:{size:'41'}});
  assert.equal((await newer).size,'41');const shutdown=mock.shutdown();children[1].emit('exit',0);await shutdown;
  console.log('PASS timeout returns pending while ownership lasts until child exit; stale result cannot resolve another photo');

  const broken=createBroker({spawn(){throw Error('spawn unavailable')}});
  await failed(broken.run('label',Buffer.from('photo'),'1'),'SCANNER_IMAGE_UNAVAILABLE');
  assert.equal(broken.getStatus().running,false);assert.equal(broken.getStatus().pid,null);await broken.shutdown();

  let spawned=0;
  const broker=createBroker({limits:{labelTimeoutMs:300,barcodeTimeoutMs:2000,idleMs:5000,maxJobs:50,maxQueued:2,maxQueuedBytes:64},spawn(){spawned++;
    return fork(path.join(__dirname,'fixtures/scanner-image-worker.cjs'),[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',windowsHide:true,execArgv:['--max-old-space-size=64']});}});
  assert.deepEqual(await broker.run('barcode',Buffer.from('first'),null),['first']);const firstPid=broker.getStatus().pid;
  assert.deepEqual(await broker.run('barcode',Buffer.from('stale'),null),['stale']);assert.equal(spawned,1,'process reused');
  let ticks=0;const clock=setInterval(()=>ticks++,10);
  await failed(broker.run('label',Buffer.from('hang'),'1'),'SCANNER_IMAGE_TIMEOUT');clearInterval(clock);
  assert.ok(ticks>=10,'API parent event loop remains responsive while child CPU is blocked');await until(()=>!broker.getStatus().stopping);
  assert.deepEqual(await broker.run('barcode',Buffer.from('after-timeout'),null),['after-timeout']);assert.notEqual(broker.getStatus().pid,firstPid);
  await failed(broker.run('label',Buffer.from('crash'),'1'),'SCANNER_IMAGE_UNAVAILABLE');await until(()=>!broker.getStatus().stopping);
  assert.deepEqual(await broker.run('barcode',Buffer.from('after-crash'),null),['after-crash']);
  await failed(broker.run('label',Buffer.from('memory'),'1'),'SCANNER_IMAGE_MEMORY_LIMIT');await until(()=>!broker.getStatus().stopping);
  assert.deepEqual(await broker.run('barcode',Buffer.from('after-memory'),null),['after-memory']);
  console.log('PASS real child CPU hang/crash and simulated over-limit RSS report do not crash/block parent; each allows a fresh process');

  const one=broker.run('barcode',Buffer.from('one'),null,{queue:true});
  const two=broker.run('barcode',Buffer.from('two'),null,{queue:true});
  const three=broker.run('barcode',Buffer.from('three'),null,{queue:true});
  await failed(broker.run('barcode',Buffer.from('overflow'),null,{queue:true}),'SCANNER_IMAGE_BUSY');
  await failed(broker.run('label',Buffer.from('label'),'1'),'SCANNER_IMAGE_BUSY');
  assert.deepEqual(await Promise.all([one,two,three]),[['one'],['two'],['three']]);
  const a=broker.run('barcode',Buffer.from('a'),null,{queue:true});
  await failed(broker.run('barcode',Buffer.alloc(65),null,{queue:true}),'SCANNER_IMAGE_BUSY');await a;
  await failed(broker.run('barcode',Buffer.alloc(12*1024*1024+1),null),'SCANNER_IMAGE_INVALID');
  assert.equal(broker.getStatus().queued,0);assert.equal(broker.getStatus().queuedBytes,0);await broker.shutdown();
  await failed(broker.run('label',Buffer.from('closed'),'1'),'SCANNER_IMAGE_UNAVAILABLE');
  console.log('PASS bounded barcode FIFO/bytes, label backpressure, oversized rejection and shutdown preserve ordering without unlimited workers');
})().catch(error=>{console.error(error);process.exitCode=1;});
