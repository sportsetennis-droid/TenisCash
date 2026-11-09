'use strict';
// Browser integration E2E: real application HTML, DOM, event handlers, IndexedDB,
// capture/queue/upload code. Synthetic camera/decoder and local HTTP API only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
// Optional browser runner: install Playwright in the test environment or set
// PLAYWRIGHT_MODULE to an existing module. Not part of the dependency-free Node suite.
const pw=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project=path.resolve(__dirname,'..');
const out=path.resolve(process.env.SCANNER_E2E_OUTPUT || path.join(project,'tmp/scanner-browser-durability'));
fs.mkdirSync(out,{recursive:true});
const root=process.argv.includes('--frozen')?path.join(out,'snapshot'):path.join(project,'public');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const snapshot=new Map(),html=fs.readFileSync(path.join(root,'bipar.html'));
snapshot.set('/bipar.html',html);
for(const match of html.toString().matchAll(/<script src="([^"]+)"/g)){const name=match[1].split('?')[0];snapshot.set(name,fs.readFileSync(path.join(root,name)));}
const sources=Object.fromEntries([...snapshot].map(([name,data])=>[name,hash(data)]));
fs.mkdirSync(path.join(out,'snapshot'),{recursive:true});
for(const [name,data]of snapshot){const target=path.join(out,'snapshot',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);}
fs.writeFileSync(path.join(out,'source-hashes.json'),JSON.stringify({createdAt:new Date().toISOString(),sources},null,2));
const engine=process.env.SCANNER_TEST_BROWSER||'chromium',race=!process.argv.includes('--without-open-race'),resultName=engine+(race?'-race':'')+'-result.json',uploads=[],requests=[],errors=[],blockedExternal=[],checks=[];
let phase='hold-first',browser,context,origin,firstRelease,held=[];
const first=new Promise(resolve=>{firstRelease=resolve;});
const counts=new Map();
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');requests.push({method:req.method,path:url.pathname});res.setHeader('Cache-Control','no-store');
  try{
    if(url.pathname.startsWith('/api/')){
      res.setHeader('Content-Type','application/json');
      const json=data=>res.end(JSON.stringify(data));
      if(url.pathname==='/api/stocktake/stores')return json({stores:[{id:'e2e-store',code:'E2E',name:'Loja fictícia E2E'}]});
      if(url.pathname==='/api/stocktake/sellers')return json({sellers:[{id:'e2e-seller',name:'Operador fictício E2E'}]});
      if(url.pathname==='/api/stocktake/rounds/current')return json({round:{id:'e2e-round',storeId:'e2e-store',status:'counting',operationType:'inventory',number:1,name:'Rodada fictícia',startedAt:'2026-11-09T12:00:00Z'}});
      if(url.pathname==='/api/stocktake/etiqueta-status')return json({rows:phase==='success'?[...new Map(uploads.map(u=>[u.id,u])).values()].map(u=>({id:'cap-'+u.id,photoRevision:u.revision,complete:true,status:'vinculado',barcode:u.code,bipeId:'bipe-'+u.id,product:{name:'Fixture E2E',size:'40'}})):[]});
      if(url.pathname==='/api/stocktake/etiqueta'){
        const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks),text=raw.toString('latin1');
        const field=name=>text.match(new RegExp('name="'+name+'"\\r\\n\\r\\n([^\\r]*)'))?.[1]||'';
        const fileStart=text.indexOf('\r\n\r\n',text.indexOf('name="file"'))+4,tail=text.indexOf('\r\n--',fileStart);
        const u={id:field('clientScanId'),round:field('roundId'),store:field('storeId'),seller:field('sellerId'),code:field('eanLocal'),revision:Number(field('photoRevision')),photoHash:hash(raw.subarray(fileStart,tail)),at:new Date().toISOString()};
        uploads.push(u);counts.set(u.id,(counts.get(u.id)||0)+1);
        if(uploads.length===1)await first;
        if(phase==='reload-hold')await new Promise(resolve=>held.push(resolve));
        if(phase!=='success'&&uploads.length===2){res.statusCode=503;return json({error:'Synthetic transient error'});}
        return json({capId:'cap-'+u.id,photoSaved:true,photoRevision:u.revision,...(phase==='success'?{bipeId:'bipe-'+u.id,found:true}:{pending:true,error:'Synthetic pending identification'})});
      }
      res.statusCode=404;return json({error:'Unexpected local API request: '+url.pathname});
    }
    if(url.pathname==='/favicon.ico'){res.statusCode=204;return res.end();}
    const data=snapshot.get(url.pathname);
    if(!data){res.statusCode=404;return res.end();}
    res.setHeader('Content-Type',url.pathname.endsWith('.html')?'text/html':'text/javascript');res.end(data);
  }catch(e){errors.push('server:'+e.message);res.statusCode=500;res.end('{}');}
});
const poll=async(test,label,timeout=10000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(test())return;await new Promise(r=>setTimeout(r,20));}throw Error('Timeout '+label);};
const check=(name,detail={})=>{checks.push({name,passed:true,...detail});console.log('PASS '+name);};
async function initialize(page){
  await page.goto(origin+'/bipar.html?storeId=e2e-store');
  await page.waitForFunction(()=>window.ScannerRound?.id()==='e2e-round'&&document.getElementById('vendedor').querySelector('option[value="e2e-seller"]'));
  await page.locator('#vendedor').selectOption('e2e-seller');
  await page.evaluate(async()=>{
    await etiqRestorePromise;
    window.__camera=document.createElement('canvas');__camera.width=600;__camera.height=800;
    const ctx=__camera.getContext('2d');ctx.fillStyle='#eee';ctx.fillRect(0,0,600,800);
    if(navigator.mediaDevices&&typeof __camera.captureStream==='function'){
      navigator.mediaDevices.getUserMedia=async()=>{const stream=__camera.captureStream(10);window.__frameTimer=setInterval(()=>{ctx.fillStyle='#eee';ctx.fillRect(0,0,600,800);},100);return stream;};
    }else{
      // The Windows WebKit build has no mediaDevices. Only acquisition is
      // simulated here; the production capture/queue/IDB path remains intact.
      Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}],getVideoTracks:()=>[]})}});
      Object.defineProperty(HTMLMediaElement.prototype,'srcObject',{get(){return this.__mockStream;},set(value){this.__mockStream=value;}});
      HTMLMediaElement.prototype.play=async function(){Object.defineProperty(this,'videoWidth',{value:600,configurable:true});Object.defineProperty(this,'videoHeight',{value:800,configurable:true});};
    }
    ScannerCamera.warmup=()=>{};ScannerCamera.tune=async()=>{};ScannerCamera.start=()=>({stop(){}});
    ScannerAuto.create=options=>{window.__scannerOptions=options;return{stop(){},reset(){},tick(){}};};
    ScannerAuto.stopDecoder=()=>{};
    window.__ocr=[];ScannerOCR.readForScan=(image,code)=>new Promise(resolve=>__ocr.push({resolve,code}));
    etiqBeep=()=>{};
    window.__deliver=(code,color)=>{
      const frame=document.createElement('canvas');frame.width=600;frame.height=800;const ctx=frame.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,600,800);ctx.fillStyle='white';ctx.font='25px sans-serif';ctx.fillText('SYNTHETIC E2E '+code,20,70);
      __scannerOptions.onCapture({ean:code,frame});
    };
    window.__state=async()=>({rows:await etiqPhotoStorage.read({includeImages:false}),live:etiqFila.map(x=>({id:x.clientScanId,ean:x.ean,revision:x.photoRevision,st:x.st,complete:x.complete,lid:x.lid,photoRef:x.photoRef})),active:etiqAtivo,armed:etiqLeituraArmada,paused:etiqPausado,failed:etiqStorageFailed,nextDisabled:document.getElementById('etiq-confirm-btn')?.disabled,nextText:document.getElementById('etiq-confirm-btn')?.textContent,status:document.getElementById('etiq-confirm-status')?.textContent});
  });
}
async function open(page){await page.locator('[data-click="camera"]').click();await page.waitForFunction(()=>!!window.__scannerOptions&&!!document.getElementById('etiq-video')?.videoWidth);}
async function main(){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{channel:'chrome'}:{})});
  context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin+'/')||url.startsWith('data:'))return route.continue();blockedExternal.push(url);return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async dialog=>{errors.push('dialog:'+dialog.message());await dialog.dismiss();});
  await initialize(page);
  if(race)await page.evaluate(async()=>{await etiqSave.queue;window.__read=etiqPhotoStorage.read;let once=true;window.__readGate=new Promise(resolve=>window.__releaseRead=resolve);etiqPhotoStorage.read=async(...args)=>{const result=await __read(...args);if(once){once=false;window.__readReached=true;await __readGate;}return result;};});
  await open(page);
  if(race)await page.waitForFunction(()=>window.__readReached===true);
  await page.evaluate(()=>{window.__append=etiqPhotoStorage.append;window.__commit=new Promise(resolve=>window.__releaseCommit=resolve);let once=true;etiqPhotoStorage.append=async(...args)=>{if(once){once=false;await __commit;}return __append(...args);};__deliver('7900000000001','#b11');});
  await page.waitForFunction(()=>etiqFila.length===1);
  if(race){await page.evaluate(()=>__releaseRead());await new Promise(resolve=>setTimeout(resolve,250));}
  let state=await page.evaluate(()=>__state());assert.equal(state.nextDisabled,true,'Next cannot advance before the held commit');assert.equal(state.rows.length,0,'No real stored event before the held commit');assert.equal(uploads.length,0,'No upload before the held commit');assert.equal(state.armed,false);
  await page.evaluate(()=>window.proximaEtiqueta());assert.equal(await page.evaluate(()=>etiqFila[0].lid===etiqAtivo),true);
  check('local commit held: Next remains disabled, upload absent, same active piece');
  await page.evaluate(()=>__releaseCommit());await page.waitForFunction(()=>!document.getElementById('etiq-confirm-btn').disabled);await poll(()=>uploads.length===1,'first held upload');
  state=await page.evaluate(()=>__state());assert.equal(state.rows.length,1);assert.match(state.nextText,/PRÓXIMO/);assert.equal(state.rows[0].complete,false);assert.ok(state.rows[0].photoRef);assert.equal(state.rows[0].autoPhoto,true);assert.equal(state.rows[0].autoRecognition,false);
  const firstId=state.rows[0].clientScanId;
  await page.screenshot({path:path.join(out,engine+'-next-before-upload.png')});
  check('automatic decoded frame saved in real IndexedDB; Next enabled before HTTP and OCR',{id:firstId});
  await page.evaluate(()=>{__deliver('7900000000009','#111');__deliver('7900000000001','#111');});assert.equal(await page.evaluate(()=>etiqFila.length),1);
  await page.locator('#etiq-confirm-btn').click();assert.equal(await page.evaluate(()=>etiqAtivo),null);
  await page.evaluate(()=>__deliver('7900000000001','#11b'));await page.waitForFunction(()=>etiqFila.length===2&&!document.getElementById('etiq-confirm-btn').disabled);
  state=await page.evaluate(()=>__state());assert.equal(state.rows.length,2);assert.notEqual(state.rows[0].clientScanId,state.rows[1].clientScanId);assert.notEqual(state.rows[0].photoRef,state.rows[1].photoRef);assert.equal(uploads.length,1);assert.equal(state.armed,false);
  check('manual Next authorizes identical next barcode as a distinct ID/photo while first upload waits');
  await page.locator('#etiq-confirm-btn').click();
  await page.evaluate(()=>{etiqPhotoStorage.append=async()=>{throw Error('Synthetic quota failure');};__deliver('7900000000003','#191');});
  await page.waitForFunction(()=>etiqStorageFailed);
  state=await page.evaluate(()=>__state());assert.equal(state.rows.length,2);assert.equal(state.live.length,3);assert.equal(state.nextDisabled,true);const thirdId=state.live[2].id;
  await page.evaluate(()=>window.proximaEtiqueta());assert.equal(await page.evaluate(()=>etiqAtivo===etiqFila[2].lid),true);
  await page.screenshot({path:path.join(out,engine+'-storage-failure.png')});
  await page.evaluate(async()=>{etiqPhotoStorage.append=__append;await etiqSave();});await page.waitForFunction(()=>!document.getElementById('etiq-confirm-btn').disabled);
  state=await page.evaluate(()=>__state());assert.equal(state.rows.length,3);assert.equal(state.live[2].id,thirdId);assert.equal(state.failed,false);
  check('local persistence failure blocks Next; retry commits the same third ID/photo without duplicate');
  await page.locator('#etiq-confirm-btn').click();phase='pending';firstRelease();
  await poll(()=>uploads.length>=3,'fair queue uploads');
  assert.equal(uploads[0].id,firstId);assert.notEqual(uploads[1].id,firstId);assert.equal(uploads[2].id,thirdId);
  assert.ok(uploads.every(u=>u.round==='e2e-round'&&u.store==='e2e-store'&&u.seller==='e2e-seller'));
  await page.waitForFunction(()=>!etiqBusy&&etiqFila.every(x=>x.st==='fila'));
  const originals=await page.evaluate(async()=>{const rows=await etiqPhotoStorage.read({includeImages:false});return Promise.all(rows.map(async r=>({id:r.clientScanId,round:r.roundId,store:r.storeId,seller:r.sellerId,ean:r.ean,revision:r.photoRevision,photoRef:r.photoRef,b64:await etiqPhotoStorage.readPhoto(r.photoRef)})));});
  check('pending item and transient HTTP 503 do not prevent later saved pieces from getting an upload turn');
  phase='reload-hold';await initialize(page);await page.waitForFunction(()=>etiqFila.length===3);
  const restored=await page.evaluate(async()=>{const rows=await etiqPhotoStorage.read({includeImages:false});return Promise.all(rows.map(async r=>({id:r.clientScanId,round:r.roundId,store:r.storeId,seller:r.sellerId,ean:r.ean,revision:r.photoRevision,photoRef:r.photoRef,b64:await etiqPhotoStorage.readPhoto(r.photoRef)})));});
  assert.deepEqual(restored,originals);assert.equal(new Set(restored.map(x=>x.id)).size,3);assert.equal(restored.filter(x=>x.ean==='7900000000001').length,2);
  check('page reload restores all 3 IDs and exact original images, including repeated EAN and pending states');
  await poll(()=>held.length>0,'automatic resumed upload');phase='success';held.forEach(r=>r());held=[];
  await page.waitForFunction(()=>etiqFila.every(x=>x.bipeId&&(x.st==='salvo'||x.complete)),null,{timeout:10000});
  await page.evaluate(()=>consultarStatus());await page.waitForFunction(()=>etiqFila.every(x=>x.complete));
  for(const row of originals){const group=uploads.filter(u=>u.id===row.id);assert.ok(group.length>=2);assert.equal(new Set(group.map(u=>u.photoHash)).size,1);assert.equal(new Set(group.map(u=>u.revision)).size,1);assert.equal(group[0].photoHash,hash(Buffer.from(row.b64.split(',')[1],'base64')));}
  assert.equal(await page.evaluate(()=>etiqFila.length),3);assert.deepEqual(errors,[]);assert.deepEqual(blockedExternal,[]);
  await page.screenshot({path:path.join(out,engine+'-restored-complete.png')});
  check('automatic retry after reload sends the same photo bytes/revision/ID; status response completes 3 simulated reads');
  check('no external network, production action, real account or physical camera used');
  const report={passed:true,engine,browser:await browser.version(),completedAt:new Date().toISOString(),origin,scope:'Browser integration with synthetic camera/decoder, actual HTML/DOM/IndexedDB and local mock API. No physical iPhone test.',sources,checks,uploads,apiRequests:requests.filter(r=>r.path.startsWith('/api/')),errors,blockedExternal};
  fs.writeFileSync(path.join(out,resultName),JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);fs.writeFileSync(path.join(out,resultName),JSON.stringify({passed:false,at:new Date().toISOString(),engine,error:error.stack,sources,checks,uploads,errors,blockedExternal},null,2));process.exitCode=1;}).finally(async()=>{firstRelease();held.forEach(r=>r());if(context)await context.close();if(browser)await browser.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));});
