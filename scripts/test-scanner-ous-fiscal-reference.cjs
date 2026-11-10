'use strict';
const assert=require('node:assert/strict');
const {matchIncomingManufacturerReference:match}=require('../src/services/scannerReference');
const {referenceMatches}=require('../src/services/stockReplacement');

// Unit inputs transcribed from the reviewed OUS corpus (Loja04/round27).
// These are hypothetical matcher inputs, NOT OCR results or application proof.
// Keep fixtures self-contained: CI needs neither archived photos nor a database.
const fixtures=[
 {index:1,model:'350044',material:'COURO',colour:'18',reference:'35004418',size:'39',ean:'7909434890276',supplier:'146790',name:'IMIGRANTE SERIE X CORAL PINK ESSENCIAL'},
 {index:12,model:'350046',material:'TEXTIL',colour:'07',reference:'3500467',size:'41',ean:'7909434821041',supplier:'131361',name:'HEVEA DOTS MULTI OE'},
 {index:17,model:'350053',material:'COURO',colour:'05',reference:'3500535',size:'43',ean:'7909434888518',supplier:'148406',name:'FLUENTE GTX PRT BRANCO PRETO ESSENCIAL'},
 {index:26,model:'350001',material:'COURO',colour:'123',reference:'350001123',size:'38',ean:'7909434881281',supplier:'146771',name:'IMIGRANTE MEGA CHANTILLY PRETO REFLEX IMPERIAL'},
 {index:27,model:'350001',material:'COURO',colour:'125',reference:'350001125',size:'36',ean:'7909434879424',supplier:'146773',name:'IMIGRANTE CAFE AZUL CHANTILLY ESSENCIAL'},
 {index:34,model:'350044',material:'COURO',colour:'08',reference:'3500448',size:'42',ean:'7909434817730',supplier:'132030',name:'IMIGRANTE SERIE X PRT CHANTILLY DIJON ESSENCIAL'},
 {index:43,model:'350053',material:'COURO',colour:'06',reference:'3500536',size:'38',ean:'7909434887979',supplier:'148407',name:'FLUENTE GTX CINZA PRETO REFLEX ESSENCIAL'},
 {index:49,model:'350002',material:'SINT',colour:'51',reference:'35000251',size:'42',ean:'7909434685650',supplier:'105859',name:'PHIBO 1123 PB OCRE OE'}
];
const product=f=>({id:'ous-'+f.index,brand:'OUS',sku:'0190-'+f.ean,aiContext:{supplierRef:f.supplier,photoRef:f.model+'_'+Number(f.colour)}});
const fiscal=(f,changes={})=>({id:'fiscal-'+f.index,productId:product(f).id,ean:f.ean,docType:'entrada',supplierCode:f.supplier,description:`${f.model} TENIS ${f.material} ${f.colour} ${f.name} ${f.size}`,...changes});
const input=(f,references=[f.reference],size=f.size)=>({references,size,text:'OUS '+f.name});
let tests=0;
function check(name,fn){fn();tests++;}
function rejected(name,f,read,rows=[fiscal(f)]){check(name,()=>assert.deepEqual(match(product(f),read,rows),{handled:true,reference:null},name));}
function fiscalDb(rows,expectedBarcode){
 return {$queryRaw:async(strings,...values)=>{
  const sql=strings.join('');
  assert(sql.includes(`d."docType"='entrada'`),'Incoming-only query is retained');
  const codes=JSON.parse(values[0]);assert(codes.includes(expectedBarcode),'Exact captured EAN remains bound to fiscal query');
  return rows.filter(r=>r.docType==='entrada'&&codes.includes(r.ean)&&r.productId);
 }};
}

(async()=>{
 for(const f of fixtures){
  check('reviewed input '+f.index,()=>assert.deepEqual(match(product(f),input(f),[fiscal(f)]),{handled:true,reference:f.reference}));
  const spaced=f.model+' '+f.colour;
  check('original reference string '+f.index,()=>assert.equal(match(product(f),input(f,[spaced]),[fiscal(f)]).reference,spaced));
  rejected('base-only cannot confirm colour '+f.index,f,input(f,[f.model]));
  rejected('different colour '+f.index,f,input(f,[f.model+'999']));
  rejected('two complete colours '+f.index,f,input(f,[f.reference,f.model+'999']));
  rejected('wrong BR '+f.index,f,input(f,[f.reference],f.size==='44'?'43':'44'));
  rejected('conflicting fiscal identity '+f.index,f,input(f),[fiscal(f),fiscal(f,{description:`${f.model} TENIS ${f.material} 999 OTHER COLOUR ${f.size}`})]);
  const context={bipe:{barcode:f.ean},size:{product:product(f)}};
  assert.equal(await referenceMatches(fiscalDb([fiscal(f)],f.ean),context,input(f)),f.reference);tests++;
  assert.equal(await referenceMatches(fiscalDb([fiscal(f,{ean:'7909430000000'})],f.ean),context,input(f)),null,'Another EAN cannot supply manufacturer identity');tests++;
  assert.equal(await referenceMatches(fiscalDb([fiscal(f,{productId:'unrelated-product'})],f.ean),context,input(f)),null,'Another product cannot supply manufacturer identity');tests++;
  assert.equal(await referenceMatches(fiscalDb([fiscal(f,{docType:'saida'})],f.ean),context,input(f)),null,'Outgoing fiscal row cannot supply incoming identity');tests++;
 }
 const f=fixtures.find(f=>f.index===17);
 // Only numeric colour padding changes: six model digits remain exact.
 for(const colour of ['5','05','005']){
  const printed=f.model+'-'+colour;
  check('colour padding '+colour,()=>assert.equal(match(product(f),input(f,[printed]),[fiscal(f)]).reference,printed));
 }
 check('equivalent colour spellings are not a conflict',()=>assert.equal(match(product(f),input(f,['3500535','35005305','350053005']),[fiscal(f)]).reference,'3500535'));
 check('equivalent fiscal colour spellings are not a conflict',()=>assert.equal(match(product(f),input(f),[fiscal(f),fiscal(f,{description:'350053 TENIS COURO 005 FLUENTE GTX 43'})]).reference,f.reference));
 for(const reference of ['350053','3500530005','35005305X','0350535','350535','3505035'])rejected('incomplete/changed identity '+reference,f,input(f,[reference]));
 const leading={...f,model:'035053',reference:'0350535'};
 check('six-digit model keeps its leading zero',()=>assert.equal(match(product(leading),input(leading),[fiscal(leading)]).reference,leading.reference));
 rejected('leading model zero cannot be discarded',leading,input(leading,['350535']));
 rejected('model padding cannot borrow a colour digit',leading,input(leading,['3505305']));
 const three=fixtures.find(f=>f.index===27);
 rejected('colour125 is not25',three,input(three,['35000125']));
 rejected('colour125 is not12',three,input(three,['35000112']));
 rejected('different full model with same colour',f,input(f,['3500545']));
 rejected('fiscal size conflict retained',f,input(f),[fiscal(f),fiscal(f,{description:'350053 TENIS COURO 05 FLUENTE GTX 42'})]);
 // Do not turn the material list into a generic "TENIS <anything>" matcher.
 for(const material of ['MALHA','TEXTILX','SINTETICO','SINT X','COURO/TEXTIL']){
  const row=fiscal({...f,material});
  check('unsupported material '+material,()=>assert.deepEqual(match(product(f),input(f),[row]),{handled:false,reference:null}));
 }
 check('unknown brand is not OUS',()=>assert.deepEqual(match({...product(f),brand:'NIKE'},input(f),[fiscal(f)]),{handled:false,reference:null}));
 const puma={id:'puma',brand:'PUMA',sku:'1079520010',aiContext:{supplierRef:'107952001036'}};
 check('Puma unchanged',()=>assert.equal(match(puma,{size:'36',references:['107952 01']},[{productId:'puma',supplierCode:'107952001036'}]).reference,'107952 01'));
 check('Puma colour conflict unchanged',()=>assert.equal(match(puma,{size:'36',references:['10795201','10795202']},[{productId:'puma',supplierCode:'107952001036'}]).reference,null));
 const asics={id:'asics',brand:'ASICS',sku:'6108-4550457738712',aiContext:{supplierRef:'1202A479 106036'}};
 check('Asics unchanged',()=>assert.equal(match(asics,{size:'37',references:['1202A479-106']},[{productId:'asics',supplierCode:'1202A479 106037'}]).reference,'1202A479-106'));
 check('Asics colour conflict unchanged',()=>assert.equal(match(asics,{size:'37',references:['1202A479-106','1202A479-107']},[{productId:'asics',supplierCode:'1202A479 106037'}]).reference,null));
 console.log(`PASS: ${tests} OUS fiscal-reference unit cases; COURO/TEXTIL/SINT, colour-only padding, exact model/BR/conflict, original strings, incoming EAN/product isolation and other-brand regressions. Hypothetical inputs only; no OCR or database.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
