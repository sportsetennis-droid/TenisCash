// =====================================================================
// Limitadores específicos da Liga Aberta (F0 — segurança).
// ---------------------------------------------------------------------
// O limitador global (index.js) é de 3000 req/15 min por IP — largo demais
// pra ações que criam coisa (torneio, inscrição, aviso, imagem, conta).
// Aqui cada ação tem o seu, contado por USUÁRIO quando logado (userId) e por
// IP quando não. Resposta 429 em JSON, em português.
// Memória do processo (1 instância no Railway). Reiniciar zera a contagem.
// =====================================================================

const rateLimit = require('express-rate-limit');

const HOUR = 60 * 60 * 1000;

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'sem-ip';
}
function userOrIp(req) {
  return req.userId ? 'u:' + req.userId : 'ip:' + clientIp(req);
}
function phoneFromBody(req) {
  const b = req.body || {};
  const p = String(b.whatsapp || b.phone || '').replace(/\D/g, '');
  return p || null;
}

function make({ windowMs = HOUR, max, message, keyGenerator = userOrIp, skip }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    skip,
    handler: (req, res, _next, options) => {
      res.status(options.statusCode || 429).json({ error: message, retryAfterSeconds: Math.ceil(windowMs / 1000) });
    },
  });
}

// Só aplica o limitador quando a requisição traz o campo (ex.: bannerUrl num PATCH).
function onlyWhen(predicate, limiter) {
  return (req, res, next) => (predicate(req) ? limiter(req, res, next) : next());
}

const limits = {
  createTournament: make({ max: 20, message: 'Muitos torneios criados em pouco tempo. Tente de novo em 1 hora.' }),
  entry: make({ max: 120, message: 'Muitas inscrições em pouco tempo. Aguarde um pouco e tente de novo.' }),
  publicRegister: make({ max: 40, message: 'Muitas inscrições deste aparelho em pouco tempo. Aguarde um pouco e tente de novo.' }),
  post: make({ max: 30, message: 'Muitos avisos publicados em pouco tempo. Tente de novo em 1 hora.' }),
  upload: make({ max: 60, message: 'Muitas imagens enviadas em pouco tempo. Tente de novo em 1 hora.' }),
  club: make({ max: 20, message: 'Muitos clubes criados em pouco tempo. Tente de novo em 1 hora.' }),
  // Cadastro de atleta com código no WhatsApp
  signupCodeIp: make({ max: 20, keyGenerator: (req) => 'ip:' + clientIp(req), message: 'Muitos códigos pedidos deste aparelho. Tente de novo em 1 hora.' }),
  signupCodePhone: make({
    max: 5,
    keyGenerator: (req) => 'ph:' + (phoneFromBody(req) || 'sem-telefone:' + clientIp(req)),
    message: 'Muitos códigos pedidos para este WhatsApp. Tente de novo em 1 hora.',
  }),
  signupIp: make({ max: 30, keyGenerator: (req) => 'ip:' + clientIp(req), message: 'Muitas tentativas de cadastro deste aparelho. Tente de novo em 1 hora.' }),
};

module.exports = { limits, make, onlyWhen, userOrIp };
