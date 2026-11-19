// =====================================================================
// Calendário da equipe: feed .ics pessoal por vendedor.
// ---------------------------------------------------------------------
// O vendedor assina o link no Google Agenda / Apple Calendário / Outlook e
// vê os turnos da escala PUBLICADA do mês (mês sem escala publicada não gera
// turno — não se presume horário) e as
// folgas/férias/compromissos APROVADOS (AgendaActivity). Pedido PENDENTE não
// entra — pedido não vira folga sozinho.
//
// Link: /api/team-calendar/feed/<token>.ics, sem login (app de calendário não
// faz login). token = idDoVendedor.versão.HMAC — não fica salvo no banco; a
// tabela "TeamCalendarFeed" guarda só a versão. "Gerar novo link" sobe a
// versão e o link antigo para de funcionar.
// Fuso: America/Fortaleza (UTC-3 fixo, sem horário de verão).
// =====================================================================

const crypto = require('crypto');
const ical = require('ical-generator');
const { paraParede } = require('./icsTz');

const TZ = 'America/Fortaleza';
const TZ_OFFSET_HOURS = 3; // UTC-3 fixo
const PAST_DAYS = 14;
const FUTURE_DAYS = 60;
const ABSENT_TYPES = ['folga', 'ferias'];
const TYPE_LABEL = {
  folga: 'Folga', ferias: 'Férias', treinamento: 'Treinamento', reuniao: 'Reunião', feriado: 'Feriado',
  meta: 'Meta', evento: 'Evento', outro: 'Compromisso',
};

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:America/Fortaleza',
  'X-LIC-LOCATION:America/Fortaleza',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:-0300',
  'TZOFFSETTO:-0300',
  'TZNAME:-03',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

function secret(env = process.env) {
  return env.TEAM_CALENDAR_SECRET || env.JWT_SECRET || 'teniscash-secret-change-in-production';
}

function sign(sellerId, version, env) {
  return crypto.createHmac('sha256', secret(env)).update(`team-calendar:${sellerId}:${version}`).digest('base64url').slice(0, 32);
}

function makeToken(sellerId, version, env) {
  return `${Buffer.from(String(sellerId)).toString('base64url')}.${version}.${sign(sellerId, version, env)}`;
}

// Devolve { sellerId, version } se a assinatura bate; senão null.
function parseToken(token, env) {
  const m = /^([A-Za-z0-9_-]{4,120})\.(\d{1,6})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  let sellerId;
  try { sellerId = Buffer.from(m[1], 'base64url').toString('utf8'); } catch (_) { return null; }
  const version = Number(m[2]);
  const expected = sign(sellerId, version, env);
  const a = Buffer.from(expected);
  const b = Buffer.from(m[3]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { sellerId, version };
}

// Cria (ou, com rotate, troca) o link pessoal. Devolve o token.
async function issueToken(prisma, sellerId, { rotate = false, env } = {}) {
  const rows = await prisma.$queryRaw`SELECT "version" FROM "TeamCalendarFeed" WHERE "sellerId" = ${sellerId} LIMIT 1`;
  let version;
  if (!rows.length) {
    await prisma.$executeRaw`INSERT INTO "TeamCalendarFeed" ("sellerId","version") VALUES (${sellerId}, 1) ON CONFLICT ("sellerId") DO NOTHING`;
    const again = await prisma.$queryRaw`SELECT "version" FROM "TeamCalendarFeed" WHERE "sellerId" = ${sellerId} LIMIT 1`;
    version = Number(again[0].version);
  } else if (rotate) {
    const up = await prisma.$queryRaw`UPDATE "TeamCalendarFeed" SET "version" = "version" + 1, "rotatedAt" = NOW() WHERE "sellerId" = ${sellerId} RETURNING "version"`;
    version = Number(up[0].version);
  } else {
    version = Number(rows[0].version);
  }
  return makeToken(sellerId, version, env);
}

async function resolveToken(prisma, token, env) {
  const parsed = parseToken(token, env);
  if (!parsed) return null;
  const rows = await prisma.$queryRaw`SELECT "version" FROM "TeamCalendarFeed" WHERE "sellerId" = ${parsed.sellerId} LIMIT 1`;
  if (!rows.length || Number(rows[0].version) !== parsed.version) return null;
  const user = await prisma.user.findUnique({ where: { id: parsed.sellerId }, select: { id: true, name: true, role: true, active: true, storeId: true } });
  if (!user || user.active !== true) return null;
  return user;
}

// ---- datas ----
function todayYmd(now = new Date()) { return now.toLocaleDateString('en-CA', { timeZone: TZ }); }
function addDays(ymd, n) { return new Date(new Date(ymd + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10); }
function ymdOf(dt) { return new Date(dt).toISOString().slice(0, 10); }
// "HH:MM" no horário de Fortaleza → instante UTC.
function localToUtc(ymd, hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const [y, mo, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, (h || 0) + TZ_OFFSET_HOURS, m || 0));
}
function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Junta o que vai no calendário do vendedor (só leitura).
async function collectEvents(prisma, seller, { now = new Date() } = {}) {
  const today = todayYmd(now);
  const from = addDays(today, -PAST_DAYS);
  const to = addDays(today, FUTURE_DAYS);
  const fromDt = new Date(from + 'T00:00:00Z');
  const toDt = new Date(to + 'T23:59:59Z');
  const months = [...new Set(eachDay(from, to).map((d) => d.slice(0, 7)))];

  const [published, fixed, acts] = await Promise.all([
    prisma.sellerMonthlySchedule.findMany({ where: { month: { in: months }, status: 'PUBLISHED' }, select: { id: true, month: true } }),
    prisma.sellerSchedule.findMany({ where: { sellerId: seller.id, active: true }, include: { store: { select: { id: true, code: true, name: true } } } }),
    prisma.agendaActivity.findMany({
      where: {
        date: { lte: toDt },
        OR: [{ endDate: { gte: fromDt } }, { endDate: null, date: { gte: fromDt } }],
        AND: [{ OR: [{ sellerId: seller.id }, { sellerId: null }] }],
      },
      include: { store: { select: { id: true, code: true, name: true } } },
      orderBy: { date: 'asc' },
    }),
  ]);
  const publishedMonths = new Map(published.map((p) => [p.month, p.id]));
  const shifts = publishedMonths.size ? await prisma.sellerMonthlyShift.findMany({
    where: { sellerId: seller.id, scheduleId: { in: [...publishedMonths.values()] }, workDate: { gte: fromDt, lte: toDt } },
    include: { store: { select: { id: true, code: true, name: true } } },
  }) : [];

  // Lojas do vendedor (pra mostrar evento/feriado de loja sem vendedor).
  const myStores = new Set([seller.storeId, ...fixed.map((f) => f.storeId), ...shifts.map((s) => s.storeId)].filter(Boolean));
  const mine = acts.filter((a) => a.sellerId === seller.id || (!a.sellerId && (!a.storeId || myStores.has(a.storeId))));
  const absentDays = new Set();
  for (const a of mine) {
    if (!(a.sellerId === seller.id && ABSENT_TYPES.includes(a.type))) continue;
    const end = a.endDate ? ymdOf(a.endDate) : ymdOf(a.date);
    for (const d of eachDay(ymdOf(a.date), end)) absentDays.add(d);
  }

  const events = [];
  // Turnos da escala publicada
  for (const s of shifts) {
    const d = ymdOf(s.workDate);
    if (absentDays.has(d)) continue;
    events.push({
      id: `turno-${s.id}`, kind: 'turno', allDay: false,
      start: localToUtc(d, s.startTime), end: localToUtc(d, s.endTime),
      summary: `Turno · ${s.store ? s.store.name : 'Loja'}`,
      location: s.store ? s.store.name : null,
      description: ['Escala publicada', s.note].filter(Boolean).join(' · '),
    });
  }
  // Mês sem escala publicada: NÃO presume turno (mesma regra da tela "Escala e folgas"
  // do vendedor: "o sistema não presume datas nem horários"). A escala fixa só serve
  // para saber as lojas do vendedor (feriado/evento da loja).
  // Folgas/férias/compromissos aprovados + eventos da loja/gerais
  for (const a of mine) {
    const label = TYPE_LABEL[a.type] || 'Agenda';
    const first = ymdOf(a.date);
    const last = a.endDate ? ymdOf(a.endDate) : first;
    const timed = !a.allDay && a.startTime;
    events.push({
      id: `agenda-${a.id}`, kind: a.type, allDay: !timed,
      start: timed ? localToUtc(first, a.startTime) : new Date(first + 'T12:00:00Z'),
      end: timed ? localToUtc(first, a.endTime || a.startTime) : new Date(addDays(last, 1) + 'T12:00:00Z'),
      summary: a.title && a.title !== label ? `${label} · ${a.title}` : label,
      location: a.store ? a.store.name : null,
      description: a.note || null,
    });
  }
  events.sort((x, y) => x.start - y.start);
  return { from, to, events };
}

function buildIcs(seller, collected, { now = new Date(), host = 'teniscash.com.br' } = {}) {
  const make = ical.default || ical;
  const firstName = String(seller.name || 'Vendedor').trim().split(/\s+/)[0];
  const cal = make({
    name: `Escala Sports & Tennis · ${firstName}`,
    prodId: { company: 'Sports & Tennis', product: 'TenisCash Escala', language: 'PT' },
    ttl: 60 * 60, // apps de calendário: atualizar de hora em hora
  });
  cal.timezone({ name: TZ, generator: () => VTIMEZONE });
  for (const e of collected.events) {
    cal.createEvent({
      id: `${e.id}@${host}`,
      start: e.allDay ? e.start : paraParede(e.start),
      end: e.allDay ? e.end : paraParede(e.end),
      allDay: e.allDay,
      timezone: e.allDay ? undefined : TZ,
      stamp: now,
      summary: e.summary,
      location: e.location || undefined,
      description: e.description || undefined,
    });
  }
  // RFC 5545: DTSTAMP é sempre UTC (a lib escreve no fuso do calendário).
  const out = cal.toString().replace(/^DTSTAMP:.*$/gm, 'DTSTAMP:' + utcStamp(now));
  return out.endsWith('\r\n') ? out : out + '\r\n'; // toda linha termina em CRLF (RFC 5545)
}

module.exports = {
  TZ, makeToken, parseToken, issueToken, resolveToken, collectEvents, buildIcs, localToUtc,
};
