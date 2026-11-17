// Cartão TenisCash na Carteira do Google.
//   GET /api/google-wallet/status     → { enabled } (público; o app decide se mostra o botão)
//   GET /api/google-wallet/save-link  → { url } link "Salvar na Carteira do Google" do cliente logado
// Sem GOOGLE_WALLET_ISSUER_ID + GOOGLE_WALLET_SA_JSON: enabled=false e save-link=404.
const express = require('express');
const { authMiddleware, prisma } = require('../middleware');
const googleWallet = require('../services/googleWallet');

const router = express.Router();

router.get('/status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ enabled: googleWallet.isEnabled() });
});

router.get('/save-link', authMiddleware, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!googleWallet.isEnabled()) return res.status(404).json({ error: 'Carteira do Google não configurada.' });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, name: true, balance: true } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const link = googleWallet.buildSaveLink(user);
    if (!link) return res.status(404).json({ error: 'Carteira do Google não configurada.' });
    res.json({ url: link.url });
  } catch (e) {
    console.error('[google-wallet/save-link]', e.message);
    res.status(500).json({ error: 'Não foi possível gerar o cartão agora.' });
  }
});

module.exports = router;
