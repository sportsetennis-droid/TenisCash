'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public/bipar.html'),'utf8');
const actions=fs.readFileSync(path.join(root,'public/bipar-actions.js'),'utf8');
const retry=html.slice(html.indexOf('  let _retrying = false;'),html.indexOf('  // Auto-retry a cada 10s'));
const auth=actions.slice(actions.indexOf('  function canUploadStocktake('),actions.indexOf('  async function authenticate('));
const read=(id='original')=>({clientScanId:id,roundId:'round-original',storeId:'store-a',sellerId:'operator-a',sellerName:'Original operator',operationType:'replacement',barcode:'0196989405971'});
const settle=()=>new Promise(setImmediate);
function harness(rows=[read()]){
 const c={action:'replacement',actor:{id:'operator-a'},token:'old-a',allowed:['store-a'],queue:structuredClone(rows),requests:[],snapshots:[],status:401,expired:0,recovered:0,renew:false,
  isInventory:()=>['inventory','replacement'].includes(c.action),tokenSubject:t=>t.endsWith('-b')?'operator-b':'operator-a',
  expireAuthentication(){c.expired++;c.actor=null;},async resumeAuthentication(){c.recovered++;if(c.renew){c.token='fresh-a';c.actor={id:'operator-a'};}},
  loadRetryQueue:()=>structuredClone(c.queue),saveRetryQueue:q=>{c.queue=structuredClone(q);c.snapshots.push(structuredClone(q));return true;},retryKey:x=>x.clientScanId,updatePendingBadge(){},genClientScanId(){throw Error('No new identity');},
  stocktakeFetch:async(url,options)=>{c.requests.push({url,body:JSON.parse(options.body),authorization:c.token});await c.beforeResponse?.();return {ok:c.status===200,status:c.status,json:async()=>c.status===200?{bipeId:'saved-original'}:{error:'HTTP '+c.status}};},
  removeFromQueue:id=>{c.queue=c.queue.filter(x=>x.clientScanId!==id);},bipes:[{clientScanId:'original',_pending:true}],renderLista(){},renderStats(){},queueSizeRequest(){},window:{}};
 vm.createContext(c);vm.runInContext(auth,c);
 c.window.BiparActions={isInventory:c.isInventory,canUploadStocktake:c.canUploadStocktake,recoverStocktakeAuthentication:c.recoverStocktakeAuthentication,headers:()=>c.token?{Authorization:'Bearer '+c.token}:{}};
 c.window.ScannerRound={current:()=>({id:'round-original',storeId:'store-a',operationType:'replacement'})};
 vm.runInContext(retry,c);return c;
}
(async()=>{
 const c=harness(),original=read();await c.processRetryQueue();
 assert.equal(c.requests.length,1);assert.equal(c.queue[0].blocked,undefined);assert.equal(c.queue[0].authPending,true);assert.equal(c.expired,1);assert.equal(c.recovered,1);
 for(const key of ['clientScanId','roundId','storeId','sellerId','sellerName','barcode'])assert.equal(c.queue[0][key],original[key]);
 await c.processRetryQueue();assert.equal(c.requests.length,1,'Expired session cannot loop');
 c.actor={id:'operator-a'};await c.processRetryQueue();assert.equal(c.requests.length,1,'Same rejected credential cannot repeat');
 c.actor={id:'operator-b'};c.token='fresh-b';await c.processRetryQueue();assert.equal(c.requests.length,1,'Another person cannot send the original');
 c.actor={id:'operator-a'};c.token='fresh-a';c.allowed=[];await c.processRetryQueue();assert.equal(c.requests.length,1,'Store authorization remains required');
 c.allowed=['store-a'];c.status=200;await c.processRetryQueue();assert.equal(c.requests.length,2);assert.deepEqual(c.requests[1].body,c.requests[0].body);assert.equal(c.queue.length,0);assert.equal(c.bipes[0]._pending,undefined);assert.equal(c.bipes[0].bipeId,'saved-original');
 assert.ok(c.snapshots.every(s=>!JSON.stringify(s).includes('old-a')&&!JSON.stringify(s).includes('fresh-a')),'No credential enters persisted metadata');
 console.log('PASS 401 remains retryable, same-person/store required, same IDs reused, no rejected-token loop or credential persistence.');

 const automatic=harness();automatic.renew=true;await automatic.processRetryQueue();assert.equal(automatic.actor.id,'operator-a');assert.equal(automatic.token,'fresh-a');automatic.status=200;await automatic.processRetryQueue();assert.equal(automatic.requests.length,2);assert.equal(automatic.queue.length,0);
 const switched=harness();switched.beforeResponse=async()=>{switched.actor={id:'operator-b'};switched.token='fresh-b';};await switched.processRetryQueue();assert.equal(switched.actor.id,'operator-b');assert.equal(switched.expired,0);assert.equal(switched.recovered,0);assert.equal(switched.queue[0].sellerId,'operator-a');assert.equal(switched.queue[0].authPending,true);
 console.log('PASS current same-person recovery works; late 401 cannot expire a newer foreign session.');

 for(const status of [400,403,409]){const denied=harness();denied.status=status;await denied.processRetryQueue();assert.equal(denied.queue[0].blocked,'HTTP '+status);denied.status=200;await denied.processRetryQueue();assert.equal(denied.requests.length,1);assert.equal(denied.recovered,0);}
 const historical=harness([{...read(),blocked:'Sessão expirada'}]);historical.status=200;await historical.processRetryQueue();assert.equal(historical.requests.length,0);assert.equal(historical.queue[0].blocked,'Sessão expirada');
 console.log('PASS real 400/403/409 and historical blocked items are untouched.');

 const concurrent=harness();concurrent.status=200;let release;concurrent.beforeResponse=()=>new Promise(resolve=>release=resolve);const first=concurrent.processRetryQueue();await settle();await concurrent.processRetryQueue();await concurrent.processRetryQueue();assert.equal(concurrent.requests.length,1);concurrent.queue.push(read('new-while-waiting'));release();await first;assert.equal(concurrent.requests.length,1);assert.deepEqual(concurrent.queue.map(x=>x.clientScanId),['new-while-waiting']);
 const missing=harness();delete missing.queue[0].operationType;missing.window.ScannerRound.current=()=>null;await missing.processRetryQueue();assert.equal(missing.requests.length,0,'Unknown original round must not inherit selected screen');missing.window.ScannerRound.current=()=>({id:'round-original',storeId:'store-a',operationType:'replacement'});missing.status=200;await missing.processRetryQueue();assert.equal(missing.requests.length,1);
 console.log('PASS concurrent wakes cannot duplicate POST, newly queued physical IDs survive, and legacy scope waits for original round.');
})().catch(error=>{console.error(error);process.exitCode=1;});
