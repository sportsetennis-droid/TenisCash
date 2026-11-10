'use strict';
const { createHash } = require('node:crypto');
const { canonicalProduct } = require('./scannerCatalog');
const barcodePolicy = require('../../public/scanner-barcode-policy');
const norm = value => String(value || '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sizeKey = value => String(value || '').replace(',', '.').replace(/\s*\/\s*/g, '/');
const sizeToken = /^\d{2}(?:[.,]5|\/\d{2})?$/;
const pairedSize=value=>/^\d{2}\/\d{2}$/.test(value)&&Number(value.slice(3))===Number(value.slice(0,2))+1;
// A printed paired size is one variant. Reassemble only adjacent OCR words
// containing a literal slash; never infer a pair from two nearby numbers.
function sizeWords(words) {
  const text=w=>String(w.text||'').normalize('NFKC').trim().replace(/\s*\/\s*/g,'/');
  const reliable=w=>w.confidence>=75;
  const all=words.filter(w=>w.bbox),consumed=new Set(),paired=[];
  const adjacent=(a,b)=>{
    const ah=a.bbox.y1-a.bbox.y0,bh=b.bbox.y1-b.bbox.y0;
    return Math.abs((a.bbox.y0+a.bbox.y1-b.bbox.y0-b.bbox.y1)/2)<=Math.max(ah,bh)*.35&&
      b.bbox.x0>=a.bbox.x1-Math.max(ah,bh)*.1&&b.bbox.x0-a.bbox.x1<=Math.max(ah,bh)*.75;
  };
  const next=a=>all.filter(b=>b!==a&&adjacent(a,b)).sort((x,y)=>x.bbox.x0-y.bbox.x0)[0];
  for(const first of all.filter(w=>reliable(w)&&/^\d{2}\/?$/.test(text(w)))){
    const second=next(first);if(!second)continue;
    let members=[first,second];
    if(/^\d{2}$/.test(text(first))&&text(second)==='/'){
      const third=next(second);if(!third)continue;members.push(third);
    }
    const joined=members.map(text).join('');
    if(!pairedSize(joined)||members.some(w=>!reliable(w)))continue;
    members.forEach(w=>consumed.add(w));
    paired.push({members,word:{text:joined,confidence:Math.min(...members.map(w=>w.confidence)),bbox:{
      x0:Math.min(...members.map(w=>w.bbox.x0)),y0:Math.min(...members.map(w=>w.bbox.y0)),
      x1:Math.max(...members.map(w=>w.bbox.x1)),y1:Math.max(...members.map(w=>w.bbox.y1))}}});
  }
  const continuation=w=>/^[\d/.,]+[A-Z]*$/i.test(text(w))&&(/[\/]/.test(text(w))||/^[.,]/.test(text(w)));
  const candidates=[...paired,...all.filter(w=>reliable(w)&&!consumed.has(w)&&sizeToken.test(text(w))&&(!text(w).includes('/')||pairedSize(text(w))))
    .map(w=>({members:[w],word:{...w,text:text(w)}}))];
  // Consume the complete printed chain, including weak/invalid fragments.
  // Neither "40/" + "41/42" nor "39/40" + "/41" is a two-number size.
  // This veto applies to composed candidates as well as isolated endpoints.
  return candidates.filter(({members})=>!all.some(other=>!members.includes(other)&&continuation(other)&&
    members.some(member=>adjacent(other,member)||adjacent(member,other)))).map(candidate=>candidate.word);
}
// Only complete printed identity shapes take part in the conflict veto.
// Bare numeric fragments can also be manufacturing codes and are not joined.
function identityReferences(words,references,numericColours=[]){
  // Do not turn a field such as "SAC:0800" into an apparent model SAC0800
  // by stripping its punctuation. Require a printed model token itself.
  const literal=new Set(words.filter(w=>/^[A-Z]{1,3}\d{4,10}(?:[-/]\d{2,4})?$/.test(w.text.normalize('NFKC').toUpperCase().trim())).map(w=>norm(w.text)));
  return references.filter(ref=>/^\d{9}[A-Z]{2,8}(?:\d{1,3})?$/.test(ref)||literal.has(ref)||numericColours.includes(ref));
}
// Puma prints a six-digit model followed by its two-digit colour, for example
// "107952 01". Preserve both literal tokens only when their typography and
// spacing form one field. Size columns and weak/intervening words are vetoes.
function numericColourReferences(words) {
  const all=words.filter(w=>w.bbox),height=w=>w.bbox.y1-w.bbox.y0;
  const cy=w=>(w.bbox.y0+w.bbox.y1)/2,cx=w=>(w.bbox.x0+w.bbox.x1)/2;
  const text=w=>String(w.text||'').trim(),joined=[];
  const following=w=>all.filter(z=>z!==w&&z.bbox.x0>=w.bbox.x1&&
    Math.abs(cy(z)-cy(w))<=Math.max(height(w),height(z))*.3&&
    z.bbox.x0-w.bbox.x1<=height(w)).sort((a,b)=>a.bbox.x0-b.bbox.x0);
  for(const model of all.filter(w=>w.confidence>=75&&/^\d{6}$/.test(text(w)))){
    const colour=following(model)[0];
    if(!colour||colour.confidence<75||!/^\d{2}$/.test(text(colour))||
      height(colour)<Math.floor(height(model)*.7)||height(colour)>height(model)*1.4)continue;
    // An extra adjacent numeric/slash token makes the printed chain incomplete.
    if(following(colour).some(w=>/^[\d/.,-]+$/.test(text(w))))continue;
    const ownedByScale=all.some(w=>w!==model&&w!==colour&&/^(BR|BRA|USA?|UK|EUR|EU|F|CM|CHN|JP|J|SIZE|TAM)$/i.test(text(w))&&(
      Math.abs(cy(w)-cy(colour))<=Math.max(height(w),height(colour))*.6&&
        // A tall, weak OCR artifact must not claim a distant model/colour
        // field. Reliable large scales and nearby weak scales retain vetoes.
        Math.max(0,w.bbox.x0-colour.bbox.x1,colour.bbox.x0-w.bbox.x1)<=Math.max(height(colour),w.confidence>=75?height(w):height(model))*5||
      Math.abs(cx(w)-cx(colour))<=Math.max(w.bbox.x1-w.bbox.x0,colour.bbox.x1-colour.bbox.x0)*.6&&
        Math.max(0,w.bbox.y0-colour.bbox.y1,colour.bbox.y0-w.bbox.y1)<=Math.max(height(w),height(colour))*1.5));
    if(!ownedByScale)joined.push(text(model)+text(colour));
  }
  return [...new Set(joined)];
}
// OUS labels in this import print a 350xxx model and a one-to-three-digit
// variation. This is a field grammar, not brand evidence: require literal
// Ref punctuation or a printed dash, and keep both model and colour. Never
// assemble bare numbers across a gap or repair a weak/missing OCR character.
const ousIdentity=ref=>/^350\d{3}\d{1,3}$/.test(ref)?ref.slice(0,6)+':'+Number(ref.slice(6)):ref;
function ousReferenceFields(words){
  const all=words.filter(w=>w.bbox),text=w=>String(w.text||'').normalize('NFKC').trim();
  const h=w=>w.bbox.y1-w.bbox.y0,cy=w=>(w.bbox.y0+w.bbox.y1)/2;
  const dash=/^[-\u2013\u2014]$/;
  const nearby=(a,b,height)=>Math.abs(cy(a)-cy(b))<=Math.max(height,h(b))*.35&&
    b.bbox.x0>=a.bbox.x1&&b.bbox.x0-a.bbox.x1<=height*1.5;
  const next=(a,height)=>all.filter(b=>b!==a&&nearby(a,b,height)).sort((a,b)=>a.bbox.x0-b.bbox.x0)[0];
  const fields=[];let conflict=false;
  for(const first of all.filter(w=>w.confidence>=75)){
    const raw=text(first),full=raw.match(/^(?:REF[.:]+\s*)?(350\d{3})\s*[-\u2013\u2014]\s*(\d{1,3})$/i);
    const head=raw.match(/^(REF[.:]+\s*)?(350\d{3})\s*([-\u2013\u2014])?$/i);
    let members=[first],model,colour,last=first;
    if(full){model=full[1];colour=full[2];}
    else if(head){
      model=head[2];let context=!!head[1]||!!head[3],candidate=next(first,h(first));
      if(candidate&&dash.test(text(candidate))){members.push(candidate);last=candidate;context=true;candidate=next(candidate,h(first));}
      if(!context){
        const prefix=all.find(w=>w!==first&&w.confidence>=75&&/^REF[.:]+$/i.test(text(w))&&nearby(w,first,h(first))&&next(w,h(first))===first);
        if(prefix){members.unshift(prefix);context=true;}
      }
      if(!context)continue;
      if(!candidate||!/^\d{1,3}$/.test(text(candidate))){conflict=true;continue;}
      if(h(candidate)<Math.floor(h(first)*.7)||h(candidate)>h(first)*1.4){conflict=true;continue;}
      members.push(candidate);last=candidate;colour=text(candidate);
    }else{
      if(/^(?:REF[.:]+\s*)?350\d{3}\s*[-\u2013\u2014]\s*\d/i.test(raw))conflict=true;
      continue;
    }
    if(members.some(w=>w.confidence<75)){conflict=true;continue;}
    // Consume the complete numeric field, including weak continuations. A
    // nearby scale or an extra slash/digit cannot be hidden by normalization.
    const before=members[0],height=h(first);
    if(all.some(w=>!members.includes(w)&&/^[A-Z\d/.,-]+$/i.test(text(w))&&!/^REF[.:]+$/i.test(text(w))&&
      (nearby(last,w,height)||nearby(w,before,height)))){conflict=true;continue;}
    const ownedByScale=all.some(w=>!members.includes(w)&&/^(BR|BRA|USA?|UK|EUR|EU|F|CM|CHN|JP|J|SIZE|TAM)$/i.test(text(w))&&(
      Math.abs(cy(w)-cy(last))<=Math.max(height,h(w))*.6&&
      Math.max(0,w.bbox.x0-last.bbox.x1,last.bbox.x0-w.bbox.x1)<=height*5||
      Math.abs((w.bbox.x0+w.bbox.x1-last.bbox.x0-last.bbox.x1)/2)<=Math.max(w.bbox.x1-w.bbox.x0,last.bbox.x1-last.bbox.x0)*.6&&
      Math.max(0,w.bbox.y0-last.bbox.y1,last.bbox.y0-w.bbox.y1)<=Math.max(height,h(w))*1.5));
    if(ownedByScale)conflict=true;else fields.push(model+colour);
  }
  return {references:[...new Set(fields)],conflict};
}
function printedReferences(words,numericColours=[]) {
  // OCR can merge two complete printed scale fields into one token. Require
  // both scale labels and a literal separator; never treat US11/29CM as a model.
  const scale='(?:BRA?|USA?|UK|EUR|EU|F|CM|CHN|JP|J)',value='\\d{1,2}(?:[.,]5)?';
  const scaleField='(?:'+scale+'\\s*'+value+'|'+value+'\\s*'+scale+')';
  const compoundScales=new RegExp('^'+scaleField+'\\s*/\\s*'+scaleField+'$','i');
  // Sparse OCR often emits "US" and "8/25.5CM" as separate words. The
  // literal number/number-CM token is still a scale field, never a model.
  const splitCentimetres=/^\d{1,2}(?:[.,]5)?\s*\/\s*\d{1,3}(?:[.,]5)?\s*CM$/i;
  const references = new Set(words.filter(w=>!compoundScales.test(w.text.trim())&&!splitCentimetres.test(w.text.trim())&&!/^(?:BR|BRA|USA?|UK|EUR|EU|F|CM|CHN|JP|J)\s*\d{1,2}(?:[.,]5|\s*\/\s*\d{2})?$/i.test(w.text)).map(w => norm(w.text)).filter(x => /^\d{5,10}$/.test(x) ||
    (x.length >= 5 && x.length <= 25 && /[A-Z]/.test(x) && /\d/.test(x))));
  // Model and colour can be separate OCR words: "220644 / BKW". Keep
  // their printed spatial relationship; never attach a colour from another row.
  for (const model of words.filter(w => /^\d{5,8}(?:BR)?$/.test(norm(w.text)))) {
    const a=model.bbox,h=a.y1-a.y0,cy=(a.y0+a.y1)/2;
    const following=words.filter(w=>w!==model&&w.bbox.x0>=a.x1&&
      Math.abs((w.bbox.y0+w.bbox.y1)/2-cy)<=Math.max(h,w.bbox.y1-w.bbox.y0)*.35&&
      w.bbox.x0-a.x1<=h*3).sort((x,y)=>x.bbox.x0-y.bbox.x0);
    const separator=following[0],colour=following[1];
    if(separator&&/^[\/|\-]$/.test(separator.text.trim())&&colour&&/^[A-Z]{2,8}$/.test(colour.text.trim())&&
      colour.bbox.x0-separator.bbox.x1<=h*1.5)references.add(norm(model.text)+norm(colour.text));
  }
  // Some labels print a nine-digit model followed by a colour token without
  // punctuation (including alphanumeric colours). Preserve the exact token;
  // never reorder a colour number, attach another line, or append a size.
  const joinedNineDigitReferences=new Set([...references].filter(ref=>/^\d{9}[A-Z]{2,8}(?:\d{1,3})?$/.test(ref)));
  for (const model of words.filter(w => /^\d{9}$/.test(w.text.trim()))) {
    const a=model.bbox,h=a.y1-a.y0,cy=(a.y0+a.y1)/2;
    const next=words.filter(w=>w!==model&&w.bbox.x0>=a.x1&&
      Math.abs((w.bbox.y0+w.bbox.y1)/2-cy)<=Math.max(h,w.bbox.y1-w.bbox.y0)*.35&&
      w.bbox.x0-a.x1<=h*2).sort((x,y)=>x.bbox.x0-y.bbox.x0);
    const separated=next[0]&&/^[\/|\-\u2013\u2014]$/.test(next[0].text.trim()),colour=next[separated?1:0];
    if(!colour)continue;
    const token=colour.text.trim(),ch=colour.bbox.y1-colour.bbox.y0;
    if(!/^[A-Z]{2,8}(?:\d{1,3})?$/.test(token)||/^(?:BR|BRA|USA?|UK|EUR|EU|CM|CHN|JP|SIZE|TAM)\d*$/.test(token))continue;
    if(ch<h*.6||ch>h*1.5||colour.bbox.x0-(separated?next[0].bbox.x1:a.x1)>h)continue;
    const joined=norm(model.text)+token;
    references.add(joined);joinedNineDigitReferences.add(joined);
  }
  numericColours.forEach(ref=>references.add(ref));
  if(joinedNineDigitReferences.size>1 || new Set(identityReferences(words,[...references],numericColours)).size>1)return null;
  return [...references];
}

// Keep geometry: in a multiscale label "43 BR" is not "11 USA".
function readParts(data) {
  const words = (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => l.words || [])));
  // Some OCR passes retain BRA40/41 as one word. The scale and the complete
  // literal pair share that word's bounds; no catalog or foreign scale is used.
  const joinedBr=words.filter(w=>w.confidence>=75&&w.bbox&&/^(BRA?)\s*[: -]?\s*\d{2}\s*\/\s*\d{2}$/i.test(w.text));
  for(const w of joinedBr){const match=w.text.match(/^(BRA?)\s*[: -]?\s*(\d{2}\s*\/\s*\d{2})$/i);
    words.push({...w,text:match[1]}, {...w,text:sizeKey(match[2])});}
  const reliable = words.filter(w => w.confidence >= 75 && w.bbox);
  const numericWords=sizeWords(words);
  const sizes = new Set();
  const brLabels=reliable.filter(w => /^(BR|BRA)$/i.test(w.text));
  // Two printed Brazilian scales may belong to two boxes, even when their
  // values happen to be equal. Do not collapse those labels into one answer.
  if(brLabels.length>1)return {conflict:true};
  for (const label of brLabels) {
    const b = label.bbox, h = b.y1 - b.y0;
    // A vertical multi-scale column may put the previous scale's value as
    // close to BR as BR's own value. Infer direction only from two other
    // literal scale/value pairs and the unambiguous start of that column.
    const cy=w=>(w.bbox.y0+w.bbox.y1)/2,cx=w=>(w.bbox.x0+w.bbox.x1)/2;
    const sameColumn=w=>Math.abs(cx(w)-cx(label))<=Math.max(b.x1-b.x0,w.bbox.x1-w.bbox.x0)*.6;
    const scaleWords=reliable.filter(w=>/^(BR|BRA|USA?|UK|EUR|EU|F|CM|CHN|JP|J)$/i.test(w.text));
    const scales=scaleWords.filter(sameColumn).sort((a,z)=>cy(a)-cy(z));
    const nums=reliable.filter(w=>/^\d{1,2}(?:[.,]5)?$/.test(w.text)&&sameColumn(w));
    let belowOnly=false;
    if(scales.length>=3){const first=scales[0],gap=w=>Math.max(first.bbox.y1-first.bbox.y0,w.bbox.y1-w.bbox.y0)*1.5;
      const before=nums.some(w=>cy(w)<cy(first)&&first.bbox.y0-w.bbox.y1<=gap(w));
      const pairs=scales.filter(s=>s!==label&&nums.some(w=>cy(w)>cy(s)&&w.bbox.y0-s.bbox.y1<=Math.max(s.bbox.y1-s.bbox.y0,w.bbox.y1-w.bbox.y0)*1.5&&!scales.some(t=>cy(t)>cy(s)&&cy(t)<cy(w))));
      belowOnly=!before&&pairs.length>=2;
    }
    // Discard values owned by a clearly closer foreign scale before counting
    // BR candidates: EUR40 above BR38 must not make BR38 ambiguous.
    const distance=(a,z)=>Math.hypot(Math.max(0,a.x0-z.x1,z.x0-a.x1),Math.max(0,a.y0-z.y1,z.y0-a.y1));
    const foreignOwned=selected=>{const sh=selected.bbox.y1-selected.bbox.y0,brDistance=distance(b,selected.bbox);
      return scaleWords.some(s=>{if(s===label)return false;const a=s.bbox,ah=a.y1-a.y0;
        const row=Math.abs(cy(s)-cy(selected))<=Math.max(ah,sh)*.6;
        const column=Math.abs(cx(s)-cx(selected))<=Math.max(a.x1-a.x0,selected.bbox.x1-selected.bbox.x0)*.6;
        return (row||column)&&distance(a,selected.bbox)+Math.max(ah,sh)*.15<brDistance;
      });};
    const nearby = numericWords.filter(w => w !== label&&!foreignOwned(w)).filter(w => {
      const a = w.bbox, ah = a.y1 - a.y0;
      const sameRow = Math.abs((a.y0 + a.y1 - b.y0 - b.y1) / 2) <= Math.max(h, ah) * .6
        && Math.max(0, a.x0 - b.x1, b.x0 - a.x1) <= Math.max(h, ah) * 5;
      const sameColumn = Math.abs((a.x0 + a.x1 - b.x0 - b.x1) / 2) <= Math.max(b.x1 - b.x0, a.x1 - a.x0) * .6
        && Math.max(0, a.y0 - b.y1, b.y0 - a.y1) <= Math.max(h, ah) * 1.5;
      return sameRow || (sameColumn&&(!belowOnly||cy(w)>cy(label)));
    });
    if(nearby.length!==1)continue;
    // If BR's number was not recognized, the preceding scale's value can be
    // the only reliable neighbour (CM 24 / BRA [unreadable]). Ambiguous
    // attachment is not BR evidence; never relabel that value as Brazilian.
    const selected=nearby[0];
    if(cy(selected)<cy(label)&&scales.some(s=>s!==label&&cy(s)<cy(selected)&&
      selected.bbox.y0-s.bbox.y1<=Math.max(s.bbox.y1-s.bbox.y0,selected.bbox.y1-selected.bbox.y0)*1.5))continue;
    // A number on the other side of a foreign scale belongs to that scale;
    // proximity alone must never turn "BR [unreadable] EUR 43" into BR 43.
    if(scaleWords.some(s=>s!==label&&Math.abs(cy(s)-cy(selected))<=Math.max(s.bbox.y1-s.bbox.y0,selected.bbox.y1-selected.bbox.y0)*.6&&cx(s)>Math.min(cx(label),cx(selected))&&cx(s)<Math.max(cx(label),cx(selected))))continue;
    sizes.add(sizeKey(nearby[0].text));
  }
  if(sizes.size>1)return {conflict:true};
  const numericColours=numericColourReferences(words);
  // Eight digits alone can be a manufacturing code or a clipped OCR token.
  // They become contradictory to a model/colour only after that printed
  // six-plus-two field is present; retain candidates for the cross-pass veto.
  const numericReferenceTokens=[...new Set(reliable.filter(w=>/^\d{6}[\s/-]?\d{2}$/.test(w.text.normalize('NFKC').trim())).map(w=>norm(w.text)))];
  if(numericColours.length&&new Set([...numericColours,...numericReferenceTokens]).size>1)return {conflict:true};
  const references = printedReferences(reliable,numericColours);
  if(!references)return {conflict:true};
  const ousFields=ousReferenceFields(words);
  if(ousFields.conflict)return {conflict:true};
  const completeOusReferences=ousFields.references;
  const ousReferenceTokens=[...new Set(reliable.map(w=>w.text.normalize('NFKC').trim().match(/^(?:REF[.:]+\s*)?(350\d{3})(?:\s*[-/\u2013\u2014]\s*|\s*)(\d{1,3})$/i))
    .filter(Boolean).map(match=>match[1]+match[2]))];
  const identities=[...new Set([...identityReferences(reliable,references,numericColours),...completeOusReferences])];
  if(completeOusReferences.length&&new Set([...identities,...ousReferenceTokens].map(ousIdentity)).size>1)return {conflict:true};
  for(const ref of completeOusReferences)if(!references.includes(ref))references.push(ref);
  return {size:sizes.size?[...sizes][0]:null,references,identityReferences:identities,numericColourReferences:numericColours,numericReferenceTokens,
    completeOusReferences,ousReferenceTokens,text:String(data.text||'').slice(0,12000)};
}

function readWords(data){const parts=readParts(data);return !parts.conflict&&parts.size&&parts.references.length?{size:parts.size,references:parts.references,text:parts.text,source:'archived-photo-local-ocr-v1',...(parts.completeOusReferences.length?{completeOusReferences:parts.completeOusReferences}:{})}:null;}

async function readImage(image, barcode) {
  try { return await require('./scannerImageBroker').run('label', image, barcode); }
  catch (error) {
    const reasons = { SCANNER_IMAGE_BUSY: 'ocr_busy', SCANNER_IMAGE_TIMEOUT: 'ocr_timeout',
      SCANNER_IMAGE_MEMORY_LIMIT: 'ocr_memory_limit', SCANNER_IMAGE_INVALID: 'photo_input_invalid' };
    const scannerDiagnostic=require('./scannerRuntimeDiagnostic').sanitize(error.scannerDiagnostic);
    return { pending: true, retry: error.code !== 'SCANNER_IMAGE_INVALID', reason: reasons[error.code] || 'ocr_unavailable',...(scannerDiagnostic?{scannerDiagnostic}:{}) };
  }
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
    || !(/^\d{2}(?:\.5)?$/.test(evidence.size)||pairedSize(evidence.size))) return { reason: 'photo_evidence_conflict' };
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
    const literalBr = String(row.description).match(/\bBRA?\s*[: -]?\s*(\d{2}(?:\s*\/\s*\d{2}|[.,]5)?)(?![\d/.,])/i);
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
module.exports = { readWords, readParts, readImage, fiscalRows, target };
