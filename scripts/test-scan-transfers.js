'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {PrismaClient}=require('@prisma/client');
const service=require('../src/services/scanTransfers');
const url=process.env.TRANSFER_TEST_DATABASE_URL;
if(!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('Use an isolated local TRANSFER_TEST_DATABASE_URL');
const db=new PrismaClient({datasources:{db:{url}}});
(async()=>{
 const key=randomUUID();
 const a=await db.store.create({data:{name:'Origem teste '+key,code:'TA'+key}}),b=await db.store.create({data:{name:'Destino teste '+key,code:'TB'+key}}),c=await db.store.create({data:{name:'Outra teste '+key,code:'TC'+key}});
 const actor=await db.user.create({data:{name:'Operador teste',phone:'test-'+key,pin:'isolated-test',role:'seller',storeId:a.id}});
 const other=await db.user.create({data:{name:'Outro operador',phone:'other-'+key,pin:'isolated-test',role:'seller',storeId:b.id}});
 const p=await db.product.create({data:{name:'Produto teste',sku:'TEST-'+key,brand:'TEST',category:'tenis',price:100,costPrice:55,sizes:{create:{size:'40',stock:77,barcode:'test-'+key}}},include:{sizes:true}}),ps=p.sizes[0];
 await db.storeStock.createMany({data:[{storeId:a.id,productSizeId:ps.id,stock:3},{storeId:b.id,productSizeId:ps.id,stock:1}]});
 const captures=await db.productCapture.count(),bipes=await db.stocktakeBipe.count();
 const sessionId=randomUUID(),input={requestId:randomUUID(),sessionId,productSizeId:ps.id,fromStoreId:a.id,toStoreId:b.id,barcode:ps.barcode};
 const located=await service.lookup(db,actor,{barcode:ps.barcode});assert.equal(located.locations.length,2);assert.ok(located.locations.find(x=>x.id===a.id).canTransfer);assert.equal(located.locations.find(x=>x.id===b.id).canTransfer,false);assert.ok(!JSON.stringify(located).includes('costPrice'));
 const results=await Promise.all(Array.from({length:8},()=>service.transfer(db,actor,input)));assert.equal(new Set(results.map(x=>x.id)).size,1);assert.equal(await db.stockTransfer.count({where:{id:input.requestId}}),1);
 let stocks=await db.storeStock.findMany({where:{productSizeId:ps.id}});assert.equal(stocks.find(s=>s.storeId===a.id).stock,2);assert.equal(stocks.find(s=>s.storeId===b.id).stock,2);
 let h=await service.history(db,actor,sessionId);assert.equal(h.today,1);assert.equal(h.session,1);assert.equal((await service.history(db,other,sessionId)).today,0);
 await assert.rejects(()=>service.undo(db,other,input.requestId),e=>e.status===404);
 await assert.rejects(()=>service.transfer(db,actor,{...input,toStoreId:c.id}),e=>e.status===409);
 await assert.rejects(()=>service.transfer(db,actor,{...input,requestId:randomUUID(),fromStoreId:b.id,toStoreId:a.id}),e=>e.status===403);
 const second=await service.transfer(db,actor,{...input,requestId:randomUUID()});await assert.rejects(()=>service.undo(db,actor,input.requestId),e=>e.status===409);
 await Promise.all(Array.from({length:5},()=>service.undo(db,actor,second.id)));await service.undo(db,actor,input.requestId);assert.equal((await service.history(db,actor,sessionId)).today,0);
 stocks=await db.storeStock.findMany({where:{productSizeId:ps.id}});assert.equal(stocks.find(s=>s.storeId===a.id).stock,3);assert.equal(stocks.find(s=>s.storeId===b.id).stock,1);
 // Two operators cannot send the last unit twice.
 const competition=await Promise.allSettled([service.transfer(db,other,{...input,requestId:randomUUID(),fromStoreId:b.id,toStoreId:a.id}),service.transfer(db,other,{...input,requestId:randomUUID(),fromStoreId:b.id,toStoreId:a.id})]);assert.equal(competition.filter(r=>r.status==='fulfilled').length,1);
 const won=competition.find(r=>r.status==='fulfilled').value;
 // A sale consuming the destination stock prevents an impossible undo.
 const destination=await db.storeStock.findUnique({where:{storeId_productSizeId:{storeId:a.id,productSizeId:ps.id}}});await db.storeStock.update({where:{id:destination.id},data:{stock:0}});await assert.rejects(()=>service.undo(db,other,won.id),e=>e.status===409);await db.storeStock.update({where:{id:destination.id},data:{stock:destination.stock}});await service.undo(db,other,won.id);
 assert.equal((await db.productSize.findUnique({where:{id:ps.id}})).stock,77);assert.equal(await db.productCapture.count(),captures);assert.equal(await db.stocktakeBipe.count(),bipes);
 const persisted=await db.stockTransfer.findUnique({where:{id:input.requestId}});assert.equal(persisted.fiscalStatus,'skipped');assert.equal(persisted.fiscalDocId,null);
 assert.equal(service.dayStart(new Date('2026-09-15T02:59:59Z')).toISOString(),'2026-09-14T03:00:00.000Z');
 console.log('PASS: atomic transfer, 8 retries = 1 movement pair, own history/session/day, source permissions, last-only undo, repeated undo, concurrent last unit, insufficient destination, no fiscal/purchased/inventory changes');
 if(process.env.TRANSFER_TEST_FIXTURE)require('fs').writeFileSync(process.env.TRANSFER_TEST_FIXTURE,JSON.stringify({actorId:actor.id,otherId:other.id,fromStoreId:a.id,toStoreId:b.id,productSizeId:ps.id,barcode:ps.barcode,sessionId}));
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>db.$disconnect());
