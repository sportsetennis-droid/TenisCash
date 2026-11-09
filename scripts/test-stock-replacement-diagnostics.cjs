'use strict';
const assert = require('node:assert/strict');
const { build } = require('../src/services/stockReplacementDiagnostics');
const at='2026-11-09T18:00:00.000Z';
const report={bipes:[{id:'a',barcode:'same',applied:true,bipedAt:at},{id:'b',barcode:'same',applied:false,bipedAt:at},{id:'c',excludedAt:at}],
 captures:[{id:'pa',bipeId:'a'},{id:'pb',bipeId:'b'},{id:'pc',bipeId:'c'},{id:'orphan',createdAt:at}],
 checks:[{bipeId:'a',appliedAt:at},{bipeId:'b',reason:'photo_size_or_reference_pending',reasonText:'BR pendente'}],
 movements:[{id:'move-a',metadata:{bipeId:'a'}}]};
let r=build(report,{available:true,items:[{jobId:'j1',bipeId:'a',state:'completed',attempts:2},{jobId:'j2',captureId:'orphan',state:'active',attempts:1}]},new Date('2026-11-09T18:01:00Z'));
assert.equal(r.totalRecords,4);assert.deepEqual(r.counts,{processing:1,review:1,applied:1,excluded:1});
assert.equal(Object.values(r.counts).reduce((a,b)=>a+b,0),r.totalRecords);
assert.equal(r.rows.filter(x=>x.barcode==='same').length,2,'same barcode is two physical events');
assert.deepEqual(r.rows.find(x=>x.bipeId==='a').movementIds,['move-a']);
assert.equal(r.rows.find(x=>x.bipeId==='b').reason,'BR pendente');
assert.equal(r.oldestPendingSeconds,60);
report.checks[0].reversedAt=at;r=build(report,{available:false,items:[]},new Date(at));
assert.equal(r.counts.applied,0);assert.equal(r.counts.excluded,2);assert.equal(r.queue.available,false);
assert.equal(r.scope,'server');assert.equal(r.counts.local,undefined,'server cannot invent phone-only photos');
assert.equal(build({bipes:[],captures:[],checks:[],movements:[]}).totalRecords,0);
const terminal=build({bipes:[{id:'late',applied:false}],captures:[{id:'late-photo',bipeId:'late',status:'processando'}],checks:[],movements:[]},
 {available:true,items:[{jobId:'terminal',captureId:'late-photo',state:'completed',reason:'photo_barcode_conflict',attempts:1}]});
assert.equal(terminal.counts.review,1);assert.equal(terminal.counts.processing,0);
assert.equal(terminal.rows[0].reason,'A foto não permitiu confirmar um único código de barras.');
console.log('PASS replacement diagnostics: linked events counted once, identical barcodes retained, reversal, queue attempts and server-only scope.');
