// =====================================================================
// Limitadores específicos da Liga Aberta (F0 — segurança).
// ---------------------------------------------------------------------
// O limitador global (index.js) é de 3000 req/15 min por IP — largo demais
// pra ações que criam coisa (torneio, inscrição, aviso, imagem, conta).
// Aqui cada ação tem o seu, contado por USUÁRIO quando logado (userId) e por
// IP quando não. Resposta 429 em JSON, em português.
// Memória do processo (1 instância no Railway). Reiniciar zera a contagem.
// =====================================================================

const net = require('net');
const rateLimit = require('express-rate-limit');
const { formatPhoneBR } = require('./phoneBR');

const HOUR = 60 * 60 * 1000;

// IP REAL do cliente. Produção fica atrás de Cloudflare → Railway (trust proxy 1
// só enxerga o IP do edge da Cloudflare). Usa cf-connecting-ip quando é um IP
// válido; senão req.ip. IPv6 é agrupado por /64 (um cliente controla o /64 inteiro).
// ⚠️ cf-connecting-ip só é confiável se o tráfego passa pela Cloudflare.
function normalizeIp(raw) {
  let s = String(raw || '').trim().replace(/%.*$/, '');
  if (/^::ffff:/i.test(s) && net.isIPv4(s.slice(7))) s = s.slice(7);
  return s;
}
function expandIPv6(ip) {
  let s = ip.toLowerCase();
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const o = m[2].split('.').map(Number);
    s = m[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => (x || '0').replace(/^0+(?=.)/, ''));
}
function ipKey(req) {
  const headers = (req && req.headers) || {};
  const cf = normalizeIp(headers['cf-connecting-ip']);
  const ip = net.isIP(cf) ? cf : normalizeIp(req.ip || (req.socket && req.socket.remoteAddress));
  if (net.isIPv6(ip)) return expandIPv6(ip).slice(0, 4).join(':') + '::/64';
  return ip || 'sem-ip';
}
function clientIp(req) { return ipKey(req); }
function userOrIp(req) {
  return req.userId ? 'u:' + req.userId : 'ip:' + ipKey(req);
}
// Mesmo formato do envio (formatPhoneBR): com e sem 55 = mesma chave.
function phoneFromBody(req) {
  const b = req.body || {};
  return formatPhoneBR(b.whatsapp || b.phone);
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
  // Liga F2 — convite de elenco e junção de perfis duplicados
  rosterInvite: make({ max: 120, message: 'Muitos convites gerados em pouco tempo. Tente de novo em 1 hora.' }),
  rosterClaim: make({ max: 20, message: 'Muitas tentativas de entrar no elenco. Tente de novo em 1 hora.' }),
  mergeStart: make({ max: 5, message: 'Muitos pedidos de junção de perfil. Tente de novo em 1 hora.' }),
  mergeConfirm: make({ max: 10, message: 'Muitas tentativas de confirmar a junção. Tente de novo em 1 hora.' }),
  // Liga F6 — denúncia e privacidade
  report: make({ max: 20, message: 'Muitas denúncias em pouco tempo. Tente de novo em 1 hora.' }),
  privacyExport: make({ max: 5, message: 'Muitos pedidos de cópia dos dados. Tente de novo em 1 hora.' }),
  privacyDelete: make({ max: 5, message: 'Muitas tentativas de apagar os dados. Tente de novo em 1 hora.' }),
};

module.exports = { limits, make, onlyWhen, userOrIp, ipKey, phoneFromBody };
