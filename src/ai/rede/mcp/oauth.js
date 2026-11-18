// OAuth 2.1 do MCP do TenisCash (dono 18/11/2026: "Coloca aí… Faça, execute").
// Deixa o Claude (celular, Desktop, claude.ai e Claude Code) conectar no /mcp só com a URL:
// o Claude se registra sozinho (RFC 7591), abre a tela de autorização, o dono entra com o
// login do admin e toca em "Autorizar"; o Claude recebe um token de 1 hora + renovação.
//
//  - Descoberta: /.well-known/oauth-protected-resource[/mcp] (RFC 9728) e
//                /.well-known/oauth-authorization-server (RFC 8414)
//  - Registro dinâmico: POST /oauth/register
//  - Autorização (PKCE S256 obrigatório): GET /oauth/authorize → tela → POST /oauth/authorize/decisao
//  - Token: POST /oauth/token (authorization_code e refresh_token, com rotação)
//
// O token de acesso é um JWT do próprio TenisCash (mesmo JWT_SECRET), então o /mcp continua
// validando do mesmo jeito: banco é a autoridade, só admin/superadmin/manager entram.
// Tabelas por SQL aditivo/idempotente (o deploy não roda prisma db push).

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { prisma, authMiddleware, JWT_SECRET } = require('../../../middleware');

const ADMIN_ROLES = ['admin', 'superadmin', 'manager'];
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_DIAS = 60;
const CODE_TTL_MS = 5 * 60 * 1000;

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function baseDe(req) {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}

let pronto = null;
function garantirTabelas(db) {
  if (!pronto) {
    pronto = (async () => {
      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "McpOAuthClient" (
        "id" TEXT PRIMARY KEY, "name" TEXT, "redirectUris" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`);
      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "McpOAuthCode" (
        "codeHash" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "userId" TEXT NOT NULL, "redirectUri" TEXT NOT NULL,
        "codeChallenge" TEXT NOT NULL, "scope" TEXT, "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3))`);
      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "McpOAuthRefresh" (
        "tokenHash" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "userId" TEXT NOT NULL, "scope" TEXT,
        "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`);
    })().catch((e) => { pronto = null; throw e; });
  }
  return pronto;
}

// Só https, ou http em localhost/127.0.0.1 (Claude Code abre um servidor local pra receber o código).
function redirectValido(uri) {
  try {
    const u = new URL(String(uri));
    if (u.hash) return false;
    // Só o Claude (claude.ai/claude.com/anthropic.com) ou o próprio computador.
    if (u.protocol === 'https:') return ['claude.ai', 'claude.com', 'anthropic.com'].some((d) => u.hostname === d || u.hostname.endsWith('.' + d));
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch (_) { return false; }
}

function erroOAuth(res, status, error, descricao) {
  res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: descricao });
}

function telaAutorizar({ cliente, params, base }) {
  // JSON seguro dentro de <script>: sem "<", ">" e "&" literais (não fecha a tag nem injeta HTML).
  const pJson = JSON.stringify(params).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#E5571E"><title>Autorizar acesso · TenisCash</title>
<style>:root{--brand:#E5571E;--ink:#1d1d1f;--muted:#6e6e73;--line:#e8e8ed;--bad:#b42318}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f6f8;color:var(--ink);padding:env(safe-area-inset-top) 16px env(safe-area-inset-bottom)}
.c{max-width:420px;margin:32px auto;background:#fff;border-radius:20px;padding:24px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
.logo{width:52px;height:52px;border-radius:14px;background:var(--brand);color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:20px}
h1{font-size:21px;margin-top:14px}p{color:var(--muted);font-size:15px;margin-top:8px;line-height:1.45}ul{margin:12px 0 0 18px;color:var(--ink);font-size:14px;line-height:1.6}
input{width:100%;min-height:48px;border:1px solid var(--line);border-radius:12px;padding:0 12px;font-size:16px;margin-top:10px}
button{width:100%;min-height:52px;border:0;border-radius:14px;font-weight:800;font-size:16px;margin-top:12px;cursor:pointer}
.ok{background:var(--brand);color:#fff}.no{background:#fff;border:1px solid var(--line);color:var(--ink)}.msg{color:var(--bad);font-size:14px;margin-top:10px;min-height:18px}</style></head>
<body><div class="c"><div class="logo">TC</div><h1>Conectar ${esc(cliente.name || 'Claude')} ao TenisCash</h1>
<p>O aplicativo <b>${esc(cliente.name || 'Claude')}</b> quer acessar o TenisCash em seu nome, com as ferramentas do MCP:</p>
<p style="font-size:13px;color:#6e6e73">Retorno para: <b>${esc(new URL(params.redirect_uri).host)}</b>. Só autorize se for o Claude.</p>
<ul><li>consultar estoque, vendas, NF-e e propostas da rede de agentes;</li><li>decidir uma proposta só depois da sua confirmação.</li></ul>
<p>Só funciona com conta de dono/administração. O acesso dura 1 hora e renova sozinho; você pode desconectar quando quiser.</p>
<div id="area"></div><div class="msg" id="msg"></div></div>
<script>
const P = ${pJson};
const area = document.getElementById('area'), msg = document.getElementById('msg');
const tok = () => { try { return localStorage.getItem('tc_admin_token') || ''; } catch (_) { return ''; } };
function decidir(aprovar) {
  msg.textContent = '';
  fetch('/oauth/authorize/decisao', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() }, body: JSON.stringify(Object.assign({}, P, { aprovar })) })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => { if (ok && j.redirect) location.href = j.redirect; else { msg.textContent = j.error_description || j.error || 'Não foi possível autorizar.'; if (j.relogar) mostrarLogin(); } })
    .catch(() => { msg.textContent = 'Sem conexão. Tente de novo.'; });
}
function mostrarAutorizar() {
  area.innerHTML = '<button class="ok" id="sim">Autorizar</button><button class="no" id="nao">Cancelar</button>';
  document.getElementById('sim').onclick = () => decidir(true);
  document.getElementById('nao').onclick = () => decidir(false);
}
function mostrarLogin() {
  area.innerHTML = '<p>Entre com o seu login do admin do TenisCash:</p><input id="u" placeholder="Telefone ou e-mail" autocomplete="username"><input id="s" type="password" placeholder="Senha" autocomplete="current-password"><button class="ok" id="ent">Entrar e autorizar</button><button class="no" id="nao">Cancelar</button>';
  document.getElementById('nao').onclick = () => decidir(false);
  document.getElementById('ent').onclick = async () => {
    const u = document.getElementById('u').value.trim(), s = document.getElementById('s').value;
    if (!u || !s) { msg.textContent = 'Preencha login e senha.'; return; }
    const body = u.includes('@') ? { email: u, password: s } : { phone: u.replace(/\\D/g, ''), password: s };
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.token) { msg.textContent = j.error || 'Login não aceito.'; return; }
      try { localStorage.setItem('tc_admin_token', j.token); } catch (_) {}
      decidir(true);
    } catch (_) { msg.textContent = 'Sem conexão. Tente de novo.'; }
  };
}
if (tok()) mostrarAutorizar(); else mostrarLogin();
</script></body></html>`;
}

function mount(app, opcoes = {}) {
  const db = opcoes.db || prisma;
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const json = express.json({ limit: '20kb' });

  const metaRecurso = (req, res) => {
    const base = baseDe(req);
    res.set('Cache-Control', 'no-store').json({ resource: base + '/mcp', authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: 'TenisCash' });
  };
  app.get('/.well-known/oauth-protected-resource', metaRecurso);
  app.get('/.well-known/oauth-protected-resource/mcp', metaRecurso);

  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = baseDe(req);
    res.set('Cache-Control', 'no-store').json({
      issuer: base,
      authorization_endpoint: base + '/oauth/authorize',
      token_endpoint: base + '/oauth/token',
      registration_endpoint: base + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  // Registro dinâmico (cliente público, sem segredo — a proteção é PKCE + redirect conferido).
  app.post('/oauth/register', json, async (req, res) => {
    try {
      await garantirTabelas(db);
      const b = req.body || {};
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).slice(0, 10) : [];
      if (!uris.length || !uris.every(redirectValido)) return erroOAuth(res, 400, 'invalid_redirect_uri', 'Endereço de retorno precisa ser do Claude (claude.ai) ou localhost.');
      const id = 'tc_' + rand(18);
      const name = String(b.client_name || 'Claude').slice(0, 80);
      await db.$executeRaw`INSERT INTO "McpOAuthClient" ("id","name","redirectUris") VALUES (${id}, ${name}, ${JSON.stringify(uris)})`;
      res.status(201).set('Cache-Control', 'no-store').json({
        client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      });
    } catch (e) { console.error('[mcp-oauth] register', e.message); erroOAuth(res, 500, 'server_error', 'Falha ao registrar.'); }
  });

  async function cliente(clientId) {
    const [c] = await db.$queryRaw`SELECT "id","name","redirectUris" FROM "McpOAuthClient" WHERE "id" = ${String(clientId || '')} LIMIT 1`;
    if (!c) return null;
    return { ...c, uris: JSON.parse(c.redirectUris || '[]') };
  }

  app.get('/oauth/authorize', async (req, res) => {
    try {
      await garantirTabelas(db);
      const q = req.query || {};
      const c = await cliente(q.client_id);
      if (!c) return res.status(400).type('text/plain').send('Aplicativo não registrado. Conecte de novo pelo Claude.');
      if (!c.uris.includes(String(q.redirect_uri || ''))) return res.status(400).type('text/plain').send('Endereço de retorno não confere com o registro.');
      const back = new URL(String(q.redirect_uri));
      const falha = (error, desc) => { back.searchParams.set('error', error); if (desc) back.searchParams.set('error_description', desc); if (q.state) back.searchParams.set('state', String(q.state)); return res.redirect(302, back.toString()); };
      if (q.response_type !== 'code') return falha('unsupported_response_type', 'Use response_type=code.');
      if (!q.code_challenge || q.code_challenge_method !== 'S256') return falha('invalid_request', 'PKCE S256 obrigatório.');
      const params = { client_id: c.id, redirect_uri: String(q.redirect_uri), code_challenge: String(q.code_challenge), state: q.state != null ? String(q.state) : '', scope: String(q.scope || 'mcp') };
      res.set('Cache-Control', 'no-store').set('X-Frame-Options', 'DENY').type('html').send(telaAutorizar({ cliente: c, params, base: baseDe(req) }));
    } catch (e) { console.error('[mcp-oauth] authorize', e.message); res.status(500).type('text/plain').send('Erro ao abrir a autorização.'); }
  });

  // A tela manda o token do admin (login do navegador); o servidor confere no banco e emite o código.
  app.post('/oauth/authorize/decisao', json, (req, res, next) => {
    if (!/^Bearer\s+\S+/i.test(String(req.headers.authorization || ''))) return erroOAuth(res, 401, 'login_required', 'Entre com o login do admin.');
    return authMiddleware(req, { status: () => ({ json: () => res.status(401).json({ error: 'login_required', error_description: 'Login vencido. Entre de novo.', relogar: true }) }) }, next);
  }, async (req, res) => {
    try {
      await garantirTabelas(db);
      const b = req.body || {};
      const c = await cliente(b.client_id);
      if (!c || !c.uris.includes(String(b.redirect_uri || ''))) return erroOAuth(res, 400, 'invalid_request', 'Aplicativo ou endereço de retorno inválido.');
      const back = new URL(String(b.redirect_uri));
      if (b.state) back.searchParams.set('state', String(b.state));
      if (!b.aprovar) { back.searchParams.set('error', 'access_denied'); return res.json({ redirect: back.toString() }); }
      if (!ADMIN_ROLES.includes(req.userRole)) return res.status(403).json({ error: 'access_denied', error_description: 'Só conta de dono/administração pode conectar o MCP.', relogar: true });
      if (!b.code_challenge) return erroOAuth(res, 400, 'invalid_request', 'PKCE ausente.');
      const code = rand(32);
      await db.$executeRaw`INSERT INTO "McpOAuthCode" ("codeHash","clientId","userId","redirectUri","codeChallenge","scope","expiresAt")
        VALUES (${sha(code)}, ${c.id}, ${req.userId}, ${String(b.redirect_uri)}, ${String(b.code_challenge)}, ${String(b.scope || 'mcp')}, NOW() + make_interval(secs => ${Math.round(CODE_TTL_MS / 1000)}))`;
      back.searchParams.set('code', code);
      res.set('Cache-Control', 'no-store').json({ redirect: back.toString() });
    } catch (e) { console.error('[mcp-oauth] decisao', e.message); erroOAuth(res, 500, 'server_error', 'Falha ao autorizar.'); }
  });

  async function emitir(userId, clientId, scope) {
    const u = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, active: true } });
    if (!u || u.active === false || !ADMIN_ROLES.includes(u.role)) return null;
    const access = jwt.sign({ userId: u.id, role: u.role, aud: 'teniscash-mcp', cid: clientId }, JWT_SECRET, { expiresIn: ACCESS_TTL_S });
    const refresh = rand(40);
    await db.$executeRaw`INSERT INTO "McpOAuthRefresh" ("tokenHash","clientId","userId","scope","expiresAt")
      VALUES (${sha(refresh)}, ${clientId}, ${u.id}, ${scope || 'mcp'}, NOW() + make_interval(days => ${REFRESH_TTL_DIAS}::int))`;
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scope || 'mcp' };
  }

  app.post('/oauth/token', form, json, async (req, res) => {
    try {
      await garantirTabelas(db);
      const b = req.body || {};
      if (b.grant_type === 'authorization_code') {
        const codeHash = sha(b.code || '');
        const [row] = await db.$queryRaw`SELECT *, ("expiresAt" > NOW()) AS "vigente" FROM "McpOAuthCode" WHERE "codeHash" = ${codeHash} LIMIT 1`;
        if (!row || row.usedAt || !row.vigente) return erroOAuth(res, 400, 'invalid_grant', 'Código inválido ou vencido.');
        if (row.clientId !== String(b.client_id || '') || row.redirectUri !== String(b.redirect_uri || '')) return erroOAuth(res, 400, 'invalid_grant', 'Código não confere com o aplicativo.');
        const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
        if (!b.code_verifier || challenge !== row.codeChallenge) return erroOAuth(res, 400, 'invalid_grant', 'PKCE não confere.');
        const usado = await db.$executeRaw`UPDATE "McpOAuthCode" SET "usedAt" = NOW() WHERE "codeHash" = ${codeHash} AND "usedAt" IS NULL`;
        if (!usado) return erroOAuth(res, 400, 'invalid_grant', 'Código já usado.');
        const t = await emitir(row.userId, row.clientId, row.scope);
        if (!t) return erroOAuth(res, 400, 'invalid_grant', 'Conta sem acesso de administração.');
        return res.set('Cache-Control', 'no-store').json(t);
      }
      if (b.grant_type === 'refresh_token') {
        const h = sha(b.refresh_token || '');
        const [row] = await db.$queryRaw`SELECT *, ("expiresAt" > NOW()) AS "vigente" FROM "McpOAuthRefresh" WHERE "tokenHash" = ${h} LIMIT 1`;
        if (row && row.revokedAt) {
          // Reuso de renovação já usada = possível roubo: derruba todas as renovações desse aplicativo.
          await db.$executeRaw`UPDATE "McpOAuthRefresh" SET "revokedAt" = NOW() WHERE "clientId" = ${row.clientId} AND "userId" = ${row.userId} AND "revokedAt" IS NULL`;
          return erroOAuth(res, 400, 'invalid_grant', 'Renovação já usada. Conecte de novo.');
        }
        if (!row || !row.vigente || row.clientId !== String(b.client_id || '')) return erroOAuth(res, 400, 'invalid_grant', 'Renovação inválida. Conecte de novo.');
        const revogado = await db.$executeRaw`UPDATE "McpOAuthRefresh" SET "revokedAt" = NOW() WHERE "tokenHash" = ${h} AND "revokedAt" IS NULL`;
        if (!revogado) return erroOAuth(res, 400, 'invalid_grant', 'Renovação já usada. Conecte de novo.');
        const t = await emitir(row.userId, row.clientId, row.scope);
        if (!t) return erroOAuth(res, 400, 'invalid_grant', 'Conta sem acesso de administração.');
        return res.set('Cache-Control', 'no-store').json(t);
      }
      return erroOAuth(res, 400, 'unsupported_grant_type', 'Use authorization_code ou refresh_token.');
    } catch (e) { console.error('[mcp-oauth] token', e.message); erroOAuth(res, 500, 'server_error', 'Falha ao emitir o token.'); }
  });
}

module.exports = { mount, redirectValido, baseDe, garantirTabelas };
