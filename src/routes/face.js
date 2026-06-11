// Reconhecimento facial pela CÂMERA (alternativa universal ao Face ID nativo).
// O navegador (face-api) extrai um "descriptor" (128 números do rosto) e manda só ISSO —
// a foto NUNCA sai do aparelho. Aqui comparamos descriptors (distância euclidiana).
// ⚠️ Menos seguro que Face ID (câmera 2D pode ser enganada por foto); senha continua como fallback.
const express = require('express');
const jwt = require('jsonwebtoken');
const { authMiddleware, JWT_SECRET, prisma } = require('../middleware');

const router = express.Router();

// limiar de match. face-api recomenda ~0.6; 0.5 é mais rígido (menos falso-positivo).
const THRESHOLD = Number(process.env.FACE_THRESHOLD || 0.5);

const includeRich = {
  store: { select: { id: true, name: true, code: true, dna: true, mall: true, city: true, state: true } },
  partner: { select: { id: true, couponCode: true, discountPct: true, commissionPct: true, tier: true, status: true, type: true, totalSales: true, totalCommission: true } },
};
function loginPayload(user) {
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  return { token, user: { id: user.id, name: user.name, phone: user.phone, storeId: user.storeId, store: user.store || null, balance: user.balance, partnerBalance: user.partnerBalance || 0, role: user.role, profileComplete: user.profileComplete, createdAt: user.createdAt, partner: user.partner || null } };
}
function euclid(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
const valid = (d) => Array.isArray(d) && d.length === 128 && d.every((x) => typeof x === 'number' && isFinite(x));

// status — o usuário tem rosto cadastrado? (autenticado)
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const n = await prisma.faceDescriptor.count({ where: { userId: req.userId } });
    res.json({ enrolled: n > 0, count: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CADASTRAR o rosto (autenticado: entrou com senha 1x). Recebe o descriptor do navegador.
router.post('/enroll', authMiddleware, async (req, res) => {
  try {
    const desc = req.body && req.body.descriptor;
    if (!valid(desc)) return res.status(400).json({ error: 'Leitura do rosto inválida — tente de novo.' });
    await prisma.faceDescriptor.create({ data: { userId: req.userId, descriptor: desc.map(Number), label: String((req.body && req.body.label) || '').slice(0, 60) || null } });
    res.json({ ok: true });
  } catch (e) { console.error('[face] enroll', e); res.status(500).json({ error: e.message }); }
});

// ENTRAR pelo rosto (público). Compara o descriptor recebido com todos os cadastrados.
router.post('/login', async (req, res) => {
  try {
    const desc = req.body && req.body.descriptor;
    if (!valid(desc)) return res.status(400).json({ error: 'Leitura do rosto inválida — tente de novo.' });
    const all = await prisma.faceDescriptor.findMany({ include: { user: { include: includeRich } } });
    let best = null, bestD = Infinity;
    for (const f of all) {
      if (!Array.isArray(f.descriptor) || f.descriptor.length !== 128) continue;
      const d = euclid(desc, f.descriptor);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (!best || bestD > THRESHOLD) return res.status(401).json({ error: 'Rosto não reconhecido. Use a senha.' });
    if (!best.user || best.user.active === false) return res.status(403).json({ error: 'Conta desativada.' });
    await prisma.faceDescriptor.update({ where: { id: best.id }, data: { lastUsedAt: new Date() } });
    res.json(loginPayload(best.user));
  } catch (e) { console.error('[face] login', e); res.status(500).json({ error: e.message }); }
});

router.delete('/credentials/:id', authMiddleware, async (req, res) => {
  try { await prisma.faceDescriptor.deleteMany({ where: { id: req.params.id, userId: req.userId } }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
