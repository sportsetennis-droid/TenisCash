// Agenda da equipe — pedidos do vendedor (folga/compromisso) + agenda do dia no grupo de WhatsApp.
// Dono 2026-11-16: "os colaboradores coloquem suas agendas para já saber quando será a sua folga,
// e a agenda já vá todos os dias cedo para o grupo de WhatsApp (canal de comunicação oficial)".
//
// - Pedido do vendedor fica em "AgendaRequest" (PENDENTE). Só vira AgendaActivity (que a escala,
//   a folha e o robô de produção leem) quando o dono APROVA — pedido não vira folga sozinho.
// - Todo dia 07:00 (America/Fortaleza) monta a agenda do dia e manda pro grupo pela Evolution.
//   "AgendaDailySend" garante 1 envio por dia (reinício/duas instâncias não duplicam).
// - Tabelas criadas por SQL aditivo/idempotente (o deploy não roda prisma db push).

const crypto = require('crypto');

const TZ = 'America/Fortaleza';
const REQUEST_TYPES = {
  folga: { label: 'Folga', activityType: 'folga', emoji: '🌴' },
  ferias: { label: 'Férias', activityType: 'ferias', emoji: '🏖️' },
  medico: { label: 'Consulta médica', activityType: 'outro', emoji: '🩺' },
  curso: { label: 'Curso / estudo', activityType: 'outro', emoji: '📚' },
  compromisso: { label: 'Compromisso pessoal', activityType: 'outro', emoji: '📌' },
};
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

let schemaReady = null;
function ensureAgendaSchema(prisma) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgendaRequest" (
        "id" TEXT PRIMARY KEY,
        "sellerId" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "date" TEXT NOT NULL,
        "endDate" TEXT,
        "startTime" TEXT,
        "endTime" TEXT,
        "note" TEXT,
        "status" TEXT NOT NULL DEFAULT 'PENDENTE',
        "activityId" TEXT,
        "decidedById" TEXT,
        "decidedAt" TIMESTAMP(3),
        "decisionNote" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
      )`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgendaRequest_seller_idx" ON "AgendaRequest" ("sellerId", "date")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgendaRequest_status_idx" ON "AgendaRequest" ("status", "date")`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgendaDailySend" (
        "day" TEXT PRIMARY KEY,
        "sentAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
        "ok" BOOLEAN NOT NULL DEFAULT false,
        "error" TEXT,
        "message" TEXT
      )`);
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

function todayYmd(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: TZ });
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10);
}
function dow(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); }
function br(ymd) { return ymd.split('-').reverse().slice(0, 2).join('/'); }
function validYmd(v) {
  if (!YMD_RE.test(String(v || ''))) return false;
  const d = new Date(v + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return parts.slice(0, 2).map(cap).join(' ');
}
function ymdOfDate(dt) { return new Date(dt).toISOString().slice(0, 10); }
function covers(act, ymd) {
  const a = ymdOfDate(act.date);
  const b = act.endDate ? ymdOfDate(act.endDate) : a;
  return ymd >= a && ymd <= b;
}

// Valida e normaliza um pedido do vendedor. Devolve { error } ou { data }.
function normalizeRequest(body, todayRef = todayYmd()) {
  const b = body || {};
  const type = String(b.type || '').toLowerCase();
  if (!REQUEST_TYPES[type]) return { error: 'Escolha o tipo.' };
  const date = String(b.date || '').trim();
  if (!validYmd(date)) return { error: 'Data inválida.' };
  if (date < todayRef) return { error: 'A data já passou.' };
  let endDate = String(b.endDate || '').trim() || null;
  if (endDate) {
    if (!validYmd(endDate)) return { error: 'Data final inválida.' };
    if (endDate < date) return { error: 'A data final é antes da inicial.' };
    if (endDate === date) endDate = null;
    else if ((new Date(endDate) - new Date(date)) / 86400000 > 45) return { error: 'Período máximo de 45 dias.' };
  }
  const startTime = String(b.startTime || '').trim() || null;
  const endTime = String(b.endTime || '').trim() || null;
  if ((startTime && !TIME_RE.test(startTime)) || (endTime && !TIME_RE.test(endTime))) return { error: 'Horário inválido.' };
  if (startTime && endTime && startTime >= endTime) return { error: 'Horário final antes do inicial.' };
  const note = String(b.note || '').trim().slice(0, 300) || null;
  const title = String(b.title || '').trim().slice(0, 120) || REQUEST_TYPES[type].label;
  return { data: { type, title, date, endDate, startTime, endTime, note } };
}

async function createRequest(prisma, sellerId, body) {
  await ensureAgendaSchema(prisma);
  const n = normalizeRequest(body);
  if (n.error) return n;
  const d = n.data;
  const id = crypto.randomUUID();
  await prisma.$executeRaw`INSERT INTO "AgendaRequest" ("id","sellerId","type","title","date","endDate","startTime","endTime","note")
    VALUES (${id}, ${sellerId}, ${d.type}, ${d.title}, ${d.date}, ${d.endDate}, ${d.startTime}, ${d.endTime}, ${d.note})`;
  return { request: { id, sellerId, status: 'PENDENTE', ...d } };
}

async function listRequests(prisma, { sellerId = null, status = null, fromYmd = null } = {}) {
  await ensureAgendaSchema(prisma);
  const rows = await prisma.$queryRaw`SELECT * FROM "AgendaRequest"
    WHERE (${sellerId}::text IS NULL OR "sellerId" = ${sellerId})
      AND (${status}::text IS NULL OR "status" = ${status})
      AND (${fromYmd}::text IS NULL OR COALESCE("endDate","date") >= ${fromYmd})
    ORDER BY "date" ASC, "createdAt" ASC LIMIT 300`;
  return rows;
}

async function cancelRequest(prisma, sellerId, id) {
  await ensureAgendaSchema(prisma);
  const n = await prisma.$executeRaw`UPDATE "AgendaRequest" SET "status"='CANCELADO', "decidedAt"=NOW()
    WHERE "id"=${id} AND "sellerId"=${sellerId} AND "status"='PENDENTE'`;
  return n > 0;
}

// Dono decide. Aprovar cria a AgendaActivity (é ela que a escala/folha/grupo enxergam).
async function decideRequest(prisma, id, approve, adminId, decisionNote = null) {
  await ensureAgendaSchema(prisma);
  const [reqRow] = await prisma.$queryRaw`SELECT * FROM "AgendaRequest" WHERE "id"=${id} LIMIT 1`;
  if (!reqRow) return { error: 'Pedido não encontrado.', status: 404 };
  if (reqRow.status !== 'PENDENTE') return { error: 'Esse pedido já foi decidido.', status: 409 };
  const note = decisionNote ? String(decisionNote).slice(0, 300) : null;
  if (!approve) {
    await prisma.$executeRaw`UPDATE "AgendaRequest" SET "status"='RECUSADO', "decidedById"=${adminId}, "decidedAt"=NOW(), "decisionNote"=${note}
      WHERE "id"=${id} AND "status"='PENDENTE'`;
    return { ok: true, status: 'RECUSADO' };
  }
  const t = REQUEST_TYPES[reqRow.type] || REQUEST_TYPES.compromisso;
  const activity = await prisma.agendaActivity.create({
    data: {
      title: reqRow.title || t.label,
      type: t.activityType,
      date: new Date(reqRow.date + 'T12:00:00Z'),
      endDate: reqRow.endDate ? new Date(reqRow.endDate + 'T12:00:00Z') : null,
      allDay: !(reqRow.startTime || reqRow.endTime),
      startTime: reqRow.startTime || null,
      endTime: reqRow.endTime || null,
      sellerId: reqRow.sellerId,
      note: [reqRow.note, 'Pedido do vendedor pelo app'].filter(Boolean).join(' · '),
    },
  });
  const changed = await prisma.$executeRaw`UPDATE "AgendaRequest" SET "status"='APROVADO', "activityId"=${activity.id}, "decidedById"=${adminId}, "decidedAt"=NOW(), "decisionNote"=${note}
    WHERE "id"=${id} AND "status"='PENDENTE'`;
  if (!changed) { await prisma.agendaActivity.delete({ where: { id: activity.id } }).catch(() => {}); return { error: 'Esse pedido já foi decidido.', status: 409 }; }
  return { ok: true, status: 'APROVADO', activityId: activity.id };
}

// Monta a agenda de um dia: quem trabalha em cada loja, quem está de folga, atividades e próximas folgas.
async function buildDay(prisma, ymd = todayYmd()) {
  const start = new Date(ymd + 'T00:00:00Z');
  const end = new Date(ymd + 'T23:59:59Z');
  const horizon = addDays(ymd, 7);
  const month = ymd.slice(0, 7);
  const [published, acts] = await Promise.all([
    prisma.sellerMonthlySchedule.findFirst({ where: { month, status: 'PUBLISHED' }, select: { id: true } }),
    prisma.agendaActivity.findMany({
      where: { date: { lte: new Date(horizon + 'T23:59:59Z') }, OR: [{ endDate: { gte: start } }, { endDate: null, date: { gte: start } }] },
      include: { seller: { select: { id: true, name: true } }, store: { select: { id: true, code: true, name: true } } },
      orderBy: { date: 'asc' },
    }),
  ]);
  let shifts;
  if (published) {
    shifts = await prisma.sellerMonthlyShift.findMany({
      where: { scheduleId: published.id, workDate: { gte: start, lte: end } },
      include: { seller: { select: { id: true, name: true } }, store: { select: { id: true, code: true, name: true } } },
    });
  } else {
    shifts = await prisma.sellerSchedule.findMany({
      where: { active: true, weekday: dow(ymd), seller: { role: 'seller', active: true }, store: { active: true } },
      include: { seller: { select: { id: true, name: true } }, store: { select: { id: true, code: true, name: true } } },
    });
    // Escala informada pelo próprio vendedor (link do WhatsApp) vence a fixa naquele dia.
    const self = await require('./selfSchedule').shiftsMap(prisma, ymd, ymd).catch(() => ({}));
    const ids = Object.keys(self);
    if (ids.length) {
      const users = await prisma.user.findMany({ where: { id: { in: ids }, role: 'seller', active: true }, select: { id: true, name: true, store: { select: { id: true, code: true, name: true } } } });
      shifts = shifts.filter((x) => !self[x.sellerId]);
      for (const u of users) {
        const x = self[u.id][ymd];
        shifts.push({ sellerId: u.id, storeId: u.store ? u.store.id : null, startTime: x.start, endTime: x.end, seller: { id: u.id, name: u.name }, store: u.store });
      }
    }
  }
  const todayActs = acts.filter((a) => covers(a, ymd));
  const absentTypes = ['folga', 'ferias'];
  const absentSellerIds = new Set(todayActs.filter((a) => absentTypes.includes(a.type) && a.sellerId).map((a) => a.sellerId));
  const holidayStoreIds = new Set(todayActs.filter((a) => a.type === 'feriado' && a.storeId).map((a) => a.storeId));
  const generalHoliday = todayActs.find((a) => a.type === 'feriado' && !a.storeId && !a.sellerId) || null;

  const byStore = new Map();
  for (const s of shifts) {
    if (absentSellerIds.has(s.sellerId)) continue;
    const key = s.storeId;
    if (!byStore.has(key)) byStore.set(key, { code: s.store ? s.store.code : '?', name: s.store ? s.store.name : 'Loja', people: [] });
    byStore.get(key).people.push({ name: shortName(s.seller && s.seller.name), start: require('./storeHours').clampStart(s.store, s.startTime), end: s.endTime });
  }
  const stores = [...byStore.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  stores.forEach((st) => st.people.sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.name.localeCompare(b.name)));

  const off = todayActs.filter((a) => absentTypes.includes(a.type) && a.seller).map((a) => ({
    name: shortName(a.seller.name), type: a.type, until: a.endDate && ymdOfDate(a.endDate) > ymd ? ymdOfDate(a.endDate) : null,
  }));
  const events = todayActs.filter((a) => !absentTypes.includes(a.type)).map((a) => ({
    type: a.type, title: a.title, time: a.startTime ? a.startTime + (a.endTime ? '–' + a.endTime : '') : null,
    who: a.seller ? shortName(a.seller.name) : null, store: a.store ? a.store.code : null,
  }));
  const upcoming = [];
  for (const a of acts) {
    if (!absentTypes.includes(a.type) || !a.seller) continue;
    const first = ymdOfDate(a.date);
    if (first <= ymd || first > horizon) continue;
    upcoming.push({ ymd: first, name: shortName(a.seller.name), type: a.type, until: a.endDate ? ymdOfDate(a.endDate) : null });
  }
  upcoming.sort((a, b) => a.ymd.localeCompare(b.ymd) || a.name.localeCompare(b.name));
  return { ymd, source: published ? 'escala publicada' : 'escala fixa', stores, off, events, upcoming, generalHoliday: generalHoliday ? generalHoliday.title : null, holidayStoreIds: [...holidayStoreIds] };
}

function formatMessage(day) {
  const L = [];
  L.push(`📅 *Agenda de hoje — ${WEEKDAYS[dow(day.ymd)]}, ${br(day.ymd)}*`);
  if (day.generalHoliday) L.push(`\n🎉 *Feriado:* ${day.generalHoliday}`);
  if (day.stores.length) {
    for (const st of day.stores) {
      L.push(`\n🏬 *${st.name}*`);
      for (const p of st.people) L.push(`• ${p.name} — ${p.start} às ${p.end}`);
    }
  } else {
    L.push('\nNenhuma escala lançada para hoje.');
  }
  if (day.off.length) {
    L.push('\n🌴 *De folga hoje*');
    for (const o of day.off) L.push(`• ${o.name}${o.type === 'ferias' ? ' (férias' + (o.until ? ' até ' + br(o.until) : '') + ')' : (o.until ? ' (até ' + br(o.until) + ')' : '')}`);
  }
  if (day.events.length) {
    L.push('\n📌 *Na agenda*');
    for (const e of day.events) L.push(`• ${e.title}${e.time ? ' — ' + e.time : ''}${e.who ? ' · ' + e.who : ''}${e.store ? ' · ' + e.store : ''}`);
  }
  if (day.upcoming.length) {
    L.push('\n🗓️ *Próximas folgas*');
    for (const u of day.upcoming) L.push(`• ${WEEKDAYS_SHORT[dow(u.ymd)]} ${br(u.ymd)} — ${u.name}${u.type === 'ferias' ? ' (férias' + (u.until ? ' até ' + br(u.until) : '') + ')' : (u.until && u.until !== u.ymd ? ' (até ' + br(u.until) + ')' : '')}`);
  }
  L.push('\nPara pedir folga ou marcar compromisso: app TenisCash › Escala e folgas.');
  return L.join('\n');
}

function hasContent(day) {
  return !!(day.stores.length || day.off.length || day.events.length || day.generalHoliday);
}

function groupJid() {
  return String(process.env.EVOLUTION_GRUPO_AGENDA || process.env.EVOLUTION_GRUPO_VENDEDORES || '120363418791122078@g.us').trim();
}

// Envia a agenda do dia pro grupo. force=true (botão do dono) reenvia mesmo se já foi hoje.
async function sendDaily(prisma, { ymd = todayYmd(), force = false } = {}) {
  if (String(process.env.AGENDA_WHATSAPP || '').toLowerCase() === 'off') return { skipped: 'AGENDA_WHATSAPP=off' };
  await ensureAgendaSchema(prisma);
  const day = await buildDay(prisma, ymd);
  if (!hasContent(day)) return { skipped: 'sem escala nem agenda para o dia', ymd };
  const message = formatMessage(day);
  if (!force) {
    // 1 envio por dia; se a tentativa anterior FALHOU (instância fora), a próxima rodada tenta de novo.
    const claimed = await prisma.$executeRaw`INSERT INTO "AgendaDailySend" ("day","message") VALUES (${ymd}, ${message})
      ON CONFLICT ("day") DO UPDATE SET "sentAt"=NOW(), "error"=NULL
      WHERE "AgendaDailySend"."ok" = false AND "AgendaDailySend"."error" IS NOT NULL`;
    if (!claimed) return { skipped: 'já enviado hoje', ymd };
  }
  const { sendEvolutionRaw } = require('../whatsapp');
  const r = await sendEvolutionRaw(groupJid(), message).catch((e) => ({ ok: false, error: e.message }));
  await prisma.$executeRaw`INSERT INTO "AgendaDailySend" ("day","ok","error","message","sentAt") VALUES (${ymd}, ${!!r.ok}, ${r.ok ? null : String(r.error || 'erro')}, ${message}, NOW())
    ON CONFLICT ("day") DO UPDATE SET "ok"=EXCLUDED."ok", "error"=EXCLUDED."error", "message"=EXCLUDED."message", "sentAt"=NOW()`;
  return { ok: !!r.ok, error: r.ok ? null : r.error, ymd };
}

async function lastSend(prisma) {
  await ensureAgendaSchema(prisma);
  const [row] = await prisma.$queryRaw`SELECT "day","sentAt","ok","error" FROM "AgendaDailySend" ORDER BY "day" DESC LIMIT 1`;
  return row || null;
}

module.exports = {
  REQUEST_TYPES, ensureAgendaSchema, todayYmd, normalizeRequest, createRequest, listRequests, cancelRequest,
  decideRequest, buildDay, formatMessage, hasContent, sendDaily, lastSend, groupJid,
};
