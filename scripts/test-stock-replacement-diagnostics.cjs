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
const { reasonText } = require('../src/services/stockReplacement');
const deferredReport={bipes:[{id:'deferred',applied:false,bipedAt:at}],captures:[{id:'deferred-photo',bipeId:'deferred'}],
 checks:[{bipeId:'deferred',reason:'ocr_timeout',reasonText:reasonText('ocr_timeout')}],movements:[]};
const nextAt='2026-11-09T18:05:00.000Z';
const deferredJob={jobId:'deferred-ack',captureId:'deferred-photo',state:'completed',reason:'ocr_timeout',autoReprocess:true,nextAttemptAt:nextAt,createdAt:at,attempts:1};
let deferred=build(deferredReport,{available:true,items:[deferredJob]},new Date(at));
assert.equal(deferred.rows[0].state,'processing','ACK with a committed later attempt is not a final review/error');
assert.match(deferred.rows[0].reason,/Aguardando reprocessamento automático/);
assert.match(deferred.rows[0].reason,/não foi aplicada ao estoque/);
assert.equal(deferred.rows[0].autoReprocess,true);
assert.equal(deferred.rows[0].nextAttemptAt,nextAt);
assert.equal(deferred.rows[0].appliedAt,null);
assert.equal(deferred.counts.applied,0);
assert.equal(deferred.totalRecords,1);
assert.deepEqual(deferred.rows[0].movementIds,[]);
const scheduled={...deferredJob,jobId:'new-pass',state:'created',reason:null,createdAt:'2026-11-09T18:00:01.000Z'};
deferred=build(deferredReport,{available:true,items:[scheduled,deferredJob]},new Date(at));
assert.equal(deferred.totalRecords,1,'ACK and later job are two attempts of the same piece');
assert.equal(deferred.counts.processing,1);
assert.match(deferred.rows[0].reason,/tempo disponível/,'the original timeout cause remains visible');
assert.match(deferred.rows[0].reason,/Aguardando reprocessamento automático/);
deferred=build(deferredReport,{available:true,items:[{...scheduled,state:'active'},deferredJob]},new Date(nextAt));
assert.match(deferred.rows[0].reason,/Reprocessamento automático em andamento/);
assert.doesNotMatch(deferred.rows[0].reason,/Aguardando reprocessamento/);
assert.equal(deferred.rows[0].nextAttemptAt,null,'an active pass no longer claims a future waiting time');
for(const state of ['failed','cancelled']){
 deferred=build(deferredReport,{available:true,items:[{...scheduled,state},deferredJob]},new Date(nextAt));
 assert.equal(deferred.rows[0].state,'review','a newer '+state+' job overrides an old automatic schedule');
 assert.equal(deferred.rows[0].autoReprocess,false);
 assert.doesNotMatch(deferred.rows[0].reason,/Aguardando reprocessamento automático/);
}
deferred=build(deferredReport,{available:true,items:[{...deferredJob,nextAttemptAt:'invalid'}]},new Date(at));
assert.equal(deferred.rows[0].state,'review','an invalid scheduling timestamp is not proof of a future attempt');
assert.equal(deferred.rows[0].nextAttemptAt,null);
const orphanDeferred=build({bipes:[],captures:[{id:'orphan-deferred',barcode:'same',createdAt:at}],checks:[],movements:[]},
 {available:true,items:[{...deferredJob,captureId:'orphan-deferred',reason:'photo_decode_memory_limit'}]},new Date(at));
assert.equal(orphanDeferred.totalRecords,1);
assert.equal(orphanDeferred.rows[0].bipeId,null);
assert.equal(orphanDeferred.rows[0].state,'processing');
assert.match(orphanDeferred.rows[0].reason,/memória/);
assert.match(orphanDeferred.rows[0].reason,/Aguardando reprocessamento automático/);
assert.equal(orphanDeferred.counts.applied,0,'an archived photo with deferred decoding does not imply a bipe or stock');
assert.doesNotMatch(reasonText('ocr_timeout'),/será tentada|Aguardando reprocessamento automático/,'a cause alone cannot promise a scheduled attempt');
assert.match(reasonText('queue_recheck_wait',{autoReprocess:true}),/Aguardando reprocessamento automático/);
for(const reason of ['ocr_timeout','ocr_memory_limit','photo_decode_timeout','photo_decode_memory_limit']){
 const message=reasonText(reason,{autoReprocess:true});
 assert.match(message,/Aguardando reprocessamento automático/);
 assert.match(message,/não foi aplicada ao estoque/);
}
const appliedDeferred={...deferredReport,bipes:[{...deferredReport.bipes[0],applied:true}],checks:[{...deferredReport.checks[0],appliedAt:at}]};
deferred=build(appliedDeferred,{available:true,items:[deferredJob]},new Date(at));
assert.equal(deferred.rows[0].state,'applied');assert.equal(deferred.rows[0].reason,null);assert.equal(deferred.rows[0].autoReprocess,false);
const excludedDeferred={...deferredReport,bipes:[{...deferredReport.bipes[0],excludedAt:at}]};
deferred=build(excludedDeferred,{available:true,items:[deferredJob]},new Date(at));
assert.equal(deferred.rows[0].state,'excluded');assert.equal(deferred.rows[0].autoReprocess,false);
console.log('PASS replacement diagnostics: linked events counted once, identical barcodes retained, reversal, queue attempts and server-only scope.');
console.log('PASS deferred diagnostics: committed automatic reprocessing stays pending without stock, latest failure wins, cause and valid next time preserved, active pass differs from waiting.');
