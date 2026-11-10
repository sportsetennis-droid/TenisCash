'use strict';
const assert=require('node:assert/strict');
const {readWords,readParts}=require('../src/services/scannerArchivedLabel');
const word=(text,confidence,x0,y0,x1,y1)=>({text,confidence,bbox:{x0,y0,x1,y1}});
const data=words=>({text:words.map(w=>w.text).join(' '),blocks:[{paragraphs:[{lines:[{words}]}]}]});
// Measured original-photo words: both model/colour are confidence92; BR34 is
// independently readable. The distant tall J is confidence46 packaging noise.
const pair=[word('107950',92,502,348,573,365),word('03',92,580,348,603,364)];
const size=[word('BR',96,992,465,1013,478),word('34',95,993,497,1041,531)];
const originalNoise=word('J',46,335,344,355,414);
const recovered=readWords(data([...pair,...size,originalNoise]));
assert.equal(recovered.size,'34');assert(recovered.references.includes('10795003'));
assert.deepEqual(readParts(data([...pair,...size,originalNoise])).numericColourReferences,['10795003']);

// Do not broadly weaken scale guards: only weak distant horizontal noise loses
// the enlarged radius. Confidence thresholds for the actual pair stay intact.
for(const [name,scale] of [
 ['same distant large scale when reliable',{...originalNoise,confidence:92}],
 ['large reliable scale100px to the right',word('UK',92,703,331,733,381)],
 ['nearby large weak scale',word('J',46,613,344,633,414)],
 ['weak large scale above the colour',word('US',46,582,264,602,334)],
 ['weak large scale below the colour',word('US',46,582,378,602,448)],
])assert(!readParts(data([...pair,...size,scale])).numericColourReferences.includes('10795003'),name+' must still veto joining');
assert(!readParts(data([{...pair[0],confidence:74},pair[1],...size])).numericColourReferences.length);
assert(!readParts(data([pair[0],{...pair[1],confidence:74},...size])).numericColourReferences.length);
assert.equal(readWords(data([...pair,originalNoise])),null,'A complete reference never invents an absent BR');

// Puma09's free text is not trustworthy word evidence. This regression must
// not promote its confidence63 model merely because the text looks complete.
const partial=readWords(data([word('10795201',63,830,841,954,869),word('368889',90,1091,1026,1207,1060),
 word('BR',96,1500,1000,1540,1030),word('36',95,1550,1000,1590,1030)]));
assert.equal(partial.size,'36');assert(!partial.references.includes('10795201'));assert(partial.references.includes('368889'));
console.log('PASS: measured remote weak scale noise no longer blocks10795003/BR34; strong/nearby/column scales, pair confidence and incomplete Puma09 evidence stay guarded.');
