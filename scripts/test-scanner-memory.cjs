'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),path=require('node:path');
const source=file=>fs.readFileSync(path.join(__dirname,'../public',file),'utf8');
const clone=x=>structuredClone(x),settle=()=>new Promise(setImmediate);
// An isolated IDB protocol harness counts photo reads. No user database/browser.
function idb(){
 const data={events:new Map(),photos:new Map()},gets=[];
 const db={objectStoreNames:{contains:()=>true},close(){},transaction(){
  const tx={pending:0,abort(){tx.onabort?.();},objectStore(name){return {
   getAll(){return run(()=>[...data[name].values()].map(clone));},
   get(key){if(name==='photos')gets.push(key);return run(()=>clone(data[name].get(key)));},
   put(row){return run(()=>{data[name].set(name==='photos'?row.ref:row.key,clone(row));});}
  };}};
  function run(fn){const req={};tx.pending++;setImmediate(()=>{try{req.result=fn();req.onsuccess?.();}catch(e){req.error=e;req.onerror?.();tx.onerror?.();}finally{tx.pending--;setImmediate(()=>{if(!tx.pending&&!tx.finished){tx.finished=true;tx.oncomplete?.();}});}});return req;}
  return tx;
 }};
 return {data,gets,open(){const req={};setImmediate(()=>{req.result=db;req.onsuccess?.();});return req;}};
}
function local(){const m=new Map();return {get length(){return m.size},key:i=>[...m.keys()][i],getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};}
(async()=>{
 const indexed=idb(),root={crypto:crypto.webcrypto,TextEncoder,localStorage:local(),indexedDB:indexed};
 vm.runInNewContext(source('scanner-photo-storage.js'),{window:root,setTimeout,clearTimeout,TextEncoder,Uint8Array});
 const storage=root.ScannerPhotoStorage.create(),originals=[];
 for(let i=0;i<80;i++){const row={clientScanId:'piece-'+i,roundId:'round',ean:'0196989405971',photoRevision:1,b64:'data:image/jpeg;base64,'+Buffer.from('original-'+i).toString('base64')};const saved=await storage.append(storage.identity(row),row);originals.push(saved);}
 const thin=await storage.read({includeImages:false});assert.equal(thin.length,80);assert.equal(indexed.gets.length,0);assert.ok(thin.every(r=>r.photoRef&&!r.b64));
 for(let i=0;i<thin.length;i++)assert.equal(await storage.readPhoto(thin[i].photoRef),originals[i].b64);
 assert.equal(indexed.gets.length,80,'Only explicitly requested individual images are loaded');
 await storage.append(storage.identity(thin[0]),{photoRevision:2,b64:'data:image/jpeg;base64,TkVX'});
 assert.equal(await storage.readPhoto(originals[0].photoRef),originals[0].b64,'A recapture keeps its original');
 const fresh=root.ScannerPhotoStorage.create();const restored=await fresh.read({includeImages:false});assert.equal(restored.length,80);assert.equal(restored[0].photoRevision,2);assert.equal(indexed.data.photos.size,81);
 const prior=indexed.gets.length;const full=await fresh.read();assert.equal(full.length,80);assert.ok(full.every(r=>r.b64));assert.equal(indexed.gets.length-prior,80,'Legacy full reads retain their behavior');
 await assert.rejects(()=>storage.readPhoto('missing'),/não foi encontrada/);
 console.log('PASS: metadata-only reload reads no images; 80 originals load individually, recapture retains both revisions, missing image is an explicit error, legacy reads remain compatible.');

 const canvases=[],timers=new Map();let timer=0,fail=false;
 function canvas(w=0,h=0){const c={width:w,height:h,getContext(){return {drawImage(){},translate(){},rotate(){},getImageData(){return {data:new Uint8ClampedArray(16)}},putImageData(){}}}};canvases.push(c);return c;}
 const worker={async setParameters(){},async terminate(){},async recognize(c){assert.ok(c.width&&c.height);if(fail)throw Error('OCR synthetic failure');return {data:{text:'',confidence:0}};}};
 const win={Tesseract:{createWorker:async()=>worker},ScannerRegions:{findRegions:()=>[{x:0,y:0,width:100,height:50,kind:'label'}],normalizePixels(){}}};
 const context={window:win,document:{createElement:()=>canvas()},Image:class {naturalWidth=600;naturalHeight=900;set src(value){if(value)setImmediate(()=>this.onload?.());}},URL,AbortController,Promise,console,
  setTimeout(fn,ms){const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(source('scanner-ocr.js'),context);
 for(let i=0;i<5;i++){await win.ScannerOCR.recognize('data:image/jpeg;base64,TEST');assert.ok(canvases.every(c=>c.width===0&&c.height===0),'Every internally owned canvas is released after OCR');}
 const borrowed=canvas(600,900);await win.ScannerOCR.recognize(borrowed);assert.equal(borrowed.width,600,'Caller-owned frame stays available');borrowed.width=0;borrowed.height=0;
 fail=true;await assert.rejects(()=>win.ScannerOCR.recognize('data:image/jpeg;base64,TEST'),/synthetic/);assert.ok(canvases.every(c=>!c.width&&!c.height));
 console.log('PASS: repeated OCR releases every owned crop, rotation and decoded image on success and failure while preserving borrowed input frames.');

 const auto=require('../public/scanner-auto.js');let n=0,frame;
 const scanner=auto.create({snapshot:()=>frame={width:100,height:200},decode:async()=>{n++;if(n===2)throw Error('decode');return '';},recognizeMissing:false,releaseSnapshots:true,canRead:()=>true,onHint(){},onCapture(){}});
 for(let i=0;i<100;i++){await scanner.tick();assert.equal(frame.width,0);assert.equal(frame.height,0);}
 console.log('PASS: 100 inventory camera snapshots release their backing dimensions after decoding, including decode failure.');
})().catch(e=>{console.error(e);process.exitCode=1;});
