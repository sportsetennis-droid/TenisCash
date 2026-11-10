'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {decodeFullFramePixels}=require('../public/scanner-auto');
const normalizePixels=require('../public/scanner-regions').normalizePixels;
const policy=require('../public/scanner-barcode-policy');
const A='7909701921191',B='4065426038538';
function bars(width,height,rects){
 const data=new Uint8ClampedArray(width*height*4).fill(255);
 for(const r of rects)for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++)if(Math.floor((x-r.x)/4)%2===0){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
 return {width,height,data};
}
async function run(image,answers){
 const calls=[],original=Buffer.from(image.data);
 const result=await decodeFullFramePixels(image,{normalizePixels,readBarcodes:async(pixels)=>{calls.push({width:pixels.width,height:pixels.height});return (answers[calls.length-1]||[]).map(text=>({text}));}});
 assert.deepEqual(Buffer.from(image.data),original,'Full-frame recovery does not mutate original pixels');
 assert.deepEqual(calls[0],{width:image.width,height:image.height},'First read receives the entire original, including the edges');
 return {result,calls};
}
function engine(answers,fullFrameResult){
 let readCalls=0,recoverCalls=0;const raw=Buffer.alloc(16);
 const sharp=()=>({ensureAlpha(){return this;},raw(){return this;},rotate(){return this;},resize(){return this;},grayscale(){return this;},normalize(){return this;},png(){return this;},async toBuffer(options){return options?{data:raw,info:{width:2,height:2}}:Buffer.from('fallback');}});
 const decoder={prepareZXingModule(){},async readBarcodes(){return (answers[readCalls++]||[]).map(text=>({text}));}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/services/scannerBarcodeEngine.js'),'utf8'),{module,Buffer,Uint8ClampedArray,__dirname:path.join(__dirname,'../src/services'),require(name){
  if(name==='sharp')return sharp;
  if(name==='node:fs')return {readFileSync:()=>Buffer.from('wasm')};
  if(name==='zxing-wasm/reader')return decoder;
  if(name==='../../public/scanner-barcode-policy')return policy;
  if(name==='../../public/scanner-regions')return {normalizePixels};
  if(name==='../../public/scanner-auto')return {async decodeFullFramePixels(image,deps){recoverCalls++;assert.equal(readCalls,2,'Only two empty baseline attempts can start recovery');await deps.readBarcodes(image,{});return fullFrameResult;}};
  return require(name);
 }});
 return {decode:()=>module.exports.decode(Buffer.from('original')),stats:()=>({readCalls,recoverCalls})};
}
(async()=>{
 const two=bars(1000,800,[{x:24,y:80,w:200,h:64},{x:700,y:630,w:200,h:64}]);
 let test=await run(two,[[],[A],[A],[B],[B]]);
 assert.equal(test.calls.length,5,'Both candidate regions are examined in color and normalized pixels');
 assert.deepEqual(test.result,{code:'',ambiguous:true},'A second barcode at the edge keeps the whole frame ambiguous');
 test=await run(two,[[],[A],[A],[A],[A]]);
 assert.deepEqual(test.result,{code:A,ambiguous:false},'Duplicate reads of the same code remain one identifier');
 const many=bars(1800,1800,Array.from({length:13},(_,i)=>({x:40+(i%4)*420,y:40+Math.floor(i/4)*420,w:240,h:80})));
 test=await run(many,[[A]]);assert.deepEqual(test.result,{code:'',ambiguous:false});assert.equal(test.calls.length,1,'Too many candidates cannot silently discard a second label and accept the first');
 const large=bars(2000,1500,[{x:100,y:80,w:600,h:280},{x:1100,y:850,w:600,h:280}]);
 test=await run(large,[[],[A],[A],[],[]]);
 assert.equal(test.calls.length,5,'Both regions are inspected before the unresolved-region recovery budget is rejected');
 assert.deepEqual(test.result,{code:'',ambiguous:false},'A recovered first barcode cannot survive an exhausted budget for the second candidate');
 const initialBudget=bars(2000,1500,[{x:60,y:60,w:500,h:200},{x:750,y:60,w:500,h:200},{x:1400,y:60,w:500,h:200},{x:750,y:850,w:500,h:200}]);
 test=await run(initialBudget,[[A]]);assert.deepEqual(test.result,{code:'',ambiguous:false});assert.equal(test.calls.length,1,'Initial candidate pixel budget refuses all work instead of dropping a candidate');
 await assert.rejects(decodeFullFramePixels({width:100,height:100,data:new Uint8ClampedArray(4)},{readBarcodes:()=>{throw Error('must not decode');}}),/Quadro/);
 for(const codes of [[A],[A,B]]){const item=engine([codes],{code:''});assert.deepEqual(Array.from(await item.decode()),codes);assert.equal(item.stats().recoverCalls,0,'Existing original results and conflicts do not enter recovery');}
 {const item=engine([[],[A]],{code:''});assert.deepEqual(Array.from(await item.decode()),[A]);assert.equal(item.stats().recoverCalls,0,'Existing fallback result is retained');}
 {const item=engine([[],[],[A]],{code:A,ambiguous:false});assert.deepEqual(Array.from(await item.decode()),[A]);assert.equal(item.stats().recoverCalls,1);}
 {const item=engine([[],[],[A,B]],{code:'',ambiguous:true});assert.deepEqual(Array.from(await item.decode()),[A,B],'Engine preserves every conflicting decoded identifier');}
 {const item=engine([[],[],[A]],{code:'',ambiguous:false});assert.deepEqual(Array.from(await item.decode()),[],'Engine discards partial codes when recovery is incomplete or over budget');}
 console.log('PASS: full archived frame, all candidate regions, second-code conflicts, candidate/pixel/recovery budgets, immutable originals, and engine empty-only fallback.');
})().catch(error=>{console.error(error);process.exitCode=1;});
