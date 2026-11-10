'use strict';
// A "not read" label answer carries every literal BR, printed brand and conflict
// seen in this photo, so a confirmed scan code can never hide a contradiction.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createProcessor}=require('../src/services/scannerImageProcessor');
const image=fs.readFileSync(path.join(__dirname,'fixtures/brand-labels/puma-34-1.jpg'));
const CODE='4065452961234';
function processor({branded=null,texts=[''],parts=()=>({})}={}){
 let n=0;
 return createProcessor({decode:async()=>[CODE],readPositions:async()=>[],
  brandReader:async()=>branded,
  createWorker:async()=>({setParameters:async()=>{},recognize:async()=>({data:{text:texts[Math.min(n++,texts.length-1)],blocks:[]}}),terminate:async()=>{}}),
  readParts:data=>({references:[],...parts(data)}),readWords:()=>null});
}
(async()=>{
 let r=await processor().run('label',image,CODE);
 assert.equal(r.pending,true);assert.equal(r.ocrConflict,false);assert.deepEqual(r.observedSizes,[]);assert.deepEqual(r.printedBrands,[]);assert.deepEqual(r.decodedBarcodes,[CODE]);
 r=await processor({branded:{reason:'reference_not_read',brand:'PUMA',literalSize:'41'}}).run('label',image,CODE);
 assert.equal(r.ocrConflict,false);assert.deepEqual(r.observedSizes,['41'],'Brand reader BR without reference is kept');assert.deepEqual(r.printedBrands,['PUMA']);
 r=await processor({branded:{reason:'br_not_read',brand:'PUMA',literalSizes:['42']}}).run('label',image,CODE);
 assert.deepEqual(r.observedSizes,['42'],'BR of the other anchor is kept');
 r=await processor({branded:{reason:'variants_disagree',brand:'PUMA'}}).run('label',image,CODE);
 assert.equal(r.ocrConflict,true,'Brand reader conflict is reported');
 r=await processor({texts:['PUMA something NIKE']}).run('label',image,CODE);
 assert.deepEqual(r.printedBrands.sort(),['NIKE','PUMA'],'Printed brands of every pass are reported');
 r=await processor({parts:()=>({conflict:true})}).run('label',image,CODE);
 assert.equal(r.ocrConflict,true,'Two BR scales on the photo are a conflict');
 r=await processor({parts:()=>({size:'40'})}).run('label',image,CODE);
 assert.deepEqual(r.observedSizes,['40']);assert.equal(r.ocrConflict,false);
 console.log('PASS: not-read label answers keep literal BR (generic and brand reader), printed brands and conflicts.');
})().catch(e=>{console.error(e);process.exitCode=1});
