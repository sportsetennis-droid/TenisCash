'use strict';
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {readWords,readParts,target}=require('../src/services/scannerArchivedLabel');
const word=(text,x,y,width=40,confidence=96)=>({text,confidence,bbox:{x0:x,y0:y,x1:x+width,y1:y+25}});
const data=words=>({text:words.map(w=>w.text).join(' '),blocks:[{paragraphs:[{lines:[{words}]}]}]});
const reference=()=>word('SFBMUL-0998-V2',100,400,220);
let checks=0;
function check(words,expected,message){assert.equal(readWords(data(words))?.size||null,expected,message);checks++;}
for(const [first,last] of [['38','39'],['40','41'],['42','43']]){
 const pair=first+'/'+last,br=()=>word('BRA',100,100,50);
 check([br(),word(pair,170,100,90),reference()],pair,'A complete paired token is one BR variant');
 check([br(),word(first+'/',170,100,55),word(last,230,100),reference()],pair,'Slash attached to first number cannot discard that endpoint');
 check([br(),word(first,170,100),word('/'+last,215,100,55),reference()],pair,'Slash attached to second number cannot discard that endpoint');
 check([br(),word(first,170,100),word('/',215,100,10),word(last,230,100),reference()],pair,'Three adjacent literal tokens preserve the pair');
 check([word('BRA'+pair,100,100,170),reference()],pair,'A fused BR/pair word retains its literal scale');
 check([word('BR',100,100),word(pair,90,145,100),reference()],pair,'Vertical BR above the complete pair');
 check([word(pair,90,100,100),word('BR',110,145),reference()],pair,'Vertical pair above its literal BR');
 check([word('US',100,100),word(pair,170,100,100),reference()],null,'Foreign scale never becomes BR');
 check([br(),word(first,170,100),word(last,230,100),reference()],null,'No slash means no invented paired size');
 check([br(),word(first+'/',170,100,55,50),word(last,230,100),reference()],null,'Weak slash fragment cannot promote the surviving endpoint');
 check([br(),word(first,170,100,40,50),word('/',215,100,10),word(last,230,100),reference()],null,'Weak first endpoint keeps entire pair pending');
 check([br(),word(first,170,100),word('/',215,100,10,50),word(last,230,100),reference()],null,'Weak slash cannot split the pair');
 check([br(),word(first+'/',170,100,55),word(last,230,100,40,50),reference()],null,'Weak second endpoint keeps entire pair pending');
 check([br(),word(first,170,100),word('/',215,100,10),word(last,230,200),reference()],null,'No joining across lines or neighboring boxes');
 check([br(),word(pair,170,100,100),word('BRA',600,100,50),word(pair,670,100,100),reference()],null,'Two BR labels remain ambiguous even with the same paired size');
 check([br(),word(pair,170,100,100),word(first,100,150),reference()],null,'An extra nearby number remains ambiguous');
}
check([word('BR',100,100),word('US',160,100),word('10/11.5',210,100,100),reference()],null,'US fractional pairs are never Brazilian pairs');
check([word('SFBMUL-0998-V2-40/41',100,100,300)],null,'A size embedded in a reference cannot replace a literal BR field');
check([word('BR',100,100),word('40/41',230,100,100),word('EUR',175,100),reference()],null,'An intervening foreign scale still prevents size theft');
check([word('BRA',100,100),word('10/41',170,100,100),reference()],null,'Nonconsecutive OCR pair 10/41 cannot replace the actual 40/41 label');
check([word('BRA',100,100),word('10/',170,100,55),word('41',230,100),reference()],null,'Malformed split pair cannot promote its last endpoint');
for(const invalid of ['40/411','40/41/422','40/41.5','40/41X'])check([word('BRA',100,100),word(invalid,170,100,110),reference()],null,'A malformed complete token cannot yield a valid prefix: '+invalid);
for(const fragments of [
 [word('40/',170,100,55),word('41/42',230,100,90)],
 [word('39/40',170,100,90),word('/41',265,100,55)],
 [word('40/',170,100,55),word('41',230,100),word('/42',275,100,55)],
 [word('40',170,100),word('/41',215,100,55),word('/422',275,100,65)],
 [word('40/41',170,100,90),word('.5',265,100,30)],
 [word('40/41',170,100,90),word('/42',265,100,55,50)],
])check([word('BRA',100,100),...fragments,reference()],null,'A complete slash chain or fractional continuation cannot be truncated to one pair');
const partial=readParts(data([word('BRA',100,100,50),word('40/41',170,100,100)]));
assert.equal(partial.size,'40/41');assert.deepEqual(partial.references,[]);checks++;

(async()=>{
 const image=Buffer.from('synthetic paired-size photo'),sha256=createHash('sha256').update(image).digest('hex'),barcode='7898707779298';
 for(const size of ['40/41','42/43']){
  let description='SAPATILHA FIBER BRA '+size;
  const db={scanActionPhoto:{findUnique:async()=>({id:'photo',scanId:'scan',barcode,image,sha256,scan:{barcode,removed:false,lot:{status:'open'}}})},
   $queryRaw:async()=>[{id:'item',productId:'product',ean:barcode,supplierCode:'SFBMUL-0998-V2',description}],
   product:{findUnique:async()=>({id:'product',active:true,brand:'FIBER',sku:'SFBMUL-0998-V2',sizes:[]})}};
  const evidence={photoId:'photo',sha256,source:'archived-photo-local-ocr-v1',size,decodedBarcodes:[barcode],references:['SFBMUL0998V2'],text:'FIBER BRA '+size};
  assert.equal((await target(db,barcode,evidence)).size,size,'Verified archived photo retains the complete paired variant');checks++;
  description='SAPATILHA FIBER BR '+size.split('/')[1];
  assert.equal((await target(db,barcode,evidence)).reason,'size_conflict','Single endpoint in fiscal evidence is a conflict, not an alias of the pair');checks++;
  assert.equal((await target(db,barcode,{...evidence,sha256:'forged'})).reason,'photo_evidence_conflict','Paired size never bypasses original-photo hash validation');checks++;
  assert.equal((await target(db,barcode,{...evidence,source:'client-ocr'})).reason,'photo_evidence_conflict','Client text is not internal archived-photo evidence');checks++;
 }
 console.log('PASS: '+checks+' paired-size assertions; full/split literals, BR scale, adjacency/confidence, multiple labels, fiscal conflicts and original-photo evidence. No OCR/network/database used.');
})().catch(error=>{console.error(error);process.exitCode=1;});
