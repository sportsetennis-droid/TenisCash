const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// Armazena códigos de email temporários
const emailCodes = new Map();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  }
});

async function sendEmailCode(email) {
  const code = generateCode();

  emailCodes.set(email, {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
  });

  try {
    await transporter.sendMail({
      from: `"TenisCash - Sports & Tennis" <${GMAIL_USER}>`,
      to: email,
      subject: `Seu código TenisCash: ${code}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:30px;background:#FF6D00;border-radius:16px;color:#fff;text-align:center">
          <div style="width:60px;height:60px;border-radius:50%;border:3px solid #fff;margin:0 auto 16px;display:flex;align-items:center;justify-content:center">
            <span style="font-size:28px;font-weight:900;color:#fff">T</span>
          </div>
          <h2 style="margin:0 0 8px;letter-spacing:4px">TENISCASH</h2>
          <p style="font-size:12px;opacity:0.7;margin:0 0 24px">SPORTS & TENNIS</p>
          <p style="font-size:14px;margin:0 0 16px">Seu código de verificação é:</p>
          <div style="background:rgba(255,255,255,0.15);border-radius:12px;padding:20px;margin:0 0 16px">
            <span style="font-size:32px;font-weight:900;letter-spacing:8px">${code}</span>
          </div>
          <p style="font-size:12px;opacity:0.6;margin:0">Esse código expira em 10 minutos.</p>
          <p style="font-size:11px;opacity:0.4;margin:16px 0 0">Se você não solicitou este código, ignore este e-mail.</p>
        </div>
      `
    });

    return { success: true, message: 'Código enviado para seu e-mail' };
  } catch (err) {
    console.error('Erro ao enviar e-mail:', err);
    return { success: false, message: 'Erro ao enviar e-mail. Tente novamente.' };
  }
}

function verifyEmailCode(email, code) {
  const stored = emailCodes.get(email);

  if (!stored) {
    return { valid: false, message: 'Código não encontrado. Solicite um novo.' };
  }

  if (Date.now() > stored.expiresAt) {
    emailCodes.delete(email);
    return { valid: false, message: 'Código expirado. Solicite um novo.' };
  }

  stored.attempts++;
  if (stored.attempts > 5) {
    emailCodes.delete(email);
    return { valid: false, message: 'Muitas tentativas. Solicite um novo código.' };
  }

  if (stored.code !== code) {
    return { valid: false, message: 'Código incorreto. Tente novamente.' };
  }

  emailCodes.delete(email);
  return { valid: true };
}

// Limpa códigos expirados
setInterval(() => {
  const now = Date.now();
  for (const [email, data] of emailCodes.entries()) {
    if (now > data.expiresAt) {
      emailCodes.delete(email);
    }
  }
}, 5 * 60 * 1000);

module.exports = { sendEmailCode, verifyEmailCode };
