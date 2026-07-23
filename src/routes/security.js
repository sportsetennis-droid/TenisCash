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
const cameraLiveCache = require('../services/cameraLiveCache');

router.use(authMiddleware, adminMiddleware);

const CAP_DIR = path.join(process.cwd(), 'captures');
const CAMERA_ARCHIVE_DIR = process.env.CAMERA_ARCHIVE_DIR || (process.platform === 'win32'
  ? path.join(process.cwd(), 'data', 'camera-recordings')
  : '/data/camera-recordings');
const CAMERA_LIVE_DIR = process.env.CAMERA_LIVE_DIR || (process.platform === 'win32'
  ? path.join(process.cwd(), 'data', 'camera-live')
  : '/data/camera-live');
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

function cameraArchiveFiles(dir, limit = 1000) {
  const files = [];
  function walk(current) {
    if (files.length >= limit || !fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.mp4')) {
        const stat = fs.statSync(full);
        files.push({ name: entry.name, size: stat.size, createdAt: stat.mtime.toISOString() });
      }
      if (files.length >= limit) break;
    }
  }
  walk(dir);
  return files;
}

router.get('/camera-recordings/:store/:camera', (req, res) => {
  const store = String(req.params.store || '').toUpperCase();
  const camera = String(req.params.camera || '').toLowerCase();
  if (!/^LOJA\d{2}$/.test(store) || !/^loja\d{2}_camera\d+$/.test(camera) || !camera.startsWith(store.toLowerCase() + '_camera')) {
    return res.status(400).json({ error: 'loja/câmera inválida' });
  }
  const dir = path.join(CAMERA_ARCHIVE_DIR, store, camera);
  const files = cameraArchiveFiles(dir, 500).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ store, camera, files, totalBytes: files.reduce((sum, item) => sum + item.size, 0) });
});

router.get('/camera-recording/:store/:camera/:name', (req, res) => {
  const store = String(req.params.store || '').toUpperCase();
  const camera = String(req.params.camera || '').toLowerCase();
  const name = path.basename(String(req.params.name || '')).replace(/[^A-Za-z0-9._-]/g, '');
  if (!/^LOJA\d{2}$/.test(store) || !/^loja\d{2}_camera\d+$/.test(camera) || !camera.startsWith(store.toLowerCase() + '_camera') || !name.endsWith('.mp4')) {
    return res.status(400).json({ error: 'arquivo inválido' });
  }
  const full = path.join(CAMERA_ARCHIVE_DIR, store, camera, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'gravação não encontrada' });
  const stat = fs.statSync(full);
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'video/mp4');
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(full).pipe(res);
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) return res.status(416).end();
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) return res.status(416).end();
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(full, { start, end }).pipe(res);
});

router.get('/camera-live/:store/:camera/:name', (req, res) => {
  const store = String(req.params.store || '').toUpperCase();
  const camera = String(req.params.camera || '').toLowerCase();
  const name = path.basename(String(req.params.name || '')).replace(/[^A-Za-z0-9._-]/g, '');
  if (!/^LOJA\d{2}$/.test(store) || !/^loja\d{2}_camera\d+$/.test(camera) || !camera.startsWith(store.toLowerCase() + '_camera')) {
    return res.status(400).json({ error: 'loja/câmera inválida' });
  }
  if (!/^(?:index\.m3u8|[A-Fa-f0-9]+_video\d+_(?:init|seg\d+)\.mp4)$/.test(name)) return res.status(400).json({ error: 'arquivo HLS inválido' });
  const full = path.join(CAMERA_LIVE_DIR, store, camera, name);
  const cached = name.endsWith('.mp4') ? cameraLiveCache.get(store, camera, name) : null;
  if (!cached && !fs.existsSync(full)) return res.status(404).json({ error: 'transmissão ainda não disponível' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
  if (cached) {
    res.setHeader('Content-Length', cached.length);
    return res.end(cached);
  }
  res.setHeader('Content-Length', fs.statSync(full).size);
  fs.createReadStream(full).pipe(res);
});

module.exports = router;
