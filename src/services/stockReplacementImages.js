'use strict';
const {createHash}=require('node:crypto');
const CONFIG_KEY='stock_replacement_catalog_vision';
function description(product){let context=product.aiContext||{};if(typeof context==='string'){try{context=JSON.parse(context)}catch(_){context={}}}return {productId:product.id,name:product.name,brand:product.brand,sku:product.sku,color:context.color||'',category:product.category,imageUrl:product.imageUrl||null};}
function fingerprint(product){return createHash('sha256').update(JSON.stringify(description(product))).digest('hex');}
function accepted(result){return result?.ok===true&&result.isCorrectProduct===true&&result.colorMatches===true&&Number.isFinite(result.score)&&result.score>=9;}
function matches(review,product){return !!product.imageUrl&&review?.status==='verified'&&review.source==='catalog-vision'&&review.isCorrectProduct===true&&review.colorMatches===true&&review.score>=9&&review.fingerprint===fingerprint(product);}
async function review(db,product,provider){const snapshot=description(product),key=fingerprint(product),base={...snapshot,fingerprint:key,checkedAt:new Date().toISOString()};
 if(!snapshot.imageUrl)return {...base,status:'pending',reason:'Produto sem imagem de catálogo.'};
 const previous=await db.stockReplacementCheck.findFirst({where:{AND:[{imageReview:{path:['fingerprint'],equals:key}},{imageReview:{path:['status'],equals:'verified'}}]},orderBy:{checkedAt:'desc'}});
 if(matches(previous?.imageReview,product))return {...previous.imageReview,reusedFromBipe:previous.bipeId};
 let config;try{config=JSON.parse((await db.config.findUnique({where:{key:CONFIG_KEY}}))?.value||'null')}catch(_){config=null}
 if(config?.enabled!==true)return {...base,status:'pending',reason:'Conferência visual automática aguarda autorização para o serviço de catálogo. A leitura da etiqueta permanece local.'};
 const validator=provider||require('./visionValidator');if(!validator.isConfigured())return {...base,status:'pending',reason:'Serviço de conferência visual indisponível.'};
 const imageUrl=snapshot.imageUrl.startsWith('/')?new URL(snapshot.imageUrl,'https://teniscash.com.br').href:snapshot.imageUrl;
 if(!/^https:\/\//i.test(imageUrl))return {...base,status:'pending',reason:'Endereço da imagem precisa de conferência.'};
 let result;try{result=await validator.scoreImageMatch(imageUrl,{...snapshot,name:snapshot.name+' · Referência '+snapshot.sku});}catch(_){return {...base,status:'pending',reason:'Falha temporária na conferência visual.'}}
 return {...base,status:accepted(result)?'verified':'pending',source:'catalog-vision',provider:result.provider||null,score:result.score||0,isCorrectProduct:result.isCorrectProduct===true,colorMatches:result.colorMatches===true,reason:result.ok?String(result.reason||'Correspondência visual insuficiente.').slice(0,500):'Serviço visual não conseguiu conferir esta imagem.',cost:result.cost||null};
}
const jobs=new Set();let working=false;
function enqueue(db,bipeId){jobs.add(bipeId);if(working)return;working=true;setImmediate(async()=>{try{while(jobs.size){const id=jobs.values().next().value;jobs.delete(id);try{
 const check=await db.stockReplacementCheck.findUnique({where:{bipeId:id}});if(!check?.appliedAt||check.reversedAt)continue;
 const size=await db.productSize.findUnique({where:{id:check.appliedProductSizeId},include:{product:true}});if(!size)continue;if(matches(check.imageReview,size.product)){await db.stockReplacementCheck.update({where:{bipeId:id},data:{checkedAt:new Date()}});continue;}
 const imageReview=await review(db,size.product);
 const fresh=await db.product.findUnique({where:{id:size.productId}});if(fresh&&fingerprint(fresh)===imageReview.fingerprint)await db.stockReplacementCheck.updateMany({where:{bipeId:id,reversedAt:null},data:{imageReview,checkedAt:new Date()}});
 }catch(e){console.warn('[replacement/image]',e.message)}}}finally{working=false}});}
module.exports={CONFIG_KEY,description,fingerprint,accepted,matches,review,enqueue};
