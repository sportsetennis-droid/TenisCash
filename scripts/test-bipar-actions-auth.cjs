'use strict';
// Reuse the full isolated real-source UI harness; no production/browser access.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const harnessFile=path.join(__dirname,'test-bipar-actions-ui.cjs');
const source=fs.readFileSync(harnessFile,'utf8').split('\n(async () => {')[0];
const mod=new Module(harnessFile,module);mod.filename=harnessFile;mod.paths=Module._nodeModulePaths(path.dirname(harnessFile));
mod._compile(source+'\nmodule.exports={harness,storage,person,stores,tokenFor,response,lupo,legacyActionDraft,settingsKey,deferred};',harnessFile);
const {harness,storage,person,stores,tokenFor,response,lupo,legacyActionDraft,settingsKey,deferred}=mod.exports;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function tickAuthentication(h){for(const [id,timer] of [...h.timers])if(timer.ms===0){h.timers.delete(id);timer.fn();}await settle();await settle();}
function synced(request){return response({synced:true,lot:{sessionId:request.body.sessionId,revision:request.body.revision,status:request.body.status}});}
function installAuth(h,expiredToken){let expired=false;h.contextHandler=request=>expired&&request.auth==='Bearer '+expiredToken?response({error:'Sessão expirada'},401):response({user:person,stores,allowedStoreIds:[stores[0].id,stores[1].id]});h.handler=()=>response({product:lupo,requiresSizeConfirmation:false});h.historyHandler=request=>/\/drafts\/(sync|recover)$/.test(request.url)?expired&&request.auth==='Bearer '+expiredToken?response({error:'Sessão expirada'},401):synced(request):response({lots:[],totals:{}});return ()=>{expired=true;};}
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS: '+name);}
(async()=>{
 await test('mid-session 401 stays visibly pending, closes camera and resumes same physical IDs with verified same-user token',async()=>{
  const old=tokenFor(person.id,'old'),fresh=tokenFor(person.id,'fresh'),h=harness(undefined,{token:old}),expire=installAuth(h,old);
  await h.boot();await h.scan(lupo.barcode);await h.scan(lupo.barcode);await h.api.openCamera();
  const draft=h.api.state().currentDraft,ids=Array.from(draft.scans,x=>x.clientScanId),session=draft.sessionId;
  h.localStorage.setItem('loja_token',fresh);expire();const contextsBefore=h.requests.filter(r=>r.url.endsWith('/context')).length;
  assert.equal(await h.api.flushSync(draft),false);assert.equal(h.api.state().actor,null);assert.equal(h.get('action-sync-status').hidden,false);assert.match(h.get('action-sync-status').textContent,/pendente.*sessão expirada/i);assert.doesNotMatch(h.get('action-sync-status').textContent,/Bipes salvos/);assert.equal(h.get('codigo').disabled,true);assert.equal(h.api.state().stream,null);assert.equal(h.get('action-login').hidden,false);
  await tickAuthentication(h);
  assert.equal(h.api.state().actor.id,person.id);assert.equal(h.sessionStorage.getItem('tc_transfer_token'),fresh);assert.ok(h.requests.filter(r=>r.url.endsWith('/context')).length>contextsBefore);
  assert.equal(h.api.state().currentDraft.sessionId,session);assert.deepEqual(Array.from(h.api.state().currentDraft.scans,x=>x.clientScanId),ids);
  const freshSyncs=h.historyRequests.filter(r=>/\/drafts\/sync$/.test(r.url)&&r.auth==='Bearer '+fresh);assert.ok(freshSyncs.length);assert.deepEqual(freshSyncs.at(-1).body.scans.map(x=>x.clientScanId),ids);assert.equal(new Set(ids).size,2);
  assert.ok(!h.requests.some(r=>/\/confirm$|\/dispatch$|\/receive$/.test(r.url)));assert.equal(h.get('action-sync-status').textContent,'Bipes salvos no sistema.');
 });
 await test('without a valid session the exact draft remains local and login warning never turns into saved success',async()=>{
  const old=tokenFor(person.id,'old'),h=harness(undefined,{token:old}),expire=installAuth(h,old);await h.boot();await h.scan(lupo.barcode);
  const draft=h.api.state().currentDraft,original=JSON.stringify(draft.scans);expire();await h.api.flushSync(draft);await tickAuthentication(h);
  assert.equal(h.api.state().actor,null);assert.equal(JSON.stringify(draft.scans),original);assert.equal(h.get('action-sync-status').hidden,false);assert.match(h.get('action-sync-status').textContent,/pendente.*sessão expirada/i);assert.equal(h.get('action-sync-retry').hidden,false);assert.ok(![...h.timers.values()].some(t=>t.ms===0));
  assert.equal(JSON.stringify(JSON.parse(h.localStorage.getItem('tc_bipar_action_draft_v1:'+draft.key)).scans),original);
 });
 await test('expiry cannot switch automatically to another account or send original drafts with its token',async()=>{
  const old=tokenFor(person.id,'old'),foreign=tokenFor('other-operator','fresh'),h=harness(undefined,{token:old}),expire=installAuth(h,old);await h.boot();await h.scan(lupo.barcode);h.localStorage.setItem('loja_token',foreign);expire();await h.api.flushSync(h.api.state().currentDraft);await tickAuthentication(h);
  assert.equal(h.api.state().actor,null);assert.ok(!h.requests.some(r=>r.auth==='Bearer '+foreign));assert.ok(!h.historyRequests.some(r=>r.auth==='Bearer '+foreign));assert.match(h.get('action-sync-status').textContent,/pendente.*sessão expirada/i);
 });
 await test('same-user candidate must still have matching server-verified identity after mid-session expiry',async()=>{
  const old=tokenFor(person.id,'old'),fresh=tokenFor(person.id,'fresh'),h=harness(undefined,{token:old}),expire=installAuth(h,old);await h.boot();await h.scan(lupo.barcode);h.localStorage.setItem('loja_token',fresh);expire();h.contextHandler=request=>request.auth==='Bearer '+old?response({},401):response({user:{...person,id:'unexpected-other',role:'superadmin'},stores,allowedStoreIds:stores.map(s=>s.id)});
  await h.api.flushSync(h.api.state().currentDraft);await tickAuthentication(h);assert.equal(h.api.state().actor,null);assert.ok(!h.historyRequests.some(r=>r.auth==='Bearer '+fresh));assert.match(h.get('action-message').textContent,/outra conta/);assert.match(h.get('action-sync-status').textContent,/pendente.*sessão expirada/i);
 });
 await test('a later valid same-user login discovered by storage event resumes the saved batch',async()=>{
  const old=tokenFor(person.id,'old'),fresh=tokenFor(person.id,'later'),h=harness(undefined,{token:old}),expire=installAuth(h,old);await h.boot();await h.scan(lupo.barcode);expire();await h.api.flushSync(h.api.state().currentDraft);await tickAuthentication(h);assert.equal(h.api.state().actor,null);
  h.localStorage.setItem('loja_token',fresh);for(const fn of h.window.events.storage)fn({key:'loja_token'});await settle();await settle();assert.equal(h.api.state().actor.id,person.id);assert.equal(h.sessionStorage.getItem('tc_transfer_token'),fresh);assert.equal(h.get('action-sync-status').textContent,'Bipes salvos no sistema.');
 });
 await test('stale 401 from prior token cannot invalidate a newly verified session or acknowledge the old request',async()=>{
  const old=tokenFor(person.id,'old'),fresh=tokenFor(person.id,'fresh'),h=harness(undefined,{token:old}),expire=installAuth(h,old);await h.boot();await h.scan(lupo.barcode);const waiting=deferred();h.historyHandler=request=>/\/drafts\/sync$/.test(request.url)&&request.auth==='Bearer '+old?waiting.promise:/\/drafts\/sync$/.test(request.url)?synced(request):response({lots:[],totals:{}});
  const pending=h.api.flushSync(h.api.state().currentDraft);h.localStorage.setItem('loja_token',fresh);expire();await h.api.authenticate();waiting.resolve(response({error:'old expired'},401));await pending;await settle();assert.equal(h.api.state().actor.id,person.id);assert.equal(h.sessionStorage.getItem('tc_transfer_token'),fresh);assert.equal(h.get('action-login').hidden,true);
 });
 await test('legacy retry/photos/pending-transfer namespaces remain verbatim, visible as evidence metadata and never replayed',async()=>{
  const originals={['tc_transfer_pending_'+person.id]:JSON.stringify({requestId:'synthetic-pending',scans:[{id:'legacy-transfer'}]}),tc_bipe_retry_queue:JSON.stringify([{clientScanId:'legacy-a',barcode:lupo.barcode},{clientScanId:'legacy-b',barcode:lupo.barcode}]),etiqFila:JSON.stringify([{clientScanId:'photo-a',b64:'synthetic-photo'}])};
  const h=harness(storage({...originals,[settingsKey]:JSON.stringify({mode:'transfer',stores:{transfer:stores[1].id},origin:stores[0].id})}));h.contextUser={...person,role:'admin'};await h.boot();await settle();
  const evidence=h.window.BiparActions.recoveryInventory();assert.equal(evidence.length,3);assert.deepEqual(Array.from(evidence,x=>x.type).sort(),['inventory_photo_queue','inventory_retry_queue','pending_single_transfer']);for(const [key,value]of Object.entries(originals))assert.equal(h.localStorage.getItem(key),value);assert.ok(!h.historyRequests.some(r=>r.method==='POST'));assert.ok(!h.requests.some(r=>r.method==='POST'));assert.equal(h.api.activeReads().length,0);
 });
 console.log('PASS: '+count+' isolated authentication and legacy-evidence regression groups.');
})().catch(e=>{console.error(e);process.exitCode=1;});

