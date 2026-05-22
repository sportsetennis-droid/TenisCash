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

router.post('/webhook', async (req, res) => {
  // Responde rápido (Meta exige < 3s, senão desabilita webhook)
  res.json({ received: true });

  try {
    const body = req.body || {};
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        for (const msg of messages) {
          const from = msg.from;
          const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name || 'cliente';
          const text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || '(mídia/outro tipo)';
          console.log(`[whatsapp/webhook] mensagem recebida | from=${from} (${profileName}) | type=${msg.type} | text="${text.slice(0, 120)}"`);

          // Auto-resposta inicial
          try {
            const reply = `Olá ${profileName}! 👋\n\nRecebemos sua mensagem na Sports & Tennis. Em instantes um atendente vai te responder.\n\nEnquanto isso, dá uma olhada na nossa loja: https://www.sportsetennis.com.br`;
            const r = await sendCustomMessage(from, reply);
            console.log(`[whatsapp/webhook] auto-reply para ${from}: ${r.ok ? 'OK msgId=' + r.messageId : 'FAIL ' + r.error}`);
          } catch (err) {
            console.error(`[whatsapp/webhook] erro auto-reply ${from}:`, err.message);
          }
        }

        // Statuses (sent/delivered/read/failed)
        for (const st of (value.statuses || [])) {
          console.log(`[whatsapp/webhook] status | id=${st.id} | status=${st.status} | recipient=${st.recipient_id}`);
        }
      }
    }
  } catch (err) {
    console.error('[whatsapp/webhook] erro processando entry:', err);
  }
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
