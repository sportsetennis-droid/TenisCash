// =====================================================================
// URL pública do sistema — fonte única da verdade.
// ---------------------------------------------------------------------
// PUBLIC_BASE_URL define o domínio público (links em páginas, e-mails,
// QR, bots). Default = teniscash.com.br (não quebra nada até o dono
// apontar o domínio novo e setar a env no Railway).
//
// Migração pra domínio novo (ex: clubsportsetennis.com.br):
//   1) DNS/Railway: domínio novo servindo o app.
//   2) Railway env: PUBLIC_BASE_URL=https://clubsportsetennis.com.br
//      → todos os links de página/e-mail passam a usar o novo.
//   3) (opcional) CANONICAL_HOST=clubsportsetennis.com.br
//      → teniscash.com.br e www.* redirecionam 301 pro novo
//        (só páginas GET; /api, /webhooks, /oauth ficam de fora).
// =====================================================================

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br').replace(/\/+$/, '');
}

// Só o host (sem protocolo, sem barra final) — pra rodapé "clubsportsetennis.com.br".
function publicDomain() {
  return publicBaseUrl().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

// Decide o destino do redirect canônico, ou null se NÃO redireciona.
// Regras: só com canonicalHost setado; só GET/HEAD; só dos hosts antigos
// (teniscash + www) ou do www do próprio canônico; nunca /api,/webhooks,
// /oauth,/.well-known; nunca se já está no host canônico.
function canonicalRedirectUrl({ host, method, path, originalUrl, canonicalHost } = {}) {
  const ch = String(canonicalHost || '').trim().toLowerCase();
  if (!ch) return null;
  if (method !== 'GET' && method !== 'HEAD') return null;
  const h = String(host || '').toLowerCase();
  if (h === ch) return null;
  const from = new Set(['teniscash.com.br', 'www.teniscash.com.br', 'www.' + ch]);
  if (!from.has(h)) return null;
  const p = path || '';
  if (p.startsWith('/api') || p.startsWith('/webhooks') || p.startsWith('/oauth') || p.startsWith('/.well-known')) return null;
  return 'https://' + ch + (originalUrl || '/');
}

module.exports = { publicBaseUrl, publicDomain, canonicalRedirectUrl };
