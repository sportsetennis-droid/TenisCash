'use strict';
const {createHash}=require('node:crypto');
function description(product){let context=product.aiContext||{};if(typeof context==='string'){try{context=JSON.parse(context)}catch(_){context={}}}return {productId:product.id,name:product.name,brand:product.brand,sku:product.sku,color:context.color||'',category:product.category,imageUrl:product.imageUrl||null};}
function fingerprint(product){return createHash('sha256').update(JSON.stringify(description(product))).digest('hex');}
function matches(review,product){return !!product.imageUrl&&review?.status==='verified'&&review.source==='operator-visual-review'&&!!review.reviewedById&&review.fingerprint===fingerprint(product);}
async function review(db,product){const snapshot=description(product),key=fingerprint(product),base={...snapshot,fingerprint:key,checkedAt:new Date().toISOString()};
 if(!snapshot.imageUrl)return {...base,status:'pending',reason:'Produto sem imagem de catálogo.'};
 const previous=await db.stockReplacementCheck.findFirst({where:{AND:[{imageReview:{path:['fingerprint'],equals:key}},{imageReview:{path:['status'],equals:'verified'}}]},orderBy:{checkedAt:'desc'}});
 if(matches(previous?.imageReview,product))return {...previous.imageReview,reusedFromBipe:previous.bipeId};
 const others=await db.product.findMany({where:{active:true,imageUrl:product.imageUrl,NOT:{id:product.id}},select:{id:true,name:true,sku:true},take:10});
 return {...base,status:'pending',source:'local-catalog-check',sameImageProducts:others,reason:others.length?'A mesma imagem aparece em outro cadastro. Confira modelo e cor.':'Imagem cadastrada; falta conferência visual do modelo e da cor. Nenhuma API paga é usada.'};
}
async function confirm(db,roundId,bipeId,input,actorId){return db.$transaction(async tx=>{
 await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${roundId} FOR SHARE`;
 const round=await tx.stocktakeRound.findUnique({where:{id:roundId}}),check=await tx.stockReplacementCheck.findUnique({where:{bipeId}});
 const fail=message=>{const e=Error(message);e.status=409;throw e;};
 if(round?.operationType!=='replacement'||!['counting','review'].includes(round.status)||check?.roundId!==roundId||!check.appliedAt||check.reversedAt)fail('Esta leitura não está disponível para conferência.');
 const size=await tx.productSize.findUnique({where:{id:check.appliedProductSizeId},include:{product:true}});
 if(!size?.product.imageUrl||input.verified!==true||input.fingerprint!==fingerprint(size.product))fail('A imagem ou o cadastro mudou. Abra e confira novamente.');
 const imageReview={...description(size.product),fingerprint:fingerprint(size.product),status:'verified',source:'operator-visual-review',reviewedById:actorId,reviewedAt:new Date().toISOString(),reason:'Modelo e cor conferidos pelo operador identificado.'};
 await tx.stockReplacementCheck.update({where:{bipeId},data:{imageReview,checkedAt:new Date()}});return imageReview;
});}
const jobs=new Set();let working=false;
function enqueue(db,bipeId){jobs.add(bipeId);if(working)return;working=true;setImmediate(async()=>{try{while(jobs.size){const id=jobs.values().next().value;jobs.delete(id);try{
 const check=await db.stockReplacementCheck.findUnique({where:{bipeId:id}});if(!check?.appliedAt||check.reversedAt)continue;
 const size=await db.productSize.findUnique({where:{id:check.appliedProductSizeId},include:{product:true}});if(!size)continue;if(matches(check.imageReview,size.product)){await db.stockReplacementCheck.update({where:{bipeId:id},data:{checkedAt:new Date()}});continue;}
 const imageReview=await review(db,size.product);
 const fresh=await db.product.findUnique({where:{id:size.productId}});if(fresh&&fingerprint(fresh)===imageReview.fingerprint)await db.stockReplacementCheck.updateMany({where:{bipeId:id,reversedAt:null},data:{imageReview,checkedAt:new Date()}});
 }catch(e){console.warn('[replacement/image]',e.message)}}}finally{working=false}});}
module.exports={description,fingerprint,matches,review,enqueue,confirm};
