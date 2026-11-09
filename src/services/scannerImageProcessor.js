'use strict';
const path = require('node:path');
const barcodePolicy = require('../../public/scanner-barcode-policy');
// One reusable OCR worker per isolated process; the parent owns deadlines.
// Never terminate while Tesseract is preparing an image asynchronously.
function createProcessor(deps = {}) {
  const sharp = deps.sharp || require('sharp');
  const decode = deps.decode || require('./scannerBarcodeEngine').decode;
  const readWords = deps.readWords || require('./scannerArchivedLabel').readWords;
  const createWorker = deps.createWorker || require('tesseract.js').createWorker;
  let worker, busy = false;
  const input = image => sharp(image, { limitInputPixels: 24000000 });
  async function label(image, barcode) {
    const codes = await decode(image);
    if (!codes.length) return { pending: true, reason: 'photo_barcode_not_found' };
    if (codes.length > 1) return { pending: true, reason: 'photo_barcode_conflict' };
    if (barcodePolicy.identity(codes[0]) !== barcodePolicy.identity(barcode)) return { pending: true, reason: 'photo_barcode_mismatch' };
    if (!worker) worker = await createWorker('eng', 1, {
      langPath: path.join(__dirname, '../../public/vendor/ocr'), cacheMethod: 'none', errorHandler: () => {},
    });
    await worker.setParameters({ preserve_interword_spaces: '1' });
    let stretched=false;
    for (const angle of [0, 90, 270, 180]) {
      const frame = angle ? await input(image).rotate(angle).png().toBuffer() : image;
      const metadata = await input(frame).metadata();
      const enhanced = await input(frame).resize({ width: Math.min(3000, metadata.width * 2) }).greyscale().normalize().png().toBuffer();
      // Same original/enhanced pixels and literal-scale guards. No database
      // product/size information is sent to this process.
      let nineDigitText=false,partial=null;
      for (const psm of ['11', '6']) {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        for (const candidate of [frame, enhanced]) {
          const data=(await worker.recognize(candidate, {}, { text: true, blocks: true })).data;
          // This is only a trigger for another attempt, never identity/size
          // evidence. The next read still has to pass every literal guard.
          nineDigitText ||= (data.blocks||[]).some(b=>(b.paragraphs||[]).some(p=>(p.lines||[]).some(l=>(l.words||[]).some(w=>w.confidence>=75&&/^\d{9}$/.test(String(w.text||'').trim())))));
          const observed = readWords(data);
          if (observed) {
            if(partial&&partial.size!==observed.size)return {pending:true,reason:'photo_size_or_reference_pending'};
            const incompleteNineDigitReference=observed.references.some(ref=>/^\d{9}$/.test(ref))&&!observed.references.some(ref=>/^\d{9}[A-Z]{2,8}(?:\d{1,3})?$/.test(ref));
            if(incompleteNineDigitReference&&!stretched)partial=partial||observed;
            else return { ...observed, decodedBarcodes: codes };
          }
        }
      }
      if(nineDigitText&&!stretched){
        stretched=true;
        // Narrow printed fonts can defeat segmentation even in a sharp photo.
        // Expand the WHOLE frame horizontally; no label/number is cropped out.
        // At most one extra pass per request, <=4MP, same parent deadline/RSS.
        const scale=Math.min(1,1800/Math.max(metadata.width,metadata.height),Math.sqrt(4000000/(metadata.width*metadata.height*2)));
        const wide=await input(frame).resize({width:Math.max(1,Math.floor(metadata.width*scale*2)),height:Math.max(1,Math.floor(metadata.height*scale)),fit:'fill'}).greyscale().normalize().png().toBuffer();
        await worker.setParameters({tessedit_pageseg_mode:'11'});
        const observed=readWords((await worker.recognize(wide,{}, {text:true,blocks:true})).data);
        if(observed&&partial&&partial.size!==observed.size)return {pending:true,reason:'photo_size_or_reference_pending'};
        if(observed)return {...observed,decodedBarcodes:codes};
      }
      if(partial)return {...partial,decodedBarcodes:codes};
    }
    return { pending: true, reason: 'photo_size_or_reference_pending' };
  }
  async function run(kind, image, barcode) {
    if (busy) throw Error('image_process_busy');
    busy = true;
    try {
      if (kind === 'barcode') return await decode(image);
      if (kind === 'label') return await label(image, barcode);
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
