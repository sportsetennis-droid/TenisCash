'use strict';
const assert=require('node:assert/strict');
const express=require('express');
const jwt=require('jsonwebtoken');

const databaseUrl=process.env.ROUND_TEST_DATABASE_URL;
if(!databaseUrl||!databaseUrl.startsWith('postgresql://roundtest@127.0.0.1:55329/'))
  throw Error('Use somente o PostgreSQL isolado de teste na porta 55329.');
process.env.DATABASE_URL=databaseUrl;

const middleware=require('../src/middleware');
const prisma=middleware.prisma;
const nativeSetInterval=global.setInterval,nativeSetTimeout=global.setTimeout;
global.setInterval=()=>({unref(){}});global.setTimeout=()=>({unref(){}});
const router=require('../src/routes/stocktake');
global.setInterval=nativeSetInterval;global.setTimeout=nativeSetTimeout;
const app=express();
app.use(express.json());
app.use('/api/stocktake',router);

function auth(role='admin'){
  const userId=role==='seller'?'isolated-http-test-seller':'isolated-http-test';
  return 'Bearer '+jwt.sign({userId,role},middleware.JWT_SECRET,{expiresIn:'5m'});
}
async function call(base,path,{role='admin',body,token=true}={}){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:auth(role)}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const raw=await response.text();
  let payload;
  try{payload=JSON.parse(raw);}catch{throw Error(`Resposta HTTP ${response.status} não é JSON: ${raw.slice(0,300)}`);}
  return {status:response.status,payload};
}

(async()=>{
  const suffix=Date.now().toString(36);
  await prisma.store.updateMany({where:{code:{startsWith:'UNKNOWN-'}},data:{active:false}});
  await prisma.user.upsert({where:{id:'isolated-http-test'},create:{id:'isolated-http-test',name:'Admin HTTP isolado',phone:'test-stock-reconstruction-admin',pin:'test-only',role:'admin'},update:{active:true,role:'admin'}});
  await prisma.user.upsert({where:{id:'isolated-http-test-seller'},create:{id:'isolated-http-test-seller',name:'Vendedor HTTP isolado',phone:'test-stock-reconstruction-seller',pin:'test-only',role:'seller'},update:{active:true,role:'seller'}});
  const store=await prisma.store.upsert({where:{code:'LOJA02'},create:{name:'Loja HTTP isolada',code:'LOJA02'},update:{name:'Loja HTTP isolada '+suffix,active:true}});
  await prisma.store.upsert({where:{code:'LOJA03'},create:{name:'Outra loja HTTP isolada',code:'LOJA03'},update:{name:'Outra loja HTTP isolada '+suffix,active:true}});
  const separateCompany=await prisma.store.upsert({where:{code:'LOJA01'},create:{name:'Baratão separado HTTP',code:'LOJA01'},update:{name:'Baratão separado HTTP '+suffix,active:true}});
  const unknownStore=await prisma.store.upsert({where:{code:'UNKNOWN-'+suffix},create:{name:'Loja HTTP sem grupo',code:'UNKNOWN-'+suffix},update:{name:'Loja HTTP sem grupo '+suffix,active:true}});
  const product=await prisma.product.create({data:{sku:'HTTP-'+suffix,name:'Produto HTTP teste',brand:'PUMA',category:'calcado',price:100}});
  const size=await prisma.productSize.create({data:{productId:product.id,size:'40',barcode:'789'+suffix.slice(-10),stock:7}});
  await prisma.storeStock.create({data:{storeId:store.id,productSizeId:size.id,stock:7}});
  await prisma.storeStock.create({data:{storeId:separateCompany.id,productSizeId:size.id,stock:11}});

  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/stocktake/reconstructions`;
  try{
    assert.equal((await call(base,'/',{token:false})).status,401,'reconstruction endpoints require a token');
    assert.equal((await call(base,'/',{role:'seller'})).status,403,'reconstruction endpoints require an admin role');
    const unknown=await call(base,'/',{body:{name:'Não deve misturar loja desconhecida'}});
    assert.equal(unknown.status,409);
    assert.ok(unknown.payload.details.unknownStores.some(item=>item.id===unknownStore.id),'unknown active business stores stop batch creation');
    await prisma.store.update({where:{id:unknownStore.id},data:{active:false}});
    assert.equal((await prisma.store.findUnique({where:{id:unknownStore.id}})).active,false,'the unknown fixture must be deactivated before starting the batch');
    const created=await call(base,'/',{body:{name:'Reconstrução HTTP isolada'}});
    assert.equal(created.status,201,JSON.stringify(created.payload));
    const batch=created.payload.batch;
    assert.ok(batch?.id);
    assert.equal((await prisma.stocktakeReconstruction.findUnique({where:{id:batch.id}})).createdById,'isolated-http-test','the authenticated admin is recorded as the batch creator');
    assert.equal(created.payload.rounds.length,created.payload.stores.length,'one fresh round is created for each active store');
    assert.ok(created.payload.rounds.some(round=>round.storeId===store.id));
    assert.ok(!created.payload.rounds.some(round=>round.storeId===separateCompany.id),'LOJA01 remains outside the Sports & Tennis batch');
    assert.ok(created.payload.excludedStores.some(item=>item.code==='LOJA01'));

    const active=await call(base,'/active');
    assert.equal(active.status,200);
    assert.equal(active.payload.reconstruction.batch.id,batch.id);
    assert.ok(active.payload.reconstruction.reports.every(report=>report.totals.total===0),'new rounds do not import older scans');

    const cancelled=await call(base,`/${encodeURIComponent(batch.id)}/cancel`,{body:{}});
    assert.equal(cancelled.status,200,JSON.stringify(cancelled.payload));
    const archived=await call(base,`/${encodeURIComponent(batch.id)}`);
    assert.equal(archived.payload.batch.status,'cancelled');
    assert.ok(archived.payload.reports.every(report=>report.round.status==='cancelled'));
    assert.equal((await prisma.storeStock.findUnique({where:{storeId_productSizeId:{storeId:store.id,productSizeId:size.id}}})).stock,7,'opening and archiving the batch leave official stock unchanged');
    assert.equal((await prisma.storeStock.findUnique({where:{storeId_productSizeId:{storeId:separateCompany.id,productSizeId:size.id}}})).stock,11,'opening and archiving leave the separate company balance untouched');

    const second=await call(base,'/',{body:{name:'Reconstrução aplicada só no teste isolado'}});
    assert.equal(second.status,201,JSON.stringify(second.payload));
    const secondBatch=second.payload.batch;
    await prisma.stocktakeRound.updateMany({where:{reconstructionId:secondBatch.id},data:{status:'review',endedAt:new Date()}});
    const review=await call(base,`/${encodeURIComponent(secondBatch.id)}`);
    assert.equal(review.status,200);
    assert.equal(review.payload.canApply,true,JSON.stringify(review.payload.blockers));
    const confirmations=review.payload.reports.map(report=>({roundId:report.round.id,reviewToken:report.reviewToken,fullStoreConfirmed:true}));
    const unconfirmed=await call(base,`/${encodeURIComponent(secondBatch.id)}/apply`,{body:{roundReviews:confirmations.map(item=>({...item,fullStoreConfirmed:false}))}});
    assert.equal(unconfirmed.status,409,'applying without every store confirmation is rejected');
    assert.equal((await prisma.storeStock.findUnique({where:{storeId_productSizeId:{storeId:store.id,productSizeId:size.id}}})).stock,7,'rejected application preserves official stock');
    const applied=await call(base,`/${encodeURIComponent(secondBatch.id)}/apply`,{body:{roundReviews:confirmations}});
    assert.equal(applied.status,200,JSON.stringify(applied.payload));
    assert.equal(applied.payload.stores.length,second.payload.stores.length,'all active stores are applied together');
    assert.equal((await prisma.stocktakeReconstruction.findUnique({where:{id:secondBatch.id}})).status,'applied');
    assert.equal((await prisma.storeStock.findUnique({where:{storeId_productSizeId:{storeId:store.id,productSizeId:size.id}}})).stock,0,'the explicit zero count replaces the store balance');
    assert.equal((await prisma.storeStock.findUnique({where:{storeId_productSizeId:{storeId:separateCompany.id,productSizeId:size.id}}})).stock,11,'applying the reconstruction never touches Baratão');
    assert.equal((await prisma.productSize.findUnique({where:{id:size.id}})).stock,7,'the purchased total is preserved');
    console.log('PASS HTTP isolado: autenticação/admin; empresa desconhecida bloqueia; LOJA01 separado; rodada nova por loja; leituras antigas não entram; arquivamento preserva saldos; sem confirmação não aplica; confirmação completa substitui todas as lojas em conjunto e preserva o comprado.');
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>prisma.$disconnect());
