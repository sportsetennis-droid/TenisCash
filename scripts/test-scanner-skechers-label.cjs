'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {readWords}=require('../src/services/scannerArchivedLabel');
const word=(text,x,y,width=60,confidence=96)=>({text,confidence,bbox:{x0:x,y0:y,x1:x+width,y1:y+30}});
const data=words=>({text:words.map(w=>w.text).join(' '),blocks:[{paragraphs:[{lines:[{words}]}]}]});
const base=[word('BRA',500,500),word('41',580,500),word('220644',100,100,180),word('/',300,100,15),word('BKW',330,100,90)];
assert.ok(readWords(data(base)).references.includes('220644BKW'),'Printed model / colour is one exact reference');
assert.ok(readWords(data(base.map(w=>w.text==='/'?{...w,text:'|'}:w))).references.includes('220644BKW'),'Slash recognized as a vertical separator retains model and colour');
assert.ok(!readWords(data(base.map(w=>w.text==='BKW'?word('BKW',330,200,90):w))).references.includes('220644BKW'),'A colour from another line is never attached');
assert.ok(!readWords(data(base.map(w=>w.text==='BKW'?word('BKW',330,100,90,40):w))).references.includes('220644BKW'),'Low-confidence colour remains unverified');
assert.ok(!readWords(data(base.filter(w=>w.text!=='/'))).references.includes('220644BKW'),'A nearby unrelated word without a separator is not a colour');

// Actual local OCR word geometry from an archived label: the image reads
// CM 24 / BRA 36, but the last number was recognized as low-confidence "3".
const measured=(text,confidence,x0,y0,x1,y1)=>({text,confidence,bbox:{x0,y0,x1,y1}});
const ambiguousScale=[measured('896312BR/AQUA',91,174,824,560,865),measured('USA',96,577,809,616,827),
 measured('37',96,581,898,610,915),measured('CM',91,582,980,607,997),
 measured('24',95,581,1006,610,1023),measured('BRA',96,579,1035,609,1051),measured('3',74,581,1061,595,1078)];
assert.equal(readWords(data(ambiguousScale)),null,'CM 24 must never become BR 24 when BR was not read');
assert.equal(readWords(data([word('BRA',500,500),word('40',580,500),word('EUR42',100,100)])),null,'A joined scale/value is not a product reference');
const measuredMegara=[measured('896312BR/PKCL',92,90,588,609,646),measured('BRA',96,637,874,675,892),measured('37',96,638,907,674,927)];
const measuredPropulsion=[measured('220509',91,198,1374,643,1458),measured('/',89,691,1373,718,1453),measured('SLT',95,768,1373,1013,1453),measured('BRA',92,1135,1769,1229,1798),measured('40',92,1269,1770,1332,1801)];
assert.equal(readWords(data(measuredMegara)).size,'37');
assert.ok(readWords(data(measuredPropulsion)).references.includes('220509SLT'));assert.equal(readWords(data(measuredPropulsion)).size,'40');

const code=fs.readFileSync(path.join(__dirname,'../src/services/scannerArchivedLabel.js'),'utf8');
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
(async()=>{
 let timeout,created=0,terminated=0,calls=0,gate=deferred(),termination=deferred(),psm;
 const blank={data:{text:'',blocks:[]}},worker={async setParameters(parameters){if(parameters.tessedit_pageseg_mode)psm=parameters.tessedit_pageseg_mode;},async recognize(){calls++;return gate.promise;},async terminate(){terminated++;if(termination)await termination.promise;}};
 const sharp=()=>({rotate(){return this},resize(){return this},greyscale(){return this},normalize(){return this},png(){return this},async metadata(){return{width:100}},async toBuffer(){return Buffer.from('same-photo')}});
 const ctx={module:{exports:{}},exports:{},__dirname:path.join(__dirname,'../src/services'),Buffer,console,
  setTimeout(fn){timeout=fn;return 1;},clearTimeout(){},require(name){if(name==='sharp')return sharp;if(name==='tesseract.js')return{async createWorker(){created++;return worker}};if(name==='./barcodeDecoder')return{async decodeBarcodesFromDataUri(){return ['0196989405971']}};if(name==='./scannerCatalog')return{};if(name==='../../public/scanner-barcode-policy')return require('../public/scanner-barcode-policy');return require(name);}};
 vm.runInNewContext(code,ctx);const api=ctx.module.exports;
 const pending=api.readImage(Buffer.from('same-photo'),'0196989405971');await tick();assert.equal(calls,1);
 timeout();const result=await pending;assert.equal(result.reason,'ocr_timeout');assert.equal(terminated,0,'Timeout must not close a worker still preparing/recognizing the current image');
 assert.equal((await api.readImage(Buffer.from('other-photo'),'0196989405971')).reason,'ocr_busy');assert.equal(created,1,'One worker remains owned until the old task settles');
 gate.resolve(blank);await tick();assert.equal(terminated,1);assert.equal(calls,1,'Expired work must never submit another OCR call');
 assert.equal((await api.readImage(Buffer.from('other-photo'),'0196989405971')).reason,'ocr_busy','Worker cleanup must finish before ownership is released');
 termination.resolve();await tick();termination=null;
 gate=deferred();const next=api.readImage(Buffer.from('same-photo'),'0196989405971');await tick();assert.equal(created,2);gate.resolve({data:data(base)});const good=await next;assert.equal(good.size,'41');assert.equal(terminated,2);assert.ok(good.references.includes('220644BKW'));
 gate=deferred();const failed=api.readImage(Buffer.from('same-photo'),'0196989405971');await tick();gate.reject(new Error('local OCR failure'));assert.equal((await failed).reason,'ocr_unavailable');assert.equal(terminated,3,'A failed recognition also cleans up its worker');
 const modes=[];worker.recognize=async()=>{modes.push(psm);return psm==='6'?{data:data(measuredMegara)}:blank;};
 const segmented=await api.readImage(Buffer.from('same-photo'),'0196989405971');assert.equal(segmented.size,'37');assert.deepEqual(modes,['11','11','6'],'Block segmentation tries the same original pixels after sparse-text failure, before rotating');
 const writer=require('zxing-wasm/writer');writer.prepareZXingModule({overrides:{wasmBinary:fs.readFileSync(path.join(__dirname,'../node_modules/zxing-wasm/dist/writer/zxing_writer.wasm'))}});
 const decoder=require('../src/services/barcodeDecoder');
 for(const [format,barcode] of [['Code128','7899865941312'],['ITF','12345678901234'],['EAN-13','5901234123457']]){
  const rendered=await writer.writeBarcode(barcode,{format,scale:3,addQuietZones:true});assert.equal(rendered.error,'');assert.ok(rendered.image);
  const original=Buffer.from(await rendered.image.arrayBuffer());const decoded=await decoder.decodeBarcodesFromDataUri('data:image/png;base64,'+original.toString('base64'));assert.ok(decoded.includes(barcode),format+' must be supported by server as it is by the camera');
 }
 console.log('PASS: exact same-row model/colour reference, confidence/row/separator guards, timeout preserves worker ownership, no post-timeout OCR submission, cleanup and following read recover.');
 console.log('PASS: real raster Code128, ITF and EAN13 decode locally without OCR or a paid service.');
 console.log('PASS: measured CM24/BRA geometry rejects the foreign scale when the Brazilian number is unreadable.');
 console.log('PASS: measured PSM6 label geometry and same-image fallback recover literal BR/model/colour; scale tokens are not references.');
})().catch(e=>{console.error(e);process.exitCode=1;});
