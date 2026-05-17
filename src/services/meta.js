// =====================================================================
// Meta / Facebook Graph API — wrapper único
// =====================================================================
// Cobre: Facebook Page, Instagram Business, WhatsApp Business, Ads, Catalog
//
// ENV vars necessárias (Railway):
//   META_USER_TOKEN           - token do usuário (long-lived)
//   META_PAGE_ID              - id da Facebook Page
//   META_PAGE_TOKEN           - token de página (long-lived, daquela page)
//   META_INSTAGRAM_ID         - id do Instagram Business (vinculado à page)
//   META_WHATSAPP_BUSINESS_ID - id da WhatsApp Business Account
//   META_WHATSAPP_ACCESS_TOKEN - token da Cloud API do WhatsApp
//   META_WHATSAPP_PHONE_NUMBER_ID - id do numero remetente do WhatsApp
//   META_BUSINESS_ID          - id do Business Manager (BM)
//   META_AD_ACCOUNT_ID        - id da conta de anúncios (ex: act_750101118074129)
// =====================================================================

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v22.0'}`;

function isConfigured() {
  return !!process.env.META_USER_TOKEN;
}

async function graphApi(path, opts = {}) {
  const method = opts.method || 'GET';
  const token = opts.token || process.env.META_PAGE_TOKEN || process.env.META_USER_TOKEN;
  let url = `${GRAPH}${path}`;
  let body = null;

  if (method === 'GET') {
    const sep = path.includes('?') ? '&' : '?';
    url = `${url}${sep}access_token=${token}`;
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
      }
    }
  } else {
    const params = opts.params || {};
    params.access_token = token;
    body = new URLSearchParams(params).toString();
  }

  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`[Meta ${res.status}] ${data.error?.message || JSON.stringify(data).slice(0,200)}`);
  }
  return data;
}

// =====================================================================
// Facebook Page — posts no feed
// =====================================================================
async function postToFacebookPage({ message, link, imageUrl }) {
  const pageId = process.env.META_PAGE_ID;
  const pageToken = process.env.META_PAGE_TOKEN;
  if (imageUrl) {
    // Post de foto
    return graphApi(`/${pageId}/photos`, {
      method: 'POST',
      token: pageToken,
      params: { url: imageUrl, caption: message || '' },
    });
  }
  // Post de texto/link
  return graphApi(`/${pageId}/feed`, {
    method: 'POST',
    token: pageToken,
    params: { message: message || '', ...(link ? { link } : {}) },
  });
}

// =====================================================================
// Instagram Business — publicar foto
// =====================================================================
async function postToInstagram({ imageUrl, caption }) {
  const igId = process.env.META_INSTAGRAM_ID;
  const pageToken = process.env.META_PAGE_TOKEN;
  if (!imageUrl) throw new Error('imageUrl é obrigatório no Instagram');

  // Step 1: cria container
  const container = await graphApi(`/${igId}/media`, {
    method: 'POST',
    token: pageToken,
    params: { image_url: imageUrl, caption: caption || '' },
  });
  // Step 2: publica
  return graphApi(`/${igId}/media_publish`, {
    method: 'POST',
    token: pageToken,
    params: { creation_id: container.id },
  });
}

// =====================================================================
// WhatsApp Business — manda mensagem
// =====================================================================
async function sendWhatsAppMessage({ phoneNumberId, to, text, template, components }) {
  // Precisa ter um phone_number_id da WBA. Pega via listWhatsAppPhones.
  const pageToken = process.env.META_WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_PAGE_TOKEN;
  const senderPhoneNumberId = phoneNumberId || process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.META_WHATSAPP_PHONE_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!pageToken) throw new Error('META_WHATSAPP_ACCESS_TOKEN nao configurado');
  if (!senderPhoneNumberId) throw new Error('META_WHATSAPP_PHONE_NUMBER_ID nao configurado');
  const body = template
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: template, language: { code: 'pt_BR' }, components: components || [] },
      }
    : {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      };
  const res = await fetch(`${GRAPH}/${senderPhoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${pageToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`[WhatsApp ${res.status}] ${data.error?.message || JSON.stringify(data).slice(0,200)}`);
  }
  return data;
}

async function listWhatsAppPhones() {
  const wba = process.env.META_WHATSAPP_BUSINESS_ID || process.env.WHATSAPP_BUSINESS_ID;
  return graphApi(`/${wba}/phone_numbers`);
}

// =====================================================================
// Catálogo (Commerce / Catalog) — Facebook e Instagram Shop
// =====================================================================
async function listCatalogs() {
  const bm = process.env.META_BUSINESS_ID;
  return graphApi(`/${bm}/owned_product_catalogs`);
}

async function addProductToCatalog(catalogId, product) {
  return graphApi(`/${catalogId}/products`, {
    method: 'POST',
    params: product,
  });
}

// =====================================================================
// Ads — Meta Ads Manager
// =====================================================================
async function listAdAccounts() {
  return graphApi('/me/adaccounts', { params: { fields: 'name,account_id,currency,timezone_name,balance' } });
}

async function listCampaigns(adAccountId) {
  const id = adAccountId || process.env.META_AD_ACCOUNT_ID;
  return graphApi(`/${id}/campaigns`, { params: { fields: 'name,status,objective,daily_budget,created_time' } });
}

// =====================================================================
// Diagnóstico
// =====================================================================
async function diagnose() {
  const out = { configured: isConfigured(), checks: {} };
  if (!out.configured) return out;
  try { out.checks.user = await graphApi('/me'); } catch (e) { out.checks.user = { error: e.message }; }
  try { out.checks.page = await graphApi(`/${process.env.META_PAGE_ID}`, { params: { fields: 'name,fan_count,followers_count' } }); } catch (e) { out.checks.page = { error: e.message }; }
  try { out.checks.instagram = await graphApi(`/${process.env.META_INSTAGRAM_ID}`, { params: { fields: 'username,followers_count,media_count' } }); } catch (e) { out.checks.instagram = { error: e.message }; }
  try { out.checks.whatsapp = await listWhatsAppPhones(); } catch (e) { out.checks.whatsapp = { error: e.message }; }
  try { out.checks.adAccounts = await listAdAccounts(); } catch (e) { out.checks.adAccounts = { error: e.message }; }
  return out;
}

module.exports = {
  isConfigured,
  graphApi,
  postToFacebookPage,
  postToInstagram,
  sendWhatsAppMessage,
  listWhatsAppPhones,
  listCatalogs,
  addProductToCatalog,
  listAdAccounts,
  listCampaigns,
  diagnose,
};
