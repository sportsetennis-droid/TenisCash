// =====================================================================
// API da REDE NEURAL DE AGENTES — /api/admin/rede (só admin/dono)
// Painel, rastros (trace), propostas (decidir/executar → aprendizado),
// objetivos, mini agentes (ligar/desligar/limiar), poda e "ao vivo" (SSE).
// =====================================================================
const express = require('express');
const { prisma, authMiddleware, adminMiddleware } = require('../middleware');
const rede = require('../ai/rede');
const acoes = require('../ai/rede/acoes');
const { decideApproval } = require('../ai/approvals/approval.service');

const router = express.Router();
router.use(authMiddleware, adminMiddleware);
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error('[rede]', req.method, req.originalUrl, e.message);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro na rede de agentes.' });
  }
};
const noStore = (res) => res.set('Cache-Control', 'no-store');

router.get('/painel', wrap(async (req, res) => {
  noStore(res);
  const { motor, aprendizado } = rede;
  const [linhas, gasto, objetivos, pendentes, ultimas, poda] = await Promise.all([
    prisma.rnaNeuronio.findMany({ orderBy: { id: 'asc' } }),
    motor.gastoHoje(),
    prisma.rnaObjetivo.findMany({ where: { status: { in: ['ativo', 'pausado'] } }, orderBy: { criadoEm: 'desc' } }),
    prisma.aIApproval.count({ where: { type: { startsWith: 'rna_' }, status: 'pending' } }),
    prisma.rnaAtivacao.findMany({ orderBy: { criadoEm: 'desc' }, take: 40 }),
    aprendizado.candidatosPoda(),
  ]);
  const meta = motor.estado.neuronios;
  res.json({
    ativa: process.env.RNA_ATIVA !== '0',
    tetoDiaRS: Number(process.env.RNA_ORCAMENTO_DIA_RS || 5),
    gastoHojeRS: gasto,
    pendentes,
    errosRegistro: motor.estado.errosRegistro,
    neuronios: linhas.map((l) => { const n = meta.get(l.id) || {}; return Object.assign({}, l, { missao: n.missao || '(neurônio não carregado)', custo: n.custo && n.custo.tipo, permissao: n.permissao, escuta: n.escuta, emite: n.emite, dominio: l.id.split('.')[0] }); }),
    objetivos,
    ultimas,
    poda,
    acoes: acoes.listar(),
  });
}));

// Rastros recentes (um por evento de origem)
router.get('/traces', wrap(async (req, res) => {
  noStore(res);
  const lim = Math.min(Number(req.query.limit) || 40, 200);
  const raizes = await prisma.rnaSinal.findMany({ where: { profundidade: 0 }, orderBy: { criadoEm: 'desc' }, take: lim });
  const ids = raizes.map((r) => r.traceId);
  const [cont, ativ] = await Promise.all([
    prisma.rnaSinal.groupBy({ by: ['traceId'], where: { traceId: { in: ids } }, _count: { _all: true } }),
    prisma.rnaAtivacao.groupBy({ by: ['traceId'], where: { traceId: { in: ids } }, _count: { _all: true }, _sum: { custoRS: true } }),
  ]);
  const c = Object.fromEntries(cont.map((x) => [x.traceId, x._count._all]));
  const a = Object.fromEntries(ativ.map((x) => [x.traceId, x]));
  res.json({ traces: raizes.map((r) => ({ traceId: r.traceId, tipo: r.tipo, origem: r.origem, loja: r.loja, em: r.criadoEm, sinais: c[r.traceId] || 1, ativacoes: a[r.traceId] ? a[r.traceId]._count._all : 0, custoRS: a[r.traceId] ? a[r.traceId]._sum.custoRS || 0 : 0 })) });
}));

router.get('/traces/:traceId', wrap(async (req, res) => {
  noStore(res);
  const traceId = String(req.params.traceId);
  const [sinais, ativacoes, propostas] = await Promise.all([
    prisma.rnaSinal.findMany({ where: { traceId }, orderBy: { criadoEm: 'asc' } }),
    prisma.rnaAtivacao.findMany({ where: { traceId }, orderBy: { criadoEm: 'asc' } }),
    prisma.aIApproval.findMany({ where: { type: { startsWith: 'rna_' }, payload: { path: ['rna', 'traceId'], equals: traceId } } }),
  ]);
  if (!sinais.length) return res.status(404).json({ error: 'Rastro não encontrado' });
  res.json({ traceId, sinais, ativacoes, propostas });
}));

router.get('/propostas', wrap(async (req, res) => {
  noStore(res);
  const status = String(req.query.status || 'pending');
  const lista = await prisma.aIApproval.findMany({ where: { type: { startsWith: 'rna_' }, ...(status === 'todas' ? {} : { status }) }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ propostas: lista });
}));

// Decisão do dono → aprendizado (pesos/limiares) — registro auditado.
router.post('/propostas/:id/decisao', wrap(async (req, res) => {
  const { decisao, nota } = req.body || {};
  if (!['approved', 'rejected', 'correction_requested'].includes(decisao)) return res.status(400).json({ error: 'decisao: approved | rejected | correction_requested' });
  const ap = await prisma.aIApproval.findUnique({ where: { id: req.params.id } });
  if (!ap || !ap.type.startsWith('rna_')) return res.status(404).json({ error: 'Proposta da rede não encontrada' });
  if (ap.status !== 'pending') return res.status(409).json({ error: 'Proposta já decidida (' + ap.status + ')' });
  const atualizada = await decideApproval({ approvalId: ap.id, decision: decisao, note: nota || null, approvedById: req.userId });
  const aprendizagem = await rede.aprendizado.aoDecidir(atualizada).catch((e) => ({ erro: e.message }));
  res.json({ proposta: atualizada, aprendizagem });
}));

router.post('/propostas/:id/executar', wrap(async (req, res) => {
  res.json(await acoes.executar(req.params.id, { executadoPor: req.userId }));
}));

// Mini agentes: ligar/desligar e ajustar limiar (auditado)
router.patch('/neuronios/:id', wrap(async (req, res) => {
  const id = String(req.params.id);
  const n = await prisma.rnaNeuronio.findUnique({ where: { id } });
  if (!n) return res.status(404).json({ error: 'Mini agente não encontrado' });
  const data = {};
  if (typeof req.body.ativo === 'boolean') data.ativo = req.body.ativo;
  if (req.body.limiar != null) {
    const l = Number(req.body.limiar);
    if (!(l >= 0 && l <= 0.95)) return res.status(400).json({ error: 'limiar entre 0 e 0.95' });
    data.limiar = l;
    await prisma.rnaAjustePeso.create({ data: { alvo: 'limiar:' + id, de: n.limiar, para: l, motivo: 'manual' } });
  }
  const up = await prisma.rnaNeuronio.update({ where: { id }, data });
  rede.motor.invalidarCaches();
  res.json({ neuronio: up });
}));

// Objetivos
router.get('/objetivos', wrap(async (req, res) => {
  noStore(res);
  res.json({ objetivos: await prisma.rnaObjetivo.findMany({ orderBy: { criadoEm: 'desc' }, take: 50 }) });
}));
router.post('/objetivos/compilar', wrap(async (req, res) => {
  const texto = String((req.body && req.body.texto) || '').trim();
  if (texto.length < 8) return res.status(400).json({ error: 'Descreva o objetivo.' });
  res.json({ rascunho: await rede.objetivos.compilar(texto) });
}));
router.post('/objetivos', wrap(async (req, res) => {
  const b = req.body || {};
  const o = await rede.objetivos.criar(Object.assign({}, b, { criadoPor: req.userId }));
  rede.emitir({ tipo: 'relogio.objetivo', origem: 's.relogio', forca: 0.8, objetivoId: o.id, loja: o.loja, dados: { objetivoId: o.id, texto: o.texto, kpis: o.kpis, regiao: o.regiao } });
  res.status(201).json({ objetivo: o });
}));
router.patch('/objetivos/:id', wrap(async (req, res) => {
  res.json({ objetivo: await rede.objetivos.definirStatus(req.params.id, String((req.body || {}).status)) });
}));

// Sinal manual (pergunta do dono ou teste de um sensor)
router.post('/sinais', wrap(async (req, res) => {
  const { tipo, dados } = req.body || {};
  if (!rede.SENSORES[tipo]) return res.status(400).json({ error: 'Tipo de sensor desconhecido', validos: Object.keys(rede.SENSORES) });
  const s = await rede.emitir(Object.assign({ tipo, dados: Object.assign({}, dados || {}, tipo === 'dono.pergunta' ? { userId: req.userId } : {}) }, rede.SENSORES[tipo]));
  res.status(202).json({ traceId: s && s.traceId, sinalId: s && s.id });
}));

// ---------------------------------------------------------------------
// GERENTE DE MARCA — um por marca (mini agente marca.gerente). O relatório
// diário de cada marca fica em RnaSinal tipo 'marca.relatorio'.
// ---------------------------------------------------------------------
const { chave: chaveMarca, ficha: fichaMarca } = require('../ai/rede/regras/marcas');

async function ultimosRelatorios(dias = 3) {
  const desde = new Date(Date.now() - dias * 86400000);
  const linhas = await prisma.rnaSinal.findMany({ where: { tipo: 'marca.relatorio', criadoEm: { gte: desde } }, orderBy: { criadoEm: 'desc' }, take: 2000 });
  const porMarca = new Map();
  for (const l of linhas) { const m = l.dados && l.dados.marca; if (m && !porMarca.has(m)) porMarca.set(m, l); }
  return porMarca;
}

// Propostas pendentes da rede, agrupadas pela marca do produto (sinal de origem → dados.marca ou productId).
async function propostasPorMarca() {
  const aps = await prisma.aIApproval.findMany({ where: { type: { startsWith: 'rna_' }, status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 500 });
  const sinalIds = aps.map((a) => a.payload && a.payload.rna && a.payload.rna.sinalId).filter(Boolean);
  const sinais = sinalIds.length ? await prisma.rnaSinal.findMany({ where: { id: { in: sinalIds } }, select: { id: true, dados: true } }) : [];
  const S = new Map(sinais.map((s) => [s.id, s.dados || {}]));
  const pids = [...new Set(sinais.map((s) => (s.dados || {}).productId).filter(Boolean))];
  const prods = pids.length ? await prisma.product.findMany({ where: { id: { in: pids } }, select: { id: true, brand: true } }) : [];
  const B = new Map(prods.map((p) => [p.id, p.brand]));
  const out = new Map();
  for (const a of aps) {
    const d = S.get(a.payload && a.payload.rna && a.payload.rna.sinalId) || {};
    const k = chaveMarca(d.marca || B.get(d.productId));
    if (!k) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ id: a.id, tipo: a.type, titulo: a.title, risco: a.riskLevel, criadoEm: a.createdAt });
  }
  return out;
}

router.get('/marcas', wrap(async (req, res) => {
  noStore(res);
  const [rel, props] = await Promise.all([ultimosRelatorios(), propostasPorMarca()]);
  const marcas = [...rel.values()].map((l) => {
    const d = l.dados;
    return {
      marca: d.marca, atencao: d.atencao, geradoEm: d.geradoEm || l.criadoEm, cards: d.cards, cardsComEstoque: d.cardsComEstoque,
      comprado: d.comprado, localizado: d.localizado, vendas30: d.vendas && d.vendas.d30, vendas7: d.vendas && d.vendas.d7,
      coberturaDias: d.coberturaDias, alertas: (d.alertas || []).length, alertaPrincipal: (d.alertas || [])[0] || null,
      propostasPendentes: (props.get(d.marca) || []).length, temFicha: !!d.ficha,
    };
  }).sort((a, b) => b.atencao - a.atencao || ((b.vendas30 && b.vendas30.rs) || 0) - ((a.vendas30 && a.vendas30.rs) || 0));
  res.json({ total: marcas.length, ultimaGeracao: marcas.reduce((m, x) => (!m || x.geradoEm > m ? x.geradoEm : m), null), marcas });
}));

router.get('/marcas/:marca', wrap(async (req, res) => {
  noStore(res);
  const k = chaveMarca(req.params.marca);
  if (!k) return res.status(400).json({ error: 'Marca inválida.' });
  const hist = await prisma.rnaSinal.findMany({ where: { tipo: 'marca.relatorio', dados: { path: ['marca'], equals: k } }, orderBy: { criadoEm: 'desc' }, take: 30 });
  const props = await propostasPorMarca();
  res.json({
    marca: k,
    ficha: fichaMarca(k),
    relatorio: hist[0] ? hist[0].dados : null,
    historico: hist.map((h) => ({ em: h.criadoEm, atencao: h.dados.atencao, localizado: h.dados.localizado, vendas30: h.dados.vendas && h.dados.vendas.d30 && h.dados.vendas.d30.un, parados: h.dados.parados && h.dados.parados.cards })),
    propostas: props.get(k) || [],
  });
}));

router.post('/marcas/:marca/atualizar', wrap(async (req, res) => {
  const k = chaveMarca(req.params.marca);
  if (!k) return res.status(400).json({ error: 'Marca inválida.' });
  const s = await rede.emitir(Object.assign({ tipo: 'marca.pedir', dados: { marca: k, userId: req.userId } }, rede.SENSORES['marca.pedir']));
  res.status(202).json({ marca: k, traceId: s && s.traceId, aviso: s ? null : 'Rede desligada (RNA_ATIVA=0) — nada foi gerado.' });
}));

// Ao vivo: a rede pensando (Server-Sent Events)
router.get('/ao-vivo', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders && res.flushHeaders();
  const enviar = (ev) => {
    const s = ev.sinal || {};
    res.write('data: ' + JSON.stringify({ evento: ev.evento, neuronio: ev.neuronio || null, status: ev.status || null, tipo: s.tipo || null, origem: s.origem || null, traceId: s.traceId || null, em: Date.now() }) + '\n\n'); if (res.flush) res.flush();
  };
  const parar = rede.motor.ouvir((ev) => { if (ev.evento !== 'ocioso?') enviar(ev); });
  const ping = setInterval(() => { res.write(': ping\n\n'); if (res.flush) res.flush(); }, 25000);
  req.on('close', () => { parar(); clearInterval(ping); });
});

module.exports = router;
