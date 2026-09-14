'use strict';
const express=require('express');
const {prisma,authMiddleware,adminMiddleware}=require('../middleware');
const service=require('../services/stocktakeRounds');
const router=express.Router();
const run=fn=>async(req,res)=>{try{await fn(req,res)}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Não foi possível concluir. Atualize e tente novamente.'})}};
router.get('/current',run(async(req,res)=>{
  const round=await prisma.stocktakeRound.findFirst({where:{activeStoreId:String(req.query.storeId||'')},select:{id:true,number:true,name:true,storeId:true,status:true,startedAt:true}});
  if(!round)return res.json({round:null});
  const [bipes,captures]=await Promise.all([
    prisma.stocktakeBipe.findMany({where:{roundId:round.id},select:{found:true,duplicate:true,productSizeId:true,productSize:true,excludedAt:true}}),
    prisma.productCapture.findMany({where:{roundId:round.id},select:{bipeId:true,status:true,excludedAt:true}})]);
  res.json({round,totals:service.summarize(bipes,captures)});
}));
router.use(authMiddleware,adminMiddleware);
router.get('/',run(async(req,res)=>{
  const rounds=await prisma.stocktakeRound.findMany({orderBy:{number:'desc'},take:100});
  res.json({rounds:rounds.map(({baseline,result,...r})=>r)});
}));
router.post('/',run(async(req,res)=>{
  const round=await service.startRound(prisma,String(req.body.storeId||''),req.body.name,req.user?.id);
  res.json({round});
}));
router.get('/:id',run(async(req,res)=>res.json(await service.roundReport(prisma,req.params.id))));
router.post('/:id/seal',run(async(req,res)=>{
  await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${req.params.id} FOR UPDATE`;
    const round=await tx.stocktakeRound.findUnique({where:{id:req.params.id}});
    if(!round)service.fail('Rodada não encontrada.',404);
    if(round.status==='review')return;
    if(round.status!=='counting')service.fail('Esta rodada já foi encerrada.');
    await tx.stocktakeRound.update({where:{id:round.id},data:{status:'review',endedAt:new Date()}});
  });res.json({ok:true});
}));
router.post('/:id/cancel',run(async(req,res)=>{
  const changed=await prisma.stocktakeRound.updateMany({where:{id:req.params.id,status:{in:['counting','review']}},data:{status:'cancelled',activeStoreId:null,endedAt:new Date()}});
  if(!changed.count)service.fail('Rodada já encerrada.');res.json({ok:true});
}));
router.post('/:id/exclude/:bipeId',run(async(req,res)=>{
  if(!String(req.body.reason||'').trim())service.fail('Informe o motivo da correção.',400);
  await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${req.params.id} FOR UPDATE`;
    const round=await tx.stocktakeRound.findUnique({where:{id:req.params.id}});
    if(!round||!['counting','review'].includes(round.status))service.fail('Rodada encerrada.');
    const bipe=await tx.stocktakeBipe.findUnique({where:{id:req.params.bipeId}});
    if(!bipe||bipe.roundId!==round.id||bipe.storeId!==round.storeId)service.fail('Bipe não pertence a esta rodada.');
    await tx.stocktakeBipe.update({where:{id:bipe.id},data:{excludedAt:new Date(),exclusionReason:String(req.body.reason).trim().slice(0,200)}});
    await tx.productCapture.updateMany({where:{roundId:round.id,bipeId:bipe.id},data:{excludedAt:new Date(),status:'descartado',exclusionReason:String(req.body.reason).slice(0,200)}});
  });res.json({ok:true});
}));
router.post('/:id/finish',run(async(req,res)=>res.json(await service.finishRound(prisma,req.params.id,req.body.reviewToken,req.body.fullStoreConfirmed))));
module.exports=router;
