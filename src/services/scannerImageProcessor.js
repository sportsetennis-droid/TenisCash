'use strict';
const path = require('node:path');
const barcodePolicy = require('../../public/scanner-barcode-policy');
const incompleteNineDigitReference=observed=>observed.references.some(ref=>/^\d{9}$/.test(ref)&&!observed.completeOusReferences?.includes(ref))&&!observed.references.some(ref=>/^\d{9}[A-Z]{2,8}(?:\d{1,3})?$/.test(ref));
// One reusable OCR worker per isolated process; the parent owns deadlines.
// Never terminate while Tesseract is preparing an image asynchronously.
function createProcessor(deps = {}) {
  const sharp = deps.sharp || require('sharp');
  const decode = deps.decode || require('./scannerBarcodeEngine').decode;
  const readWords = deps.readWords || require('./scannerArchivedLabel').readWords;
  const readParts = deps.readParts || require('./scannerArchivedLabel').readParts;
  const createWorker = deps.createWorker || require('tesseract.js').createWorker;
  let worker, busy = false;
  const input = image => sharp(image, { limitInputPixels: 24000000 });
  // Diagnostics cannot change recognition or participate in its evidence.
  async function label(image, barcode, diagnostic) {
   const rasterDiagnostic=async(bytes,fields)=>{
    if(!diagnostic.enabled)return;
    diagnostic('raster-metadata',fields);
    try{const info=await input(bytes).metadata();diagnostic('ocr',{...fields,width:info.width,height:info.height});}
    catch(_){diagnostic('ocr',fields);}
   };
    diagnostic('decode');
    const codes = await decode(image);
    if (!codes.length) return { pending: true, reason: 'photo_barcode_not_found' };
    if (codes.length > 1) return { pending: true, reason: 'photo_barcode_conflict' };
    if (barcodePolicy.identity(codes[0]) !== barcodePolicy.identity(barcode)) return { pending: true, reason: 'photo_barcode_mismatch' };
    diagnostic('ocr-init');
    if (!worker) worker = await createWorker('eng', 1, {
      langPath: path.join(__dirname, '../../public/vendor/ocr'), cacheMethod: 'none', errorHandler: () => {},
    });
    await worker.setParameters({ preserve_interword_spaces: '1' });
    let stretched=false,pass=0;
    // Retain contradictory partial evidence within this photo only. A pass
    // without a complete answer may still contain a reliable BR or colour.
    const seenSizes=new Set(),seenReferences=new Set(),seenNumericColours=new Set(),seenNumericTokens=new Set(),seenOusTokens=new Set();
    let hasOusField=false;
    const ousIdentity=ref=>/^350\d{3}\d{1,3}$/.test(ref)?ref.slice(0,6)+':'+Number(ref.slice(6)):ref;
    const consistent=data=>{const parts=readParts(data);if(parts.conflict)return false;
      if(parts.size)seenSizes.add(parts.size);
      for(const ref of parts.identityReferences||[])seenReferences.add(ref);
      for(const ref of parts.numericColourReferences||[])seenNumericColours.add(ref);
      for(const ref of parts.numericReferenceTokens||[])seenNumericTokens.add(ref);
      for(const ref of parts.ousReferenceTokens||[])seenOusTokens.add(ref);
      hasOusField ||= !!parts.completeOusReferences?.length;
      const identities=hasOusField?new Set([...seenReferences,...seenOusTokens].map(ousIdentity)):seenReferences;
      return seenSizes.size<=1&&identities.size<=1&&
        (!seenNumericColours.size||new Set([...seenNumericColours,...seenNumericTokens]).size<=1);};
    for (const angle of [0, 90, 270, 180]) {
      diagnostic('metadata',{angle});
      const frame = angle ? await input(image).rotate(angle).png().toBuffer() : image;
      const metadata = await input(frame).metadata();
      let enhanced;
      // Same original/enhanced pixels and literal-scale guards. No database
      // product/size information is sent to this process.
      let nineDigitText=false,partial=null;
      for (const psm of ['11', '6']) {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        for (const enhance of [false, true]) {
          // Try the original first, without preparing an unused enhanced
          // raster. Preserve the exact existing enhancement pixels: reducing
          // resolution can change the literal characters recognized by OCR.
          if (enhance && !enhanced) {
            diagnostic('enhance',{angle,psm,enhanced:true});
            enhanced = await input(frame).resize({ width: Math.min(3000, metadata.width * 2) }).greyscale().normalize().png().toBuffer();
          }
          const candidate = enhance ? enhanced : frame;
          await rasterDiagnostic(candidate,{pass:++pass,angle,psm,enhanced:enhance});
          const data=(await worker.recognize(candidate, {}, { text: true, blocks: true })).data;
          if(!consistent(data))return {pending:true,reason:'photo_size_or_reference_pending'};
          // This is only a trigger for another attempt, never identity/size
          // evidence. The next read still has to pass every literal guard.
          nineDigitText ||= (data.blocks||[]).some(b=>(b.paragraphs||[]).some(p=>(p.lines||[]).some(l=>(l.words||[]).some(w=>w.confidence>=75&&/^\d{9}$/.test(String(w.text||'').trim())))));
          const observed = readWords(data);
          if (observed) {
            if(partial&&partial.size!==observed.size)return {pending:true,reason:'photo_size_or_reference_pending'};
            if(incompleteNineDigitReference(observed)&&!stretched)partial=partial||observed;
            else return { ...observed, decodedBarcodes: codes };
          }
        }
      }
      if(nineDigitText&&!stretched){
        stretched=true;
        // Narrow printed fonts can defeat segmentation even in a sharp photo.
        // Expand the WHOLE frame horizontally; no label/number is cropped out.
        // At most two extra passes per request, <=4MP each, same deadline/RSS.
        // Retain colour first: grayscale can erase narrow printed letterforms.
        const scale=Math.min(1,1800/Math.max(metadata.width,metadata.height),Math.sqrt(4000000/(metadata.width*metadata.height*2)));
        await worker.setParameters({tessedit_pageseg_mode:'11'});
        for(const normalized of [false,true]){
          diagnostic('stretch',{angle,psm:'11',enhanced:normalized});
          let wide=input(frame).resize({width:Math.max(1,Math.floor(metadata.width*scale*2)),height:Math.max(1,Math.floor(metadata.height*scale)),fit:'fill'});
          if(normalized)wide=wide.greyscale().normalize();
          const candidate=await wide.png().toBuffer();
          await rasterDiagnostic(candidate,{pass:++pass,angle,psm:'11',enhanced:normalized});
          const data=(await worker.recognize(candidate,{}, {text:true,blocks:true})).data;
          if(!consistent(data))return {pending:true,reason:'photo_size_or_reference_pending'};
          const observed=readWords(data);
          if(observed&&partial&&partial.size!==observed.size)return {pending:true,reason:'photo_size_or_reference_pending'};
          if(observed){
            if(incompleteNineDigitReference(observed))partial=partial||observed;
            else return {...observed,decodedBarcodes:codes};
          }
        }
      }
      if(partial)return {...partial,decodedBarcodes:codes};
    }
    return { pending: true, reason: 'photo_size_or_reference_pending' };
  }
  async function run(kind, image, barcode, onDiagnostic = deps.onDiagnostic) {
    if (busy) throw Error('image_process_busy');
    busy = true;
    // The callback belongs to this invocation, never a mutable current-job ID.
    const diagnostic=(phase,fields={})=>{try{onDiagnostic?.({phase,...fields});}catch(_){}};
    diagnostic.enabled=typeof onDiagnostic==='function';
    try {
      if (kind === 'barcode') {diagnostic('decode');return await decode(image);}
      if (kind === 'label') return await label(image, barcode,diagnostic);
      throw Error('image_operation_invalid');
    } finally { busy = false; }
  }
  async function close() {
    if (busy) throw Error('image_process_busy');
    if (worker) { const old = worker; worker = null; await old.terminate(); }
  }
  return { run, close };
}
module.exports = { createProcessor };
