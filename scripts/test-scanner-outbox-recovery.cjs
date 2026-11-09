'use strict';
// Actual recovery/upload/auth-gate functions in an isolated VM. No browser,
// production endpoint, real camera, account mutation, or replacement round.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../public/bipar.html'),'utf8');
const actions=fs.readFileSync(path.join(__dirname,'../public/bipar-actions.js'),'utf8');
const identity=html.slice(html.indexOf('  function etiqIdentity('),html.indexOf('  function etiqCopy('));
const queue=html.slice(html.indexOf('  const etiqRejectedAuthorizations'),html.indexOf('  let etiqStatusOffset'));
const recovery=html.slice(html.indexOf('  async function resumeInventoryOutbox()'),html.indexOf('  carregarLojas();',html.indexOf('  async function resumeInventoryOutbox()')));
const auth=actions.slice(actions.indexOf('  function canUploadStocktake('),actions.indexOf('  async function authenticate('));
const updateStatus=html.slice(html.indexOf('  function atualizarStatus()'),html.indexOf("  document.getElementById('loja').addEventListener('change'",html.indexOf('  function atualizarStatus()')));
const render=html.slice(html.indexOf('  function renderEtiqLista()'),html.indexOf('  async function excluirBipeRecente('));
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(setImmediate);};
const photo='data:image/jpeg;base64,b3JpZ2luYWw=';
function read(id='first',sellerId='operator-a'){return {lid:id,clientScanId:id,roundId:'original-round',storeId:'store-a',sellerId,sellerName:'Original operator',operationType:'replacement',st:'fila',ean:'0196989405971',photoRevision:1,photoRef:'photo-'+id,manualPhoto:true,ocrDone:true};}
function harness(rows,{authenticated=true,status=200}={}){
 const uploads=[],events={},timers=new Map(),saved=[],elements=new Map();let timer=0;
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'',classList:{add(){},remove(){}},replaceChildren(){},focus(){}});return elements.get(id);};
 const ctx={console,FormData,Blob,AbortController,Map,Promise,JSON,Date,Number,String,Object,
  action:'replacement',actor:authenticated?{id:'operator-a'}:null,token:authenticated?'token-a':'',allowed:['store-a'],
  isInventory(){return ctx.action==='replacement'||ctx.action==='inventory'},tokenSubject:t=>t==='token-a'||t==='new-token-a'?'operator-a':'operator-b',
  expireAuthentication(){ctx.expired++;ctx.actor=null;},async resumeAuthentication(){ctx.resumed++;if(ctx.recover){ctx.token='new-token-a';ctx.actor={id:'operator-a'};}},expired:0,resumed:0,recover:false,
  etiqFila:rows,etiqStorageReady:true,etiqStorageFailed:false,etiqBusy:false,etiqAtivo:null,etiqRestorePromise:Promise.resolve(),etiqAutoFrames:new Map(),
  etiqSave:async()=>{saved.push(JSON.parse(JSON.stringify(rows)));return true;},etiqReadPhoto:async()=>{await ctx.beforePhotoRead?.();return photo;},etiqStartOcr(){},etiqStartAutoOcr(){},
  renderEtiqLista(){},renderEtiqCaptureState(){},renderLista(){},consultarStatus:async()=>{ctx.statusPolls++;},statusPolls:0,
  fetch:async data=>{assert.equal(data,photo);return {blob:async()=>new Blob(['original'])};},
  stocktakeFetch:async(url,options)=>{uploads.push({url,form:options.body,authorization:ctx.token});const status=ctx.responseStatus,id=typeof options.body==='string'?JSON.parse(options.body).clientScanId:options.body.get('clientScanId');await ctx.beforeResponse?.();return {status,ok:status===200,json:async()=>status===200?{capId:'capture-'+id,bipeId:'bipe-'+id,photoSaved:true,photoRevision:1}:{error:'HTTP '+status}};},responseStatus:status,
  setTimeout(fn,ms){const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  sellers:[],stores:[],retryStorageFailed:false,STORAGE_VENDNAME:'seller-name',localStorage:{setItem(){}},Option:function(text,value){this.text=text;this.value=value;},round:null,
  window:{addEventListener:(name,fn)=>events[name]=fn},document:{hidden:false,addEventListener:(name,fn)=>events[name]=fn,getElementById:element}};
 vm.createContext(ctx);vm.runInContext(auth,ctx);
 ctx.window.ScannerRound={current:()=>ctx.round,id:()=>ctx.round?.id||null};
 ctx.window.BiparActions={isInventory:ctx.isInventory,mode:()=>ctx.action,version:()=>1,headers:()=>ctx.token?{Authorization:'Bearer '+ctx.token}:{},operator:()=>ctx.actor,replacementReady:()=>false,canUploadStocktake:ctx.canUploadStocktake,recoverStocktakeAuthentication:ctx.recoverStocktakeAuthentication};
 vm.runInContext(identity+queue+recovery+updateStatus,ctx);
 return {ctx,uploads,events,timers,saved};
}
(async()=>{
 const first=read(),foreign=read('foreign','operator-b'),h=harness([first,foreign]);await settle();
 assert.equal(h.uploads.length,1,'Reload resumes a saved original without opening camera');
 for(const [key,value]of Object.entries({clientScanId:'first',roundId:'original-round',storeId:'store-a',sellerId:'operator-a'}))assert.equal(h.uploads[0].form.get(key),value);
 assert.equal(await h.uploads[0].form.get('file').text(),'original');assert.equal(first.st,'salvo');assert.equal(foreign.st,'fila');assert.equal(h.ctx.etiqFila.length,2);
 assert.equal(h.ctx.etiqAtivo,null,'Recovery never selects or advances a new camera piece');
 const online=read('online');h.ctx.etiqFila.push(online);h.events.online();await settle();assert.equal(h.uploads.length,2);
 const visible=read('visible');h.ctx.etiqFila.push(visible);h.ctx.document.hidden=true;h.events.visibilitychange();await settle();assert.equal(h.uploads.length,2);
 h.ctx.document.hidden=false;h.events.visibilitychange();await settle();assert.equal(h.uploads.length,3);
 assert.equal(h.ctx.etiqFila.length,4);assert.ok(h.ctx.statusPolls>=3);

 const waiting=read('login'),a=harness([waiting],{authenticated:false});await settle();assert.equal(a.uploads.length,0);
 a.ctx.actor={id:'operator-b'};a.ctx.token='token-b';a.ctx.window.ScannerInventoryOutbox.resume();await settle();assert.equal(a.uploads.length,0,'Another verified operator cannot send the original operator reading');
 a.ctx.actor={id:'operator-a'};a.ctx.token='token-a';a.ctx.window.ScannerInventoryOutbox.resume();await settle();assert.equal(a.uploads.length,1,'Verified original identity resumes its existing queue');

 const old=read('old');delete old.operationType;const legacy=harness([old],{authenticated:false});legacy.ctx.action='inventory';await settle();assert.equal(legacy.uploads.length,0,'Legacy boot cannot assume public inventory before its original round loads');
 legacy.ctx.round={id:'another-round',storeId:'store-a',operationType:'inventory'};legacy.ctx.atualizarStatus();await settle();assert.equal(legacy.uploads.length,0,'Another round never supplies the missing original operation');
 legacy.ctx.round={id:'original-round',storeId:'another-store',operationType:'inventory'};legacy.ctx.atualizarStatus();await settle();assert.equal(legacy.uploads.length,0,'Another store never supplies the missing original operation');
 legacy.ctx.round={id:'original-round',storeId:'store-a',operationType:'replacement'};legacy.ctx.atualizarStatus();await settle();assert.equal(legacy.uploads.length,0,'Original replacement waits for verified original identity');
 legacy.ctx.actor={id:'operator-b'};legacy.ctx.token='token-b';legacy.ctx.atualizarStatus();await settle();assert.equal(legacy.uploads.length,0);
 legacy.ctx.actor={id:'operator-a'};legacy.ctx.token='token-a';legacy.ctx.atualizarStatus();await settle();assert.equal(legacy.uploads.length,1,'Round/auth status restoration wakes old reads without camera or new capture');assert.equal(old.clientScanId,'old');assert.equal(legacy.ctx.etiqAtivo,null);
 const publicRead=read('public');delete publicRead.operationType;const publicInventory=harness([publicRead],{authenticated:false});publicInventory.ctx.action='inventory';publicInventory.ctx.round={id:'original-round',storeId:'store-a',operationType:'inventory'};await settle();assert.equal(publicInventory.uploads.length,1,'Confirmed legacy public inventory keeps its original operator selection');

 const duringPhoto=harness([]);await settle();duringPhoto.ctx.etiqFila.push(read('photo-switch'));duringPhoto.ctx.beforePhotoRead=async()=>{duringPhoto.ctx.actor={id:'operator-b'};duringPhoto.ctx.token='token-b';};duringPhoto.ctx.window.ScannerInventoryOutbox.resume();await settle();assert.equal(duringPhoto.uploads.length,0,'Identity is rechecked after asynchronous photo loading');
 const late=harness([],{status:401});await settle();const lateRead=read('late-401');late.ctx.etiqFila.push(lateRead);late.ctx.beforeResponse=async()=>{late.ctx.actor={id:'operator-b'};late.ctx.token='token-b';};late.ctx.window.ScannerInventoryOutbox.resume();await settle();assert.equal(late.uploads.length,1);assert.equal(late.ctx.actor.id,'operator-b');assert.equal(late.ctx.expired,0,'Late 401 cannot expire another operator session');assert.equal(lateRead.sellerId,'operator-a');assert.equal(lateRead.authPending,true);
 const simultaneous=harness([]);await settle();simultaneous.ctx.etiqFila.push(read('single'));let release;simultaneous.ctx.beforeResponse=()=>new Promise(resolve=>{release=resolve;});simultaneous.events.online();await settle();simultaneous.events.online();simultaneous.events.visibilitychange();simultaneous.ctx.window.ScannerInventoryOutbox.resume();await settle();assert.equal(simultaneous.uploads.length,1,'Concurrent wake events keep one request in flight');release();await settle();assert.equal(simultaneous.uploads.length,1);assert.equal(simultaneous.ctx.etiqFila.length,1);

 const unauthorized=read('401'),u=harness([unauthorized],{status:401});await settle();assert.equal(u.uploads.length,1);assert.equal(unauthorized.st,'fila');assert.equal(unauthorized.authPending,true);assert.equal(unauthorized.photoRef,'photo-401');assert.equal(u.ctx.expired,1);assert.equal(u.ctx.resumed,1);
 u.events.online();await settle();assert.equal(u.uploads.length,1,'Rejected token is not retried in a tight loop');
 u.ctx.actor={id:'operator-b'};u.ctx.token='token-b';u.events.online();await settle();assert.equal(u.uploads.length,1);
 u.ctx.actor={id:'operator-a'};u.ctx.token='new-token-a';u.ctx.responseStatus=200;u.ctx.enviarFila.attempts.get(u.ctx.etiqIdentity(unauthorized)).retryAt=0;u.ctx.window.ScannerInventoryOutbox.resume();await settle();assert.equal(u.uploads.length,2);assert.equal(unauthorized.authPending,false);assert.equal(unauthorized.clientScanId,'401');assert.equal(unauthorized.bipeId,'bipe-401');
 assert.ok(u.saved.every(snapshot=>!JSON.stringify(snapshot).includes('token-')),'No authentication token is saved with photo metadata');
 const recognition=read('recognition-401');Object.assign(recognition,{manualPhoto:false,autoRecognition:true,autoRevision:1});delete recognition.photoRef;const recognitionAuth=harness([recognition],{status:401});await settle();assert.equal(recognitionAuth.uploads[0].url,'/api/stocktake/recognize');assert.equal(recognition.st,'fila');assert.equal(recognition.authPending,true);assert.equal(recognition.clientScanId,'recognition-401');

 for(const status of [400,403,409]){const row=read('review-'+status),r=harness([row],{status});await settle();assert.equal(row.st,'revisao');r.events.online();r.ctx.window.ScannerInventoryOutbox.resume();await settle();assert.equal(r.uploads.length,1,'Genuine review stays blocked: '+status);}
 const owner=harness([]);await settle();assert.equal(await owner.ctx.recoverStocktakeAuthentication('operator-b','Bearer token-a'),false);assert.equal(owner.ctx.expired,0);
 assert.equal(await owner.ctx.recoverStocktakeAuthentication('operator-a','Bearer stale-token'),false);assert.equal(owner.ctx.expired,0);
 owner.ctx.recover=true;assert.equal(await owner.ctx.recoverStocktakeAuthentication('operator-a','Bearer token-a'),true);assert.equal(owner.ctx.token,'new-token-a');assert.equal(owner.ctx.actor.id,'operator-a');
 const renderRows=[read('local'),{...read('current-photo'),capId:'cap-1',capIdPhotoRevision:1},
  {...read('photo-and-bipe'),capId:'cap-2',capIdPhotoRevision:1,bipeId:'bipe-2'},
  {...read('applied'),capId:'cap-3',capIdPhotoRevision:1,bipeId:'bipe-3',bipou:true,st:'pendente'},
  {...read('review'),capId:'cap-4',capIdPhotoRevision:1,bipeId:'bipe-4',st:'revisao'},
  {...read('size'),capId:'cap-5',capIdPhotoRevision:1,bipeId:'bipe-5',needsSize:true},
  {...read('auth'),authPending:true},{...read('old-photo'),capId:'cap-6',capIdPhotoRevision:1,photoRevision:2,bipeId:'bipe-6'},
  {...read('identified-only'),capId:'cap-7',capIdPhotoRevision:1,bipeId:'bipe-7',complete:true},
  {...read('excluded'),excluded:true,bipeId:'bipe-8',bipou:true},{...read('other-round'),roundId:'other-round',bipeId:'bipe-9',bipou:true}];
 const nodes={'etiq-contador':{textContent:''},'etiq-lista':{innerHTML:''}};
 const ui={etiqFila:renderRows,window:{ScannerRound:{id:()=> 'original-round'},BiparActions:{isInventory:()=>true,mode:()=> 'replacement'}},document:{getElementById:id=>nodes[id]},etiqPhotoDurable:()=>true};
 vm.runInNewContext(render+'\nrenderEtiqLista();',ui);
 const counted=nodes['etiq-contador'].textContent.match(/^total (\d+) · no aparelho\/aguardando envio (\d+) · recebidas\/em conferência (\d+) · aplicadas (\d+) · pendências\/erros (\d+)$/);
 assert.ok(counted);assert.deepEqual(counted.slice(1).map(Number),[9,2,3,1,3]);assert.equal(counted.slice(2).reduce((sum,n)=>sum+Number(n),0),Number(counted[1]),'Exclusive states sum to current non-excluded readings');
 assert.match(nodes['etiq-lista'].innerHTML,/ÚLTIMOS BIPES · 9/);assert.ok(renderRows.every(row=>row.ean===renderRows[0].ean),'Equal codes remain distinct physical IDs');
 assert.equal(renderRows[8].bipou,undefined,'Identification/photo receipt never invents stock application');
 ui.window.ScannerRound.id=()=>null;renderRows.push({...read('missing-round'),roundId:null});vm.runInNewContext(render+'\nrenderEtiqLista();',ui);assert.match(nodes['etiq-contador'].textContent,/^total 0 /,'No current round never includes unknown-scope metadata');
 console.log('PASS: reload/round/auth/online/foreground restore original IDs/photos without camera; legacy scope waits for original round; identity switches and late401 stay isolated; concurrent wake events do not duplicate; photo/recognition401 wait for same-person auth; 400/403/409 stay in review; no tokens in scan metadata.');
 console.log('PASS: exclusive overlay states sum to current non-excluded scan IDs, repeated codes stay distinct, recapture waits for its own photo ACK, and received/identified never imply applied stock.');
})().catch(error=>{console.error(error);process.exitCode=1;});
