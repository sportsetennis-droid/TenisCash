// =====================================================================
// Observabilidade: log JSON (pino) com requestId + Sentry opcional.
// ---------------------------------------------------------------------
// - NÃO muda o comportamento das rotas. Os console.log/console.error que já
//   existem continuam iguais; isto só ACRESCENTA uma linha JSON por request
//   de /api e /webhooks (método, rota sem query sensível, status, tempo, id).
// - x-request-id: aproveita o que vier do proxy (se for um id válido) ou gera
//   um UUID; devolve no header da resposta pra cruzar log ↔ reclamação.
// - NUNCA loga corpo, token, senha, CPF, telefone, cookie ou Authorization.
// - Sentry só liga se existir SENTRY_DSN. Sem DSN: nada é carregado/registrado
//   (no-op total, nem handler de erro nem de unhandledRejection).
// Envs: LOG_LEVEL (info), LOG_HTTP=off (desliga a linha por request),
//       SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_TRACES_SAMPLE_RATE (0).
// =====================================================================

const crypto = require('crypto');
const pino = require('pino');

// Caminhos que o pino apaga de QUALQUER log estruturado (logger.info({...})).
const REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'req.body', 'body', 'res.headers["set-cookie"]',
  'authorization', 'cookie', 'token', 'accessToken', 'refreshToken', 'password', 'senha', 'secret',
  'cpf', 'CPF', 'document', 'documento', 'phone', 'telefone', 'whatsapp', 'email',
  '*.authorization', '*.cookie', '*.token', '*.accessToken', '*.refreshToken', '*.password', '*.senha', '*.secret',
  '*.cpf', '*.CPF', '*.document', '*.documento', '*.phone', '*.telefone', '*.whatsapp', '*.email', '*.body',
  '*.*.token', '*.*.password', '*.*.cpf', '*.*.phone', '*.*.telefone', '*.*.email',
];

const SENSITIVE_QUERY_KEYS = /^(token|access_token|key|apikey|api_key|g|secret|password|senha|cpf|phone|telefone|whatsapp|email|code|otp|signature|sig)$/i;

// Texto livre (URL, mensagem de erro): mascara CPF, telefone, e-mail e JWT.
function scrubText(value) {
  return String(value == null ? '' : value)
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[cpf]')
    .replace(/\(?\b\d{2}\)?\s?9?\d{4}-\d{4}\b/g, '[telefone]')
    .replace(/\+?\b55\d{10,11}\b/g, '[telefone]')
    .replace(/\b\d{10,11}\b/g, '[num]');
}

// URL sem valores sensíveis na query (?token=..., ?cpf=...) e sem CPF/telefone no caminho.
function safeUrl(url) {
  const raw = String(url || '');
  const q = raw.indexOf('?');
  // Links-capacidade (token no CAMINHO): /team-calendar/feed/<token>.ics
  const path = scrubText(q === -1 ? raw : raw.slice(0, q)).replace(/(\/team-calendar\/feed\/)[^/?#]+/g, '$1[token]');
  if (q === -1) return path;
  const params = new URLSearchParams(raw.slice(q + 1));
  const out = [];
  for (const [k, v] of params) out.push(encodeURIComponent(k) + '=' + (SENSITIVE_QUERY_KEYS.test(k) ? '[redigido]' : encodeURIComponent(scrubText(v).slice(0, 80))));
  return path + (out.length ? '?' + out.join('&') : '');
}

function createLogger({ destination, ...opts } = {}) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { svc: 'teniscash-api' },
    redact: { paths: REDACT_PATHS, censor: '[redigido]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...opts,
  }, destination);
}

let logger = null;
function getLogger() {
  if (!logger) logger = createLogger();
  return logger;
}

const REQ_ID_RE = /^[A-Za-z0-9._:-]{8,80}$/;
function requestIdFor(req, res) {
  const incoming = String(req.headers['x-request-id'] || '');
  const id = REQ_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  req.id = id;
  try { res.setHeader('x-request-id', id); } catch (_) {}
  return id;
}

function shouldLogPath(url) {
  const p = String(url || '').split('?')[0];
  if (!(p.startsWith('/api/') || p.startsWith('/webhooks/'))) return false; // estático/páginas: não
  if (p === '/api/health') return false;
  if (/^\/(?:api\/)?live\/camera\//.test(p) || /^\/api\/admin\/security\/camera-live\//.test(p)) return false; // HLS: milhares/min
  return true;
}

function httpLogger(opts = {}) {
  const pinoHttp = require('pino-http');
  return pinoHttp({
    logger: opts.logger || getLogger(),
    genReqId: requestIdFor,
    autoLogging: { ignore: (req) => process.env.LOG_HTTP === 'off' || !shouldLogPath(req.originalUrl || req.url) },
    quietReqLogger: true,
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    // Só o mínimo. Sem headers, sem corpo, sem IP.
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: safeUrl(req.originalUrl || req.url) }),
      res: (res) => ({ statusCode: res.statusCode }),
      err: (err) => ({ type: err && err.name, message: scrubText(err && err.message).slice(0, 300) }),
    },
    customSuccessMessage: (req, res) => `${req.method} ${safeUrl(String(req.originalUrl || req.url).split('?')[0]).slice(0, 120)} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${safeUrl(String(req.originalUrl || req.url).split('?')[0]).slice(0, 120)} ${res.statusCode}`,
  });
}

// ---------------------------- Sentry -------------------------------
let Sentry = null;

function scrubObject(obj, depth = 0) {
  if (obj == null || depth > 6) return obj;
  if (typeof obj === 'string') return scrubText(obj);
  if (Array.isArray(obj)) return obj.map((v) => scrubObject(v, depth + 1));
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/^(authorization|cookie|cookies|token|password|senha|cpf|phone|telefone|whatsapp|email|data|body|secret|x-api-key)$/i.test(k)) { out[k] = '[redigido]'; continue; }
    out[k] = scrubObject(v, depth + 1);
  }
  return out;
}

// beforeSend: tira corpo, cookies, headers, IP; usuário só com id.
function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.env;
    if (event.request.url) event.request.url = safeUrl(event.request.url);
    if (event.request.query_string) event.request.query_string = typeof event.request.query_string === 'string'
      ? safeUrl('?' + event.request.query_string).slice(1) : '[redigido]';
  }
  if (event.user) event.user = event.user.id ? { id: String(event.user.id) } : undefined;
  if (event.message) event.message = scrubText(event.message);
  if (event.exception && Array.isArray(event.exception.values)) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = scrubText(ex.value);
      if (ex.stacktrace && Array.isArray(ex.stacktrace.frames)) for (const f of ex.stacktrace.frames) delete f.vars;
    }
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({ ...b, message: b.message ? scrubText(b.message) : b.message, data: b.data ? scrubObject(b.data) : b.data }));
  }
  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) event.contexts = scrubObject(event.contexts);
  return event;
}

function initSentry(env = process.env) {
  if (!env.SENTRY_DSN) return null; // no-op: não carrega nem registra nada
  if (Sentry) return Sentry;
  Sentry = require('@sentry/node');
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || 'production',
    release: env.RAILWAY_GIT_COMMIT_SHA || undefined,
    sendDefaultPii: false,
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE || 0),
    // LocalVariables leria variáveis do stack (pode ter CPF/token) — fora.
    // Console vira breadcrumb de log livre — fora (logs têm telefone de cliente).
    // OnUnhandledRejection em modo 'strict': captura e mantém o comportamento
    // atual do Node 22 (rejeição não tratada derruba o processo → Railway reinicia).
    integrations: (defaults) => defaults
      .filter((i) => !['LocalVariables', 'LocalVariablesAsync', 'Console', 'OnUnhandledRejection'].includes(i.name))
      .concat([Sentry.onUnhandledRejectionIntegration({ mode: 'strict' })]),
    beforeSend: scrubEvent,
    beforeBreadcrumb: (b) => ({ ...b, message: b.message ? scrubText(b.message) : b.message, data: b.data ? scrubObject(b.data) : b.data }),
  });
  return Sentry;
}

// 5xx tratados dentro das rotas (catch → res.status(500)) também viram evento,
// agrupados por método+rota (sem query) — o corpo/PII nunca vai.
function sentryResponseHook(req, res, next) {
  if (!Sentry) return next();
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    const route = safeUrl(String(req.originalUrl || req.url || '').split('?')[0]).replace(/\/[0-9a-f-]{16,}/gi, '/:id').slice(0, 120);
    Sentry.withScope((scope) => {
      scope.setTag('requestId', req.id || '');
      scope.setFingerprint(['http-5xx', req.method, route]);
      Sentry.captureMessage(`HTTP ${res.statusCode} ${req.method} ${scrubText(route)}`, 'error');
    });
  });
  next();
}

// Chamado logo depois de criar o app (antes das rotas).
function install(app) {
  initSentry();
  app.use(httpLogger());
  app.use(sentryResponseHook);
  return app;
}

// Chamado depois de todas as rotas. Sem DSN não registra nada.
function installErrorHandler(app) {
  if (!Sentry) return app;
  Sentry.setupExpressErrorHandler(app);
  return app;
}

function _resetForTests() { Sentry = null; logger = null; }

module.exports = {
  REDACT_PATHS, scrubText, safeUrl, scrubEvent, createLogger, getLogger, httpLogger,
  initSentry, install, installErrorHandler, sentryResponseHook, _resetForTests,
  get sentryEnabled() { return !!Sentry; },
};
