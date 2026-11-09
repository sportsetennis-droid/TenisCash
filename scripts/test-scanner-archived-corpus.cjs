'use strict';
// Optional local corpus diagnostic. Images/manifests are never embedded in Git.
// Usage: node scripts/test-scanner-archived-corpus.cjs manifest.json output.json
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const reader=require('../src/services/scannerArchivedLabel'),broker=require('../src/services/scannerImageBroker');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const manifestPath=path.resolve(process.argv[2]||''),output=process.argv[3]&&path.resolve(process.argv[3]);
 if(!output||!fs.statSync(manifestPath).isFile())throw Error('Supply a real manifest and local output path');
 const input=JSON.parse(fs.readFileSync(manifestPath,'utf8').replace(/^\uFEFF/,''));
 const report={at:new Date().toISOString(),localOnly:true,stockChanged:false,node:process.version,
  dependencies:{sharp:require('sharp').versions.sharp,zxing:JSON.parse(fs.readFileSync(path.join(__dirname,'../node_modules/zxing-wasm/package.json'))).version,tesseract:require('tesseract.js/package.json').version},
  limits:broker.limits,results:[]};
 let last=Date.now(),maxGapMs=0;const heartbeat=setInterval(()=>{const now=Date.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;},20);
 try{
  for(const row of input.manifest){
   const file=path.resolve(path.dirname(manifestPath),row.file);assert.equal(path.dirname(file),path.dirname(manifestPath));
   const image=fs.readFileSync(file);assert.equal(createHash('sha256').update(image).digest('hex'),row.sha256);
   for(let i=0;broker.getStatus().stopping&&i<500;i++)await delay(10);
   const start=Date.now(),result=await reader.readImage(image,row.barcode);
   report.results.push({captureId:row.id,file:row.file,barcode:row.barcode,sha256:row.sha256,ms:Date.now()-start,result,process:broker.getStatus()});
   report.maxParentHeartbeatGapMs=maxGapMs;
   fs.writeFileSync(output,JSON.stringify(report,null,2));
   console.log(JSON.stringify({file:row.file,ms:Date.now()-start,reason:result.reason||'literal_size_and_reference_candidates',size:result.size||null,rss:broker.getStatus().rss}));
  }
 }finally{clearInterval(heartbeat);await broker.shutdown();}
 report.finishedAt=new Date().toISOString();report.maxParentHeartbeatGapMs=maxGapMs;fs.writeFileSync(output,JSON.stringify(report,null,2));
 console.log('Corpus complete; extraction is not identity validation or stock application. Parent max heartbeat gap(ms): '+maxGapMs);
})().catch(async error=>{console.error(error);await broker.shutdown();process.exitCode=1;});
