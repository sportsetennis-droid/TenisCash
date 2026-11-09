'use strict';
const assert=require('node:assert/strict');
const {fiberReferenceIdentity,matchFiberReference,referenceCandidatesForRead,learnScannerBarcode}=require('../src/services/scannerReference');
const {referenceMatches}=require('../src/services/stockReplacement');
const db={$queryRaw:async()=>[]};
function context(sku,supplierRef,brand='FIBER') { return {bipe:{barcode:'7898707779922'},size:{product:{id:'p',sku,brand,aiContext:{supplierRef}}}}; }
function read(reference,size,text='FIBER'){return {references:[reference],size,text,source:'archived-photo-local-ocr-v1'};}
(async()=>{
 // Two real archived labels: TFBU-WHITE-40/BRA40 and -42/BRA42; unified
 // catalogue header retains -34. No actual photo size is taken from that header.
 const c=context('0110-TFBU-WHITE-34','TFBU-WHITE-34');
 for(const size of ['40','42'])assert.equal(await referenceMatches(db,c,read('TFBU-WHITE-'+size,size)),'TFBU-WHITE-'+size);
 assert.equal(await referenceMatches(db,c,read('TFBU-WHITE-42','40')),null);
 assert.equal(await referenceMatches(db,c,read('TFBU-BLACK-40','40')),null);
 assert.equal(await referenceMatches(db,c,read('TFBU','40')),null,'Model-only is insufficient');
 assert.equal(await referenceMatches(db,c,read('TFBU-WHITE-40','40','FIBER NIKE')),null);
 assert.equal(await referenceMatches(db,c,{...read('TFBU-WHITE-40','40'),references:['TFBU-WHITE-40','TFBU-BLACK-40']}),null);
 assert.equal(await referenceMatches(db,context('0110-TFBU-WHITE-34','TFBU-BLACK-34'),read('TFBU-WHITE-40','40')),null);
 assert.equal(await referenceMatches(db,context('0110-TFBU-WHITE-34','TFBU-WHITE-34','NIKE'),read('TFBU-WHITE-40','40','NIKE')),null,'Do not generalize Fiber import format');
 const fly=context('0110-FBRFLYR-BLACK-V4-35','FBRFLYR-BLACK-V4-35');
 assert.equal(await referenceMatches(db,fly,read('FBRFLYR-BLACK-V4-40','40')),'FBRFLYR-BLACK-V4-40');
 assert.equal(await referenceMatches(db,fly,read('FBRFLYR-BLACK-V3-40','40')),null,'Version retained');
 assert.equal(await referenceMatches(db,fly,read('FBRFLYR-BW-V4-40','40')),null,'Colour retained');
 assert.equal(await referenceMatches(db,context('0110-SFBMUL-0998-V2-34/35','SFBMUL-0998-V2-34/35'),read('SFBMUL-0998-V2-40/41','40/41')),'SFBMUL-0998-V2-40/41');
 assert.equal(await referenceMatches(db,context('0110-SFBMUL-0998-V2-34/35','SFBMUL-0998-V2-34/35'),read('SFBMUL-0896-V2-40/41','40/41')),null);
 assert.equal(await referenceMatches(db,context('0110-SFBMUL-0998-V2-34/35','SFBMUL-0998-V2-34/35'),read('SFBMUL-0998-V2-40/41','41')),null,'Compound size remains one complete size');
 assert.equal(fiberReferenceIdentity('GTM-220644-BKW-41'),null);
 assert.deepEqual(fiberReferenceIdentity('TFERSBLACK'),{identity:'TFERSBLACK',size:null});
 assert.equal(matchFiberReference(c.size.product,{references:['TFBUWHITE40'],size:null}).reference,null);
 // Exact full Skechers model+colour still blocks both real bad consolidations.
 assert.equal(await referenceMatches(db,context('T-232932-WGY','T-232932-WGY','SKECHERS'),read('232932CCRD','41','SKECHERS')),null);
 assert.equal(await referenceMatches(db,context('GTW-128901-LBNV','GTW-128901-LBNV','SKECHERS'),read('220509SLT','40','SKECHERS')),null);
 const fiscalDb=rows=>({$queryRaw:async()=>rows});
 const puma=context('107952   0010','107952   001036','PUMA');
 const pumaRow={productId:'p',supplierCode:'107952   001036'};
 assert.equal(await referenceMatches(fiscalDb([pumaRow]),puma,read('107952 01','36','PUMA')),'107952 01');
 for(const [reference,size]of [['107952','36'],['10795202','36'],['10795201','34']])assert.equal(await referenceMatches(fiscalDb([pumaRow]),puma,read(reference,size,'PUMA')),null);
 assert.equal(await referenceMatches(fiscalDb([{...pumaRow,supplierCode:'107952   003036'}]),puma,read('10795201','36','PUMA')),null);
 assert.equal(await referenceMatches(fiscalDb([{...pumaRow,productId:'unrelated'}]),puma,read('10795201','36','PUMA')),null);
 const asics=context('6108-7909701968905','1011C017 402043','ASICS');
 const asicsRow={productId:'p',supplierCode:'1011C017 402042'};
 assert.equal(await referenceMatches(fiscalDb([asicsRow]),asics,read('1011C017.402','42','ASICS')),'1011C017.402');
 for(const reference of ['1011C017','1011C017.400','1011C017402043'])assert.equal(await referenceMatches(fiscalDb([asicsRow]),asics,read(reference,'42','ASICS')),null);
 const ous=context('0190-7909434878489','146789','OUS');
 const ousRow={productId:'p',supplierCode:'146789',description:'350044 TENIS COURO 17 IMIGRANTE SERIE X BOURBON CHANTILLY PRT ESSENCIAL 39'};
 assert.equal(await referenceMatches(fiscalDb([ousRow]),ous,read('350044 17','39','OUS')),'350044 17');
 for(const [reference,size]of [['350044','39'],['35004418','39'],['35004417','43']])assert.equal(await referenceMatches(fiscalDb([ousRow]),ous,read(reference,size,'OUS')),null);
 assert.equal(await referenceMatches(fiscalDb([ousRow,{...ousRow,description:ousRow.description.replace('COURO 17','COURO 18')}]),ous,read('35004417','39','OUS')),null);
 let queried=[];
 const target={id:'fiber',active:true,brand:'FIBER',sku:'0110-TFER-WHITE-35',aiContext:{supplierRef:'TFER-WHITE-35'},sizes:[{id:'fiber40',productId:'fiber',size:'40',barcode:'7908919000049'}]};
 const candidateDb={$queryRaw:async(strings,...values)=>{if(!strings.join('').includes('WITH codes'))return [];const codes=JSON.parse(values[0]);queried.push(codes);return codes.includes('TFERWHITE40')?[{id:'fiber'}]:[];},product:{findUnique:async()=>target,findFirst:async()=>null,update:async()=>{throw Error('Unexpected product write');}},productSize:{findMany:async()=>[],update:async()=>{throw Error('Unexpected variant write');}}};candidateDb.$transaction=fn=>fn(candidateDb);
 assert.deepEqual(await referenceCandidatesForRead(candidateDb,{sku:'TFERWHITE'},'40'),[{id:'fiber',source:'fiber-reference-plus-physical-size'}]);
 assert.deepEqual(await referenceCandidatesForRead(candidateDb,{sku:'TFERWHITE'},null),[]);
 assert.deepEqual(await referenceCandidatesForRead(candidateDb,{sku:'TFERBLACK'},'40'),[]);
 assert.equal((await learnScannerBarcode(candidateDb,{barcode:'7898707778147',read:{sku:'TFERWHITE'},size:'40'})).reason,'size_barcode_conflict');
 assert.ok(queried.some(codes=>codes.includes('TFERWHITE40')),'Only separately read BR completes the exact incoming reference');
 console.log('PASS: Fiber full model/colour/version across imported header sizes; exact physical size and compound size required; model-only, colour, version, brand and conflicting consolidation remain blocked.');
})().catch(e=>{console.error(e);process.exitCode=1});
