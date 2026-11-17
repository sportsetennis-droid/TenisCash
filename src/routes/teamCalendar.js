// Calendário da equipe (.ics por vendedor).
//   GET  /api/team-calendar/my-link         → { url, webcal } (vendedor logado; cria se não existir)
//   POST /api/team-calendar/my-link/rotate  → novo link (o antigo para de funcionar)
//   GET  /api/team-calendar/feed/<token>.ics → feed iCalendar (sem login: o token é o acesso)
const express = require('express');
const { authMiddleware, prisma } = require('../middleware');
const { publicBaseUrl } = require('../config/publicUrl');
const teamCalendar = require('../services/teamCalendar');

const router = express.Router();

function requireSeller(req, res, next) {
  if (req.userRole !== 'seller') return res.status(403).json({ error: 'Acesso restrito ao vendedor.' });
  next();
}

function linkPayload(token) {
  const url = `${publicBaseUrl()}/api/team-calendar/feed/${token}.ics`;
  return { url, webcal: url.replace(/^https?:\/\//, 'webcal://') };
}

router.get('/my-link', authMiddleware, requireSeller, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(linkPayload(await teamCalendar.issueToken(prisma, req.userId)));
  } catch (e) {
    console.error('[team-calendar/my-link]', e.message);
    res.status(500).json({ error: 'Não foi possível gerar o link agora.' });
  }
});

router.post('/my-link/rotate', authMiddleware, requireSeller, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(linkPayload(await teamCalendar.issueToken(prisma, req.userId, { rotate: true })));
  } catch (e) {
    console.error('[team-calendar/rotate]', e.message);
    res.status(500).json({ error: 'Não foi possível trocar o link agora.' });
  }
});

router.get('/feed/:file', async (req, res) => {
  res.set('Cache-Control', 'private, max-age=300');
  const token = String(req.params.file || '').replace(/\.ics$/i, '');
  try {
    const seller = await teamCalendar.resolveToken(prisma, token);
    if (!seller) return res.status(404).type('text/plain').send('Link de calendário inválido ou trocado.');
    const collected = await teamCalendar.collectEvents(prisma, seller);
    const body = teamCalendar.buildIcs(seller, collected, { host: new URL(publicBaseUrl()).host });
    res.set('Content-Disposition', 'inline; filename="escala.ics"');
    res.type('text/calendar; charset=utf-8').send(body);
  } catch (e) {
    console.error('[team-calendar/feed]', e.message);
    res.status(500).type('text/plain').send('Erro ao montar o calendário.');
  }
});

module.exports = router;
