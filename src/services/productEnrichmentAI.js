// =====================================================================
// Product Enrichment AI — extrai estrutura do nome cru da NF-e
// =====================================================================
// Recebe nome cru ("TENIS CT00010001 CHUCK TAYLOR ALL STAR BRANCO/BRANCO/MARINHO 34")
// e devolve estrutura limpa: marca, modelo, cor, tamanho, gênero, categoria.

const { callAI } = require('../ai/ai-client');

const SYSTEM_PROMPT = `Você ajuda a estruturar produtos esportivos a partir de descrições cruas de NF-e fiscal.

Receba um nome bruto (geralmente UPPERCASE, abreviado) e o nome do fornecedor, e devolva os campos estruturados.

REGRAS:
- "TENIS NIKE PEGASUS 40 MASC PRETO" → marca=Nike, modelo="Air Zoom Pegasus", cor=Preto, tamanho=40, gênero=Masculino
- Se o fornecedor é COOPERSHOES, marca SEMPRE é "Converse" (eles fabricam Converse no Brasil)
- Se vier sigla MASC/M/MASCULINO, gênero=Masculino. FEM/F/FEMININO=Feminino. UNISEX=Unissex.
- Tamanhos: 28-48 (calçado), PP/P/M/G/GG/XG (vestuário), número pequeno (acessório)
- Cor: pode vir "BRANCO/BRANCO/MARINHO" (várias cores) — retorna a primeira ou junta com hífen
- Modelo: a coisa mais reconhecível. "CHUCK TAYLOR ALL STAR" → modelo="Chuck Taylor All Star"
- Categoria: tenis | vestuario | acessorio | meia | chuteira | sandalia | mochila | bone
- Subcategoria: corrida | casual | lifestyle | futebol | basquete | beach_tennis | fitness | infantil
- Esporte: corrida | beach_tennis | futebol | basquete | casual | musculacao | fitness | tenis

RETORNE SOMENTE JSON:
{
  "brand": "...",
  "model": "...",
  "color": "...",
  "size": "...",
  "gender": "Masculino|Feminino|Unissex|Menino|Menina|null",
  "category": "tenis|vestuario|acessorio|...",
  "subcategory": "corrida|casual|...",
  "sport": "corrida|...",
  "cleanName": "Nome formatado: 'Tênis Converse Chuck Taylor All Star Branco/Marinho'",
  "baseProductKey": "id base SEM tamanho — ex: 'converse-chuck-taylor-all-star-branco-marinho'"
}`;

async function extractFromName(rawName, supplierName = '') {
  const userPrompt = `Fornecedor: ${supplierName || 'desconhecido'}
Nome bruto: ${rawName}

Retorne SOMENTE o JSON pedido.`;

  const result = await callAI({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    jsonMode: true,
    maxTokens: 400,
  });

  if (!result.ok || !result.json) {
    return { ok: false, error: result.error || 'IA falhou', cost: 0 };
  }
  return { ok: true, data: result.json, cost: result.cost?.brl || 0 };
}

/**
 * groupVariantsByBase — agrupa itens da NF-e que pertencem ao mesmo produto.
 * Estratégia simples: usa baseProductKey gerado pela IA OU prefixo do nome até "tamanho".
 *
 * @param {Array} enrichedItems - itens já enriquecidos (com data da IA)
 * @returns {Array} - lista de grupos [{ base: {brand,model,color,...}, variants: [{size,sku,ean,cost,qty}] }]
 */
function groupVariantsByBase(enrichedItems) {
  const groups = new Map();
  for (const item of enrichedItems) {
    const key = item.data?.baseProductKey || `${item.data?.brand || ''}-${item.data?.model || ''}-${item.data?.color || ''}`.toLowerCase().replace(/\s+/g, '-');
    if (!groups.has(key)) {
      groups.set(key, {
        baseKey: key,
        brand: item.data?.brand || '',
        model: item.data?.model || '',
        color: item.data?.color || '',
        gender: item.data?.gender || null,
        category: item.data?.category || '',
        subcategory: item.data?.subcategory || '',
        sport: item.data?.sport || '',
        cleanName: item.data?.cleanName || '',
        variants: [],
      });
    }
    groups.get(key).variants.push({
      size: item.data?.size || item.rawSize || '',
      sku: item.sku,
      ean: item.ean || null,
      cost: item.cost,
      qty: item.qty,
      rawName: item.rawName,
    });
  }
  return Array.from(groups.values());
}

module.exports = { extractFromName, groupVariantsByBase };
