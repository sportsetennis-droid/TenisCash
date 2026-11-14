// =====================================================================
// CENTRAL DE COMUNICAÇÃO (admin) — /api/admin/comms
// 3 empresas, cada uma com canais + CRM próprios (src/config/canais.js).
// =====================================================================
const express = require('express');
const { prisma, authMiddleware, adminMiddleware } = require('../middleware');
const { EMPRESAS, canalByInstance } = require('../config/canais');
const comms = require('../services/comms');
const crm = require('../services/crmContacts');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

function fail(res, e) { return res.status(e.status || 500).json({ error: e.message || 'erro' }); }

async function requireOwner(req, res) {
  const u = req.userId ? await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true, active: true } }) : null;
  if (!u || !u.active || u.role !== 'superadmin') { res.status(403).json({ error: 'Só o proprietário' }); return false; }
  return true;
}
async function actorName(req) {
  const u = req.userId ? await prisma.user.findUnique({ where: { id: req.userId }, select: { name: true } }).catch(() => null) : null;
  return u ? u.name : 'admin';
}

router.get('/overview', async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await comms.overview()); } catch (e) { fail(res, e); }
});

// Cria (se faltar) o número na Evolution e devolve o QR pra ler no celular da loja.
router.post('/canais/:instance/conectar', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!(await requireOwner(req, res))) return;
    res.json(await comms.connectCanal(req.params.instance));
  } catch (e) { fail(res, e); }
});

router.post('/canais/:instance/pergunta-nome', async (req, res) => {
  try {
    if (!canalByInstance(req.params.instance)) return res.status(404).json({ error: 'Canal desconhecido' });
    await crm.setAskEnabled(req.params.instance, !!(req.body && req.body.on));
    res.json({ ok: true, instance: req.params.instance, perguntaNome: !!(req.body && req.body.on) });
  } catch (e) { fail(res, e); }
});

router.get('/contatos', async (req, res) => {
  try {
    const empresa = String(req.query.empresa || '');
    if (!EMPRESAS[empresa]) return res.status(400).json({ error: 'empresa inválida (st | baratao | metafard)' });
    const q = String(req.query.q || '').trim();
    const canal = String(req.query.canal || '').trim();
    const take = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const skip = Math.max(0, Number(req.query.offset) || 0);
    const where = { empresa };
    if (canal) where.OR = [{ firstChannel: canal }, { lastChannel: canal }];
    if (req.query.semNome === '1') where.name = null;
    if (q) {
      const digits = q.replace(/\D/g, '');
      const or = [{ name: { contains: q, mode: 'insensitive' } }, { profileName: { contains: q, mode: 'insensitive' } }, { instagram: { contains: q.replace(/^@/, ''), mode: 'insensitive' } }];
      if (digits.length >= 4) or.push({ phone: { contains: digits } });
      where.AND = [{ OR: or }];
    }
    const [total, rows] = await Promise.all([
      prisma.crmContact.count({ where }),
      prisma.crmContact.findMany({ where, orderBy: { lastSeenAt: 'desc' }, take, skip }),
    ]);
    res.set('Cache-Control', 'no-store').json({ total, contatos: rows.map((r) => ({ ...r, pendingText: undefined })) });
  } catch (e) { fail(res, e); }
});

router.patch('/contatos/:id', async (req, res) => {
  try {
    const data = {};
    if (typeof req.body.name === 'string') {
      const n = req.body.name.replace(/\s+/g, ' ').trim().slice(0, 80);
      Object.assign(data, n ? { name: n, nameSource: 'manual', nameState: 'ok' } : { name: null, nameSource: null, nameState: null });
    }
    if (typeof req.body.notes === 'string') data.notes = req.body.notes.slice(0, 4000);
    const r = await prisma.crmContact.update({ where: { id: req.params.id }, data });
    res.json({ ok: true, contato: r });
  } catch (e) { fail(res, e); }
});

// Mensagem de um canal pra outro canal da MESMA empresa (ou pra um telefone).
router.post('/enviar', async (req, res) => {
  try {
    const { from, to, text } = req.body || {};
    res.json(await comms.sendFromCanal({ from, to, text, actor: await actorName(req) }));
  } catch (e) { fail(res, e); }
});

router.post('/repassar', async (req, res) => {
  try {
    const { from, to, contatoId, nota } = req.body || {};
    res.json(await comms.repassarCliente({ from, to, contactId: contatoId, nota, actor: await actorName(req) }));
  } catch (e) { fail(res, e); }
});

router.post('/instagram/ativar', async (req, res) => {
  try {
    if (!(await requireOwner(req, res))) return;
    res.json(await require('../services/igWebhookSetup').activateInstagramWebhook());
  } catch (e) { fail(res, e); }
});

module.exports = router;
