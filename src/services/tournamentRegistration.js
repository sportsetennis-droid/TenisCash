// =====================================================================
// CLUB F3 — INSCRIÇÃO PAGA, LISTA DE ESPERA, CASHBACK E CHECK-IN
// ---------------------------------------------------------------------
// Fluxo:
//   inscrição pública → (vaga?) PENDING_PAYMENT : WAITLIST
//   pagamento (PIX PagBank | TenisCash | misto | no local | grátis/cupom 100%)
//   → CONFIRMED: cria a TournamentEntry (só aí entra na chave), credita o
//     cashback (1x) e avisa. Vaga que libera (expirou/cancelou/estornou)
//     promove o 1º da fila com prazo pra pagar.
//
// ⛔ Regras de dinheiro:
//   - valores SEMPRE em centavos (inteiro). User.balance (TenisCash) é Float em R$.
//   - webhook idempotente (cobrança vira PAID uma vez só; cashback 1x via
//     update condicional cashbackAt IS NULL).
//   - devolução de DINHEIRO nunca é automática: só registra o pedido e o
//     estorno manual feito pelo organizador (auditado). O saldo TenisCash
//     (ledger interno) volta automático quando a inscrição expira/cancela
//     ou quando o organizador registra o estorno.
//   - nada de CPF; telefone só aparece no painel do organizador.
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');
const pix = require('./tournamentPix');
const { notify } = require('./notify');
const roles = require('./tournamentRoles');

const HOLD_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED'];
const ACTIVE_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'WAITLIST'];
const TEAM_SPORTS = new Set(['FUTSAL', 'SOCCER', 'VOLLEY', 'BASKETBALL', 'HANDBALL']);
const SHIRT_SIZES = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG'];
const FIELD_TYPES = ['text', 'number', 'boolean', 'select', 'shirt'];
const MAX_ACTIVE_PER_PHONE = 5;

const STATUS_LABEL = {
  PENDING_PAYMENT: 'Aguardando pagamento',
  CONFIRMED: 'Confirmada',
  WAITLIST: 'Lista de espera',
  EXPIRED: 'Expirada',
  CANCELED: 'Cancelada',
  REFUNDED: 'Estornada',
};

class RegError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new RegError(status, message); };

const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const clean = (s, max = 120) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const token = (n = 18) => crypto.randomBytes(n).toString('base64url');
const intOr = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const reais = (cents) => Math.round(cents) / 100;
const fmtBRL = (cents) => 'R$ ' + (Math.round(cents) / 100).toFixed(2).replace('.', ',');

function dueCents(reg) {
  return Math.max(0, (reg.feeCents || 0) - (reg.discountCents || 0) - (reg.tcCents || 0) - (reg.paidCents || 0));
}

function kindFor(t) {
  if (TEAM_SPORTS.has(t.sport)) return 'TEAM';
  return t.isDoubles ? 'DOUBLES' : 'ATHLETE';
}

// ---------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------
const CONFIG_DEFAULTS = {
  enabled: false, categories: {}, customFields: [], termsText: null, termsVersion: 1,
  holdMinutes: 60, waitlistHoldHours: 24, allowTenisCash: true, allowOnsite: false,
  cashbackPct: 0, paymentStoreId: null, checkinToleranceMin: 15,
};

async function getConfig(tournamentId, db = prisma) {
  const row = await db.tournamentRegistrationConfig.findUnique({ where: { tournamentId } });
  if (!row) return { tournamentId, ...CONFIG_DEFAULTS, persisted: false };
  return {
    ...CONFIG_DEFAULTS, ...row,
    categories: row.categories && typeof row.categories === 'object' ? row.categories : {},
    customFields: Array.isArray(row.customFields) ? row.customFields : [],
    persisted: true,
  };
}

function categoryRules(cfg, categoryId) {
  const c = (cfg.categories || {})[categoryId] || {};
  const fee = intOr(c.feeCents, 0);
  const max = c.maxEntries == null || c.maxEntries === '' ? null : intOr(c.maxEntries, null);
  return { feeCents: Math.max(0, fee), maxEntries: max && max > 0 ? max : null };
}

function normalizeCustomFields(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const keys = new Set();
  for (const f of list.slice(0, 20)) {
    const label = clean(f && f.label, 80);
    if (!label) continue;
    let key = clean((f && f.key) || label, 40).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'campo';
    while (keys.has(key)) key += '_2';
    keys.add(key);
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
    let options = [];
    if (type === 'select') options = (Array.isArray(f.options) ? f.options : String(f.options || '').split(',')).map((o) => clean(o, 40)).filter(Boolean).slice(0, 30);
    if (type === 'shirt') options = SHIRT_SIZES.slice();
    if (type === 'select' && !options.length) continue;
    out.push({ key, label, type, required: !!f.required, options });
  }
  return out;
}

/**
 * Salva a configuração. Cashback e loja do PIX (dinheiro da S&T) só admin global.
 */
async function saveConfig(tournamentId, body, { isGlobalAdmin }) {
  const cur = await getConfig(tournamentId);
  const b = body || {};
  const data = {};
  if (b.enabled !== undefined) data.enabled = !!b.enabled;
  if (b.categories !== undefined) {
    const cats = await prisma.tournamentCategory.findMany({ where: { tournamentId }, select: { id: true } });
    const ok = new Set(cats.map((c) => c.id));
    const out = {};
    for (const [cid, v] of Object.entries(b.categories || {})) {
      if (!ok.has(cid)) continue;
      const fee = intOr(v && v.feeCents, 0);
      if (fee < 0 || fee > 10000000) fail(400, 'taxa inválida (0 a R$ 100.000)');
      const max = v && v.maxEntries != null && v.maxEntries !== '' ? intOr(v.maxEntries, null) : null;
      if (max != null && (max < 1 || max > 2000)) fail(400, 'vagas por categoria: 1 a 2000');
      out[cid] = { feeCents: fee, maxEntries: max };
    }
    data.categories = out;
  }
  if (b.customFields !== undefined) data.customFields = normalizeCustomFields(b.customFields);
  if (b.termsText !== undefined) {
    const txt = b.termsText == null ? null : String(b.termsText).slice(0, 20000).trim() || null;
    if (txt !== (cur.termsText || null)) {
      data.termsText = txt;
      data.termsVersion = (cur.termsVersion || 1) + (cur.persisted && cur.termsText ? 1 : 0);
    }
  }
  if (b.holdMinutes !== undefined) data.holdMinutes = clamp(intOr(b.holdMinutes, 60), 10, 1440);
  if (b.waitlistHoldHours !== undefined) data.waitlistHoldHours = clamp(intOr(b.waitlistHoldHours, 24), 1, 168);
  if (b.allowTenisCash !== undefined) data.allowTenisCash = !!b.allowTenisCash;
  if (b.allowOnsite !== undefined) data.allowOnsite = !!b.allowOnsite;
  if (b.checkinToleranceMin !== undefined) data.checkinToleranceMin = clamp(intOr(b.checkinToleranceMin, 15), 0, 180);
  if (b.cashbackPct !== undefined && intOr(b.cashbackPct, 0) !== cur.cashbackPct) {
    if (!isGlobalAdmin) fail(403, 'só o admin da Sports & Tennis liga/muda o cashback');
    data.cashbackPct = clamp(intOr(b.cashbackPct, 0), 0, 30);
  }
  if (b.paymentStoreId !== undefined && (b.paymentStoreId || null) !== (cur.paymentStoreId || null)) {
    if (!isGlobalAdmin) fail(403, 'só o admin da Sports & Tennis escolhe a conta que recebe o PIX');
    if (b.paymentStoreId) {
      const s = await prisma.store.findUnique({ where: { id: String(b.paymentStoreId) } });
      if (!s) fail(400, 'loja não encontrada');
    }
    data.paymentStoreId = b.paymentStoreId || null;
  }
  const row = await prisma.tournamentRegistrationConfig.upsert({
    where: { tournamentId },
    create: { tournamentId, ...CONFIG_DEFAULTS, ...data, categories: data.categories || {}, customFields: data.customFields || [] },
    update: data,
  });
  return getConfig(row.tournamentId);
}

// ---------------------------------------------------------------------
// Vagas
// ---------------------------------------------------------------------
async function occupancy(db, { tournamentId, categoryId }) {
  const now = new Date();
  const pendingWhere = { status: 'PENDING_PAYMENT', entryId: null, OR: [{ paymentExpiresAt: null }, { paymentExpiresAt: { gt: now } }] };
  const [catEntries, catPending, tEntries, tPending] = await Promise.all([
    db.tournamentEntry.count({ where: { categoryId, status: { in: ['CONFIRMED', 'PENDING'] } } }),
    db.tournamentRegistration.count({ where: { categoryId, ...pendingWhere } }),
    db.tournamentEntry.count({ where: { tournamentId, status: { in: ['CONFIRMED', 'PENDING'] } } }),
    db.tournamentRegistration.count({ where: { tournamentId, ...pendingWhere } }),
  ]);
  return { category: catEntries + catPending, tournament: tEntries + tPending };
}

async function spotsLeft(db, t, cfg, categoryId) {
  const rules = categoryRules(cfg, categoryId);
  const occ = await occupancy(db, { tournamentId: t.id, categoryId });
  const a = rules.maxEntries != null ? rules.maxEntries - occ.category : Infinity;
  const b = t.maxEntries ? t.maxEntries - occ.tournament : Infinity;
  return Math.max(0, Math.min(a, b));
}

// Serializa decisões de vaga por categoria (2 pessoas na última vaga).
async function lockCategory(tx, categoryId) {
  await tx.$queryRawUnsafe('SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext($1))', 'treg:' + categoryId);
}

// ---------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------
async function audit(db, { tournamentId, registrationId, action, actorUserId, note, data }) {
  try {
    await db.tournamentRegistrationAudit.create({
      data: { tournamentId, registrationId: registrationId || null, action, actorUserId: actorUserId || null, note: note ? String(note).slice(0, 500) : null, data: data || undefined },
    });
  } catch (e) { console.error('[treg audit]', e.message); }
}

// Usuário a avisar / creditar: quem inscreveu ou a conta do telefone de contato.
async function userForRegistration(reg) {
  if (reg.userId) return reg.userId;
  const p = digits(reg.contactPhone);
  if (!p) return null;
  const variants = [p, p.startsWith('55') ? p.slice(2) : '55' + p];
  const u = await prisma.user.findFirst({ where: { phone: { in: variants }, active: true }, select: { id: true } });
  return u ? u.id : null;
}

async function notifyReg(reg, payload) {
  try {
    const uid = await userForRegistration(reg);
    if (uid) await notify(uid, payload);
  } catch (_) {}
}

// ---------------------------------------------------------------------
// Cupom
// ---------------------------------------------------------------------
function couponDiscount(coupon, feeCents) {
  if (!coupon) return 0;
  if (coupon.kind === 'FIXED') return Math.min(feeCents, Math.max(0, coupon.value));
  return Math.min(feeCents, Math.floor((feeCents * clamp(coupon.value, 0, 100)) / 100));
}

async function findValidCoupon(db, tournamentId, code) {
  const c = clean(code, 40).toUpperCase();
  if (!c) return null;
  const coupon = await db.tournamentCoupon.findUnique({ where: { tournamentId_code: { tournamentId, code: c } } });
  if (!coupon || !coupon.active) fail(400, 'cupom inválido');
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) fail(400, 'cupom vencido');
  if (coupon.maxUses != null && coupon.usedCount >= coupon.maxUses) fail(409, 'cupom esgotado');
  return coupon;
}

async function checkCoupon(slugOrId, code, categoryId) {
  const t = await findTournament(slugOrId);
  const cfg = await getConfig(t.id);
  const coupon = await findValidCoupon(prisma, t.id, code);
  const fee = categoryRules(cfg, categoryId).feeCents;
  const discount = couponDiscount(coupon, fee);
  return { code: coupon.code, kind: coupon.kind, value: coupon.value, discountCents: discount, totalCents: fee - discount };
}

// Reserva 1 uso (atômico; respeita o limite mesmo com corrida).
async function reserveCoupon(tx, coupon) {
  const r = coupon.maxUses == null
    ? await tx.tournamentCoupon.updateMany({ where: { id: coupon.id, active: true }, data: { usedCount: { increment: 1 } } })
    : await tx.tournamentCoupon.updateMany({ where: { id: coupon.id, active: true, usedCount: { lt: coupon.maxUses } }, data: { usedCount: { increment: 1 } } });
  if (!r.count) fail(409, 'cupom esgotado');
}

async function releaseCoupon(db, reg) {
  if (!reg.couponId) return;
  await db.tournamentCoupon.updateMany({ where: { id: reg.couponId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } }).catch(() => {});
}

// ---------------------------------------------------------------------
// Inscrição pública
// ---------------------------------------------------------------------
async function findTournament(slugOrId) {
  const t = await prisma.tournament.findFirst({ where: { OR: [{ slug: String(slugOrId) }, { id: String(slugOrId) }] } });
  if (!t) fail(404, 'torneio não encontrado');
  return t;
}

function ageAt(birthDate, ref) {
  const m = String(birthDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const b = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(b) || b > ref) return null;
  let age = ref.getUTCFullYear() - b.getUTCFullYear();
  const md = ref.getUTCMonth() - b.getUTCMonth();
  if (md < 0 || (md === 0 && ref.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

function parseAthlete(a, idx, refDate) {
  const name = clean(a && a.name, 100);
  if (!name) fail(400, `nome do atleta ${idx + 1} obrigatório`);
  const birthDate = clean(a && a.birthDate, 10);
  const age = ageAt(birthDate, refDate);
  if (age == null || age > 110) fail(400, `data de nascimento do atleta ${idx + 1} inválida (AAAA-MM-DD)`);
  const out = { name, birthDate, phone: digits(a && a.phone).slice(0, 13) || null, email: clean(a && a.email, 120) || null, minor: age < 18, username: clean(a && a.username, 40).replace(/^@/, '') || null };
  if (out.minor) {
    const g = (a && a.guardian) || {};
    const gName = clean(g.name, 100);
    const gPhone = digits(g.phone);
    if (!gName || gPhone.length < 10) fail(400, `atleta ${idx + 1} é menor de idade: informe nome e telefone do responsável`);
    out.guardian = { name: gName, phone: gPhone.slice(0, 13), relationship: clean(g.relationship, 40) || null };
  }
  return out;
}

function parseAnswers(fields, answers) {
  const out = {};
  const a = answers && typeof answers === 'object' ? answers : {};
  for (const f of fields) {
    const v = a[f.key];
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (f.required && f.type !== 'boolean') fail(400, `preencha: ${f.label}`);
      if (f.type === 'boolean') out[f.key] = false;
      continue;
    }
    if (f.type === 'number') {
      const n = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n)) fail(400, `${f.label}: número inválido`);
      out[f.key] = n;
    } else if (f.type === 'boolean') {
      out[f.key] = v === true || v === 'true' || v === 'sim' || v === 1 || v === '1';
      if (f.required && !out[f.key]) fail(400, `confirme: ${f.label}`);
    } else if (f.type === 'select' || f.type === 'shirt') {
      const s = clean(v, 40);
      if (!f.options.includes(s)) fail(400, `${f.label}: opção inválida`);
      out[f.key] = s;
    } else {
      out[f.key] = clean(v, 300);
    }
  }
  return out;
}

/**
 * Cria a inscrição. Retorna a inscrição pública (com publicToken).
 * user = usuário logado (opcional). meta = { ip, userAgent }.
 */
async function register(slugOrId, body, user, meta = {}) {
  const t = await findTournament(slugOrId);
  const cfg = await getConfig(t.id);
  if (!cfg.enabled) fail(409, 'a inscrição online deste torneio não está aberta');
  if (!['OPEN', 'ONGOING'].includes(t.status)) fail(409, 'as inscrições não estão abertas');
  if (t.registrationCloseAt && new Date(t.registrationCloseAt) < new Date()) fail(409, 'inscrições encerradas');
  const b = body || {};
  const cat = await prisma.tournamentCategory.findFirst({ where: { id: String(b.categoryId || ''), tournamentId: t.id } });
  if (!cat) fail(400, 'escolha uma categoria deste torneio');

  const kind = kindFor(t);
  const refDate = t.startDate ? new Date(t.startDate) : new Date();
  let athletes = [];
  let roster = null;
  let displayName;
  let contactName = clean(b.contactName, 100);
  let contactPhone = digits(b.contactPhone);
  const contactEmail = clean(b.contactEmail, 120) || null;

  if (kind === 'TEAM') {
    displayName = clean(b.teamName, 60);
    if (!displayName) fail(400, 'nome do time obrigatório');
    if (!contactName) fail(400, 'nome do responsável pelo time obrigatório');
    if (b.responsibleAdult !== true) fail(400, 'o responsável pelo time precisa declarar que é maior de idade');
    roster = (Array.isArray(b.roster) ? b.roster : []).slice(0, 40).map((p) => ({
      name: clean(p && p.name, 80), number: p && p.number !== '' && p.number != null && Number.isFinite(Number(p.number)) ? clamp(Math.round(Number(p.number)), 0, 999) : null,
      isGoalkeeper: !!(p && p.isGoalkeeper),
    })).filter((p) => p.name);
  } else {
    const list = Array.isArray(b.athletes) ? b.athletes : [];
    const need = kind === 'DOUBLES' ? 2 : 1;
    if (list.length !== need) fail(400, `esta categoria pede ${need} atleta(s) por inscrição`);
    athletes = list.map((a, i) => parseAthlete(a, i, refDate));
    displayName = athletes.map((a) => a.name.split(' ')[0]).join(' & ');
    if (!contactName) contactName = athletes[0].minor ? athletes[0].guardian.name : athletes[0].name;
    if (!contactPhone) contactPhone = athletes[0].minor ? athletes[0].guardian.phone : digits(athletes[0].phone);
  }
  if (contactPhone.length < 10 || contactPhone.length > 13) fail(400, 'telefone de contato inválido (com DDD)');

  const answers = parseAnswers(cfg.customFields || [], b.answers);

  let terms = {};
  if (cfg.termsText) {
    if (b.acceptTerms !== true) fail(400, 'é preciso aceitar o termo de responsabilidade / regulamento');
    terms = {
      termsVersion: cfg.termsVersion,
      termsHash: crypto.createHash('sha256').update(cfg.termsText).digest('hex'),
      termsAcceptedAt: new Date(),
      termsIp: clean(meta.ip, 64) || null,
      termsUserAgent: clean(meta.userAgent, 300) || null,
    };
  }

  const rules = categoryRules(cfg, cat.id);
  const coupon = b.couponCode ? await findValidCoupon(prisma, t.id, b.couponCode) : null;
  const discount = couponDiscount(coupon, rules.feeCents);

  const reg = await prisma.$transaction(async (tx) => {
    await lockCategory(tx, cat.id);
    // duplicidade
    if (kind === 'TEAM') {
      const dupE = await tx.tournamentEntry.findFirst({ where: { categoryId: cat.id, name: { equals: displayName, mode: 'insensitive' }, status: { not: 'WITHDRAWN' } } });
      const dupR = await tx.tournamentRegistration.findFirst({ where: { categoryId: cat.id, displayName: { equals: displayName, mode: 'insensitive' }, status: { in: ACTIVE_STATUSES } } });
      if (dupE || dupR) fail(409, 'já existe um time com esse nome nesta categoria');
    } else {
      const same = await tx.tournamentRegistration.findMany({ where: { categoryId: cat.id, status: { in: ACTIVE_STATUSES } }, select: { athletes: true } });
      const names = new Set(athletes.map((a) => a.name.toLowerCase() + '|' + a.birthDate));
      if (same.some((r) => (Array.isArray(r.athletes) ? r.athletes : []).some((a) => names.has(String(a.name || '').toLowerCase() + '|' + a.birthDate)))) {
        fail(409, 'esse atleta já tem inscrição nesta categoria');
      }
    }
    const activeByPhone = await tx.tournamentRegistration.count({ where: { tournamentId: t.id, contactPhone, status: { in: ACTIVE_STATUSES } } });
    if (activeByPhone >= MAX_ACTIVE_PER_PHONE) fail(429, 'limite de inscrições por telefone neste torneio');

    if (coupon) await reserveCoupon(tx, coupon);
    const left = await spotsLeft(tx, t, cfg, cat.id);
    const status = left > 0 ? 'PENDING_PAYMENT' : 'WAITLIST';
    return tx.tournamentRegistration.create({
      data: {
        tournamentId: t.id, categoryId: cat.id, kind, displayName, status,
        userId: user ? user.id : null, contactName, contactPhone, contactEmail,
        athletes: athletes.length ? athletes : undefined, roster: roster || undefined, answers,
        ...terms,
        feeCents: rules.feeCents, discountCents: discount,
        couponId: coupon ? coupon.id : null, couponCode: coupon ? coupon.code : null,
        paymentExpiresAt: status === 'PENDING_PAYMENT' ? new Date(Date.now() + cfg.holdMinutes * 60000) : null,
        publicToken: token(18), checkinToken: token(18),
      },
    });
  });

  await audit(prisma, { tournamentId: t.id, registrationId: reg.id, action: 'REGISTERED', actorUserId: user ? user.id : null, data: { status: reg.status, feeCents: reg.feeCents, discountCents: discount, couponCode: reg.couponCode } });
  // grátis (taxa 0 ou cupom 100%) → confirma direto
  if (reg.status === 'PENDING_PAYMENT' && dueCents(reg) === 0) {
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { paymentMethod: 'FREE' } });
    await confirmRegistration(reg.id, { reason: 'free' });
  }
  try {
    await notify(t.ownerId, { type: 'entry', title: 'Nova inscrição', body: `${displayName} se inscreveu em "${t.name}" (${STATUS_LABEL[reg.status] || reg.status}).`, link: '#/inscricoes/' + t.id }, { waCategory: 'organizer' });
  } catch (_) {}
  return prisma.tournamentRegistration.findUnique({ where: { id: reg.id } });
}

// ---------------------------------------------------------------------
// Confirmação (idempotente) + entrada na chave
// ---------------------------------------------------------------------
async function confirmRegistration(regId, { reason } = {}) {
  const res = await prisma.$transaction(async (tx) => {
    const reg = await tx.tournamentRegistration.findUnique({ where: { id: regId } });
    if (!reg) return { ok: false, error: 'inscrição não encontrada' };
    await lockCategory(tx, reg.categoryId);
    const r = await tx.tournamentRegistration.updateMany({
      where: { id: regId, status: { in: ['PENDING_PAYMENT', 'WAITLIST', 'EXPIRED'] } },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), paidAt: reg.paidAt || new Date(), paymentExpiresAt: null },
    });
    if (!r.count) return { ok: true, already: true, reg };
    let entryId = reg.entryId;
    if (!entryId) {
      const memberIds = [];
      if (reg.kind !== 'TEAM') {
        if (reg.userId) memberIds.push(reg.userId);
        for (const a of Array.isArray(reg.athletes) ? reg.athletes : []) {
          if (!a.username) continue;
          const u = await tx.user.findFirst({ where: { username: { equals: a.username, mode: 'insensitive' } }, select: { id: true } });
          if (u && !memberIds.includes(u.id)) memberIds.push(u.id);
        }
      }
      // atleta já membro de outra inscrição da categoria não entra 2x (EntryMember)
      const already = memberIds.length ? await tx.entryMember.findMany({ where: { userId: { in: memberIds }, entry: { categoryId: reg.categoryId } }, select: { userId: true } }) : [];
      const taken = new Set(already.map((m) => m.userId));
      const entry = await tx.tournamentEntry.create({
        data: {
          tournamentId: reg.tournamentId, categoryId: reg.categoryId, name: reg.displayName, status: 'CONFIRMED',
          members: { create: memberIds.filter((id) => !taken.has(id)).map((userId) => ({ userId })) },
        },
      });
      entryId = entry.id;
      if (reg.kind === 'TEAM' && Array.isArray(reg.roster)) {
        for (const p of reg.roster) {
          await tx.rosterPlayer.create({ data: { entryId, name: p.name, number: p.number == null ? null : p.number, isGoalkeeper: !!p.isGoalkeeper } });
        }
      }
      await tx.tournamentRegistration.update({ where: { id: regId }, data: { entryId } });
    }
    return { ok: true, confirmed: true, reg: { ...reg, entryId, status: 'CONFIRMED' } };
  });
  if (!res.ok || res.already) return res;
  const reg = res.reg;
  await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'CONFIRMED', data: { reason: reason || null, paidCents: reg.paidCents, tcCents: reg.tcCents } });
  // Liga F2: time inscrito online ganha o CLUBE (depois do pagamento; nunca derruba a confirmação)
  if (reg.kind === 'TEAM' && reg.entryId) await require('./clubIdentity').attachClubToTeamEntry(reg.entryId, { ownerUserId: reg.userId || null });
  // admin do time → papel no torneio (clube único: vale pra todas as categorias)
  if (reg.kind === 'TEAM' && reg.userId && reg.entryId) {
    await roles.assignRole(reg.tournamentId, { userId: reg.userId, role: 'TEAM_ADMIN', entryId: reg.entryId }).catch(() => {});
  }
  const cb = await creditCashback(reg.id).catch((e) => ({ ok: false, error: e.message }));
  const t = await prisma.tournament.findUnique({ where: { id: reg.tournamentId }, select: { name: true, slug: true } });
  await notifyReg(reg, {
    type: 'entry', title: 'Inscrição confirmada ✅',
    body: `Sua inscrição em "${t ? t.name : 'torneio'}" está confirmada.` + (cb && cb.credited ? ` Você ganhou ${fmtBRL(cb.cents)} de cashback TenisCash.` : '') + ' Seu QR de check-in está na página da inscrição.',
    link: t ? '/t/' + t.slug + '/inscricao?r=' + reg.publicToken : null,
  });
  return { ok: true, confirmed: true, cashback: cb };
}

// ---------------------------------------------------------------------
// Cashback (1x, só sobre o que foi pago em dinheiro)
// ---------------------------------------------------------------------
async function creditCashback(regId, { userIdOverride } = {}) {
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: regId } });
  if (!reg || reg.status !== 'CONFIRMED') return { ok: true, credited: false };
  if (reg.cashbackAt) return { ok: true, credited: false, already: true };
  const cfg = await getConfig(reg.tournamentId);
  const pct = clamp(intOr(cfg.cashbackPct, 0), 0, 30);
  const cents = Math.floor(((reg.paidCents || 0) * pct) / 100);
  if (!(pct > 0) || cents <= 0) return { ok: true, credited: false };
  const userId = userIdOverride || (await userForRegistration(reg));
  if (!userId) {
    if (reg.cashbackStatus !== 'NO_ACCOUNT') await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { cashbackStatus: 'NO_ACCOUNT', cashbackCents: cents } });
    return { ok: true, credited: false, noAccount: true, cents };
  }
  const t = await prisma.tournament.findUnique({ where: { id: reg.tournamentId }, select: { name: true } });
  const out = await prisma.$transaction(async (tx) => {
    const claim = await tx.tournamentRegistration.updateMany({
      where: { id: reg.id, cashbackAt: null, status: 'CONFIRMED' },
      data: { cashbackAt: new Date(), cashbackCents: cents, cashbackUserId: userId, cashbackStatus: 'CREDITED' },
    });
    if (!claim.count) return null; // outro processo já creditou
    const u = await tx.user.update({ where: { id: userId }, data: { balance: { increment: reais(cents) } } });
    const trx = await tx.transaction.create({
      data: {
        type: 'tournament_registration_cashback',
        amount: reais(cents),
        description: `Cashback inscrição: ${t ? t.name : 'torneio'} (${pct}%)`,
        senderId: null, receiverId: userId, balanceAfter: u.balance,
        metadata: JSON.stringify({ tournamentId: reg.tournamentId, registrationId: reg.id, pct, baseCents: reg.paidCents }),
      },
    });
    await tx.tournamentRegistration.update({ where: { id: reg.id }, data: { cashbackTxId: trx.id } });
    return { txId: trx.id, balance: u.balance };
  });
  if (!out) return { ok: true, credited: false, already: true };
  return { ok: true, credited: true, cents, userId, ...out };
}

// ---------------------------------------------------------------------
// TenisCash (ledger interno)
// ---------------------------------------------------------------------
async function debitTenisCash(reg, userId, cents) {
  const t = await prisma.tournament.findUnique({ where: { id: reg.tournamentId }, select: { name: true } });
  return prisma.$transaction(async (tx) => {
    const claim = await tx.tournamentRegistration.updateMany({
      where: { id: reg.id, status: 'PENDING_PAYMENT', tcTxId: null },
      data: { tcCents: { increment: cents } },
    });
    if (!claim.count) fail(409, 'esta inscrição já recebeu pagamento em TenisCash');
    const dec = await tx.user.updateMany({ where: { id: userId, balance: { gte: reais(cents) - 1e-9 } }, data: { balance: { decrement: reais(cents) } } });
    if (!dec.count) fail(402, 'saldo TenisCash insuficiente');
    const u = await tx.user.findUnique({ where: { id: userId }, select: { balance: true } });
    const trx = await tx.transaction.create({
      data: {
        type: 'tournament_registration_fee', amount: reais(cents),
        description: `Inscrição: ${t ? t.name : 'torneio'} (${reg.displayName})`,
        senderId: userId, receiverId: null, balanceAfter: u.balance,
        metadata: JSON.stringify({ tournamentId: reg.tournamentId, registrationId: reg.id }),
      },
    });
    await tx.tournamentRegistration.update({ where: { id: reg.id }, data: { tcTxId: trx.id, userId: reg.userId || userId } });
    return { txId: trx.id, balance: u.balance };
  });
}

async function refundTenisCash(db, reg, reason) {
  if (!(reg.tcCents > 0) || !reg.tcTxId || reg.tcRefundTxId) return null;
  const tx0 = await db.transaction.findUnique({ where: { id: reg.tcTxId } });
  const payerId = tx0 && tx0.senderId;
  if (!payerId) return null;
  const claim = await db.tournamentRegistration.updateMany({ where: { id: reg.id, tcRefundTxId: null }, data: { tcRefundTxId: 'pending' } });
  if (!claim.count) return null;
  const u = await db.user.update({ where: { id: payerId }, data: { balance: { increment: reais(reg.tcCents) } } });
  const trx = await db.transaction.create({
    data: {
      type: 'tournament_registration_refund', amount: reais(reg.tcCents),
      description: `Estorno TenisCash da inscrição (${reason})`,
      senderId: null, receiverId: payerId, balanceAfter: u.balance,
      metadata: JSON.stringify({ tournamentId: reg.tournamentId, registrationId: reg.id }),
    },
  });
  await db.tournamentRegistration.update({ where: { id: reg.id }, data: { tcRefundTxId: trx.id } });
  return trx.id;
}

// ---------------------------------------------------------------------
// Pagamento
// ---------------------------------------------------------------------
async function loadByToken(publicToken) {
  const reg = await prisma.tournamentRegistration.findUnique({ where: { publicToken: String(publicToken || '') } });
  if (!reg) fail(404, 'inscrição não encontrada');
  return reg;
}

async function ensurePixCharge(reg, cfg, t) {
  const amount = dueCents(reg);
  if (amount <= 0) return null;
  const now = new Date();
  const existing = await prisma.tournamentPaymentCharge.findFirst({ where: { registrationId: reg.id, status: 'PENDING', amountCents: amount, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
  if (existing) return existing;
  const av = await pix.availability(prisma, cfg, t);
  if (!av.ok) fail(409, 'PIX indisponível neste torneio: ' + av.reason);
  // pagamento só reserva a vaga até paymentExpiresAt
  let expiresAt = reg.paymentExpiresAt;
  if (!expiresAt || new Date(expiresAt) <= now) {
    expiresAt = new Date(Date.now() + cfg.holdMinutes * 60000);
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { paymentExpiresAt: expiresAt } });
  }
  // cobranças pendentes antigas (valor diferente) deixam de valer
  await prisma.tournamentPaymentCharge.updateMany({ where: { registrationId: reg.id, status: 'PENDING' }, data: { status: 'CANCELED' } });
  const charge = await prisma.tournamentPaymentCharge.create({
    data: { registrationId: reg.id, tournamentId: reg.tournamentId, provider: av.provider, storeId: av.store ? av.store.id : null, amountCents: amount, expiresAt },
  });
  try {
    const r = await pix.createCharge({ store: av.store, chargeId: charge.id, amountCents: amount, expiresAt, customerName: reg.contactName, description: 'Inscrição ' + t.name });
    return prisma.tournamentPaymentCharge.update({ where: { id: charge.id }, data: { providerOrderId: r.providerOrderId, qrText: r.qrText, qrPngUrl: r.qrPngUrl || null } });
  } catch (e) {
    await prisma.tournamentPaymentCharge.update({ where: { id: charge.id }, data: { status: 'CANCELED' } });
    console.error('[treg pix] falha ao gerar cobrança:', e.message);
    fail(502, 'não foi possível gerar o PIX agora — tente de novo em instantes');
  }
}

/**
 * Inicia/escolhe o pagamento. method: PIX | TENISCASH | MIXED | ONSITE
 * tcCents (MIXED): quanto do TenisCash usar; o resto vai pro PIX.
 */
async function startPayment(publicToken, { method, tcCents } = {}, user) {
  await expireStale({ registrationToken: publicToken }).catch(() => {});
  let reg = await loadByToken(publicToken);
  if (reg.status !== 'PENDING_PAYMENT') fail(409, `esta inscrição está "${STATUS_LABEL[reg.status] || reg.status}"`);
  const t = await prisma.tournament.findUnique({ where: { id: reg.tournamentId } });
  const cfg = await getConfig(reg.tournamentId);
  const m = String(method || 'PIX').toUpperCase();
  const due = dueCents(reg);
  if (due <= 0) { await confirmRegistration(reg.id, { reason: 'zero-due' }); return publicStatus(publicToken, user); }

  if (m === 'TENISCASH' || m === 'MIXED') {
    if (!cfg.allowTenisCash) fail(409, 'este torneio não aceita TenisCash');
    if (!user) fail(401, 'entre na sua conta TenisCash para usar o saldo');
    const want = m === 'TENISCASH' ? due : intOr(tcCents, 0);
    if (!(want > 0)) fail(400, 'informe quanto do saldo TenisCash usar');
    if (want > due) fail(400, 'o valor em TenisCash passa do valor da inscrição');
    if (m === 'MIXED' && want === due) return startPayment(publicToken, { method: 'TENISCASH' }, user);
    await debitTenisCash(reg, user.id, want);
    await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'PAID_TENISCASH', actorUserId: user.id, data: { tcCents: want } });
    reg = await prisma.tournamentRegistration.findUnique({ where: { id: reg.id } });
    if (dueCents(reg) === 0) {
      await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { paymentMethod: reg.paidCents > 0 ? 'MIXED' : 'TENISCASH' } });
      await confirmRegistration(reg.id, { reason: 'teniscash' });
      return publicStatus(publicToken, user);
    }
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { paymentMethod: 'MIXED' } });
    await ensurePixCharge(reg, cfg, t);
    return publicStatus(publicToken, user);
  }
  if (m === 'ONSITE') {
    if (!cfg.allowOnsite) fail(409, 'este torneio não aceita pagamento no local');
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { paymentMethod: reg.tcCents > 0 ? 'MIXED' : 'ONSITE', paymentExpiresAt: null } });
    await prisma.tournamentPaymentCharge.updateMany({ where: { registrationId: reg.id, status: 'PENDING' }, data: { status: 'CANCELED' } });
    await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'CHOSE_ONSITE', actorUserId: user ? user.id : null });
    return publicStatus(publicToken, user);
  }
  if (m !== 'PIX') fail(400, 'forma de pagamento inválida');
  if (reg.paymentMethod !== 'MIXED') await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { paymentMethod: 'PIX' } });
  await ensurePixCharge(reg, cfg, t);
  return publicStatus(publicToken, user);
}

/**
 * Confere uma cobrança no PSP (re-consulta, nunca confia no payload) e,
 * se paga, liquida. Idempotente: chamar N vezes credita/confirma 1x.
 */
async function settleCharge(chargeId) {
  const charge = await prisma.tournamentPaymentCharge.findUnique({ where: { id: String(chargeId) } });
  if (!charge || !charge.providerOrderId) return { ok: false, error: 'cobrança não encontrada' };
  if (charge.status === 'PAID') return { ok: true, already: true };
  const store = charge.storeId ? await prisma.store.findUnique({ where: { id: charge.storeId } }) : null;
  let st;
  try {
    st = await pix.fetchStatus({ store, providerOrderId: charge.providerOrderId, chargeId: charge.id });
  } catch (e) {
    console.error('[treg pix] consulta falhou:', e.message);
    return { ok: false, error: 'consulta ao PSP falhou' };
  }
  await prisma.tournamentPaymentCharge.update({ where: { id: charge.id }, data: { lastCheckedAt: new Date() } }).catch(() => {});
  if (!st.paid) return { ok: true, paid: false, status: st.status };
  return markChargePaid(charge.id, { paidCents: st.paidCents, e2e: st.e2e });
}

async function markChargePaid(chargeId, { paidCents, e2e }) {
  const charge = await prisma.tournamentPaymentCharge.findUnique({ where: { id: chargeId } });
  const paid = Number.isInteger(paidCents) ? paidCents : charge.amountCents;
  const claim = await prisma.tournamentPaymentCharge.updateMany({
    where: { id: chargeId, status: { in: ['PENDING', 'EXPIRED', 'CANCELED'] } },
    data: { status: 'PAID', paidAt: new Date(), paidCents: paid, e2e: e2e || null },
  });
  if (!claim.count) return { ok: true, already: true };
  const reg0 = await prisma.tournamentRegistration.update({ where: { id: charge.registrationId }, data: { paidCents: { increment: paid } } });
  await audit(prisma, { tournamentId: reg0.tournamentId, registrationId: reg0.id, action: 'PAID_PIX', data: { chargeId, paidCents: paid, expectedCents: charge.amountCents, e2e: e2e ? String(e2e).slice(0, 12) + '…' : null } });
  if (paid < charge.amountCents) {
    await audit(prisma, { tournamentId: reg0.tournamentId, registrationId: reg0.id, action: 'UNDERPAID', note: `pago ${fmtBRL(paid)} de ${fmtBRL(charge.amountCents)} — conferir` });
    return { ok: true, paid: true, confirmed: false, underpaid: true };
  }
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: reg0.id } });
  if (reg.status === 'PENDING_PAYMENT') return { ok: true, paid: true, ...(await confirmRegistration(reg.id, { reason: 'pix' })) };
  if (reg.status === 'CONFIRMED') return { ok: true, paid: true, already: true };
  // pago DEPOIS de expirar/cancelar: confirma se ainda há vaga; senão vai pro estorno manual
  const t = await prisma.tournament.findUnique({ where: { id: reg.tournamentId } });
  const cfg = await getConfig(reg.tournamentId);
  const left = await spotsLeft(prisma, t, cfg, reg.categoryId);
  if (left > 0 && ['EXPIRED', 'CANCELED'].includes(reg.status)) {
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { status: 'PENDING_PAYMENT', canceledAt: null } });
    return { ok: true, paid: true, late: true, ...(await confirmRegistration(reg.id, { reason: 'pix-late' })) };
  }
  await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { refundStatus: 'REQUESTED', refundRequestedAt: new Date(), refundReason: 'PIX recebido depois do prazo e sem vaga — devolver manualmente' } });
  await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'PAID_LATE_NO_SLOT', note: 'precisa de estorno manual' });
  try { await notify(t.ownerId, { type: 'entry', title: 'PIX recebido sem vaga', body: `${reg.displayName} pagou depois do prazo e não há vaga. Faça o estorno manual no painel.`, link: '#/inscricoes/' + t.id }, { waCategory: 'organizer' }); } catch (_) {}
  return { ok: true, paid: true, confirmed: false, needsRefund: true };
}

// Webhook do PagBank: acha a cobrança pelo reference_id/order id e liquida.
async function handlePagbankWebhook(payload) {
  const p = payload || {};
  const orderId = p.id || p.order_id || (p.data && p.data.id) || (p.charges && p.charges[0] && p.charges[0].order_id) || null;
  const ref = p.reference_id || (p.data && p.data.reference_id) || (p.charges && p.charges[0] && p.charges[0].reference_id) || null;
  let charge = null;
  const cid = pix.chargeIdFromReference(ref);
  if (cid) charge = await prisma.tournamentPaymentCharge.findUnique({ where: { id: cid } });
  if (!charge && orderId) charge = await prisma.tournamentPaymentCharge.findUnique({ where: { providerOrderId: String(orderId) } });
  if (!charge) return { ok: false, ignored: true };
  return settleCharge(charge.id);
}

// ---------------------------------------------------------------------
// Expiração + lista de espera
// ---------------------------------------------------------------------
async function expireOne(reg) {
  // antes de expirar: o PIX pode ter caído sem webhook
  const pend = await prisma.tournamentPaymentCharge.findMany({ where: { registrationId: reg.id, status: 'PENDING', providerOrderId: { not: null } } });
  for (const c of pend) {
    const r = await settleCharge(c.id);
    if (r && r.paid) return { expired: false, paid: true };
  }
  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.tournamentRegistration.updateMany({
      where: { id: reg.id, status: 'PENDING_PAYMENT', paymentExpiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED', canceledAt: new Date() },
    });
    if (!r.count) return false;
    await tx.tournamentPaymentCharge.updateMany({ where: { registrationId: reg.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    await releaseCoupon(tx, reg);
    await refundTenisCash(tx, reg, 'inscrição expirou');
    return true;
  });
  if (!done) return { expired: false };
  await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'EXPIRED' });
  await notifyReg(reg, { type: 'entry', title: 'Inscrição expirou', body: `O prazo de pagamento da inscrição "${reg.displayName}" acabou e a vaga foi liberada.` + (reg.tcCents > 0 ? ' O TenisCash usado voltou pro seu saldo.' : '') });
  await promoteWaitlist(reg.tournamentId, reg.categoryId);
  return { expired: true };
}

async function expireStale({ tournamentId, registrationToken } = {}) {
  const where = { status: 'PENDING_PAYMENT', paymentExpiresAt: { lt: new Date() } };
  if (tournamentId) where.tournamentId = tournamentId;
  if (registrationToken) where.publicToken = String(registrationToken);
  const list = await prisma.tournamentRegistration.findMany({ where, take: 100, orderBy: { paymentExpiresAt: 'asc' } });
  let expired = 0;
  for (const reg of list) {
    const r = await expireOne(reg).catch((e) => { console.error('[treg expire]', e.message); return {}; });
    if (r.expired) expired += 1;
  }
  return { expired };
}

// Cobranças pendentes sem webhook há um tempo → confere no PSP (auto-cura).
async function pollPendingCharges({ olderThanMs = 120000, limit = 20 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const list = await prisma.tournamentPaymentCharge.findMany({
    where: { status: 'PENDING', providerOrderId: { not: null }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: cutoff } }] },
    take: limit, orderBy: { createdAt: 'asc' },
  });
  let paid = 0;
  for (const c of list) {
    const r = await settleCharge(c.id).catch(() => null);
    if (r && r.paid) paid += 1;
  }
  return { checked: list.length, paid };
}

async function promoteWaitlist(tournamentId, categoryId) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t || ['FINISHED', 'CANCELED'].includes(t.status)) return [];
  const cfg = await getConfig(tournamentId);
  const promoted = await prisma.$transaction(async (tx) => {
    await lockCategory(tx, categoryId);
    const out = [];
    let left = await spotsLeft(tx, t, cfg, categoryId);
    while (left > 0) {
      const next = await tx.tournamentRegistration.findFirst({ where: { categoryId, status: 'WAITLIST' }, orderBy: { createdAt: 'asc' } });
      if (!next) break;
      const deadline = new Date(Date.now() + cfg.waitlistHoldHours * 3600000);
      await tx.tournamentRegistration.update({ where: { id: next.id }, data: { status: 'PENDING_PAYMENT', promotedAt: new Date(), paymentExpiresAt: deadline } });
      out.push({ ...next, status: 'PENDING_PAYMENT', paymentExpiresAt: deadline });
      left -= 1;
    }
    return out;
  });
  for (const reg of promoted) {
    await audit(prisma, { tournamentId, registrationId: reg.id, action: 'PROMOTED_FROM_WAITLIST', data: { deadline: reg.paymentExpiresAt } });
    if (dueCents(reg) === 0) {
      await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { paymentMethod: reg.paymentMethod || 'FREE' } });
      await confirmRegistration(reg.id, { reason: 'waitlist-free' });
      continue;
    }
    const prazo = new Date(reg.paymentExpiresAt).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    await notifyReg(reg, {
      type: 'entry', title: 'Abriu vaga pra você! 🎾',
      body: `Saiu da lista de espera: "${reg.displayName}" em "${t.name}". Pague ${fmtBRL(dueCents(reg))} até ${prazo} pra garantir a vaga.`,
      link: '/t/' + t.slug + '/inscricao?r=' + reg.publicToken,
    });
  }
  return promoted;
}

// ---------------------------------------------------------------------
// Cancelamento / reembolso
// ---------------------------------------------------------------------
async function cancelUnpaid(reg, { actorUserId, reason }) {
  if (!['PENDING_PAYMENT', 'WAITLIST'].includes(reg.status)) fail(409, 'só dá pra cancelar inscrição ainda não confirmada — peça reembolso');
  if (reg.paidCents > 0) fail(409, 'inscrição com PIX recebido: o organizador faz o estorno');
  const ok = await prisma.$transaction(async (tx) => {
    const r = await tx.tournamentRegistration.updateMany({ where: { id: reg.id, status: { in: ['PENDING_PAYMENT', 'WAITLIST'] }, paidCents: 0 }, data: { status: 'CANCELED', canceledAt: new Date() } });
    if (!r.count) return false;
    await tx.tournamentPaymentCharge.updateMany({ where: { registrationId: reg.id, status: 'PENDING' }, data: { status: 'CANCELED' } });
    await releaseCoupon(tx, reg);
    await refundTenisCash(tx, reg, reason || 'inscrição cancelada');
    return true;
  });
  if (!ok) fail(409, 'inscrição mudou de situação, recarregue');
  await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'CANCELED', actorUserId, note: reason });
  if (reg.status === 'PENDING_PAYMENT') await promoteWaitlist(reg.tournamentId, reg.categoryId);
  return { ok: true };
}

async function cancelByToken(publicToken, user) {
  const reg = await loadByToken(publicToken);
  return cancelUnpaid(reg, { actorUserId: user ? user.id : null, reason: 'cancelada pelo atleta' });
}

async function requestRefund(publicToken, reason, user) {
  const reg = await loadByToken(publicToken);
  if (reg.status !== 'CONFIRMED') fail(409, 'reembolso só para inscrição confirmada');
  if (!(reg.paidCents > 0 || reg.tcCents > 0)) fail(409, 'inscrição sem valor pago');
  if (reg.refundStatus === 'REQUESTED') return { ok: true, already: true };
  await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { refundStatus: 'REQUESTED', refundRequestedAt: new Date(), refundReason: clean(reason, 300) || null } });
  await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'REFUND_REQUESTED', actorUserId: user ? user.id : null, note: clean(reason, 300) });
  const t = await prisma.tournament.findUnique({ where: { id: reg.tournamentId }, select: { ownerId: true, name: true, id: true } });
  try { await notify(t.ownerId, { type: 'entry', title: 'Pedido de reembolso', body: `${reg.displayName} pediu reembolso da inscrição em "${t.name}".`, link: '#/inscricoes/' + t.id }, { waCategory: 'organizer' }); } catch (_) {}
  return { ok: true };
}

// Organizador marca pago no local (auditado).
async function markPaidOnsite(regId, { amountCents, note }, actorUserId) {
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: regId } });
  if (!reg) fail(404, 'inscrição não encontrada');
  if (!['PENDING_PAYMENT', 'WAITLIST', 'EXPIRED'].includes(reg.status)) fail(409, `inscrição está "${STATUS_LABEL[reg.status] || reg.status}"`);
  if (reg.status !== 'PENDING_PAYMENT') {
    const t = await prisma.tournament.findUnique({ where: { id: reg.tournamentId } });
    const cfg = await getConfig(reg.tournamentId);
    if ((await spotsLeft(prisma, t, cfg, reg.categoryId)) <= 0) fail(409, 'não há vaga nesta categoria (aumente as vagas antes)');
  }
  const due = dueCents(reg);
  const amount = amountCents == null || amountCents === '' ? due : intOr(amountCents, -1);
  if (amount < 0 || amount > 10000000) fail(400, 'valor inválido');
  if (amount < due) fail(400, `valor menor que o devido (${fmtBRL(due)})`);
  const r = await prisma.tournamentRegistration.updateMany({
    where: { id: reg.id, status: reg.status },
    data: { paidCents: { increment: amount }, paymentMethod: reg.tcCents > 0 ? 'MIXED' : 'ONSITE', status: 'PENDING_PAYMENT', canceledAt: null },
  });
  if (!r.count) fail(409, 'inscrição mudou de situação, recarregue');
  await prisma.tournamentPaymentCharge.updateMany({ where: { registrationId: reg.id, status: 'PENDING' }, data: { status: 'CANCELED' } });
  await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'MARK_PAID_ONSITE', actorUserId, note: clean(note, 300), data: { amountCents: amount, fromStatus: reg.status } });
  return confirmRegistration(reg.id, { reason: 'onsite' });
}

// Organizador registra estorno MANUAL (o dinheiro ele devolve fora do sistema).
async function registerRefund(regId, { refundCents, note, denied }, actorUserId) {
  const reg = await prisma.tournamentRegistration.findUnique({ where: { id: regId } });
  if (!reg) fail(404, 'inscrição não encontrada');
  if (denied) {
    if (reg.refundStatus !== 'REQUESTED') fail(409, 'não há pedido de reembolso aberto');
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { refundStatus: 'DENIED', refundNote: clean(note, 300) || null } });
    await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'REFUND_DENIED', actorUserId, note });
    await notifyReg(reg, { type: 'entry', title: 'Reembolso não aprovado', body: `O organizador não aprovou o reembolso da inscrição "${reg.displayName}".` + (note ? ' Motivo: ' + clean(note, 200) : '') });
    return { ok: true, denied: true };
  }
  if (reg.status === 'REFUNDED') return { ok: true, already: true };
  if (!(reg.paidCents > 0 || reg.tcCents > 0)) fail(409, 'inscrição sem valor pago — use cancelar');
  if (!clean(note, 300)) fail(400, 'descreva como o estorno foi feito (ex: PIX devolvido em 17/11 pelo banco X)');
  const money = refundCents == null || refundCents === '' ? reg.paidCents : intOr(refundCents, -1);
  if (money < 0 || money > reg.paidCents) fail(400, `valor de estorno em dinheiro: 0 a ${fmtBRL(reg.paidCents)}`);
  const claim = await prisma.tournamentRegistration.updateMany({
    where: { id: reg.id, status: { not: 'REFUNDED' } },
    data: { status: 'REFUNDED', refundStatus: 'REFUNDED', refundedAt: new Date(), refundedBy: actorUserId || null, refundNote: clean(note, 300), refundCents: money },
  });
  if (!claim.count) return { ok: true, already: true };
  const tcRefundTx = await refundTenisCash(prisma, reg, 'estorno da inscrição');
  // cashback concedido volta (se houver saldo); senão fica pendente pro organizador ver
  let cashback = null;
  if (reg.cashbackStatus === 'CREDITED' && reg.cashbackUserId && reg.cashbackCents > 0) {
    const dec = await prisma.user.updateMany({ where: { id: reg.cashbackUserId, balance: { gte: reais(reg.cashbackCents) - 1e-9 } }, data: { balance: { decrement: reais(reg.cashbackCents) } } });
    if (dec.count) {
      const u = await prisma.user.findUnique({ where: { id: reg.cashbackUserId }, select: { balance: true } });
      await prisma.transaction.create({ data: { type: 'tournament_registration_cashback_reversal', amount: reais(reg.cashbackCents), description: 'Estorno do cashback da inscrição', senderId: reg.cashbackUserId, receiverId: null, balanceAfter: u.balance, metadata: JSON.stringify({ tournamentId: reg.tournamentId, registrationId: reg.id }) } });
      cashback = 'REVERSED';
    } else cashback = 'REVERSAL_PENDING';
    await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { cashbackStatus: cashback } });
  }
  // tira da chave: apaga a entry se ainda não tem jogo; senão WITHDRAWN
  if (reg.entryId) {
    const games = await prisma.tournamentMatch.count({ where: { OR: [{ homeEntryId: reg.entryId }, { awayEntryId: reg.entryId }] } });
    if (games) await prisma.tournamentEntry.update({ where: { id: reg.entryId }, data: { status: 'WITHDRAWN' } }).catch(() => {});
    else {
      await prisma.rosterPlayer.deleteMany({ where: { entryId: reg.entryId } }).catch(() => {});
      await prisma.tournamentEntry.delete({ where: { id: reg.entryId } }).catch(() => {});
      await prisma.tournamentRegistration.update({ where: { id: reg.id }, data: { entryId: null } });
    }
  }
  await audit(prisma, { tournamentId: reg.tournamentId, registrationId: reg.id, action: 'REFUNDED_MANUAL', actorUserId, note, data: { refundCents: money, tcCents: reg.tcCents, tcRefundTx, cashback } });
  await notifyReg(reg, { type: 'entry', title: 'Estorno registrado', body: `O organizador registrou o estorno da inscrição "${reg.displayName}"` + (money ? ` (${fmtBRL(money)} em dinheiro)` : '') + (reg.tcCents ? ` e ${fmtBRL(reg.tcCents)} de TenisCash voltou pro saldo` : '') + '.' });
  await promoteWaitlist(reg.tournamentId, reg.categoryId);
  return { ok: true, refunded: true, cashback };
}

// ---------------------------------------------------------------------
// Visões
// ---------------------------------------------------------------------
async function qrDataUrl(text) {
  try { return await require('qrcode').toDataURL(String(text), { errorCorrectionLevel: 'M', margin: 1, width: 320 }); } catch (_) { return null; }
}

async function publicTournament(slugOrId, user) {
  const t = await findTournament(slugOrId);
  const cfg = await getConfig(t.id);
  await expireStale({ tournamentId: t.id }).catch(() => {});
  const cats = await prisma.tournamentCategory.findMany({ where: { tournamentId: t.id }, orderBy: { name: 'asc' } });
  const categories = [];
  for (const c of cats) {
    const rules = categoryRules(cfg, c.id);
    const left = await spotsLeft(prisma, t, cfg, c.id);
    const waitlist = await prisma.tournamentRegistration.count({ where: { categoryId: c.id, status: 'WAITLIST' } });
    categories.push({ id: c.id, name: c.name, gender: c.gender, levelLabel: c.levelLabel, feeCents: rules.feeCents, maxEntries: rules.maxEntries, spotsLeft: Number.isFinite(left) ? left : null, waitlist });
  }
  const av = await pix.availability(prisma, cfg, t);
  const open = cfg.enabled && ['OPEN', 'ONGOING'].includes(t.status) && !(t.registrationCloseAt && new Date(t.registrationCloseAt) < new Date());
  return {
    tournament: { id: t.id, slug: t.slug, name: t.name, sport: t.sport, isDoubles: t.isDoubles, status: t.status, city: t.city, state: t.state, startDate: t.startDate, endDate: t.endDate, registrationCloseAt: t.registrationCloseAt, bannerUrl: t.bannerUrl },
    open, enabled: cfg.enabled, kind: kindFor(t), categories,
    customFields: cfg.customFields, terms: cfg.termsText ? { text: cfg.termsText, version: cfg.termsVersion } : null,
    payment: { pix: av.ok, tenisCash: cfg.allowTenisCash, onsite: cfg.allowOnsite, holdMinutes: cfg.holdMinutes },
    cashbackPct: cfg.cashbackPct || 0,
    me: user ? { name: user.name, phone: user.phone, email: user.email || null, username: user.username || null, balanceCents: Math.round((user.balance || 0) * 100) } : null,
  };
}

async function publicStatus(publicToken, user) {
  let reg = await loadByToken(publicToken);
  // auto-cura: PIX pago sem webhook (no máx. 1 consulta a cada 10s)
  if (reg.status === 'PENDING_PAYMENT') {
    const c = await prisma.tournamentPaymentCharge.findFirst({ where: { registrationId: reg.id, status: 'PENDING', providerOrderId: { not: null } }, orderBy: { createdAt: 'desc' } });
    if (c && (!c.lastCheckedAt || Date.now() - new Date(c.lastCheckedAt).getTime() > 10000)) await settleCharge(c.id).catch(() => {});
    if (reg.paymentExpiresAt && new Date(reg.paymentExpiresAt) < new Date()) await expireOne(reg).catch(() => {});
    reg = await loadByToken(publicToken);
  }
  // cashback que ficou sem conta: credita quando o dono do telefone entra logado
  if (user && reg.status === 'CONFIRMED' && reg.cashbackStatus === 'NO_ACCOUNT') {
    const p = digits(user.phone);
    const rp = digits(reg.contactPhone);
    if (p && (p === rp || p === '55' + rp || '55' + p === rp)) {
      await creditCashback(reg.id, { userIdOverride: user.id }).catch(() => {});
      reg = await loadByToken(publicToken);
    }
  }
  const tFull = await prisma.tournament.findUnique({ where: { id: reg.tournamentId } });
  const t = { id: tFull.id, slug: tFull.slug, name: tFull.name, startDate: tFull.startDate, endDate: tFull.endDate, city: tFull.city, state: tFull.state };
  const cat = await prisma.tournamentCategory.findUnique({ where: { id: reg.categoryId }, select: { name: true } });
  const cfg = await getConfig(reg.tournamentId);
  const out = {
    id: reg.id, status: reg.status, statusLabel: STATUS_LABEL[reg.status] || reg.status, kind: reg.kind,
    displayName: reg.displayName, category: cat ? cat.name : '', tournament: t,
    feeCents: reg.feeCents, discountCents: reg.discountCents, couponCode: reg.couponCode,
    tcCents: reg.tcCents, paidCents: reg.paidCents, dueCents: dueCents(reg), paymentMethod: reg.paymentMethod,
    paymentExpiresAt: reg.paymentExpiresAt, confirmedAt: reg.confirmedAt, promotedAt: reg.promotedAt,
    cashbackCents: reg.cashbackStatus === 'CREDITED' ? reg.cashbackCents : 0,
    cashbackPending: reg.cashbackStatus === 'NO_ACCOUNT' ? reg.cashbackCents : 0,
    refundStatus: reg.refundStatus,
    payment: { pix: (await pix.availability(prisma, cfg, tFull)).ok, tenisCash: cfg.allowTenisCash, onsite: cfg.allowOnsite },
    me: user ? { balanceCents: Math.round((user.balance || 0) * 100) } : null,
  };
  if (reg.status === 'WAITLIST') {
    out.waitlistPosition = 1 + (await prisma.tournamentRegistration.count({ where: { categoryId: reg.categoryId, status: 'WAITLIST', createdAt: { lt: reg.createdAt } } }));
  }
  if (reg.status === 'PENDING_PAYMENT') {
    const c = await prisma.tournamentPaymentCharge.findFirst({ where: { registrationId: reg.id, status: 'PENDING', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
    if (c && c.qrText) out.pix = { amountCents: c.amountCents, qrText: c.qrText, qrImage: await qrDataUrl(c.qrText), expiresAt: c.expiresAt };
  }
  if (reg.status === 'CONFIRMED') {
    out.checkin = { code: reg.checkinToken, qrImage: await qrDataUrl('TREG:' + reg.checkinToken) };
  }
  return out;
}

// ---------------------------------------------------------------------
// Painel do organizador
// ---------------------------------------------------------------------
async function listForOrganizer(tournamentId, { status, categoryId, q } = {}) {
  await expireStale({ tournamentId }).catch(() => {});
  const where = { tournamentId };
  if (status) where.status = String(status);
  if (categoryId) where.categoryId = String(categoryId);
  if (q) {
    const s = clean(q, 60);
    where.OR = [{ displayName: { contains: s, mode: 'insensitive' } }, { contactName: { contains: s, mode: 'insensitive' } }, { contactPhone: { contains: digits(s) || s } }];
  }
  const [rows, all, cats, checks] = await Promise.all([
    prisma.tournamentRegistration.findMany({ where, orderBy: { createdAt: 'asc' }, take: 2000 }),
    prisma.tournamentRegistration.findMany({ where: { tournamentId }, select: { status: true, paidCents: true, tcCents: true, refundCents: true, feeCents: true, discountCents: true, cashbackCents: true, cashbackStatus: true, refundStatus: true } }),
    prisma.tournamentCategory.findMany({ where: { tournamentId }, select: { id: true, name: true } }),
    prisma.tournamentCheckin.groupBy({ by: ['registrationId'], where: { tournamentId }, _count: { _all: true } }).catch(() => []),
  ]);
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const checkCount = Object.fromEntries(checks.map((c) => [c.registrationId, c._count._all]));
  const summary = { total: all.length, byStatus: {}, collectedCents: 0, tenisCashCents: 0, refundedCents: 0, pendingCents: 0, cashbackCents: 0, refundRequests: 0 };
  for (const r of all) {
    summary.byStatus[r.status] = (summary.byStatus[r.status] || 0) + 1;
    if (r.status === 'CONFIRMED' || r.status === 'REFUNDED') { summary.collectedCents += r.paidCents; summary.tenisCashCents += r.tcCents; }
    if (r.status === 'REFUNDED') summary.refundedCents += r.refundCents;
    if (r.status === 'PENDING_PAYMENT') summary.pendingCents += dueCents(r);
    if (r.cashbackStatus === 'CREDITED') summary.cashbackCents += r.cashbackCents;
    if (r.refundStatus === 'REQUESTED') summary.refundRequests += 1;
  }
  summary.netCents = summary.collectedCents - summary.refundedCents;
  return {
    summary,
    registrations: rows.map((r) => ({
      id: r.id, status: r.status, statusLabel: STATUS_LABEL[r.status] || r.status, kind: r.kind, displayName: r.displayName,
      categoryId: r.categoryId, category: catName[r.categoryId] || '', contactName: r.contactName, contactPhone: r.contactPhone, contactEmail: r.contactEmail,
      athletes: r.athletes, roster: r.roster, answers: r.answers,
      feeCents: r.feeCents, discountCents: r.discountCents, couponCode: r.couponCode, tcCents: r.tcCents, paidCents: r.paidCents, dueCents: dueCents(r),
      paymentMethod: r.paymentMethod, paymentExpiresAt: r.paymentExpiresAt, paidAt: r.paidAt, confirmedAt: r.confirmedAt,
      cashbackCents: r.cashbackCents, cashbackStatus: r.cashbackStatus, refundStatus: r.refundStatus, refundReason: r.refundReason, refundNote: r.refundNote, refundCents: r.refundCents,
      termsVersion: r.termsVersion, termsAcceptedAt: r.termsAcceptedAt, entryId: r.entryId, checkins: checkCount[r.id] || 0, createdAt: r.createdAt,
    })),
  };
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // anti CSV-injection
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportCsv(tournamentId) {
  const cfg = await getConfig(tournamentId);
  const { registrations } = await listForOrganizer(tournamentId, {});
  const fields = cfg.customFields || [];
  const money = (c) => (Math.round(c || 0) / 100).toFixed(2).replace('.', ',');
  const dt = (d) => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }) : '');
  const head = ['Inscrição', 'Situação', 'Categoria', 'Tipo', 'Nome', 'Atletas / elenco', 'Menor (responsável)', 'Responsável', 'Telefone', 'E-mail',
    'Taxa (R$)', 'Desconto (R$)', 'Cupom', 'Pago dinheiro (R$)', 'Pago TenisCash (R$)', 'Forma', 'Confirmada em', 'Cashback (R$)', 'Reembolso', 'Estornado (R$)', 'Check-ins', 'Termo (versão)', 'Inscrito em',
    ...fields.map((f) => f.label)];
  const lines = [head.map(csvCell).join(';')];
  for (const r of registrations) {
    const ath = Array.isArray(r.athletes) ? r.athletes : [];
    const people = r.kind === 'TEAM' ? (Array.isArray(r.roster) ? r.roster.map((p) => (p.number != null ? p.number + ' ' : '') + p.name).join(', ') : '') : ath.map((a) => a.name + ' (' + a.birthDate + ')').join(', ');
    const minors = ath.filter((a) => a.minor && a.guardian).map((a) => a.name + ': ' + a.guardian.name + (a.guardian.relationship ? ' (' + a.guardian.relationship + ')' : '') + ' ' + a.guardian.phone).join(' | ');
    const ans = r.answers || {};
    lines.push([
      r.id.slice(-8).toUpperCase(), r.statusLabel, r.category, r.kind, r.displayName, people, minors, r.contactName, r.contactPhone, r.contactEmail || '',
      money(r.feeCents), money(r.discountCents), r.couponCode || '', money(r.paidCents), money(r.tcCents), r.paymentMethod || '', dt(r.confirmedAt),
      r.cashbackStatus === 'CREDITED' ? money(r.cashbackCents) : '', r.refundStatus || '', r.refundCents ? money(r.refundCents) : '', r.checkins, r.termsVersion || '', dt(r.createdAt),
      ...fields.map((f) => (ans[f.key] === true ? 'Sim' : ans[f.key] === false ? 'Não' : ans[f.key] == null ? '' : ans[f.key])),
    ].map(csvCell).join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

async function listAudit(tournamentId, registrationId) {
  return prisma.tournamentRegistrationAudit.findMany({ where: { tournamentId, ...(registrationId ? { registrationId } : {}) }, orderBy: { createdAt: 'desc' }, take: 300 });
}

// Cupons
async function listCoupons(tournamentId) {
  return prisma.tournamentCoupon.findMany({ where: { tournamentId }, orderBy: { createdAt: 'desc' } });
}
async function saveCoupon(tournamentId, b, actorUserId) {
  const code = clean(b.code, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (code.length < 3) fail(400, 'código do cupom: mínimo 3 letras/números');
  const kind = b.kind === 'FIXED' ? 'FIXED' : 'PERCENT';
  const value = intOr(b.value, 0);
  if (kind === 'PERCENT' && (value < 1 || value > 100)) fail(400, 'percentual: 1 a 100');
  if (kind === 'FIXED' && (value < 1 || value > 10000000)) fail(400, 'valor do desconto inválido');
  const maxUses = b.maxUses == null || b.maxUses === '' ? null : intOr(b.maxUses, 0);
  if (maxUses != null && maxUses < 1) fail(400, 'limite de usos: 1 ou mais (vazio = sem limite)');
  const expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
  if (expiresAt && isNaN(expiresAt)) fail(400, 'validade inválida');
  try {
    const c = await prisma.tournamentCoupon.create({ data: { tournamentId, code, kind, value, maxUses, expiresAt, createdBy: actorUserId || null } });
    await audit(prisma, { tournamentId, action: 'COUPON_CREATED', actorUserId, data: { code, kind, value, maxUses } });
    return c;
  } catch (e) {
    if (e.code === 'P2002') fail(409, 'já existe um cupom com esse código');
    throw e;
  }
}
async function setCouponActive(tournamentId, couponId, active, actorUserId) {
  const r = await prisma.tournamentCoupon.updateMany({ where: { id: couponId, tournamentId }, data: { active: !!active } });
  if (!r.count) fail(404, 'cupom não encontrado');
  await audit(prisma, { tournamentId, action: active ? 'COUPON_ON' : 'COUPON_OFF', actorUserId, data: { couponId } });
  return { ok: true };
}

// ---------------------------------------------------------------------
// CHECK-IN por QR + W.O. sugerido
// ---------------------------------------------------------------------
function parseCheckinCode(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/TREG:([A-Za-z0-9_-]{10,64})/);
  if (m) return m[1];
  const u = s.match(/[?&/]c(?:heckin)?[=/]([A-Za-z0-9_-]{10,64})/);
  if (u) return u[1];
  return /^[A-Za-z0-9_-]{10,64}$/.test(s) ? s : null;
}

async function checkin(tournamentId, { code, registrationId, matchId, round }, actorUserId) {
  let reg = null;
  if (registrationId) reg = await prisma.tournamentRegistration.findFirst({ where: { id: String(registrationId), tournamentId } });
  else {
    const tk = parseCheckinCode(code);
    if (!tk) fail(400, 'QR não reconhecido');
    reg = await prisma.tournamentRegistration.findUnique({ where: { checkinToken: tk } });
    if (reg && reg.tournamentId !== tournamentId) fail(409, 'este QR é de outro torneio');
  }
  if (!reg) fail(404, 'inscrição não encontrada');
  if (reg.status !== 'CONFIRMED') fail(409, `inscrição "${STATUS_LABEL[reg.status] || reg.status}" — não pode fazer check-in`);
  let scopeKey = 'event';
  let match = null;
  if (matchId) {
    match = await prisma.tournamentMatch.findFirst({ where: { id: String(matchId), tournamentId } });
    if (!match) fail(404, 'jogo não encontrado neste torneio');
    if (reg.entryId !== match.homeEntryId && reg.entryId !== match.awayEntryId) fail(409, `${reg.displayName} não joga essa partida`);
    scopeKey = 'match:' + match.id;
  } else if (round != null && round !== '') {
    scopeKey = 'round:' + intOr(round, 0);
  }
  const method = registrationId ? 'MANUAL' : 'QR';
  let already = false;
  try {
    await prisma.tournamentCheckin.create({ data: { tournamentId, registrationId: reg.id, entryId: reg.entryId, scopeKey, matchId: match ? match.id : null, method, checkedBy: actorUserId || null } });
  } catch (e) {
    if (e.code !== 'P2002') throw e;
    already = true;
  }
  if (!already && method === 'MANUAL') await audit(prisma, { tournamentId, registrationId: reg.id, action: 'CHECKIN_MANUAL', actorUserId, data: { scopeKey } });
  const cat = await prisma.tournamentCategory.findUnique({ where: { id: reg.categoryId }, select: { name: true } });
  return { ok: true, already, scopeKey, registration: { id: reg.id, displayName: reg.displayName, category: cat ? cat.name : '', kind: reg.kind } };
}

async function undoCheckin(tournamentId, { registrationId, scopeKey }, actorUserId) {
  const r = await prisma.tournamentCheckin.deleteMany({ where: { tournamentId, registrationId: String(registrationId), scopeKey: String(scopeKey) } });
  if (r.count) await audit(prisma, { tournamentId, registrationId, action: 'CHECKIN_UNDO', actorUserId, data: { scopeKey } });
  return { ok: true, removed: r.count };
}

// Presença de um jogo (com sugestão de W.O.) ou de uma rodada/evento.
async function attendance(tournamentId, { matchId, round } = {}) {
  const cfg = await getConfig(tournamentId);
  if (matchId) {
    const m = await prisma.tournamentMatch.findFirst({ where: { id: String(matchId), tournamentId } });
    if (!m) fail(404, 'jogo não encontrado');
    return matchAttendance(m, cfg);
  }
  const scopeKey = round != null && round !== '' ? 'round:' + intOr(round, 0) : 'event';
  const [regs, checks, cats] = await Promise.all([
    prisma.tournamentRegistration.findMany({ where: { tournamentId, status: 'CONFIRMED' }, orderBy: { displayName: 'asc' } }),
    prisma.tournamentCheckin.findMany({ where: { tournamentId, scopeKey } }),
    prisma.tournamentCategory.findMany({ where: { tournamentId }, select: { id: true, name: true } }),
  ]);
  const at = Object.fromEntries(checks.map((c) => [c.registrationId, c]));
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const list = regs.map((r) => ({ registrationId: r.id, displayName: r.displayName, category: catName[r.categoryId] || '', present: !!at[r.id], at: at[r.id] ? at[r.id].createdAt : null, method: at[r.id] ? at[r.id].method : null }));
  return { scopeKey, present: list.filter((x) => x.present).length, absent: list.filter((x) => !x.present).length, list };
}

async function matchAttendance(m, cfg) {
  const scopeKey = 'match:' + m.id;
  const entryIds = [m.homeEntryId, m.awayEntryId].filter(Boolean);
  const [regs, checks, entries] = await Promise.all([
    prisma.tournamentRegistration.findMany({ where: { entryId: { in: entryIds }, status: 'CONFIRMED' } }),
    prisma.tournamentCheckin.findMany({ where: { scopeKey } }),
    prisma.tournamentEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, name: true } }),
  ]);
  const eName = Object.fromEntries(entries.map((e) => [e.id, e.name]));
  const regByEntry = Object.fromEntries(regs.map((r) => [r.entryId, r]));
  const checked = new Set(checks.map((c) => c.registrationId));
  const side = (eid) => {
    if (!eid) return null;
    const r = regByEntry[eid];
    return { entryId: eid, name: eName[eid] || '', registrationId: r ? r.id : null, tracked: !!r, present: r ? checked.has(r.id) : null };
  };
  const home = side(m.homeEntryId);
  const away = side(m.awayEntryId);
  const tol = cfg.checkinToleranceMin || 0;
  const deadline = m.scheduledAt ? new Date(new Date(m.scheduledAt).getTime() + tol * 60000) : null;
  let suggestion = null;
  const open = !['FINISHED', 'WALKOVER'].includes(m.status) && m.status !== 'CANCELED';
  if (open && deadline && Date.now() > deadline.getTime() && home && away && home.tracked && away.tracked) {
    if (home.present && !away.present) suggestion = { type: 'WO', absentEntryId: away.entryId, winnerEntryId: home.entryId, text: `${away.name} não fez check-in até ${tol} min após o horário — sugerir W.O. pra ${home.name}` };
    else if (away.present && !home.present) suggestion = { type: 'WO', absentEntryId: home.entryId, winnerEntryId: away.entryId, text: `${home.name} não fez check-in até ${tol} min após o horário — sugerir W.O. pra ${away.name}` };
    else if (!home.present && !away.present) suggestion = { type: 'BOTH_ABSENT', text: 'Nenhum dos dois fez check-in — coordenador decide' };
  }
  return { matchId: m.id, scopeKey, scheduledAt: m.scheduledAt, status: m.status, toleranceMin: tol, deadline, home, away, suggestion };
}

// Jogos do torneio com presença + sugestões (pra mesa/coordenação).
async function matchesBoard(tournamentId, { day } = {}) {
  const cfg = await getConfig(tournamentId);
  const where = { tournamentId };
  if (day) {
    const start = new Date(day + 'T00:00:00-03:00');
    if (!isNaN(start)) where.scheduledAt = { gte: start, lt: new Date(start.getTime() + 86400000) };
  }
  const ms = await prisma.tournamentMatch.findMany({ where, orderBy: [{ scheduledAt: 'asc' }, { round: 'asc' }, { ordering: 'asc' }], take: 300 });
  const out = [];
  for (const m of ms) {
    if (!m.homeEntryId && !m.awayEntryId) continue;
    const a = await matchAttendance(m, cfg);
    out.push({ ...a, round: m.round, stage: m.stage, location: m.location, categoryId: m.categoryId });
  }
  return { toleranceMin: cfg.checkinToleranceMin, matches: out, suggestions: out.filter((x) => x.suggestion) };
}

// W.O. só com confirmação do coordenador (aqui), nunca automático.
async function confirmWalkover(tournamentId, { matchId, absentEntryId, homeScore, awayScore, note }, actorUserId) {
  const m = await prisma.tournamentMatch.findFirst({ where: { id: String(matchId || ''), tournamentId } });
  if (!m) fail(404, 'jogo não encontrado');
  if (![m.homeEntryId, m.awayEntryId].includes(absentEntryId)) fail(400, 'time ausente não está nesse jogo');
  if (['FINISHED', 'WALKOVER'].includes(m.status)) fail(409, 'jogo já encerrado');
  const hs = Number(homeScore);
  const as = Number(awayScore);
  if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0) fail(400, 'informe o placar do W.O. conforme o regulamento');
  const winnerEntryId = absentEntryId === m.homeEntryId ? m.awayEntryId : m.homeEntryId;
  if ((winnerEntryId === m.homeEntryId && !(hs > as)) || (winnerEntryId === m.awayEntryId && !(as > hs))) fail(400, 'o placar precisa dar vitória ao time presente');
  const engine = require('./tournamentEngine');
  const r = await engine.applyMatchResult(m.id, { homeScore: hs, awayScore: as, winnerEntryId });
  if (!r.ok) fail(400, r.error || 'não foi possível aplicar o W.O.');
  await audit(prisma, { tournamentId, action: 'WO_CONFIRMED', actorUserId, note: clean(note, 300), data: { matchId: m.id, absentEntryId, winnerEntryId, homeScore: hs, awayScore: as } });
  return { ok: true, winnerEntryId };
}

module.exports = {
  RegError, STATUS_LABEL, SHIRT_SIZES, kindFor, dueCents, couponDiscount,
  getConfig, saveConfig, categoryRules, spotsLeft,
  register, checkCoupon, startPayment, settleCharge, markChargePaid, handlePagbankWebhook,
  confirmRegistration, creditCashback, expireStale, expireOne, pollPendingCharges, promoteWaitlist,
  cancelByToken, cancelUnpaid, requestRefund, markPaidOnsite, registerRefund,
  publicTournament, publicStatus, listForOrganizer, exportCsv, listAudit,
  listCoupons, saveCoupon, setCouponActive,
  parseCheckinCode, checkin, undoCheckin, attendance, matchesBoard, confirmWalkover,
};
