// Login biométrico (WebAuthn / FIDO2) — Face ID, digital, Windows Hello.
// O sistema NÃO guarda biometria: só a chave pública. O aparelho confirma "é você".
// Senha continua como fallback (este módulo só ADICIONA o caminho biométrico).
const express = require('express');
const jwt = require('jsonwebtoken');
const { authMiddleware, getJwtSecret, prisma } = require('../middleware');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

// @simplewebauthn usa a WebCrypto global. Node < 20 (ou alguns runtimes) não expõem
// globalThis.crypto por padrão → "An instance of the Crypto API could not be located".
if (!globalThis.crypto) { try { globalThis.crypto = require('node:crypto').webcrypto; } catch (_) {} }

const router = express.Router();

const RP_ID = process.env.WEBAUTHN_RP_ID || 'teniscash.com.br';
const RP_NAME = 'TenisCash';
// aceita com/sem www; rpID 'teniscash.com.br' já cobre o subdomínio www
const ORIGINS = (process.env.WEBAUTHN_ORIGINS || 'https://teniscash.com.br,https://www.teniscash.com.br').split(',');

// includeRich igual ao /login (pra o payload de retorno ser idêntico)
const includeRich = {
  store: { select: { id: true, name: true, code: true, dna: true, mall: true, city: true, state: true } },
  partner: { select: { id: true, couponCode: true, discountPct: true, commissionPct: true, tier: true, status: true, type: true, totalSales: true, totalCommission: true } },
};
function loginPayload(user) {
  const token = jwt.sign({ userId: user.id, role: user.role }, getJwtSecret(), { expiresIn: '30d' });
  return { token, user: { id: user.id, name: user.name, phone: user.phone, storeId: user.storeId, store: user.store || null, balance: user.balance, partnerBalance: user.partnerBalance || 0, role: user.role, profileComplete: user.profileComplete, createdAt: user.createdAt, partner: user.partner || null } };
}

// challenges temporários (5 min). 1 instância no Railway → Map em memória basta.
const challenges = new Map();
const TTL = 5 * 60 * 1000;
function putChallenge(key, challenge, userId) { challenges.set(key, { challenge, exp: Date.now() + TTL, userId }); }
function takeChallenge(key) { const c = challenges.get(key); challenges.delete(key); if (!c || c.exp < Date.now()) return null; return c; }
const _gc = setInterval(() => { const now = Date.now(); for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k); }, TTL);
if (_gc.unref) _gc.unref();

// ===== STATUS — o usuário tem biometria cadastrada? (autenticado) =====
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const creds = await prisma.webauthnCredential.findMany({ where: { userId: req.userId }, select: { id: true, deviceLabel: true, createdAt: true, lastUsedAt: true } });
    res.json({ enrolled: creds.length > 0, count: creds.length, credentials: creds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== PASSO A — ATIVAR biometria (autenticado: entrou com senha 1x) =====
router.post('/register/options', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, include: { webauthnCredentials: true } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(user.id),
      userName: user.phone || user.name || user.id,
      userDisplayName: user.name || user.phone || 'Usuário',
      attestationType: 'none',
      excludeCredentials: user.webauthnCredentials.map(c => ({ id: c.credentialId, transports: c.transports ? c.transports.split(',') : undefined })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    putChallenge('reg:' + user.id, options.challenge, user.id);
    res.json(options);
  } catch (e) { console.error('[webauthn] register/options', e); res.status(500).json({ error: e.message }); }
});

router.post('/register/verify', authMiddleware, async (req, res) => {
  try {
    const c = takeChallenge('reg:' + req.userId);
    if (!c) return res.status(400).json({ error: 'Sessão expirada — tente ativar de novo.' });
    const verification = await verifyRegistrationResponse({
      response: req.body.cred || req.body,
      expectedChallenge: c.challenge, expectedOrigin: ORIGINS, expectedRPID: RP_ID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Não foi possível registrar a biometria.' });
    const { credential } = verification.registrationInfo;
    await prisma.webauthnCredential.upsert({
      where: { credentialId: credential.id },
      create: {
        userId: req.userId, credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey), counter: credential.counter || 0,
        transports: (credential.transports || []).join(',') || null,
        deviceLabel: String(req.body.label || '').slice(0, 60) || null,
      },
      update: { publicKey: Buffer.from(credential.publicKey), counter: credential.counter || 0 },
    });
    res.json({ ok: true });
  } catch (e) { console.error('[webauthn] register/verify', e); res.status(500).json({ error: e.message }); }
});

// ===== PASSO B — ENTRAR com biometria (público, discoverable) =====
router.post('/auth/options', async (_req, res) => {
  try {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred', allowCredentials: [] });
    putChallenge('auth:' + options.challenge, options.challenge, null);
    res.json(options);
  } catch (e) { console.error('[webauthn] auth/options', e); res.status(500).json({ error: e.message }); }
});

router.post('/auth/verify', async (req, res) => {
  try {
    const resp = req.body.cred || req.body;
    if (!resp || !resp.id || !resp.response) return res.status(400).json({ error: 'Resposta inválida.' });
    const clientData = JSON.parse(Buffer.from(resp.response.clientDataJSON, 'base64url').toString('utf8'));
    const c = takeChallenge('auth:' + clientData.challenge);
    if (!c) return res.status(400).json({ error: 'Sessão expirada — tente de novo.' });
    const cred = await prisma.webauthnCredential.findUnique({ where: { credentialId: resp.id }, include: { user: { include: includeRich } } });
    if (!cred) return res.status(401).json({ error: 'Biometria não reconhecida. Entre com a senha.' });
    const verification = await verifyAuthenticationResponse({
      response: resp, expectedChallenge: c.challenge, expectedOrigin: ORIGINS, expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: { id: cred.credentialId, publicKey: new Uint8Array(cred.publicKey), counter: cred.counter, transports: cred.transports ? cred.transports.split(',') : undefined },
    });
    if (!verification.verified) return res.status(401).json({ error: 'Não foi possível confirmar a biometria.' });
    await prisma.webauthnCredential.update({ where: { id: cred.id }, data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() } });
    if (!cred.user || cred.user.active === false) return res.status(403).json({ error: 'Conta desativada.' });
    res.json(loginPayload(cred.user));
  } catch (e) { console.error('[webauthn] auth/verify', e); res.status(500).json({ error: e.message }); }
});

// remover uma biometria (autenticado)
router.delete('/credentials/:id', authMiddleware, async (req, res) => {
  try {
    await prisma.webauthnCredential.deleteMany({ where: { id: req.params.id, userId: req.userId } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
