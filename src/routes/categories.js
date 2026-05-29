// =====================================================================
// Routes: /api/admin/categories — árvore de categorias
// =====================================================================
const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const nsHandlers = require('../services/nuvemshopHandlers');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// Sync background pra Nuvemshop apos classificacao em lote.
// Fire-and-forget pra nao travar resposta HTTP em batches grandes.
function scheduleNsSync(productIds) {
  setImmediate(async () => {
    try {
      const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
      if (!conn) { console.log('[categories ns sync] sem conexao'); return; }
      const mapped = await prisma.nuvemshopProductMapping.findMany({
        where: { localProductId: { in: productIds } },
        select: { localProductId: true },
      });
      const mappedIds = new Set(mapped.map(m => m.localProductId));
      let ok = 0, fail = 0;
      for (const pid of productIds) {
        if (!mappedIds.has(pid)) continue;
        try {
          await nsHandlers.pushProductToNuvemshop(pid, conn);
          ok++;
        } catch (e) {
          fail++;
          console.error('[categories ns sync]', pid.slice(0,8), e.message);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      console.log(`[categories ns sync] concluido: ${ok} ok, ${fail} falhas (${productIds.length - mappedIds.size} sem mapping)`);
    } catch (err) {
      console.error('[categories ns sync] erro fatal:', err.message);
    }
  });
}

// GET /tree — retorna árvore completa hierárquica
router.get('/tree', async (req, res) => {
  try {
    const flat = await prisma.categoryNode.findMany({
      where: { active: true },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    // Conta produtos por nó via aiContext/category/subcategory
    // Pra simplicidade: só conta produtos nas folhas, mapeando level
    const byParent = {};
    flat.forEach(n => {
      const k = n.parentId || '__root__';
      (byParent[k] = byParent[k] || []).push(n);
    });
    function build(parentId) {
      const list = byParent[parentId || '__root__'] || [];
      return list.map(n => ({
        id: n.id, name: n.name, level: n.level, parentId: n.parentId,
        position: n.position, notes: n.notes,
        children: build(n.id),
      }));
    }
    res.json({ tree: build(null) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar árvore', detail: err.message });
  }
});

// POST / — cria nó (precisa name, level, parentId opcional)
router.post('/', async (req, res) => {
  try {
    const { name, level, parentId, position } = req.body || {};
    if (!name || !level) return res.status(400).json({ error: 'name e level obrigatórios' });
    if (!['CATEGORY', 'SUBCATEGORY', 'MODALITY', 'SPECIALTY'].includes(level)) {
      return res.status(400).json({ error: 'level inválido' });
    }
    // Valida hierarquia: parent deve ser do nível anterior
    if (parentId) {
      const parent = await prisma.categoryNode.findUnique({ where: { id: parentId } });
      if (!parent) return res.status(404).json({ error: 'parentId não encontrado' });
      const order = ['CATEGORY', 'SUBCATEGORY', 'MODALITY', 'SPECIALTY'];
      if (order.indexOf(parent.level) + 1 !== order.indexOf(level)) {
        return res.status(400).json({ error: `Pai ${parent.level} não aceita filho ${level}` });
      }
    } else if (level !== 'CATEGORY') {
      return res.status(400).json({ error: 'Apenas CATEGORY pode ser raiz (sem parentId)' });
    }
    const node = await prisma.categoryNode.create({
      data: { name: name.trim(), level, parentId: parentId || null, position: position || 0 },
    });
    res.json({ node });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar nó', detail: err.message });
  }
});

// PUT /:id — renomeia / move posição
router.put('/:id', async (req, res) => {
  try {
    const { name, position, notes, active } = req.body || {};
    const data = {};
    if (name != null) data.name = String(name).trim();
    if (position != null) data.position = parseInt(position, 10);
    if (notes !== undefined) data.notes = notes ? String(notes) : null;
    if (active != null) data.active = !!active;
    const node = await prisma.categoryNode.update({ where: { id: req.params.id }, data });
    res.json({ node });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar', detail: err.message });
  }
});

// DELETE /:id — remove (cascata em children)
router.delete('/:id', async (req, res) => {
  try {
    await prisma.categoryNode.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao deletar', detail: err.message });
  }
});

// GET /:id/products — produtos classificados nesse nó (ou candidatos)
router.get('/:id/products', async (req, res) => {
  try {
    const node = await prisma.categoryNode.findUnique({ where: { id: req.params.id } });
    if (!node) return res.status(404).json({ error: 'Nó não encontrado' });
    // Para cada nível, monta filtro diferente
    let where = { active: true };
    if (node.level === 'CATEGORY') {
      where.category = { equals: node.name, mode: 'insensitive' };
    } else if (node.level === 'SUBCATEGORY') {
      // Precisa achar o pai (categoria) também
      const parent = await prisma.categoryNode.findUnique({ where: { id: node.parentId } });
      where.AND = [
        parent ? { category: { equals: parent.name, mode: 'insensitive' } } : {},
        { subcategory: { equals: node.name, mode: 'insensitive' } },
      ];
    } else if (node.level === 'MODALITY') {
      where.AND = [{ aiContext: { path: ['classification', 'modality'], equals: node.name } }];
    } else if (node.level === 'SPECIALTY') {
      where.AND = [{ aiContext: { path: ['classification', 'tier'], equals: node.name } }];
    }
    const products = await prisma.product.findMany({
      where, select: { id: true, sku: true, name: true, brand: true, category: true, subcategory: true, aiContext: true, price: true },
      take: 1000,
      orderBy: { name: 'asc' },
    });
    res.json({ node, products });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar produtos', detail: err.message });
  }
});

function mapTypeFromCategory(catName) {
  if (catName === 'Tênis') return 'Tênis';
  if (catName === 'Chuteiras') return 'Chuteira';
  if (catName === 'Vestuário' || catName === 'Acessórios') return 'Outro';
  return null;
}

// POST /:id/assign-products — atribui esse nó (e ancestrais) a vários produtos
// Funciona em qualquer nível. Atualiza Product.category/subcategory ou
// aiContext.classification.modality/tier conforme o level.
//
// Body: { productIds:[], slot?:1|2, clear?:bool }
//  - slot 1 (default): classificação principal (Product.category/subcategory +
//    aiContext.classification) — comportamento original.
//  - slot 2: 2ª classificação opcional, guardada em aiContext.classification2
//    (NÃO mexe na 1ª nem em Product.category/subcategory). Vai pro Nuvemshop também.
//  - clear:true com slot 2 → remove a 2ª classificação.
router.post('/:id/assign-products', async (req, res) => {
  try {
    const { productIds, clear } = req.body || {};
    const slot = (req.body?.slot === 2 || req.body?.slot === '2') ? 2 : 1;
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds obrigatório' });

    // ---- Remover 2ª classificação ----
    if (slot === 2 && clear) {
      let cleared = 0;
      for (const pid of productIds) {
        const p = await prisma.product.findUnique({ where: { id: pid }, select: { aiContext: true } });
        if (!p) continue;
        const ctx = (typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext) || {};
        if (ctx.classification2) { delete ctx.classification2; await prisma.product.update({ where: { id: pid }, data: { aiContext: ctx } }); cleared++; }
      }
      scheduleNsSync(productIds);
      return res.json({ ok: true, updated: cleared, cleared: true, nuvemshop: 'queued' });
    }

    const node = await prisma.categoryNode.findUnique({ where: { id: req.params.id } });
    if (!node) return res.status(404).json({ error: 'Nó não encontrado' });
    // Constrói cadeia de ancestrais
    const chain = [];
    let cur = node;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? await prisma.categoryNode.findUnique({ where: { id: cur.parentId } }) : null;
    }
    const byLevel = Object.fromEntries(chain.map(c => [c.level, c.name]));
    // Aplica em batch — pra cada produto, faz update preservando aiContext
    let updated = 0;
    for (const pid of productIds) {
      const p = await prisma.product.findUnique({ where: { id: pid }, select: { aiContext: true } });
      if (!p) continue;
      const ctx = (typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext) || {};

      if (slot === 2) {
        // 2ª classificação — guarda cadeia completa em classification2 (não toca na 1ª)
        const c2 = {};
        if (byLevel.CATEGORY) { c2.category = byLevel.CATEGORY; const t = mapTypeFromCategory(byLevel.CATEGORY); if (t) c2.type = t; }
        if (byLevel.SUBCATEGORY) {
          c2.subcategory = byLevel.SUBCATEGORY;
          if (/^(Mulher|Feminino|Homem|Menina|Menino)$/i.test(byLevel.SUBCATEGORY)) c2.gender = byLevel.SUBCATEGORY;
        }
        if (byLevel.MODALITY) c2.modality = byLevel.MODALITY;
        if (byLevel.SPECIALTY) c2.tier = byLevel.SPECIALTY;
        c2.classifiedAt = new Date().toISOString();
        c2.editedBy = req.userId;
        ctx.classification2 = c2;
        await prisma.product.update({ where: { id: pid }, data: { aiContext: ctx } });
        updated++;
        continue;
      }

      // slot 1 — comportamento original
      ctx.classification = ctx.classification || {};
      const t = mapTypeFromCategory(byLevel.CATEGORY);
      if (t) ctx.classification.type = t;
      if (byLevel.SUBCATEGORY && /^(Mulher|Feminino|Homem|Menina|Menino)$/i.test(byLevel.SUBCATEGORY)) {
        ctx.classification.gender = byLevel.SUBCATEGORY;
      }
      if (byLevel.MODALITY) ctx.classification.modality = byLevel.MODALITY;
      if (byLevel.SPECIALTY) ctx.classification.tier = byLevel.SPECIALTY;
      await prisma.product.update({
        where: { id: pid },
        data: {
          ...(byLevel.CATEGORY ? { category: byLevel.CATEGORY } : {}),
          ...(byLevel.SUBCATEGORY ? { subcategory: byLevel.SUBCATEGORY } : {}),
          aiContext: ctx,
        },
      });
      updated++;
    }
    // Sync com Nuvemshop em background — não bloqueia resposta
    scheduleNsSync(productIds);
    res.json({ ok: true, updated, applied: byLevel, slot, nuvemshop: 'queued' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atribuir', detail: err.message });
  }
});

module.exports = router;
