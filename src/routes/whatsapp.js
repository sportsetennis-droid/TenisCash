const express = require('express');
const crypto = require('crypto');
const { sendCustomMessage, isMetaWhatsAppConfigured, isEvolutionConfigured, formatPhoneBR } = require('../whatsapp');
const { authMiddleware, adminMiddleware } = require('../middleware');
const { getAttendantReply, isEnabled: attendantEnabled } = require('../services/aiAttendant');

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

// =====================================================================
// WEBHOOK DA EVOLUTION API — mensagens recebidas no numero da loja (9671)
// caem aqui e sao respondidas pelo atendente de IA (automatico).
// Interruptor: env AI_ATTENDANT_ENABLED='false' desliga a IA.
// =====================================================================
router.post('/evolution', async (req, res) => {
  res.json({ received: true }); // responde rapido (Evolution nao espera)

  try {
    const body = req.body || {};
    const event = body.event || body.type || '';
    // Evolution manda varios eventos; so queremos mensagens novas
    if (event && !/messages\.upsert/i.test(event)) return;

    const data = Array.isArray(body.data) ? body.data[0] : (body.data || {});
    const key = data.key || {};

    // Ignora: mensagens que NOS enviamos, grupos e status
    if (key.fromMe) return;
    const jid = key.remoteJid || '';
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

    const phone = jid.replace(/[^0-9]/g, '');
    if (!phone) return;
    const pushName = data.pushName || 'cliente';

    const m = data.message || {};
    const text = (m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim();

    // Mensagem nao-texto (audio/foto/figurinha): pede texto
    if (!text) {
      if (attendantEnabled()) {
        await sendCustomMessage(phone, 'Oi! No momento consigo te atender por *texto*. Pode escrever o que voce procura? 🙂').catch(() => {});
      }
      return;
    }

    if (!attendantEnabled()) {
      console.log(`[whatsapp/evolution] IA desligada — ignorando msg de ${phone}`);
      return;
    }

    console.log(`[whatsapp/evolution] msg de ${phone} (${pushName}): "${text.slice(0, 120)}"`);
    const result = await getAttendantReply({ phone, text, pushName });
    if (result.ok && result.reply) {
      const r = await sendCustomMessage(phone, result.reply);
      console.log(`[whatsapp/evolution] resposta IA -> ${phone}: ${r.ok ? 'OK' : 'FAIL ' + r.error}`);
    } else if (!result.skip) {
      console.warn(`[whatsapp/evolution] sem resposta p/ ${phone}:`, result.error || 'desconhecido');
    }
  } catch (err) {
    console.error('[whatsapp/evolution] erro:', err.message);
  }
});

router.get('/status', authMiddleware, adminMiddleware, (_req, res) => {
  const metaConfigured = isMetaWhatsAppConfigured();
  const evolutionConfigured = isEvolutionConfigured();

  res.json({
    provider: evolutionConfigured ? 'evolution' : 'meta',
    ready: metaConfigured || evolutionConfigured,
    metaConfigured,
    evolutionConfigured,
    evolutionInstance: process.env.EVOLUTION_INSTANCE || 'teniscash',
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

// =====================================================================
// EMBEDDED SIGNUP COEXISTENCE
// Fluxo: usuario clica botao no admin -> FB.login abre popup Meta ->
// usuario passa pelo wizard escolhendo "Use WhatsApp Business app" ->
// Meta retorna `code` (curto, ~5s) -> trocamos por System User Token (~60d+) ->
// salvamos em env vars / DB e atualizamos subscribed_apps.
// =====================================================================

router.get('/embedded-signup-config', authMiddleware, adminMiddleware, (_req, res) => {
  const appId = process.env.META_APP_ID || '2450210998825590';
  const configId = process.env.META_LOGIN_CONFIG_ID || '961531953387744';
  const graphVersion = process.env.META_WHATSAPP_API_VERSION || 'v22.0';
  res.json({
    appId,
    configId,
    graphVersion,
    callbackPath: '/api/whatsapp/embedded-signup-callback',
    ready: !!(process.env.META_APP_SECRET),
  });
});

router.post('/embedded-signup-callback', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code, phone_number_id, waba_id, business_id } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code ausente' });

    const appId = process.env.META_APP_ID || '2450210998825590';
    const appSecret = process.env.META_APP_SECRET;
    const graphVersion = process.env.META_WHATSAPP_API_VERSION || 'v22.0';
    if (!appSecret) {
      return res.status(500).json({ error: 'META_APP_SECRET nao configurado no servidor (admin precisa setar no Railway)' });
    }

    // 1. Troca code por access_token (System User Token)
    const tokenUrl = `https://graph.facebook.com/${graphVersion}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`;
    const tokenResp = await fetch(tokenUrl);
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || tokenData.error || !tokenData.access_token) {
      return res.status(400).json({
        error: 'Falha ao trocar code por token',
        details: tokenData.error?.message || JSON.stringify(tokenData),
      });
    }

    const accessToken = tokenData.access_token;
    console.log(`[whatsapp/embedded-signup] token obtido | waba=${waba_id} | phone=${phone_number_id} | business=${business_id}`);

    // 2. Subscribe webhook field `messages` na WABA com este token (idempotente)
    let subscribed = false;
    if (waba_id) {
      try {
        const subUrl = `https://graph.facebook.com/${graphVersion}/${waba_id}/subscribed_apps`;
        const subResp = await fetch(subUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const subData = await subResp.json();
        subscribed = !!subData.success;
        console.log(`[whatsapp/embedded-signup] subscribe WABA ${waba_id}: ${JSON.stringify(subData)}`);
      } catch (err) {
        console.error('[whatsapp/embedded-signup] erro subscribe:', err.message);
      }
    }

    // 3. Configura webhook URL no phone_number (importante pra Coexistence)
    let webhookSet = false;
    if (phone_number_id) {
      try {
        const cbUrl = process.env.META_WHATSAPP_WEBHOOK_URL || 'https://teniscash.com.br/api/whatsapp/webhook';
        const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN || DEFAULT_VERIFY_TOKEN;
        const phoneUrl = `https://graph.facebook.com/${graphVersion}/${phone_number_id}`;
        const phoneResp = await fetch(phoneUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            webhook_configuration: { override_callback_uri: cbUrl, verify_token: verifyToken },
          }),
        });
        const phoneData = await phoneResp.json();
        webhookSet = !!phoneData.success;
        console.log(`[whatsapp/embedded-signup] phone webhook set: ${JSON.stringify(phoneData)}`);
      } catch (err) {
        console.error('[whatsapp/embedded-signup] erro webhook config:', err.message);
      }
    }

    // 4. Retorna pro frontend (mascara token mas registra em log)
    return res.json({
      success: true,
      tokenObtained: true,
      tokenLength: accessToken.length,
      tokenPreview: accessToken.substring(0, 12) + '...',
      wabaId: waba_id,
      phoneNumberId: phone_number_id,
      businessId: business_id,
      subscribed,
      webhookSet,
      nextStep: 'Token gerado. Copie do log do Railway e atualize META_USER_TOKEN/META_WHATSAPP_ACCESS_TOKEN nas env vars.',
      // Em prod, idealmente persistimos em DB encrypted. Por ora logamos pro admin copiar.
      tokenFull: accessToken,
    });
  } catch (err) {
    console.error('[whatsapp/embedded-signup-callback]', err);
    return res.status(500).json({ error: err.message || 'Erro no callback' });
  }
});

module.exports = router;
