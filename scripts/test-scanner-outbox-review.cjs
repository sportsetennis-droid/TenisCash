'use strict';
// Audit regressions: execute the production storage/polling functions in an
// isolated protocol harness. No real browser, network, photo, account or DB.
const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const storageSource=fs.readFileSync(path.join(__dirname,'../public/scanner-photo-storage.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/bipar.html'),'utf8');
const clone=value=>structuredClone(value),settle=async()=>{for(let n=0;n<8;n++)await new Promise(setImmediate);};
function local(){const data=new Map();return{get length(){return data.size},key:i=>[...data.keys()][i],getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
function idb(){
 const data={events:new Map(),photos:new Map()};let chain=Promise.resolve();
 const db={objectStoreNames:{contains:()=>true},close(){},transaction(){
  let release;const preceding=chain,done=new Promise(resolve=>release=resolve);chain=preceding.then(()=>done);
  const changes=[],tx={pending:0,finished:false,abort(){if(!tx.finished){tx.finished=true;tx.onabort?.();release();}},objectStore(name){return{
   getAll:()=>request(()=>[...data[name].values()].map(clone)),get:key=>request(()=>clone(data[name].get(key))),put:row=>request(()=>changes.push({name,row:clone(row)}))
  };}};
  function request(fn){const operation={};tx.pending++;preceding.then(()=>setImmediate(()=>{if(tx.finished)return;try{operation.result=fn();operation.onsuccess?.();}catch(error){operation.error=tx.error=error;operation.onerror?.();tx.finished=true;tx.onerror?.();release();}finally{tx.pending--;setImmediate(()=>{if(!tx.pending&&!tx.finished){for(const change of changes)data[change.name].set(change.name==='photos'?change.row.ref:change.row.key,change.row);tx.finished=true;tx.oncomplete?.();release();}});}}));return operation;}
  return tx;
 }};
 return{data,open(){const operation={};setImmediate(()=>{operation.result=db;operation.onsuccess?.();});return operation;}};
}
function storageHarness(){const indexed=idb(),root={indexedDB:indexed,localStorage:local(),crypto:crypto.webcrypto,TextEncoder};vm.runInNewContext(storageSource,{window:root,setTimeout,clearTimeout,TextEncoder,Uint8Array});return{root,indexed,api:root.ScannerPhotoStorage.create()};}
const piece=(revision,extra={})=>({lid:'physical-one',clientScanId:'physical-one',roundId:'original-round',storeId:'original-store',sellerId:'original-operator',operationType:'replacement',ean:'0196989405971',photoRevision:revision,b64:'data:image/jpeg;base64,'+Buffer.from('original-revision-'+revision).toString('base64'),st:'fila',complete:false,...extra});

test('a stale tab must not make an older photograph current after a newer recapture committed',async()=>{
 const h=storageHarness(),first=piece(1),id=h.api.identity(first);
 const savedFirst=await h.api.append(id,first);
 const savedNew=await h.api.append(id,piece(2));
 // This is a late full-frame write of the same event from an older tab.
 await h.api.append(id,first);
 const reopened=h.root.ScannerPhotoStorage.create(),rows=await reopened.read({includeImages:false});
 assert.equal(h.indexed.data.photos.size,2,'Both originals remain physically archived');
 assert.equal(await reopened.readPhoto(savedFirst.photoRef),first.b64);
 assert.equal(await reopened.readPhoto(savedNew.photoRef),piece(2).b64);
 assert.equal(rows[0].photoRevision,2,'Latest photo revision must not regress to the stale frame');
 assert.equal(rows[0].photoRef,savedNew.photoRef,'The outbox must retain the newer photo for upload');
});

test('a genuinely newer saved recapture must not be mistaken for a stale pending copy of a completed read',async()=>{
 const h=storageHarness(),first=piece(1,{complete:true,capId:'server-capture',bipeId:'server-bipe',capIdPhotoRevision:1,bipou:true,st:'vinculado'}),id=h.api.identity(first);
 await h.api.append(id,first);
 const fresh=piece(2,{capId:'server-capture',bipeId:'server-bipe',capIdPhotoRevision:1,bipou:true});
 const saved=await h.api.append(id,fresh);
 const rows=await h.root.ScannerPhotoStorage.create().read({includeImages:false});
 assert.equal(h.indexed.data.photos.size,2,'The current implementation preserves bytes even when queue association is wrong');
 assert.equal(rows[0].photoRevision,2,'A successful revision-2 receipt must restore revision 2 after reload');
 assert.equal(rows[0].photoRef,saved.photoRef);
 assert.equal(rows[0].complete,false,'A prior server completion does not confirm the newer photo');
});

test('revision-stamped metadata and legacy unversioned replies cannot overwrite a later recapture',async()=>{
 const h=storageHarness(),id=h.api.identity(piece(1));
 await h.api.append(id,piece(1));
 await h.api.append(id,{st:'salvo',capId:'server-capture',capIdPhotoRevision:1});
 assert.equal((await h.api.read({includeImages:false}))[0].capId,'server-capture','Initial legacy server receipts remain readable');
 await h.api.append(id,piece(2));
 await h.api.append(id,{photoRevision:1,complete:true,st:'vinculado',bipou:true});
 await h.api.append(id,{complete:true,st:'vinculado',bipou:true});
 let row=(await h.api.read({includeImages:false}))[0];
 assert.equal(row.photoRevision,2);assert.equal(row.complete,false);assert.equal(row.st,'fila');
 await h.api.append(id,{photoRevision:2,capIdPhotoRevision:2,complete:true,st:'vinculado',bipou:true});
 row=(await h.api.read({includeImages:false}))[0];assert.equal(row.complete,true);assert.equal(row.capIdPhotoRevision,2);
 assert.equal(h.indexed.data.photos.size,2);assert.equal(h.indexed.data.events.size,6,'Old deltas remain archived');
});

test('same-revision stale writes never undo completion or an explicit cancellation',async()=>{
 const h=storageHarness(),id=h.api.identity(piece(1));
 await h.api.append(id,piece(1,{complete:true,capId:'server-capture',st:'vinculado'}));
 await h.api.append(id,piece(1));
 assert.equal((await h.api.read({includeImages:false}))[0].complete,true);
 await h.api.append(id,{photoRevision:1,excluded:true,st:'revisao',msg:'Repetição cancelada — não contada'});
 await h.api.append(id,piece(2));
 assert.equal((await h.api.read({includeImages:false}))[0].excluded,true);
 assert.equal((await h.api.read({includeImages:false}))[0].photoRevision,1);
 assert.equal(h.indexed.data.photos.size,2,'Even a rejected later frame stays in the immutable evidence store');
});

const actions=fs.readFileSync(path.join(__dirname,'../public/bipar-actions.js'),'utf8');
const pollSource=html.slice(html.indexOf('  let etiqStatusOffset'),html.indexOf('  function renderEtiqLista()'));
const authSource=actions.slice(actions.indexOf('  function canUploadStocktake('),actions.indexOf('  async function authenticate('));
const waitSource=html.slice(html.indexOf('  function etiqCanUpload('),html.indexOf('  async function enviarReconhecimento('));
const identitySource=html.slice(html.indexOf('  function etiqIdentity('),html.indexOf('  function etiqCopy('));
const received=(id='one',extra={})=>piece(1,{lid:id,clientScanId:id,capId:'capture-'+id,photoRef:'photo-'+id,capIdPhotoRevision:1,st:'salvo',...extra});

function pollingHarness(rows=[received()]){
 const timers=new Map(),requests=[],saved=[];let sequence=0;
 const ctx={console,AbortController,Date:class extends Date {static now(){return ctx.now;}},now:Date.now(),Promise,Number,Map,
  setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),
  action:'replacement',actor:{id:'original-operator'},token:'original-token',allowed:['original-store'],expired:0,resumed:0,recover:false,
  isInventory:()=>ctx.action==='replacement'||ctx.action==='inventory',tokenSubject:token=>token==='other-token'?'other-operator':'original-operator',
  expireAuthentication(){ctx.expired++;ctx.actor=null;},async resumeAuthentication(){ctx.resumed++;if(ctx.recover){ctx.actor={id:'original-operator'};ctx.token='renewed-token';}},
  window:{ScannerRound:{id:()=> 'original-round',current:()=>({id:'original-round',storeId:'original-store',operationType:'replacement'})}},navigator:{onLine:true},
  etiqFila:rows,etiqRejectedAuthorizations:new Map(),etiqSave:async()=>{saved.push(clone(rows));return true;},renderEtiqLista(){},enviarFila(){},queueSizeRequest(){},bipes:[],
  responseStatus:200,responseBody:{rows:[]},
  stocktakeFetch:async(url,options={})=>{requests.push({url,options,token:ctx.token});await ctx.beforeHeaders?.(options);const status=ctx.responseStatus;return{status,ok:status===200,headers:{get:name=>name==='Retry-After'?ctx.retryAfter:null},json:()=>ctx.readBody?ctx.readBody(options):Promise.resolve(ctx.responseBody)}}};
 vm.createContext(ctx);vm.runInContext(authSource,ctx);
 ctx.window.BiparActions={isInventory:ctx.isInventory,headers:()=>ctx.token?{Authorization:'Bearer '+ctx.token}:{},canUploadStocktake:ctx.canUploadStocktake,recoverStocktakeAuthentication:ctx.recoverStocktakeAuthentication};
 vm.runInContext(identitySource+waitSource+pollSource+'\nglobalThis.poll=consultarStatus;globalThis.isBusy=()=>etiqStatusBusy;',ctx);
 return{ctx,timers,requests,saved,expireTimers(){for(const [id,timer]of [...timers])if(timer.ms<=30000){timers.delete(id);timer.fn();}}};
}

test('a status response whose body never completes releases the poll and permits a later retry',async()=>{
 const h=pollingHarness();let bodyWasRequested=false;
 h.ctx.readBody=options=>{bodyWasRequested=true;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('Aborted'),{name:'AbortError'})),{once:true}));};
 void h.ctx.poll();await settle();assert.equal(bodyWasRequested,true);
 h.expireTimers();await settle();
 assert.equal(h.ctx.isBusy(),false,'An interrupted body must not lock every later status poll indefinitely');
 h.ctx.readBody=null;await h.ctx.poll();assert.equal(h.requests.length,2);assert.equal(h.timers.size,0);
});

test('a status request stalled before headers also times out without changing its saved original',async()=>{
 const row=received(),before=clone(row),h=pollingHarness([row]);
 h.ctx.beforeHeaders=options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('AbortError')),{once:true}));
 void h.ctx.poll();await settle();h.expireTimers();await settle();
 assert.equal(h.ctx.isBusy(),false);assert.deepEqual(row,before);assert.equal(h.timers.size,0);
});

test('status batches contain only readings authorized for their original operator and store',async()=>{
 const own=received(),foreignPerson=received('foreign-person',{sellerId:'other-operator'}),foreignStore=received('foreign-store',{storeId:'other-store'}),excluded=received('excluded',{excluded:true});
 const h=pollingHarness([own,foreignPerson,foreignStore,excluded]);await h.ctx.poll();
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/api/stocktake/etiqueta-status?ids=capture-one');
 assert.equal(foreignPerson.st,'salvo');assert.equal(foreignStore.st,'salvo');assert.equal(excluded.excluded,true);
});

test('status 401 preserves every reading and waits for the same verified identity without a tight retry',async()=>{
 const rows=[received('one'),received('two')],h=pollingHarness(rows);h.ctx.responseStatus=401;h.ctx.responseBody={error:'Sessão expirada'};
 await h.ctx.poll();assert.equal(h.ctx.expired,1);assert.equal(h.ctx.resumed,1);
 for(const row of rows){assert.equal(row.authPending,true);assert.equal(row.st,'salvo');assert.match(row.msg,/mesma conta/);assert.ok(row.photoRef);}
 await h.ctx.poll();assert.equal(h.requests.length,1,'Rejected session waits for authentication');
 h.ctx.actor={id:'other-operator'};h.ctx.token='other-token';await h.ctx.poll();assert.equal(h.requests.length,1);
 h.ctx.actor={id:'original-operator'};h.ctx.token='renewed-token';h.ctx.responseStatus=200;h.ctx.responseBody={rows:[]};await h.ctx.poll();
 assert.equal(h.requests.length,2);for(const row of rows)assert.equal(row.authPending,false);
 assert.ok(h.saved.every(snapshot=>!JSON.stringify(snapshot).includes('token')),'Tokens never enter capture metadata');
});

test('late 401 cannot expire another operator session or mark a newer image revision',async()=>{
 const row=received(),h=pollingHarness([row]);h.ctx.responseStatus=401;
 h.ctx.beforeHeaders=async()=>{h.ctx.actor={id:'other-operator'};h.ctx.token='other-token';};
 await h.ctx.poll();assert.equal(h.ctx.expired,0);assert.equal(h.ctx.actor.id,'other-operator');assert.equal(row.authPending,true);assert.equal(row.sellerId,'original-operator');
 const newer=received(),n=pollingHarness([newer]);n.ctx.responseStatus=401;n.ctx.beforeHeaders=async()=>{newer.photoRevision=2;};
 await n.ctx.poll();assert.equal(n.ctx.expired,0);assert.equal(newer.authPending,undefined);
});

test('genuine 403 and 409 stay visibly in review and are not automatically rearmed',async()=>{
 for(const status of [403,409]){
  const row=received(),h=pollingHarness([row]);h.ctx.responseStatus=status;h.ctx.responseBody={error:'Conferência necessária'};
  await h.ctx.poll();assert.equal(row.st,'revisao');assert.equal(row.msg,'Conferência necessária');assert.equal(row.photoRef,'photo-one');
  await h.ctx.poll();assert.equal(h.requests.length,1);assert.equal(h.ctx.expired,0);
 }
});

test('late status success never confirms a newer recapture or an unrelated response row',async()=>{
 const row=received(),foreign=received('foreign',{sellerId:'other-operator'}),h=pollingHarness([row,foreign]);
 h.ctx.beforeHeaders=async()=>{row.photoRevision=2;row.st='fila';};
 h.ctx.responseBody={rows:[{id:row.capId,photoRevision:1,status:'vinculado',complete:true,appliedToStock:true},{id:foreign.capId,photoRevision:1,status:'vinculado',complete:true,appliedToStock:true}]};
 await h.ctx.poll();assert.equal(row.photoRevision,2);assert.equal(row.complete,false);assert.equal(row.st,'fila');assert.equal(foreign.complete,false);
});

test('an older status response cannot undo a concurrent exclusion, review or completion',async()=>{
 for(const change of [{excluded:true,st:'revisao'},{st:'revisao',msg:'Repetição aguardando confirmação'},{complete:true,bipou:true,st:'vinculado'}]){
  const row=received(),h=pollingHarness([row]);h.ctx.beforeHeaders=async()=>Object.assign(row,change);
  h.ctx.responseBody={rows:[{id:row.capId,photoRevision:1,status:'pendente',complete:false,appliedToStock:false,excludedAt:null}]};
  await h.ctx.poll();for(const [key,value]of Object.entries(change))assert.equal(row[key],value);
 }
});

test('a malformed forbidden response remains a visible review without deleting evidence',async()=>{
 const row=received(),h=pollingHarness([row]);h.ctx.responseStatus=403;h.ctx.responseBody=null;
 await h.ctx.poll();assert.equal(row.st,'revisao');assert.match(row.msg,/preservados/);assert.equal(row.photoRef,'photo-one');assert.equal(h.ctx.isBusy(),false);
});

test('429 and 408 preserve the received readings and retry after the temporary wait',async()=>{
 for(const [status,retryAfter,wait]of [[429,'90',90000],[408,undefined,3000],[429,'invalid',3000]]){
  const row=received(),before=clone(row),h=pollingHarness([row]);h.ctx.responseStatus=status;h.ctx.retryAfter=retryAfter;
  await h.ctx.poll();assert.deepEqual(row,before,'Temporary failures must not create a permanent review');assert.equal(h.ctx.isBusy(),false);
  h.ctx.responseStatus=200;await h.ctx.poll();assert.equal(h.requests.length,1,'No immediate repeat while the server asks us to wait');
  h.ctx.now+=wait-1;await h.ctx.poll();assert.equal(h.requests.length,1);
  h.ctx.now++;h.ctx.responseBody={rows:[{id:row.capId,photoRevision:1,status:'vinculado',complete:true,appliedToStock:true}]};
  await h.ctx.poll();assert.equal(h.requests.length,2);assert.equal(row.complete,true);assert.equal(row.bipou,true);assert.equal(row.photoRef,'photo-one');
 }
});

test('HTTP-date Retry-After resumes the rotating status batches without losing any original',async()=>{
 const rows=Array.from({length:25},(_,i)=>received('part-'+i)),before=clone(rows),h=pollingHarness(rows);
 h.ctx.now=Math.floor(h.ctx.now/1000)*1000;h.ctx.responseStatus=429;h.ctx.retryAfter=new Date(h.ctx.now+30000).toUTCString();
 await h.ctx.poll();assert.deepEqual(rows,before);assert.equal(h.requests[0].url.split('ids=')[1].split(',').length,20);
 h.ctx.responseStatus=200;h.ctx.now+=29999;await h.ctx.poll();assert.equal(h.requests.length,1);
 h.ctx.now++;await h.ctx.poll();assert.equal(h.requests.length,2);assert.match(h.requests[1].url,/ids=capture-part-20,/);
 assert.deepEqual(rows.map(row=>row.photoRef),before.map(row=>row.photoRef));assert.ok(rows.every(row=>row.st==='salvo'));
});

test('a status rate limit never prevents an independent recognition retry from reaching the upload queue',async()=>{
 const h=pollingHarness();h.ctx.responseStatus=429;h.ctx.retryAfter='90';await h.ctx.poll();
 const another=received('another',{st:'pendente',autoRecognition:true,manualPhoto:false});h.ctx.etiqFila.push(another);
 let uploads=0;h.ctx.enviarFila=()=>uploads++;
 await h.ctx.poll();await settle();assert.equal(another.st,'fila');assert.equal(uploads,1);assert.equal(h.requests.length,1);
});
