'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),fs=require('node:fs'),vm=require('node:vm'),express=require('express'),jwt=require('jsonwebtoken');
const url=process.env.ROUND_TEST_DATABASE_URL;
if(!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/stock_replacement_'))throw Error('Somente PostgreSQL isolado local55329 stock_replacement_.');
process.env.DATABASE_URL=url;
const mw=require('../src/middleware'),db=mw.prisma,service=require('../src/services/stockReplacement'),queue=require('../src/services/stockReplacementQueue'),photos=require('../src/services/scannerCapturePhoto'),policy=require('../public/scanner-barcode-policy');
const source=fs.readFileSync(require.resolve('../src/routes/stocktake'),'utf8');
const pause=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const code=()=>{const b='8'+randomUUID().replace(/\D/g,'').padEnd(11,'0').slice(0,11);return b+((10-[...b].reduce((s,n,i)=>s+Number(n)*(i%2?3:1),0)%10)%10);};
let photo,server,admin;
const cases=[];
const readFor=f=>({source:'archived-photo-local-ocr-v1',decodedBarcodes:[f.ps.barcode],size:'41',references:['RACE001'],text:'PUMA RACE001 BR 41'});
async function fixture({orphan=false}={}){
 const suffix=randomUUID(),store=await db.store.create({data:{code:'EXCL-RACE-'+suffix,name:'Excluded race isolated'}}),seller=await db.user.create({data:{name:'Race seller',phone:'EXCL-RACE-'+suffix,role:'seller',storeId:store.id,pin:'test-only'}});
 const round=await db.stocktakeRound.create({data:{name:'Exclusion race isolated',storeId:store.id,operationType:'replacement',status:'counting',activeReplacementStoreId:store.id,baseline:[],startedAt:new Date(Date.now()-60000)}});
 const product=await db.product.create({data:{sku:'RACE001-'+suffix,name:'Tênis teste de concorrência',brand:'PUMA',category:'Tênis',price:100,aiContext:{scannerReferences:['RACE001']}}});
 const ps=await db.productSize.create({data:{productId:product.id,size:'41',barcode:code(),stock:0}}),scanKey=round.id+':'+randomUUID();
 const bipe=orphan?null:await db.stocktakeBipe.create({data:{scanKey,roundId:round.id,storeId:store.id,sellerId:seller.id,barcode:ps.barcode,productId:product.id,productSizeId:ps.id,productSize:'41',found:true}});
 const capture=await db.productCapture.create({data:{scanKey,roundId:round.id,storeId:store.id,sellerId:seller.id,sellerName:seller.name,bipeId:bipe?.id,barcode:ps.barcode,photo,status:'processando',note:photos.photoNote('','Saved','1')}});
 const f={store,seller,round,product,ps,bipe,capture};cases.push(f);return f;
}
const stock=async f=>(await db.storeStock.findUnique({where:{storeId_productSizeId:{storeId:f.store.id,productSizeId:f.ps.id}}}))?.stock||0;
const movements=async f=>db.storeStockMovement.findMany({where:{storeId:f.store.id},orderBy:{createdAt:'asc'}});
async function excludeHttp(f){const response=await fetch('http://127.0.0.1:'+server.address().port+'/rounds/'+f.round.id+'/exclude/'+f.bipe.id,{method:'POST',headers:{Authorization:'Bearer '+jwt.sign({userId:admin.id},mw.JWT_SECRET),'Content-Type':'application/json'},body:JSON.stringify({reason:'Isolated race correction'})});assert.equal(response.status,200,JSON.stringify(await response.json()));}
async function excludeUnderLock(f,{entered,release}={}){
 return db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${f.round.id} FOR UPDATE`;
  if(entered){entered.resolve();await release.promise;}
  if(f.bipe){await service.exclude(tx,f.bipe,'Isolated race correction');await tx.stocktakeBipe.update({where:{id:f.bipe.id},data:{excludedAt:new Date(),exclusionReason:'Isolated race correction'}});}
  await tx.productCapture.update({where:{id:f.capture.id},data:{excludedAt:new Date(),status:'descartado',exclusionReason:'Isolated race correction'}});
 },{timeout:20000});
}
function realIdentify(f,{beforeUpdate,releaseUpdate}){
 // Execute the actual route functions; only OCR/catalog identification is a
 // deterministic test input. All state, exclusion and stock use real PG.
 let transactions=0;
 const prisma=new Proxy(db,{get(target,key){if(key==='$transaction')return async(...args)=>{if(++transactions===2){beforeUpdate.resolve();await releaseUpdate.promise;}return target.$transaction(...args);};if(key!=='productCapture')return target[key];return new Proxy(target.productCapture,{get(t,k){if(k!=='updateMany')return typeof t[k]==='function'?t[k].bind(t):t[k];return async args=>{beforeUpdate.resolve();await releaseUpdate.promise;return t.updateMany(args);};}});}});
 const context={prisma,capturePhotos:photos,barcodePolicy:policy,barcodeVariants:policy.variants,parseScannerText:()=>({sku:'RACE001',tamanho:'41',marca:'PUMA'}),normalizeScannedSize:x=>x,
  learnScannerBarcode:async()=>({reason:'matched',name:f.product.name,productId:f.product.id,productSizeId:f.ps.id}),matchInternalBarcode:async()=>{throw Error('unexpected internal code');},needsManualSize:()=>false,
  applyBipeIfReady:async()=>({applied:false,reason:'replacement_validation_pending'}),scannerPendingMessage:()=> 'pending',replacement:service,console,module:{exports:null}};
 const a=source.indexOf('async function garantirBipeDaCaptura('),b=source.indexOf('\n// Extrai o PRIMEIRO objeto',a),c=source.indexOf('async function processarEtiqueta('),d=source.indexOf('\n// Automatic recognition',c);
 assert.ok(a>=0&&b>a&&c>b&&d>c);vm.runInNewContext(source.slice(a,b)+'\n'+source.slice(c,d)+'\nmodule.exports=processarEtiqueta;',context);
 return context.module.exports;
}
(async()=>{
 photo='data:image/png;base64,'+(await require('sharp')({create:{width:40,height:40,channels:3,background:'#fff'}}).png().toBuffer()).toString('base64');
 admin=await db.user.create({data:{name:'Race admin',role:'admin',phone:'EXCL-RACE-ADMIN-'+randomUUID(),pin:'test-only'}});
 const app=express();app.use(express.json());app.use('/rounds',require('../src/routes/stocktakeRounds'));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const first=await fixture(),entered=pause(),release=pause();
 const applying=service.applyVerified(db,await service.context(db,first.bipe.id),readFor(first),'RACE001',{beforeCommit:async()=>{entered.resolve();await release.promise;}});
 await entered.promise;let excludeDone=false;const excluding=excludeHttp(first).then(()=>excludeDone=true);await new Promise(r=>setTimeout(r,40));assert.equal(excludeDone,false);release.resolve();assert.equal((await applying).applied,true);await excluding;
 assert.equal(await stock(first),0);assert.deepEqual((await movements(first)).map(m=>m.quantity),[1,-1]);assert.equal((await service.applyVerified(db,await service.context(db,first.bipe.id),readFor(first),'RACE001')).applied,false);
 console.log('PASS application holds round lock; HTTP exclusion waits, reverses once, and late replay cannot restore stock.');
 const second=await fixture(),lockHeld=pause(),unlock=pause(),oldContext=await service.context(db,second.bipe.id);
 const removing=excludeUnderLock(second,{entered:lockHeld,release:unlock});await lockHeld.promise;const lateApply=service.applyVerified(db,oldContext,readFor(second),'RACE001');unlock.resolve();await removing;assert.equal((await lateApply).applied,false);assert.equal(await stock(second),0);assert.equal((await movements(second)).length,0);
 console.log('PASS exclusion commits first; waiting validated result cannot add stock.');
 const third=await fixture();assert.equal((await service.applyVerified(db,await service.context(db,third.bipe.id),readFor(third),'RACE001')).applied,true);await Promise.all([excludeHttp(third),excludeHttp(third)]);assert.equal(await stock(third),0);assert.deepEqual((await movements(third)).map(m=>m.quantity),[1,-1]);
 console.log('PASS concurrent HTTP exclusions create one reversal only.');
 const fourth=await fixture(),ocrStarted=pause(),ocrRelease=pause();const q=queue.createQueue(db,{work:false,readImage:async()=>{ocrStarted.resolve();await ocrRelease.promise;return readFor(fourth);}});
 const processing=q.processJob({data:queue.snapshot(fourth.capture)});await ocrStarted.promise;await excludeHttp(fourth);ocrRelease.resolve();assert.equal((await processing).status,'obsolete');assert.equal(await stock(fourth),0);assert.equal((await movements(fourth)).length,0);await q.stop();
 console.log('PASS queue result returning after exclusion is obsolete with zero movements.');
 const fifth=await fixture({orphan:true}),decodeStarted=pause(),decodeRelease=pause();const recovery=require('../src/services/stockReplacementCaptureRecovery').createRecovery({decode:async()=>{decodeStarted.resolve();await decodeRelease.promise;return [fifth.ps.barcode];},enqueue:async()=>{throw Error('excluded capture must not enqueue');}});
 const recovering=recovery.recover(db,fifth.capture.id);await decodeStarted.promise;await excludeUnderLock(fifth);decodeRelease.resolve();assert.equal((await recovering).recovered,false);assert.equal(await db.stocktakeBipe.count({where:{roundId:fifth.round.id}}),0);assert.equal(await stock(fifth),0);
 console.log('PASS recovery decoding before exclusion cannot create an orphan bipe afterward.');
 const sixth=await fixture(),beforeUpdate=pause(),releaseUpdate=pause(),identify=realIdentify(sixth,{beforeUpdate,releaseUpdate});
 const identifying=identify(sixth.capture.id,photo,sixth.ps.barcode,{photoRevision:'1',ocrText:'PUMA RACE001 BR 41',serverRead:readFor(sixth)});await beforeUpdate.promise;await excludeHttp(sixth);releaseUpdate.resolve();await identifying;
 const final=await db.productCapture.findUnique({where:{id:sixth.capture.id}});assert.ok(final.excludedAt);assert.equal(await stock(sixth),0);assert.equal((await movements(sixth)).length,0);
 console.log(JSON.stringify({case:'late_identification_persistence',status:final.status,excluded:!!final.excludedAt,stock:await stock(sixth)}));
 assert.equal(final.status,'descartado','Late recognition must not overwrite the persisted discarded status.');
 console.log('PASS late identification cannot overwrite discarded state.');
 const seventh=await fixture(),beforeClose=pause(),releaseClosed=pause(),closedIdentify=realIdentify(seventh,{beforeUpdate:beforeClose,releaseUpdate:releaseClosed});
 const closingIdentify=closedIdentify(seventh.capture.id,photo,seventh.ps.barcode,{photoRevision:'1',ocrText:'PUMA RACE001 BR 41',serverRead:readFor(seventh)});await beforeClose.promise;
 await db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${seventh.round.id} FOR UPDATE`;await tx.stocktakeRound.update({where:{id:seventh.round.id},data:{status:'cancelled',activeReplacementStoreId:null},select:{id:true}});});
 const beforeFinal=await db.productCapture.findUnique({where:{id:seventh.capture.id}});releaseClosed.resolve();await closingIdentify;const afterFinal=await db.productCapture.findUnique({where:{id:seventh.capture.id}});assert.deepEqual(afterFinal,beforeFinal);assert.equal(await stock(seventh),0);
 console.log('PASS closed round rejects late recognition persistence without changing its capture.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await queue.stopAll();await db.$disconnect();});
