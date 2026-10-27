'use strict';
const express=require('express');
const {prisma,authMiddleware,adminMiddleware}=require('../middleware');
const service=require('../services/stocktakeRounds');
const router=express.Router();
const run=fn=>async(req,res)=>{try{await fn(req,res)}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Não foi possível concluir. Atualize e tente novamente.',...(e.details?{details:e.details}:{})})}};

router.use(authMiddleware,adminMiddleware);
router.get('/active',run(async(_req,res)=>{
  const batch=await prisma.stocktakeReconstruction.findFirst({where:{status:'counting'},orderBy:{number:'desc'},select:{id:true}});
  if(!batch)return res.json({reconstruction:null});
  res.json({reconstruction:await service.reconstructionReport(prisma,batch.id,{includeDetails:false})});
}));
router.get('/',run(async(_req,res)=>{
  const reconstructions=await prisma.stocktakeReconstruction.findMany({orderBy:{number:'desc'},take:50,
    select:{id:true,number:true,name:true,status:true,startedAt:true,endedAt:true,appliedAt:true,storeIds:true}});
  res.json({reconstructions});
}));
router.post('/',run(async(req,res)=>{
  res.status(201).json(await service.startReconstruction(prisma,req.body.name,req.userId));
}));
router.get('/:id',run(async(req,res)=>{
  res.json(await service.reconstructionReport(prisma,req.params.id,{includeDetails:false}));
}));
router.post('/:id/apply',run(async(req,res)=>{
  res.json(await service.applyReconstruction(prisma,req.params.id,req.body.roundReviews));
}));
router.post('/:id/cancel',run(async(req,res)=>{
  res.json(await service.cancelReconstruction(prisma,req.params.id));
}));
module.exports=router;
