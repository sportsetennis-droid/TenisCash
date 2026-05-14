// =====================================================================
// Serper.dev — Web Search (Google organic results via API)
// Usado quando precisamos achar a URL de uma página, não imagens.
// =====================================================================

const API_KEY = process.env.SERPER_API_KEY;
const ENDPOINT = 'https://google.serper.dev/search';

function isConfigured() {
  return !!API_KEY;
}

async function searchWeb(query, opts = {}) {
  if (!isConfigured()) {
    return { ok: false, results: [], error: 'SERPER_API_KEY não configurada' };
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        gl: 'br',
        hl: 'pt-br',
        num: Math.min(Math.max(opts.count || 10, 1), 100),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, results: [], error: `[Serper ${res.status}] ${data.message || JSON.stringify(data).slice(0, 200)}` };
    }
    const results = (data.organic || []).map((r) => ({
      url: r.link,
      title: r.title,
      snippet: r.snippet,
    }));
    return { ok: true, results, query };
  } catch (err) {
    return { ok: false, results: [], error: err.message };
  }
}

module.exports = { isConfigured, searchWeb };
