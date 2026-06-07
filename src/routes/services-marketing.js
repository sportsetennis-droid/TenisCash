// =====================================================================
// SERVIÇOS — MARKETING (aniversariantes, reativação de inativos, promoção)
// ---------------------------------------------------------------------
// Estilo AppBarber: o dono aciona campanhas pra puxar cliente de volta.
//   - ANIVERSARIANTES do mês (cruza ServiceAppointment.clientUserId → User.birthDate)
//   - INATIVOS (clientes que sumiram há N dias)
//   - COMPOSITOR de promoção → enfileira 1 MessageLog por destinatário
//
// ⚠️ ENVIO REAL = SKELETON. NUNCA dispara WhatsApp/SMS/email. Só grava
// MessageLog com status "queued". O disparo de verdade depende de
// aprovação humana (regra inquebrável do projeto).
//
// Timezone America/Fortaleza (UTC-3 fixo). Reusa o MESMO approach de
// "hoje" dos endpoints /cash e /report de services.js (sem inventar
// matemática de data): new Date(Date.now() + TZ_OFFSET_MIN*60000)...slice(0,10)
// + localToUtc(dateStr, minOfDay).
// =====================================================================

const express = require('express');
const { prisma, authMiddleware } = require('../middleware');

const router = express.Router();

// América/Fortaleza = UTC-3 fixo, sem horário de verão (igual services.js).
const TZ_OFFSET_MIN = -180;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[services-marketing]', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

// (dia local 'YYYY-MM-DD', minuto do dia) → instante UTC. Idêntico a services.js.
function localToUtc(dateStr, minOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - TZ_OFFSET_MIN * 60000 + minOfDay * 60000);
}

// "hoje" no fuso local, no MESMO padrão de /cash e /report (services.js).
function todayLocalStr() {
  return new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

// Posse do estabelecimento — exatamente como o ownedVenue de services.js.
async function ownedVenue(req, res) {
  const v = await prisma.serviceVenue.findUnique({ where: { id: req.params.id } });
  if (!v) {
    res.status(404).json({ error: 'Estabelecimento não encontrado' });
    return null;
  }
  if (v.ownerUserId !== req.userId) {
    res.status(403).json({ error: 'Sem permissão' });
    return null;
  }
  return v;
}

// Carrega os agendamentos do venue (qualquer status), com base mínima de
// contato. Usado por birthdays e inactive.
async function venueAppointments(venueId) {
  return prisma.serviceAppointment.findMany({
    where: { venueId },
    select: {
      id: true,
      clientUserId: true,
      customerName: true,
      customerPhone: true,
      startAt: true,
    },
    orderBy: { startAt: 'desc' },
    take: 5000,
  });
}

// =====================================================================
// ANIVERSARIANTES DO MÊS — cruza clientes do venue com User.birthDate
// =====================================================================
router.get(
  '/venues/:id/marketing/birthdays',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;

    // Mês corrente no fuso local (padrão /cash e /report).
    const month = Number(todayLocalStr().slice(5, 7)); // 1..12

    const appts = await venueAppointments(v.id);
    const userIds = [...new Set(appts.filter((a) => a.clientUserId).map((a) => a.clientUserId))];
    if (!userIds.length) return res.json({ month, count: 0, birthdays: [] });

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, phone: true, birthDate: true },
    });

    // birthDate é String (schema). Aceita "YYYY-MM-DD" ou "DD/MM" etc.
    // Extrai o mês de forma defensiva e filtra pelo mês corrente.
    const out = [];
    for (const u of users) {
      const parsed = parseBirthMonthDay(u.birthDate);
      if (!parsed || parsed.month !== month) continue;
      // último contato conhecido (telefone do User ou do agendamento mais recente)
      const lastAppt = appts.find((a) => a.clientUserId === u.id);
      out.push({
        clientUserId: u.id,
        name: u.name || lastAppt?.customerName || 'Cliente',
        phone: u.phone || lastAppt?.customerPhone || null,
        day: parsed.day,
      });
    }
    out.sort((a, b) => (a.day || 99) - (b.day || 99));
    res.json({ month, count: out.length, birthdays: out });
  })
);

// Extrai {month, day} de uma String de nascimento heterogênea.
// Suporta "YYYY-MM-DD", "YYYY-MM-DDT...", "DD/MM/YYYY", "DD/MM".
function parseBirthMonthDay(s) {
  if (!s) return null;
  const str = String(s).trim();
  // ISO: YYYY-MM-DD
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { month: Number(m[2]), day: Number(m[3]) };
  // BR: DD/MM(/YYYY)
  m = str.match(/^(\d{1,2})\/(\d{1,2})/);
  if (m) return { month: Number(m[2]), day: Number(m[1]) };
  return null;
}

// =====================================================================
// INATIVOS — agendaram no venue mas o último startAt < hoje - N dias
// =====================================================================
router.get(
  '/venues/:id/marketing/inactive',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;

    const days = Math.max(1, Number(req.query.days) || 30);
    // corte = início do dia (local) de N dias atrás → instante UTC.
    const cutoffDateStr = new Date(Date.now() + TZ_OFFSET_MIN * 60000 - days * 86400000)
      .toISOString()
      .slice(0, 10);
    const cutoff = localToUtc(cutoffDateStr, 0);

    const appts = await venueAppointments(v.id);

    // Agrupa por clientUserId; sem userId, agrupa por customerPhone.
    const groups = new Map();
    for (const a of appts) {
      const key = a.clientUserId ? `u:${a.clientUserId}` : a.customerPhone ? `p:${a.customerPhone}` : null;
      if (!key) continue;
      const cur = groups.get(key);
      if (!cur || a.startAt > cur.lastAt) {
        groups.set(key, {
          clientUserId: a.clientUserId || null,
          customerPhone: a.customerPhone || null,
          customerName: a.customerName || null,
          lastAt: a.startAt,
        });
      }
    }

    // mantém só quem está inativo (última visita antes do corte)
    const inactiveGroups = [...groups.values()].filter((g) => g.lastAt < cutoff);

    // resolve nome/telefone via User quando houver clientUserId
    const uids = inactiveGroups.filter((g) => g.clientUserId).map((g) => g.clientUserId);
    const users = uids.length
      ? await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, name: true, phone: true } })
      : [];
    const uMap = new Map(users.map((u) => [u.id, u]));

    const out = inactiveGroups
      .map((g) => {
        const u = g.clientUserId ? uMap.get(g.clientUserId) : null;
        return {
          clientUserId: g.clientUserId,
          name: (u && u.name) || g.customerName || 'Cliente',
          phone: (u && u.phone) || g.customerPhone || null,
          lastVisit: g.lastAt,
        };
      })
      .sort((a, b) => new Date(a.lastVisit) - new Date(b.lastVisit));

    res.json({ days, cutoff, count: out.length, inactive: out });
  })
);

// =====================================================================
// CRIAR CAMPANHA — cria MarketingCampaign + enfileira 1 MessageLog por
// destinatário do segmento. NÃO ENVIA (skeleton).
// segment: "birthdays" | "inactive" | "all"
// =====================================================================
router.post(
  '/venues/:id/marketing/campaign',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    const title = (b.title || '').trim();
    const message = (b.message || '').trim();
    if (!title || !message) return res.status(400).json({ error: 'title e message obrigatórios' });

    const type = String(b.type || 'promo');
    const segment = ['birthdays', 'inactive', 'all'].includes(b.segment) ? b.segment : 'all';

    // Resolve destinatários do segmento.
    const recipients = await resolveSegment(v.id, segment, b);

    // Cria a campanha + enfileira os logs numa transação (>1 write → timeout/maxWait).
    const out = await prisma.$transaction(
      async (tx) => {
        const campaign = await tx.marketingCampaign.create({
          data: {
            venueId: v.id,
            type,
            title,
            message,
            segment,
            status: 'queued',
          },
        });
        let queued = 0;
        for (const r of recipients) {
          // TODO(skeleton): envio real precisa aprovacao humana — aqui só enfileira.
          await tx.messageLog.create({
            data: {
              venueId: v.id,
              campaignId: campaign.id,
              clientUserId: r.clientUserId || null,
              customerName: r.name || null,
              customerPhone: r.phone || null,
              channel: 'whatsapp',
              status: 'queued',
            },
          });
          queued += 1;
        }
        return { campaign, queued };
      },
      { timeout: 20000, maxWait: 10000 }
    );

    res.status(201).json({
      campaign: out.campaign,
      queued: out.queued,
      sent: 0,
      note: 'Mensagens enfileiradas (status "queued"). Envio real depende de aprovação humana (skeleton).',
    });
  })
);

// Resolve a lista de destinatários {clientUserId?, name, phone} de um segmento.
async function resolveSegment(venueId, segment, opts) {
  const appts = await venueAppointments(venueId);

  if (segment === 'birthdays') {
    const month = Number(todayLocalStr().slice(5, 7));
    const userIds = [...new Set(appts.filter((a) => a.clientUserId).map((a) => a.clientUserId))];
    if (!userIds.length) return [];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, phone: true, birthDate: true },
    });
    const out = [];
    for (const u of users) {
      const parsed = parseBirthMonthDay(u.birthDate);
      if (!parsed || parsed.month !== month) continue;
      out.push({ clientUserId: u.id, name: u.name || 'Cliente', phone: u.phone || null });
    }
    return out;
  }

  if (segment === 'inactive') {
    const days = Math.max(1, Number(opts && opts.days) || 30);
    const cutoffDateStr = new Date(Date.now() + TZ_OFFSET_MIN * 60000 - days * 86400000)
      .toISOString()
      .slice(0, 10);
    const cutoff = localToUtc(cutoffDateStr, 0);
    const groups = new Map();
    for (const a of appts) {
      const key = a.clientUserId ? `u:${a.clientUserId}` : a.customerPhone ? `p:${a.customerPhone}` : null;
      if (!key) continue;
      const cur = groups.get(key);
      if (!cur || a.startAt > cur.lastAt) {
        groups.set(key, {
          clientUserId: a.clientUserId || null,
          customerPhone: a.customerPhone || null,
          customerName: a.customerName || null,
          lastAt: a.startAt,
        });
      }
    }
    const inactive = [...groups.values()].filter((g) => g.lastAt < cutoff);
    const uids = inactive.filter((g) => g.clientUserId).map((g) => g.clientUserId);
    const users = uids.length
      ? await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, name: true, phone: true } })
      : [];
    const uMap = new Map(users.map((u) => [u.id, u]));
    return inactive.map((g) => {
      const u = g.clientUserId ? uMap.get(g.clientUserId) : null;
      return { clientUserId: g.clientUserId, name: (u && u.name) || g.customerName || 'Cliente', phone: (u && u.phone) || g.customerPhone || null };
    });
  }

  // "all" — todo cliente já atendido no venue (dedup por userId/telefone)
  const groups = new Map();
  for (const a of appts) {
    const key = a.clientUserId ? `u:${a.clientUserId}` : a.customerPhone ? `p:${a.customerPhone}` : null;
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { clientUserId: a.clientUserId || null, customerName: a.customerName || null, customerPhone: a.customerPhone || null });
    }
  }
  const all = [...groups.values()];
  const uids = all.filter((g) => g.clientUserId).map((g) => g.clientUserId);
  const users = uids.length
    ? await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, name: true, phone: true } })
    : [];
  const uMap = new Map(users.map((u) => [u.id, u]));
  return all.map((g) => {
    const u = g.clientUserId ? uMap.get(g.clientUserId) : null;
    return { clientUserId: g.clientUserId, name: (u && u.name) || g.customerName || 'Cliente', phone: (u && u.phone) || g.customerPhone || null };
  });
}

// =====================================================================
// HISTÓRICO DE CAMPANHAS
// =====================================================================
router.get(
  '/venues/:id/marketing/campaigns',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const campaigns = await prisma.marketingCampaign.findMany({
      where: { venueId: v.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // contagem de destinatários enfileirados por campanha
    const ids = campaigns.map((c) => c.id);
    const counts = ids.length
      ? await prisma.messageLog.groupBy({ by: ['campaignId'], where: { venueId: v.id, campaignId: { in: ids } }, _count: true })
      : [];
    const cMap = new Map(counts.map((c) => [c.campaignId, c._count]));
    res.json(campaigns.map((c) => ({ ...c, recipients: cMap.get(c.id) || 0 })));
  })
);

module.exports = router;
