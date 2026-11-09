'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createHash}=require('node:crypto');
const capturePhotos=require('../src/services/scannerCapturePhoto'),barcodePolicy=require('../public/scanner-barcode-policy');
const source=fs.readFileSync(require.resolve('../src/routes/stocktake'),'utf8');
const chunk=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);};
const registration=chunk('const replacementReadToken=','let replacementRecoveryRunning=');
const functions=chunk('function archivedCaptureRead(','\n// Automatic recognition');
const normalize=chunk('function normalizeScannedSize(','// Variantes do código');
const hash=value=>createHash('sha256').update(value).digest('hex');
const photo='data:image/png;base64,b3JpZ2luYWwtcGhvdG8=';
const barcode='1200161015441';
const base={id:'capture',roundId:'round',storeId:'store',scanKey:'round:scan',barcode,sellerId:'seller',photo,bipeId:'bipe',status:'processando',note:capturePhotos.photoNote('','Foto salva','10')};
const observed={source:'archived-photo-local-ocr-v1',size:'43',references:['100074187BLK'],decodedBarcodes:[barcode],text:'REEBOK\n100074187 BLK\nUSA UK EUR BR\n11 10 44.5 43'};
function harness({learnReason='matched',afterLearn}={}){
  let callback,current=structuredClone(base),applied=false,check=null,writes=0,links=0,learns=[],parses=0,enqueued=0;
  const tx={
    $queryRaw:async()=>[],productCapture:{findUnique:async()=>structuredClone(current),updateMany:async({data})=>{writes++;Object.assign(current,data);return {count:1};}},
    stocktakeRound:{findUnique:async()=>({storeId:'store',status:'counting',operationType:'replacement'})},
    stocktakeBipe:{findUnique:async()=>({applied})},stockReplacementCheck:{findUnique:async()=>check},
  };
  const api={
    current:()=>current,recapture:()=>{current.photo='data:image/png;base64,bmV3';current.note=capturePhotos.photoNote('','Nova foto','11');},
    apply:()=>{applied=true;check={appliedAt:'now',reversedAt:null};Object.assign(current,{status:'vinculado',matchedProductId:'confirmed',resolvedAt:'now',note:capturePhotos.photoNote('','Aplicado','10')});},
    counts:()=>({writes,links,learns,parses,enqueued})
  };
  const context={
    prisma:{productCapture:{findUnique:async()=>structuredClone(current)},$transaction:async fn=>fn(tx)},capturePhotos,barcodePolicy,require,
    parseScannerText:()=>{parses++;return {sku:'WRONG-TEXT',tamanho:'BR 40',marca:'REEBOK'};},
    learnScannerBarcode:async(db,input)=>{learns.push(structuredClone(input));afterLearn?.(api);return {reason:learnReason,productId:'product',productSizeId:'size',name:'Nano X4'};},
    matchInternalBarcode:async()=>{throw Error('Unexpected internal code');},
    garantirBipeDaCaptura:async(capId,pid,psId,ean,expected)=>{links++;return current.photo===expected.photo&&capturePhotos.revisionOf(current.note)===expected.photoRevision&&Object.entries(expected.context||{}).every(([key,value])=>current[key]===value)?{bipeId:'bipe'}:null;},
    scannerPendingMessage:()=> 'pending',replacement:{enqueue:async()=>{enqueued++;}},
    replacementQueue:{get:()=>({setIdentify:fn=>{callback=fn;}})},console,module:{exports:null},
  };
  vm.runInNewContext(normalize+'\n'+functions+'\n'+registration+'\nmodule.exports=processarEtiqueta;',context);
  const meta=()=>({captureId:base.id,photoRevision:'10',photoHash:hash(photo),captureContext:{roundId:base.roundId,storeId:base.storeId,scanKey:base.scanKey,sellerId:base.sellerId},ocrText:observed.text,serverRead:structuredClone(observed)});
  return {...api,callback,raw:context.module.exports,meta};
}
(async()=>{
  const good=harness();await good.callback(base.id,photo,barcode,good.meta());
  assert.equal(good.counts().learns.length,1);assert.equal(good.counts().parses,0,'Flattened OCR must not replace geometric BR/reference evidence');
  assert.equal(good.counts().learns[0].size,'43');assert.equal(good.counts().learns[0].read.tamanho,'BR 43');
  assert.deepEqual(good.counts().learns[0].read.codigos,['100074187BLK']);assert.equal(good.counts().learns[0].read.marca,'REEBOK');
  assert.equal(good.counts().learns[0].archivedLabel,undefined,'ProductCapture is not a ScanActionPhoto verdict');
  assert.equal(good.counts().writes,1);assert.equal(good.counts().links,1);assert.equal(good.counts().enqueued,0);
  const paired=harness(),pairMeta=paired.meta();pairMeta.serverRead.size='40/41';await paired.callback(base.id,photo,barcode,pairMeta);assert.equal(paired.counts().learns[0].size,'40/41');
  const alias=harness(),aliasMeta=alias.meta();aliasMeta.serverRead.decodedBarcodes=['0'+barcode];await alias.callback(base.id,photo,barcode,aliasMeta);assert.equal(alias.counts().learns.length,1);
  const invalids=[
    m=>{delete m.photoHash;},m=>{m.photoHash='0'.repeat(64);},m=>{m.captureId='other';},m=>{delete m.photoRevision;},m=>{m.photoRevision='9';},
    m=>{m.serverRead=null;},m=>{m.serverRead.source='tesseract-local';},m=>{m.serverRead.pending=true;},m=>{m.serverRead.conflict=true;},m=>{m.serverRead.reason='photo_barcode_conflict';},
    m=>{m.serverRead.decodedBarcodes=[];},m=>{m.serverRead.decodedBarcodes=['4006381333931'];},m=>{m.serverRead.decodedBarcodes.push('4006381333931');},
    m=>{m.serverRead.size='43 UK';},m=>{m.serverRead.size='40/42';},m=>{m.serverRead.references=[];},m=>{m.serverRead.references=[{}];},m=>{m.serverRead.text+=' NIKE';},
  ];
  for(const corrupt of invalids){const h=harness(),m=h.meta();corrupt(m);m.ocrText='REEBOK 100074187BLK BR 43';m.previousRead={sku:'100074187BLK',tamanho:'BR 43'};
    const result=await h.callback(base.id,photo,barcode,m);
    assert.ok(!result||result.vinculado===false);assert.equal(h.counts().learns.length,0);assert.equal(h.counts().parses,0);assert.equal(h.counts().writes,0);assert.equal(h.counts().links,0);
  }
  const forged=harness(),spoof=forged.meta();spoof.serverReadToken=Symbol('archived-capture-worker');
  assert.equal((await forged.raw(base.id,photo,barcode,spoof)).reason,'photo_evidence_conflict');assert.equal(forged.counts().learns.length,0);
  const wrongPhoto=harness();await wrongPhoto.callback(base.id,'data:image/png;base64,ZGlmZmVyZW50',barcode,wrongPhoto.meta());assert.equal(wrongPhoto.counts().learns.length,0);
  const wrongCode=harness();await wrongCode.callback(base.id,photo,'4006381333931',wrongCode.meta());assert.equal(wrongCode.counts().learns.length,0);
  for(const key of ['roundId','storeId','scanKey','sellerId']){
    const changedContext=harness(),meta=changedContext.meta();changedContext.current()[key]='other';
    assert.equal((await changedContext.callback(base.id,photo,barcode,meta)).reason,'photo_evidence_conflict');assert.equal(changedContext.counts().learns.length,0);
    const duringLearn=harness({afterLearn:h=>{h.current()[key]='other';}});await duringLearn.callback(base.id,photo,barcode,duringLearn.meta());assert.equal(duringLearn.counts().writes,0);
  }
  // Execute the actual transactional linker, not its recognition-test stub:
  // a context already changed before that function starts must still fail.
  for(const key of ['roundId','storeId','scanKey','sellerId']){
    const changed={...base,[key]:'other'};let downstream=0;
    const tx={$queryRaw:async()=>[],productCapture:{findUnique:async()=>structuredClone(changed)},productSize:{findUnique:async()=>{downstream++;return null;}}};
    const ctx={prisma:{$transaction:async fn=>fn(tx)},capturePhotos,barcodeVariants:barcodePolicy.variants,console,module:{exports:null}};
    vm.runInNewContext(chunk('async function garantirBipeDaCaptura(','\n// Extrai o PRIMEIRO objeto')+'\nmodule.exports=garantirBipeDaCaptura;',ctx);
    const result=await ctx.module.exports(base.id,'product','size',barcode,{photo,photoRevision:'10',context:{roundId:base.roundId,storeId:base.storeId,scanKey:base.scanKey,sellerId:base.sellerId}});
    assert.equal(result,null);assert.equal(downstream,0,'Job context must be checked before selecting/updating a variant');
  }
  const changed=harness({afterLearn:h=>h.recapture()});await changed.callback(base.id,photo,barcode,changed.meta());assert.equal(changed.counts().writes,0);assert.equal(capturePhotos.revisionOf(changed.current().note),'11');
  const late=harness({afterLearn:h=>h.apply()});await late.callback(base.id,photo,barcode,late.meta());assert.equal(late.counts().writes,0);assert.equal(late.current().matchedProductId,'confirmed');assert.equal(late.current().note,capturePhotos.photoNote('','Aplicado','10'));
  for(const reason of ['size_conflict','barcode_conflict','reference_conflict','brand_conflict']){const h=harness({learnReason:reason});const result=await h.callback(base.id,photo,barcode,h.meta());assert.equal(result.vinculado,false);assert.equal(h.counts().links,0);assert.equal(h.current().status,'pendente');}
  // Execute the real HTTP-to-background construction with hostile extra body
  // fields. Only the already-whitelisted OCR string/revision may cross it.
  let forwarded;
  const http=chunk('if(!req.replacementRound)setImmediate(', '\n    } catch (e)');
  vm.runInNewContext(http,{req:{replacementRound:null,body:{serverRead:observed,photoHash:hash(photo),captureId:base.id}},
    cap:{id:base.id},photo,eanCam:barcode,savedPhoto:{photoRevision:'10'},previousCapture:{note:''},ocrText:'untrusted text',parseJsonSeguro:()=>null,
    setImmediate:fn=>fn(),processarEtiqueta:async(id,p,e,meta)=>{forwarded=meta;},console,prisma:{productCapture:{updateMany:async()=>{}}},capturePhotos});
  assert.equal(forwarded.ocrText,'untrusted text');for(const key of ['serverRead','serverReadToken','captureId','photoHash'])assert.equal(Object.hasOwn(forwarded,key),false);
  console.log('PASS server OCR geometry preserved; hash/revision/capture/code/source/capability verified; 18 invalid-evidence cases fail closed; aliases and paired BR accepted; recapture/late-applied/conflicts preserved; HTTP verdict fields excluded. No DB/OCR/network.');
})().catch(error=>{console.error(error);process.exitCode=1;});
