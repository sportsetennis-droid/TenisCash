'use strict';
// =====================================================================
// /api/fotos-loja — o vendedor fotografa na loja a peça do card que falta foto
// (dono 19/11: "Arrume outro jeito" para foto sem crédito). Tela: /fotos-loja.html
// Acesso: conta pessoal de vendedor/gestor (mesma identificação das transferências).
// =====================================================================
const express = require('express');
const { authMiddleware, prisma } = require('../middleware');
const { operator } = require('../services/scanTransfers');
const fotos = require('../services/fotosDaLoja');

const router = express.Router();
router.use(authMiddleware);
router.use(async (req, res, next) => {
  try { req.ator = await operator(prisma, req.userId); next(); }
  catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Não foi possível verificar seu acesso.' }); }
});
const handle = (fn) => async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await fn(req)); }
  catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Não foi possível concluir. Tente de novo.' }); }
};

router.get('/contexto', handle(async (req) => {
  const { canSend } = require('../services/scanTransfers');
  const lojas = await prisma.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
  return { usuario: { id: req.ator.id, nome: req.ator.name, papel: req.ator.role }, lojas: lojas.filter((l) => canSend(req.ator, l.id)) };
}));
router.get('/pendentes', handle((req) => fotos.pendentes(prisma, req.ator, String(req.query.storeId || '')).then((itens) => ({ itens }))));
router.post('/:productId', handle((req) => fotos.salvar(prisma, req.ator, req.params.productId, req.body || {})));

module.exports = router;
