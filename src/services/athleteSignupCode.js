// =====================================================================
// Código de verificação do CADASTRO DE ATLETA (Liga Aberta F0).
// ---------------------------------------------------------------------
// POST /api/tournaments/athletes/register/start  → gera e manda o código
// POST /api/tournaments/athletes/register        → só cria a conta com código válido
//
// - 6 dígitos (crypto.randomInt), validade 10 min, no máximo 5 tentativas.
// - No banco fica só o HASH (HMAC-SHA256 com o segredo do servidor), nunca o código.
// - Telefone no MESMO formato do envio (src/services/phoneBR.js → 55+DDD+número):
//   "83 9…" e "5583 9…" são o mesmo número na tabela e no limitador.
// - O código novo só invalida os anteriores DEPOIS de enviado com sucesso.
// - Teto global de envios por 24 h (env ATHLETE_SIGNUP_DAILY_MAX, padrão 500):
//   estourou → 429 sem enviar nada.
// - Envio pelo MESMO canal do cadastro do app (src/whatsapp.js → Meta Cloud
//   com template de autenticação ou Evolution). Sem canal → 503, nada criado.
// Tabela: AthleteSignupCode (aditiva em ensureApexSchema.js).
// =====================================================================

const crypto = require('crypto');
const { prisma, JWT_SECRET } = require('../middleware');
const { formatPhoneBR } = require('./phoneBR');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DAY_MS = 24 * 3600 * 1000;

function dailyMax() {
  const n = Number(process.env.ATHLETE_SIGNUP_DAILY_MAX);
  return process.env.ATHLETE_SIGNUP_DAILY_MAX != null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 500;
}

function defaultSender(phone, code) {
  return require('../whatsapp').sendCodeMessage(phone, code);
}
let sender = defaultSender;
// Só para teste automatizado (injeção do canal de envio). Não é rota.
function setSenderForTests(fn) { sender = typeof fn === 'function' ? fn : defaultSender; }

// 55 + DDD + número (formato do envio) ou null.
function normalizePhone(raw) {
  return formatPhoneBR(raw);
}
// Variantes com e sem 55, pra achar conta já existente gravada de qualquer jeito.
function phoneVariants(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const full = formatPhoneBR(raw);
  return [...new Set([digits, full, full && full.slice(2)].filter(Boolean))];
}

function hashCode(phone, code) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`athlete-signup:${phone}:${code}`).digest('hex');
}
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === 32 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Teto global: códigos enviados nas últimas 24 h (falha de envio não fica gravada).
async function dailyCapReached() {
  const max = dailyMax();
  const sentToday = await prisma.athleteSignupCode.count({ where: { createdAt: { gte: new Date(Date.now() - DAY_MS) } } });
  return sentToday >= max;
}

// phone JÁ normalizado (normalizePhone).
async function startSignup(phone) {
  const now = new Date();
  // faxina: código com mais de 1 dia não serve pra nada (e já saiu da janela do teto)
  await prisma.athleteSignupCode.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - DAY_MS) } } }).catch(() => {});
  if (await dailyCapReached()) {
    return { ok: false, status: 429, error: 'Limite diário de códigos atingido. Tente de novo amanhã.' };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const row = await prisma.athleteSignupCode.create({
    data: { phone, codeHash: hashCode(phone, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS) },
  });
  let r;
  try { r = await sender(phone, code); } catch (e) { r = { success: false, message: e.message }; }
  if (!r || !r.success) {
    await prisma.athleteSignupCode.delete({ where: { id: row.id } }).catch(() => {});
    console.error('[athlete-signup] envio do código falhou:', (r && r.message) || 'sem resposta');
    return { ok: false, status: 503, error: 'Não foi possível enviar o código pelo WhatsApp agora. Tente de novo em alguns minutos.', whatsappDown: true };
  }
  // Só agora o código anterior deixa de valer (se o envio novo falhasse, o antigo seguia).
  await prisma.athleteSignupCode.updateMany({ where: { phone, usedAt: null, id: { not: row.id } }, data: { usedAt: new Date() } });
  return { ok: true, expiresInSeconds: CODE_TTL_MS / 1000, provider: r.provider || null };
}

// Confere o código SEM consumir (a tentativa conta). Retorna { ok, rowId } ou { ok:false, status, error }.
async function checkSignupCode(phone, rawCode) {
  const code = String(rawCode == null ? '' : rawCode).replace(/\D/g, '');
  if (code.length !== 6) return { ok: false, status: 400, error: 'informe o código de 6 dígitos enviado no seu WhatsApp' };
  const row = await prisma.athleteSignupCode.findFirst({ where: { phone, usedAt: null }, orderBy: { createdAt: 'desc' } });
  if (!row || row.expiresAt < new Date()) return { ok: false, status: 400, error: 'código expirado ou não encontrado — peça um novo' };
  // Reserva a tentativa de forma atômica (tentativas em paralelo não furam o limite).
  const reserved = await prisma.athleteSignupCode.updateMany({
    where: { id: row.id, usedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (reserved.count !== 1) {
    await prisma.athleteSignupCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    return { ok: false, status: 429, error: 'muitas tentativas com este código — peça um novo' };
  }
  if (!sameHash(row.codeHash, hashCode(phone, code))) {
    const remaining = Math.max(0, MAX_ATTEMPTS - (row.attempts + 1));
    if (remaining === 0) await prisma.athleteSignupCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    return { ok: false, status: 400, error: remaining ? `código incorreto (restam ${remaining} tentativa(s))` : 'código incorreto — peça um novo', remaining };
  }
  return { ok: true, rowId: row.id };
}

// Consome o código (uso único). `db` pode ser o tx de uma transação: assim a conta
// e o consumo do código nascem juntos ou não nascem.
async function markSignupCodeUsed(db, rowId) {
  const used = await db.athleteSignupCode.updateMany({ where: { id: rowId, usedAt: null }, data: { usedAt: new Date() } });
  return used.count === 1;
}

async function consumeSignupCode(phone, rawCode) {
  const c = await checkSignupCode(phone, rawCode);
  if (!c.ok) return c;
  if (!(await markSignupCodeUsed(prisma, c.rowId))) return { ok: false, status: 400, error: 'código já usado — peça um novo' };
  return { ok: true };
}

module.exports = {
  startSignup, checkSignupCode, markSignupCodeUsed, consumeSignupCode,
  normalizePhone, phoneVariants, setSenderForTests, CODE_TTL_MS, MAX_ATTEMPTS, dailyMax,
};
