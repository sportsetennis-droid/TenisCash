// =====================================================================
// Emailer — wrapper Resend com templates brand TenisCash
// =====================================================================
// Endereços padrão:
//   noreply@teniscash.com.br  → transacionais (login, cashback, reset)
//   contato@teniscash.com.br  → respostas humanas
//   suporte@teniscash.com.br  → tickets de cliente
//   marketing@teniscash.com.br → newsletter, broadcasts
//
// Setup necessário em produção:
//   1. Domínio teniscash.com.br verificado no Resend (DNS: SPF+DKIM+DMARC)
//   2. Env: RESEND_API_KEY
//   3. (Opcional) Reply-to específico por tipo de email
// =====================================================================

const { Resend } = require('resend');
const tpl = require('./emailTemplates');

let _resend = null;
function getResend() {
  if (_resend) return _resend;
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY não configurada');
  _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

const FROM = {
  default:   `TenisCash <noreply@${tpl.BRAND.domain}>`,
  contato:   `TenisCash <contato@${tpl.BRAND.domain}>`,
  suporte:   `Suporte TenisCash <suporte@${tpl.BRAND.domain}>`,
  marketing: `Sports & Tennis <marketing@${tpl.BRAND.domain}>`,
};

/**
 * Envia email genérico.
 * @param {object} opts { to, subject, html, from?, replyTo?, attachments? }
 */
async function sendEmail({ to, subject, html, from = FROM.default, replyTo, attachments }) {
  if (!to || !subject || !html) throw new Error('to, subject e html obrigatórios');
  try {
    const resend = getResend();
    const payload = { from, to: Array.isArray(to) ? to : [to], subject, html };
    if (replyTo) payload.reply_to = replyTo;
    if (attachments) payload.attachments = attachments;

    const result = await resend.emails.send(payload);
    console.log(`[email] enviado pra ${to} | subject="${subject}" | id=${result.data?.id}`);
    return { success: true, id: result.data?.id };
  } catch (err) {
    console.error('[email] erro:', err.message);
    return { success: false, error: err.message };
  }
}

// ====================================================
// Atalhos por tipo de email (já com template aplicado)
// ====================================================

async function sendVerificationCode(to, code, expiresMinutes = 10) {
  return sendEmail({
    to,
    subject: `Seu código TenisCash: ${code}`,
    html: tpl.renderVerificationCode({ code, expiresMinutes }),
  });
}

async function sendWelcome(to, { name, balance }) {
  return sendEmail({
    to,
    from: FROM.contato,
    subject: `Bem-vindo ao TenisCash, ${name?.split(' ')[0] || 'atleta'}!`,
    html: tpl.renderWelcome({ name, balance }),
  });
}

async function sendCashbackEarned(to, { name, amount, balance, saleDescription }) {
  return sendEmail({
    to,
    subject: `🎉 +R$ ${amount.toFixed(2)} de TenisCash`,
    html: tpl.renderCashbackEarned({ name, amount, balance, saleDescription }),
  });
}

async function sendPasswordReset(to, { name, resetUrl, expiresMinutes }) {
  return sendEmail({
    to,
    subject: 'Redefinir seu PIN TenisCash',
    html: tpl.renderPasswordReset({ name, resetUrl, expiresMinutes }),
  });
}

async function sendGeneric(to, opts) {
  return sendEmail({
    to,
    from: opts.fromType ? FROM[opts.fromType] : FROM.default,
    subject: opts.subject,
    html: tpl.renderGeneric(opts),
    replyTo: opts.replyTo,
  });
}

module.exports = {
  FROM,
  sendEmail,
  sendVerificationCode,
  sendWelcome,
  sendCashbackEarned,
  sendPasswordReset,
  sendGeneric,
  templates: tpl,
};
