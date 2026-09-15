'use strict';
const {canonicalProduct,resolveBarcodeRows,aliasRows}=require('./scannerCatalog');

// Exact identifiers only. Punctuation is insignificant; colour suffixes are not.
function normalizeReference(value) {
  return String(value || '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
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
  return [...new Set([code, code.replace(/^0+/, ''), code.padStart(13, '0'), code.padStart(14, '0')])];
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

// Exact incoming NF-e GTIN plus its existing product link and literal variant.
async function fiscalBarcodeTarget(db,barcode){
 const rows=await db.$queryRaw`SELECT i.id, i."productId", i.description FROM "XmlFiscalItem" i JOIN "XmlFiscalDocument" d ON d.id=i."fiscalDocumentId" WHERE d."docType"='entrada' AND i.ean IN (SELECT jsonb_array_elements_text(${JSON.stringify(variants(barcode))}::jsonb)) AND i."productId" IS NOT NULL LIMIT 51`;
 if(rows.length>50)return {reason:'reference_conflict'};
 const targets=[];
 for(const row of rows){
  const product=await canonicalProduct(db,await db.product.findUnique({where:{id:row.productId},include:{sizes:true}}));
  if(!product)continue;
  const match=String(row.description||'').trim().match(/^(.*)\s+(\d{2}(?:[.,]5)?|PP|P|M|G|GG|XG|XGG)$/i);
  if(!match || normalizeReference(match[1])!==normalizeReference(String(product.name).replace(/\s+\d{2}(?:[.,]5)?$/,'')) && normalizeReference(match[1])!==normalizeReference(product.name))return {reason:'size_required'};
  const size=match[2].toUpperCase().replace(',','.');
  // A missing literal fiscal size is created below with zero purchased stock.
  targets.push({productId:product.id,size,itemId:row.id});
 }
 const unique=[...new Map(targets.map(t=>[t.productId+':'+t.size,t])).values()];
 return unique.length>1?{reason:'barcode_conflict'}:unique[0]||null;
}

// Learns a barcode only after one exact target is established. The optional
// confirmedProductId is used exclusively by the authenticated review endpoint.
async function learnScannerBarcode(db, { barcode, read, size, confirmedProductId }) {
  barcode = String(barcode || '').trim();
  if (!validGtin(barcode)) return { reason: 'invalid_barcode' };
  const codes = referencesFrom(read);
  return db.$transaction(async tx => {
    // Serialize competing scans of the same UPC/GTIN (including leading zero).
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${barcode.replace(/^0+/, '')}))::text AS locked`;
    const rawOwners = await tx.productSize.findMany({ where: { barcode: { in: variants(barcode) } }, include: { product: true } });
    const owners=await resolveBarcodeRows(tx,rawOwners);
    if(!owners.length)owners.push(...await aliasRows(tx,barcode));
    if (owners.length > 1) return { reason: 'barcode_conflict' };
    const candidates = await referenceCandidates(tx, codes);
    if (!confirmedProductId && candidates.length > 1) return { reason: 'reference_conflict' };
    const fiscal = !owners.length || !owners[0].sizeConfirmedAt ? await fiscalBarcodeTarget(tx,barcode) : null;
    if(fiscal?.reason && !owners.length && !confirmedProductId)return {reason:fiscal.reason};
    if(fiscal?.productId && candidates.some(c=>c.id!==fiscal.productId))return {reason:'reference_conflict'};
    if(fiscal?.size && size && size!==fiscal.size)return {reason:'size_conflict'};
    if(!size && fiscal?.size)size=fiscal.size;
    const pid = confirmedProductId || candidates[0]?.id || owners[0]?.productId || fiscal?.productId;
    if (!pid) return { reason: 'reference_not_found' };
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
        if(candidates.length!==1 && !confirmedProductId)return {reason:'size_barcode_conflict'};
        // A printed reference and exact size can have another GTIN after catalogue
        // consolidation. Keep the existing GTIN and record a separate alias.
        const ctx=product.aiContext||{};
        await tx.product.update({where:{id:pid},data:{aiContext:{...ctx,scannerBarcodeAliases:{...(ctx.scannerBarcodeAliases||{}),[barcode.replace(/^0+/,'')]:{size,reference:codes[0],source:'exact-reference-and-size',at:new Date().toISOString()}}}}});
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
      scannerReferenceEvidence: { source: fiscal?.itemId ? 'exact-incoming-nfe-gtin-product-and-size' : confirmedProductId ? 'operator-confirmed-label' : 'existing-variant-reference', fiscalItemId:fiscal?.itemId||null, barcode, size, confirmedAt: new Date().toISOString() },
    } } });
    return { productId: pid, productSizeId: ps.id, name: product.name, barcode, reason: 'matched' };
  }, { isolationLevel: 'Serializable', timeout: 15000 });
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
module.exports = { fiscalBarcodeTarget, matchScannerReference, normalizeReference, referencesFrom, validGtin, referenceCandidates, learnScannerBarcode };
