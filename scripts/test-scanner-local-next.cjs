'use strict';
// Execute the real queue, capture, rendering and upload functions in an isolated
// DOM/storage/HTTP harness. No browser account, camera or production endpoint.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{randomUUID,createHash}=require('node:crypto');
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
 etiqPhotoStorage:{async migrateLegacy(){},async read(options={}){return [...rows.values()].map(row=>{const value={...row};if(options.includeImages===false)delete value.b64;return copy(value);});},async readPhoto(ref){const row=[...rows.values()].find(row=>row.photoRef===ref);assert.ok(row);return row.b64;},async append(id,fields){if(holdCommit)await holdCommit.promise;if(failCommit)throw Error('local quota');const next={...rows.get(id),...copy(fields)};if(fields.b64)next.photoRef='photo:'+fields.photoRevision+':'+createHash('sha256').update(fields.b64).digest('hex');rows.set(id,next);return copy(next);}},
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
 ctx.etiqAtivo=second.lid;
 const pendingUpload=ctx.enviarFila();await settle();assert.equal(uploads.length,2);assert.equal(uploads[1].form.get('clientScanId'),second.clientScanId,'The first unattempted piece gets its turn');
 uploads[1].reply.resolve({ok:true,status:200,json:async()=>({capId:'cap-second',photoSaved:true,photoRevision:1,pending:true})});await pendingUpload;await settle();
 assert.equal(second.st,'fila');assert.ok(ctx.enviarFila.attempts.get(ctx.etiqIdentity(second)).retryAt>Date.now());
 const thirdUpload=ctx.enviarFila();await settle();assert.equal(uploads.length,3);assert.equal(uploads[2].form.get('clientScanId'),third.clientScanId,'A pending active piece cannot starve another saved original');
 uploads[2].reply.resolve({ok:true,status:200,json:async()=>({capId:'cap-third',bipeId:'bipe-third',photoSaved:true,photoRevision:1})});await thirdUpload;await settle();
 const enrichedFirst=ctx.enviarFila();await settle();assert.equal(uploads.length,4);assert.equal(uploads[3].form.get('clientScanId'),first.clientScanId);
 uploads[3].reply.resolve({ok:true,status:200,json:async()=>({capId:'cap-first',bipeId:'bipe-first',photoSaved:true,photoRevision:1})});await enrichedFirst;await settle();
 await ctx.enviarFila();assert.equal(uploads.length,4,'The failed piece respects its own backoff without a tight retry loop');
 ctx.enviarFila.attempts.get(ctx.etiqIdentity(second)).retryAt=0;
 const recoveredSecond=ctx.enviarFila();await settle();assert.equal(uploads.length,5);assert.equal(uploads[4].form.get('clientScanId'),second.clientScanId);assert.equal(uploads[4].form.get('roundId'),second.roundId);
 assert.equal(await uploads[4].form.get('file').text(),'second-physical-pair','Retry sends the original image for this same physical piece');
 uploads[4].reply.resolve({ok:true,status:200,json:async()=>({capId:'cap-second',bipeId:'bipe-second',photoSaved:true,photoRevision:1})});await recoveredSecond;await settle();
 assert.equal(second.bipeId,'bipe-second');assert.equal(ctx.etiqFila.length,3);
 second.st='revisao';second.complete=false;second.repeatCancelPending=true;ctx.renderEtiqCaptureState();
 assert.equal(node('etiq-confirm-btn').disabled,true);ctx.window.proximaEtiqueta();assert.equal(ctx.etiqAtivo,second.lid,'Cancellation awaiting ACK does not advance');
 second.excluded=true;second.repeatCancelPending=false;await ctx.etiqSave();ctx.renderEtiqCaptureState();
 assert.equal(node('etiq-confirm-btn').disabled,false);assert.match(node('etiq-confirm-status').textContent,/NÃO CONTADA/);
 assert.equal(ctx.capturarFrame(second.ean,{width:800,height:1200},true),null,'An excluded original cannot be recaptured/resurrected');
 ctx.window.proximaEtiqueta();assert.equal(ctx.etiqAtivo,null);assert.equal(ctx.etiqFila.length,3,'Confirmed cancellation permits manual Next without counting');
 console.log('PASS: one outbox sends all saved pieces fairly; a pending active piece backs off independently and retries the same ID/photo without blocking the other pairs.');
 ctx.etiqBusy=true; // Simulate a slow server for the entire burst, no uploads ACKed.
 for(let i=0;i<200;i++){
   ctx.window.proximaEtiqueta();frame='physical-'+i+'-'+('a'.repeat(128000));capture('0196989405971');await settle();
   assert.equal(ctx.etiqFila.length,4+i);assert.equal(node('etiq-confirm-btn').disabled,false);
   assert.ok(ctx.etiqFila.filter(row=>row.b64).length<=1,'Only the current preview retains an in-memory image');
   assert.equal([...ctx.etiqSave.baseline.values()].filter(row=>row.b64).length,0,'Checkpoint metadata does not duplicate original images');
 }
 ctx.window.proximaEtiqueta();assert.equal(ctx.etiqFila.filter(row=>row.b64).length,0);assert.equal(rows.size,203);
 assert.ok(JSON.stringify(ctx.etiqFila).length<200000,'The live queue stays small even with over 34 MB of original photos on disk');
 const reloaded=await ctx.etiqPhotoStorage.read({includeImages:false});assert.equal(reloaded.length,203);assert.equal(reloaded.filter(row=>row.b64).length,0);
 for(const row of reloaded){assert.equal(await ctx.etiqReadPhoto(row),rows.get('id:'+row.roundId+':'+row.clientScanId).b64,'Each archived original is still individually available after reload');}
 const remote=ctx.etiqFila[0],oldRef=remote.photoRef;remote.b64=await ctx.etiqReadPhoto(remote);
 ctx.etiqMergeStored([{...ctx.etiqSave.baseline.get(ctx.etiqIdentity(remote)),photoRef:'new-other-tab-image',photoRevision:remote.photoRevision+1}]);
 assert.notEqual(remote.photoRef,oldRef);assert.equal(remote.b64,undefined,'Another tab revision cannot retain a stale image with the new revision');
 console.log('PASS: 200 additional captures during a stalled upload retain only the current image in the live queue, no images in checkpoints, and all 203 exact originals/IDs survive metadata-only reload.');
 console.log('PASS: Next appears after local commit while upload/OCR are held; identical next pair has its own photo/ID; late results only affect the original; failed storage blocks Next and retry preserves all pieces.');
})().catch(e=>{console.error(e);process.exitCode=1});
