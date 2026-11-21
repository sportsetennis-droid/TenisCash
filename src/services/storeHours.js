// Horário de abertura de cada loja (dono 21/11/2026): "as únicas lojas que abrem de 9 horas
// é do Manaíra e Tambiá. Paraíba Mall abre de 10, Pirâmide abre de 10 ... Campina, 14h40."
// Toda mensagem ao vendedor (agenda do grupo, aviso antes do expediente, agente do WhatsApp,
// checklist do dia) usa esta tabela: escala que começa antes da loja abrir mostra a abertura.
// Não muda a escala gravada nem a folha. Loja sem horário aqui (Baratão, Fábrica) fica como está.
// Mudar sem deploy: STORE_OPENING_JSON='{"LOJA03":"14:40"}' no Railway (vence esta tabela).

const OPENING = {
  LOJA07: '09:00', // Manaíra
  LOJA06: '09:00', // Tambiá
  LOJA02: '10:00', // Bessa — Parahyba Mall
  LOJA05: '10:00', // Pirâmide
  LOJA03: '14:40', // Campina (Rainha da Borborema)
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function table() {
  let extra = {};
  try { extra = JSON.parse(process.env.STORE_OPENING_JSON || '{}') || {}; } catch (_) { extra = {}; }
  const out = { ...OPENING };
  for (const [code, t] of Object.entries(extra)) if (TIME_RE.test(String(t))) out[String(code).toUpperCase()] = String(t);
  return out;
}

function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

// Aceita o código (LOJA06), o objeto loja ({ code, name }) ou só o nome ("Loja 06 - Tambiá").
function codeOf(store) {
  if (!store) return null;
  if (typeof store === 'string') {
    if (/^loja\d{2}$/i.test(store.trim())) return store.trim().toUpperCase();
    const m = /loja\s*0?(\d{1,2})/i.exec(store);
    if (m) return 'LOJA' + m[1].padStart(2, '0');
    const n = norm(store);
    if (n.includes('manaira')) return 'LOJA07';
    if (n.includes('tambia')) return 'LOJA06';
    if (n.includes('piramide')) return 'LOJA05';
    if (n.includes('bessa') || n.includes('parahyba') || n.includes('paraiba mall')) return 'LOJA02';
    if (n.includes('campina') || n.includes('borborema')) return 'LOJA03';
    return null;
  }
  return codeOf(store.code) || codeOf(store.name);
}

function openingFor(store) {
  const code = codeOf(store);
  return code ? (table()[code] || null) : null;
}

// Início mostrado ao vendedor: nunca antes da loja abrir.
function clampStart(store, start) {
  const open = openingFor(store);
  if (!open) return start || null;
  if (!start || !TIME_RE.test(String(start).slice(0, 5))) return start || null;
  return String(start).slice(0, 5) < open ? open : start;
}

// Mesmo ajuste a partir do id da loja (checklist do dia guarda só o id).
const idCache = { at: 0, map: new Map() };
async function clampStartByStoreId(prisma, storeId, start) {
  if (!storeId || !start) return start || null;
  if (Date.now() - idCache.at > 10 * 60 * 1000) {
    const rows = await prisma.store.findMany({ select: { id: true, code: true, name: true } }).catch(() => null);
    if (rows) { idCache.map = new Map(rows.map((r) => [r.id, r])); idCache.at = Date.now(); }
  }
  return clampStart(idCache.map.get(storeId) || null, start);
}

module.exports = { OPENING, openingFor, clampStart, clampStartByStoreId, codeOf };
