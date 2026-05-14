// =====================================================================
// Routes: /api/admin/products — operações de metadado por produto
// (campo a campo em aiContext, sem precisar refazer o produto inteiro)
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// Localizações válidas — qualquer outra é rejeitada
const VALID_LOCATIONS = new Set([
  'Praia do Bessa',
  'Praia de Tambaú',
  'Rainha da Borborema',
  'Tambiá',
  'Baratão dos esportes',
  'Fábrica',
]);

// Atualiza apenas a localização do produto (aiContext.location)
router.post('/:id/location', async (req, res) => {
  try {
    const { location } = req.body || {};
    if (location && !VALID_LOCATIONS.has(location)) {
      return res.status(400).json({ error: 'Localização inválida' });
    }
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
    const ctx = (() => {
      try { return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : (product.aiContext || {}); }
      catch (_) { return {}; }
    })();
    ctx.location = location || null;
    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: { aiContext: ctx },
    });
    res.json({ ok: true, location: ctx.location, productId: updated.id });
  } catch (err) {
    console.error('[products/location] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Atualiza descrição técnica (longDescription + shortDescription derivado)
router.post('/:id/description', async (req, res) => {
  try {
    const { description } = req.body || {};
    const desc = description == null ? null : String(description).trim();
    const data = {
      longDescription: desc || null,
      shortDescription: desc ? (desc.length > 200 ? desc.slice(0, 200) + '…' : desc) : null,
    };
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ ok: true, product: { id: product.id, longDescription: product.longDescription, shortDescription: product.shortDescription } });
  } catch (err) {
    console.error('[products/description] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Atualiza gênero / esporte / ageGroup / cor em aiContext
router.post('/:id/classification', async (req, res) => {
  try {
    const { gender, ageGroup, sport, color } = req.body || {};
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
    const ctx = (() => {
      try { return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : (product.aiContext || {}); }
      catch (_) { return {}; }
    })();
    if (gender !== undefined) ctx.gender = gender || null;
    if (ageGroup !== undefined) ctx.ageGroup = ageGroup || null;
    if (sport !== undefined) ctx.sport = sport || null;
    if (color !== undefined) ctx.color = color || null;
    await prisma.product.update({
      where: { id: req.params.id },
      data: { aiContext: ctx },
    });
    res.json({ ok: true, aiContext: ctx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualização em massa de localização — todos os produtos de um CNPJ
router.post('/bulk-location', async (req, res) => {
  try {
    const { supplierCnpj, location } = req.body || {};
    if (!supplierCnpj) return res.status(400).json({ error: 'supplierCnpj obrigatório' });
    if (location && !VALID_LOCATIONS.has(location)) {
      return res.status(400).json({ error: 'Localização inválida' });
    }
    const products = await prisma.product.findMany({
      where: {
        active: true,
        aiContext: { path: ['supplierCnpj'], equals: String(supplierCnpj) },
      },
      select: { id: true, aiContext: true },
    });
    let updated = 0;
    for (const p of products) {
      const ctx = (() => {
        try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
        catch (_) { return {}; }
      })();
      ctx.location = location || null;
      await prisma.product.update({ where: { id: p.id }, data: { aiContext: ctx } });
      updated++;
    }
    res.json({ ok: true, updated });
  } catch (err) {
    console.error('[products/bulk-location] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
