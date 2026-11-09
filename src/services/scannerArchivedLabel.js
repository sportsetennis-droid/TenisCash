'use strict';
const path = require('path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { canonicalProduct } = require('./scannerCatalog');
const barcodePolicy = require('../../public/scanner-barcode-policy');
const norm = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sizeKey = value => String(value || '').replace(',', '.');
let busy = false;

// Keep geometry: in a multiscale label "43 BR" is not "11 USA".
function readWords(data) {
  const words = (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => l.words || [])));
  const reliable = words.filter(w => w.confidence >= 75 && w.bbox);
  const sizes = new Set();
  for (const label of reliable.filter(w => /^(BR|BRA)$/i.test(w.text))) {
    const b = label.bbox, h = b.y1 - b.y0;
    // A vertical multi-scale column may put the previous scale's value as
    // close to BR as BR's own value. Infer direction only from two other
    // literal scale/value pairs and the unambiguous start of that column.
    const cy=w=>(w.bbox.y0+w.bbox.y1)/2,cx=w=>(w.bbox.x0+w.bbox.x1)/2;
    const sameColumn=w=>Math.abs(cx(w)-cx(label))<=Math.max(b.x1-b.x0,w.bbox.x1-w.bbox.x0)*.6;
    const scales=reliable.filter(w=>/^(BR|BRA|USA?|UK|EUR|EU|CM|CHN)$/i.test(w.text)&&sameColumn(w)).sort((a,z)=>cy(a)-cy(z));
    const nums=reliable.filter(w=>/^\d{1,2}(?:[.,]5)?$/.test(w.text)&&sameColumn(w));
    let belowOnly=false;
    if(scales.length>=3){const first=scales[0],gap=w=>Math.max(first.bbox.y1-first.bbox.y0,w.bbox.y1-w.bbox.y0)*1.5;
      const before=nums.some(w=>cy(w)<cy(first)&&first.bbox.y0-w.bbox.y1<=gap(w));
      const pairs=scales.filter(s=>s!==label&&nums.some(w=>cy(w)>cy(s)&&w.bbox.y0-s.bbox.y1<=Math.max(s.bbox.y1-s.bbox.y0,w.bbox.y1-w.bbox.y0)*1.5&&!scales.some(t=>cy(t)>cy(s)&&cy(t)<cy(w))));
      belowOnly=!before&&pairs.length>=2;
    }
    const nearby = reliable.filter(w => /^\d{2}(?:[.,]5)?$/.test(w.text) && w !== label).filter(w => {
      const a = w.bbox, ah = a.y1 - a.y0;
      const sameRow = Math.abs((a.y0 + a.y1 - b.y0 - b.y1) / 2) <= Math.max(h, ah) * .6
        && Math.max(0, a.x0 - b.x1, b.x0 - a.x1) <= Math.max(h, ah) * 5;
      const sameColumn = Math.abs((a.x0 + a.x1 - b.x0 - b.x1) / 2) <= Math.max(b.x1 - b.x0, a.x1 - a.x0) * .6
        && Math.max(0, a.y0 - b.y1, b.y0 - a.y1) <= Math.max(h, ah) * 1.5;
      return sameRow || (sameColumn&&(!belowOnly||cy(w)>cy(label)));
    });
    if (nearby.length !== 1) return null;
    sizes.add(sizeKey(nearby[0].text));
  }
  if (sizes.size !== 1) return null;
  const references = [...new Set(reliable.map(w => norm(w.text)).filter(x => /^\d{5,10}$/.test(x) || (x.length >= 5 && x.length <= 25 && /[A-Z]/.test(x) && /\d/.test(x))))];
  if (!references.length) return null;
  return { size: [...sizes][0], references, text: String(data.text || '').slice(0, 12000), source: 'archived-photo-local-ocr-v1' };
}

async function readImage(image, barcode) {
  if (busy) return { pending: true, retry: true, reason: 'ocr_busy' };
  busy = true;
  let worker, timer, expired = false;
  try {
    const work = (async () => {
      const codes = await require('./barcodeDecoder').decodeBarcodesFromDataUri('data:image/jpeg;base64,' + image.toString('base64'));
      if (codes.length !== 1 || barcodePolicy.identity(codes[0]) !== barcodePolicy.identity(barcode)) return { pending: true, reason: 'photo_barcode_conflict' };
      worker = await require('tesseract.js').createWorker('eng', 1, { langPath: path.join(__dirname, '../../public/vendor/ocr'), cacheMethod: 'none', errorHandler: () => {} });
      if (expired) { await worker.terminate(); return null; }
      await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
      for (const angle of [0, 90, 270, 180]) {
        if (expired) return null;
        const frame = angle ? await sharp(image).rotate(angle).png().toBuffer() : image;
        const { data } = await worker.recognize(frame, {}, { text: true, blocks: true });
        const read = readWords(data);
        if (read) return { ...read, decodedBarcodes: codes };
        if(expired)return null;
        const metadata=await sharp(frame).metadata();
        const enhanced=await sharp(frame).resize({width:Math.min(3000,metadata.width*2)}).greyscale().normalize().png().toBuffer();
        const improved=readWords((await worker.recognize(enhanced,{}, {text:true,blocks:true})).data);
        if(improved)return {...improved,decodedBarcodes:codes};
      }
      return { pending: true, reason: 'photo_size_or_reference_pending' };
    })();
    return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve({ pending: true, retry: true, reason: 'ocr_timeout' }); }, 16000); })]);
  } catch (_) { return { pending: true, retry: true, reason: 'ocr_unavailable' }; }
  finally { clearTimeout(timer); if (worker) await worker.terminate().catch(() => {}); busy = false; }
}

async function fiscalRows(db, barcode) {
  return db.$queryRaw`SELECT i.id, i."productId", i.description, i.ean, i."supplierCode" FROM "XmlFiscalItem" i JOIN "XmlFiscalDocument" d ON d.id=i."fiscalDocumentId" WHERE d."docType"='entrada' AND i.ean IN (SELECT jsonb_array_elements_text(${JSON.stringify(barcodePolicy.variants(barcode))}::jsonb)) AND i."productId" IS NOT NULL LIMIT 51`;
}

// Internal evidence generated from the archived bytes, never accepted from an HTTP body.
async function target(db, barcode, evidence) {
  const photo = await db.scanActionPhoto.findUnique({ where: { id: evidence.photoId }, include: { scan: { include: { lot: true } } } });
  if (!photo || photo.sha256 !== evidence.sha256 || createHash('sha256').update(photo.image).digest('hex') !== evidence.sha256
    || photo.scan.removed || photo.scan.lot.status !== 'open' || barcodePolicy.identity(photo.scan.barcode) !== barcodePolicy.identity(barcode)
    || barcodePolicy.identity(photo.barcode) !== barcodePolicy.identity(barcode) || evidence.source !== 'archived-photo-local-ocr-v1'
    || evidence.decodedBarcodes?.length !== 1 || barcodePolicy.identity(evidence.decodedBarcodes[0]) !== barcodePolicy.identity(barcode)
    || !/^\d{2}(?:\.5)?$/.test(evidence.size)) return { reason: 'photo_evidence_conflict' };
  const rows = await fiscalRows(db, barcode);
  if (!rows.length || rows.length > 50) return { reason: 'reference_conflict' };
  const targets = [];
  for (const row of rows) {
    const product = await canonicalProduct(db, await db.product.findUnique({ where: { id: row.productId }, include: { sizes: true } }));
    if (!product) return { reason: 'inactive_product' };
    const refs = [product.sku, product.aiContext?.supplierRef, ...(Array.isArray(product.aiContext?.scannerReferences) ? product.aiContext.scannerReferences : []), row.supplierCode].map(norm);
    const printed = evidence.references.find(ref => refs.includes(ref));
    // Reebok fiscal codes in this import contain the printed 9-digit model,
    // letters for the variant, then BR. The size is READ from the photo; this
    // check only corroborates that literal and never derives it from the code.
    const reebok = norm(product.brand) === 'REEBOK' && norm(row.supplierCode).match(/^(\d{9})([A-Z]{2,12})(\d{2})$/);
    const reebokRef = reebok && evidence.references.includes(reebok[1]);
    if (reebokRef && reebok[3] !== evidence.size) return { reason: 'size_conflict' };
    if (!printed && !reebokRef) return { reason: 'reference_conflict' };
    const literalBr = String(row.description).match(/\bBR\s*[: -]?\s*(\d{2}(?:[.,]5)?)(?!\d)/i);
    if (literalBr && sizeKey(literalBr[1]) !== evidence.size) return { reason: 'size_conflict' };
    const brands = [...String(evidence.text).matchAll(/\b(REEBOK|NIKE|ADIDAS|PUMA|FILA|ASICS|SKECHERS|MIZUNO|OLYMPIKUS)\b/gi)].map(m => norm(m[1]));
    if (brands.some(b => b !== norm(product.brand))) return { reason: 'brand_conflict' };
    targets.push({ productId: product.id, size: evidence.size, itemId: row.id, photoEvidence: { photoId: photo.id, scanId: photo.scanId, sha256: photo.sha256, reference: printed || reebok[1], size: evidence.size, source: evidence.source } });
  }
  if (new Set(targets.map(t => t.productId + ':' + t.size)).size !== 1) return { reason: 'barcode_conflict' };
  const selected = targets[0];
  if (photo.scan.lot.transferId) {
    const expected = await db.stockTransferItem.findFirst({ where: { transferId: photo.scan.lot.transferId, productSize: { productId: selected.productId, size: selected.size } } });
    if (!expected) return { reason: 'transfer_conflict' };
  }
  return selected;
}
module.exports = { readWords, readImage, fiscalRows, target };
