'use strict';
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {SOURCE,sanitize}=require('../src/services/scannerRuntimeDiagnostic');
const {createBroker,limits}=require('../src/services/scannerImageBroker');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const forbidden={photo:'data:image/secret',text:'PRIVATE OCR',barcode:'7890000000000',token:'secret-token',path:'/private/file',name:'operator'};
const allowed={source:SOURCE,phase:'ocr',kind:'label',platform:'linux',arch:'x64',node:'22.14.0',sharp:'0.35.5',vips:'8.17.3',tesseract:'7.0.0',
 rssBytes:200,peakRssObservedBytes:220,elapsedMs:30,phaseElapsedMs:29,timeoutMs:24000,maxRssBytes:limits.maxRssBytes,width:2026,height:3600,pass:2,angle:0,psm:'11',enhanced:true,mallocArenaMax:2,allocatorOverridePresent:false};
function mockBroker(){const children=[];return {children,broker:createBroker({limits:{labelTimeoutMs:70,barcodeTimeoutMs:70,idleMs:5000,maxRssBytes:1024},spawn(){
 const child=new EventEmitter();Object.assign(child,{pid:100+children.length,ref(){},unref(){},channel:{ref(){},unref(){}},send(m){child.message=m;},kill(){child.killed=true;return true;}});
 children.push(child);setImmediate(()=>child.emit('message',{type:'ready'}));return child;
}})};}
(async()=>{
 assert.deepEqual(sanitize({...allowed,...forbidden}),{...allowed,rasterPixels:7293600});
 assert.equal(sanitize({phase:'ocr'}),null);assert.equal(sanitize({source:'other',...forbidden}),null);
 const invalid=sanitize({source:SOURCE,phase:'secret',platform:'other',arch:'secret',node:'22.14.0-token',width:1.5,height:24001,pass:129,angle:45,psm:'other',enhanced:1,
  rssBytes:Infinity,peakRssObservedBytes:NaN,elapsedMs:-1,phaseElapsedMs:600001,maxRssBytes:17*1024**3,timeoutMs:'24000',mallocArenaMax:129,allocatorOverridePresent:'secret'});
 assert.deepEqual(invalid,{source:SOURCE});assert.ok(JSON.stringify(sanitize({...allowed,...forbidden})).length<1024);
 console.log('PASS strict allowlist, bounds, enums, versions and payload size; no photo, OCR, barcode, names, paths or credentials');

 const {children,broker}=mockBroker();let error;
 const first=broker.run('label',Buffer.from('first'),'private-code').catch(e=>{error=e;});await delay(5);
 let child=children[0],id=child.message.id;
 child.emit('message',{type:'diagnostic',id:'other-job',diagnostic:{...allowed,rssBytes:999999}});
 child.emit('message',{type:'memory',id:'other-job',rss:999999});assert.equal(child.killed,undefined);
 child.emit('message',{type:'diagnostic',id,diagnostic:{...allowed,...forbidden}});
 child.emit('message',{type:'memory',id,rss:Infinity});assert.equal(child.killed,undefined);
 child.emit('message',{type:'memory',id,rss:1200});await first;
 assert.equal(error.code,'SCANNER_IMAGE_MEMORY_LIMIT');assert.equal(error.scannerDiagnostic.phase,'ocr');assert.equal(error.scannerDiagnostic.rssBytes,1200);
 assert.equal(error.scannerDiagnostic.peakRssObservedBytes,1200);assert.equal(error.scannerDiagnostic.rasterPixels,7293600);assert.equal(error.scannerDiagnostic.maxRssBytes,1024);
 assert.ok(!Object.keys(forbidden).some(key=>key in error.scannerDiagnostic));child.emit('exit',9);
 const next=broker.run('barcode',Buffer.from('second'),null).catch(e=>{error=e;});await delay(5);const old=child;child=children[1];id=child.message.id;
 old.emit('message',{type:'diagnostic',id,diagnostic:allowed});old.emit('message',{type:'memory',id,rss:1200});
 child.emit('message',{type:'diagnostic',id:'old-job',diagnostic:allowed});await next;
 assert.equal(error.code,'SCANNER_IMAGE_TIMEOUT');assert.equal(error.scannerDiagnostic.phase,'starting');assert.equal(error.scannerDiagnostic.kind,'barcode');
 assert.equal(error.scannerDiagnostic.width,undefined);assert.equal(error.scannerDiagnostic.rssBytes,undefined);assert.ok(error.scannerDiagnostic.elapsedMs>=60);
 child.emit('exit',9);
 const third=broker.run('barcode',Buffer.from('third'),null);await delay(5);child=children[2];const priorId=child.message.id;
 child.emit('message',{type:'diagnostic',id:priorId,diagnostic:allowed});child.emit('message',{type:'result',id:priorId,result:['third']});await third;
 const fourth=broker.run('barcode',Buffer.from('fourth'),null).catch(e=>{error=e;});await delay(5);
 child.emit('message',{type:'diagnostic',id:priorId,diagnostic:allowed});child.emit('message',{type:'memory',id:priorId,rss:1200});await fourth;
 assert.equal(error.code,'SCANNER_IMAGE_TIMEOUT');assert.equal(error.scannerDiagnostic.phase,'starting');assert.equal(error.scannerDiagnostic.width,undefined);
 child.emit('exit',9);await broker.shutdown();
 const crash=mockBroker();const failed=crash.broker.run('label',Buffer.from('crash'),'code').catch(e=>{error=e;});await delay(5);
 crash.children[0].emit('message',{type:'diagnostic',id:crash.children[0].message.id,diagnostic:allowed});crash.children[0].emit('exit',1);await failed;
 assert.equal(error.code,'SCANNER_IMAGE_UNAVAILABLE');assert.equal(error.scannerDiagnostic,undefined);await crash.broker.shutdown();
 const enormous=mockBroker();const overCap=enormous.broker.run('label',Buffer.from('large'),'code').catch(e=>{error=e;});await delay(5);
 enormous.children[0].emit('message',{type:'memory',id:enormous.children[0].message.id,rss:17*1024**3});
 assert.equal(enormous.children[0].killed,true,'RSS above the diagnostic field cap must still enforce the resource limit immediately');await overCap;
 assert.equal(error.code,'SCANNER_IMAGE_MEMORY_LIMIT');assert.equal(error.scannerDiagnostic.rssBytes,undefined,'Unbounded value is not persisted');
 assert.equal(error.scannerDiagnostic.maxRssBytes,1024);enormous.children[0].emit('exit',9);await enormous.broker.shutdown();
 console.log('PASS memory/timeout retain original reasons and own-job metrics; stale IPC, replaced PID and reused barcode process cannot contaminate the next capture; crash reason unchanged');

 const service=require('../src/services/scannerImageBroker'),run=service.run;
 try{service.run=async()=>{throw Object.assign(Error('private'),{code:'SCANNER_IMAGE_MEMORY_LIMIT',scannerDiagnostic:{...allowed,...forbidden}});};
  const read=await require('../src/services/scannerArchivedLabel').readImage(Buffer.from('bytes'),'private-code');
  assert.equal(read.reason,'ocr_memory_limit');assert.equal(read.retry,true);assert.deepEqual(read.scannerDiagnostic,sanitize(allowed));
 }finally{service.run=run;}
 const sharp=require('sharp'),{createProcessor}=require('../src/services/scannerImageProcessor');
 const photo=await sharp({create:{width:31,height:47,channels:3,background:'#fff'}}).png().toBuffer();
 const observe=async callback=>{const calls=[],events=[];const p=createProcessor({decode:async()=>['7898707778727'],readParts:()=>({}),readWords:()=>null,
  createWorker:async()=>({setParameters:async()=>{},recognize:async bytes=>{calls.push(bytes.toString('base64'));return {data:{text:'',blocks:[]}};},terminate:async()=>{}})});
  const result=await p.run('label',photo,'7898707778727',callback===false?undefined:value=>{events.push(value);if(callback==='throws')throw Error('ignored');});await p.close();return {calls,events,result};};
 const plain=await observe(false),instrumented=await observe(true),throwing=await observe('throws');
 assert.deepEqual(instrumented.calls,plain.calls);assert.deepEqual(throwing.calls,plain.calls);assert.deepEqual(instrumented.result,plain.result);
 const rasters=instrumented.events.filter(x=>x.phase==='ocr');assert.equal(rasters.length,16);assert.deepEqual(rasters.map(x=>x.pass),Array.from({length:16},(_,i)=>i+1));
 assert.deepEqual([rasters[1].width,rasters[1].height],[62,94]);assert.deepEqual([rasters[4].width,rasters[4].height],[47,31]);
 console.log('PASS processor reports actual transformed raster sizes; original, enhanced and rotated bytes/output are identical; diagnostic callback failure cannot affect recognition');

 // Run the real worker wrapper against a stub processor. A callback retained by
 // an old operation must still carry that old ID after another message starts.
 const proc=new EventEmitter(),sent=[],reporters=[];Object.assign(proc,{connected:true,platform:'linux',arch:'x64',versions:{node:'22.14.0'},env:{MALLOC_ARENA_MAX:'2',LD_PRELOAD:'/secret/allocator'},
  send(value,cb){sent.push(value);cb?.();},exit(){throw Error('unexpected exit');},memoryUsage:()=>({rss:12345})});
 const module={exports:{}};const shim={concurrency(){},cache(){},versions:{sharp:'0.35.5',vips:'8.17.3'}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/services/scannerImageWorker.js'),'utf8'),{module,process:proc,Buffer,setImmediate,
  setInterval:()=>({unref(){}}),require(name){if(name==='sharp')return shim;if(name==='./scannerRuntimeDiagnostic')return {SOURCE,sanitize};
   if(name==='tesseract.js/package.json')return {version:'7.0.0'};
   if(name==='./scannerImageProcessor')return {createProcessor:()=>({async run(k,b,c,report){reporters.push(report);return [];}})};throw Error('unexpected module '+name);}});
 proc.emit('message',{type:'run',id:'first-id',kind:'barcode',image:Buffer.from('one')});await delay(1);
 proc.emit('message',{type:'run',id:'second-id',kind:'barcode',image:Buffer.from('two')});await delay(1);reporters[0]({phase:'ocr',...forbidden});
 const late=sent.at(-1);assert.equal(late.id,'first-id');assert.equal(late.diagnostic.mallocArenaMax,2);assert.equal(late.diagnostic.allocatorOverridePresent,true);
 assert.ok(!JSON.stringify(sent).includes('/secret/allocator'));assert.ok(!Object.keys(forbidden).some(key=>key in late.diagnostic));
 assert.deepEqual(sent.filter(x=>x.type==='memory').map(x=>x.id),['first-id','second-id']);
 assert.equal(limits.maxRssBytes,384*1024*1024);assert.equal(limits.labelTimeoutMs,24000);assert.equal(limits.barcodeTimeoutMs,8000);assert.equal(limits.heapMb,128);
 console.log('PASS real worker wrapper snapshots IPC context per invocation; allocator value is boolean only; unchanged production timeout/RSS/heap limits');
})().catch(e=>{console.error(e);process.exitCode=1;});
