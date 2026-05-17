const express = require('express');
const crypto = require('crypto');
const { sendCustomMessage, isMetaWhatsAppConfigured, formatPhoneBR } = require('../whatsapp');
const { authMiddleware, adminMiddleware } = require('../middleware');

const router = express.Router();
const DEFAULT_VERIFY_TOKEN = 'teniscash-whatsapp-webhook-2026';

function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!rawBody || !signatureHeader || !appSecret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.META_WHATSAPP_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN || DEFAULT_VERIFY_TOKEN;

  if (mode === 'subscribe' && token && challenge && expectedToken && token === expectedToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

router.post('/webhook', (req, res) => {
  const appSecret = process.env.META_WHATSAPP_APP_SECRET || process.env.WHATSAPP_APP_SECRET;
  const signature = req.get('x-hub-signature-256');
  const signatureValid = appSecret ? verifySignature(req.rawBody, signature, appSecret) : false;

  console.log('[whatsapp/webhook]', {
    signatureValid,
    object: req.body?.object,
    entries: Array.isArray(req.body?.entry) ? req.body.entry.length : 0,
  });

  return res.json({ received: true });
});

router.get('/status', authMiddleware, adminMiddleware, (_req, res) => {
  const metaConfigured = isMetaWhatsAppConfigured();

  res.json({
    provider: 'meta',
    ready: metaConfigured,
    metaConfigured,
    phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.META_WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    businessId: process.env.META_WHATSAPP_BUSINESS_ID || process.env.WHATSAPP_BUSINESS_ID || null,
    webhookUrl: '/api/whatsapp/webhook',
  });
});

router.post('/send-test', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const phone = formatPhoneBR(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'Telefone invalido' });

    const message = req.body?.message || 'Teste TenisCash via WhatsApp.';
    const result = await sendCustomMessage(phone, message);
    if (!result.ok) return res.status(400).json({ error: result.error || 'Falha no envio' });
    return res.json({ success: true, result });
  } catch (err) {
    console.error('[whatsapp/send-test]', err);
    return res.status(500).json({ error: 'Erro ao enviar teste' });
  }
});

module.exports = router;
