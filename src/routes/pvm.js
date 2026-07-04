// =====================================================================
// Routes: /api/admin/pvm — Sistema PVM (Padrão, Validação e Monitoramento)
// Ciclo: definir padrão → testar pequeno → medir → corrigir → padronizar
// → repetir, por área da loja. Ficha PVM = unidade de teste; Padrão =
// manual de padrões oficiais (o que virou regra depois de validado).
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

const AREAS = ['atendimento', 'ambiente', 'produto', 'preco', 'vitrine', 'comunicacao', 'posvenda', 'experiencia', 'outro'];
const STATUSES = ['planejada', 'testando', 'concluida'];
const DECISOES = ['manter', 'melhorar', 'cortar'];
const CATEGORIAS_PADRAO = ['atendimento', 'visual', 'exposicao', 'som_ambiente', 'whatsapp', 'posvenda', 'outro'];

async function creatorInfo(req) {
  if (!req.userId) return { createdBy: null, createdByName: null };
  const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { name: true } });
  return { createdBy: req.userId, createdByName: u ? u.name : null };
}

// =====================================================================
// META — lojas + constantes, pros seletores
// =====================================================================
router.get('/meta', async (req, res) => {
  try {
    const stores = await prisma.store.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } });
    res.json({ stores, areas: AREAS, statuses: STATUSES, decisoes: DECISOES, categoriasPadrao: CATEGORIAS_PADRAO });
  } catch (err) { console.error('[pvm/meta]', err); res.status(500).json({ error: err.message }); }
});

// =====================================================================
// RESUMO — contadores pro painel
// =====================================================================
router.get('/resumo', async (req, res) => {
  try {
    const [porStatus, porDecisao, diarioSemana] = await Promise.all([
      prisma.pvmFicha.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.pvmFicha.groupBy({ by: ['decisao'], _count: { _all: true }, where: { decisao: { not: null } } }),
      prisma.pvmDiario.count({ where: { date: { gte: new Date(Date.now() - 7 * 86400000) } } }),
    ]);
    res.json({ porStatus, porDecisao, diarioSemana });
  } catch (err) { console.error('[pvm/resumo]', err); res.status(500).json({ error: err.message }); }
});

// =====================================================================
// FICHAS PVM — CRUD
// =====================================================================
router.get('/fichas', async (req, res) => {
  try {
    const { area, status, storeId, decisao } = req.query;
    const where = {
      ...(area ? { area } : {}),
      ...(status ? { status } : {}),
      ...(storeId ? { storeId } : {}),
      ...(decisao ? { decisao } : {}),
    };
    const fichas = await prisma.pvmFicha.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
    res.json({ fichas });
  } catch (err) { console.error('[pvm/fichas:list]', err); res.status(500).json({ error: err.message }); }
});

router.post('/fichas', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.problema || !b.hipotese || !b.padraoNovo) {
      return res.status(400).json({ error: 'problema, hipotese e padraoNovo são obrigatórios' });
    }
    const area = AREAS.includes(b.area) ? b.area : 'outro';
    let storeCode = null;
    if (b.storeId) {
      const store = await prisma.store.findUnique({ where: { id: b.storeId }, select: { code: true } });
      storeCode = store ? store.code : null;
    }
    const ficha = await prisma.pvmFicha.create({
      data: {
        area,
        problema: String(b.problema).trim(),
        hipotese: String(b.hipotese).trim(),
        padraoNovo: String(b.padraoNovo).trim(),
        storeId: b.storeId || null,
        storeCode,
        testeInicio: b.testeInicio ? new Date(String(b.testeInicio) + 'T12:00:00Z') : null,
        testeFim: b.testeFim ? new Date(String(b.testeFim) + 'T12:00:00Z') : null,
        indicadores: Array.isArray(b.indicadores) ? b.indicadores : [],
        metaMinima: b.metaMinima || null,
        status: STATUSES.includes(b.status) ? b.status : 'planejada',
        ...(await creatorInfo(req)),
      },
    });
    res.json({ ficha });
  } catch (err) { console.error('[pvm/fichas:create]', err); res.status(500).json({ error: err.message }); }
});

router.put('/fichas/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    if (b.area !== undefined) data.area = AREAS.includes(b.area) ? b.area : 'outro';
    if (b.problema !== undefined) data.problema = String(b.problema).trim();
    if (b.hipotese !== undefined) data.hipotese = String(b.hipotese).trim();
    if (b.padraoNovo !== undefined) data.padraoNovo = String(b.padraoNovo).trim();
    if (b.storeId !== undefined) {
      data.storeId = b.storeId || null;
      if (b.storeId) {
        const store = await prisma.store.findUnique({ where: { id: b.storeId }, select: { code: true } });
        data.storeCode = store ? store.code : null;
      } else data.storeCode = null;
    }
    if (b.testeInicio !== undefined) data.testeInicio = b.testeInicio ? new Date(String(b.testeInicio) + 'T12:00:00Z') : null;
    if (b.testeFim !== undefined) data.testeFim = b.testeFim ? new Date(String(b.testeFim) + 'T12:00:00Z') : null;
    if (b.indicadores !== undefined) data.indicadores = Array.isArray(b.indicadores) ? b.indicadores : [];
    if (b.metaMinima !== undefined) data.metaMinima = b.metaMinima || null;
    if (b.resultado !== undefined) data.resultado = b.resultado || null;
    if (b.decisao !== undefined) data.decisao = DECISOES.includes(b.decisao) ? b.decisao : null;
    if (b.status !== undefined) data.status = STATUSES.includes(b.status) ? b.status : 'planejada';
    const ficha = await prisma.pvmFicha.update({ where: { id: req.params.id }, data });
    res.json({ ficha });
  } catch (err) { console.error('[pvm/fichas:update]', err); res.status(500).json({ error: err.message }); }
});

router.delete('/fichas/:id', async (req, res) => {
  try {
    await prisma.pvmFicha.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { console.error('[pvm/fichas:delete]', err); res.status(500).json({ error: err.message }); }
});

// Promove a ficha (decisão=manter) a padrão oficial no Manual de Padrões.
router.post('/fichas/:id/promover', async (req, res) => {
  try {
    const ficha = await prisma.pvmFicha.findUnique({ where: { id: req.params.id } });
    if (!ficha) return res.status(404).json({ error: 'ficha não encontrada' });
    if (ficha.decisao !== 'manter') return res.status(400).json({ error: 'só promove ficha com decisão "manter"' });
    const b = req.body || {};
    const categoria = CATEGORIAS_PADRAO.includes(b.categoria) ? b.categoria : 'outro';
    const padrao = await prisma.pvmPadrao.create({
      data: {
        categoria,
        titulo: b.titulo || ficha.padraoNovo,
        descricao: b.descricao || `${ficha.padraoNovo}\n\n(origem: ${ficha.problema})`,
        fichaId: ficha.id,
      },
    });
    res.json({ padrao });
  } catch (err) { console.error('[pvm/fichas:promover]', err); res.status(500).json({ error: err.message }); }
});

// =====================================================================
// DIÁRIO — rotina diária de 10 minutos
// =====================================================================
router.get('/diario', async (req, res) => {
  try {
    const { from, to, storeId } = req.query;
    const where = { ...(storeId ? { storeId } : {}) };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(String(from) + 'T00:00:00Z');
      if (to) where.date.lte = new Date(String(to) + 'T23:59:59Z');
    }
    const registros = await prisma.pvmDiario.findMany({ where, orderBy: { date: 'desc' }, take: 200 });
    res.json({ registros });
  } catch (err) { console.error('[pvm/diario:list]', err); res.status(500).json({ error: err.message }); }
});

router.post('/diario', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.date) return res.status(400).json({ error: 'date é obrigatório' });
    let storeCode = null;
    if (b.storeId) {
      const store = await prisma.store.findUnique({ where: { id: b.storeId }, select: { code: true } });
      storeCode = store ? store.code : null;
    }
    const registro = await prisma.pvmDiario.create({
      data: {
        date: new Date(String(b.date) + 'T12:00:00Z'),
        storeId: b.storeId || null,
        storeCode,
        vendas: b.vendas !== undefined && b.vendas !== '' ? Number(b.vendas) : null,
        clientesAprox: b.clientesAprox !== undefined && b.clientesAprox !== '' ? parseInt(b.clientesAprox, 10) : null,
        produtoMaisProcurado: b.produtoMaisProcurado || null,
        principalReclamacao: b.principalReclamacao || null,
        motivoNaoCompra: b.motivoNaoCompra || null,
        algoQueFuncionou: b.algoQueFuncionou || null,
        ...(await creatorInfo(req)),
      },
    });
    res.json({ registro });
  } catch (err) { console.error('[pvm/diario:create]', err); res.status(500).json({ error: err.message }); }
});

router.delete('/diario/:id', async (req, res) => {
  try {
    await prisma.pvmDiario.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { console.error('[pvm/diario:delete]', err); res.status(500).json({ error: err.message }); }
});

// =====================================================================
// MANUAL DE PADRÕES — o que virou regra oficial
// =====================================================================
router.get('/padroes', async (req, res) => {
  try {
    const { categoria, active } = req.query;
    const where = {
      ...(categoria ? { categoria } : {}),
      ...(active !== undefined ? { active: active === 'true' } : {}),
    };
    const padroes = await prisma.pvmPadrao.findMany({ where, orderBy: [{ categoria: 'asc' }, { createdAt: 'desc' }] });
    res.json({ padroes });
  } catch (err) { console.error('[pvm/padroes:list]', err); res.status(500).json({ error: err.message }); }
});

router.put('/padroes/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    if (b.categoria !== undefined) data.categoria = CATEGORIAS_PADRAO.includes(b.categoria) ? b.categoria : 'outro';
    if (b.titulo !== undefined) data.titulo = String(b.titulo).trim();
    if (b.descricao !== undefined) data.descricao = String(b.descricao).trim();
    if (b.active !== undefined) data.active = !!b.active;
    const padrao = await prisma.pvmPadrao.update({ where: { id: req.params.id }, data });
    res.json({ padrao });
  } catch (err) { console.error('[pvm/padroes:update]', err); res.status(500).json({ error: err.message }); }
});

router.delete('/padroes/:id', async (req, res) => {
  try {
    await prisma.pvmPadrao.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { console.error('[pvm/padroes:delete]', err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
