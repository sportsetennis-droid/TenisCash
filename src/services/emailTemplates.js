// =====================================================================
// Email Templates — HTML responsivo brand TenisCash
// =====================================================================
// Templates pra emails transacionais. Todos seguem brand:
//   - Cor primária #FF6A1F (laranja TenisCash)
//   - Fonte system stack (compatibilidade Gmail/Outlook/Apple Mail)
//   - Mobile-first (max-width 600px centralizado)
//   - Dark mode safe (background branco, sem inversão automática)
//
// Uso:
//   const { renderWelcome } = require('./emailTemplates');
//   const html = renderWelcome({ name: 'Douglas' });
// =====================================================================

const BRAND = {
  name: 'TenisCash',
  tagline: 'Sports & Tennis · Loyalty Esportivo',
  color: '#FF6A1F',
  colorSoft: '#FFEBDC',
  colorDark: '#E64500',
  bgApp: '#f5f5f7',
  text: '#0a0a0a',
  text2: '#6e6e73',
  border: '#e5e5ea',
  domain: 'teniscash.com.br',
  websiteUrl: 'https://teniscash.com.br',
  appUrl: 'https://teniscash.com.br/app.html',
  storeUrl: 'https://teniscash.com.br/loja.html',
  supportEmail: 'suporte@teniscash.com.br',
  privacyUrl: 'https://teniscash.com.br/politica-privacidade.html',
  social: {
    instagram: 'https://instagram.com/sportsetennis',
    whatsapp: 'https://wa.me/558396713153',
  },
};

// ====================================================
// Skeleton base — header + footer comuns
// ====================================================
function shell({ subject, preheader = '', body, ctaText, ctaUrl, footerText }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bgApp};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.text};-webkit-font-smoothing:antialiased;">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">${esc(preheader)}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bgApp};padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);">

          <!-- HEADER -->
          <tr>
            <td style="padding:0;">
              <div style="background:linear-gradient(135deg,${BRAND.colorDark} 0%,${BRAND.color} 45%,#FF9550 100%);padding:36px 32px 28px;text-align:center;">
                <div style="display:inline-block;background:rgba(255,255,255,0.18);border-radius:14px;padding:8px 14px;backdrop-filter:blur(20px);">
                  <span style="font-size:24px;font-weight:900;color:#ffffff;letter-spacing:-0.02em;line-height:1;">T$</span>
                </div>
                <div style="margin-top:14px;color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-0.02em;">${BRAND.name}</div>
                <div style="margin-top:4px;color:rgba(255,255,255,0.85);font-size:12px;font-weight:500;letter-spacing:0.5px;">${BRAND.tagline}</div>
              </div>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:36px 36px 12px;">
              ${body}
            </td>
          </tr>

          ${ctaText && ctaUrl ? `
          <!-- CTA -->
          <tr>
            <td align="center" style="padding:16px 36px 36px;">
              <a href="${esc(ctaUrl)}" style="display:inline-block;background:${BRAND.color};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:999px;letter-spacing:-0.01em;box-shadow:0 4px 12px rgba(255,106,31,0.3);">${esc(ctaText)}</a>
            </td>
          </tr>` : ''}

          <!-- FOOTER -->
          <tr>
            <td style="background:#fafafc;padding:28px 36px;border-top:1px solid ${BRAND.border};">
              ${footerText ? `<div style="font-size:13px;color:${BRAND.text2};line-height:1.5;margin-bottom:16px;">${footerText}</div>` : ''}
              <div style="font-size:12px;color:${BRAND.text2};line-height:1.6;">
                <strong>Sports & Tennis</strong> · Bessa · Tambaú · Rainha da Borborema · Tambiá · Ecommerce<br>
                João Pessoa/PB · CNPJ 44.052.617/0001-26<br>
                <a href="${BRAND.social.whatsapp}" style="color:${BRAND.color};text-decoration:none;">WhatsApp</a> ·
                <a href="${BRAND.social.instagram}" style="color:${BRAND.color};text-decoration:none;">Instagram</a> ·
                <a href="${BRAND.storeUrl}" style="color:${BRAND.color};text-decoration:none;">Loja online</a>
              </div>
              <div style="margin-top:16px;font-size:11px;color:#a8a8ad;line-height:1.5;">
                Esta mensagem foi enviada pra você porque você tem cadastro no TenisCash.
                Dúvidas? Responde esse email ou fala com a gente em <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.text2};">${BRAND.supportEmail}</a>.
                <br><a href="${BRAND.privacyUrl}" style="color:#a8a8ad;text-decoration:underline;">Política de privacidade</a>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ====================================================
// Templates
// ====================================================

/** Código de verificação (login / cadastro) */
function renderVerificationCode({ code, expiresMinutes = 10 }) {
  return shell({
    subject: `Seu código TenisCash: ${code}`,
    preheader: `Código de verificação: ${code} (expira em ${expiresMinutes} min)`,
    body: `
      <p style="font-size:16px;line-height:1.5;margin:0 0 18px;color:${BRAND.text};">Use o código abaixo pra entrar:</p>
      <div style="background:${BRAND.colorSoft};border:1.5px dashed ${BRAND.color};border-radius:16px;padding:24px;text-align:center;margin-bottom:24px;">
        <div style="font-size:36px;font-weight:900;color:${BRAND.color};letter-spacing:12px;font-variant-numeric:tabular-nums;">${esc(code)}</div>
      </div>
      <p style="font-size:13px;color:${BRAND.text2};line-height:1.5;margin:0;">
        Expira em <strong>${expiresMinutes} minutos</strong>. Se não foi você que pediu, ignora esse email.
      </p>
    `,
  });
}

/** Boas-vindas — depois do cadastro */
function renderWelcome({ name, balance = 0, appUrl = BRAND.appUrl }) {
  return shell({
    subject: `Bem-vindo ao TenisCash, ${name?.split(' ')[0] || 'atleta'}!`,
    preheader: `Você ganhou ${balance > 0 ? `R$ ${balance.toFixed(2)} de TenisCash. ` : ''}Aproveita.`,
    body: `
      <h1 style="font-size:24px;font-weight:800;letter-spacing:-0.02em;margin:0 0 16px;color:${BRAND.text};">E aí, ${esc(name?.split(' ')[0] || 'atleta')}! 👟</h1>
      <p style="font-size:16px;line-height:1.55;margin:0 0 16px;color:${BRAND.text};">
        Cadastro feito. Agora você faz parte do TenisCash — o programa de cashback das lojas Sports & Tennis.
      </p>
      ${balance > 0 ? `
      <div style="background:${BRAND.colorSoft};border-radius:14px;padding:18px 22px;margin:20px 0;">
        <div style="font-size:11px;letter-spacing:1px;font-weight:700;color:${BRAND.color};text-transform:uppercase;">Saldo inicial</div>
        <div style="font-size:28px;font-weight:900;color:${BRAND.color};letter-spacing:-0.02em;margin-top:4px;">R$ ${balance.toFixed(2)}</div>
      </div>` : ''}
      <p style="font-size:15px;line-height:1.55;margin:16px 0;color:${BRAND.text};">
        Como funciona:<br>
        • Toda compra na loja → vira <strong>TenisCash</strong> na sua conta<br>
        • Usa em qualquer próxima compra (sem expirar)<br>
        • Treina no app APEX → ganha badge → mais TenisCash
      </p>
    `,
    ctaText: 'Abrir o app',
    ctaUrl: appUrl,
  });
}

/** Cashback creditado depois de venda */
function renderCashbackEarned({ name, amount, balance, saleDescription }) {
  return shell({
    subject: `🎉 +R$ ${amount.toFixed(2)} de TenisCash`,
    preheader: `Você ganhou R$ ${amount.toFixed(2)} de cashback. Saldo: R$ ${balance.toFixed(2)}`,
    body: `
      <p style="font-size:16px;line-height:1.5;margin:0 0 20px;color:${BRAND.text};">Oi ${esc(name?.split(' ')[0] || '')}! 🎉</p>
      <div style="background:${BRAND.colorSoft};border-radius:14px;padding:20px 22px;text-align:center;margin:0 0 18px;">
        <div style="font-size:11px;letter-spacing:1px;font-weight:700;color:${BRAND.color};text-transform:uppercase;">Você ganhou</div>
        <div style="font-size:36px;font-weight:900;color:${BRAND.color};letter-spacing:-0.02em;margin:6px 0 0;">+R$ ${amount.toFixed(2)}</div>
        <div style="font-size:13px;color:${BRAND.text2};margin-top:6px;">${esc(saleDescription || 'Compra registrada')}</div>
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;">
        <tr>
          <td style="padding:14px 16px;background:#fafafc;border-radius:12px;">
            <span style="font-size:13px;color:${BRAND.text2};">Saldo total disponível</span>
            <span style="float:right;font-size:18px;font-weight:800;color:${BRAND.text};font-variant-numeric:tabular-nums;">R$ ${balance.toFixed(2)}</span>
          </td>
        </tr>
      </table>
      <p style="font-size:14px;line-height:1.55;color:${BRAND.text2};margin:18px 0 0;">
        Usa na próxima compra em qualquer loja Sports & Tennis ou no nosso e-commerce.
      </p>
    `,
    ctaText: 'Ver minha carteira',
    ctaUrl: BRAND.appUrl,
  });
}

/** Reset de senha (PIN) */
function renderPasswordReset({ name, resetUrl, expiresMinutes = 30 }) {
  return shell({
    subject: 'Redefinir seu PIN TenisCash',
    preheader: `Link válido por ${expiresMinutes} minutos.`,
    body: `
      <p style="font-size:16px;line-height:1.5;margin:0 0 16px;color:${BRAND.text};">
        Oi ${esc(name?.split(' ')[0] || '')}, pra redefinir seu PIN é só clicar no botão abaixo.
      </p>
      <p style="font-size:13px;color:${BRAND.text2};line-height:1.5;margin:16px 0 0;">
        Link válido por <strong>${expiresMinutes} minutos</strong>. Se não foi você que pediu, ignora esse email — sua conta segue protegida.
      </p>
    `,
    ctaText: 'Redefinir PIN',
    ctaUrl: resetUrl,
  });
}

/** Email genérico (avisos, novidades, marketing leve) */
function renderGeneric({ subject, preheader, heading, body, ctaText, ctaUrl }) {
  return shell({
    subject,
    preheader,
    body: `
      ${heading ? `<h1 style="font-size:22px;font-weight:800;letter-spacing:-0.02em;margin:0 0 16px;color:${BRAND.text};">${esc(heading)}</h1>` : ''}
      <div style="font-size:15px;line-height:1.6;color:${BRAND.text};">${body}</div>
    `,
    ctaText,
    ctaUrl,
  });
}

module.exports = {
  BRAND,
  renderVerificationCode,
  renderWelcome,
  renderCashbackEarned,
  renderPasswordReset,
  renderGeneric,
};
