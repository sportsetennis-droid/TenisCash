'use strict';
const router=require('express').Router();
const {prisma,authMiddleware,adminMiddleware}=require('../middleware');
const service=require('../services/stockReplacement');
const staff=require('../services/scanTransfers');
const run=fn=>async(req,res)=>{try{await fn(req,res)}catch(e){console.warn('[replacement]',e.message);res.status(e.status||500).json({error:e.status?e.message:'Não foi possível concluir a operação. Atualize e tente novamente.'})}};
async function access(req,storeId){const actor=await staff.operator(prisma,req.userId);if(!staff.canSend(actor,storeId)){const e=Error('Esta loja não está vinculada à sua conta.');e.status=403;throw e;}return actor;}
async function roundAccess(req){const round=await prisma.stocktakeRound.findUnique({where:{id:req.params.id}});if(round?.operationType!=='replacement'){const e=Error('Substituição não encontrada.');e.status=404;throw e;}await access(req,round.storeId);return round;}
router.use(authMiddleware);
router.get('/',run(async(req,res)=>{const actor=await staff.operator(prisma,req.userId);const stores=(await prisma.store.findMany({where:{active:true},orderBy:{code:'asc'},select:{id:true,name:true,code:true}})).filter(s=>staff.canSend(actor,s.id));const rounds=await prisma.stocktakeRound.findMany({where:{operationType:'replacement',storeId:{in:stores.map(s=>s.id)}},orderBy:{startedAt:'desc'},select:{id:true,number:true,storeId:true,status:true,startedAt:true,endedAt:true}});res.json({stores,rounds,actor:{id:actor.id,name:actor.name,role:actor.role}})}));
router.get('/preview',adminMiddleware,run(async(req,res)=>res.json(await service.preview(prisma,String(req.query.storeId||'')))));
router.post('/',adminMiddleware,run(async(req,res)=>res.json(await service.start(prisma,req.body||{},req.userId))));
router.get('/:id',run(async(req,res)=>{await roundAccess(req);res.json(await service.report(prisma,req.params.id))}));
router.get('/:id/captures/:captureId',run(async(req,res)=>{await roundAccess(req);const c=await prisma.productCapture.findFirst({where:{id:req.params.captureId,roundId:req.params.id},select:{id:true,photo:true,photos:true,barcode:true,bipeId:true,createdAt:true}});if(!c)return res.status(404).json({error:'Foto não encontrada nesta operação.'});res.set('Cache-Control','private, no-store').json(c)}));
router.post('/:id/retry',run(async(req,res)=>{await roundAccess(req);const bipes=await prisma.stocktakeBipe.findMany({where:{roundId:req.params.id,excludedAt:null,applied:false},select:{id:true}});for(const b of bipes)service.enqueue(prisma,b.id);res.json({queued:bipes.length})}));
router.post('/:id/finish',adminMiddleware,run(async(req,res)=>{await roundAccess(req);res.json(await service.finish(prisma,req.params.id))}));
module.exports=router;
