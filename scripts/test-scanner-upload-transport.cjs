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
  stocktakeFetch:async(url,options)=>{uploads.push({url,form:options.body,authorization:ctx.token});const status=ctx.responseStatus,id=typeof options.body==='string'?JSON.parse(options.body).clientScanId:options.body.get('clientScanId');await ctx.beforeResponse?.(options);return {status,headers:new Headers(ctx.responseHeaders||{}),ok:status>=200&&status<300,json:async()=>ctx.readResponseBody?ctx.readResponseBody(options):ctx.responseBody||(status===200?{capId:'capture-'+id,bipeId:'bipe-'+id,photoSaved:true,photoRevision:1}:{error:'HTTP '+status})};},responseStatus:status,
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
 const cases=[['empty-object',{}],['invalid-json','INVALID'],['null',null],['array',[]],['missing-photoSaved',{capId:'cap',photoRevision:1}],['missing-revision',{capId:'cap',photoSaved:true}],['saved-false',{capId:'cap',photoSaved:false,photoRevision:1}]];
 for(const [name,body] of cases){
  const h=harness([]);await settle();const row=read(name);h.ctx.etiqFila.push(row);h.ctx.readResponseBody=async()=>{if(body==='INVALID')throw SyntaxError('Unexpected token <');return body;};
  await h.ctx.enviarFila();await settle();const attempt=h.ctx.enviarFila.attempts.get(h.ctx.etiqIdentity(row));
  assert.equal(row.st,'fila');assert.equal(row.capId,undefined);assert.equal(row.bipeId,undefined);assert.equal(row.photoRef,'photo-'+name);assert.equal(attempt.delay,2000);assert.ok(attempt.retryAt>Date.now());assert.equal(h.uploads.length,1);
  await h.ctx.enviarFila();await settle();assert.equal(h.uploads.length,1,'No immediate resend without ACK');
  attempt.retryAt=0;await h.ctx.enviarFila();await settle();const retried=h.ctx.enviarFila.attempts.get(h.ctx.etiqIdentity(row));assert.equal(retried.delay,4000);assert.equal(h.uploads.length,2);assert.equal(h.ctx.etiqFila.length,1);
 }
 for(const [name,header]of [['seconds','60'],['date',new Date(Date.now()+90000).toUTCString()],['invalid','not-a-date'],['absent',null],['long','3000000']]){
  const h=harness([],{status:429});await settle();const row=read('retry-'+name),next=read('next-'+name);h.ctx.etiqFila.push(row,next);if(header)h.ctx.responseHeaders={'Retry-After':header};
  const before=Date.now();await h.ctx.enviarFila();await settle();const attempt=h.ctx.enviarFila.attempts.get(h.ctx.etiqIdentity(row));assert.equal(row.st,'fila');assert.equal(row.photoRef,'photo-retry-'+name);assert.equal(attempt.delay,2000);assert.ok(attempt.retryAt>before);
  if(name==='seconds')assert.ok(attempt.retryAt>=before+60000);
  if(name==='date')assert.ok(attempt.retryAt===Date.parse(header));
  if(name==='invalid'||name==='absent')assert.ok(attempt.retryAt<before+3000);
  h.ctx.responseStatus=200;h.ctx.responseHeaders={};await h.ctx.enviarFila();await settle();assert.equal(h.uploads.length,2);assert.equal(h.uploads[1].form.get('clientScanId'),next.clientScanId,'Other saved piece can proceed');assert.equal(next.st,'salvo');assert.equal(row.st,'fila');
  h.events.online();await settle();assert.equal(h.uploads.length,2,'Online does not bypass Retry-After');
  if(name==='long')assert.ok([...h.timers.values()].some(timer=>timer.ms===2147483647),'Long Retry-After does not overflow browser timers into tight retries');
  attempt.retryAt=0;attempt.retryAfterAt=0;await h.ctx.enviarFila();await settle();assert.equal(h.uploads.length,3);assert.equal(h.uploads[2].form.get('clientScanId'),row.clientScanId);assert.equal(await h.uploads[2].form.get('file').text(),'original');assert.equal(row.st,'salvo');assert.equal(h.ctx.enviarFila.attempts.get(h.ctx.etiqIdentity(row)).retryAfterAt,undefined);assert.equal(h.ctx.etiqFila.length,2);
 }
 for(const body of [{error:'Image too large'},null,'INVALID']){
  const h=harness([],{status:413});await settle();const row=read('oversize');h.ctx.etiqFila.push(row);h.ctx.readResponseBody=async()=>{if(body==='INVALID')throw SyntaxError('bad JSON');return body;};
  await h.ctx.enviarFila();await settle();assert.equal(row.st,'revisao');assert.equal(row.photoRef,'photo-oversize');assert.equal(row.capId,undefined);assert.equal(row.bipeId,undefined);assert.equal(h.timers.size,0);h.events.online();await settle();assert.equal(h.uploads.length,1);assert.equal(h.ctx.etiqFila.length,1);assert.doesNotMatch(row.msg,/Rodada encerrada/);
 }
 console.log('PASS: malformed/missing ACK backs off 2s then 4s with same photo/ID; 429 respects seconds/date Retry-After without blocking another piece; 413 preserves original in review without loop; long header avoids timer overflow.');
})().catch(error=>{console.error(error);process.exitCode=1;});
