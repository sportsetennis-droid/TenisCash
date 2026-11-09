'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),express=require('express'),jwt=require('jsonwebtoken');
const url=process.env.ROUND_TEST_DATABASE_URL;if(!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/stock_replacement_'))throw Error('Somente banco local isolado.');process.env.DATABASE_URL=url;
const mw=require('../src/middleware'),db=mw.prisma,service=require('../src/services/stockReplacement');
const originalInterval=global.setInterval,originalTimeout=global.setTimeout;global.setInterval=global.setTimeout=()=>({unref(){}});const router=require('../src/routes/stocktake');global.setInterval=originalInterval;global.setTimeout=originalTimeout;
const originalImmediate=global.setImmediate,background=new Set();
global.setImmediate=(fn,...args)=>originalImmediate(()=>{const task=fn(...args);if(task?.then){background.add(task);task.then(()=>background.delete(task),()=>background.delete(task));}});
const app=express();app.use(express.json());app.use('/api/stocktake',router);
(async()=>{const u=randomUUID(),s=await db.store.create({data:{code:'HTTP-'+u,name:'Teste HTTP'}}),other=await db.store.create({data:{code:'HTTP-OTHER-'+u,name:'Outra loja HTTP'}});
 const users={};for(const [key,role,storeId] of [['admin','admin',null],['seller','seller',s.id],['other','seller',other.id]])users[key]=await db.user.create({data:{name:key,role,storeId,phone:'test-'+key+'-'+u,pin:'test-only'}});
 const p=await db.product.create({data:{sku:'HTTP-'+u,name:'Tênis de teste',brand:'PUMA',category:'Tênis',price:100}}),ps=await db.productSize.create({data:{productId:p.id,size:'41',barcode:'4067983952562',stock:8}});await db.storeStock.create({data:{storeId:s.id,productSizeId:ps.id,stock:8}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/stocktake';
 const call=async(path,body,who='admin')=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(who?{Authorization:'Bearer '+jwt.sign({userId:users[who].id},mw.JWT_SECRET,{expiresIn:'5m'})}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
 try{
  assert.equal((await call('/replacements',undefined,null)).status,401);assert.equal((await call('/replacements/preview?storeId='+s.id,undefined,'seller')).status,403);
  const preview=await call('/replacements/preview?storeId='+s.id);assert.equal(preview.status,200);const requestId=randomUUID();const created=await call('/replacements',{storeId:s.id,requestId,reviewToken:preview.data.reviewToken});assert.equal(created.status,200,JSON.stringify(created));assert.equal(created.data.round.createdById,users.admin.id);const id=created.data.round.id;
  assert.equal((await call('/replacements/'+id,undefined,'other')).status,403);assert.equal((await call('/replacements/'+id,undefined,'seller')).status,200);
  const read={roundId:id,storeId:s.id,clientScanId:randomUUID(),barcode:ps.barcode,sellerId:users.other.id,sellerName:'Falso'};
  assert.equal((await call('/recognize',read,null)).status,401);assert.equal((await call('/recognize',read,'other')).status,403);assert.equal((await call('/bipe',read,null)).status,401);
  assert.equal((await call('/recognize',read,'seller')).status,409);read.sellerId=users.seller.id;
  const scanned=await call('/recognize',read,'seller');assert.equal(scanned.status,200,JSON.stringify(scanned));let b=await db.stocktakeBipe.findUnique({where:{scanKey:id+':'+read.clientScanId}});assert.equal(b.sellerId,users.seller.id);assert.equal(b.sellerName,users.seller.name);assert.equal(b.applied,false);assert.equal((await db.storeStock.findUnique({where:{storeId_productSizeId:{storeId:s.id,productSizeId:ps.id}}})).stock,0);
  const png=await require('sharp')({create:{width:40,height:40,channels:3,background:'#fff'}}).png().toBuffer();const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'test.png');for(const [k,v] of Object.entries({...read,eanLocal:read.barcode,photoRevision:1}))form.append(k,String(v));const r=await fetch(base+'/etiqueta',{method:'POST',headers:{Authorization:'Bearer '+jwt.sign({userId:users.seller.id},mw.JWT_SECRET)},body:form});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));
  const capture=await db.productCapture.findUnique({where:{scanKey:id+':'+read.clientScanId}});assert.ok(capture);assert.equal(capture.sellerId,users.seller.id);assert.equal(capture.photo,'data:image/png;base64,'+png.toString('base64'));assert.equal(capture.bipeId,b.id);
  assert.equal((await call('/etiqueta-status?ids='+capture.id,undefined,null)).status,401);const status=await call('/etiqueta-status?ids='+capture.id,undefined,'seller');assert.equal(status.status,200,JSON.stringify(status));assert.equal(status.data.rows[0].complete,false);assert.equal(status.data.rows[0].photoSaved,true);
  assert.equal((await call('/replacements/'+id+'/captures/'+capture.id,undefined,'other')).status,403);assert.equal((await call('/replacements/'+id+'/captures/'+capture.id,undefined,'seller')).data.photo,capture.photo);
  assert.equal((await call('/rounds/'+id+'/cancel',{})).status,409);assert.equal((await call('/rounds/'+id+'/seal',{})).status,409);assert.equal((await call('/rounds/'+id+'/finish',{fullStoreConfirmed:true})).status,409);assert.equal((await call('/replacements/'+id+'/finish',{})).status,409);
  const live=await call('/rounds/current?storeId='+s.id+'&operation=replacement');assert.equal(live.data.round.id,id);assert.equal((await call('/rounds/current?storeId='+s.id)).data.round,null);
  assert.equal(await db.stocktakeBipe.count({where:{roundId:id}}),1);console.log('PASS HTTP: autenticação, loja, operador real, prévia/início, foto original, idempotência, pendência, consulta protegida e separação do inventário');
  const prefix='8'+randomUUID().replace(/\D/g,'').padEnd(11,'0').slice(0,11);
  const code=prefix+((10-[...prefix].reduce((sum,n,i)=>sum+Number(n)*(i%2?3:1),0)%10)%10);
  const target=await db.productSize.create({data:{productId:p.id,size:'42',barcode:null,stock:0}});
  const legacy=await db.product.create({data:{sku:'OLD-'+u,name:'Cadastro unificado',brand:'PUMA',category:'Tênis',active:false,price:100,aiContext:{consolidatedInto:p.id}}});
  await db.productSize.create({data:{productId:legacy.id,size:'42',barcode:code,stock:0}});
  const consolidatedRead={...read,clientScanId:randomUUID(),eanLocal:code,photoRevision:1};
  let firstId;
  for(let attempt=0;attempt<2;attempt++){
   const fd=new FormData();fd.append('file',new Blob([png],{type:'image/png'}),'same-original.png');for(const [k,v]of Object.entries(consolidatedRead))fd.append(k,String(v));
   const response=await fetch(base+'/etiqueta',{method:'POST',headers:{Authorization:'Bearer '+jwt.sign({userId:users.seller.id},mw.JWT_SECRET)},body:fd});const result=await response.json();
   assert.equal(response.status,200);assert.ok(result.bipeId,JSON.stringify(result));firstId??=result.bipeId;assert.equal(result.bipeId,firstId);
  }
  const linked=await db.stocktakeBipe.findUnique({where:{id:firstId}});assert.equal(linked.productSizeId,target.id);assert.equal(linked.barcode,code);assert.equal(linked.applied,false);
  assert.equal(await db.stocktakeBipe.count({where:{scanKey:id+':'+consolidatedRead.clientScanId}}),1);
  console.log('PASS HTTP: consolidated legacy barcode follows the exact product ID, creates the pending bipe and retries without another piece or premature stock.');
 }finally{await new Promise(r=>server.close(r));await new Promise(originalImmediate);while(background.size)await Promise.allSettled([...background]);global.setImmediate=originalImmediate;}
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
