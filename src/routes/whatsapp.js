const express = require('express');
const crypto = require('crypto');
const { sendCustomMessage, sendEvolutionRaw, isMetaWhatsAppConfigured, isEvolutionConfigured, formatPhoneBR, getMetaWhatsAppConfigSummary, setMetaWhatsAppCredentials } = require('../whatsapp');
const { authMiddleware, adminMiddleware } = require('../middleware');
const { saveMetaWhatsAppCredentials } = require('../services/whatsappCredentials');
const { getAttendantReply, isEnabled: attendantEnabled } = require('../services/aiAttendant');
const { handleMetaWebhook, INSTANCE: METAFARD_INSTANCE } = require('../services/metaFardamentosAttendant');
const { handleBarataoWebhook, INSTANCE: BARATAO_INSTANCE } = require('../services/barataoAttendant');
const { handleMetaApsWebhook, INSTANCE: METAAPS_INSTANCE } = require('../services/metaApsAttendant');
const { captureEvolutionMessages } = require('../services/whatsappInbox');
const { STORE_ARCHIVE } = require('../services/whatsappStoreArchive');
const waFunctions = require('../services/whatsappFunctions');

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
    const instance = (body.instance || body.instanceName || '').toString();
    const _d0 = Array.isArray(body.data) ? body.data[0] : (body.data || {});
    console.log(`[whatsapp/evolution] HIT instance="${instance}" event="${event}" jid="${(_d0 && _d0.key && _d0.key.remoteJid) || '?'}"`);
    // Loja 05 archives both new messages and history received during pairing.
    // It must return before every attendant: connecting it authorizes no replies.
    const isStoreArchive = instance === STORE_ARCHIVE.key;
    if (event && !/messages[._]upsert/i.test(event) &&
        !(isStoreArchive && /messages[._]set/i.test(event))) return;
    if (isStoreArchive) {
      const archiveData = Array.isArray(body.data?.messages) ? body.data.messages : body.data;
      await captureEvolutionMessages({ ...body, data: archiveData });
      return;
    }

    // MONITOR: grava toda mensagem (todas as instancias) pro dono acompanhar no admin.
    // Fire-and-forget + try/catch interno: NUNCA atrapalha o atendente de IA.
    captureEvolutionMessages(body).catch(() => {});

    // META FARDAMENTOS: instancia propria -> atendente proprio, isolado da S&T.
    if (instance && instance === METAFARD_INSTANCE) {
      await handleMetaWebhook(body);
      return;
    }

    // BARATAO DOS ESPORTES: instancia propria -> atendente proprio (perfil baratao,
    // mesmo catalogo da S&T filtrado pra loja Baratao / LOJA01).
    if (instance && instance === BARATAO_INSTANCE) {
      await handleBarataoWebhook(body);
      return;
    }

    // META APS (saude publica / APS): instancia propria -> atendente proprio,
    // assistente de saude que acolhe o cidadao e encaminha pra equipe da UBS.
    if (instance && instance === METAAPS_INSTANCE) {
      await handleMetaApsWebhook(body);
      return;
    }

    const data = Array.isArray(body.data) ? body.data[0] : (body.data || {});
    const key = data.key || {};

    if (key.fromMe) return; // nao responde as proprias mensagens
    const jid = key.remoteJid || '';
    if (!jid || jid === 'status@broadcast') return;

    const VENDEDORES_GROUP = process.env.EVOLUTION_GRUPO_VENDEDORES || '120363418791122078@g.us';
    const isGroup = jid.endsWith('@g.us');
    // Atende SO o grupo de vendedores; qualquer outro grupo e ignorado
    if (isGroup && jid !== VENDEDORES_GROUP) return;

    // Em grupo quem mandou vem em key.participant; no privado e o proprio remoteJid
    const senderJid = isGroup ? (key.participant || '') : jid;
    const phone = (senderJid || jid).replace(/[^0-9]/g, '');
    if (!phone) return;
    const pushName = data.pushName || (isGroup ? 'colega' : 'cliente');

    const m = data.message || {};
    const text = (m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim();

    if (!text) {
      // Em grupo, ignora midia em silencio (nao poluir). No privado, pede texto.
      if (!isGroup && attendantEnabled()) {
        await sendCustomMessage(phone, 'Oi! No momento consigo te atender por *texto*. Pode escrever o que voce procura? 🙂').catch(() => {});
      }
      return;
    }

    // FUNÇÕES PELO WHATSAPP (2ª via do cupom, menu...): o cliente pede, o sistema
    // roda e entrega aqui mesmo. Vem antes da IA e funciona mesmo com a IA desligada.
    if (!isGroup && await waFunctions.tryHandle({ phone, text, pushName })) return;

    // No grupo, o robô SÓ responde quando for MARCADO (@). Senão fica em silêncio (só escuta).
    // (dono 2026-06-19: a IA respondia conversa interna; agora só fala se chamarem ela com @)
    if (isGroup) {
      const ctx = (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || {};
      const mentioned = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [];
      const BOT_NUM = String(process.env.EVOLUTION_BOT_NUMBER || '558396713153').replace(/\D/g, '');
      const marcado = mentioned.some((j) => String(j).replace(/\D/g, '').includes(BOT_NUM)) || text.includes('@' + BOT_NUM);
      if (!marcado) {
        console.log('[whatsapp/evolution] grupo: nao fui marcado -> so escuta');
        return;
      }
    }

    if (!attendantEnabled()) {
      console.log(`[whatsapp/evolution] IA desligada — ignorando msg de ${phone}`);
      return;
    }

    // Pre-filtro barato no grupo: nao gasta IA em mensagem trivial (risada, ok, emoji solto)
    if (isGroup) {
      const limpo = text.toLowerCase().replace(/[^a-z0-9]/gi, '');
      const trivial = limpo.length < 4 || /^(ok|sim|nao|blz|vlw|valeu|obg|kk+|rs+|haha+|aff|opa|eai|salve|bomdia|boatarde|boanoite)$/.test(limpo);
      if (trivial && !text.includes('?')) return;
    }

    console.log(`[whatsapp/evolution] ${isGroup ? 'GRUPO' : 'priv'} ${phone} (${pushName}): "${text.slice(0, 120)}"`);
    const result = await getAttendantReply({
      phone,
      text,
      pushName,
      isGroup,
      senderName: pushName,
      sessionKey: isGroup ? jid + ':' + phone : phone,
    });

    if (result.silent) {
      console.log('[whatsapp/evolution] IA em silencio (grupo, nao direcionado a ela)');
      return;
    }
    if (result.ok && result.reply) {
      const r = isGroup ? await sendEvolutionRaw(jid, result.reply) : await sendCustomMessage(phone, result.reply);
      console.log(`[whatsapp/evolution] resposta IA -> ${isGroup ? jid : phone}: ${r.ok ? 'OK' : 'FAIL ' + r.error}`);
    } else if (!result.skip) {
      console.warn(`[whatsapp/evolution] sem resposta p/ ${phone}:`, result.error || 'desconhecido');
    }
  } catch (err) {
    console.error('[whatsapp/evolution] erro:', err.message);
  }
});

router.get('/status', authMiddleware, adminMiddleware, async (_req, res) => {
  const metaConnection = await getMetaWhatsAppConfigSummary();
  const metaConfigured = metaConnection.configured || isMetaWhatsAppConfigured();
  const evolutionConfigured = isEvolutionConfigured();
  const providerSetting = (process.env.WHATSAPP_PROVIDER || 'auto').toLowerCase();
  const provider = providerSetting === 'evolution' && evolutionConfigured
    ? 'evolution'
    : providerSetting === 'meta' && metaConfigured
      ? 'meta'
      : providerSetting === 'auto' && metaConnection.source === 'embedded-signup' && metaConfigured
        ? 'meta'
        : evolutionConfigured
          ? 'evolution'
          : 'meta';

  res.json({
    provider,
    ready: metaConfigured || evolutionConfigured,
    metaConfigured,
    evolutionConfigured,
    metaConnectionSource: metaConnection.source,
    evolutionInstance: process.env.EVOLUTION_INSTANCE || 'teniscash',
    phoneNumberId: metaConnection.phoneNumberId || process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.META_WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    businessId: metaConnection.businessId || process.env.META_WHATSAPP_BUSINESS_ID || process.env.WHATSAPP_BUSINESS_ID || null,
    displayPhoneNumber: metaConnection.displayPhoneNumber || null,
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
// O SDK da Meta devolve o código OAuth e os IDs da conta/telefone em sinais separados.
// O callback valida o número esperado, troca o código, inscreve o webhook e guarda
// as credenciais cifradas no banco. A versão do fluxo vem da configuração Meta.
// =====================================================================

router.get('/embedded-signup-config', authMiddleware, adminMiddleware, (_req, res) => {
  const appId = process.env.META_APP_ID || '2450210998825590';
  const configId = process.env.META_LOGIN_CONFIG_ID || null;
  const graphVersion = process.env.META_WHATSAPP_API_VERSION || 'v22.0';
  const appSecretReady = !!process.env.META_APP_SECRET;
  res.json({
    appId,
    configId,
    graphVersion,
    callbackPath: '/api/whatsapp/embedded-signup-callback',
    appSecretReady,
    configReady: !!configId,
    ready: !!(appSecretReady && configId),
  });
});

router.post('/embedded-signup-callback', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code, phone_number_id, waba_id, business_id } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code ausente' });
    let phoneNumberId = String(phone_number_id || '').trim();
    const wabaId = String(waba_id || '').trim();
    const businessId = String(business_id || '').trim();
    if ((phoneNumberId && !/^\d{5,30}$/.test(phoneNumberId)) || !/^\d{5,30}$/.test(wabaId) || (businessId && !/^\d{5,30}$/.test(businessId))) {
      return res.status(400).json({ error: 'A Meta não retornou os IDs da conta e do telefone. Nenhuma conexão foi salva.' });
    }

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

    // A conclusão de coexistência pode retornar apenas waba_id. Resolve o telefone
    // pela conta autorizada e pelo número esperado, sem escolher o primeiro ativo.
    const expectedPhone = String(process.env.META_WHATSAPP_EXPECTED_PHONE || '558396713153').replace(/\D/g, '');
    const numbersResp = await fetch(`https://graph.facebook.com/${graphVersion}/${wabaId}/phone_numbers?fields=id,display_phone_number&limit=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const numbersData = await numbersResp.json().catch(() => ({}));
    const matches = Array.isArray(numbersData.data) ? numbersData.data.filter((phone) =>
      String(phone.display_phone_number || '').replace(/\D/g, '') === expectedPhone &&
      (!phoneNumberId || String(phone.id) === phoneNumberId)
    ) : [];
    if (!numbersResp.ok || numbersData.error || matches.length !== 1 || !/^\d{5,30}$/.test(String(matches[0]?.id || ''))) {
      return res.status(409).json({ error: 'A conta autorizada não confirmou um único telefone da Sports & Tennis esperado. Nenhuma conexão foi salva.' });
    }
    phoneNumberId = String(matches[0].id);

    // Confirma que o token trocado realmente acessa o telefone escolhido no Embedded Signup.
    const phoneResp = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}?fields=id,display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const phoneData = await phoneResp.json().catch(() => ({}));
    if (!phoneResp.ok || phoneData.error || String(phoneData.id || '') !== phoneNumberId) {
      return res.status(400).json({
        error: 'A Meta não confirmou acesso ao telefone selecionado. Nenhuma conexão foi salva.',
        details: phoneData.error?.message || 'Telefone não acessível pelo token recebido.',
      });
    }
    const selectedPhone = String(phoneData.display_phone_number || '').replace(/\D/g, '');
    if (expectedPhone && selectedPhone !== expectedPhone) {
      return res.status(409).json({
        error: 'O número selecionado na Meta não é o WhatsApp da Sports & Tennis esperado. Nenhuma conexão foi salva.',
      });
    }

    // 2. Subscribe webhook field `messages` na WABA com este token (idempotente)
    let subscribed = false;
    try {
      const subUrl = `https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`;
      const subResp = await fetch(subUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const subData = await subResp.json().catch(() => ({}));
      subscribed = !!subData.success;
    } catch (err) {
      console.error('[whatsapp/embedded-signup] falha ao inscrever webhook:', err.message);
    }
    if (!subscribed) {
      return res.status(502).json({ error: 'A Meta não concluiu a inscrição do webhook para a conta. Nenhuma conexão foi salva.' });
    }

    // 3. Configura webhook URL no phone_number (importante pra Coexistence)
    let webhookSet = false;
    if (phoneNumberId) {
      try {
        const cbUrl = process.env.META_WHATSAPP_WEBHOOK_URL || 'https://teniscash.com.br/api/whatsapp/webhook';
        const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN || DEFAULT_VERIFY_TOKEN;
        const webhookResp = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            webhook_configuration: { override_callback_uri: cbUrl, verify_token: verifyToken },
          }),
        });
        const webhookData = await webhookResp.json().catch(() => ({}));
        webhookSet = !!webhookData.success;
      } catch (err) {
        console.error('[whatsapp/embedded-signup] erro webhook config:', err.message);
      }
    }

    const credentials = {
      accessToken,
      phoneNumberId,
      wabaId,
      businessId: businessId || null,
      displayPhoneNumber: phoneData.display_phone_number || null,
      verifiedName: phoneData.verified_name || null,
      connectedAt: new Date().toISOString(),
    };
    await saveMetaWhatsAppCredentials(credentials);
    setMetaWhatsAppCredentials(credentials);
    console.log(`[whatsapp/embedded-signup] conexão salva | waba=${wabaId} | phone=${phoneNumberId} | webhook=${webhookSet}`);

    // 4. Nunca devolve o token Meta ao navegador; ele fica cifrado no banco.
    return res.json({
      success: true,
      connected: true,
      tokenStored: true,
      wabaId,
      phoneNumberId,
      businessId: businessId || null,
      displayPhoneNumber: credentials.displayPhoneNumber,
      subscribed,
      webhookSet,
      warning: webhookSet ? null : 'O telefone foi conectado, mas a configuração específica do webhook não foi confirmada.',
    });
  } catch (err) {
    console.error('[whatsapp/embedded-signup-callback]', err.message || 'falha');
    return res.status(500).json({ error: 'Falha ao finalizar a conexão com o WhatsApp. Nenhum token foi mostrado no navegador.' });
  }
});

module.exports = router;
