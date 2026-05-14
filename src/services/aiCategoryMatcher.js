// =====================================================================
// AI Category Matcher — classifica produto local na árvore Nuvemshop
// =====================================================================
// Usa Claude pra mapear cada Product TenisCash em:
//   - 1 a 3 IDs de categorias da Nuvemshop (gênero + família + modelo)
//   - Tags adicionais
//   - Gênero (Feminino/Masculino/Menina/Menino/Unissex)
//   - Subcategoria comercial sugerida
// Salva o resultado no Product.aiContext (JSON) pra evitar re-classificar.
// =====================================================================

const { prisma } = require('../middleware');
const { callAI } = require('../ai/ai-client');

const SYSTEM_PROMPT = `Você ajuda a classificar produtos esportivos no catálogo Nuvemshop da loja Sports & Tennis.

Receba um PRODUTO e a ÁRVORE DE CATEGORIAS disponível, e retorne:
1. Os IDs das categorias mais apropriadas (até 3)
2. O gênero do público-alvo
3. Tags úteis para busca

Regras:
- Tente sempre mapear: GÊNERO (Feminino/Masculino/Menina/Menino) + FAMÍLIA (Corrida/Performance/Casual/Lifestyle/etc.) + MARCA-MODELO se o produto tiver um modelo específico no nome (ex.: "Nike Air Zoom Pegasus" → mapear categoria "Nike Air Zoom Pegasus" se existir)
- Se gênero não estiver claro no nome, deixe "Unissex"
- Categorias só com IDs que EXISTEM na lista fornecida
- Use bom senso esportivo: tênis com palavra "Pegasus" e marca Nike → Nike Air Zoom Pegasus
- Tênis com palavra "Cumulus" → Asics Cumulus (se categoria existir) ou família corrida
- Beach Tennis, Padel → tags
- Sandália / chinelo / casual → família Casual
- Vestuário esportivo → cuidado com gênero
- Acessórios (meia, mochila, garrafa) → tags só

Retorne SOMENTE JSON neste formato:
{
  "categoryIds": [123, 456],
  "gender": "Feminino|Masculino|Menina|Menino|Unissex",
  "tags": ["corrida", "nike", "performance"],
  "reasoning": "1 frase curta explicando a escolha"
}`;

function buildCategoryTreeText(categories) {
  // Apresenta árvore: id + nome + parent (se houver)
  return categories
    .map((c) => `id=${c.id} nome="${c.name}"${c.parentId ? ` (parent=${c.parentId})` : ''}`)
    .join('\n');
}

async function classifyProduct(product, nsCategories) {
  if (!nsCategories.length) return { categoryIds: [], gender: null, tags: [] };

  const userPrompt = [
    '# Árvore de categorias disponíveis na Nuvemshop',
    buildCategoryTreeText(nsCategories),
    '',
    '# Produto a classificar',
    `- Nome: ${product.name}`,
    `- Marca: ${product.brand || ''}`,
    `- Categoria interna TenisCash: ${product.category || ''}`,
    `- Subcategoria interna: ${product.subcategory || ''}`,
    `- Descrição: ${(product.shortDescription || product.longDescription || '').slice(0, 300)}`,
    '',
    'Retorne SOMENTE o JSON pedido.',
  ].join('\n');

  const result = await callAI({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    jsonMode: true,
    maxTokens: 400,
  });

  if (!result.ok || !result.json) {
    return { categoryIds: [], gender: null, tags: [], _error: result.error || 'IA falhou' };
  }

  const json = result.json;
  // Valida IDs
  const validIds = new Set(nsCategories.map((c) => String(c.id)));
  const categoryIds = (Array.isArray(json.categoryIds) ? json.categoryIds : [])
    .map((id) => String(id))
    .filter((id) => validIds.has(id))
    .map((id) => parseInt(id, 10));

  return {
    categoryIds,
    gender: json.gender || null,
    tags: Array.isArray(json.tags) ? json.tags.slice(0, 8) : [],
    reasoning: json.reasoning || '',
    cost: result.cost?.brl || 0,
  };
}

async function getOrComputeMapping(product, nsCategories, opts = {}) {
  // Verifica se já tem aiContext.nuvemshopMapping
  const aiCtx = (() => {
    try {
      if (!product.aiContext) return null;
      return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext;
    } catch (_) { return null; }
  })();

  if (aiCtx && aiCtx.nuvemshopMapping && !opts.force) {
    return aiCtx.nuvemshopMapping;
  }

  const classification = await classifyProduct(product, nsCategories);

  // Salva no aiContext
  const newAiCtx = aiCtx || {};
  newAiCtx.nuvemshopMapping = classification;
  newAiCtx.nuvemshopMappingAt = new Date().toISOString();
  await prisma.product.update({
    where: { id: product.id },
    data: { aiContext: newAiCtx },
  });

  return classification;
}

/**
 * enrichProductsForNuvemshop — roda classificação em batch.
 * @param {Array} nsCategories - lista [{id, name, parentId}]
 * @param {Object} opts - { limit, force, delayMs }
 */
async function enrichProductsForNuvemshop(nsCategories, opts = {}) {
  const limit = opts.limit || 1000;
  const force = !!opts.force;
  const delayMs = opts.delayMs ?? 600;

  const products = await prisma.product.findMany({
    where: { active: true },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });

  let processed = 0;
  let withCategory = 0;
  let totalCost = 0;
  const errors = [];

  for (const p of products) {
    try {
      const mapping = await getOrComputeMapping(p, nsCategories, { force });
      if (mapping.categoryIds?.length) withCategory++;
      totalCost += mapping.cost || 0;
      processed++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    } catch (err) {
      errors.push({ sku: p.sku, error: err.message });
    }
  }

  return { total: products.length, processed, withCategory, totalCostBRL: totalCost, errors: errors.slice(0, 20) };
}

module.exports = {
  classifyProduct,
  getOrComputeMapping,
  enrichProductsForNuvemshop,
};
