// =====================================================================
// Routes: /api/admin/reels-agency — "Agência de Reels por Loja"
// O dono VÊ os agentes da esteira de conteúdo e ESCOLHE loja + produto
// (estoque/foto/preço 100% REAIS) pra virar reel. Tela: /reels.html
// =====================================================================
const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const { generateDailySlate, getSavedSlate } = require('../services/dailySlate');

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

// O time da agência (visível pro dono) — cada agente, o que faz, status.
const SQUAD = [
  { code: 'estoquista', name: 'Estoquista', emoji: '📦', role: 'Lê o estoque REAL bipado de cada loja e separa o que dá pra empurrar', status: 'online' },
  { code: 'curador', name: 'Curador Viral', emoji: '🎯', role: 'Escolhe o produto-herói pelo DNA da loja (apelo + giro + estoque)', status: 'online' },
  { code: 'roteirista', name: 'Roteirista de Origem', emoji: '✍️', role: 'Cria a narrativa de origem ("o Reinado é da Massa") do produto', status: 'online' },
  { code: 'designer', name: 'Designer de Reel', emoji: '🎬', role: 'Monta o reel 9:16 com a foto real do produto e skin própria', status: 'online' },
  { code: 'auditor', name: 'Auditor', emoji: '🛡️', role: 'Confere fato/preço/estoque e as regras (só verificado, sem fornecedor)', status: 'online' },
  { code: 'publicador', name: 'Publicador', emoji: '🚀', role: 'Entrega o .mp4 + legenda; você posta pelo app com áudio em alta', status: 'idle' },
];

const DNA_HINT = {
  Masculino: 'Homem — corrida, lifestyle, treino',
  Feminino: 'Mulher — corrida, fitness, moda',
  Futebol: 'Futebol — chuteira, society, várzea',
  Geral: 'Geral — Paraíba, o que todo mundo usa',
};

router.get('/squad', (_req, res) => {
  res.json({ squad: SQUAD });
});

// Lojas físicas S&T (exclui Baratão e Ecommerce)
router.get('/stores', async (_req, res) => {
  try {
    const stores = await prisma.store.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, dna: true, mall: true, city: true },
      orderBy: { code: 'asc' },
    });
    const fisicas = stores
      .filter((s) => /sports\s*&\s*tennis/i.test(s.name) && !/ecommerce/i.test(s.name))
      .map((s) => ({ ...s, dnaHint: DNA_HINT[s.dna] || s.dna || '' }));
    res.json({ stores: fisicas });
  } catch (err) {
    console.error('[reels-agency/stores]', err);
    res.status(500).json({ error: 'Erro ao listar lojas', detail: err.message });
  }
});

// Candidatos REAIS por loja: estoque bipado (StoreStock) > 0, ativo, com foto e preço.
router.get('/candidates', async (req, res) => {
  try {
    const storeId = String(req.query.storeId || '');
    if (!storeId) return res.status(400).json({ error: 'storeId é obrigatório' });
    const rows = await prisma.$queryRawUnsafe(`
      SELECT p.id, p.brand, p.name, p.price, p."promoPrice", p."imageUrl",
             p."aiContext"->>'color' AS color, p.category, p.subcategory,
             SUM(ss.stock)::int AS qt, COUNT(DISTINCT psz.id)::int AS tams
      FROM "StoreStock" ss
      JOIN "ProductSize" psz ON psz.id = ss."productSizeId"
      JOIN "Product" p ON p.id = psz."productId"
      WHERE ss."storeId" = $1 AND ss.stock > 0 AND p.active = true
        AND p."imageUrl" IS NOT NULL AND p.price > 0
      GROUP BY p.id
      HAVING SUM(ss.stock) >= 2
      ORDER BY qt DESC
      LIMIT 24`, storeId);
    res.json({ storeId, count: rows.length, candidates: rows });
  } catch (err) {
    console.error('[reels-agency/candidates]', err);
    res.status(500).json({ error: 'Erro ao puxar candidatos', detail: err.message });
  }
});

// Dono ESCOLHE um produto pra virar reel → grava como pedido (fila).
// Não renderiza aqui (o render é local); registra a escolha pra produção.
router.post('/pick', async (req, res) => {
  try {
    const { storeId, productId, note } = req.body || {};
    if (!storeId || !productId) return res.status(400).json({ error: 'storeId e productId são obrigatórios' });
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, brand: true, name: true, price: true, imageUrl: true },
    });
    const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, dna: true } });
    if (!product || !store) return res.status(404).json({ error: 'produto ou loja não encontrado' });
    res.json({
      ok: true,
      pick: { store, product, note: note || null, requestedAt: new Date().toISOString() },
      message: 'Escolha registrada. O Designer vai montar o reel desse produto.',
    });
  } catch (err) {
    console.error('[reels-agency/pick]', err);
    res.status(500).json({ error: 'Erro ao registrar escolha', detail: err.message });
  }
});

// MOLDE do dia (pauta): lê o slate salvo (gerado pelo cron 05:30 ou sob demanda).
router.get('/slate', async (_req, res) => {
  try {
    const slate = await getSavedSlate();
    res.json({ slate });
  } catch (err) {
    console.error('[reels-agency/slate]', err);
    res.status(500).json({ error: 'Erro ao ler o molde', detail: err.message });
  }
});

// Gera o molde de hoje sob demanda (botão "Gerar pauta"). ~30s. NÃO publica.
router.post('/slate/run', async (req, res) => {
  try {
    const ctx = req.body && typeof req.body.ctx === 'string' ? req.body.ctx : undefined;
    const slate = await generateDailySlate({ ctx });
    res.json({ ok: true, slate });
  } catch (err) {
    console.error('[reels-agency/slate/run]', err);
    res.status(500).json({ error: 'Erro ao gerar o molde', detail: err.message });
  }
});

module.exports = router;
