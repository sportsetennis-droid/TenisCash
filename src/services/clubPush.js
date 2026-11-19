// =====================================================================
// Club — Push no celular (Web Push) + preferências + lembrete de jogo.
// ---------------------------------------------------------------------
// Reaproveita o Web Push do varejo:
//  - chaves VAPID: as MESMAS já salvas no banco (Config "vapid_public" /
//    "vapid_private"; assunto opcional em env VAPID_SUBJECT) via
//    pushNotifications.ensureVapidKeys(). Nada de chave nova.
//  - tabela PushSubscription: inscrições do Club levam app = 'club'
//    (o envio do Club só vai pra elas; o varejo segue igual).
// O notify.js chama sendPush() depois de gravar o aviso in-app.
// Preferências: liga/desliga geral + por tipo. Padrão = tudo ligado.
// iOS: só recebe push com o app INSTALADO na Tela de Início (iOS 16.4+).
// =====================================================================

const { PrismaClient } = require('@prisma/client');

let prisma = new PrismaClient();
function setPrisma(p) { prisma = p; }

const APP = 'club';
const PREF_TYPES = {
  game_soon: 'Jogo começando (30 min antes)',
  result: 'Resultado publicado',
  invite: 'Convites (time e clube)',
  entry: 'Inscrição (pedido e aprovação)',
  challenge: 'Desafios 1x1',
  schedule: 'Jogo agendado / horário',
  training: 'Treinos',
  info: 'Outros avisos',
};
const TYPE_MAP = { team: 'invite', club_invite: 'invite', club: 'invite' };

// Liga Aberta F4 — WhatsApp por TIPO (opt-in). O atleta liga só o que quer receber;
// padrão DESLIGADO (regra do projeto: nada de mensagem a cliente sem ele pedir).
// 'organizer' = avisos de quem ORGANIZA o campeonato (pedido de inscrição, reembolso,
// PIX sem vaga, torneio transferido): padrão ligado só para conta da EQUIPE
// (admin/gerente/vendedor) — é aviso operacional de quem trabalha; cliente liga se quiser.
const WA_TYPES = { ...PREF_TYPES, organizer: 'Organização do meu campeonato (pedidos de inscrição, reembolso)' };
const STAFF_ROLES = new Set(['admin', 'superadmin', 'manager', 'gerente', 'seller', 'assistant', 'store']);
function isStaffRole(role) { return STAFF_ROLES.has(String(role || '')); }
function waDefault(key, role) { return key === 'organizer' && isStaffRole(role); }
function waCategory(type, explicit) {
  if (explicit && WA_TYPES[explicit]) return explicit;
  return category(type);
}

function category(type) {
  const t = String(type || 'info');
  if (PREF_TYPES[t]) return t;
  return TYPE_MAP[t] || 'info';
}

async function userRole(userId) {
  const u = await prisma.user.findUnique({ where: { id: String(userId) }, select: { role: true } }).catch(() => null);
  return u ? u.role : null;
}

// role opcional (evita consulta quando quem chama já tem). WhatsApp: valor salvo vence;
// sem valor salvo = padrão (desligado; 'organizer' ligado só para a equipe).
async function getPrefs(userId, { role } = {}) {
  const row = await prisma.clubNotifyPref.findUnique({ where: { userId } }).catch(() => null);
  const types = {};
  const saved = (row && row.types && typeof row.types === 'object') ? row.types : {};
  for (const k of Object.keys(PREF_TYPES)) types[k] = saved[k] !== false;
  const r = role === undefined ? await userRole(userId) : role;
  const savedWa = (row && row.whatsapp && typeof row.whatsapp === 'object' && !Array.isArray(row.whatsapp)) ? row.whatsapp : {};
  const whatsapp = {};
  for (const k of Object.keys(WA_TYPES)) whatsapp[k] = typeof savedWa[k] === 'boolean' ? savedWa[k] : waDefault(k, r);
  return { push: row ? row.push !== false : true, types, labels: PREF_TYPES, whatsapp, whatsappLabels: WA_TYPES };
}

async function setPrefs(userId, input = {}) {
  const cur = await getPrefs(userId);
  const types = { ...cur.types };
  if (input.types && typeof input.types === 'object') {
    for (const [k, v] of Object.entries(input.types)) if (PREF_TYPES[k]) types[k] = !!v;
  }
  const push = input.push === undefined ? cur.push : !!input.push;
  const data = { push, types };
  if (input.whatsapp && typeof input.whatsapp === 'object' && !Array.isArray(input.whatsapp)) {
    const wa = { ...cur.whatsapp };
    for (const [k, v] of Object.entries(input.whatsapp)) if (WA_TYPES[k]) wa[k] = !!v;
    data.whatsapp = wa; // grava a escolha explícita (todas as chaves) — o padrão não muda mais por baixo
  }
  await prisma.clubNotifyPref.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
  return getPrefs(userId);
}

// Liga F4: o atleta ligou WhatsApp para esta categoria? (notify.js chama antes de enfileirar)
async function whatsappAllowed(userId, cat, { role } = {}) {
  const p = await getPrefs(userId, { role });
  return p.whatsapp[cat] === true;
}

// Link do aviso → URL que o toque na notificação abre
function toUrl(link) {
  const l = String(link || '');
  if (!l) return '/club.html#/avisos';
  if (/^https?:\/\//i.test(l)) return l;
  if (l.startsWith('/')) return l;
  if (l.startsWith('#')) return '/club.html' + l;
  return '/club.html#/' + l.replace(/^#?\/?/, '');
}

async function subscribe(userId, { endpoint, keys, userAgent } = {}) {
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) throw new Error('inscrição inválida');
  if (!/^https:\/\//i.test(String(endpoint))) throw new Error('endpoint inválido');
  const sub = await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId, p256dh: keys.p256dh, authKey: keys.auth, userAgent: userAgent || null, app: APP, lastUsedAt: new Date() },
    create: { userId, endpoint, p256dh: keys.p256dh, authKey: keys.auth, userAgent: userAgent || null, app: APP },
  });
  return { id: sub.id };
}

async function unsubscribe(userId, endpoint) {
  if (!endpoint) return { removed: 0 };
  const r = await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
  return { removed: r.count };
}

async function status(userId) {
  const subs = await prisma.pushSubscription.count({ where: { userId, app: APP } });
  return { subscriptions: subs, prefs: await getPrefs(userId) };
}

// ---------------------------------------------------------------- envio
const pending = new Set();
function track(p) { pending.add(p); p.finally(() => pending.delete(p)).catch(() => {}); return p; }
async function flush() { while (pending.size) await Promise.allSettled([...pending]); }

async function sendPushNow(userId, { type, title, body, link } = {}) {
  if (!userId) return { sent: 0, failed: 0, skipped: 'sem usuário' };
  const prefs = await getPrefs(userId, { role: null }); // push não depende do papel
  const cat = category(type);
  if (!prefs.push) return { sent: 0, failed: 0, skipped: 'push desligado' };
  if (prefs.types[cat] === false) return { sent: 0, failed: 0, skipped: 'tipo desligado: ' + cat };
  const subs = await prisma.pushSubscription.findMany({ where: { userId, app: APP } });
  if (!subs.length) return { sent: 0, failed: 0, skipped: 'sem inscrição' };

  const pushSvc = require('./pushNotifications');
  const ready = await pushSvc.ensureVapidKeys();
  if (!ready) return { sent: 0, failed: 0, skipped: 'web-push indisponível' };
  const wp = require('web-push');
  const payload = JSON.stringify({
    title: String(title || 'Club Sports & Tennis').slice(0, 120),
    body: String(body || '').slice(0, 300),
    url: toUrl(link),
    tag: 'club-' + cat,
    type: cat,
  });
  let sent = 0;
  let failed = 0;
  for (const s of subs) {
    try {
      await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.authKey } }, payload, { TTL: 3600 });
      sent += 1;
      await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    } catch (err) {
      failed += 1;
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      }
    }
  }
  return { sent, failed };
}

// Fire-and-forget (o notify não espera o push). Erro nunca propaga.
function sendPush(userId, payload) {
  return track(sendPushNow(userId, payload).catch((e) => {
    console.error('[clubPush] envio falhou:', e.message);
    return { sent: 0, failed: 0, error: e.message };
  }));
}

// ------------------------------------------------- lembrete 30 min antes
async function matchAudience(match) {
  const ids = new Set();
  for (const e of [match.homeEntry, match.awayEntry]) {
    if (!e) continue;
    for (const m of e.members || []) ids.add(m.userId);
    const roster = await prisma.rosterPlayer.findMany({ where: { entryId: e.id, userId: { not: null } }, select: { userId: true } });
    roster.forEach((r) => ids.add(r.userId));
    const tm = await prisma.teamMembership.findMany({ where: { tournamentId: match.tournamentId, clubName: e.name, status: 'ACTIVE' }, select: { userId: true } });
    tm.forEach((r) => ids.add(r.userId));
    // Clube permanente com vínculo EXPLÍCITO a essa inscrição (nome exato)
    const links = await prisma.clubTournamentLink.findMany({ where: { tournamentId: match.tournamentId, entryName: e.name }, select: { clubId: true } });
    if (links.length) {
      const ms = await prisma.clubMembership.findMany({ where: { clubId: { in: links.map((l) => l.clubId) }, status: 'ACTIVE' }, select: { userId: true } });
      ms.forEach((r) => ids.add(r.userId));
    }
  }
  return [...ids];
}

async function runGameSoon(now = new Date(), { minMinutes = 25, maxMinutes = 35 } = {}) {
  const from = new Date(now.getTime() + minMinutes * 60000);
  const to = new Date(now.getTime() + maxMinutes * 60000);
  const matches = await prisma.tournamentMatch.findMany({
    // Liga F1: torneio arquivado não manda push
    where: { status: 'SCHEDULED', scheduledAt: { gte: from, lt: to }, homeEntryId: { not: null }, awayEntryId: { not: null }, tournament: { archivedAt: null } },
    include: {
      tournament: { select: { name: true } },
      homeEntry: { select: { id: true, name: true, members: { select: { userId: true } } } },
      awayEntry: { select: { id: true, name: true, members: { select: { userId: true } } } },
    },
  });
  const { notifyMany } = require('./notify');
  let notified = 0;
  for (const m of matches) {
    try {
      await prisma.clubPushLog.create({ data: { key: 'game_soon:' + m.id } });
    } catch (_) { continue; } // já avisado (idempotente)
    const ids = await matchAudience(m);
    const hhmm = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit' }).format(m.scheduledAt);
    await notifyMany(ids, {
      type: 'game_soon',
      title: 'Seu jogo começa em 30 min',
      body: `${m.homeEntry.name} x ${m.awayEntry.name} às ${hhmm}${m.location ? ' · ' + m.location : ''} (${m.tournament.name}).`,
      link: '#/jogo/' + m.id,
    });
    notified += ids.length;
  }
  return { matches: matches.length, notified };
}

let cronStarted = false;
function startClubPushCron() {
  if (cronStarted) return;
  cronStarted = true;
  require('node-cron').schedule('*/5 * * * *', () => {
    runGameSoon().catch((e) => console.error('[clubPush] lembrete falhou:', e.message));
  }, { timezone: 'America/Fortaleza' });
}

module.exports = {
  setPrisma, APP, PREF_TYPES, WA_TYPES, category, waCategory, isStaffRole, whatsappAllowed, toUrl,
  getPrefs, setPrefs, subscribe, unsubscribe, status,
  sendPush, sendPushNow, flush, runGameSoon, matchAudience, startClubPushCron,
};
