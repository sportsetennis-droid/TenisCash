'use strict';
// Código já conferido: a later piece with a code already confirmed on its own box
// photo enters automatically; every conflict keeps it pending.
const assert=require('node:assert/strict');
const ledger=require('../src/services/storeStockLedger');
const movements=[];
ledger.applyStoreStockDelta=async(tx,data)=>{movements.push(data);return {stockAfter:movements.length};};
const service=require('../src/services/stockReplacement');
require('../src/services/stockReplacementImages').check=async()=>{};

const CODE='4065452961234',SIZE='ps-puma-40',PRODUCT='p-puma';
function world(){
 const product={id:PRODUCT,active:true,name:'TENIS PUMA SMASH',category:'Tênis',ncm:'64041100',brand:'PUMA',sku:'390987',aiContext:{}};
 const size={id:SIZE,productId:PRODUCT,size:'40',barcode:CODE,product};
 const round={id:'r27',number:27,operationType:'replacement',storeId:'s4',status:'counting'};
 const bipe={id:'b-new',roundId:'r27',storeId:'s4',barcode:CODE,found:true,duplicate:false,productId:PRODUCT,productSizeId:SIZE};
 const capture={id:'c-new',bipeId:'b-new',roundId:'r27',storeId:'s4',scanKey:'k',sellerId:'u',barcode:CODE,note:'',photo:'data:image/jpeg;base64,dGVzdA=='};
 const w={product,size,round,bipe,capture,owners:[{id:SIZE,product:{active:true}}],
  others:[{id:'b-old',barcode:CODE}],
  checks:[{bipeId:'b-old',appliedAt:new Date(),reversedAt:null,reason:null,appliedProductSizeId:SIZE,
   evidence:{source:'archived-photo-assistant-review-manufacturer-label-v1',productSizeId:SIZE,productId:PRODUCT,size:'40',barcode:CODE,reference:'390987-01'}}],
  saved:null};
 const db={
  $queryRaw:async()=>[],
  $transaction:async fn=>fn(db),
  productSize:{findMany:async()=>w.owners,findUnique:async()=>w.size},
  stocktakeBipe:{findMany:async()=>w.others,findUnique:async()=>w.bipe,update:async()=>({})},
  stocktakeRound:{findUnique:async()=>w.round},
  productCapture:{findFirst:async()=>w.capture,update:async()=>({})},
  stockReplacementCheck:{findMany:async()=>w.checks,findUnique:async()=>null,upsert:async a=>{w.saved=a.create;return a.create;},
   createMany:async()=>{},updateMany:async()=>{}},
 };
 w.db=db;return w;
}
const c=w=>({bipe:w.bipe,round:w.round,capture:w.capture,size:w.size});
const pendingRead=(extra={})=>({pending:true,reason:'photo_size_or_reference_pending',decodedBarcodes:[CODE],observedSizes:[],...extra});

(async()=>{
 // 1. Confirmation found.
 let w=world();
 const found=await service.confirmedCode(w.db,c(w));
 assert.deepEqual(found.bipeIds,['b-old']);assert.equal(found.reference,'390987-01');

 // 2. The photo read must carry this code and no different BR.
 assert.equal(service.confirmedCodeRead(c(w),pendingRead()),true);
 assert.equal(service.confirmedCodeRead(c(w),pendingRead({observedSizes:['40']})),true);
 assert.equal(service.confirmedCodeRead(c(w),pendingRead({observedSizes:['41']})),false,'A different literal BR on this photo blocks');
 assert.equal(service.confirmedCodeRead(c(w),pendingRead({observedSizes:['40','41']})),false,'Contradictory BR on this photo blocks');
 assert.equal(service.confirmedCodeRead(c(w),pendingRead({observedSizes:undefined})),false,'Unknown OCR content blocks');
 assert.equal(service.confirmedCodeRead(c(w),pendingRead({decodedBarcodes:[]})),false,'The photo must decode the code');
 assert.equal(service.confirmedCodeRead(c(w),pendingRead({decodedBarcodes:[CODE,'7891234567895']})),false,'Two codes on the photo block');
 assert.equal(service.confirmedCodeRead(c(w),pendingRead({decodedBarcodes:['7891234567895']})),false,'Another code blocks');
 assert.equal(service.confirmedCodeRead(c(w),pendingRead({reason:'photo_barcode_conflict'})),false);
 assert.equal(service.confirmedCodeRead(c(w),{source:'archived-photo-local-ocr-v1',size:'40',references:['X'],decodedBarcodes:[CODE],text:'PUMA'}),true,'Literal matching BR with unmatched reference');
 assert.equal(service.confirmedCodeRead(c(w),{source:'archived-photo-local-ocr-v1',size:'40',references:['X'],decodedBarcodes:[CODE],text:'NIKE'}),false,'Another printed brand blocks');

 // 3. Conflicts keep the piece pending.
 w=world();w.checks[0].appliedProductSizeId='ps-other';assert.equal(await service.confirmedCode(w.db,c(w)),null,'Code confirmed as another variant');
 w=world();w.checks.push({bipeId:'b-x',appliedAt:new Date(),reversedAt:null,appliedProductSizeId:'ps-other',evidence:{}});w.others.push({id:'b-x',barcode:CODE});
 assert.equal(await service.confirmedCode(w.db,c(w)),null,'Any confirmation of another variant blocks');
 w=world();w.checks.push({bipeId:'b-y',appliedAt:null,reversedAt:null,reason:'tamanho_da_foto_divergente',evidence:{}});w.others.push({id:'b-y',barcode:CODE});
 assert.equal(await service.confirmedCode(w.db,c(w)),null,'A box of this code with a different BR blocks');
 w=world();w.owners.push({id:'ps-twin',product:{active:true}});assert.equal(await service.confirmedCode(w.db,c(w)),null,'Two active variants own the code');
 w=world();w.owners.push({id:'ps-old',product:{active:false}});assert.ok(await service.confirmedCode(w.db,c(w)),'Inactive old variant does not block');
 w=world();w.checks[0].reversedAt=new Date();assert.equal(await service.confirmedCode(w.db,c(w)),null,'Reversed confirmation is no basis');
 w=world();w.checks[0].evidence.size='41';assert.equal(await service.confirmedCode(w.db,c(w)),null,'Confirmed with another size');
 w=world();w.checks[0].evidence.source=service.CONFIRMED_CODE;assert.equal(await service.confirmedCode(w.db,c(w)),null,'Derived applications are never a basis');
 w=world();w.checks[0].evidence.source='durable-queue';assert.equal(await service.confirmedCode(w.db,c(w)),null,'Only archived-photo evidence counts');
 w=world();w.others=[];assert.equal(await service.confirmedCode(w.db,c(w)),null,'Never confirmed');
 w=world();w.others=[{id:'b-old',barcode:'0'+CODE}];assert.ok(await service.confirmedCode(w.db,c(w)),'Leading-zero alias of the same code counts');
 w=world();w.bipe.barcode='12345';assert.equal(await service.confirmedCode(w.db,c(w)),null,'Not a scan code');

 // 4. End to end: an unreadable label with a confirmed code enters once, with its evidence.
 w=world();movements.length=0;
 let r=await service.check(w.db,'b-new',{read:pendingRead({observedSizes:['40']})});
 assert.equal(r.applied,true);assert.equal(movements.length,1);assert.equal(movements[0].quantity,1);assert.equal(movements[0].productSizeId,SIZE);
 assert.equal(w.saved.evidence.source,service.CONFIRMED_CODE);assert.deepEqual(w.saved.evidence.confirmedBy.bipeIds,['b-old']);
 assert.equal(w.saved.evidence.reference,'390987-01');assert.equal(w.saved.appliedProductSizeId,SIZE);

 // 5. End to end: a conflict stays pending and moves nothing.
 w=world();movements.length=0;w.checks[0].appliedProductSizeId='ps-other';
 r=await service.check(w.db,'b-new',{read:pendingRead()});
 assert.equal(r.applied,false);assert.equal(r.reason,'photo_size_or_reference_pending');assert.equal(movements.length,0);
 w=world();movements.length=0;
 r=await service.check(w.db,'b-new',{read:pendingRead({observedSizes:['41']})});
 assert.equal(r.applied,false);assert.equal(movements.length,0);
 w=world();movements.length=0;w.bipe.duplicate=true;
 r=await service.check(w.db,'b-new',{read:pendingRead()});
 assert.equal(r.applied,false);assert.equal(movements.length,0,'Repeated code still needs its own confirmation flow');

 // 6. A forged confirmed-code read is rechecked inside the transaction.
 w=world();movements.length=0;w.others=[];
 r=await service.applyVerified(w.db,c(w),{source:service.CONFIRMED_CODE,size:'40',decodedBarcodes:[CODE],references:[]},'X');
 assert.equal(r.applied,false);assert.equal(movements.length,0);
 console.log('PASS: confirmed scan code enters automatically once with its basis recorded; other variant, other BR, two codes, derived basis, reversal, ambiguity and forged reads stay pending.');
})().catch(error=>{console.error(error);process.exitCode=1});
