'use strict';
const assert=require('node:assert/strict');
const proof=require('../src/services/scannerRepeatConfirmation'),photos=require('../src/services/scannerCapturePhoto');
const initialKey=process.env.JWT_SECRET;
const key='isolated-repeat-confirmation-test-key-not-production';
const capture={id:'capture-a',roundId:'round-a',storeId:'store-a',scanKey:'round-a:scan-key-a',sellerId:'seller-a',sellerName:'Original',createdAt:new Date('2026-11-09T19:00:00.000Z'),
 barcode:'0196989405971',photo:'data:image/png;base64,b3JpZ2luYWw=',note:'etiqueta '+('x'.repeat(440))+'\n[scanner-photo-revision:1]',status:'pendente',bipeId:null};
let row={...capture},count=1,updates=0;
const tx={stocktakeRound:{findUnique:async()=>({operationType:'replacement',status:'counting',storeId:capture.storeId})},
 store:{findUnique:async()=>({active:true})},user:{findUnique:async()=>({id:capture.sellerId,role:'seller',active:true,storeId:capture.storeId})},
 stocktakeBipe:{count:async()=>count},$queryRaw:async()=>[],productCapture:{findUnique:async()=>({...row}),update:async({data})=>{updates++;row={...row,...data};return {...row};}}};
const input={actorId:capture.sellerId,confirmedCount:1,photo:capture.photo,photoRevision:'1',barcode:capture.barcode};
(async()=>{try{
 process.env.JWT_SECRET=key;
 assert.equal(proof.confirmed(capture,1),null,'old saved photos contain no inferred approval');
 for(const value of [undefined,null,true,0,-1,1.5,'bad','1x',Infinity])assert.equal(await proof.record(tx,capture,{...input,confirmedCount:value}),capture);
 assert.equal(updates,0);
 const saved=await proof.record(tx,capture,input);
 assert.ok(saved.note.length<=480);assert.equal(photos.revisionOf(saved.note),'1');assert.equal(saved.photo,capture.photo);
 assert.equal(proof.confirmed(saved,1).actorId,capture.sellerId);assert.equal(proof.confirmed(saved,2),null,'count must still match when recovery creates the event');
 const rewritten={...saved,note:photos.photoNote(saved.note,'etiqueta '+('y'.repeat(1000)))};
 assert.equal(rewritten.note.length,480);assert.ok(proof.confirmed(rewritten,1));assert.doesNotMatch(photos.visibleNote(rewritten.note),/scanner-repeat|scanner-photo/);
 const revised={...saved,note:photos.photoNote(saved.note,'New revision','2')};assert.equal(proof.marker(revised.note),'');assert.equal(proof.confirmed(revised,1),null);
 for(const changes of [{id:'other'},{roundId:'other'},{storeId:'other'},{scanKey:'other'},{sellerId:'other'},{sellerName:'Other'},
  {createdAt:new Date('2026-11-09T19:00:01.000Z')},{excludedAt:new Date()},{status:'descartado'},
  {barcode:'5901234123457'},{photo:'data:image/png;base64,bmV3'},
  {note:saved.note.replace('confirmed-v1:1:','confirmed-v1:2:')},
  {note:saved.note.replace(/([a-f0-9]{64})\]/,'0'.repeat(64)+']')},
  {note:saved.note+proof.marker(saved.note)},
  {note:saved.note.slice(0,150)+'\n[scanner-photo-revision:1]'}])assert.equal(proof.confirmed({...saved,...changes},1),null,JSON.stringify(changes));
 assert.ok(proof.confirmed({...saved,barcode:'196989405971'},1),'UPC/EAN aliases preserve exact barcode identity');
 process.env.JWT_SECRET='rotated-repeat-confirmation-test-key';assert.equal(proof.confirmed(saved,1),null,'rotation rejects old signatures safely');
 delete process.env.JWT_SECRET;assert.equal(proof.confirmed(saved,1),null);
 await assert.rejects(()=>proof.record(tx,capture,input),e=>e.status===503);
 process.env.JWT_SECRET=key;
 for(const changes of [{actorId:'other'},{photo:'changed'},{photoRevision:'0'},{barcode:'5901234123457'}])await assert.rejects(()=>proof.record(tx,capture,{...input,...changes}),e=>[403,409].includes(e.status));
 count=2;assert.equal(await proof.record(tx,capture,input),capture,'stale confirmation is not archived');
 const staleBefore=updates;count=1;await assert.rejects(()=>proof.record(tx,{...capture,excludedAt:new Date()},input),e=>e.status===409);assert.equal(updates,staleBefore);
 const hash=require('node:crypto').createHash;
 const manifestText=JSON.stringify({source:'explicit-owner-chat-confirmation-v1',executor:'system-maintenance',operationId:'isolated-owner-review',confirmedBy:'Test owner',userStatement:'These exact test captures are separate physical pairs',targets:[{
  captureId:capture.id,roundId:capture.roundId,storeId:capture.storeId,scanKey:capture.scanKey,sellerId:capture.sellerId,sellerName:capture.sellerName,
  barcode:capture.barcode,photoDataUrlSha256:hash('sha256').update(capture.photo).digest('hex'),photoRevision:'1',createdAt:capture.createdAt.toISOString()}]});
 const ownerSaved=await proof.recordOwnerReview(tx,capture,{manifestText});
 assert.ok(ownerSaved.note.length<=480);assert.equal(proof.confirmed(ownerSaved,1).source,'explicit-owner-chat-confirmation-v1');
 assert.equal(proof.confirmed(ownerSaved,7).source,'explicit-owner-chat-confirmation-v1','explicit finite capture approval is not converted into mutable-count approval');
 assert.equal(proof.confirmed({...ownerSaved,id:'unapproved-capture'},7),null);
 assert.equal(proof.confirmed({...ownerSaved,scanKey:'another-key'},7),null);
 assert.equal(proof.confirmed({...ownerSaved,note:ownerSaved.note.replace(/owner-v1:(\d+):(\d+):([a-f0-9]{64}):/,'owner-v1:$1:$2:'+('0'.repeat(64))+':')},1),null);
 assert.ok(proof.confirmed({...ownerSaved,note:photos.photoNote(ownerSaved.note,'long '+('a'.repeat(1000)))},7));
 await assert.rejects(()=>proof.recordOwnerReview(tx,{...capture,id:'unapproved-capture'},{manifestText}),e=>e.status===409);
 await assert.rejects(()=>proof.recordOwnerReview(tx,{...capture,photo:'other-photo'},{manifestText}),e=>e.status===409);
 for(const field of ['roundId','storeId','sellerId','sellerName','barcode','scanKey']){
  const changed=JSON.parse(manifestText);changed.targets[0][field]='foreign';
  await assert.rejects(()=>proof.recordOwnerReview(tx,capture,{manifestText:JSON.stringify(changed)}),e=>e.status===409);
 }
 row={...row,photo:'changed-after-preview'};
 await assert.rejects(()=>proof.recordOwnerReview(tx,capture,{manifestText}),e=>e.status===409);
 row={...ownerSaved};
 process.env.JWT_SECRET='rotated-repeat-confirmation-test-key';assert.equal(proof.confirmed(ownerSaved,1),null);process.env.JWT_SECRET=key;
 console.log('PASS explicit authenticated confirmation only; ID/context/photo/revision/code/count-bound HMAC, tampering/duplicate marker/truncation, note preservation, rotation/missing key fail closed, stale/foreign/excluded requests rejected.');
 console.log('PASS finite owner review uses distinct provenance, manifest-bound one-capture grant, survives count growth only for that approved ID and rejects copied/tampered/rotated proofs.');
 }finally{if(initialKey===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=initialKey;}
})().catch(e=>{console.error(e);process.exitCode=1});
