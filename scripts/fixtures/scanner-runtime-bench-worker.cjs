'use strict';
// Test-only wrapper around the production processor. No database or HTTP.
if(typeof process.send!=='function')throw Error('IPC required');
const {createHash}=require('node:crypto'),path=require('node:path'),sharp=require('sharp'),tesseract=require('tesseract.js');
const clearBeforeImage=process.env.SCANNER_SYNTHETIC_CLEAR==='1';
sharp.concurrency(1);sharp.cache({memory:16,files:0,items:16});
const diagnostic=require('../../src/services/scannerRuntimeDiagnostic');
const runtime={platform:process.platform,arch:process.arch,node:process.versions.node,sharp:sharp.versions.sharp,vips:sharp.versions.vips,tesseract:require('tesseract.js/package.json').version,
 mallocArenaMax:Number(process.env.MALLOC_ARENA_MAX),allocatorOverridePresent:!!process.env.LD_PRELOAD};
let busy=false,activeId=null,startedAt=0,pass=0;
const send=message=>{if(process.connected)process.send(message,error=>{if(error)process.exit(1);});};
const memory=()=>{if(activeId)send({type:'memory',id:activeId,rss:process.memoryUsage().rss});};
setInterval(memory,250).unref();
// Stream the existing object without retaining another full OCR JSON string.
function objectHash(value){const hash=createHash('sha256');function visit(v){
 if(v===null||typeof v!=='object'){hash.update(JSON.stringify(v)??'undefined');return;}
 if(Array.isArray(v)){hash.update('[');for(const x of v){visit(x);hash.update(',');}hash.update(']');return;}
 hash.update('{');for(const key of Object.keys(v).sort()){hash.update(JSON.stringify(key)+':');visit(v[key]);hash.update(',');}hash.update('}');
 }visit(value);return hash.digest('hex');}
const processor=require('../../src/services/scannerImageProcessor').createProcessor({createWorker:async(...args)=>{
 if(clearBeforeImage)args[2]={...args[2],workerPath:path.join(__dirname,'tesseract-clear-worker.cjs')};
 const actual=await tesseract.createWorker(...args);
 return {...actual,recognize:async(...recognizeArgs)=>{
  const bytes=recognizeArgs[0];if(!Buffer.isBuffer(bytes))throw Error('Expected original processor Buffer');
  const ordinal=++pass,inputSha256=createHash('sha256').update(bytes).digest('hex');
  send({type:'bench:pass-start',id:activeId,pass:ordinal,inputSha256,elapsedMs:Date.now()-startedAt});
  const result=await actual.recognize(...recognizeArgs),data=result.data;
  send({type:'bench:pass-result',id:activeId,pass:ordinal,inputSha256,ocrSha256:objectHash({text:data.text,confidence:data.confidence,blocks:data.blocks}),
   elapsedMs:Date.now()-startedAt,rss:process.memoryUsage().rss});return result;
 }};
}});
process.on('disconnect',()=>process.exit(0));
process.on('message',async message=>{
 if(!message||message.type!=='run'||busy||message.kind!=='label'||typeof message.id!=='string'||!Buffer.isBuffer(message.image)||!message.image.length||message.image.length>12*1024*1024){process.exit(1);return;}
 busy=true;activeId=message.id;startedAt=Date.now();pass=0;const id=message.id;
 const report=fields=>send({type:'diagnostic',id,diagnostic:diagnostic.sanitize({source:diagnostic.SOURCE,...runtime,...fields,phaseElapsedMs:Date.now()-startedAt,rssBytes:process.memoryUsage().rss})});
 try{
  const header=process.report.getReport().header;
  send({type:'bench:header',id,clearBeforeImage,runtime:{...runtime,mallocArenaMax:Number.isInteger(runtime.mallocArenaMax)&&runtime.mallocArenaMax>0?runtime.mallocArenaMax:null,
   glibcVersionRuntime:header.glibcVersionRuntime||null,glibcVersionCompiler:header.glibcVersionCompiler||null},cache:{memory:16,files:0,items:16},sharpConcurrency:1});
  report({phase:'starting'});const result=await processor.run(message.kind,message.image,message.barcode,report);
  memory();send({type:'result',id,result});
 }catch(_){send({type:'failure',id});setImmediate(()=>process.exit(1));}
 finally{busy=false;activeId=null;}
});
send({type:'ready'});
