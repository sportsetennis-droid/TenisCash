// =====================================================================
// SERVIÇOS — Agendamento + Marketplace + TenisCash na rede
// ---------------------------------------------------------------------
// Reaproveita o Professional (card + offers + clients + charges) e
// adiciona o que faltava p/ virar uma plataforma estilo AppBarber:
//   - ESTABELECIMENTO (ServiceVenue) que agrupa N barbeiros
//   - AGENDA (disponibilidade + slots + booking)
//   - MARKETPLACE (descoberta por cidade/segmento)
//   - MOEDA no serviço: cashback (earn) + pagar com T$ (burn) — o moat
//
// O crédito/débito de T$ fica ATRÁS da flag Config `services.cashback.enabled`
// (default OFF). Regra do dono: nada que mexe em conta financeira roda sem
// ele ligar. Liga em POST /api/services/config { cashbackEnabled: true }.
//
// Padrão de movimentação de saldo = idêntico ao transfer.js (User.balance
// increment/decrement + Transaction com balanceAfter, dentro de $transaction).
// =====================================================================

const express = require('express');
const jwt = require('jsonwebtoken');
const { prisma, authMiddleware, adminMiddleware, JWT_SECRET } = require('../middleware');
const { generatePublicToken, sanitize } = require('../services/pix');

const router = express.Router();

// América/Fortaleza = UTC-3 fixo, sem horário de verão (regra CLAUDE.md).
const TZ_OFFSET_MIN = -180;
const SEGMENTS = ['barbearia', 'salao', 'estetica', 'tattoo', 'other'];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Promise wrapper — captura erro e responde 500 (sem deixar handler estourar)
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[services]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

// Auth opcional: cliente do marketplace pode estar logado (ganha cashback) ou não
function optionalAuth(req, _res, next) {
  let token = null;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) token = h.split(' ')[1];
  else if (req.query && req.query.token) token = String(req.query.token);
  if (token) {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      req.userId = d.userId;
      req.userRole = d.role;
    } catch (_) {
      /* token inválido → segue como anônimo */
    }
  }
  next();
}

function slugify(s) {
  return (
    sanitize(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'venue'
  );
}

async function uniqueVenueSlug(base) {
  let slug = slugify(base);
  let n = 1;
  while (await prisma.serviceVenue.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${slugify(base)}-${n}`;
  }
  return slug;
}

function getMyPro(req) {
  return prisma.professional.findUnique({ where: { userId: req.userId } });
}

// Flag global (Config key/value). id setado = key (Config.id é PK).
async function getFlag(key, def) {
  const c = await prisma.config.findUnique({ where: { key } });
  return c ? c.value : def;
}
function setFlag(key, value) {
  return prisma.config.upsert({
    where: { key },
    create: { id: key, key, value: String(value) },
    update: { value: String(value) },
  });
}
const cashbackOn = async () => (await getFlag('services.cashback.enabled', 'false')) === 'true';

// (dia local 'YYYY-MM-DD', minuto do dia) → instante UTC
function localToUtc(dateStr, minOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - TZ_OFFSET_MIN * 60000 + minOfDay * 60000);
}

// Carrega agendamento e confirma que o req.userId é dono do card OU do estabelecimento.
// Em falha, responde e retorna null.
async function loadOwnedAppointment(req, res) {
  const appt = await prisma.serviceAppointment.findUnique({ where: { id: req.params.id } });
  if (!appt) {
    res.status(404).json({ error: 'Agendamento não encontrado' });
    return null;
  }
  const pro = await prisma.professional.findUnique({ where: { id: appt.professionalId } });
  let owns = pro && pro.userId === req.userId;
  if (!owns && appt.venueId) {
    const v = await prisma.serviceVenue.findUnique({ where: { id: appt.venueId } });
    owns = v && v.ownerUserId === req.userId;
  }
  if (!owns) {
    res.status(403).json({ error: 'Sem permissão sobre este agendamento' });
    return null;
  }
  return { appt, pro };
}

// Calcula horários livres de um profissional num dia, passo de 15min,
// respeitando disponibilidade, exceções (folga) e agendamentos existentes.
async function computeSlots(professionalId, dateStr, durationMin, stepMin = 15) {
  const weekday = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  const windows = await prisma.professionalAvailability.findMany({
    where: { professionalId, weekday, active: true },
  });
  if (!windows.length) return [];

  const dayStart = localToUtc(dateStr, 0);
  const dayEnd = localToUtc(dateStr, 24 * 60);

  const exceptions = await prisma.availabilityException.findMany({
    where: { professionalId, date: { gte: dayStart, lt: dayEnd } },
  });
  const appts = await prisma.serviceAppointment.findMany({
    where: {
      professionalId,
      status: { in: ['booked', 'confirmed'] },
      startAt: { gte: dayStart, lt: dayEnd },
    },
    select: { startAt: true, endAt: true },
  });

  const busy = appts.map((a) => [a.startAt.getTime(), a.endAt.getTime()]);
  for (const ex of exceptions) {
    if (ex.startMin == null) return []; // dia inteiro bloqueado
    busy.push([localToUtc(dateStr, ex.startMin).getTime(), localToUtc(dateStr, ex.endMin ?? ex.startMin).getTime()]);
  }

  const now = Date.now();
  const slots = [];
  for (const w of windows) {
    for (let m = w.startMin; m + durationMin <= w.endMin; m += stepMin) {
      const s = localToUtc(dateStr, m).getTime();
      const e = s + durationMin * 60000;
      if (s < now) continue; // não oferecer horário no passado
      const overlap = busy.some(([bs, be]) => s < be && e > bs);
      if (!overlap) slots.push(new Date(s).toISOString());
    }
  }
  return slots;
}

// =====================================================================
// MARKETPLACE (público)
// =====================================================================

// Descoberta — estabelecimentos publicados, filtra por cidade/segmento/nome
router.get(
  '/discover',
  wrap(async (req, res) => {
    const { city, segment, q } = req.query;
    const where = { published: true };
    if (city) where.city = { equals: String(city), mode: 'insensitive' };
    if (segment) where.segment = String(segment);
    if (q) where.name = { contains: String(q), mode: 'insensitive' };
    const venues = await prisma.serviceVenue.findMany({
      where,
      take: 60,
      orderBy: [{ verified: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, slug: true, name: true, segment: true, avatarUrl: true, coverUrl: true,
        city: true, neighborhood: true, cashbackPct: true, givesCashback: true, acceptsTC: true, verified: true,
        reviewRating: true, reviewCount: true,
      },
    });
    res.json({ count: venues.length, venues });
  })
);

// Página pública do estabelecimento — barbeiros + serviços
router.get(
  '/venue/:slug',
  wrap(async (req, res) => {
    const venue = await prisma.serviceVenue.findUnique({ where: { slug: req.params.slug } });
    if (!venue || !venue.published) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    const members = await prisma.venueMember.findMany({ where: { venueId: venue.id, active: true } });
    const proIds = members.map((m) => m.professionalId);
    const pros = await prisma.professional.findMany({
      where: { id: { in: proIds } },
      select: { id: true, slug: true, displayName: true, headline: true, avatarUrl: true },
    });
    const offers = await prisma.professionalOffer.findMany({
      where: { professionalId: { in: proIds }, active: true, visible: true },
    });
    const professionals = pros.map((p) => ({
      ...p,
      role: members.find((m) => m.professionalId === p.id)?.role || 'staff',
      offers: offers.filter((o) => o.professionalId === p.id),
    }));
    res.json({ venue, professionals });
  })
);

// Horários livres de um profissional num dia
router.get(
  '/slots',
  wrap(async (req, res) => {
    const { professionalId, date, offerId } = req.query;
    if (!professionalId || !date) return res.status(400).json({ error: 'professionalId e date (YYYY-MM-DD) obrigatórios' });
    let durationMin = Number(req.query.durationMin) || 30;
    if (offerId) {
      const o = await prisma.professionalOffer.findUnique({ where: { id: String(offerId) } });
      if (o?.durationMin) durationMin = o.durationMin;
    }
    const slots = await computeSlots(String(professionalId), String(date), durationMin);
    res.json({ date, durationMin, slots });
  })
);

// =====================================================================
// BOOKING — cria agendamento (cliente logado ganha cashback; anônimo também marca)
// =====================================================================
router.post(
  '/book',
  optionalAuth,
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.professionalId || !b.startAt) return res.status(400).json({ error: 'professionalId e startAt obrigatórios' });

    const pro = await prisma.professional.findUnique({ where: { id: b.professionalId } });
    if (!pro) return res.status(404).json({ error: 'Profissional não encontrado' });

    let durationMin = Number(b.durationMin) || 30;
    let price = 0;
    let serviceName = b.serviceName || 'Serviço';
    let offer = null;
    if (b.offerId) {
      offer = await prisma.professionalOffer.findFirst({ where: { id: b.offerId, professionalId: pro.id } });
      if (offer) {
        durationMin = offer.durationMin || durationMin;
        price = offer.price || 0;
        serviceName = offer.title;
      }
    }

    const start = new Date(b.startAt);
    if (isNaN(start.getTime())) return res.status(400).json({ error: 'startAt inválido' });
    const end = new Date(start.getTime() + durationMin * 60000);

    let venue = null;
    if (b.venueId) venue = await prisma.serviceVenue.findUnique({ where: { id: b.venueId } });
    const cashbackPct = venue?.cashbackPct ?? 0;

    try {
      const appt = await prisma.$transaction(async (tx) => {
        // Guarda anti-overbooking: re-checa conflito dentro da transação
        const clash = await tx.serviceAppointment.findFirst({
          where: {
            professionalId: pro.id,
            status: { in: ['booked', 'confirmed'] },
            startAt: { lt: end },
            endAt: { gt: start },
          },
        });
        if (clash) throw new Error('SLOT_TAKEN');
        return tx.serviceAppointment.create({
          data: {
            venueId: venue?.id || null,
            professionalId: pro.id,
            offerId: offer?.id || null,
            clientUserId: req.userId || null,
            clientId: b.clientId || null,
            customerName: b.customerName || null,
            customerPhone: b.customerPhone || null,
            startAt: start,
            endAt: end,
            durationMin,
            serviceName,
            price,
            cashbackPct,
            source: b.source || 'marketplace',
            status: 'booked',
          },
        });
      });
      res.status(201).json(appt);
    } catch (e) {
      if (e.message === 'SLOT_TAKEN') return res.status(409).json({ error: 'Esse horário acabou de ser reservado' });
      throw e;
    }
  })
);

// =====================================================================
// CLIENTE — meus agendamentos
// =====================================================================
router.get(
  '/me/appointments',
  authMiddleware,
  wrap(async (req, res) => {
    const rows = await prisma.serviceAppointment.findMany({
      where: { clientUserId: req.userId },
      orderBy: { startAt: 'desc' },
      take: 50,
    });
    res.json(rows);
  })
);

// =====================================================================
// PROFISSIONAL / ESTABELECIMENTO — gestão da agenda
// =====================================================================

// Agenda (meus agendamentos como pro + dos meus estabelecimentos)
router.get(
  '/manage/appointments',
  authMiddleware,
  wrap(async (req, res) => {
    const pro = await getMyPro(req);
    const venues = await prisma.serviceVenue.findMany({ where: { ownerUserId: req.userId }, select: { id: true } });
    const venueIds = venues.map((v) => v.id);
    const or = [];
    if (pro) or.push({ professionalId: pro.id });
    if (venueIds.length) or.push({ venueId: { in: venueIds } });
    if (!or.length) return res.json([]);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 86400000);
    const rows = await prisma.serviceAppointment.findMany({
      where: { OR: or, startAt: { gte: from } },
      orderBy: { startAt: 'asc' },
      take: 300,
    });
    res.json(rows);
  })
);

// Disponibilidade (janelas semanais)
router.get(
  '/me/availability',
  authMiddleware,
  wrap(async (req, res) => {
    const pro = await getMyPro(req);
    if (!pro) return res.status(404).json({ error: 'Perfil profissional não encontrado' });
    const rows = await prisma.professionalAvailability.findMany({
      where: { professionalId: pro.id },
      orderBy: [{ weekday: 'asc' }, { startMin: 'asc' }],
    });
    res.json(rows);
  })
);

router.post(
  '/me/availability',
  authMiddleware,
  wrap(async (req, res) => {
    const pro = await getMyPro(req);
    if (!pro) return res.status(404).json({ error: 'Perfil profissional não encontrado' });
    const b = req.body || {};
    const weekday = Number(b.weekday);
    const startMin = Number(b.startMin);
    const endMin = Number(b.endMin);
    if (!(weekday >= 0 && weekday <= 6)) return res.status(400).json({ error: 'weekday 0..6' });
    if (!(startMin >= 0 && endMin > startMin && endMin <= 1440)) return res.status(400).json({ error: 'startMin/endMin inválidos' });
    const row = await prisma.professionalAvailability.create({
      data: { professionalId: pro.id, weekday, startMin, endMin },
    });
    res.status(201).json(row);
  })
);

router.delete(
  '/me/availability/:id',
  authMiddleware,
  wrap(async (req, res) => {
    const pro = await getMyPro(req);
    if (!pro) return res.status(404).json({ error: 'Perfil profissional não encontrado' });
    const row = await prisma.professionalAvailability.findUnique({ where: { id: req.params.id } });
    if (!row || row.professionalId !== pro.id) return res.status(404).json({ error: 'Janela não encontrada' });
    await prisma.professionalAvailability.delete({ where: { id: row.id } });
    res.json({ ok: true });
  })
);

// Folga / bloqueio pontual
router.post(
  '/me/availability/exception',
  authMiddleware,
  wrap(async (req, res) => {
    const pro = await getMyPro(req);
    if (!pro) return res.status(404).json({ error: 'Perfil profissional não encontrado' });
    const b = req.body || {};
    if (!b.date) return res.status(400).json({ error: 'date (YYYY-MM-DD) obrigatória' });
    const row = await prisma.availabilityException.create({
      data: {
        professionalId: pro.id,
        date: localToUtc(String(b.date), 0),
        startMin: b.startMin != null ? Number(b.startMin) : null,
        endMin: b.endMin != null ? Number(b.endMin) : null,
        reason: b.reason || null,
      },
    });
    res.status(201).json(row);
  })
);

// --- Ciclo de vida do agendamento (pro/estabelecimento) ---
function setStatusHandler(status, extra) {
  return wrap(async (req, res) => {
    const ctx = await loadOwnedAppointment(req, res);
    if (!ctx) return;
    const row = await prisma.serviceAppointment.update({
      where: { id: ctx.appt.id },
      data: { status, ...(extra ? extra() : {}) },
    });
    res.json(row);
  });
}
router.post('/appointments/:id/confirm', authMiddleware, setStatusHandler('confirmed'));
router.post('/appointments/:id/no-show', authMiddleware, setStatusHandler('no_show'));

// Cancelar — permitido ao pro/estabelecimento OU ao próprio cliente
router.post(
  '/appointments/:id/cancel',
  authMiddleware,
  wrap(async (req, res) => {
    const appt = await prisma.serviceAppointment.findUnique({ where: { id: req.params.id } });
    if (!appt) return res.status(404).json({ error: 'Agendamento não encontrado' });
    let allowed = appt.clientUserId === req.userId;
    if (!allowed) {
      const pro = await prisma.professional.findUnique({ where: { id: appt.professionalId } });
      allowed = pro && pro.userId === req.userId;
    }
    if (!allowed && appt.venueId) {
      const v = await prisma.serviceVenue.findUnique({ where: { id: appt.venueId } });
      allowed = v && v.ownerUserId === req.userId;
    }
    if (!allowed) return res.status(403).json({ error: 'Sem permissão' });
    if (appt.status === 'done') return res.status(400).json({ error: 'Serviço concluído não pode ser cancelado' });
    const row = await prisma.serviceAppointment.update({
      where: { id: appt.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    res.json(row);
  })
);

// CONCLUIR serviço — registra Charge (COBRAR≠RECEBER, off_platform por padrão)
// e, SE a flag estiver ligada, credita cashback em T$ no cliente TenisCash.
router.post(
  '/appointments/:id/done',
  authMiddleware,
  wrap(async (req, res) => {
    const ctx = await loadOwnedAppointment(req, res);
    if (!ctx) return;
    const { appt, pro } = ctx;
    if (appt.status === 'done') return res.json(appt);

    const enabled = await cashbackOn();
    const venue = appt.venueId ? await prisma.serviceVenue.findUnique({ where: { id: appt.venueId } }) : null;
    // Regra: cliente ganha 100% (1:1) do que pagou, em T$ — sem % configurável.
    const cashback = (enabled && appt.clientUserId && venue && venue.givesCashback) ? round2(appt.price) : 0;

    const out = await prisma.$transaction(async (tx) => {
      // Registro de cobrança do serviço
      const charge = await tx.charge.create({
        data: {
          professionalId: pro.id,
          clientId: appt.clientId || null,
          offerId: appt.offerId || null,
          amount: appt.price,
          description: `Serviço: ${appt.serviceName}`,
          settlementMode: 'off_platform',
          method: req.body?.method || 'cash',
          status: 'paid',
          paidAt: new Date(),
          paidConfirmedBy: 'manual',
          cashbackAmount: enabled ? cashback : 0,
          publicToken: generatePublicToken(),
        },
      });

      // Cashback (gated) — só credita User TenisCash de verdade
      let credited = 0;
      if (enabled && appt.clientUserId && cashback > 0) {
        const u = await tx.user.update({
          where: { id: appt.clientUserId },
          data: { balance: { increment: cashback } },
        });
        await tx.transaction.create({
          data: {
            type: 'cashback_service',
            amount: cashback,
            description: `Cashback: ${appt.serviceName}`,
            receiverId: appt.clientUserId,
            balanceAfter: u.balance,
            metadata: JSON.stringify({ appointmentId: appt.id, professionalId: pro.id, venueId: appt.venueId }),
          },
        });
        credited = cashback;
      }

      await tx.professional.update({ where: { id: pro.id }, data: { totalPaid: { increment: appt.price } } });
      if (appt.venueId) {
        await tx.serviceVenue.update({ where: { id: appt.venueId }, data: { totalBilled: { increment: appt.price } } }).catch(() => {});
      }
      const row = await tx.serviceAppointment.update({
        where: { id: appt.id },
        data: { status: 'done', doneAt: new Date(), tcEarned: credited, chargeId: charge.id },
      });
      return { row, charge, credited };
    });

    res.json({ ...out.row, cashbackEnabled: enabled, cashbackCredited: out.credited, chargeId: out.charge.id });
  })
);

// PAGAR com T$ (burn) — debita saldo do cliente até o valor do serviço.
// Gated pela flag + venue.acceptsTC. Pode ser chamado pelo cliente ou pelo pro.
router.post(
  '/appointments/:id/pay-with-tc',
  authMiddleware,
  wrap(async (req, res) => {
    const appt = await prisma.serviceAppointment.findUnique({ where: { id: req.params.id } });
    if (!appt) return res.status(404).json({ error: 'Agendamento não encontrado' });
    if (!appt.clientUserId) return res.status(400).json({ error: 'Agendamento sem cliente TenisCash vinculado' });

    let allowed = appt.clientUserId === req.userId;
    if (!allowed) {
      const pro = await prisma.professional.findUnique({ where: { id: appt.professionalId } });
      allowed = pro && pro.userId === req.userId;
    }
    if (!allowed) return res.status(403).json({ error: 'Sem permissão' });

    if (!(await cashbackOn())) return res.status(403).json({ error: 'Pagamento com T$ desativado (flag services.cashback.enabled)' });
    if (appt.venueId) {
      const v = await prisma.serviceVenue.findUnique({ where: { id: appt.venueId } });
      if (v && !v.acceptsTC) return res.status(400).json({ error: 'Estabelecimento não aceita pagamento com T$' });
    }

    const u = await prisma.user.findUnique({ where: { id: appt.clientUserId } });
    const remaining = round2(appt.price - appt.tcUsed);
    if (remaining <= 0) return res.status(400).json({ error: 'Serviço já quitado em T$' });
    const want = req.body?.amount ? Math.min(Number(req.body.amount), remaining) : remaining;
    const use = round2(Math.min(u.balance, want));
    if (use <= 0) return res.status(400).json({ error: 'Saldo de T$ insuficiente' });

    const out = await prisma.$transaction(async (tx) => {
      const nu = await tx.user.update({ where: { id: u.id }, data: { balance: { decrement: use } } });
      await tx.transaction.create({
        data: {
          type: 'service_payment',
          amount: use,
          description: `Pagamento com T$: ${appt.serviceName}`,
          senderId: u.id,
          balanceAfter: nu.balance,
          metadata: JSON.stringify({ appointmentId: appt.id, professionalId: appt.professionalId }),
        },
      });
      const row = await tx.serviceAppointment.update({ where: { id: appt.id }, data: { tcUsed: { increment: use } } });
      return { nu, row };
    });

    res.json({ tcUsed: out.row.tcUsed, remaining: round2(appt.price - out.row.tcUsed), balance: out.nu.balance });
  })
);

// =====================================================================
// ESTABELECIMENTO — CRUD (dono)
// =====================================================================
router.post(
  '/venues',
  authMiddleware,
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
    const slug = await uniqueVenueSlug(b.name);
    const v = await prisma.serviceVenue.create({
      data: {
        ownerUserId: req.userId,
        slug,
        name: b.name,
        segment: SEGMENTS.includes(b.segment) ? b.segment : 'barbearia',
        bio: b.bio || null,
        address: b.address || null,
        neighborhood: b.neighborhood || null,
        city: b.city || null,
        state: b.state || null,
        cep: b.cep || null,
        whatsapp: b.whatsapp || null,
        instagram: b.instagram || null,
        givesCashback: b.givesCashback !== false,
        acceptsTC: b.acceptsTC !== false,
        pixKey: b.pixKey || null,
      },
    });
    res.status(201).json(v);
  })
);

router.get(
  '/me/venues',
  authMiddleware,
  wrap(async (req, res) => {
    res.json(await prisma.serviceVenue.findMany({ where: { ownerUserId: req.userId }, orderBy: { createdAt: 'desc' } }));
  })
);

// Helper de posse do estabelecimento
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

router.patch(
  '/venues/:id',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    const data = {};
    for (const f of ['name', 'bio', 'address', 'neighborhood', 'city', 'state', 'cep', 'whatsapp', 'instagram', 'pixKey', 'avatarUrl', 'coverUrl']) {
      if (b[f] !== undefined) data[f] = b[f];
    }
    if (b.segment !== undefined && SEGMENTS.includes(b.segment)) data.segment = b.segment;
    if (b.givesCashback !== undefined) data.givesCashback = !!b.givesCashback;
    if (b.acceptsTC !== undefined) data.acceptsTC = !!b.acceptsTC;
    if (b.published !== undefined) data.published = !!b.published;
    const row = await prisma.serviceVenue.update({ where: { id: v.id }, data });
    res.json(row);
  })
);

// Listar barbeiros do estabelecimento (escopo do dono)
router.get(
  '/venues/:id/members',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const members = await prisma.venueMember.findMany({ where: { venueId: v.id, active: true } });
    const pros = await prisma.professional.findMany({
      where: { id: { in: members.map((m) => m.professionalId) } },
      select: { id: true, slug: true, displayName: true, headline: true, avatarUrl: true },
    });
    res.json(
      members.map((m) => {
        const p = pros.find((x) => x.id === m.professionalId);
        return {
          professionalId: m.professionalId,
          role: m.role,
          commissionPct: m.commissionPct,
          name: p?.displayName || 'Barbeiro',
          slug: p?.slug || '',
          headline: p?.headline || '',
          avatarUrl: p?.avatarUrl || '',
        };
      })
    );
  })
);

// Adicionar barbeiro (Professional) ao estabelecimento
router.post(
  '/venues/:id/members',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    let professionalId = req.body?.professionalId;
    if (!professionalId && req.body?.slug) {
      const bySlug = await prisma.professional.findUnique({
        where: { slug: String(req.body.slug).trim().toLowerCase() },
      });
      if (!bySlug) return res.status(404).json({ error: 'Barbeiro não encontrado com esse usuário' });
      professionalId = bySlug.id;
    }
    if (!professionalId) return res.status(400).json({ error: 'professionalId ou slug obrigatório' });
    const pro = await prisma.professional.findUnique({ where: { id: professionalId } });
    if (!pro) return res.status(404).json({ error: 'Profissional não encontrado' });
    const role = req.body?.role || 'staff';
    const commissionPct =
      req.body?.commissionPct != null && !Number.isNaN(Number(req.body.commissionPct))
        ? Math.max(0, Math.min(100, Number(req.body.commissionPct)))
        : undefined;
    const m = await prisma.venueMember.upsert({
      where: { venueId_professionalId: { venueId: v.id, professionalId } },
      create: { venueId: v.id, professionalId, role, ...(commissionPct != null ? { commissionPct } : {}) },
      update: { active: true, role, ...(commissionPct != null ? { commissionPct } : {}) },
    });
    const count = await prisma.venueMember.count({ where: { venueId: v.id, active: true } });
    await prisma.serviceVenue.update({ where: { id: v.id }, data: { memberCount: count } });
    res.status(201).json(m);
  })
);

router.delete(
  '/venues/:id/members/:professionalId',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    await prisma.venueMember
      .update({
        where: { venueId_professionalId: { venueId: v.id, professionalId: req.params.professionalId } },
        data: { active: false },
      })
      .catch(() => {});
    const count = await prisma.venueMember.count({ where: { venueId: v.id, active: true } });
    await prisma.serviceVenue.update({ where: { id: v.id }, data: { memberCount: count } });
    res.json({ ok: true });
  })
);

// =====================================================================
// CONFIG (admin) — liga/desliga a moeda no serviço
// =====================================================================
router.get(
  '/config',
  authMiddleware,
  adminMiddleware,
  wrap(async (_req, res) => {
    res.json({ cashbackEnabled: await cashbackOn() });
  })
);
router.post(
  '/config',
  authMiddleware,
  adminMiddleware,
  wrap(async (req, res) => {
    await setFlag('services.cashback.enabled', req.body?.cashbackEnabled ? 'true' : 'false');
    res.json({ cashbackEnabled: !!req.body?.cashbackEnabled });
  })
);

// =====================================================================
// GESTÃO DO ESTABELECIMENTO — produtos, comanda, caixa, comissão,
// relatório, avaliação (NPS), lista de espera. Tudo escopado pelo dono.
// =====================================================================

async function memberCommission(venueId, professionalId) {
  if (!venueId) return 0;
  const m = await prisma.venueMember.findUnique({ where: { venueId_professionalId: { venueId, professionalId } } }).catch(() => null);
  return m ? m.commissionPct || 0 : 0;
}

// ----- PRODUTOS (estoque) -----
router.get('/venues/:id/products', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  res.json(await prisma.venueProduct.findMany({ where: { venueId: v.id, active: true }, orderBy: { name: 'asc' } }));
}));
router.post('/venues/:id/products', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
  const p = await prisma.venueProduct.create({ data: { venueId: v.id, name: b.name, price: Number(b.price) || 0, cost: Number(b.cost) || 0, stock: Number(b.stock) || 0 } });
  res.status(201).json(p);
}));
router.patch('/venues/:id/products/:pid', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  const b = req.body || {}; const data = {};
  for (const f of ['name']) if (b[f] !== undefined) data[f] = b[f];
  for (const f of ['price', 'cost', 'stock']) if (b[f] !== undefined) data[f] = Number(b[f]);
  if (b.active !== undefined) data.active = !!b.active;
  const p = await prisma.venueProduct.updateMany({ where: { id: req.params.pid, venueId: v.id }, data });
  res.json({ ok: p.count > 0 });
}));
router.delete('/venues/:id/products/:pid', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  await prisma.venueProduct.updateMany({ where: { id: req.params.pid, venueId: v.id }, data: { active: false } });
  res.json({ ok: true });
}));

// ----- Núcleo da comanda: cria comanda paga, baixa estoque, comissão, caixa, cashback -----
async function buildComanda(tx, { venue, professionalId, appointment, services, products, discount, paymentMethod, clientUserId, customerName }) {
  const commissionPct = await memberCommission(venue.id, professionalId);
  const items = [];
  for (const s of services) {
    const total = round2((s.price || 0) * (s.qty || 1));
    items.push({ kind: 'service', refId: s.refId || null, name: s.name, qty: s.qty || 1, unitPrice: s.price || 0, total, commissionPct, commissionAmount: round2(total * commissionPct / 100) });
  }
  const stockOps = [];
  for (const pi of products || []) {
    const prod = await tx.venueProduct.findFirst({ where: { id: pi.productId, venueId: venue.id } });
    if (!prod) continue;
    const qty = Math.max(1, Number(pi.qty) || 1);
    const total = round2(prod.price * qty);
    items.push({ kind: 'product', refId: prod.id, name: prod.name, qty, unitPrice: prod.price, total, commissionPct, commissionAmount: round2(total * commissionPct / 100) });
    stockOps.push({ id: prod.id, qty });
  }
  const subtotal = round2(items.reduce((a, i) => a + i.total, 0));
  const disc = round2(Number(discount) || 0);
  const total = round2(Math.max(0, subtotal - disc));
  const commissionTotal = round2(items.reduce((a, i) => a + i.commissionAmount, 0));

  const comanda = await tx.comanda.create({
    data: {
      venueId: venue.id, professionalId, appointmentId: appointment ? appointment.id : null,
      clientUserId: clientUserId || null, customerName: customerName || null,
      status: 'paid', subtotal, discount: disc, total, commissionTotal,
      paymentMethod: paymentMethod || 'cash', paidAt: new Date(),
      items: { create: items },
    },
    include: { items: true },
  });
  for (const op of stockOps) await tx.venueProduct.update({ where: { id: op.id }, data: { stock: { decrement: op.qty } } });
  await tx.cashEntry.create({ data: { venueId: venue.id, type: 'in', category: 'service', amount: total, description: `Comanda #${comanda.id.slice(-5)}`, method: paymentMethod || 'cash', comandaId: comanda.id, professionalId } });
  await tx.serviceVenue.update({ where: { id: venue.id }, data: { totalBilled: { increment: total } } }).catch(() => {});
  await tx.professional.update({ where: { id: professionalId }, data: { totalPaid: { increment: total } } }).catch(() => {});
  return comanda;
}

// Fechar conta de um agendamento (concluir + comanda com produtos + cashback)
router.post('/appointments/:id/checkout', authMiddleware, wrap(async (req, res) => {
  const ctx = await loadOwnedAppointment(req, res); if (!ctx) return;
  const { appt } = ctx;
  if (!appt.venueId) return res.status(400).json({ error: 'Agendamento sem estabelecimento' });
  if (appt.status === 'done') return res.status(400).json({ error: 'Já concluído' });
  const venue = await prisma.serviceVenue.findUnique({ where: { id: appt.venueId } });
  const b = req.body || {};
  const enabled = await cashbackOn();
  const out = await prisma.$transaction(async (tx) => {
    const comanda = await buildComanda(tx, {
      venue, professionalId: appt.professionalId, appointment: appt,
      services: [{ refId: appt.offerId, name: appt.serviceName, price: appt.price, qty: 1 }],
      products: b.products, discount: b.discount, paymentMethod: b.paymentMethod,
      clientUserId: appt.clientUserId, customerName: appt.customerName,
    });
    let cashback = 0;
    if (enabled && appt.clientUserId && venue.givesCashback) {
      cashback = round2(comanda.total); // 100% (1:1) do que o cliente pagou
      if (cashback > 0) {
        const u = await tx.user.update({ where: { id: appt.clientUserId }, data: { balance: { increment: cashback } } });
        await tx.transaction.create({ data: { type: 'cashback_service', amount: cashback, description: `Cashback: ${appt.serviceName}`, receiverId: appt.clientUserId, balanceAfter: u.balance, metadata: JSON.stringify({ comandaId: comanda.id }) } });
        await tx.comanda.update({ where: { id: comanda.id }, data: { tcEarned: cashback } });
      }
    }
    await tx.serviceAppointment.update({ where: { id: appt.id }, data: { status: 'done', doneAt: new Date(), tcEarned: cashback } });
    return { comanda, cashback };
  }, { timeout: 20000, maxWait: 10000 });
  res.json({ comanda: out.comanda, cashbackCredited: out.cashback, cashbackEnabled: enabled });
}));

// Comanda avulsa (cliente sem agendamento — walk-in)
router.post('/venues/:id/comanda', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  const b = req.body || {};
  const professionalId = b.professionalId;
  if (!professionalId) return res.status(400).json({ error: 'professionalId obrigatório' });
  const services = Array.isArray(b.services) ? b.services : [];
  if (!services.length && !(b.products || []).length) return res.status(400).json({ error: 'Adicione ao menos 1 item' });
  const comanda = await prisma.$transaction((tx) => buildComanda(tx, {
    venue: v, professionalId, appointment: null, services, products: b.products,
    discount: b.discount, paymentMethod: b.paymentMethod, customerName: b.customerName,
  }), { timeout: 20000, maxWait: 10000 });
  res.status(201).json(comanda);
}));

// ----- CAIXA -----
router.get('/venues/:id/cash', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  const date = req.query.date ? String(req.query.date) : new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
  const from = localToUtc(date, 0), to = localToUtc(date, 24 * 60);
  const entries = await prisma.cashEntry.findMany({ where: { venueId: v.id, createdAt: { gte: from, lt: to } }, orderBy: { createdAt: 'desc' } });
  const totalIn = round2(entries.filter((e) => e.type === 'in').reduce((a, e) => a + e.amount, 0));
  const totalOut = round2(entries.filter((e) => e.type === 'out').reduce((a, e) => a + e.amount, 0));
  res.json({ date, totalIn, totalOut, net: round2(totalIn - totalOut), count: entries.length, entries });
}));
router.post('/venues/:id/cash', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount inválido' });
  const e = await prisma.cashEntry.create({ data: { venueId: v.id, type: b.type === 'in' ? 'in' : 'out', category: b.category || (b.type === 'in' ? 'other' : 'expense'), amount, description: b.description || null, method: b.method || 'cash', createdById: req.userId } });
  res.status(201).json(e);
}));

// ----- RELATÓRIO -----
router.get('/venues/:id/report', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  const toStr = req.query.to ? String(req.query.to) : new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
  const fromStr = req.query.from ? String(req.query.from) : toStr;
  const from = localToUtc(fromStr, 0), to = localToUtc(toStr, 24 * 60);
  const comandas = await prisma.comanda.findMany({ where: { venueId: v.id, status: 'paid', paidAt: { gte: from, lt: to } }, include: { items: true } });
  const revenue = round2(comandas.reduce((a, c) => a + c.total, 0));
  const commission = round2(comandas.reduce((a, c) => a + c.commissionTotal, 0));
  const count = comandas.length;
  const ticket = count ? round2(revenue / count) : 0;
  const byPro = {}; const byService = {};
  for (const c of comandas) {
    byPro[c.professionalId] = byPro[c.professionalId] || { revenue: 0, commission: 0, count: 0 };
    byPro[c.professionalId].revenue = round2(byPro[c.professionalId].revenue + c.total);
    byPro[c.professionalId].commission = round2(byPro[c.professionalId].commission + c.commissionTotal);
    byPro[c.professionalId].count += 1;
    for (const it of c.items) { byService[it.name] = byService[it.name] || { qty: 0, total: 0 }; byService[it.name].qty += it.qty; byService[it.name].total = round2(byService[it.name].total + it.total); }
  }
  // nomes dos profissionais
  const proIds = Object.keys(byPro);
  const pros = await prisma.professional.findMany({ where: { id: { in: proIds } }, select: { id: true, displayName: true } });
  const byProfessional = pros.map((p) => ({ id: p.id, name: p.displayName, ...byPro[p.id] }));
  res.json({ from: fromStr, to: toStr, revenue, commission, count, ticket, byProfessional, byService });
}));

// ----- AVALIAÇÃO (NPS) -----
router.post('/appointments/:id/review', optionalAuth, wrap(async (req, res) => {
  const appt = await prisma.serviceAppointment.findUnique({ where: { id: req.params.id } });
  if (!appt) return res.status(404).json({ error: 'Agendamento não encontrado' });
  const rating = Math.max(1, Math.min(5, Number(req.body?.rating) || 0));
  if (!rating) return res.status(400).json({ error: 'rating 1..5' });
  const exists = await prisma.venueReview.findUnique({ where: { appointmentId: appt.id } }).catch(() => null);
  if (exists) return res.status(400).json({ error: 'Já avaliado' });
  const review = await prisma.venueReview.create({ data: { venueId: appt.venueId, professionalId: appt.professionalId, appointmentId: appt.id, clientUserId: appt.clientUserId, customerName: appt.customerName, rating, comment: req.body?.comment || null } });
  if (appt.venueId) {
    const agg = await prisma.venueReview.aggregate({ where: { venueId: appt.venueId }, _avg: { rating: true }, _count: true });
    await prisma.serviceVenue.update({ where: { id: appt.venueId }, data: { reviewRating: round2(agg._avg.rating || 0), reviewCount: agg._count } }).catch(() => {});
  }
  res.status(201).json(review);
}));

// ----- LISTA DE ESPERA -----
router.post('/waitlist', optionalAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.venueId || !b.customerName) return res.status(400).json({ error: 'venueId e customerName obrigatórios' });
  const w = await prisma.appointmentWaitlist.create({ data: { venueId: b.venueId, professionalId: b.professionalId || null, customerName: b.customerName, customerPhone: b.customerPhone || null, date: b.date ? localToUtc(String(b.date), 0) : null } });
  res.status(201).json(w);
}));
router.get('/venues/:id/waitlist', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  res.json(await prisma.appointmentWaitlist.findMany({ where: { venueId: v.id, status: 'waiting' }, orderBy: { createdAt: 'asc' } }));
}));
router.post('/venues/:id/waitlist/:wid/notify', authMiddleware, wrap(async (req, res) => {
  const v = await ownedVenue(req, res); if (!v) return;
  // TODO(skeleton): disparo real via WhatsApp exige aprovação (regra do projeto). Por ora só marca.
  await prisma.appointmentWaitlist.updateMany({ where: { id: req.params.wid, venueId: v.id }, data: { notified: true, status: 'notified' } });
  res.json({ ok: true, note: 'marcado como notificado (envio WhatsApp = TODO)' });
}));

module.exports = router;
