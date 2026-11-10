'use strict';
const assert=require('node:assert/strict');
const {readParts,readWords}=require('../src/services/scannerArchivedLabel');
const word=(text,confidence,x0,y0,x1,y1)=>({text,confidence,bbox:{x0,y0,x1,y1}});
const data=words=>({text:words.map(w=>w.text).join(' '),blocks:[{paragraphs:[{lines:[{words}]}]}]});
const copy=words=>structuredClone(words);
// Measured original-photo words, Puma10794201 / BR38. EUR40 belongs to EUR,
// even though both40 and38 fall in the broad candidate column around BR.
const original=[word('107942',93,390,373,494,406),word('01',93,503,383,532,406),
 word('EUR',96,1048,403,1087,419),word('6.5',96,918,443,993,484),word('40',96,1046,441,1105,481),
 word('us',94,916,533,940,550),word('BR',96,1043,531,1067,546),word('38',96,1042,565,1100,604)];
const enhanced=[word('107942',96,651,633,823,677),word('01',96,839,639,887,678),
 word('UK',96,1530,675,1574,702),word('EUR',96,1747,672,1812,699),word('6.5',95,1530,739,1655,807),
 word('40',95,1744,736,1841,801),word('Us',88,1527,889,1567,916),word('BR',96,1739,885,1779,910),
 word('7.5',96,1532,947,1653,1013),word('38',96,1738,942,1833,1007)];
for(const words of [original,enhanced]){
 const parsed=readWords(data(copy(words)));assert.equal(parsed?.size,'38');assert(parsed.references.includes('10794201'));
 for(const missing of ['38','BR'])assert.equal(readWords(data(copy(words).filter(w=>w.text!==missing))),null,'Missing own BR/value must not borrow EUR40');
 for(const weak of ['38','BR']){const changed=copy(words);changed.find(w=>w.text===weak).confidence=74;assert.equal(readWords(data(changed)),null);}
 const ambiguous=copy(words).filter(w=>w.text!=='EUR');assert.equal(readWords(data(ambiguous)),null,'Two unowned values remain ambiguous');
 const weakEUR=copy(words);weakEUR.find(w=>w.text==='EUR').confidence=74;
 assert.equal(readWords(data(weakEUR)),null,'Unreliable foreign scale cannot eliminate a competing value');
}
// Foreign labels can occur after their own number. A distant/low-confidence
// label cannot win just because its text names a known scale.
const after=copy(original);after.find(w=>w.text==='EUR').bbox={x0:1060,y0:490,x1:1090,y1:510};
assert.equal(readWords(data(after))?.size,'38');
const duplicate=copy(original);duplicate.push(word('BR',96,1400,531,1424,546),word('38',96,1400,565,1458,604));
assert.equal(readWords(data(duplicate)),null,'Two labels never become one box');

// OCR boxes use integer pixels. Measured23px colour/33px model differs from
// the minimum ratio by0.1px. Adjacent22px, remote, another row and weak colour
// remain rejected; the literal field still cannot use a scale-owned number.
const pair=original.slice(0,2),reference=words=>(readParts(data(words)).numericColourReferences||[]);
assert.deepEqual(reference(copy(pair)),['10794201']);
for(const mutate of [
 words=>{words[1].bbox.y0=384;},
 words=>{words[1].confidence=74;},
 words=>{words[0].confidence=74;},
 words=>{words[1].bbox.x0+=100;words[1].bbox.x1+=100;},
 words=>{words[1].bbox.y0+=30;words[1].bbox.y1+=30;},
 words=>words.push(word('US',96,540,383,570,406)),
 words=>words.push(word('02',96,538,383,567,406)),
]){const words=copy(pair);mutate(words);assert.deepEqual(reference(words),[]);}
console.log('PASS: measured original/enhanced Puma38 ignores EUR40 ownership; missing/weak/ambiguous BR, foreign-scale confidence, two labels and numeric colour geometry stay guarded.');
