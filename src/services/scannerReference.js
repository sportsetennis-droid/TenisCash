'use strict';
const {canonicalProduct,resolveBarcodeRows,aliasRows}=require('./scannerCatalog');
const barcodePolicy = require('../../public/scanner-barcode-policy');

// Exact identifiers only. Punctuation is insignificant; colour suffixes are not.
function normalizeReference(value) {
  return String(value || '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// Fiber imports keep the first imported size in the unified product's SKU.
// Separate only that documented terminal size; model, colour and version are
// all retained. This is not a generic suffix stripper for other manufacturers.
function fiberReferenceIdentity(value) {
  const ref=normalizeReference(value);
  const match=ref.match(/^(?:0110)?(TFBU(?:BLACK|WHITE)|TFERS?(?:BLACK|WHITE))(\d{2})?$/)
    ||ref.match(/^(?:0110)?(FBRFLYR(?:BLACK|BW)V[1-9])(\d{2})?$/)
    ||ref.match(/^(?:0110)?(SFBMUL\d{4}V[1-9])(\d{4}|\d{6})?$/);
  return match?{identity:match[1],size:match[2]||null}:null;
}
function matchFiberReference(product,read) {
  const ctx=product.aiContext||{};
  const expected=[product.sku,ctx.supplierRef].map(fiberReferenceIdentity).filter(Boolean);
  if(!expected.length)return {handled:false,reference:null};
  const identities=new Set(expected.map(ref=>ref.identity));
  if(identities.size!==1)return {handled:true,reference:null};
  const size=normalizeReference(read?.size);
  if(!size)return {handled:true,reference:null};
  const observed=(read.references||[]).map(reference=>({reference,parsed:fiberReferenceIdentity(reference)})).filter(item=>item.parsed);
  // A reference printed with a size must agree with the separate BR field.
  // A second model/colour/version in the frame cannot be silently ignored.
  if(observed.some(item=>!identities.has(item.parsed.identity)||item.parsed.size&&item.parsed.size!==size))return {handled:true,reference:null};
  return {handled:true,reference:observed.find(item=>identities.has(item.parsed.identity))?.reference||null};
}
function asicsReferenceIdentity(value) {
  const match=normalizeReference(value).match(/^(\d{4}[A-Z]\d{3})(\d{3})(?:0?(\d{2}))?$/);
  return match?{identity:match[1]+match[2],size:match[3]||null}:null;
}
function matchIncomingManufacturerReference(product,read,fiscal) {
  const brand=normalizeReference(product.brand),size=String(read.size||'').trim();
  const ctx=product.aiContext||{},catalog=[product.sku,ctx.supplierRef];
  const incoming=fiscal.filter(row=>row.productId===product.id);
  let expected=[],observed=[];
  if(brand==='PUMA'){
    // This supplier import encodes printed colour 01 as 0010 (03 as 0030,
    // 14 as 0140): model, "0", two-digit colour, "0", then BR.
    // Permit only the photographed six-digit model + two-digit colour, with
    // the exact incoming EAN row independently carrying that colour and BR.
    const imported=value=>{const m=normalizeReference(value).match(/^(\d{6})0(\d{2})0(\d{2})?$/);return m&&m[2]!=='00'?{identity:m[1]+m[2],size:m[3]||null}:null;};
    const records=incoming.map(row=>imported(row.supplierCode)).filter(Boolean);
    if(!records.length)return {handled:false,reference:null};
    if(!/^\d{2}$/.test(size)||records.some(ref=>ref.size!==size))return {handled:true,reference:null};
    expected=[...catalog.map(imported).filter(Boolean),...records].map(ref=>ref.identity);
    observed=(read.references||[]).filter(ref=>/^\d{8}$/.test(normalizeReference(ref))).map(reference=>({reference,identity:normalizeReference(reference)}));
  }else if(brand==='CONVERSE'){
    // The exact incoming EAN row names the printed Converse reference in its
    // description ("TENIS CT09830001 CHUCK ... 38"); its last field is BR.
    const records=incoming.map(row=>{
      const text=String(row.description||'').normalize('NFKC').toUpperCase();
      const refs=[...new Set([...text.matchAll(/(?:^|\s)(C[A-Z]\d{8}|[A-Z]\d{9})(?=\s|$)/g)].map(m=>m[1]))];
      const tail=text.match(/\s(\d{2}(?:[.,]5)?)$/);
      return refs.length===1?{identity:refs[0],size:tail?tail[1].replace(',','.'):null}:null;
    }).filter(Boolean);
    if(!records.length)return {handled:false,reference:null};
    if(records.some(ref=>ref.size&&ref.size!==size))return {handled:true,reference:null};
    expected=records.map(ref=>ref.identity);
    observed=(read.references||[]).filter(ref=>/^(?:C[A-Z]\d{8}|[A-Z]\d{9})$/.test(normalizeReference(ref))).map(reference=>({reference,identity:normalizeReference(reference)}));
  }else if(brand==='ASICS'){
    const records=incoming.map(row=>asicsReferenceIdentity(row.supplierCode)).filter(Boolean);
    if(!records.length)return {handled:false,reference:null};
    if(records.some(ref=>ref.size&&ref.size!==size))return {handled:true,reference:null};
    expected=[...catalog.map(asicsReferenceIdentity).filter(Boolean),...records].map(ref=>ref.identity);
    observed=(read.references||[]).map(reference=>({reference,parsed:asicsReferenceIdentity(reference)})).filter(item=>item.parsed);
    if(observed.some(item=>item.parsed.size&&item.parsed.size!==size))return {handled:true,reference:null};
    observed=observed.map(item=>({reference:item.reference,identity:item.parsed.identity}));
  }else if(brand==='OUS'){
    // These exact incoming items carry manufacturer model AND variation in
    // the description; supplierCode is a different distributor identifier.
    // Only the 1-3 digit colour suffix may have padding (05 and 5). Keep all
    // six model digits intact and retain both components in conflict checks.
    const identity=(model,colour)=>model+':'+Number(colour);
    const records=incoming.map(row=>{
      const text=String(row.description||'').normalize('NFKC').toUpperCase();
      const model=text.match(/^(\d{6})\s+TENIS\s+(?:COURO|TEXTIL|SINT)\s+(\d{1,3})\s/);
      const tail=text.match(/\s(\d{2}(?:[.,]5)?)$/);
      return model&&tail?{identity:identity(model[1],model[2]),size:tail[1].replace(',','.')}:null;
    }).filter(Boolean);
    if(!records.length)return {handled:false,reference:null};
    if(records.some(ref=>ref.size!==size))return {handled:true,reference:null};
    expected=records.map(ref=>ref.identity);
    observed=(read.references||[]).map(reference=>{
      const match=normalizeReference(reference).match(/^(\d{6})(\d{1,3})$/);
      return match?{reference,identity:identity(match[1],match[2])}:null;
    }).filter(Boolean);
  }else return {handled:false,reference:null};
  const identities=new Set(expected);
  if(identities.size!==1||observed.some(ref=>!identities.has(ref.identity)))return {handled:true,reference:null};
  return {handled:true,reference:observed.find(ref=>identities.has(ref.identity))?.reference||null};
}
function referencesFrom(read) {
  const values = [read?.sku, ...(Array.isArray(read?.codigos) ? read.codigos : [])];
  return [...new Set(values.map(normalizeReference).filter(x => x.length >= 5 && x.length <= 50))].slice(0, 12);
}
function validGtin(value) {
  const code = String(value || '').trim();
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code) || /^0+$/.test(code)) return false;
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(code[i]) * weight;
  return (10 - sum % 10) % 10 === Number(code.at(-1));
}
function variants(code) {
  return barcodePolicy.variants(code);
}
async function referenceCandidates(db, codes) {
  if (!codes.length) return [];
  // Values are bound, never interpolated into SQL. No substring/name matching.
  const found = await db.$queryRaw`
    WITH codes AS (SELECT jsonb_array_elements_text(${JSON.stringify(codes)}::jsonb) AS code),
    refs AS (
      SELECT p.id, p.sku AS ref FROM "Product" p WHERE (p.active = true OR p."aiContext" ? 'consolidatedInto')
      UNION ALL SELECT p.id, p."aiContext"->>'supplierRef' FROM "Product" p WHERE (p.active = true OR p."aiContext" ? 'consolidatedInto')
      UNION ALL SELECT p.id, r.value FROM "Product" p,
        jsonb_array_elements_text(CASE WHEN jsonb_typeof(p."aiContext"->'scannerReferences') = 'array'
          THEN p."aiContext"->'scannerReferences' ELSE '[]'::jsonb END) r WHERE (p.active = true OR p."aiContext" ? 'consolidatedInto')
      UNION ALL SELECT p.id, s.barcode FROM "ProductSize" s JOIN "Product" p ON p.id = s."productId" WHERE (p.active = true OR p."aiContext" ? 'consolidatedInto')
      UNION ALL SELECT p.id, i."supplierCode" FROM "XmlFiscalItem" i
        JOIN "XmlFiscalDocument" d ON d.id = i."fiscalDocumentId"
        JOIN "Product" p ON p.id = i."productId" WHERE (p.active = true OR p."aiContext" ? 'consolidatedInto') AND d."docType" = 'entrada'
      UNION ALL SELECT p.id, regexp_replace(p.sku, '^[A-Z]{1,3}-', '') FROM "Product" p WHERE upper(p.brand)='SKECHERS'
    ) SELECT DISTINCT refs.id FROM refs JOIN codes ON
      regexp_replace(upper(refs.ref), '[^A-Z0-9]', '', 'g') = codes.code LIMIT 12`;
  if(found.length>=12)return [{id:null},{id:null}]; // bounded search must not hide a conflict
  const resolved=[];for(const row of found){const p=await canonicalProduct(db,await db.product.findUnique({where:{id:row.id},include:{sizes:true}}));if(p)resolved.push({id:p.id});}
  return [...new Map(resolved.map(r=>[r.id,r])).values()];
}

async function referenceCandidatesForRead(db,read,size) {
  const codes=referencesFrom(read),exact=await referenceCandidates(db,codes);
  if(exact.length||!size)return exact;
  const sizeKey=normalizeReference(size);
  const qualified=[...new Set(codes.map(fiberReferenceIdentity).filter(ref=>ref&&(!ref.size||ref.size===sizeKey)).map(ref=>ref.identity+sizeKey))];
  if(!qualified.length)return [];
  // Some Fiber boxes print the complete model/colour but keep BR in its own
  // field. Their incoming invoice stores model/colour/size as one exact SKU.
  // Join only a size already read from this piece, then recheck the active
  // product's full identity. Never infer a size from an imported product name.
  const candidates=await referenceCandidates(db,qualified),out=[];
  if(candidates.some(candidate=>!candidate.id))return candidates;
  for(const candidate of candidates){
    const product=await db.product.findUnique({where:{id:candidate.id},include:{sizes:true}});
    if(normalizeReference(product?.brand)!=='FIBER')continue;
    const matched=matchFiberReference(product,{references:codes,size});
    if(matched.reference)out.push({...candidate,source:'fiber-reference-plus-physical-size'});
  }
  return out;
}

function gtinKey(value) { return validGtin(value) ? String(value).trim().replace(/^0+/, '') : ''; }
function evidenceText(value) { return typeof value === 'string' ? value.trim().normalize('NFKC').replace(/\s+/g, ' ') : ''; }
function literalSize(value) {
 const size=evidenceText(value);
 // A range is allowed only as an explicitly documented literal, never from a
 // supplier-code suffix or an unlabelled number in a product description.
 const footwearRange=size.match(/^(?:PP|P|M|G|GG|XG|XGG) \(Calçados (\d{2} a \d{2})\)$/i);
 if(footwearRange)return footwearRange[1];
 return /^(?:\d{2}(?:[.,]5)?|PP|P|M|G|GG|XG|XGG|U|ÚNICO|\d{2} a \d{2})$/i.test(size)?size.replace(',','.'):'';
}
function textKey(value) { return evidenceText(value).toUpperCase(); }
function singleLiteral(value) { return Array.isArray(value)&&value.length===1?value[0]:typeof value==='string'?value:''; }
function officialLupoUrl(value) {
 try { const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['www.lsport.com.br','lsport.com.br','luposport.vtexcommercestable.com.br'].includes(u.hostname); }
 catch (_) { return false; }
}
function officialLupoCatalogUrl(value) { return officialLupoUrl(value)&&new URL(value).hostname==='luposport.vtexcommercestable.com.br'; }
function datedEvidence(value) { return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value)); }

// This persisted import contract is deliberately narrow. It does not accept
// OCR/client data, an AI status alone, a model-only SKU or a size-code mapping.
// The stored exact official record corroborates every component of the variant;
// when a second official source was saved, it must agree as well.
function documentedFiscalVariant(product,row,barcode) {
 const list=product?.aiContext?.invoicePricing20260925?.variants;
 if(!Array.isArray(list))return null;
 const key=gtinKey(barcode);
 if(!key)return null;
 const records=list.filter(v=>v&&v.status==='confirmed_official'&&[v.ean,v.source?.ean,v.source?.corroboration?.ean].some(e=>gtinKey(e)===key));
 if(!records.length)return null;
 if(normalizeReference(product.brand)!=='LUPO')return {reason:'reference_conflict'};
 const confirmed=[];
 for(const v of records){
  const source=v.source,other=source?.corroboration;
  const fullSKU=normalizeReference(v.supplierCode),size=literalSize(v.size);
  const color=evidenceText(v.color),colorWithCode=evidenceText(v.colorLiteralWithCode);
  // All variants in this Lupo import use the complete 15-digit supplier SKU.
  // Model references alone (five/eight digits) cannot identify a colour/size.
  if(!source||source.type!=='official_exact_ean_and_full_supplier_sku'||!size||!/^\d{15}$/.test(fullSKU)||!color||!colorWithCode
    ||!officialLupoUrl(source.sourceUrl)||!datedEvidence(source.consultedAt)
    ||(!other&&!officialLupoCatalogUrl(source.sourceUrl)))return {reason:'size_required'};
  if([v.ean,source.ean,row.ean].some(e=>gtinKey(e)!==key)
    ||[source.fullSKU,row.supplierCode].some(s=>normalizeReference(s)!==fullSKU))return {reason:'reference_conflict'};
  if(source.modelReference&&(!/^\d{8}$/.test(normalizeReference(source.modelReference))||!fullSKU.startsWith(normalizeReference(source.modelReference))))return {reason:'reference_conflict'};
  if(textKey(literalSize(source.sizeLiteral))!==textKey(size))return {reason:'size_conflict'};
  // Some Lupo sources spell colour with its explicit code ("Coral - 0510").
  // Compare that documented suffix as well; never derive it from the SKU.
  const colorName=value=>textKey(value).replace(/\s+-\s+\d+$/,'');
  if(!evidenceText(source.colorLiteral)||colorName(source.colorLiteral)!==colorName(color)
    ||colorName(colorWithCode)!==colorName(color)
    ||[color,source.colorLiteral].some(c=>/\s+-\s+\d+$/.test(c)&&textKey(c)!==textKey(colorWithCode))
    ||textKey(source.colorLiteralWithCode)!==textKey(colorWithCode))return {reason:'reference_conflict'};
  if(other){
   if(!officialLupoCatalogUrl(other.sourceUrl)||!datedEvidence(other.at))return {reason:'size_required'};
   if(gtinKey(other.ean)!==key||normalizeReference(other.fullSKU)!==fullSKU)return {reason:'reference_conflict'};
   if(textKey(literalSize(singleLiteral(other.sizeLiteral)))!==textKey(size))return {reason:'size_conflict'};
   if(textKey(singleLiteral(other.colorLiteral))!==textKey(colorWithCode))return {reason:'reference_conflict'};
  }
  confirmed.push({size,color,colorLiteralWithCode:colorWithCode,supplierCode:v.supplierCode,sourceUrl:source.sourceUrl,...(other?{corroborationUrl:other.sourceUrl}:{}),consultedAt:source.consultedAt});
 }
 if(new Set(confirmed.map(v=>textKey(v.size)+'|'+textKey(v.colorLiteralWithCode)+'|'+normalizeReference(v.supplierCode))).size!==1)return {reason:'reference_conflict'};
 return confirmed[0];
}

// Exact incoming NF-e GTIN plus its canonical product link and either the
// existing literal-size rule or the persisted, corroborated official variant.
async function fiscalBarcodeTarget(db,barcode){
 const rows=await db.$queryRaw`SELECT i.id, i."productId", i.description, i.ean, i."supplierCode" FROM "XmlFiscalItem" i JOIN "XmlFiscalDocument" d ON d.id=i."fiscalDocumentId" WHERE d."docType"='entrada' AND i.ean IN (SELECT jsonb_array_elements_text(${JSON.stringify(variants(barcode))}::jsonb)) AND i."productId" IS NOT NULL LIMIT 51`;
 if(rows.length>50)return {reason:'reference_conflict'};
 const targets=[];
 for(const row of rows){
  const product=await canonicalProduct(db,await db.product.findUnique({where:{id:row.productId},include:{sizes:true}}));
  if(!product)continue;
  const description=String(row.description||'').trim(),match=description.match(/^(.*)\s+(\d{2}(?:[.,]5)?|PP|P|M|G|GG|XG|XGG)$/i);
  const names=[normalizeReference(product.name),normalizeReference(String(product.name).replace(/\s+\d{2}(?:[.,]5)?$/,''))];
  const literal=match&&names.includes(normalizeReference(match[1]))?match[2].toUpperCase().replace(',','.'):null;
  const documented=documentedFiscalVariant(product,row,barcode);
  if(documented?.reason)return documented;
  const officialTail=evidenceText(row.description).match(/(?:^|\s)(\d{2} a \d{2}|\d{2}(?:[.,]5)?|PP|P|M|G|GG|XG|XGG|U|ÚNICO)$/i);
  if(officialTail&&documented&&textKey(officialTail[1].replace(',','.'))!==textKey(documented.size))return {reason:'size_conflict'};
  // Importers may rename a catalog product. For official evidence, the exact
  // fiscal EAN/full SKU and explicit canonical product link establish identity.
  if(!literal&&!documented)return {reason:'size_required'};
  const size=literal||documented.size;
  // A missing literal fiscal size is created below with zero purchased stock.
  targets.push({productId:product.id,size,itemId:row.id,...(documented?{officialEvidence:documented}:{})});
 }
 const unique=[...new Map(targets.map(t=>[t.productId+':'+t.size,t])).values()];
 return unique.length>1?{reason:'barcode_conflict'}:unique[0]||null;
}

// Learns a barcode only after one exact target is established. The optional
// confirmedProductId is used exclusively by the authenticated review endpoint.
async function learnScannerBarcode(db, { barcode, read, size, confirmedProductId, archivedLabel }) {
  barcode = String(barcode || '').trim();
  if (!validGtin(barcode)) return { reason: 'invalid_barcode' };
  const codes = referencesFrom(read);
  const requestedSize=size;
  // Concurrent first scans may wait on the same advisory lock with an older
  // Serializable snapshot. Retry only a rolled-back serialization conflict.
  for(let attempt=0;;attempt++)try { return await db.$transaction(async tx => {
    let size=requestedSize;
    // Serialize competing scans of the same UPC/GTIN (including leading zero).
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${barcodePolicy.identity(barcode)}))::text AS locked`;
    const rawOwners = await tx.productSize.findMany({ where: { barcode: { in: variants(barcode) } }, include: { product: true } });
    const owners=await resolveBarcodeRows(tx,rawOwners);
    if(!owners.length)owners.push(...await aliasRows(tx,barcode));
    if(archivedLabel){const aliases=await aliasRows(tx,barcode);if(aliases.some(a=>owners.some(o=>o.id!==a.id)))return {reason:'barcode_conflict'};}
    if (owners.length > 1) return { reason: 'barcode_conflict' };
    const candidates = await referenceCandidatesForRead(tx, read, size);
    if (!confirmedProductId && candidates.length > 1) return { reason: 'reference_conflict' };
    const photoTarget = archivedLabel ? await require('./scannerArchivedLabel').target(tx, barcode, archivedLabel) : null;
    if (archivedLabel && !photoTarget?.productId) return { reason: photoTarget?.reason || 'photo_evidence_conflict' };
    const fiscal = photoTarget || (!owners.length || !owners[0].sizeConfirmedAt ? await fiscalBarcodeTarget(tx,barcode) : null);
    if(fiscal?.reason && !owners.length && !confirmedProductId)return {reason:fiscal.reason};
    if(fiscal?.productId && candidates.some(c=>c.id!==fiscal.productId))return {reason:'reference_conflict'};
    if(fiscal?.size && size && size!==fiscal.size)return {reason:'size_conflict'};
    if(!size && fiscal?.size)size=fiscal.size;
    const pid = confirmedProductId || candidates[0]?.id || owners[0]?.productId || fiscal?.productId;
    if (!pid) return { reason: 'reference_not_found' };
    if((fiscal?.officialEvidence||fiscal?.photoEvidence)&&fiscal.productId!==pid)return {reason:'reference_conflict'};
    if (owners.length && owners[0].productId !== pid) return { reason: 'barcode_conflict' };
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${pid} FOR UPDATE`;
    const product = await tx.product.findUnique({ where: { id: pid }, include: { sizes: true } });
    if (!product?.active) return { reason: 'inactive_product' };
    const brand = normalizeReference(read?.marca);
    if (brand && normalizeReference(product.brand) !== brand) return { reason: 'brand_conflict' };
    // Explicit manual confirmation may bridge a supplier code to a new printed
    // reference, but must not steal an identifier belonging to another card.
    if (confirmedProductId && candidates.some(p => p.id !== pid)) return { reason: 'reference_conflict' };
    const internalOwner = await tx.product.findFirst({ where: { internalBarcode: { in: variants(barcode) } }, select: { id: true } });
    if (internalOwner && internalOwner.id !== pid) return { reason: 'barcode_conflict' };
    let ps = owners[0];
    if(ps && fiscal?.itemId && fiscal.productId===ps.productId && fiscal.size===ps.size && !ps.sizeConfirmedAt)ps=await tx.productSize.update({where:{id:ps.id},data:{sizeConfirmedAt:new Date()}});
    let previousReference = null;
    if (ps && size && ps.size !== size && !/^T-|^\?$/.test(ps.size)) return { reason: 'size_conflict' };
    if (!ps) {
      if (!size) return { reason: 'size_required' };
      ps = product.sizes.find(s => s.size === size);
      if (ps?.barcode && validGtin(ps.barcode) && !variants(barcode).includes(ps.barcode)) {
        // A different existing Fiber GTIN may be assigned to the wrong size
        // (observed 40/41 conflict). Do not hide that conflict as a new alias.
        if(!confirmedProductId&&normalizeReference(product.brand)==='FIBER')return {reason:'size_barcode_conflict'};
        // An occupied size is reusable only when both GTINs independently have
        // exact incoming invoices and official evidence for this same colour.
        if(fiscal?.officialEvidence){
          const prior=await fiscalBarcodeTarget(tx,ps.barcode);
          if(!prior?.officialEvidence||prior.productId!==pid||textKey(prior.size)!==textKey(size)
            ||textKey(prior.officialEvidence.colorLiteralWithCode)!==textKey(fiscal.officialEvidence.colorLiteralWithCode))return {reason:'size_barcode_conflict'};
          const ctx=product.aiContext||{};
          await tx.product.update({where:{id:pid},data:{aiContext:{...ctx,scannerBarcodeAliases:{...(ctx.scannerBarcodeAliases||{}),[barcodePolicy.identity(barcode)]:{
            size,reference:fiscal.officialEvidence.supplierCode,source:'exact-incoming-nfe-and-confirmed-official-variant',fiscalItemId:fiscal.itemId,
            matchingBarcode:ps.barcode,matchingFiscalItemId:prior.itemId,officialVariant:fiscal.officialEvidence,matchingOfficialVariant:prior.officialEvidence,at:new Date().toISOString()
          }}}}});
          return {productId:pid,productSizeId:ps.id,name:product.name,barcode,reason:'matched'};
        }
        if(candidates.length!==1 && !confirmedProductId)return {reason:'size_barcode_conflict'};
        // A printed reference and exact size can have another GTIN after catalogue
        // consolidation. Keep the existing GTIN and record a separate alias.
        const ctx=product.aiContext||{};
        await tx.product.update({where:{id:pid},data:{aiContext:{...ctx,scannerBarcodeAliases:{...(ctx.scannerBarcodeAliases||{}),[barcodePolicy.identity(barcode)]:{size,reference:codes[0],source:'exact-reference-and-size',at:new Date().toISOString()}}}}});
        return {productId:pid,productSizeId:ps.id,name:product.name,barcode,reason:'matched'};
      }
      if (ps) {
        // Preserve the prior supplier identifier for future reference searches.
        const previous = normalizeReference(ps.barcode);
        if (previous && !validGtin(ps.barcode)) previousReference = previous;
        ps = await tx.productSize.update({ where: { id: ps.id }, data: { barcode, ...((confirmedProductId || fiscal?.itemId) ? { sizeConfirmedAt: new Date() } : {}) } });
      } else {
        ps = await tx.productSize.create({ data: { productId: pid, size, barcode, stock: 0,
          ...((confirmedProductId || fiscal?.itemId) ? { sizeConfirmedAt: new Date() } : {}) } });
      }
    }
    const context = product.aiContext && typeof product.aiContext === 'object' && !Array.isArray(product.aiContext) ? product.aiContext : {};
    // Automatic scans only retain identifiers actually present in the database;
    // an operator can explicitly confirm a new printed reference.
    const existing = Array.isArray(context.scannerReferences) ? context.scannerReferences : [];
    if (confirmedProductId || previousReference || fiscal?.itemId) await tx.product.update({ where: { id: pid }, data: { aiContext: { ...context,
      scannerReferences: [...new Set([...existing, ...(confirmedProductId ? codes : []), ...(previousReference ? [previousReference] : [])])],
      scannerReferenceEvidence: { source: fiscal?.photoEvidence ? 'archived-photo-and-exact-incoming-nfe' : fiscal?.officialEvidence ? 'exact-incoming-nfe-and-confirmed-official-variant' : fiscal?.itemId ? 'exact-incoming-nfe-gtin-product-and-size' : confirmedProductId ? 'operator-confirmed-label' : 'existing-variant-reference', fiscalItemId:fiscal?.itemId||null, barcode, size, ...(fiscal?.photoEvidence?{photoEvidence:fiscal.photoEvidence}:{}), ...(fiscal?.officialEvidence?{officialVariant:fiscal.officialEvidence}:{}), confirmedAt: new Date().toISOString() },
    } } });
    return { productId: pid, productSizeId: ps.id, name: product.name, barcode, reason: 'matched' };
  }, { isolationLevel: 'Serializable', timeout: 15000 });
  } catch(error) {
    const rolledBack=error.code==='P2034'||(error.code==='P2010'&&['40001','40P01'].includes(error.meta?.code));
    if(!rolledBack||attempt>=3)throw error;
  }
}

async function matchScannerReference(db,read,size){
  const refs=await referenceCandidates(db,referencesFrom(read));
  if(refs.length!==1)return {reason:refs.length?'reference_conflict':'reference_not_found'};
  if(!size)return {reason:'size_required'};
  const p=await db.product.findUnique({where:{id:refs[0].id},include:{sizes:true}});
  if(!p?.active)return {reason:'inactive_product'};
  if(read?.marca&&normalizeReference(read.marca)!==normalizeReference(p.brand))return {reason:'brand_conflict'};
  const ps=p.sizes.find(s=>s.size===size);
  if(!ps)return {reason:'size_required'};
  return {reason:'matched',productId:p.id,productSizeId:ps.id,name:p.name};
}
module.exports = { documentedFiscalVariant, fiscalBarcodeTarget, matchScannerReference, normalizeReference, fiberReferenceIdentity, matchFiberReference, asicsReferenceIdentity, matchIncomingManufacturerReference, referencesFrom, validGtin, referenceCandidates, referenceCandidatesForRead, learnScannerBarcode };
