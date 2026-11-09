'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const capturePhotos=require('../src/services/scannerCapturePhoto'),policy=require('../public/scanner-barcode-policy');
const source=fs.readFileSync(require.resolve('../src/routes/stocktake'),'utf8');
const start=source.indexOf('async function garantirBipeDaCaptura('),end=source.indexOf('\n// Extrai o PRIMEIRO objeto',start);
assert.ok(start>=0&&end>start);
const original={id:'capture',roundId:'round',storeId:'store',scanKey:'round:client-1234',barcode:'0196989405971',sellerId:'seller',sellerName:'Original',photo:'original-photo',note:'',bipeId:'bipe',createdAt:new Date()};
async function run({initial=original,locked=initial,round={id:'round',storeId:'store',status:'counting'},expectedPhoto}={}){
 const calls=[];let reads=0,updates=0;
 const tx={async $queryRaw(strings,...values){calls.push({sql:strings.join('?'),values});return []},
  productCapture:{async findUnique(){calls.push({read:'capture'});return structuredClone(reads++===0?initial:locked)},async update(){updates++;}},
  stocktakeRound:{async findUnique(){return round}},
  productSize:{async findUnique(){return {id:'size',productId:'product',size:'41',product:{name:'Test',brand:'PUMA'}}}},
  stocktakeBipe:{async findUnique(){return {id:'bipe',roundId:locked?.roundId,storeId:locked?.storeId,productSizeId:'size',applied:false}},async update(){updates++;},async create(){updates++;return {id:'created'}}}};
 const context={prisma:{$transaction:fn=>fn(tx)},capturePhotos,barcodeVariants:policy.variants,applyBipeIfReady:async()=>({applied:false,reason:'pending'}),needsManualSize:()=>false,console,module:{exports:null}};
 vm.runInNewContext(source.slice(start,end)+'\nmodule.exports=garantirBipeDaCaptura;',context);
 const result=await context.module.exports('capture','product','size',original.barcode,expectedPhoto);
 return {result,calls,updates};
}
(async()=>{
 const valid=await run();assert.ok(valid.result);assert.equal(valid.updates,1);
 assert.equal(valid.calls[0].read,'capture');assert.match(valid.calls[1].sql,/StocktakeRound.*FOR SHARE/);
 assert.match(valid.calls[2].sql,/ProductCapture.*FOR UPDATE/);assert.equal(valid.calls[3].read,'capture');
 const historical={...original,roundId:null,scanKey:null};const legacy=await run({initial:historical});assert.ok(legacy.result);
 assert.equal(legacy.calls.filter(c=>c.sql?.includes('StocktakeRound')).length,0);assert.match(legacy.calls[1].sql,/ProductCapture.*FOR UPDATE/);
 for(const mutation of [
  {roundId:'different-round'},{storeId:'different-store'},{scanKey:'round:other-1234'},
  {barcode:'0196989405988'},{sellerId:'different-seller'},{sellerName:'Changed'},
  {photo:'different-photo'},{note:capturePhotos.photoNote('','Saved','2')},
  {excludedAt:new Date()},{status:'descartado'}]){
  const changed=await run({locked:{...original,...mutation}});assert.equal(changed.result,null,JSON.stringify(mutation));assert.equal(changed.updates,0);
 }
 const movedLegacy=await run({initial:historical,locked:original});assert.equal(movedLegacy.result,null);assert.equal(movedLegacy.updates,0);
 for(const round of [null,{id:'round',storeId:'different-store',status:'counting'},{id:'round',storeId:'store',status:'closed'}]){
  const rejected=await run({round});assert.equal(rejected.result,null);assert.equal(rejected.updates,0);
 }
 const missing=await run({initial:null});assert.equal(missing.result,null);assert.equal(missing.calls.filter(c=>c.sql).length,0);
 const removed=await run({locked:null});assert.equal(removed.result,null);assert.equal(removed.updates,0);
 const revision={...original,note:capturePhotos.photoNote('','Saved','1')};
 const stalePhoto=await run({initial:revision,expectedPhoto:{photo:'old-photo',photoRevision:'1'}});assert.equal(stalePhoto.result,null);
 const noBipe=await run({initial:{...revision,bipeId:null}});assert.equal(noBipe.result,null);assert.equal(noBipe.updates,0);
 console.log('PASS late capture linking locks round before capture, revalidates every context/photo revision after locks, rejects stale/conflicting contexts and preserves legacy no-round behavior.');
})().catch(error=>{console.error(error);process.exitCode=1});
