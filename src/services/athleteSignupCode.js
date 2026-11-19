// =====================================================================
// Código de verificação do CADASTRO DE ATLETA (Liga Aberta F0).
// ---------------------------------------------------------------------
// POST /api/tournaments/athletes/register/start  → gera e manda o código
// POST /api/tournaments/athletes/register        → só cria a conta com código válido
//
// - 6 dígitos (crypto.randomInt), validade 10 min, no máximo 5 tentativas.
// - No banco fica só o HASH (HMAC-SHA256 com o segredo do servidor), nunca o código.
// - Pedir código novo invalida os anteriores do mesmo telefone.
// - Envio pelo MESMO canal do cadastro do app (src/whatsapp.js → Meta Cloud
//   com template de autenticação ou Evolution). Sem canal → 503, nada criado.
// Tabela: AthleteSignupCode (aditiva em ensureApexSchema.js).
// =====================================================================

const crypto = require('crypto');
const { prisma, JWT_SECRET } = require('../middleware');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function defaultSender(phone, code) {
  return require('../whatsapp').sendCodeMessage(phone, code);
}
let sender = defaultSender;
// Só para teste automatizado (injeção do canal de envio). Não é rota.
function setSenderForTests(fn) { sender = typeof fn === 'function' ? fn : defaultSender; }

function normalizePhone(raw) {
  const p = String(raw || '').replace(/\D/g, '');
  return p.length >= 10 && p.length <= 13 ? p : null;
}

function hashCode(phone, code) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`athlete-signup:${phone}:${code}`).digest('hex');
}
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === 32 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function startSignup(phone) {
  const now = new Date();
  // faxina: código com mais de 1 dia não serve pra nada
  await prisma.athleteSignupCode.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * 3600 * 1000) } } }).catch(() => {});
  await prisma.athleteSignupCode.updateMany({ where: { phone, usedAt: null }, data: { usedAt: now } });
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
  return { ok: true, expiresInSeconds: CODE_TTL_MS / 1000, provider: r.provider || null };
}

// Confere e CONSOME o código (uso único). Retorna { ok } ou { ok:false, status, error }.
async function consumeSignupCode(phone, rawCode) {
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
  const used = await prisma.athleteSignupCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (used.count !== 1) return { ok: false, status: 400, error: 'código já usado — peça um novo' };
  return { ok: true };
}

module.exports = { startSignup, consumeSignupCode, normalizePhone, setSenderForTests, CODE_TTL_MS, MAX_ATTEMPTS };
