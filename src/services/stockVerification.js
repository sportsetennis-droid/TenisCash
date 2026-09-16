'use strict';
// Read model only: never adds the old official balance to the new count.
function summarizeVariant(bipes, captures, size, movements) {
 const captureByBipe = new Map(captures.filter(c=>c.bipeId).map(c=>[c.bipeId,c]));
 let counted=0,pending=0; const evidence=[];
 for(const b of bipes){
  const c=captureByBipe.get(b.id);
  const valid=b.found&&!b.duplicate&&/^\d{8}$|^\d{12,14}$/.test(b.barcode||'')&&size&&size.productId===b.productId&&size.product.active&&size.size&&!/^(?:\?|T-|REF:)/i.test(size.size)&&(!c||c.status==='vinculado')&&(!/adidas|nike/i.test(size.product.brand||'')||Boolean(size.sizeConfirmedAt))&&(!/adidas/i.test(size.product.brand||'')||+new Date(size.sizeConfirmedAt)>=+new Date(b.bipedAt));
  if(valid) counted++; else pending++;
  evidence.push({barcode:b.barcode,seller:b.sellerName,at:b.bipedAt,valid});
 }
 const first=bipes.reduce((v,b)=>Math.min(v,+new Date(b.bipedAt)),Infinity);
 const last=bipes.reduce((v,b)=>Math.max(v,+new Date(b.bipedAt)),0);
 let delta=0,uncertain=false;
 for(const m of movements){
  if(+new Date(m.createdAt)<=first)continue;
  // Sales/transfers out reduce the verified subset conservatively. Receipts,
  // returns, recounts and interleaved scans require reconciliation, not green.
  if(m.quantity<0 && /^(sale|exchange_sale|transfer_out)$/.test(m.type)) delta+=m.quantity;
  else uncertain=true;
  if(+new Date(m.createdAt)<=last)uncertain=true;
 }
 if(counted+delta<0)uncertain=true;
 return {counted,available:Math.max(0,counted+delta),movementDelta:delta,pending,status:pending||uncertain?'pending':counted?'verified':'unverified',reconcile:uncertain,evidence};
}
async function loadVerification(db,storeId){
 const rounds=await db.stocktakeRound.findMany({where:{status:{in:['counting','review']},...(storeId?{storeId}:{})},select:{id:true,storeId:true,number:true,startedAt:true}});
 if(!rounds.length)return {rows:[],rounds:[],orphanPending:0};
 const ids=rounds.map(r=>r.id), stores=rounds.map(r=>r.storeId);
 const [bipes,captures,moves,storeRows]=await Promise.all([
 db.stocktakeBipe.findMany({where:{roundId:{in:ids},excludedAt:null}}),
 db.productCapture.findMany({where:{roundId:{in:ids},excludedAt:null,status:{not:'descartado'}},select:{id:true,bipeId:true,status:true,storeId:true,roundId:true}}),
 db.storeStockMovement.findMany({where:{storeId:{in:stores},createdAt:{gte:new Date(Math.min(...rounds.map(r=>+r.startedAt)))}},select:{storeId:true,productSizeId:true,quantity:true,type:true,createdAt:true}}),
 db.store.findMany({where:{id:{in:stores}},select:{id:true,code:true}})]);
 const sizes=await db.productSize.findMany({where:{id:{in:[...new Set(bipes.map(b=>b.productSizeId).filter(Boolean))]}},select:{id:true,size:true,productId:true,sizeConfirmedAt:true,product:{select:{active:true,brand:true}}}});
 const sizeMap=new Map(sizes.map(s=>[s.id,s])), groups=new Map();
 for(const b of bipes){if(!b.productSizeId)continue;const key=b.roundId+':'+b.productSizeId;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(b);}
 const rows=[];
 for(const group of groups.values()){
 const b=group[0],size=sizeMap.get(b.productSizeId),round=rounds.find(r=>r.id===b.roundId);
 rows.push({storeId:b.storeId,storeCode:storeRows.find(s=>s.id===b.storeId)?.code,roundId:round.id,roundNumber:round.number,productId:b.productId,productSizeId:b.productSizeId,size:size?.size||b.productSize,...summarizeVariant(group,captures,size,moves.filter(m=>m.storeId===b.storeId&&m.productSizeId===b.productSizeId))});
 }
 return {rows,rounds,orphanPending:captures.filter(c=>!c.bipeId).length,unidentifiedPending:bipes.filter(b=>!b.productSizeId).length};
}
function attachVerification(products,snapshot){for(const p of products){p.verification=snapshot.rows.filter(r=>r.productId===p.id);for(const s of p.sizes||[])s.verification=p.verification.filter(r=>r.productSizeId===s.id);}return products;}
function matchesVerification(p,status){const rows=p.verification||[];return !status||status==='all'||(status==='unverified'?(!rows.length||(p.sizes||[]).some(s=>!rows.some(r=>r.productSizeId===s.id))):rows.some(r=>r.status===status));}
module.exports={loadVerification,attachVerification,matchesVerification,summarizeVariant};
