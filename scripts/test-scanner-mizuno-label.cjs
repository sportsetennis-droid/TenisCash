'use strict';
const assert=require('node:assert/strict');
const {readWords}=require('../src/services/scannerArchivedLabel');
const {createProcessor}=require('../src/services/scannerImageProcessor');
const word=(text,confidence,x0,y0,x1,y1)=>({text,confidence,bbox:{x0,y0,x1,y1}});
const data=words=>({text:words.map(w=>w.text).join(' '),blocks:[{paragraphs:[{lines:[{words}]}]}]});
// Measured word geometry from the complete original label, horizontal scale2.
// No private image or database/catalog data is embedded in this regression.
const measured=[word('101060060',93,2397,179,2690,228),word('ROSA46',89,2710,183,2939,230),word('36',96,2952,186,3024,231),
 word('BRA',96,1373,456,1498,492),word('36',95,1524,420,1658,493)];
const good=readWords(data(measured));assert.equal(good.size,'36');assert.ok(good.references.includes('101060060ROSA46'));
const simple=[word('101006006',92,100,100,280,140),word('STNDLA',91,295,100,410,140),word('BRA',95,100,300,160,335),word('37',95,175,295,215,336)];
assert.ok(readWords(data(simple)).references.includes('101006006STNDLA'),'Nine-digit model and adjacent literal colour need no invented punctuation');
assert.equal(readWords(data(measured.filter(w=>w.text!=='BRA'))),null,'Size in the model header cannot replace literal BRA');
const low=measured.map(w=>w.text==='ROSA46'?{...w,confidence:39}:w);
assert.ok(!readWords(data(low)).references.includes('101060060ROSA46'),'Low confidence colour never completes a reference');
const otherRow=measured.map(w=>w.text==='ROSA46'?word('ROSA46',89,2710,280,2939,327):w);
assert.ok(!readWords(data(otherRow)).references.includes('101060060ROSA46'),'Colour on another row is not attached');
const far=measured.map(w=>w.text==='ROSA46'?word('ROSA46',89,2900,183,3129,230):w);
assert.ok(!readWords(data(far)).references.includes('101060060ROSA46'),'A distant token cannot identify the colour');
for(const token of ['EUR42','BR36','CM24','UK8','SIZE']){
 const changed=measured.map(w=>w.text==='ROSA46'?{...w,text:token}:w);
 assert.ok(!readWords(data(changed))?.references.includes('101060060'+token),'A scale or size heading is not a colour: '+token);
}
const reordered=[word('101060060',93,100,100,280,140),word('46',92,295,100,330,140),word('ROSA',95,345,100,430,140),...simple.slice(2)];
assert.ok(!readWords(data(reordered)).references.includes('101060060ROSA46'),'Never reorder printed tokens to agree with a catalog');
const twoSizes=[...measured,word('BRA',95,800,700,900,740),word('37',95,920,700,980,740)];
assert.equal(readWords(data(twoSizes)),null,'Two literal Brazilian sizes remain ambiguous');
const twoColours=[...measured,word('101060060',92,100,700,280,740),word('AZUL46',91,295,700,410,740)];
assert.equal(readWords(data(twoColours)),null,'Two different complete model/colour references cannot choose the first box');
const mixedReferences=[...simple,word('101060060ROSA46',95,100,700,410,740)];
assert.equal(readWords(data(mixedReferences)),null,'A complete single OCR word must also conflict with a different split reference');
function fakeSharp(){return{angle:0,rotate(angle){this.angle=angle;return this},resize(options){this.options=options;return this},greyscale(){return this},normalize(){this.normalized=true;return this},png(){return this},async metadata(){return this.angle===90||this.angle===270?{width:1013,height:1800}:{width:1800,height:1013}},async toBuffer(){return Buffer.from(this.options?.fit==='fill'?'wide:'+JSON.stringify({...this.options,normalized:this.normalized===true}):'regular')}};}
(async()=>{
 let calls=0,wideCalls=0,parameters={},wideDimensions=[];
 const trigger=data(low.filter(w=>w.text!=='BRA'));
 const worker={async setParameters(p){parameters={...parameters,...p}},async recognize(bytes){calls++;if(bytes.toString().startsWith('wide:')){wideCalls++;wideDimensions.push(JSON.parse(bytes.toString().slice(5)));assert.equal(parameters.tessedit_pageseg_mode,'11');return{data:data(measured)}}return{data:trigger}},async terminate(){}};
 const processor=createProcessor({sharp:fakeSharp,readWords,decode:async()=>['7894756210898'],createWorker:async()=>worker});
 const result=await processor.run('label',Buffer.from('original'),'7894756210898');assert.equal(result.size,'36');assert.ok(result.references.includes('101060060ROSA46'));assert.equal(wideCalls,1);assert.equal(calls,5,'Four existing passes followed by one bounded full-frame pass');assert.ok(wideDimensions.every(x=>x.width*x.height<=4000000));assert.equal(wideDimensions[0].height,1013,'The whole original height is retained at this size');await processor.close();
 for(const wideData of [data(measured),data([]),data(measured.map(w=>w.text==='36'?{...w,text:'37'}:w))]){
  calls=0;wideCalls=0;
  worker.recognize=async bytes=>{calls++;if(bytes.toString().startsWith('wide:')){wideCalls++;return{data:wideData}}return{data:data(low)}};
  const partialProcessor=createProcessor({sharp:fakeSharp,readWords,decode:async()=>['7894756210898'],createWorker:async()=>worker});
  const partialResult=await partialProcessor.run('label',Buffer.from('original'),'7894756210898');
  assert.equal(wideCalls,wideData.text?1:2,'Literal BR with incomplete colour still gets bounded whole-frame attempts');
  if(wideData.text.includes('37'))assert.equal(partialResult.pending,true,'A changed literal BR across attempts cannot silently replace the earlier BR');
  else {assert.equal(partialResult.size,'36');assert.equal(partialResult.references.includes('101060060ROSA46'),!!wideData.text,'Failed extra attempt retains only the original partial evidence');}
  await partialProcessor.close();
 }
 for(const changedSize of [false,true]){
  calls=0;wideCalls=0;const wideOrder=[];
  worker.recognize=async bytes=>{calls++;if(bytes.toString().startsWith('wide:')){wideCalls++;const options=JSON.parse(bytes.toString().slice(5));wideOrder.push(options.normalized);assert.ok(options.width*options.height<=4000000);
    return{data:options.normalized?data(measured.map(w=>changedSize&&w.text==='36'?{...w,text:'37'}:w)):data(low)};}return{data:trigger}};
  const colorFallback=createProcessor({sharp:fakeSharp,readWords,decode:async()=>['7894756210898'],createWorker:async()=>worker});
  const fallback=await colorFallback.run('label',Buffer.from('original'),'7894756210898');assert.deepEqual(wideOrder,[false,true]);assert.equal(calls,6);
  if(changedSize)assert.equal(fallback.pending,true,'Colour/normalized BR disagreement remains pending');
  else {assert.equal(fallback.size,'36');assert.ok(fallback.references.includes('101060060ROSA46'),'Partial colour read must not bypass the normalized fallback');}
  await colorFallback.close();
 }
 calls=0;wideCalls=0;
 worker.recognize=async bytes=>{calls++;if(bytes.toString().startsWith('wide:'))wideCalls++;return{data:data(twoSizes)}};
 const ambiguous=createProcessor({sharp:fakeSharp,readWords,decode:async()=>['7894756210898'],createWorker:async()=>worker});
 const pending=await ambiguous.run('label',Buffer.from('original'),'7894756210898');assert.equal(pending.pending,true);assert.equal(wideCalls,2,'Never multiply stretch passes across four rotations');assert.equal(calls,18,'Sixteen existing passes plus at most two extra');await ambiguous.close();
 console.log('PASS: measured literal BRA/model/colour, nine-digit adjacent colour, wrong-scale/cross-line/low-confidence/conflicting-box rejection, up to two whole-frame attempts (colour then normalized) triggered even when initial colour is poor; <=4MP each.');
})().catch(error=>{console.error(error);process.exitCode=1;});
