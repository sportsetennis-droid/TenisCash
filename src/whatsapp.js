const META_WA_API_VERSION = process.env.META_WHATSAPP_API_VERSION || process.env.META_GRAPH_VERSION || 'v22.0';
// Token: prioriza dedicado de WhatsApp, depois System User token (META_USER_TOKEN), depois Page Token
const META_WA_ACCESS_TOKEN = process.env.META_WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_USER_TOKEN || process.env.META_PAGE_TOKEN;
const META_WA_PHONE_NUMBER_ID = process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.META_WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
const META_WA_CODE_TEMPLATE = process.env.META_WHATSAPP_CODE_TEMPLATE || process.env.WHATSAPP_CODE_TEMPLATE;
const META_WA_CODE_TEMPLATE_LANG = process.env.META_WHATSAPP_CODE_TEMPLATE_LANG || 'pt_BR';

// Evolution API (WhatsApp Web nao-oficial) — provedor enquanto a Cloud API esta travada no numero de teste
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'teniscash';
// 'auto' (padrao) = Evolution primeiro, Meta fallback; 'meta' = Meta primeiro (usar quando a Cloud API liberar)
const WHATSAPP_PROVIDER = (process.env.WHATSAPP_PROVIDER || 'auto').toLowerCase();

function isMetaWhatsAppConfigured() {
  return !!(META_WA_ACCESS_TOKEN && META_WA_PHONE_NUMBER_ID);
}

function isEvolutionConfigured() {
  return !!(EVOLUTION_API_URL && EVOLUTION_API_KEY);
}

function isWhatsAppConfigured() {
  return isMetaWhatsAppConfigured() || isEvolutionConfigured();
}

function whatsappProviderOrder() {
  const order = [];
  if (WHATSAPP_PROVIDER === 'meta') {
    if (isMetaWhatsAppConfigured()) order.push('meta');
    if (isEvolutionConfigured()) order.push('evolution');
  } else {
    if (isEvolutionConfigured()) order.push('evolution');
    if (isMetaWhatsAppConfigured()) order.push('meta');
  }
  return order;
}

async function sendEvolutionText(phone, message, instance = EVOLUTION_INSTANCE) {
  if (!isEvolutionConfigured()) return { ok: false, error: 'Evolution nao configurado' };
  const formattedPhone = formatPhoneBR(phone);
  if (!formattedPhone) return { ok: false, error: 'Telefone invalido' };
  // Timeout curto: instancia desconectada NAO pode pendurar o envio do codigo.
  // Sem isso, o fetch fica preso e trava o cadastro/reset por dezenas de segundos.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: formattedPhone, text: String(message || '') }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = Array.isArray(data?.response?.message) ? data.response.message.join('; ') : (data?.message || `Evolution ${response.status}`);
      return { ok: false, error: msg, data };
    }
    return { ok: true, messageId: data?.key?.id, data };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Evolution timeout (instancia desconectada)' : (err.message || 'Erro de conexao Evolution');
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// Envia direto pra um numero OU JID de grupo (xxxxx@g.us), sem passar por formatPhoneBR.
// `instance` opcional: permite enviar por outra instancia Evolution (ex: Meta Fardamentos).
async function sendEvolutionRaw(numberOrJid, message, instance = EVOLUTION_INSTANCE) {
  if (!isEvolutionConfigured()) return { ok: false, error: 'Evolution nao configurado' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: String(numberOrJid), text: String(message || '') }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: (data && data.message) || `Evolution ${response.status}` };
    return { ok: true, messageId: data && data.key && data.key.id };
  } catch (err) {
    return { ok: false, error: err.message || 'Erro Evolution' };
  } finally {
    clearTimeout(timer);
  }
}

async function sendMetaWhatsAppPayload(payload) {
  if (!isMetaWhatsAppConfigured()) return { ok: false, error: 'Meta WhatsApp nao configurado' };

  const url = `https://graph.facebook.com/${META_WA_API_VERSION}/${META_WA_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${META_WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      return { ok: false, error: data.error?.message || data.message || `Meta WhatsApp ${response.status}`, data };
    }
    return { ok: true, messageId: data.messages?.[0]?.id, data };
  } catch (err) {
    return { ok: false, error: err.message || 'Erro de conexao Meta WhatsApp' };
  }
}

async function sendMetaText(phone, message) {
  const formattedPhone = formatPhoneBR(phone);
  if (!formattedPhone) return { ok: false, error: 'Telefone invalido' };
  return sendMetaWhatsAppPayload({
    to: formattedPhone,
    type: 'text',
    text: { preview_url: false, body: String(message || '') },
  });
}

async function sendMetaCode(phone, code) {
  const formattedPhone = formatPhoneBR(phone);
  if (!formattedPhone) return { ok: false, error: 'Telefone invalido' };

  if (META_WA_CODE_TEMPLATE) {
    // Template AUTHENTICATION da Meta exige o código no body E no botão copiar (sub_type url)
    return sendMetaWhatsAppPayload({
      to: formattedPhone,
      type: 'template',
      template: {
        name: META_WA_CODE_TEMPLATE,
        language: { code: META_WA_CODE_TEMPLATE_LANG },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      },
    });
  }

  return sendMetaText(
    formattedPhone,
    `TenisCash - Sports & Tennis\n\nSeu codigo de verificacao e: ${code}\n\nEsse codigo expira em 10 minutos.`
  );
}

// Armazena codigos temporarios em memoria (expira em 10 min)
const verificationCodes = new Map();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendVerificationCode(phone) {
  const code = generateCode();

  const formattedPhone = formatPhoneBR(phone);
  if (!formattedPhone) {
    return { success: false, message: 'Telefone invalido' };
  }

  verificationCodes.set(phone, {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
  });

  const providers = whatsappProviderOrder();
  if (!providers.length) {
    return { success: false, message: 'WhatsApp nao configurado' };
  }

  let lastResult = null;
  for (const provider of providers) {
    const result = provider === 'meta'
      ? await sendMetaCode(formattedPhone, code)
      : await sendEvolutionText(
          formattedPhone,
          `TenisCash - Sports & Tennis\n\nSeu codigo de verificacao e: ${code}\n\nEsse codigo expira em 10 minutos.`
        );
    if (result.ok) {
      return { success: true, message: 'Codigo enviado por WhatsApp', provider, messageId: result.messageId };
    }
    lastResult = result;
    console.error(`WhatsApp ${provider} falhou:`, result.error);
  }
  return { success: false, message: lastResult?.error || 'Erro ao enviar WhatsApp' };
}

// Telefones verificados temporariamente (expira em 15 min)
const verifiedPhones = new Map();

function verifyCode(phone, code) {
  const stored = verificationCodes.get(phone);

  if (!stored) {
    if (verifiedPhones.has(phone)) {
      return { valid: true };
    }
    return { valid: false, message: 'Codigo nao encontrado. Solicite um novo.' };
  }

  if (Date.now() > stored.expiresAt) {
    verificationCodes.delete(phone);
    return { valid: false, message: 'Codigo expirado. Solicite um novo.' };
  }

  stored.attempts++;
  if (stored.attempts > 5) {
    verificationCodes.delete(phone);
    return { valid: false, message: 'Muitas tentativas. Solicite um novo codigo.' };
  }

  if (stored.code !== code) {
    return { valid: false, message: 'Codigo incorreto. Tente novamente.' };
  }

  verificationCodes.delete(phone);
  verifiedPhones.set(phone, { expiresAt: Date.now() + 15 * 60 * 1000 });
  return { valid: true };
}

function isPhoneVerified(phone) {
  const data = verifiedPhones.get(phone);
  if (!data) return false;
  if (Date.now() > data.expiresAt) {
    verifiedPhones.delete(phone);
    return false;
  }
  return true;
}

function clearVerified(phone) {
  verifiedPhones.delete(phone);
}

// Limpa codigos expirados a cada 5 minutos.
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of verificationCodes.entries()) {
    if (now > data.expiresAt) {
      verificationCodes.delete(phone);
    }
  }
}, 5 * 60 * 1000);

// =====================================================================
// CAMPANHA - envio em lote via Meta WhatsApp Cloud API com throttling e log
// =====================================================================

function formatPhoneBR(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (!p) return null;
  if (!p.startsWith('55')) p = '55' + p;
  if (p.length < 12 || p.length > 13) return null;
  return p;
}

async function sendCustomMessage(phone, message) {
  const providers = whatsappProviderOrder();
  if (!providers.length) {
    return { ok: false, provider: null, error: 'WhatsApp nao configurado' };
  }

  const formattedPhone = formatPhoneBR(phone);
  if (!formattedPhone) return { ok: false, provider: null, error: 'Telefone invalido' };
  if (!message || !String(message).trim()) return { ok: false, provider: null, error: 'Mensagem vazia' };

  let lastResult = null;
  for (const provider of providers) {
    const out = provider === 'meta'
      ? await sendMetaText(formattedPhone, message)
      : await sendEvolutionText(formattedPhone, message);
    if (out.ok) return { ok: true, provider, messageId: out.messageId };
    lastResult = out;
  }
  return { ok: false, provider: providers[providers.length - 1], error: lastResult?.error || 'Falha no envio WhatsApp' };
}

/**
 * sendCampaignBatch - envia para uma lista de telefones com throttling.
 * Retorna sumario { total, sent, failed, errors[] }.
 *
 * @param {Object} opts
 * @param {string[]} opts.phones - lista de telefones (qualquer formato BR)
 * @param {string} opts.message - texto unico OU template com placeholders {{name}}
 * @param {Array} [opts.recipients] - alternativa: [{phone, name}] para personalizar {{name}}
 * @param {number} [opts.delayMs=1500] - delay entre envios
 */
async function sendCampaignBatch({ phones, message, recipients, delayMs = 1500 } = {}) {
  const list = Array.isArray(recipients) && recipients.length
    ? recipients
    : (phones || []).map((p) => ({ phone: p, name: '' }));
  const result = { total: list.length, sent: 0, failed: 0, errors: [] };
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const personalized = String(message || '').replace(/\{\{name\}\}/gi, r.name || '');
    const out = await sendCustomMessage(r.phone, personalized);
    if (out.ok) {
      result.sent += 1;
    } else {
      result.failed += 1;
      result.errors.push({ phone: r.phone, error: out.error });
    }
    if (i < list.length - 1) await new Promise((res) => setTimeout(res, delayMs));
  }
  return result;
}

module.exports = {
  sendVerificationCode,
  verifyCode,
  isPhoneVerified,
  clearVerified,
  sendCustomMessage,
  sendCampaignBatch,
  formatPhoneBR,
  isMetaWhatsAppConfigured,
  isEvolutionConfigured,
  isWhatsAppConfigured,
  sendMetaText,
  sendEvolutionText,
  sendEvolutionRaw,
};
