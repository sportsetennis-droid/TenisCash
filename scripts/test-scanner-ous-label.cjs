'use strict';
// Synthetic grammar/negative fixtures and separately recorded real OCR words.
// No OCR, decoder, database, network or production evidence is created here.
const assert=require('node:assert/strict');
const {readParts,readWords}=require('../src/services/scannerArchivedLabel');
const {createProcessor}=require('../src/services/scannerImageProcessor');
const real=require('./fixtures/scanner-ous-real-words.json');
let checks=0;
function check(ok,message){assert.ok(ok,message);checks++;}
const w=(text,x,y,width=40,confidence=96,height=25)=>({text,confidence,bbox:{x0:x,y0:y,x1:x+width,y1:y+height}});
const data=words=>({text:words.map(x=>x.text).join(' '),blocks:[{paragraphs:[{lines:[{words}]}]}]});
const br=()=>[w('BR',700,400),w('38',750,400)];
const field=(colour='123',model='350001',y=100)=>[w('Ref.:',20,y,65),w(model,100,y,100),w('-',208,y,10),w(colour,230,y,45)];
const has=(words,ref)=>readParts(data(words)).completeOusReferences?.includes(ref);
for(const colour of ['7','07','18','123']){
 const ref='350001'+colour;
 for(const words of [field(colour),[w('Ref.:350001',100,100,150),w('-',258,100,10),w(colour,280,100,45)],
  [w('350001',100,100,100),w('-',208,100,10),w(colour,230,100,45)],
  [w('Ref.:350001',100,100,150),w(colour,258,100,45)],
  [w('350001-'+colour,100,100,170)],[w('Ref.:350001 - '+colour,100,100,220)]]){
  check(has(words,ref),'Complete OUS literal field survives: '+words.map(x=>x.text));
  check(readWords(data([...words,...br()]))?.references.includes(ref),'Reference retains separate literal BR');
 }
}
for(const [name,words] of [
 ['bare six+one',[w('350001',100,100,100),w('7',208,100,20)]],
 ['bare six+three',[w('350001',100,100,100),w('123',208,100,45)]],
 ['uncontextual numeric token',[w('350001123',100,100,170)]],
 ['another numeric manufacturer',[w('107952',100,100,100),w('-',208,100,10),w('123',230,100,45)]],
 ['model weak',[w('Ref.:350001',100,100,150,74),w('123',258,100,45)]],
 ['colour weak',[...field().slice(0,3),w('123',230,100,45,74)]],
 ['dash weak',[...field().slice(0,2),w('-',208,100,10,74),w('123',230,100,45)]],
 ['prefix weak without dash',[w('Ref.:',20,100,65,74),w('350001',100,100,100),w('123',208,100,45)]],
 ['intervening weak text',[...field().slice(0,2),w('x',202,100,5,12),...field().slice(2)]],
 ['intervening weak prefix text',[w('Ref.',50,100,50),w('X',105,100,10,20),w('350046',120,100,100),w('7',225,100,20)]],
 ['different row',[...field().slice(0,3),w('123',230,160,45)]],
 ['remote colour',[...field().slice(0,3),w('123',600,100,45)]],
 ['extra slash',[...field(),w('/4',280,100,25,20)]],
 ['extra letter',[...field(),w('X',280,100,15)]],
 ['four digit suffix',[...field().slice(0,3),w('1234',230,100,55)]],
 ['suffix decimal',[...field().slice(0,3),w('123.5',230,100,60)]],
 ['whole token extra suffix',[w('Ref.:350001-123/4',100,100,240)]],
 ['scale owns number',[...field('7'),w('US',235,65,25)]],
 ['BR owns number',[...field('38'),w('BR',230,65,30)]],
])check(!(readParts(data(words)).completeOusReferences||[]).length,name+' cannot become complete OUS evidence');
for(const token of ['8/25.5CM','8/255CM','9.5/27.5CM','8 / 25,5 CM']){
 check(readWords(data([...br(),w('US',100,100,30),w(token,140,100,160)]))===null,'A split US/CM field is not a reference: '+token);
 check(readWords(data([...br(),w(token,100,100,180),...field('18','350044',220)]))?.references.includes('35004418'),'Real OUS reference survives foreign-scale exclusion');
}
for(const token of ['1011C017.402','220644/BKW','TFBU-WHITE-39','101056056AZLTQS','CM12901']){
 check(readWords(data([...br(),w(token,100,100,250)]))?.references.includes(token.replace(/[^A-Z0-9]/g,'')),'Other manufacturer format unchanged: '+token);
}
for(const other of [field('125','350001',220),[w('350001125',100,220,160)],[w('350044-18',100,220,160)],[w('DH3162-101',100,220,180)]]){
 check(readWords(data([...br(),...field(),...other]))===null,'Complete conflicting identity remains pending');
}
check(readWords(data([...br(),...field('08','350044'),w('350044-8',100,220,160)]))?.size==='38','Only colour zero padding is equivalent within complete OUS fields');
check(readWords(data([...field(),...br(),w('BR',950,400),w('38',1000,400)]))===null,'Two labels cannot be merged, even equal BR');
check(readWords(data(field()))===null,'A reference does not supply a missing BR');
for(const tail of ['X','AB','V2','/4','4']){
 check(readWords(data([...br(),w('350001-123',100,100,150),w(tail,255,100,20,20)]))===null,'Full-token reference plus weak continuation is entirely rejected: '+tail);
}

// Recorded words retain original confidence and bounds, including background
// and other labels. No human transcript is inserted into these OCR fixtures.
for(const fixture of real.fixtures){
 for(const pass of fixture.passes){
  const input={text:pass.text,blocks:[{paragraphs:[{lines:[{words:structuredClone(pass.words)}]}]}]};
  const parts=readParts(input);
  check(readWords(input)===null,'Real photo '+fixture.humanIndex+' pass '+pass.pass+' stays pending without same-pass full evidence');
  check(!(parts.references||[]).some(ref=>['8255CM','7245CM'].includes(ref)),'Real scale noise is excluded without inventing the reference');
  check(!(parts.completeOusReferences||[]).length,'Real weak/missing context never gains a complete-field marker');
 }
}
const original26=real.fixtures.find(x=>x.humanIndex===26).passes[0];
check(original26.words.some(w=>w.text==='350001'&&w.confidence===96)&&original26.words.some(w=>w.text==='123'&&w.confidence===96),'Real complementary reference remains documented, not fused with another pass');
const fakeSharp=()=>({rotate(){return this;},resize(){return this;},greyscale(){return this;},normalize(){return this;},png(){return this;},async metadata(){return {width:1000,height:800};},async toBuffer(){return Buffer.from('unit-photo');}});
async function run(sequence){
 let calls=0;
 const processor=createProcessor({sharp:fakeSharp,decode:async()=>['7909434881281'],createWorker:async()=>({async setParameters(){},async recognize(){return {data:data(sequence[Math.min(calls++,sequence.length-1)])};},async terminate(){}})});
 try{return {result:await processor.run('label',Buffer.from('unit-photo'),'7909434881281'),get calls(){return calls;}};}finally{await processor.close();}
}
(async()=>{
 const complete=await run([[...br(),...field()]]);
 check(complete.result.size==='38'&&complete.calls===1,'A contextual complete OUS nine-digit identity does not request an alphabetic suffix');
 const bare=await run([[...br(),w('101059351',100,100,150)]]);
 check(bare.calls===6,'Existing nine-digit non-OUS recovery remains unchanged');
 const uncontextual=await run([[...br(),w('350001123',100,100,150)]]);
 check(uncontextual.calls===6,'Bare nine digits alone cannot bypass recovery based only on prefix');
 for(const sequence of [
  [[w('350001125',100,100,150)],[...br(),...field()]],
  [field(),[...br(),w('350001125',100,100,150)]],
  [[w('DH3162-101',100,100,180)],[...br(),...field()]],
 ])check((await run(sequence)).result.pending===true,'Cross-pass contradictions remain blocked');
 for(const token of ['350001/125','350001 125','Ref.:350001/125','350001 - 125']){
  check((await run([[w(token,100,100,200)],[...br(),...field()]])).result.pending===true,'A complete prior token cannot hide a different OUS colour: '+token);
  check(readWords(data([...br(),...field(),w(token,100,220,200)]))===null,'A same-pass complete token cannot hide a different colour: '+token);
 }
 check((await run([field('08','350044'),[...br(),...field('8','350044')]])).result.size==='38','Equivalent OUS suffix zero does not create a false cross-pass conflict');
 check((await run([field(),br()])).result.pending===true,'Reference and BR in different passes are not fused');
 console.log('PASS: '+checks+' OUS field/scale/real-cache/processor checks; no OCR, network or DB.');
})().catch(e=>{console.error(e);process.exitCode=1;});
