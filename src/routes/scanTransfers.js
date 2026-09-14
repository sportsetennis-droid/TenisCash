'use strict';
const express=require('express');
const {authMiddleware,prisma}=require('../middleware');
const service=require('../services/scanTransfers');
const router=express.Router();
router.use(authMiddleware);
router.use(async(req,res,next)=>{try{req.transferActor=await service.operator(prisma,req.userId);next();}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Não foi possível verificar seu acesso.'});}});
function handle(fn){return async(req,res)=>{try{res.set('Cache-Control','no-store');res.json(await fn(req));}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Não foi possível concluir. Atualize e tente novamente com a mesma leitura.'});}};}
router.get('/me',handle(async r=>({user:r.transferActor})));
router.post('/lookup',handle(r=>service.lookup(prisma,r.transferActor,r.body||{})));
router.post('/confirm',handle(r=>service.transfer(prisma,r.transferActor,r.body||{})));
router.post('/:id/undo',handle(r=>service.undo(prisma,r.transferActor,r.params.id)));
router.get('/history',handle(r=>service.history(prisma,r.transferActor,String(r.query.sessionId||''))));
module.exports=router;
