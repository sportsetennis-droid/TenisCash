// =====================================================================
// Conta Instagram Business da loja (@sportsetennis) — resolvedor ÚNICO.
// ---------------------------------------------------------------------
// Antes cada serviço lia uma env diferente (META_IG_BUSINESS_ID /
// META_IG_USER_ID / META_INSTAGRAM_ID) e o META_IG_USER_ID do Railway
// apontava pra um ID inexistente ("Object ... does not exist") → publicação
// e Business Discovery (foto do atleta) falhavam.
//
// Agora: testa cada ID configurado no Graph e usa o PRIMEIRO que responde.
// Se nenhum responde, descobre o ID real pela Página do Facebook
// (instagram_business_account). Resultado fica em cache (30 min).
// Nunca expõe o token.
// =====================================================================

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || process.env.META_GRAPH_VERSION || 'v22.0'}`;
const TTL_MS = 30 * 60 * 1000;
const ID_ENVS = ['META_IG_BUSINESS_ID', 'META_IG_USER_ID', 'META_INSTAGRAM_ID'];

let cache = null; // { at, result }
let inflight = null;

function igToken() {
  return process.env.META_IG_ACCESS_TOKEN || process.env.META_PAGE_TOKEN || process.env.META_USER_TOKEN || null;
}

async function graphGet(path, params, token) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}?${qs}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`[Meta ${r.status}${e.code ? ' #' + e.code : ''}] ${e.message || 'erro desconhecido'}`);
  }
  return j;
}

async function doResolve() {
  const token = igToken();
  const out = { ok: false, igId: null, username: null, source: null, tried: [], checkedAt: new Date().toISOString() };
  if (!token) { out.error = 'sem token (META_IG_ACCESS_TOKEN / META_PAGE_TOKEN / META_USER_TOKEN)'; return out; }

  // 1) IDs configurados nas envs, na ordem de preferência (sem repetir).
  const seen = new Set();
  for (const env of ID_ENVS) {
    const id = String(process.env[env] || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const j = await graphGet(id, { fields: 'id,username' }, token);
      if (j.username) {
        Object.assign(out, { ok: true, igId: String(j.id || id), username: j.username, source: `env:${env}` });
        return out;
      }
      out.tried.push({ env, error: 'sem username (não é conta IG)' });
    } catch (e) {
      out.tried.push({ env, error: e.message.slice(0, 160) });
    }
  }

  // 2) Descobre pela Página do Facebook vinculada.
  const pageRefs = [];
  if (process.env.META_PAGE_ID) pageRefs.push({ ref: String(process.env.META_PAGE_ID).trim(), label: 'page:META_PAGE_ID' });
  pageRefs.push({ ref: 'me', label: 'page:token' }); // token de Página → /me é a própria Página
  for (const p of pageRefs) {
    try {
      const j = await graphGet(p.ref, { fields: 'instagram_business_account{id,username}' }, token);
      const acc = j.instagram_business_account;
      if (acc && acc.id) {
        Object.assign(out, { ok: true, igId: String(acc.id), username: acc.username || null, source: p.label });
        return out;
      }
      out.tried.push({ env: p.label, error: 'página sem instagram_business_account' });
    } catch (e) {
      out.tried.push({ env: p.label, error: e.message.slice(0, 160) });
    }
  }

  out.error = 'nenhum ID de Instagram válido (ver tried)';
  return out;
}

// Retorna { ok, igId, username, source, tried, error? }. force=true ignora cache.
async function resolveIgAccount({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.result;
  if (inflight) return inflight;
  inflight = doResolve()
    .then((result) => {
      cache = { at: Date.now(), result };
      if (!result.ok) console.warn('[igAccount] Instagram NÃO resolvido:', JSON.stringify(result.tried));
      return result;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Credenciais prontas pra uso (lança erro claro se não der).
async function getIgCredentials() {
  const token = igToken();
  const acc = await resolveIgAccount();
  if (!token || !acc.ok) throw new Error(`Instagram não configurado: ${acc.error || 'sem token'}`);
  return { userId: acc.igId, token };
}

// Estado pro /api/health (sem token, sem chamar a Meta).
function getIgHealthState() {
  if (!cache) return { state: 'unchecked' };
  const r = cache.result;
  return { state: r.ok ? 'ok' : 'error', username: r.username, source: r.source, checkedAt: r.checkedAt,
    error: r.ok ? undefined : r.error, tried: r.tried.length ? r.tried : undefined };
}

// Checagem no boot + a cada 30 min, pra o health refletir o estado real.
function startIgHealthCheck() {
  if (!igToken()) { console.log('[igAccount] sem token Meta — check não iniciado'); return; }
  const run = () => resolveIgAccount({ force: true })
    .then((r) => console.log(`[igAccount] ${r.ok ? `OK @${r.username} (${r.source})` : 'FALHOU'}`))
    .catch((e) => console.error('[igAccount] erro:', e.message));
  setTimeout(run, 10000);
  setInterval(run, TTL_MS).unref();
}

module.exports = { igToken, resolveIgAccount, getIgCredentials, getIgHealthState, startIgHealthCheck };
