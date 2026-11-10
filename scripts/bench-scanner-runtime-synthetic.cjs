'use strict';
// Experimental branch only. Generates synthetic labels; never reads user photos.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{fork}=require('node:child_process'),{createHash}=require('node:crypto');
const {createBroker,limits}=require('../src/services/scannerImageBroker');
const {generateFixtures}=require('./fixtures/scanner-runtime-synthetic.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),out=path.resolve(process.env.SCANNER_BENCH_OUTPUT||'artifacts/scanner-runtime-synthetic');
const workload=process.argv[2]||'all';if(!['all','positive','stress'].includes(workload))throw Error('Invalid synthetic workload');
if(process.env.CI){assert.equal(process.platform,'linux');assert.equal(process.versions.node,'22.14.0');}
const originalArena=process.env.MALLOC_ARENA_MAX;
if(originalArena!==undefined&&!/^[1-9]\d{0,2}$/.test(originalArena))throw Error('Unsupported original allocator setting');
if(Number(originalArena)===2)throw Error('Inconclusive A/B: original environment already uses two arenas');
fs.mkdirSync(out,{recursive:true});
const sourceFiles=['src/services/scannerImageWorker.js','src/services/scannerImageBroker.js','src/services/scannerImageProcessor.js','src/services/scannerBarcodeEngine.js','src/services/scannerArchivedLabel.js','src/services/scannerRuntimeDiagnostic.js','scripts/fixtures/scanner-runtime-bench-worker.cjs','scripts/fixtures/scanner-runtime-synthetic.cjs','scripts/fixtures/tesseract-clear-worker.cjs'];
const report={source:'synthetic-runtime-abba-v1',startedAt:new Date().toISOString(),privatePhotos:false,productionDatabase:false,limits,sequence:['A','B','B','A'],additionalScenarios:['C','C'],
 sourceHashes:Object.fromEntries(sourceFiles.map(p=>[p,hash(fs.readFileSync(path.join(__dirname,'..',p)))])),fixtures:[],runs:[]};
function save(){fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));}
async function one(fixture,mode,ordinal){
 const trace=[],passes=[],started=Date.now();let header,pid,live=0,maxLive=0,lastPhase,peak=0;
 const env={...process.env};if(mode==='B')env.MALLOC_ARENA_MAX='2';
 if(mode==='C')env.SCANNER_SYNTHETIC_CLEAR='1';else delete env.SCANNER_SYNTHETIC_CLEAR;
 const broker=createBroker({spawn(){
  const child=fork(path.join(__dirname,'fixtures/scanner-runtime-bench-worker.cjs'),[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',windowsHide:true,
   execArgv:['--max-old-space-size='+limits.heapMb],env});pid=child.pid;live++;maxLive=Math.max(maxLive,live);child.once('exit',()=>live--);
  child.on('message',m=>{
   if(m.type==='bench:header')header=m;
   if(m.type==='diagnostic'){lastPhase=m.diagnostic;peak=Math.max(peak,m.diagnostic?.rssBytes||0);trace.push({type:'phase',atMs:Date.now()-started,...m.diagnostic});}
   if(m.type==='memory'){peak=Math.max(peak,m.rss||0);trace.push({type:'sample',atMs:Date.now()-started,rssBytes:m.rss,phase:lastPhase?.phase,pass:lastPhase?.pass});}
   if(m.type==='bench:pass-start'||m.type==='bench:pass-result'){const {id,...row}=m;passes.push(row);if(m.rss)peak=Math.max(peak,m.rss);}
   assert.ok(trace.length<1000&&passes.length<100,'Bounded synthetic telemetry');
  });return child;
 }});
 let result,error;
 try{result=await broker.run('label',fixture.buffer,fixture.barcode);}
 catch(e){error={code:e.code,diagnostic:e.scannerDiagnostic};if(!['SCANNER_IMAGE_MEMORY_LIMIT','SCANNER_IMAGE_TIMEOUT'].includes(e.code))throw e;}
 finally{await broker.shutdown();}
 assert.equal(live,0);assert.equal(maxLive,1);assert.equal(hash(fixture.buffer),fixture.sha256,'Fixture bytes unchanged');
 assert.ok(header?.runtime,'Worker runtime header required');
 assert.equal(header.runtime.sharp,'0.35.5');assert.equal(header.runtime.vips,'8.18.7');assert.equal(header.runtime.tesseract,'7.0.0');
 if(process.env.CI)assert.ok(/^\d+\.\d+$/.test(header.runtime.glibcVersionRuntime||''),'Linux glibc version required');
 assert.equal(header.runtime.mallocArenaMax,mode==='B'?2:originalArena===undefined?null:Number(originalArena));
 assert.equal(header.clearBeforeImage,mode==='C');
 const row={fixture:fixture.name,mode,ordinal,pid,coldProcess:true,elapsedMs:Date.now()-started,peakRssObservedBytes:peak,header:header?{runtime:header.runtime,cache:header.cache,sharpConcurrency:header.sharpConcurrency,clearBeforeImage:header.clearBeforeImage}:null,
  result:result||null,error:error||null,trace,passes};
 report.runs.push(row);save();console.log(JSON.stringify({fixture:row.fixture,mode,ordinal,elapsedMs:row.elapsedMs,peakMiB:peak/1024**2,
  completedPasses:passes.filter(x=>x.type==='bench:pass-result').length,result:row.result,error:row.error}));return row;
}
(async()=>{
 assert.equal(limits.maxRssBytes,384*1024**2);assert.equal(limits.labelTimeoutMs,24000);assert.equal(limits.heapMb,128);
 const fixtures=(await generateFixtures()).filter(f=>workload==='all'||f.name===workload);
 for(const fixture of fixtures){fixture.sha256=hash(fixture.buffer);report.fixtures.push({name:fixture.name,sha256:fixture.sha256,bytes:fixture.buffer.length,width:1800,height:1013,expected:fixture.expected});
  fs.writeFileSync(path.join(out,fixture.name+'.png'),fixture.buffer);
  const runs=[];for(const [i,mode]of [...report.sequence,...report.additionalScenarios].entries())runs.push(await one(fixture,mode,i+1));
  const successful=runs.filter(r=>!r.error);
  if(fixture.name==='positive'){assert.equal(successful.length,runs.length,'Positive control must complete in all scenarios');for(const r of successful){assert.equal(r.result.size,fixture.expected.size);assert.ok(r.result.references.includes(fixture.expected.reference));}}
  if(fixture.name==='stress')for(const r of successful){assert.equal(r.result.pending,true);assert.equal(r.passes.filter(x=>x.type==='bench:pass-result').length,16,'Missing BR must traverse all16passes without parser stubs');}
  const hashes=runs.map(r=>r.passes.filter(p=>p.type==='bench:pass-result').map(p=>({pass:p.pass,inputSha256:p.inputSha256,ocrSha256:p.ocrSha256})));
  const compared=Math.min(...hashes.map(h=>h.length));for(let i=1;i<hashes.length;i++)assert.deepEqual(hashes[i].slice(0,compared),hashes[0].slice(0,compared),'Common completed pass inputs/text/confidence/boxes must match');
  if(successful.length>1)for(let i=1;i<successful.length;i++)assert.deepEqual(successful[i].result,successful[0].result,'Same synthetic identity result');
  report.fixtures.at(-1).comparison={commonCompletedPasses:compared,hashesIdentical:compared>0?true:null,inconclusive:compared===0,successfulRuns:successful.length};save();
 }
 report.completedAt=new Date().toISOString();report.status='complete';save();
})().catch(e=>{report.status='failed';report.failure=String(e.message).slice(0,800);save();console.error(e);process.exitCode=1;});
