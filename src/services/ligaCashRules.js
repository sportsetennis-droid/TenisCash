// =====================================================================
// Liga Aberta F7 — TenisCash POR CONQUISTA (título, vice, artilharia)
// ---------------------------------------------------------------------
// Configuração por torneio (tabela TournamentCashConfig): o FUNDADOR (ação MONEY) escreve
// um RASCUNHO com quanto cada atleta ganha por conquista. Nada é pago enquanto o torneio
// não tiver `cashEnabled` — e ligar o `cashEnabled` continua SÓ do admin global.
//
// Conquistas (só as que já têm dado oficial no sistema):
//   TITLE       campeão da categoria (tournamentFormats.categoryChampion: final/reset ou 1º
//               dos pontos corridos encerrados)
//   RUNNER_UP   vice (perdedor da final / 2º dos pontos corridos)
//   TOP_SCORER  artilharia oficial da categoria (gols; basquete = pontos — medals.topScorers)
//   ("melhor goleiro"/MVP: não há dado oficial — ficam de fora, nada é inventado.)
//
// TRAVAS (dinheiro de cliente):
//  - valores padrão = 0 (não inventa valor); regra com 0 não paga.
//  - teto POR REGRA (por atleta): env LIGA_CASH_RULE_MAX (padrão 0 = nada paga até o dono
//    definir) · teto TOTAL por torneio: env LIGA_CASH_TOURNAMENT_MAX (padrão = teto do prêmio
//    PRIZE_CASH_MAX), somando o que já foi pago por conquista + o prêmio já pago.
//  - só paga com cashEnabled=true, torneio não arquivado, não suspenso, fora da lista de
//    exclusão (Master Cup), e com a categoria ENCERRADA (campeão definido).
//  - só a atleta com CONTA (User ativo): time sem conta, vaga sem conta e vaga de menor não
//    recebem; conta que declara menor de 18 (User.birthDate) não recebe (ligaMinors).
//  - idempotente: chave única (torneio, categoria, conquista, atleta) em TournamentCashAward;
//    o pagamento roda numa transação com trava por torneio (pg_advisory_xact_lock).
//  - com cashEnabled ligado o rascunho TRAVA (só o admin global muda as regras).
//  - categoria só paga ENCERRADA de vez: campeão definido E nenhum jogo pendente (3º lugar,
//    reset etc.). Conquista já paga e resultado mudou depois (outro campeão/artilheiro) =
//    NÃO paga de novo: fica bloqueada para o administrador decidir.
//  - a organização do torneio (dono, FOUNDER, COORDINATOR) não recebe (conflito de interesse:
//    quem paga controla elenco e resultado).
//  - cada crédito = Transaction (type 'tournament_award') + auditoria (cash.award) na MESMA
//    transação; aviso no app (sininho e push que o atleta escolheu) — nunca WhatsApp/e-mail.
// =====================================================================

const { prisma } = require('../middleware');
const roles = require('./tournamentRoles');
const audit = require('./tournamentAudit');
const clubIdentity = require('./clubIdentity');
const minors = require('./ligaMinors');
const F = require('./tournamentFormats');
const { PRIZE_CASH_MAX } = require('./tournamentCash');

const RULES = Object.freeze({
  TITLE: { label: 'Título (campeão)', help: 'cada atleta com conta do time/dupla campeão' },
  RUNNER_UP: { label: 'Vice-campeão', help: 'cada atleta com conta do time/dupla vice' },
  TOP_SCORER: { label: 'Artilharia', help: 'artilheiro(s) da categoria (empate: todos)' },
});
const RULE_KEYS = Object.keys(RULES);
const MAX_AMOUNT = 100000; // sanidade do formulário (o teto que vale é o do env)

class CashRuleError extends Error { constructor(status, msg, code, extra) { super(msg); this.status = status; this.code = code || null; this.extra = extra || null; } }
const fail = (status, msg, code, extra) => { throw new CashRuleError(status, msg, code, extra); };

function num(raw, dflt) {
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function caps() {
  return { perRule: num(process.env.LIGA_CASH_RULE_MAX, 0), perTournament: num(process.env.LIGA_CASH_TOURNAMENT_MAX, PRIZE_CASH_MAX) };
}
const round2 = (n) => Math.round(n * 100) / 100;

function defaultRules() { return Object.fromEntries(RULE_KEYS.map((k) => [k, { amount: 0 }])); }

// Valida o que o organizador mandou. Desconhecido/negativo/não número = 400.
function normalizeRules(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'regras inválidas');
  const out = defaultRules();
  for (const [k, v] of Object.entries(input)) {
    if (!RULES[k]) fail(400, 'conquista desconhecida: ' + String(k).slice(0, 30));
    const raw = v && typeof v === 'object' ? v.amount : v;
    const n = Number(raw);
    if (raw === '' || raw == null || !Number.isFinite(n) || n < 0) fail(400, 'valor inválido em ' + RULES[k].label + ' (use 0 ou mais)');
    if (n > MAX_AMOUNT) fail(400, 'valor alto demais em ' + RULES[k].label);
    out[k] = { amount: round2(n) };
  }
  return out;
}

async function getRules(tournamentId, db = prisma) {
  let row = null;
  try { row = await db.tournamentCashConfig.findUnique({ where: { tournamentId: String(tournamentId) } }); } catch (_) { row = null; }
  if (!row || !row.rules) return defaultRules();
  try { return normalizeRules(row.rules); } catch (_) { return defaultRules(); }
}

const isExcluded = (t) => clubIdentity.isExcludedSlug(t && t.slug);

// Por que este torneio NÃO pode pagar agora (null = pode).
function blockReason(t) {
  if (!t) return 'torneio não encontrado';
  if (isExcluded(t)) return 'torneio da lista de exclusão (II Futsal Master Cup): TenisCash por conquista não vale aqui';
  if (t.archivedAt) return 'torneio arquivado';
  if (t.suspendedAt) return 'torneio suspenso pela moderação';
  if (!t.cashEnabled) return 'TenisCash desligado neste torneio — só o administrador do sistema liga';
  return null;
}

// Atletas COM conta de uma inscrição: EntryMember + vaga do elenco (jogador) ligada à conta.
async function recipientsOfEntry(entryId, db = prisma) {
  if (!entryId) return { users: [], blocked: [{ reason: 'sem time definido' }] };
  const [members, roster, entry] = await Promise.all([
    db.entryMember.findMany({ where: { entryId }, select: { userId: true } }),
    db.rosterPlayer.findMany({ where: { entryId }, select: { userId: true, role: true, minorProfileId: true, name: true } }),
    db.tournamentEntry.findUnique({ where: { id: entryId }, select: { name: true } }),
  ]);
  const ids = new Set(members.map((m) => m.userId).filter(Boolean));
  roster.filter((r) => (r.role || 'PLAYER') === 'PLAYER' && r.userId && !r.minorProfileId).forEach((r) => ids.add(r.userId));
  const blocked = [];
  if (!ids.size) blocked.push({ entry: entry && entry.name, reason: 'time sem atleta com conta no Club — não recebe' });
  const users = ids.size ? await db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, active: true, birthDate: true } }) : [];
  return { users, blocked, entryName: entry && entry.name };
}

function screenUser(u) {
  if (!u) return 'conta não encontrada';
  if (!u.active) return 'conta desativada';
  if (minors.declaresMinor(u.birthDate)) return MINOR_REASON;
  return null;
}
const MINOR_REASON = 'atleta menor de 18 anos — não recebe';
const DONE_STATUSES = new Set(['FINISHED', 'WALKOVER', 'CANCELED']);

// Dono + FOUNDER/COORDINATOR do torneio: quem paga não recebe.
async function organizersOf(t, db = prisma) {
  const rows = await db.tournamentRole.findMany({ where: { tournamentId: t.id, role: { in: ['FOUNDER', 'COORDINATOR'] } }, select: { userId: true } }).catch(() => []);
  return new Set([t.ownerId, ...rows.map((r) => r.userId)].filter(Boolean));
}

/**
 * Calcula o que cada regra pagaria (prévia ou pagamento). Não grava nada.
 * Retorna { categories: [{categoryId, name, done, reason, items:[{rule, userId, name, entryId, amount, status, reason}]}] }
 * status: 'pay' (a pagar) | 'paid' (já pago) | 'blocked' (não recebe, com motivo).
 */
async function computeAwards(t, rules, { categoryId = null, db = prisma } = {}) {
  const cats = await db.tournamentCategory.findMany({ where: { tournamentId: t.id, ...(categoryId ? { id: String(categoryId) } : {}) }, select: { id: true, name: true, formatConfig: true }, orderBy: { name: 'asc' } });
  const paidRows = await db.tournamentCashAward.findMany({ where: { tournamentId: t.id } }).catch(() => []);
  const paidKey = new Set(paidRows.map((p) => [p.categoryId, p.rule, p.userId].join('|')));
  // a CONQUISTA (categoria + regra) já paga: a quem (time/atletas). Resultado que muda depois
  // do pagamento não gera 2º pagamento da mesma conquista.
  const paidConquest = new Map();
  for (const p of paidRows) {
    const k = p.categoryId + '|' + p.rule;
    if (!paidConquest.has(k)) paidConquest.set(k, { entries: new Set(), users: new Set() });
    const g = paidConquest.get(k);
    if (p.entryId) g.entries.add(p.entryId);
    g.users.add(p.userId);
  }
  const orgs = await organizersOf(t, db);
  const medals = require('./medals');
  const out = [];
  for (const c of cats) {
    const [matches, standings] = await Promise.all([
      db.tournamentMatch.findMany({ where: { categoryId: c.id } }),
      db.tournamentStanding.findMany({ where: { categoryId: c.id }, select: { entryId: true, rank: true } }),
    ]);
    const cfg = c.formatConfig && typeof c.formatConfig === 'object' ? c.formatConfig : {};
    const champ = matches.length ? F.categoryChampion(matches, standings, { swissRounds: Number(cfg.rounds) || null }) : null;
    const pending = matches.filter((m) => !DONE_STATUSES.has(m.status));
    const cat = { categoryId: c.id, name: c.name, done: !!(champ && champ.championId) && !pending.length, reason: null, items: [] };
    if (!cat.done) { cat.reason = champ && champ.championId ? `categoria com ${pending.length} jogo(s) ainda sem resultado — só paga encerrada` : 'categoria ainda sem campeão definido (resultado oficial)'; out.push(cat); continue; }
    const seen = new Set();
    const add = (rule, u, extra = {}) => {
      if (u && seen.has(rule + '|' + u.id)) return; // mesma conta em 2 vagas = 1 crédito
      if (u) seen.add(rule + '|' + u.id);
      const amount = rules[rule] ? rules[rule].amount : 0;
      const key = [c.id, rule, u && u.id].join('|');
      if (paidKey.has(key)) { cat.items.push({ rule, ruleLabel: RULES[rule].label, userId: u.id, name: u.name, entryId: extra.entryId || null, amount, status: 'paid', reason: null }); return; }
      let why = module.exports.screenUser(u); // via exports: o teste de sabotagem troca a trava
      if (!why && u && orgs.has(u.id)) why = 'organização do torneio não recebe (conflito de interesse)';
      const g = paidConquest.get(c.id + '|' + rule);
      if (!why && g) {
        const sameTeam = rule !== 'TOP_SCORER' && extra.entryId && g.entries.has(extra.entryId);
        if (!sameTeam) why = 'conquista já paga a outro ' + (rule === 'TOP_SCORER' ? 'atleta' : 'time') + ' — o resultado mudou depois do pagamento; o administrador decide';
      }
      // menor: não expõe o nome da conta na prévia
      const hideName = why === MINOR_REASON;
      cat.items.push({ rule, ruleLabel: RULES[rule].label, userId: u && !hideName ? u.id : null, name: hideName ? null : u ? u.name : extra.name || null, entryId: extra.entryId || null, amount, status: why ? 'blocked' : 'pay', reason: why });
    };
    const block = (rule, reason, extra = {}) => cat.items.push({ rule, ruleLabel: RULES[rule].label, userId: null, name: extra.name || null, entryId: extra.entryId || null, amount: rules[rule] ? rules[rule].amount : 0, status: 'blocked', reason });
    for (const [rule, entryId] of [['TITLE', champ.championId], ['RUNNER_UP', champ.runnerUpId]]) {
      if (!(rules[rule] && rules[rule].amount > 0)) continue;
      if (!entryId) { block(rule, 'sem vice definido nesta categoria'); continue; }
      const r = await recipientsOfEntry(entryId, db);
      r.blocked.forEach((b) => block(rule, b.reason, { name: b.entry, entryId }));
      r.users.forEach((u) => add(rule, u, { entryId }));
    }
    if (rules.TOP_SCORER && rules.TOP_SCORER.amount > 0) {
      const top = await medals.topScorers(c.id, matches, db);
      if (!top.length) block('TOP_SCORER', 'categoria sem gol/ponto com autor na súmula');
      for (const s of top) {
        if (!s.userId) { block('TOP_SCORER', 'artilheiro sem conta ligada no elenco — não recebe', { name: s.name, entryId: s.entryId }); continue; }
        const p = await db.rosterPlayer.findUnique({ where: { id: s.playerId }, select: { minorProfileId: true } }).catch(() => null);
        if (p && p.minorProfileId) { block('TOP_SCORER', MINOR_REASON, { entryId: s.entryId }); continue; }
        const u = await db.user.findUnique({ where: { id: s.userId }, select: { id: true, name: true, active: true, birthDate: true } });
        add('TOP_SCORER', u, { entryId: s.entryId, name: s.name });
      }
    }
    out.push(cat);
  }
  return { categories: out, paidRows };
}

const sumPaid = (rows) => round2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
const prizeAlreadyPaid = (t) => (t.prizePaidAt && t.prizeCash > 0 ? Number(t.prizeCash) : 0);

/** Painel do organizador (fundador/coordenador/admin): regras, travas, prévia e o que já foi pago. */
async function view({ userId, userRole }, t) {
  const rules = await getRules(t.id);
  const { categories, paidRows } = await computeAwards(t, rules);
  const admin = roles.isGlobalAdmin(userRole);
  const money = await roles.can(userId, userRole, t.id, 'MONEY');
  const c = caps();
  const reason = blockReason(t);
  return {
    rules,
    catalog: RULE_KEYS.map((k) => ({ key: k, label: RULES[k].label, help: RULES[k].help })),
    cashEnabled: !!t.cashEnabled,
    excluded: isExcluded(t),
    locked: !!t.cashEnabled && !admin, // com dinheiro ligado, só o admin muda as regras
    canEdit: money && !isExcluded(t) && (!t.cashEnabled || admin),
    canPay: money && !reason,
    payBlockedReason: reason,
    caps: c,
    paidTotal: sumPaid(paidRows),
    prizePaid: prizeAlreadyPaid(t),
    categories,
    paid: paidRows.map((p) => ({ categoryId: p.categoryId, rule: p.rule, userId: p.userId, amount: p.amount, transactionId: p.transactionId, at: p.createdAt })),
  };
}

/** Grava o rascunho (fundador/admin — a rota já passou no MONEY). */
async function saveRules({ userId, userRole }, t, input) {
  if (isExcluded(t)) fail(409, 'torneio da lista de exclusão (II Futsal Master Cup): nada de TenisCash por conquista aqui', 'EXCLUDED');
  if (t.cashEnabled && !roles.isGlobalAdmin(userRole)) fail(409, 'TenisCash já está ligado neste torneio: as regras ficam travadas (só o administrador do sistema muda)', 'LOCKED');
  const rules = normalizeRules(input);
  const before = await getRules(t.id);
  await prisma.tournamentCashConfig.upsert({
    where: { tournamentId: t.id },
    create: { tournamentId: t.id, rules, updatedBy: userId || null },
    update: { rules, updatedBy: userId || null },
  });
  await audit.record({ tournamentId: t.id, userId, action: 'cash.rules', entity: 'TournamentCashConfig', entityId: t.id, before, after: rules });
  const c = caps();
  const overCap = RULE_KEYS.filter((k) => rules[k].amount > c.perRule);
  return { ok: true, rules, caps: c, warnings: overCap.length ? overCap.map((k) => `${RULES[k].label}: ${rules[k].amount} acima do teto por conquista (${c.perRule}) — não será pago até o teto subir`) : [] };
}

/**
 * Paga o que falta (fundador/admin — a rota já passou no MONEY). Idempotente.
 * body: { categoryId?, confirm:true }
 */
async function pay({ userId, userRole }, tournamentId, { categoryId = null, confirm } = {}) {
  if (confirm !== true) fail(400, 'confirme o pagamento (confirm:true): credita TenisCash REAL no saldo dos atletas', 'CONFIRM_REQUIRED');
  const t0 = await prisma.tournament.findUnique({ where: { id: String(tournamentId) } });
  const why0 = module.exports.blockReason(t0); // via exports: teste de sabotagem
  if (why0) fail(409, why0, 'CASH_BLOCKED');
  const rules = await getRules(t0.id);
  const c = module.exports.caps();
  const active = RULE_KEYS.filter((k) => rules[k].amount > 0);
  if (!active.length) fail(409, 'nenhuma conquista com valor: configure as regras antes de pagar', 'NO_RULES');
  const over = active.filter((k) => rules[k].amount > c.perRule);
  if (over.length) fail(409, `valor acima do teto por conquista (${c.perRule} TenisCash): ${over.map((k) => RULES[k].label).join(', ')} — precisa de liberação do dono`, 'RULE_CAP', { perRule: c.perRule });

  const result = await prisma.$transaction(async (tx) => {
    // trava por torneio: dois pagamentos ao mesmo tempo não passam juntos do teto nem pagam 2x
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${'liga-cash:' + t0.id}))) AS l`;
    const t = await tx.tournament.findUnique({ where: { id: t0.id } });
    const why = module.exports.blockReason(t);
    if (why) fail(409, why, 'CASH_BLOCKED');
    const { categories, paidRows } = await module.exports.computeAwards(t, rules, { categoryId, db: tx }); // via exports: teste de sabotagem
    const toPay = [];
    for (const cat of categories) for (const it of cat.items) if (it.status === 'pay' && it.amount > 0) toPay.push({ ...it, categoryId: cat.categoryId, category: cat.name });
    const already = sumPaid(paidRows) + prizeAlreadyPaid(t);
    const adding = round2(toPay.reduce((s, x) => s + x.amount, 0));
    if (toPay.length && already + adding > c.perTournament) {
      fail(409, `acima do teto total do torneio (${c.perTournament} TenisCash: já pago ${already}, este pagamento ${adding}) — precisa de liberação do dono`, 'TOURNAMENT_CAP', { perTournament: c.perTournament, already, adding });
    }
    const paid = [];
    for (const it of toPay) {
      const award = await tx.tournamentCashAward.create({ data: { tournamentId: t.id, categoryId: it.categoryId, rule: it.rule, userId: it.userId, entryId: it.entryId, amount: it.amount, paidBy: userId || null } });
      const u = await tx.user.update({ where: { id: it.userId }, data: { balance: { increment: it.amount } } });
      const trx = await tx.transaction.create({
        data: {
          type: 'tournament_award',
          amount: it.amount,
          description: `${RULES[it.rule].label}: ${t.name}${it.category ? ' (' + it.category + ')' : ''}`,
          senderId: null,
          receiverId: it.userId,
          balanceAfter: u.balance,
          metadata: JSON.stringify({ tournamentId: t.id, categoryId: it.categoryId, rule: it.rule, awardId: award.id, entryId: it.entryId }),
        },
      });
      await tx.tournamentCashAward.update({ where: { id: award.id }, data: { transactionId: trx.id } });
      paid.push({ awardId: award.id, transactionId: trx.id, userId: it.userId, name: it.name, rule: it.rule, categoryId: it.categoryId, category: it.category, amount: it.amount });
    }
    // auditoria NA MESMA transação: crédito sem registro não existe
    if (paid.length) {
      await tx.tournamentAudit.create({ data: { tournamentId: t.id, userId: userId || null, action: 'cash.award', entity: 'TournamentCashAward', entityId: categoryId || t.id, after: { total: adding, paid: paid.map((p) => ({ userId: p.userId, rule: p.rule, categoryId: p.categoryId, amount: p.amount, transactionId: p.transactionId })) } } });
    }
    const skipped = [];
    for (const cat of categories) {
      if (!cat.done) skipped.push({ category: cat.name, reason: cat.reason });
      for (const it of cat.items) if (it.status !== 'pay') skipped.push({ category: cat.name, rule: it.rule, name: it.name, reason: it.status === 'paid' ? 'já pago' : it.reason });
    }
    return { t, paid, skipped, total: adding };
  }, { timeout: 60000, maxWait: 20000 });

  if (result.paid.length) {
    try {
      const { notify } = require('./notify');
      for (const p of result.paid) {
        // aviso no app (sininho + push que o atleta ligou); NUNCA WhatsApp/e-mail
        await notify(p.userId, { type: 'result', title: 'TenisCash recebido', body: `Você recebeu ${p.amount} TenisCash por ${RULES[p.rule].label.toLowerCase()} em ${result.t.name}.`, link: '#/t/' + result.t.id }, { whatsapp: false });
      }
    } catch (_) { /* aviso é best-effort */ }
  }
  return { ok: true, paid: result.paid, skipped: result.skipped, total: result.total, caps: c };
}

// Prêmios recebidos por conquista (export de privacidade).
async function awardsOfUser(userId) {
  try { return await prisma.tournamentCashAward.findMany({ where: { userId: String(userId) }, orderBy: { createdAt: 'desc' }, take: 500 }); } catch (_) { return []; }
}

module.exports = { RULES, RULE_KEYS, CashRuleError, caps, defaultRules, normalizeRules, getRules, blockReason, screenUser, computeAwards, view, saveRules, pay, awardsOfUser, organizersOf };
