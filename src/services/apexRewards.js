// =====================================================================
// APEX — Badges, XP e cashback por badge (o loop treina → ganha → compra)
// ---------------------------------------------------------------------
// • Badge = linha em BadgeEarned (@@unique userId+badgeKey → idempotente:
//   rodar a mesma atividade 2x nunca dá 2 badges nem 2 créditos).
// • Cashback por badge é CONFIGURÁVEL pelo admin (Config key
//   "apex_badge_cashback"). PADRÃO = 0 = DESLIGADO. Quando > 0, credita
//   User.balance + grava Transaction (type "credit", mesmo padrão da loja)
//   dentro da MESMA transação do badge, com TETO MENSAL por atleta.
// • Teto/mês é contado pelo mês de America/Fortaleza (UTC-3 fixo).
// • Aviso in-app (AppNotification) + web push. NÃO manda WhatsApp
//   (regra: nada de mensagem automática ao cliente).
// =====================================================================

const { prisma } = require('../middleware');

const CONFIG_KEY = 'apex_badge_cashback';
const CONFIG_ID = 'cfg_apex_badge_cashback';
const DEFAULT_CONFIG = Object.freeze({ amountPerBadge: 0, byBadge: {}, monthlyCap: 30 });
const TZ_OFFSET_H = 3; // America/Fortaleza = UTC-3, sem horário de verão

// Catálogo de badges (chave base → título + XP). Chaves com ":" são
// repetíveis por período/objeto (ex: month_100km:2026-11).
const BADGES = {
  first_activity: { title: 'Primeira atividade', xp: 50, icon: '🚀' },
  dist_5k: { title: '5 km numa atividade', xp: 50, icon: '5K' },
  dist_10k: { title: '10 km numa atividade', xp: 100, icon: '10K' },
  dist_21k: { title: 'Meia maratona', xp: 250, icon: '21K' },
  dist_42k: { title: 'Maratona', xp: 600, icon: '42K' },
  streak_7: { title: 'Sequência de 7 dias', xp: 150, icon: '🔥' },
  month_100km: { title: '100 km no mês', xp: 300, icon: '💯' },
  local_legend: { title: 'Local Legend', xp: 200, icon: '👑' },
  segment_pr: { title: 'Recorde pessoal em segmento', xp: 25, icon: 'PR' },
  challenge: { title: 'Desafio concluído', xp: 150, icon: '🏆' },
};
const DIST_SPORTS = new Set(['RUN', 'TRAIL_RUN', 'WALK', 'HIKE', 'TREADMILL']);

function badgeBase(key) { return String(key).split(':')[0]; }
function badgeInfo(key) { return BADGES[badgeBase(key)] || { title: key, xp: 0, icon: '★' }; }

// ----------------------------------------------------------- datas (UTC-3)
function localDay(d) { // 'YYYY-MM-DD' no fuso de Fortaleza
  return new Date(new Date(d).getTime() - TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
}
function localMonth(d) { return localDay(d).slice(0, 7); }
function monthStartUtc(d) {
  const [y, m] = localMonth(d).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1, TZ_OFFSET_H));
}
function monthEndUtc(d) {
  const [y, m] = localMonth(d).split('-').map(Number);
  return new Date(Date.UTC(y, m, 1, TZ_OFFSET_H));
}

// ----------------------------------------------------------------- config
async function getConfig(db = prisma) {
  const row = await db.config.findUnique({ where: { key: CONFIG_KEY } }).catch(() => null);
  if (!row) return { ...DEFAULT_CONFIG, byBadge: {} };
  try {
    const v = JSON.parse(row.value);
    return {
      amountPerBadge: Math.max(0, Number(v.amountPerBadge) || 0),
      byBadge: v.byBadge && typeof v.byBadge === 'object' ? v.byBadge : {},
      monthlyCap: Math.max(0, Number(v.monthlyCap ?? DEFAULT_CONFIG.monthlyCap) || 0),
    };
  } catch (_) { return { ...DEFAULT_CONFIG, byBadge: {} }; }
}

async function setConfig(input, adminId) {
  const cur = await getConfig();
  const next = {
    amountPerBadge: input.amountPerBadge !== undefined ? Number(input.amountPerBadge) : cur.amountPerBadge,
    byBadge: input.byBadge !== undefined ? input.byBadge : cur.byBadge,
    monthlyCap: input.monthlyCap !== undefined ? Number(input.monthlyCap) : cur.monthlyCap,
  };
  if (!Number.isFinite(next.amountPerBadge) || next.amountPerBadge < 0 || next.amountPerBadge > 500) throw new Error('amountPerBadge deve estar entre 0 e 500');
  if (!Number.isFinite(next.monthlyCap) || next.monthlyCap < 0 || next.monthlyCap > 5000) throw new Error('monthlyCap deve estar entre 0 e 5000');
  if (typeof next.byBadge !== 'object' || Array.isArray(next.byBadge) || next.byBadge === null) throw new Error('byBadge deve ser objeto {badge: valor}');
  const clean = {};
  for (const [k, v] of Object.entries(next.byBadge)) {
    if (!BADGES[k]) throw new Error(`badge desconhecido: ${k}`);
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 500) throw new Error(`valor inválido pra ${k}`);
    clean[k] = n;
  }
  next.byBadge = clean;
  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    create: { id: CONFIG_ID, key: CONFIG_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  if (adminId) {
    await prisma.adminAction.create({
      data: { adminId, action: 'apex_badge_cashback_update', description: `APEX cashback por badge: ${JSON.stringify(next)}` },
    }).catch(() => {});
  }
  return next;
}

function cashbackFor(cfg, key) {
  const base = badgeBase(key);
  if (Object.prototype.hasOwnProperty.call(cfg.byBadge || {}, base)) return Number(cfg.byBadge[base]) || 0;
  return Number(cfg.amountPerBadge) || 0;
}

// ---------------------------------------------------------------- avisos
async function notifyBadge(userId, key, xp, cash) {
  const info = badgeInfo(key);
  const body = `${info.title} · +${xp} XP` + (cash > 0 ? ` · +T$ ${cash.toFixed(2)} de cashback` : '');
  try {
    const { notify } = require('./notify');
    await notify(userId, { type: 'badge', title: 'Nova conquista!', body, link: '/atividade.html#/conquistas' }, { whatsapp: false });
  } catch (_) {}
  try {
    const push = require('./pushNotifications');
    push.sendToUser(userId, { title: 'Nova conquista!', body, url: '/atividade.html#/conquistas' }).catch(() => {});
  } catch (_) {}
}

/**
 * Concede um badge (idempotente). Credita cashback se configurado (> 0),
 * respeitando o teto mensal. Retorna o badge criado ou null se já tinha.
 */
async function awardBadge(userId, key, { metadata = null, at = new Date(), silent = false } = {}) {
  const info = badgeInfo(key);
  const cfg = await getConfig();
  let created = null;
  try {
    created = await prisma.$transaction(async (tx) => {
      // trava por atleta: duas ingestões simultâneas não estouram o teto
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `apex_badge:${userId}`);
      const exists = await tx.badgeEarned.findUnique({ where: { userId_badgeKey: { userId, badgeKey: key } } });
      if (exists) return null;
      const badge = await tx.badgeEarned.create({
        data: { userId, badgeKey: key, xpAwarded: info.xp, earnedAt: at, metadata: metadata || undefined },
      });
      let amount = cashbackFor(cfg, key);
      if (amount > 0) {
        const used = await tx.badgeEarned.aggregate({
          where: { userId, earnedAt: { gte: monthStartUtc(at), lt: monthEndUtc(at) } },
          _sum: { cashbackAwarded: true },
        });
        const room = Math.max(0, cfg.monthlyCap - (used._sum.cashbackAwarded || 0));
        amount = Math.round(Math.min(amount, room) * 100) / 100;
      }
      if (amount > 0) {
        const u = await tx.user.update({ where: { id: userId }, data: { balance: { increment: amount } }, select: { balance: true } });
        const t = await tx.transaction.create({
          data: {
            type: 'credit',
            amount,
            description: `Cashback APEX — ${info.title}`,
            receiverId: userId,
            balanceAfter: u.balance,
            metadata: JSON.stringify({ source: 'apex_badge', badgeKey: key, badgeId: badge.id }),
          },
        });
        return tx.badgeEarned.update({
          where: { id: badge.id },
          data: { cashbackAwarded: amount, metadata: { ...(metadata || {}), transactionId: t.id } },
        });
      }
      return badge;
    });
  } catch (e) {
    if (e && e.code === 'P2002') return null; // corrida: outro processo já gravou
    throw e;
  }
  if (created && !silent) notifyBadge(userId, key, created.xpAwarded, created.cashbackAwarded).catch(() => {});
  return created;
}

/**
 * Avalia as regras automáticas depois de gravar uma atividade.
 * Retorna a lista de badges novos.
 */
async function evaluateActivityBadges(activity) {
  const out = [];
  const uid = activity.userId;
  const push = (b) => { if (b) out.push(b); };
  const meta = { activityId: activity.id };

  push(await awardBadge(uid, 'first_activity', { metadata: meta }));

  const d = Number(activity.distanceM) || 0;
  if (DIST_SPORTS.has(activity.sportType)) {
    for (const [km, key] of [[5, 'dist_5k'], [10, 'dist_10k'], [21.0975, 'dist_21k'], [42.195, 'dist_42k']]) {
      if (d >= km * 1000) push(await awardBadge(uid, key, { metadata: meta }));
    }
  }

  // 100 km no mês (soma das atividades do mês de Fortaleza)
  const month = await prisma.activity.aggregate({
    where: { userId: uid, processingState: 'done', startedAt: { gte: monthStartUtc(activity.startedAt), lt: monthEndUtc(activity.startedAt) } },
    _sum: { distanceM: true },
  });
  if ((month._sum.distanceM || 0) >= 100000) {
    push(await awardBadge(uid, `month_100km:${localMonth(activity.startedAt)}`, { metadata: meta }));
  }

  // Sequência de 7 dias: concede quando a sequência que contém o dia da
  // atividade atinge EXATAMENTE 7 dias contando do início (chave = dia inicial).
  const since = new Date(new Date(activity.startedAt).getTime() - 15 * 86400e3);
  const until = new Date(new Date(activity.startedAt).getTime() + 15 * 86400e3);
  const recent = await prisma.activity.findMany({
    where: { userId: uid, processingState: 'done', startedAt: { gte: since, lte: until } },
    select: { startedAt: true },
  });
  const days = new Set(recent.map((a) => localDay(a.startedAt)));
  const dayMs = 86400e3;
  const toDate = (s) => new Date(s + 'T12:00:00Z').getTime();
  let start = toDate(localDay(activity.startedAt));
  while (days.has(new Date(start - dayMs).toISOString().slice(0, 10))) start -= dayMs;
  let len = 0;
  while (days.has(new Date(start + len * dayMs).toISOString().slice(0, 10))) len++;
  if (len >= 7) push(await awardBadge(uid, `streak_7:${new Date(start).toISOString().slice(0, 10)}`, { metadata: meta }));

  return out;
}

async function userSummary(userId) {
  const badges = await prisma.badgeEarned.findMany({ where: { userId }, orderBy: { earnedAt: 'desc' } });
  const xp = badges.reduce((s, b) => s + (b.xpAwarded || 0), 0);
  const level = Math.floor(Math.sqrt(xp / 50)) + 1; // nível 2 = 50 XP, 3 = 200, 4 = 450...
  const nextLevelXp = 50 * level * level;
  return {
    xp, level, nextLevelXp,
    cashbackTotal: Math.round(badges.reduce((s, b) => s + (b.cashbackAwarded || 0), 0) * 100) / 100,
    badges: badges.map((b) => ({ ...b, ...badgeInfo(b.badgeKey), key: b.badgeKey })),
  };
}

module.exports = {
  BADGES, CONFIG_KEY, DEFAULT_CONFIG,
  getConfig, setConfig, awardBadge, evaluateActivityBadges, userSummary, badgeInfo,
  localDay, localMonth, monthStartUtc, monthEndUtc,
};
