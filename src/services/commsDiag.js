// TEMPORÁRIO — raio-x READ-ONLY da comunicação (WhatsApp/Evolution + Meta/Instagram).
// Nunca devolve token. Remover junto com a rota /api/_commsdiag.
const { prisma } = require('../middleware');

const EVO = (process.env.EVOLUTION_API_URL || '').replace(/[^\x21-\x7E]/g, '').replace(/\/+$/, '');
const KEY = (process.env.EVOLUTION_API_KEY || '').replace(/[^\x21-\x7E]/g, '');
const GV = process.env.META_GRAPH_API_VERSION || 'v22.0';

async function evo(path) {
  try {
    const r = await fetch(EVO + path, { headers: { apikey: KEY } });
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; } catch (_) { return { status: r.status, body: t.slice(0, 300) }; }
  } catch (e) { return { error: e.message }; }
}
async function graph(path, token) {
  if (!token) return { error: 'sem token' };
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`https://graph.facebook.com/${GV}/${path}${sep}access_token=${encodeURIComponent(token)}`);
    const j = await r.json().catch(() => ({}));
    if (j.error) return { error: `#${j.error.code} ${j.error.message}`.slice(0, 220) };
    return j;
  } catch (e) { return { error: e.message }; }
}

async function run() {
  const out = { at: new Date().toISOString() };
  const envNames = Object.keys(process.env).filter((k) => /^(EVOLUTION|BARATAO|METAFARD|METAAPS|META_|WHATSAPP|WA_|INSTAGRAM|IG_|AI_ATTENDANT)/.test(k));
  out.envPresent = envNames.sort().map((k) => {
    const v = String(process.env[k] || '');
    const isId = /INSTANCE|_ID$|PROVIDER|ENABLED|VERSION|URL$/.test(k) && !/TOKEN|SECRET|KEY/.test(k);
    return isId ? `${k}=${v.slice(0, 60)}` : `${k}=(${v.length} chars)`;
  });

  // Evolution: todas as instâncias + webhook de cada uma
  out.evolution = { configured: !!(EVO && KEY) };
  if (EVO && KEY) {
    const all = await evo('/instance/fetchInstances');
    const arr = Array.isArray(all.body) ? all.body : [];
    out.evolution.instances = [];
    for (const it of arr) {
      const i = it.instance || it;
      const name = i.instanceName || i.name;
      const wh = await evo('/webhook/find/' + encodeURIComponent(name));
      const w = wh.body && typeof wh.body === 'object' ? (wh.body.webhook || wh.body) : null;
      out.evolution.instances.push({
        name,
        status: i.connectionStatus || i.status || i.state,
        number: String(i.ownerJid || i.number || i.owner || '').replace(/\D/g, '') || null,
        profileName: i.profileName || null,
        webhook: w ? { url: w.url || null, enabled: w.enabled, events: w.events } : wh,
      });
    }
    if (!arr.length) out.evolution.raw = all;
  }

  // Mensagens capturadas por instância
  try {
    out.messagesByInstance = await prisma.$queryRawUnsafe(`
      SELECT instance, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE "fromMe"=false)::int AS recebidas,
        COUNT(DISTINCT "chatJid") FILTER (WHERE "isGroup"=false)::int AS contatos,
        COUNT(DISTINCT "chatJid") FILTER (WHERE "isGroup"=false AND ts > NOW()-INTERVAL '30 days')::int AS contatos30d,
        MAX(ts) AS ultima
      FROM "WhatsappMessage" GROUP BY instance ORDER BY total DESC`);
  } catch (e) { out.messagesByInstance = { error: e.message }; }

  try { out.stores = await prisma.store.findMany({ select: { code: true, name: true, phone: true }, orderBy: { code: 'asc' } }); } catch (e) { out.stores = { error: e.message }; }
  try {
    out.crm = {
      usersRoleUser: await prisma.user.count({ where: { role: 'user' } }),
      mfLeads: await prisma.mfLead.count(),
      mfCustomers: await prisma.mfCustomer.count(),
    };
  } catch (e) { out.crm = { error: e.message }; }

  // Meta: o que cada token enxerga (páginas, IG ligados, WABAs)
  const tokens = { META_USER_TOKEN: process.env.META_USER_TOKEN, META_PAGE_TOKEN: process.env.META_PAGE_TOKEN, META_IG_ACCESS_TOKEN: process.env.META_IG_ACCESS_TOKEN, META_SYSTEM_USER_TOKEN: process.env.META_SYSTEM_USER_TOKEN, META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN };
  out.meta = {};
  for (const [name, tok] of Object.entries(tokens)) {
    if (!tok) continue;
    const me = await graph('me?fields=id,name', tok);
    const perms = await graph('me/permissions', tok);
    const accounts = await graph('me/accounts?fields=id,name,instagram_business_account{id,username},connected_instagram_account{id,username}&limit=100', tok);
    const debug = await graph(`debug_token?input_token=${encodeURIComponent(tok)}`, tok);
    out.meta[name] = {
      me,
      type: debug && debug.data ? debug.data.type : null,
      expiresAt: debug && debug.data ? debug.data.expires_at : null,
      scopes: debug && debug.data ? debug.data.scopes : (perms.data ? perms.data.filter((p) => p.status === 'granted').map((p) => p.permission) : perms),
      pages: accounts.data ? accounts.data.map((p) => ({ id: p.id, name: p.name, ig: p.instagram_business_account || p.connected_instagram_account || null })) : accounts,
    };
    if (name === 'META_PAGE_TOKEN') {
      out.meta[name].pageIg = await graph('me?fields=id,name,instagram_business_account{id,username}', tok);
      out.meta[name].subscribedApps = await graph('me/subscribed_apps', tok);
    }
  }
  const bizId = process.env.META_BUSINESS_ID || process.env.META_BUSINESS_MANAGER_ID;
  const ut = process.env.META_SYSTEM_USER_TOKEN || process.env.META_USER_TOKEN;
  if (ut) {
    out.meta.businesses = await graph('me/businesses?fields=id,name&limit=50', ut);
    const ids = new Set([bizId, ...((out.meta.businesses.data || []).map((b) => b.id))].filter(Boolean));
    out.meta.byBusiness = {};
    for (const id of ids) {
      out.meta.byBusiness[id] = {
        ownedPages: await graph(`${id}/owned_pages?fields=id,name,instagram_business_account{id,username}&limit=100`, ut),
        igAccounts: await graph(`${id}/instagram_accounts?fields=id,username&limit=100`, ut),
        wabas: await graph(`${id}/owned_whatsapp_business_accounts?fields=id,name,phone_numbers{display_phone_number,verified_name,status,code_verification_status}&limit=50`, ut),
      };
    }
  }
  return out;
}

module.exports = { run };
