'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const capturePhotos=require('../src/services/scannerCapturePhoto');
const route=fs.readFileSync(require.resolve('../src/routes/stocktake'),'utf8');
const start=route.indexOf('async function processarEtiqueta('),end=route.indexOf('\n// Automatic recognition',start);
assert.ok(start>=0&&end>start);
const original={id:'capture',roundId:'round',storeId:'store',scanKey:'round:scan',barcode:'7898707779915',sellerId:'seller',
  photo:'original-photo',bipeId:'bipe',status:'processando',matchedProductId:null,note:capturePhotos.photoNote('','Foto salva','1')};
async function run({applied=false,check=null,match={reason:'reference_not_found'},operationType='replacement'}={}){
  let writes=0,enqueued=0,checkReads=0;
  const calls=[];
  const current={...original,status:'vinculado',matchedProductId:'confirmed-product',
    note:capturePhotos.photoNote(original.note,'etiqueta Conferência manual do tamanho 40/41'),resolvedAt:'2026-11-09T22:00:00.000Z'};
  const before=structuredClone(current);
  const tx={
    async $queryRaw(strings,...values){calls.push({sql:strings.join('?'),values});return [];},
    productCapture:{async findUnique(){calls.push({read:'capture'});return structuredClone(current);},
      async updateMany({data}){writes++;Object.assign(current,data);return {count:1};}},
    stocktakeRound:{async findUnique(){return {status:'counting',storeId:'store',operationType};}},
    stocktakeBipe:{async findUnique(){calls.push({read:'bipe'});return {applied};}},
    stockReplacementCheck:{async findUnique(){checkReads++;calls.push({read:'check'});return check;}},
  };
  const context={
    prisma:{productCapture:{async findUnique(){return structuredClone(original);}},async $transaction(fn){return fn(tx);}},
    capturePhotos,parseScannerText:()=>null,normalizeScannedSize:()=>null,
    barcodePolicy:{isInternalCode:()=>false},learnScannerBarcode:async()=>match,
    matchInternalBarcode:async()=>{throw Error('Unexpected internal lookup');},
    garantirBipeDaCaptura:async()=>null,scannerPendingMessage:()=> 'Foto pendente por resultado OCR antigo',
    replacement:{async enqueue(){enqueued++;}},console,module:{exports:null},
  };
  vm.runInNewContext(route.slice(start,end)+'\nmodule.exports=processarEtiqueta;',context);
  const result=await context.module.exports(original.id,original.photo,original.barcode,{photoRevision:'1',ocrText:''});
  return {result,writes,enqueued,current,before,calls,checkReads};
}
(async()=>{
  for(const state of [
    {applied:true,check:{appliedAt:'2026-11-09T22:00:00Z',reversedAt:null}},
    {applied:true,check:null},
    {applied:false,check:{appliedAt:'2026-11-09T22:00:00Z',reversedAt:null}},
    {applied:true,check:null,operationType:'count'},
  ]){
    for(const match of [{reason:'reference_not_found'},{reason:'size_conflict'},
      {reason:'matched',productId:'stale-product',productSizeId:'stale-size',name:'Old OCR'}]){
      const outcome=await run({...state,match});
      assert.equal(outcome.result?.vinculado,true);
      assert.equal(outcome.writes,0,'A completed application must retain its capture snapshot');
      assert.equal(outcome.enqueued,0,'Old OCR must not re-enqueue an already applied piece');
      assert.deepEqual(outcome.current,outcome.before,'Product link, status, note, photo revision and resolvedAt stay unchanged');
      const sql=outcome.calls.filter(call=>call.sql).map(call=>call.sql);
      assert.match(sql[0],/StocktakeRound.*FOR SHARE/);
      assert.match(sql[1],/ProductCapture.*FOR UPDATE/);
      assert.match(sql[2],/StocktakeBipe.*FOR UPDATE/);
      assert.ok(outcome.calls.findIndex(call=>call.read==='bipe')>outcome.calls.findIndex(call=>call.sql?.includes('StocktakeBipe')));
    }
  }
  for(const check of [null,{appliedAt:null,reversedAt:null},{appliedAt:'2026-11-09T22:00:00Z',reversedAt:'2026-11-09T22:01:00Z'}]){
    const pending=await run({applied:false,check});
    assert.equal(pending.writes,1,'Unapplied/reversed state follows existing pending update path');
    assert.equal(pending.current.status,'pendente');assert.equal(pending.current.matchedProductId,null);
    assert.equal(pending.enqueued,1);assert.equal(capturePhotos.revisionOf(pending.current.note),'1');
  }
  console.log('PASS late OCR after manual/verified application preserves capture link, status, note, timestamp and photo revision under round/capture/bipe locks; unapplied control still updates; no DB/OCR/network.');
})().catch(error=>{console.error(error);process.exitCode=1;});
