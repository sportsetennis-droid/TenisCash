// =====================================================================
// Routes: /api/admin/imagens-site — Orquestrador "IMAGENS DE SITE".
// Dispara a esteira e transmite o trabalho dos agentes ao vivo (SSE),
// pra o dono ver acontecendo em /imagens-site.html.
// =====================================================================
const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const bus = require('../services/imagensSite/bus');
const orchestrator = require('../services/imagensSite/orchestrator');
const { CFG_KEY: SLOTS_KEY } = require('../services/imagensSite/agents/mapper');

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

let running = false;

// SSE ao vivo. EventSource não manda header → token vem por ?token= (authMiddleware aceita).
router.get('/stream', (req, res) => { bus.openSse(req, res); });

// Dispara a esteira (não bloqueia; o progresso sai todo pelo /stream).
router.post('/run', async (req, res) => {
  if (running) return res.status(409).json({ error: 'já tem uma rodada em andamento' });
  const genders = Array.isArray(req.body?.genders) && req.body.genders.length
    ? req.body.genders.filter((g) => ['feminino', 'masculino'].includes(g))
    : null;
  running = true;
  bus.reset();
  res.status(202).json({ started: true, genders: genders || ['feminino', 'masculino'] });
  // fire-and-forget — tudo é emitido via SSE
  orchestrator.run({ prisma, emit: bus.emit, genders })
    .catch((e) => bus.emit({ phase: 'done', agent: 'orquestrador', level: 'err', msg: 'Erro: ' + e.message }))
    .finally(() => { running = false; });
});

// Estado atual: plano salvo + mapa + histórico de eventos da rodada em memória.
router.get('/state', async (_req, res) => {
  try {
    const get = async (k) => {
      const r = await prisma.config.findUnique({ where: { key: k } });
      return r?.value ? JSON.parse(r.value) : null;
    };
    const [plan, slots] = await Promise.all([get(orchestrator.PLAN_KEY), get(SLOTS_KEY)]);
    res.json({ running, plan, slots, events: bus.snapshot() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
