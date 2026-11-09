'use strict';
// Execute the real queue, capture, rendering and upload functions in an isolated
// DOM/storage/HTTP harness. No browser account, camera or production endpoint.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{randomUUID}=require('node:crypto');
const html=fs.readFileSync(require('node:path').join(__dirname,'../public/bipar.html'),'utf8');
const source=html.slice(html.indexOf('  function etiqIdentity('),html.indexOf('  const etiqRestorePromise ='))+
 html.slice(html.indexOf('  function etiqPhotoDurable('),html.indexOf('  let etiqStatusOffset ='));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
const copy=x=>JSON.parse(JSON.stringify(x)),rows=new Map(),nodes=new Map(),uploads=[],ocr=[],timers=new Map();
let holdCommit=null,failCommit=false,timerId=0,frame='first-frame';
function node(id){if(!nodes.has(id))nodes.set(id,{id,value:id==='loja'?'store-a':id==='vendedor'?'seller-a':'',style:{},textContent:'',setAttribute(){},insertBefore(){},videoWidth:800,videoHeight:1200});return nodes.get(id);}
const ctx={window:{BiparActions:{isInventory:()=>true,version:()=>1},ScannerRound:{requireRound:()=> 'round-a',id:()=> 'round-a'},ScannerTransfer:{start(){},update(){},activity(){}},ScannerOCR:{readForScan(){const d=deferred();ocr.push(d);return d.promise;}}},
 document:{getElementById:node,createElement:()=>({getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/jpeg;base64,'+Buffer.from(frame).toString('base64')})},
 localStorage:{getItem:()=> 'Operador A'},STORAGE_VENDNAME:'operator',genClientScanId:randomUUID,
 etiqFila:[],etiqPendingFrames:[],etiqAutoFrames:new Map(),etiqStorageReady:true,etiqStorageFailed:false,etiqRestorePromise:Promise.resolve(),
 etiqPausado:false,etiqLeituraArmada:true,etiqAtivo:null,etiqCameraContext:null,etiqRetryAt:0,etiqIgnoredCode:'',etiqIgnoreUntil:0,etiqWatch:null,etiqUltimo:'',etiqUltimoTs:0,etiqBusy:false,
 etiqAuto:{stop(){},reset(){}},etiqBeep(){},etiqStorageNotice(){},renderEtiqLista(){},renderLista(){},alert(){},console,
 etiqPhotoStorage:{async migrateLegacy(){},async read(){return [...rows.values()].map(copy);},async append(id,fields){if(holdCommit)await holdCommit.promise;if(failCommit)throw Error('local quota');const next={...rows.get(id),...copy(fields)};if(fields.b64)next.photoRef='photo:'+fields.photoRevision+':'+fields.b64;rows.set(id,next);return copy(next);}},
 fetch:async image=>({blob:async()=>new Blob([Buffer.from(image.split(',')[1],'base64')],{type:'image/jpeg'})}),
 stocktakeFetch:async(url,options)=>{assert.equal(url,'/api/stocktake/etiqueta');const d=deferred();uploads.push({url,form:options.body,reply:d});return d.promise;},
 setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},setInterval(){return 0;},clearInterval(){},
 Blob,FormData,AbortController,Map,Promise,JSON,Date,Number,String,Object};
vm.createContext(ctx);vm.runInContext(source,ctx);
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
const capture=code=>ctx.window.capturaAutomatica({ean:code,frame:{width:800,height:1200}});
(async()=>{
 holdCommit=deferred();capture('0196989405971');await settle();const first=ctx.etiqFila[0];assert.ok(first);
 assert.equal(node('etiq-confirm-btn').hidden,false);assert.equal(node('etiq-confirm-btn').disabled,true);ctx.window.proximaEtiqueta();assert.equal(ctx.etiqAtivo,first.lid);assert.equal(uploads.length,0);
 holdCommit.resolve();holdCommit=null;await settle();assert.equal(uploads.length,1);assert.equal(ocr.length,1);assert.equal(first.capId,undefined);assert.equal(first.complete,false);
 assert.equal(node('etiq-confirm-btn').disabled,false);assert.match(node('etiq-confirm-btn').textContent,/PRÓXIMO/);assert.match(node('etiq-confirm-det').textContent,/segundo plano/);
 ctx.window.proximaEtiqueta();assert.equal(ctx.etiqAtivo,null);assert.equal(ctx.etiqLeituraArmada,true);assert.equal(ctx.etiqBusy,true,'The first HTTP upload is still pending');
 frame='second-physical-pair';capture(first.ean);await settle();const second=ctx.etiqFila[1];assert.ok(second);assert.notEqual(second.clientScanId,first.clientScanId);assert.notEqual(second.b64,first.b64);assert.equal(second.capId,undefined);assert.equal(node('etiq-confirm-btn').disabled,false);
 assert.equal(rows.size,2,'Both original photos are durable before the first server response');assert.equal(uploads.length,1,'One upload does not block capturing the second pair');
 ocr[0].resolve('OCR ONLY FOR FIRST PIECE');await settle();assert.equal(first.ocrText,'OCR ONLY FOR FIRST PIECE');assert.equal(second.ocrText,'');assert.equal(ctx.etiqAtivo,second.lid);
 uploads[0].reply.resolve({ok:true,status:200,json:async()=>({capId:'cap-first',bipeId:'bipe-first',photoSaved:true,photoRevision:1,found:true})});await settle();assert.equal(first.capId,'cap-first');assert.equal(second.capId,undefined);assert.equal(ctx.etiqAtivo,second.lid);assert.equal(node('etiq-confirm-btn').disabled,false);
 ctx.window.proximaEtiqueta();assert.equal(ctx.etiqAtivo,null);failCommit=true;frame='unsaved-third';capture('5901234123457');await settle();const third=ctx.etiqFila[2];assert.equal(ctx.etiqStorageFailed,true);assert.equal(rows.size,2);assert.equal(node('etiq-confirm-btn').disabled,true);ctx.window.proximaEtiqueta();assert.equal(ctx.etiqAtivo,third.lid);
 failCommit=false;await ctx.etiqSave();assert.equal(ctx.etiqStorageFailed,false);assert.equal(rows.size,3);assert.equal(node('etiq-confirm-btn').disabled,false);assert.equal(ctx.etiqFila.length,3,'Storage retry preserves the same three pieces');
 const restored=[...rows.values()];assert.equal(restored[0].ean,first.ean);assert.equal(restored[1].ean,second.ean);assert.equal(new Set(restored.map(r=>r.clientScanId)).size,3);
 console.log('PASS: Next appears after local commit while upload/OCR are held; identical next pair has its own photo/ID; late results only affect the original; failed storage blocks Next and retry preserves all pieces.');
})().catch(e=>{console.error(e);process.exitCode=1});
