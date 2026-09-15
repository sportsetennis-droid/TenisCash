'use strict';
// Follow only an explicit consolidation link; never infer a product from its name.
async function canonicalProduct(db, product) {
  let p=product;const seen=new Set();
  for(let depth=0;p&&depth<6;depth++){
    if(seen.has(p.id))return null;seen.add(p.id);
    if(p.active)return p;
    if(!p.aiContext)p=await db.product.findUnique({where:{id:p.id},include:{sizes:true}});
    const next=p?.aiContext?.consolidatedInto;if(!next)return null;
    p=await db.product.findUnique({where:{id:next},include:{sizes:true}});
  }
  return null;
}
async function resolveBarcodeRows(db, rows) {
  const resolved=[];
  for(const row of rows){
    if(row.product?.active){
      if((!row.size||row.size==='?'||/^T-/.test(row.size))&&row.barcode){const aliases=await aliasRows(db,row.barcode);if(aliases.length===1&&aliases[0].productId===row.productId){resolved.push(aliases[0]);continue;}}
      resolved.push(row);continue;
    }
    const target=await canonicalProduct(db,row.product);
    // A reviewed alias preserves the exact GTIN identity when a legacy row
    // still carries a placeholder size after consolidation.
    const aliasSize=target?.aiContext?.scannerBarcodeAliases?.[String(row.barcode||'').replace(/^0+/,'')]?.size;
    const size=target?.sizes?.find(s=>s.size===(aliasSize||row.size));
    if(target&&size)resolved.push({...size,productId:target.id,product:target,sourceProductId:row.productId});
    else resolved.push(row); // inactive, unknown, missing size or cyclic: stays blocked
  }
  return [...new Map(resolved.map(r=>[r.id,r])).values()];
}
async function aliasRows(db,barcode){
  const key=String(barcode).replace(/^0+/,'');
  const rows=await db.$queryRaw`SELECT id FROM "Product" WHERE active=true AND ("aiContext"->'scannerBarcodeAliases') ? ${key}`;
  const out=[];for(const row of rows){const p=await db.product.findUnique({where:{id:row.id},include:{sizes:true}});const size=p?.aiContext?.scannerBarcodeAliases?.[key]?.size;const ps=p?.sizes?.find(s=>s.size===size);if(ps)out.push({...ps,product:p,productId:p.id});}
  return out;
}
module.exports={canonicalProduct,resolveBarcodeRows,aliasRows};
