// =====================================================================
// MODULO SEGURANCA — painel do dono pra ver as maquinas das lojas,
// acompanhar a gravacao do caixa e comandar tudo (sem AnyDesk, sem terminal).
// Protegido por authMiddleware + adminMiddleware (SO o dono).
// =====================================================================
const express = require('express');
const router = express.Router();
const path = require('node:path');
const fs = require('node:fs');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

router.use(authMiddleware, adminMiddleware);

const CAP_DIR = path.join(process.cwd(), 'captures');
const CMD_TYPES = ['restart-agent', 'update-agent', 'update-supervisor', 'tailscale-up', 'funnel-up', 'get-health', 'get-log', 'capture-list', 'capture-pull', 'ping'];

// Estado de TODAS as maquinas (heartbeat dos Supervisores).
router.get('/machines', async (req, res) => {
  try {
    const hbs = await prisma.machineHeartbeat.findMany({ orderBy: { storeCode: 'asc' } });
    const now = Date.now();
    res.json({
      machines: hbs.map((h) => {
        const ageSec = Math.round((now - new Date(h.lastSeen).getTime()) / 1000);
        return {
          store: h.storeCode, hostname: h.hostname || null,
          agentHealthy: !!h.agentHealthy, agentVersion: h.agentVersion || null,
          supervisorVersion: h.supervisorVersion || null,
          lastSeen: h.lastSeen, ageSec, online: ageSec <= 180,
        };
      }),
    });
  } catch (err) { console.error('[security/machines]', err); res.status(500).json({ error: err.message }); }
});

// Enfileira um comando pra maquina (o Supervisor pega no proximo poll).
router.post('/cmd', async (req, res) => {
  try {
    const store = String(req.body?.store || '').toUpperCase();
    const type = String(req.body?.type || '');
    const name = req.body?.name;
    if (!store || !CMD_TYPES.includes(type)) return res.status(400).json({ error: 'store/type inválido' });
    const c = await prisma.agentCommand.create({ data: { storeCode: store, type, args: (type === 'capture-pull' && name) ? { name } : undefined, createdBy: 'security-ui' } });
    res.json({ id: c.id });
  } catch (err) { console.error('[security/cmd]', err); res.status(500).json({ error: err.message }); }
});

// Resultado de um comando (a UI faz polling).
router.get('/cmd/:id', async (req, res) => {
  try {
    const c = await prisma.agentCommand.findUnique({ where: { id: String(req.params.id) } });
    if (!c) return res.status(404).json({ error: 'não achado' });
    res.json({ id: c.id, store: c.storeCode, type: c.type, status: c.status, result: c.result, updatedAt: c.updatedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Capturas JA puxadas pro central de uma loja (as que o dono ja viu).
router.get('/captures/:store', (req, res) => {
  const dir = path.join(CAP_DIR, path.basename(String(req.params.store)));
  res.json({ files: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort() : [] });
});

// Serve a imagem (a UI busca via fetch com o Bearer e mostra como blob).
router.get('/capture/:store/:name', (req, res) => {
  const full = path.join(CAP_DIR, path.basename(String(req.params.store)), path.basename(String(req.params.name)));
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'não achado' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(fs.readFileSync(full));
});

module.exports = router;
