'use strict';
const assert=require('node:assert/strict'),rounds=require('../src/services/stocktakeRounds');
(async()=>{
const base={id:'b',found:true,productId:'p',productSizeId:'s',productSize:'40',excludedAt:null};
const bipes=[{...base,barcode:'REF:HF6416-600/BR40'}];
const tx={$queryRaw:async()=>[],$executeRaw:async()=>0,stocktakeRound:{findUnique:async()=>({id:'r',storeId:'loja04',status:'review',baseline:[],startedAt:new Date('2026-01-01')})},stocktakeBipe:{findMany:async()=>bipes},productCapture:{findMany:async()=>[]},storeStock:{findMany:async()=>[],upsert:async()=>{throw Error('unexpected stock mutation')}},store:{findUnique:async()=>({id:'loja04'})},productSize:{findMany:async()=>[{id:'s',size:'40',product:{name:'Produto',sku:'ref',active:true}}]},storeStockMovement:{count:async()=>0}};
const db={$transaction:async fn=>fn(tx)};
let r=await rounds.roundReport(tx,'r');assert.equal(r.totals.total,1);assert.equal(r.totals.matched,1);assert.equal(r.totals.barcodePending,1);assert.equal(r.lines[0].counted,1);
await assert.rejects(rounds.finishRound(db,'r',r.reviewToken,true),/sem código de barras escaneado/);
bipes[0].barcode='0197862895278';r=await rounds.roundReport(tx,'r');assert.equal(r.totals.barcodePending,0);assert.equal(r.lines[0].counted,1);
assert.equal(rounds.summarize([{...base,barcode:'REF:X',excludedAt:new Date()}],[]).barcodePending,0);
assert.equal(rounds.summarize([{...base,barcode:'SEM GTIN'}],[]).barcodePending,1);
assert.equal(rounds.summarize([{...base,barcode:''}],[]).barcodePending,1);
console.log('PASS: reference-only scan remains counted, missing barcode blocks closure, recorded barcode clears requirement; excluded scans do not block.');
})().catch(e=>{console.error(e);process.exitCode=1});
