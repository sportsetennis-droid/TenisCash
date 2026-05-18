// =====================================================================
// NFe Size Parser — heurística zero-custo pra extrair tamanho do nome bruto
// =====================================================================
// Usado por: src/routes/xmlImport.js (rota /apply) e scripts de unificação.
//
// Estratégia: regex no FINAL do xProd. Padrões mais comuns:
//   "TENIS X COR Y 38"           → base="TENIS X COR Y", size="38"
//   "TENIS X COR Y TAM 38"       → base="TENIS X COR Y", size="38"
//   "TENIS X COR Y T 38"         → base="TENIS X COR Y", size="38"
//   "TENIS X COR Y T-38"         → base="TENIS X COR Y", size="38"
//   "TENIS X COR Y N 38"         → base="TENIS X COR Y", size="38"
//   "TENIS X COR Y P"            → base="TENIS X COR Y", size="P"  (vestuário)
//   "TENIS X COR Y - GG"         → base="TENIS X COR Y", size="GG"
//   "TENIS X COR Y 36/37"        → base="TENIS X COR Y", size="36/37"
//   "TENIS X COR Y BRANCO/40"    → base="TENIS X COR Y BRANCO", size="40"
//
// Não devolve nada se o nome não tem padrão claro de tamanho — assim
// produtos sem variante (mochila, bola etc.) viram 1 produto sem agrupamento.
// =====================================================================

// Tamanhos válidos de calçado/vestuário/infantil
const NUMERIC_SIZE_RE = /^(\d{1,2})(?:[\/\-](\d{1,2}))?$/; // 38 ou 36/37 ou 36-37
const LETTER_SIZE_RE = /^(PP|P|M|G|GG|XG|XGG|XXG|XS|S|L|XL|XXL|XXXL|EG)$/i;

function isValidSize(s) {
  if (!s) return false;
  const t = String(s).trim().toUpperCase();
  if (LETTER_SIZE_RE.test(t)) return true;
  const m = t.match(NUMERIC_SIZE_RE);
  if (!m) return false;
  const n = parseInt(m[1], 10);
  // Faixas razoáveis: calçado 14-50, vestuário usaria letra
  return n >= 14 && n <= 50;
}

/**
 * extractBaseAndSize — separa nome base e tamanho do final.
 * @param {string} rawName - descrição crua da NFe (xProd)
 * @returns {{ baseName: string, size: string, baseKey: string }}
 */
function extractBaseAndSize(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return { baseName: '', size: '', baseKey: '' };

  // Tenta separadores: " TAM ", " T ", " N ", " 38/39 ", " 38 ", " - 38 "
  // Ordem importa: explícitos primeiro, depois espaço (cobre "36/37" sem ser quebrado por "/").
  const patterns = [
    // "...TAM 38" ou "...TAM. 38" ou "...TAMANHO 38"
    /^(.+?)\s+TAM(?:ANHO|\.)?\s*[:\-]?\s*([A-Z0-9\/\-]{1,6})\s*$/i,
    // "...T 38" ou "...T-38" ou "...T:38"
    /^(.+?)\s+T[:\-\s]+([A-Z0-9\/\-]{1,6})\s*$/i,
    // "...N 38" ou "...N-38" ou "...N. 38" (numeração)
    /^(.+?)\s+N[º°:\-\s\.]+([A-Z0-9\/\-]{1,6})\s*$/i,
    // "... 38" ou "... 36/37" ou "... GG" (espaço simples) — token pode ter / interno
    /^(.+?)\s+([A-Z0-9]{1,3}(?:\/[A-Z0-9]{1,3})?)\s*$/i,
    // "... - 38" ou "...BRANCO/40" (sem espaço antes do separador, último recurso)
    /^(.+?)\s*[\-\/]\s*([A-Z0-9]{1,6})\s*$/i,
  ];

  for (const re of patterns) {
    const m = name.match(re);
    if (m) {
      const candidate = m[2].trim().toUpperCase();
      if (isValidSize(candidate)) {
        const baseName = m[1].trim().replace(/\s*[\-\/]\s*$/, '').trim();
        // Normaliza pra chave: lowercase, remove non-alphanum
        const baseKey = baseName
          .toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 80);
        return { baseName, size: candidate, baseKey };
      }
    }
  }

  // Sem tamanho detectado — produto sem variante
  const baseKey = name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return { baseName: name, size: '', baseKey };
}

/**
 * groupItemsByBase — agrupa itens fiscais por baseKey, somando quantidades por tamanho.
 * @param {Array<{description, ean, supplierCode, quantity, unitValue, ...}>} items
 * @returns {Array<{baseKey, baseName, items: [], variants: [{size, qty, ean, supplierCode, unitValue}]}>}
 */
function groupItemsByBase(items) {
  const groups = new Map();
  for (const it of items) {
    const { baseName, size, baseKey } = extractBaseAndSize(it.description);
    if (!groups.has(baseKey)) {
      groups.set(baseKey, {
        baseKey,
        baseName,
        items: [],
        variants: [],
      });
    }
    const g = groups.get(baseKey);
    g.items.push(it);
    g.variants.push({
      size,
      qty: Number(it.quantity) || 0,
      ean: it.ean || null,
      supplierCode: it.supplierCode || null,
      unitValue: Number(it.unitValue) || 0,
      itemId: it.id || null, // pra atualizar matchStatus depois
    });
  }
  return Array.from(groups.values());
}

module.exports = { extractBaseAndSize, groupItemsByBase, isValidSize };
