'use strict';
const {resolveBarcodeRows,aliasRows}=require('./scannerCatalog');
const {matchScannerReference}=require('./scannerReference');
const {parseScannerText}=require('./scannerText');
const {applyStoreStockDelta}=require('./storeStockLedger');
const SOURCE='camera-transfer-v1';
const staffRoles=['seller','admin','superadmin','manager'];
function fail(message,status=400){const e=new Error(message);e.status=status;throw e;}
function uuid(value){return typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);}
function note(sessionId,barcode){return JSON.stringify({source:SOURCE,sessionId,barcode});}
function isOurs(t){try{return JSON.parse(t.note||'{}').source===SOURCE;}catch(_){return false;}}
function canSend(actor,storeId){return actor.role!=='seller'||[actor.storeId,...(actor.storeIds||[])].includes(storeId);}
async function operator(db,id){const u=await db.user.findUnique({where:{id},select:{id:true,name:true,role:true,active:true,storeId:true,storeIds:true}});if(!u?.active||!staffRoles.includes(u.role))fail('Entre com sua conta pessoal de vendedor ou gestor.',403);return u;}
const publicInclude={fromStore:{select:{id:true,name:true,code:true}},toStore:{select:{id:true,name:true,code:true}},items:{select:{productSizeId:true,productName:true,brand:true,size:true,barcode:true,quantity:true}}};
function publicTransfer(t){return {id:t.id,code:t.code,status:t.status,createdAt:t.createdAt,cancelledAt:t.cancelledAt,fromStore:t.fromStore,toStore:t.toStore,items:t.items,qtyTotal:t.qtyTotal};}
function dayStart(now=new Date()){const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);return new Date(date+'T00:00:00-03:00');}
async function lookup(db,actor,{barcode,ocrText}){
  barcode=String(barcode||'').trim();if(barcode.length>60||String(ocrText||'').length>5000)fail('Leitura inválida.');
  let sizes=[];
  if(barcode){const codes=[...new Set([barcode,barcode.replace(/^0+/,''),barcode.padStart(13,'0'),barcode.padStart(14,'0')])];
    sizes=await resolveBarcodeRows(db,await db.productSize.findMany({where:{barcode:{in:codes}},include:{product:true}}));
    if(!sizes.length)sizes=await aliasRows(db,barcode);
  }
  if(sizes.length>1)fail('Código associado a mais de um produto. Confira o cadastro antes de transferir.',409);
  if(!sizes.length&&ocrText){const read=parseScannerText(ocrText);const size=String(read?.tamanho||'').replace(/^BRA?\s*/i,'').trim();
    if(read&&size){const match=await matchScannerReference(db,read,size);if(match.productSizeId)sizes=[await db.productSize.findUnique({where:{id:match.productSizeId},include:{product:true}})];}
  }
  if(!sizes.length)fail('Produto não identificado. Aproxime a etiqueta e tente novamente; nenhuma transferência foi feita.',404);
  const ps=sizes[0],p=ps.product||await db.product.findUnique({where:{id:ps.productId}});
  if(!p?.active)fail('Cadastro inativo. Confira o produto antes de transferir.',409);
  if(!ps.size||ps.size==='?'||/^T-|^Único-/i.test(ps.size))fail('O tamanho desta etiqueta precisa ser conferido no cadastro antes da transferência.',409);
  const stores=await db.store.findMany({where:{active:true},select:{id:true,name:true,code:true},orderBy:{name:'asc'}});
  const stocks=await db.storeStock.findMany({where:{productSizeId:ps.id,stock:{gt:0},storeId:{in:stores.map(s=>s.id)}},select:{storeId:true,stock:true}});
  return {product:{productSizeId:ps.id,name:p.name,brand:p.brand,size:ps.size,barcode:barcode||ps.barcode||'',imageUrl:p.imageUrl||null},
    locations:stocks.map(s=>({...stores.find(x=>x.id===s.storeId),quantity:s.stock,canTransfer:canSend(actor,s.storeId)})),stores};
}
async function transfer(db,actor,input){
  const {requestId,sessionId,productSizeId,fromStoreId,toStoreId}=input;
  if(![requestId,sessionId,productSizeId,fromStoreId,toStoreId].every(uuid))fail('Identificação da transferência inválida. Escaneie novamente.');
  if(fromStoreId===toStoreId)fail('Escolha uma loja de destino diferente da origem.');
  if(!canSend(actor,fromStoreId))fail('Você só pode transferir a partir das lojas vinculadas à sua conta.',403);
  return db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${SOURCE}))::text`;
    const existing=await tx.stockTransfer.findUnique({where:{id:requestId},include:publicInclude});
    if(existing){if(existing.createdById!==actor.id||!isOurs(existing)||existing.fromStoreId!==fromStoreId||existing.toStoreId!==toStoreId||existing.items[0]?.productSizeId!==productSizeId)fail('Identificador já utilizado em outra transferência.',409);return {...publicTransfer(existing),alreadySaved:true};}
    const stores=await tx.store.count({where:{id:{in:[fromStoreId,toStoreId]},active:true}});if(stores!==2)fail('Origem ou destino não está disponível.',409);
    const ps=await tx.productSize.findUnique({where:{id:productSizeId},include:{product:true}});if(!ps?.product?.active)fail('Produto indisponível.',409);
    if(!ps.size||ps.size==='?'||/^T-|^Único-/i.test(ps.size))fail('Tamanho não confirmado.',409);
    // Lock balance rows in stable order; the source guard also handles concurrent sales.
    await tx.$queryRaw`SELECT id FROM "StoreStock" WHERE "productSizeId"=${productSizeId} AND "storeId" IN (${fromStoreId},${toStoreId}) ORDER BY "storeId" FOR UPDATE`;
    const source=await tx.storeStock.findUnique({where:{storeId_productSizeId:{storeId:fromStoreId,productSizeId}}});
    if(!source||source.stock<1)fail('O saldo da origem mudou ou está zerado. Atualize a leitura; nada foi transferido.',409);
    const highest=await tx.stockTransfer.aggregate({_max:{code:true}});
    const saved=await tx.stockTransfer.create({data:{id:requestId,code:(highest._max.code||0)+1,fromStoreId,toStoreId,status:'received',createdById:actor.id,receivedById:actor.id,receivedAt:new Date(),itemsCount:1,qtyTotal:1,fiscalStatus:'skipped',note:note(sessionId,String(input.barcode||ps.barcode||'').slice(0,60)),items:{create:{productSizeId,quantity:1,productName:ps.product.name,brand:ps.product.brand,size:ps.size,barcode:String(input.barcode||ps.barcode||'').slice(0,60)}}},include:publicInclude});
    const metadata={transferId:saved.id,actorId:actor.id,sessionId};
    await applyStoreStockDelta(tx,{storeId:fromStoreId,productSizeId,quantity:-1,type:'transfer_out',source:SOURCE,reason:'Transferência #'+saved.code,metadata});
    await applyStoreStockDelta(tx,{storeId:toStoreId,productSizeId,quantity:1,type:'transfer_in',source:SOURCE,reason:'Transferência #'+saved.code,metadata});
    return publicTransfer(saved);
  },{timeout:15000});
}
async function undo(db,actor,id){
  if(!uuid(id))fail('Transferência inválida.');
  return db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${SOURCE}))::text`;
    const t=await tx.stockTransfer.findUnique({where:{id},include:publicInclude});
    if(!t||t.createdById!==actor.id||!isOurs(t))fail('Transferência não encontrada no seu histórico.',404);
    if(t.status==='cancelled')return {...publicTransfer(t),alreadyUndone:true};
    const last=await tx.stockTransfer.findFirst({where:{createdById:actor.id,status:'received',note:{startsWith:'{"source":"'+SOURCE+'",'}},orderBy:{code:'desc'}});
    if(last?.id!==id)fail('Só é possível desfazer sua última transferência ativa.',409);
    if(t.status!=='received'||t.fiscalDocId||t.items.length!==1||t.items[0].quantity!==1)fail('Esta transferência não permite desfazer por esta tela.',409);
    const ps=t.items[0].productSizeId;
    await tx.$queryRaw`SELECT id FROM "StoreStock" WHERE "productSizeId"=${ps} AND "storeId" IN (${t.fromStoreId},${t.toStoreId}) ORDER BY "storeId" FOR UPDATE`;
    const dest=await tx.storeStock.findUnique({where:{storeId_productSizeId:{storeId:t.toStoreId,productSizeId:ps}}});
    if(!dest||dest.stock<1)fail('O destino já não tem saldo para devolver esta peça. Nenhum estoque foi alterado.',409);
    const metadata={transferId:id,actorId:actor.id};
    await applyStoreStockDelta(tx,{storeId:t.toStoreId,productSizeId:ps,quantity:-1,type:'transfer_undo_out',source:SOURCE,reason:'Desfazer transferência #'+t.code,metadata});
    await applyStoreStockDelta(tx,{storeId:t.fromStoreId,productSizeId:ps,quantity:1,type:'transfer_undo_in',source:SOURCE,reason:'Desfazer transferência #'+t.code,metadata});
    return publicTransfer(await tx.stockTransfer.update({where:{id},data:{status:'cancelled',cancelledAt:new Date()},include:publicInclude}));
  },{timeout:15000});
}
async function history(db,actor,sessionId){
  if(!uuid(sessionId))fail('Sessão inválida.');
  const where={createdById:actor.id,note:{startsWith:'{"source":"'+SOURCE+'",'},createdAt:{gte:dayStart()}};
  const [items,day,session,last]=await Promise.all([
    db.stockTransfer.findMany({where,include:publicInclude,orderBy:{code:'desc'},take:100}),
    db.stockTransfer.aggregate({where:{...where,status:'received'},_sum:{qtyTotal:true}}),
    db.stockTransfer.aggregate({where:{...where,status:'received',note:{startsWith:'{"source":"'+SOURCE+'","sessionId":"'+sessionId+'",'}},_sum:{qtyTotal:true}}),
    db.stockTransfer.findFirst({where:{createdById:actor.id,status:'received',note:where.note},include:publicInclude,orderBy:{code:'desc'}})
  ]);
  return {items:items.map(publicTransfer),today:day._sum.qtyTotal||0,session:session._sum.qtyTotal||0,last:last?publicTransfer(last):null};
}
module.exports={operator,lookup,transfer,undo,history,canSend,dayStart};
