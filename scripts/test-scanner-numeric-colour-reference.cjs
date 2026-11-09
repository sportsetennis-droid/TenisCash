'use strict';
// Geometry fixtures exercise the printed Puma model/colour layout. They are
// synthetic parser inputs, not claimed OCR output or authorization to apply stock.
const assert=require('node:assert/strict');
const {readParts,readWords}=require('../src/services/scannerArchivedLabel');
const {createProcessor}=require('../src/services/scannerImageProcessor');
const word=(text,x,y,width=40,confidence=96,height=25)=>({text,confidence,bbox:{x0:x,y0:y,x1:x+width,y1:y+height}});
const data=words=>({text:words.map(w=>w.text).join(' '),blocks:[{paragraphs:[{lines:[{words}]}]}]});
const br=()=>[word('BR',700,100),word('36',700,145)];
const model=()=>word('107952',100,300,100);
const colour=()=>word('01',208,300,30);
const refs=words=>readParts(data(words)).references||[];
let assertions=0;
function check(ok,message){assert.ok(ok,message);assertions++;}
for(const [code,colourCode] of [['107952','01'],['107950','03'],['106455','01']]){
 const words=[...br(),word(code,100,300,100),word(colourCode,208,300,30)];
 const result=readWords(data(words));
 check(result?.references.includes(code+colourCode),'Adjacent literal model and colour must stay complete: '+code+' '+colourCode);
 check(result.size==='36','Model/colour never replaces the separate literal BR');
 check(readParts(data(words)).identityReferences.includes(code+colourCode),'Complete identity participates in the cross-pass conflict guard');
}
for(const [name,words] of [
 ['missing colour',[model()]],
 ['different line',[model(),word('01',208,340,30)]],
 ['remote neighbour',[model(),word('01',400,300,30)]],
 ['weak colour',[model(),word('01',208,300,30,50)]],
 ['weak model',[word('107952',100,300,100,50),colour()]],
 ['intervening weak text',[model(),word('X',202,300,5,20),word('01',214,300,30)]],
 ['third numeric field',[model(),colour(),word('02',245,300,30)]],
 ['colour with another slash field',[model(),word('01/02',208,300,70)]],
 ['oversized neighbour',[model(),word('01',208,290,50,96,50)]],
 ['five-digit model',[word('10795',100,300,100),colour()]],
 ['seven-digit model',[word('1079520',100,300,100),colour()]],
 ['BR-owned number',[model(),word('36',208,300,30),word('BR',208,260,30)]],
 ['US-owned number',[model(),word('10',208,300,30),word('US',245,300,30)]],
 ['intervening scale',[model(),word('BR',202,300,30),word('36',238,300,30)]],
])check(!refs(words).includes('10795201')&&!refs(words).includes('10795236')&&!refs(words).includes('10795210'),name+' cannot fabricate a model/colour identity');
check(readWords(data([...br(),model(),colour(),word('106455',100,450,100),word('01',208,450,30)]))===null,'Two different complete identities remain conflicting');
check(readWords(data([...br(),model(),colour(),word('10645501',100,450,140)]))===null,'A full token conflicting with the split model/colour remains pending');
for(const token of ['106455-01','106455/01','106455 01'])check(readWords(data([...br(),model(),colour(),word(token,100,450,140)]))===null,'Punctuation or OCR token boundaries cannot hide a contradictory full model/colour');
check(readWords(data([...br(),model(),colour(),word('10795201',100,450,140)]))?.references.includes('10795201'),'The same full and split model/colour remain consistent');
const numericOnly=readParts(data([word('41403893',100,450,140)]));
check(numericOnly.numericReferenceTokens.includes('41403893')&&numericOnly.identityReferences.length===0,'An eight-digit manufacturing fragment alone is not a complete identity');
check(readWords(data([...br(),model(),colour(),word('BR',1000,100),word('36',1000,145)]))===null,'Two boxes with equal BR remain ambiguous');
check(readWords(data([model(),colour()]))===null,'A complete model/colour still needs literal BR');
check(!refs([word('Ii',100,300,30),word('-0896-V2-42/43',138,300,220)]).includes('SFBMUL0896V24243'),'A truncated Fiber prefix is never filled from the product catalog');
const fiber=readParts(data([word('BRA',700,100),word('10/41',700,145,100),word('SFBMUL-0998-V2-40/41',100,300,300)]));
check(fiber.references.includes('SFBMUL0998V24041')&&fiber.size===null,'A whole Fiber reference survives while invalid BR stays pending');
const fakeSharp=()=>({rotate(){return this;},resize(){return this;},greyscale(){return this;},normalize(){return this;},png(){return this;},async metadata(){return {width:1000,height:800};},async toBuffer(){return Buffer.from('current-photo');}});
async function passes(first,second){
 let index=0;
 const processor=createProcessor({sharp:fakeSharp,decode:async()=>['4067979368889'],createWorker:async()=>({async setParameters(){},async recognize(){return {data:data(index++===0?first:second)};},async terminate(){}})});
 try{return await processor.run('label',Buffer.from('same-photo'),'4067979368889');}finally{await processor.close();}
}
(async()=>{
 check((await passes([word('10645501',100,450,140)],[...br(),model(),colour()])).pending===true,'A full-token first pass conflicts with a different split identity later');
 check((await passes([model(),colour()],[...br(),word('10645501',100,450,140)])).pending===true,'A split first pass conflicts with a different full identity later');
 check((await passes([word('10795201',100,450,140)],[...br(),model(),colour()])).size==='36','The same full and split identity across passes remains valid');
 check((await passes([word('41403893',100,450,140)],[...br(),word('101056056AZLTQS',100,450,250)])).size==='36','An eight-digit manufacturing code never becomes a universal identity veto for Mizuno');
 console.log('PASS: '+assertions+' numeric-colour reference assertions; literal model+colour, geometric/confidence/scale guards, same/cross-pass conflicts and no Fiber prefix inference. No OCR/network/database used.');
})().catch(error=>{console.error(error);process.exitCode=1;});
