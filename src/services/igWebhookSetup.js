// Liga o recebimento de DM do Instagram no nosso servidor:
//  1) assinatura do APP no objeto "instagram" (campo messages) -> /api/instagram/webhook
//  2) a Página (com o IG ligado) inscrita no app (subscribed_apps)
// Só funciona pras contas IG que estão ligadas a uma Página que o token enxerga.
const GV = process.env.META_GRAPH_API_VERSION || 'v22.0';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.APP_URL || 'https://teniscash.com.br').replace(/\/+$/, '');
const VERIFY = process.env.META_IG_VERIFY_TOKEN || process.env.META_WHATSAPP_VERIFY_TOKEN || 'teniscash-whatsapp-webhook-2026';

async function call(path, method, params) {
  const r = await fetch(`https://graph.facebook.com/${GV}/${path}`, {
    method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  return j.error ? { ok: false, error: `#${j.error.code} ${j.error.message}`.slice(0, 240) } : { ok: true, data: j };
}

async function activateInstagramWebhook() {
  const appId = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;
  const pageToken = process.env.META_PAGE_TOKEN;
  const out = { callback: PUBLIC_URL + '/api/instagram/webhook' };
  if (!appId || !secret || !pageToken) return { ...out, ok: false, error: 'faltam META_APP_ID / META_APP_SECRET / META_PAGE_TOKEN' };
  const appToken = `${appId}|${secret}`;
  out.appSubscription = await call(`${appId}/subscriptions`, 'POST', {
    object: 'instagram', callback_url: out.callback, fields: 'messages', verify_token: VERIFY,
    include_values: 'true', access_token: appToken,
  });
  out.pageSubscription = await call('me/subscribed_apps', 'POST', { subscribed_fields: 'messages', access_token: pageToken });
  const check = await fetch(`https://graph.facebook.com/${GV}/me/subscribed_apps?access_token=${encodeURIComponent(pageToken)}`).then((r) => r.json()).catch(() => ({}));
  out.pageSubscribedApps = (check.data || []).map((a) => ({ id: a.id, name: a.name, fields: a.subscribed_fields }));
  const subs = await fetch(`https://graph.facebook.com/${GV}/${appId}/subscriptions?access_token=${encodeURIComponent(appToken)}`).then((r) => r.json()).catch(() => ({}));
  out.appSubscriptions = (subs.data || []).map((s) => ({ object: s.object, url: s.callback_url, active: s.active, fields: (s.fields || []).map((f) => f.name || f) }));
  out.ok = !!(out.appSubscription.ok && out.pageSubscription.ok);
  return out;
}

module.exports = { activateInstagramWebhook };
