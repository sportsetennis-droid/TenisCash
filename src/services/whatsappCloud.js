// =====================================================================
// WhatsApp Cloud API OFICIAL (Meta). Zero risco de ban, sem PC, sem QR.
// ---------------------------------------------------------------------
// Liga sozinho quando as variáveis estão no ambiente (Railway):
//   WHATSAPP_TOKEN            token de acesso (temporário 24h p/ teste; permanente p/ produção)
//   WHATSAPP_PHONE_NUMBER_ID  "ID do número de telefone" da tela de API do WhatsApp
//   WHATSAPP_API_VERSION      (opcional) default v21.0
//   WHATSAPP_TEMPLATE         (opcional) nome do modelo aprovado; default "hello_world"
//   WHATSAPP_TEMPLATE_LANG    (opcional) idioma do modelo; default en_US (hello_world) / pt_BR
// Mensagem PROATIVA no WhatsApp exige TEMPLATE aprovado pela Meta (regra deles).
// =====================================================================

function ver() { return process.env.WHATSAPP_API_VERSION || 'v21.0'; }
function enabled() { return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID); }

// Normaliza pra E.164 sem "+". Número BR sem DDI ganha 55.
function digits(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (!d) return '';
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) d = '55' + d;
  return d;
}

async function sendTemplate(toPhone, templateName, lang, bodyParams) {
  if (!enabled()) return { ok: false, error: 'whatsapp cloud desligado (faltam WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID)' };
  const to = digits(toPhone);
  if (!to) return { ok: false, error: 'telefone inválido' };
  const payload = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: templateName, language: { code: lang } },
  };
  if (bodyParams && bodyParams.length) {
    payload.template.components = [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t).slice(0, 1000) })) }];
  }
  try {
    const r = await fetch(`https://graph.facebook.com/${ver()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status), raw: j };
    const id = j && j.messages && j.messages[0] && j.messages[0].id;
    return { ok: true, id };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Dispara um aviso: usa o template configurado. hello_world não tem variável;
// um template próprio (ex: aviso_geral) recebe o texto como parâmetro {{1}}.
async function sendNotification(toPhone, text) {
  const tpl = process.env.WHATSAPP_TEMPLATE || 'hello_world';
  const lang = process.env.WHATSAPP_TEMPLATE_LANG || (tpl === 'hello_world' ? 'en_US' : 'pt_BR');
  const params = tpl === 'hello_world' ? [] : [String(text || '').slice(0, 1000)];
  return sendTemplate(toPhone, tpl, lang, params);
}

module.exports = { enabled, digits, sendTemplate, sendNotification };
