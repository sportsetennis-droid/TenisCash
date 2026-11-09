'use strict';
// Actual recovery/upload/auth-gate functions in an isolated VM. No browser,
// production endpoint, real camera, account mutation, or replacement round.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../public/bipar.html'),'utf8');
const actions=fs.readFileSync(path.join(__dirname,'../public/bipar-actions.js'),'utf8');
const identity=html.slice(html.indexOf('  function etiqIdentity('),html.indexOf('  function etiqCopy('));
const durable=html.slice(html.indexOf('  function etiqPhotoDurable('),html.indexOf('  function renderEtiqCaptureState('));
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
  etiqSave:async()=>{saved.push(JSON.parse(JSON.stringify(rows)));for(const row of rows)ctx.etiqSave.baseline.set(ctx.etiqIdentity(row),JSON.parse(JSON.stringify(row)));return true;},etiqReadPhoto:async()=>{await ctx.beforePhotoRead?.();return photo;},etiqStartOcr(){},etiqStartAutoOcr(){},
  renderEtiqLista(){},renderEtiqCaptureState(){},renderLista(){},consultarStatus:async()=>{ctx.statusPolls++;},statusPolls:0,
  fetch:async data=>{assert.equal(data,photo);return {blob:async()=>new Blob(['original'])};},
  stocktakeFetch:async(url,options)=>{uploads.push({url,form:options.body,authorization:ctx.token});const status=ctx.responseStatus,id=typeof options.body==='string'?JSON.parse(options.body).clientScanId:options.body.get('clientScanId');await ctx.beforeResponse?.(options);return {status,ok:status===200,json:async()=>ctx.readResponseBody?ctx.readResponseBody(options):ctx.responseBody||(status===200?{capId:'capture-'+id,bipeId:'bipe-'+id,photoSaved:true,photoRevision:1}:{error:'HTTP '+status})};},responseStatus:status,
  setTimeout(fn,ms){const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  sellers:[],stores:[],retryStorageFailed:false,STORAGE_VENDNAME:'seller-name',localStorage:{setItem(){}},Option:function(text,value){this.text=text;this.value=value;},round:null,
  window:{addEventListener:(name,fn)=>events[name]=fn},document:{hidden:false,addEventListener:(name,fn)=>events[name]=fn,getElementById:element}};
 vm.createContext(ctx);vm.runInContext(auth,ctx);
 ctx.window.ScannerRound={current:()=>ctx.round,id:()=>ctx.round?.id||null};
 ctx.window.BiparActions={isInventory:ctx.isInventory,mode:()=>ctx.action,version:()=>1,headers:()=>ctx.token?{Authorization:'Bearer '+ctx.token}:{},operator:()=>ctx.actor,replacementReady:()=>false,canUploadStocktake:ctx.canUploadStocktake,recoverStocktakeAuthentication:ctx.recoverStocktakeAuthentication};
 ctx.etiqSave.baseline=new Map();
 vm.runInContext(identity+durable+queue+recovery+updateStatus,ctx);
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
 const duplicate=harness([],{status:409});await settle();const pair=read('repeat');duplicate.ctx.etiqFila.push(pair);duplicate.ctx.etiqAtivo=pair.lid;
 let choose;duplicate.ctx.window.ScannerConfirm={ask:()=>new Promise(resolve=>{choose=resolve;})};
 duplicate.ctx.responseBody={capId:'repeat-photo',photoSaved:true,photoRevision:1,repeat:{barcode:pair.ean,count:1,product:{name:'Tênis',size:'41'}}};
 duplicate.ctx.window.ScannerInventoryOutbox.resume();await settle();assert.equal(pair.st,'revisao');assert.equal(pair.repeat.count,1);assert.equal(pair.capId,'repeat-photo');assert.equal(duplicate.uploads.length,1);
 duplicate.ctx.responseStatus=200;duplicate.ctx.responseBody=null;choose(true);await settle();
 assert.equal(duplicate.uploads.length,2);assert.equal(duplicate.uploads[1].form.get('repeatConfirmedCount'),'1');assert.equal(duplicate.uploads[1].form.get('clientScanId'),'repeat');assert.equal(pair.bipeId,'bipe-repeat');
 const canceled=harness([],{status:409});await settle();const declined=read('declined');canceled.ctx.etiqFila.push(declined);canceled.ctx.etiqAtivo=declined.lid;
 let cancel;canceled.ctx.window.ScannerConfirm={ask:()=>new Promise(resolve=>{cancel=resolve;})};canceled.ctx.responseBody={capId:'declined-photo',photoSaved:true,photoRevision:1,repeat:{barcode:declined.ean,count:2}};
 canceled.ctx.window.ScannerInventoryOutbox.resume();await settle();assert.equal(declined.excluded,undefined);
 canceled.ctx.responseStatus=200;canceled.ctx.responseBody={excluded:true,capId:'declined-photo'};cancel(false);await settle();
 assert.equal(canceled.uploads.at(-1).url,'/api/stocktake/etiqueta/cancelar');assert.equal(JSON.parse(canceled.uploads.at(-1).form).clientScanId,'declined');assert.equal(JSON.parse(canceled.uploads.at(-1).form).photoRevision,1);assert.equal(declined.excluded,true);assert.equal(declined.bipeId,undefined);assert.equal(declined.photoRef,'photo-declined');
 const stuck=harness([]);await settle();const stuckRead={...read('cancel-timeout'),capId:'photo-cancel-timeout',repeatCancelPending:true};stuck.ctx.etiqFila.push(stuckRead);
 stuck.ctx.beforeResponse=options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('AbortError'))));
 const timeoutResult=stuck.ctx.etiqCancelRepeat(stuckRead).then(()=>null,error=>error);await settle();
 const cancelTimer=[...stuck.timers.values()].find(timer=>timer.ms===25000);assert.ok(cancelTimer);cancelTimer.fn();assert.match((await timeoutResult).message,/AbortError/);
 assert.equal(stuckRead.excluded,undefined);assert.equal(stuckRead.repeatCancelPending,true);assert.equal(stuckRead.photoRef,'photo-cancel-timeout','Timeout preserves original and retryable cancellation without fake exclusion');
 for(const kind of ['cancel','recognize','upload']){
  const bodyWait=harness([]);await settle();const event={...read('body-'+kind),capId:'body-photo'};bodyWait.ctx.etiqFila.push(event);
  bodyWait.ctx.readResponseBody=options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('AbortError'))));
  if(kind==='recognize'){event.autoRecognition=true;event.manualPhoto=false;event.autoRevision=1;}
  const pending=(kind==='cancel'?bodyWait.ctx.etiqCancelRepeat(event):kind==='recognize'?bodyWait.ctx.enviarReconhecimento(event,1):bodyWait.ctx.enviarFila()).then(()=>null,error=>error);
  await settle();const bodyTimer=[...bodyWait.timers.values()].find(timer=>timer.ms===25000);assert.ok(bodyTimer,kind+' timeout remains active after headers');bodyTimer.fn();await pending;
  assert.equal(event.excluded,undefined);assert.equal(event.bipeId,undefined);assert.equal(event.photoRef,'photo-body-'+kind);assert.equal(bodyWait.ctx.etiqBusy,false);
 }
 const stale=harness([],{status:409});await settle();const revised=read('revised');stale.ctx.etiqFila.push(revised);stale.ctx.etiqAtivo=revised.lid;
 let answer;stale.ctx.window.ScannerConfirm={ask:()=>new Promise(resolve=>{answer=resolve;})};stale.ctx.responseBody={capId:'old-photo',photoSaved:true,photoRevision:1,repeat:{barcode:revised.ean,count:1}};stale.ctx.window.ScannerInventoryOutbox.resume();await settle();revised.photoRevision=2;answer(true);await settle();assert.equal(revised.repeatConfirmedCount,undefined);assert.equal(stale.uploads.length,1,'Old confirmation cannot authorize a recaptured revision');
 const offline=harness([]);await settle();offline.ctx.navigator={onLine:false};offline.ctx.etiqFila.push(read('offline'));offline.events.online();await settle();assert.equal(offline.uploads.length,0);offline.ctx.navigator.onLine=true;offline.events.online();await settle();assert.equal(offline.uploads.length,1);
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
 const counted=nodes['etiq-contador'].textContent.match(/^total (\d+) · no aparelho\/aguardando envio (\d+) · recebidas\/em conferência (\d+) · aplicadas (\d+) · pendências\/erros (\d+) · excluídas\/sem contagem (\d+)$/);
 assert.ok(counted);assert.deepEqual(counted.slice(1).map(Number),[10,2,3,1,3,1]);assert.equal(counted.slice(2).reduce((sum,n)=>sum+Number(n),0),Number(counted[1]),'Exclusive states include excluded events separately and sum to current readings');
 assert.match(nodes['etiq-lista'].innerHTML,/ÚLTIMOS BIPES · 10/);assert.ok(renderRows.every(row=>row.ean===renderRows[0].ean),'Equal codes remain distinct physical IDs');
 assert.equal(renderRows[8].bipou,undefined,'Identification/photo receipt never invents stock application');
 ui.window.ScannerRound.id=()=>null;renderRows.push({...read('missing-round'),roundId:null});vm.runInNewContext(render+'\nrenderEtiqLista();',ui);assert.match(nodes['etiq-contador'].textContent,/^total 0 /,'No current round never includes unknown-scope metadata');
 const archiveNodes={'etiq-local-archive':{hidden:true},'etiq-local-count':{textContent:''},'etiq-local-list':{innerHTML:''}};
 ui.document.getElementById=id=>archiveNodes[id];vm.runInNewContext(render+'\nrenderEtiqLista();',ui);
 assert.equal(archiveNodes['etiq-local-archive'].hidden,false);assert.match(archiveNodes['etiq-local-list'].innerHTML,/Loja: store-a · Rodada: original-round · Operador: Original operator/);
 assert.doesNotMatch(archiveNodes['etiq-local-list'].innerHTML,/exclude-recent-bipe|retry-label/,'Cold offline archive shows originals without activating camera or stock actions');
 console.log('PASS: duplicate confirmation preserves exact scan/revision/count; cancel waits for server ACK and preserves photo; stale confirmation cannot authorize another revision; offline waits for online; cold archive keeps original contexts.');
 console.log('PASS: reload/round/auth/online/foreground restore original IDs/photos without camera; legacy scope waits for original round; identity switches and late401 stay isolated; concurrent wake events do not duplicate; photo/recognition401 wait for same-person auth; 400/403/409 stay in review; no tokens in scan metadata.');
 console.log('PASS: exclusive overlay states sum to current scan IDs (including separately excluded), repeated codes stay distinct, recapture waits for its own photo ACK, and received/identified never imply applied stock.');
})().catch(error=>{console.error(error);process.exitCode=1;});
