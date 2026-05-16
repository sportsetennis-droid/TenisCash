// =====================================================================
// Retail Orchestrator — backend service que recebe demandas do gestor,
// classifica e roteia pro agente especialista correto.
// =====================================================================
// Usa Claude (Anthropic) pra interpretar a demanda + Tool Use pra
// invocar agentes específicos com contexto enriquecido pelo banco.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { PrismaClient } = require('@prisma/client');
const prisma = global._prismaOrch || (global._prismaOrch = new PrismaClient());

const MODEL = process.env.AI_ORCHESTRATOR_MODEL || 'claude-sonnet-4-5-20251029';

function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

// Mapa CNPJ → nome curto pra usar em prompts
async function _contextSnapshot() {
  const [totalProducts, withImage, withDesc, suppliers, lastUpd] = await Promise.all([
    prisma.product.count({ where: { active: true } }),
    prisma.product.count({ where: { active: true, imageUrl: { not: null } } }),
    prisma.product.count({ where: { active: true, longDescription: { not: null } } }),
    prisma.supplier.findMany({ where: { active: true }, select: { cnpj: true, companyName: true, averageMarkup: true } }),
    prisma.product.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
  ]);
  const onNs = await prisma.nuvemshopProductMapping.count();
  return {
    catalog: totalProducts,
    withImage,
    withDescription: withDesc,
    onNuvemshop: onNs,
    suppliersCount: suppliers.length,
    suppliersWithMarkup: suppliers.filter((s) => s.averageMarkup != null).length,
    lastDbActivity: lastUpd?.updatedAt,
  };
}

const SYSTEM_PROMPT = `Você é o RETAIL ORCHESTRATOR da Central IA Sports & Tennis — rede de varejo esportivo (4 lojas + Nuvemshop) em Paraíba/PB.

Sua função: receber demandas do dono/gestor, classificar, planejar, e produzir um plano executável estruturado.

NUNCA atue como assistente genérico. Atue como SO operacional de varejo.

Roteador de decisão:
- Estoque, giro, ruptura, transferência → stock-agent
- Preço, margem, desconto, taxas → pricing-margin-agent
- Campanha, copy, brand, Instagram → marketing-agent
- WhatsApp, CRM, recuperação → crm-whatsapp-agent
- Nuvemshop, SEO, checkout → ecommerce-agent
- Rotina de loja, equipe → store-operations-agent
- Descrição de produto → product-content-agent
- Vitrine, exposição → visual-merchandising-agent
- Fornecedor, compra → buying-supplier-agent
- Caixa, DRE → finance-agent
- Contratos, CDC → legal-compliance-agent
- Comparações, A/B → benchmark-posthoc-agent
- Live commerce → live-commerce-agent
- Jornada cliente, NPS → customer-experience-agent
- Decisão estratégica → life-assessor-agent
- Revisão crítica de output → safety-agent (SEMPRE)

Output OBRIGATÓRIO em markdown:

## Diagnóstico
[classificação, urgência, contexto]

## Decisão
[decisão tomada pelo orquestrador]

## Plano de ação
[lista de passos numerados, com responsável por passo]

## Agentes acionados
[lista de agentes + tarefa específica de cada]

## Dados necessários
[o que falta saber pra executar — só liste se ESSENCIAL]

## Riscos / controles
[o que pode dar errado + como mitigar]

## Impacto esperado (KPI)
[métrica numérica concreta de sucesso]

## Próximos passos
[ações imediatas + ação 7d + ação 30d]

REGRAS:
- Resposta direta, sem enrolação. PT-BR informal.
- Distinguir FATO / SUPOSIÇÃO / DADO FALTANTE / AÇÃO RECOMENDADA
- Tabelas quando comparações fizerem sentido
- Nunca aprove ação que mexa em preço/cliente final/conta sem plano revisável
- Marque aprovações necessárias com "⚠️ APROVAÇÃO HUMANA"`;

/**
 * Recebe demanda do gestor e devolve plano operacional.
 * @param {string} demand - texto da demanda em PT-BR
 * @param {Object} [opts]
 * @param {boolean} [opts.includeContext=true] - injeta snapshot do banco no contexto
 */
async function orchestrate(demand, opts = {}) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  if (!demand || !demand.trim()) return { ok: false, error: 'demanda vazia' };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let userPrompt = `DEMANDA DO GESTOR:\n${demand.trim()}\n\n`;
  if (opts.includeContext !== false) {
    try {
      const ctx = await _contextSnapshot();
      userPrompt += `\nESTADO ATUAL DO CATÁLOGO:
- Catálogo total: ${ctx.catalog} produtos
- Com imagem: ${ctx.withImage} (${Math.round(ctx.withImage / ctx.catalog * 100)}%)
- Com descrição: ${ctx.withDescription}
- Na Nuvemshop: ${ctx.onNuvemshop}
- Fornecedores ativos: ${ctx.suppliersCount} (${ctx.suppliersWithMarkup} com markup definido)
- Última atividade no banco: ${ctx.lastDbActivity?.toISOString() || '?'}
`;
    } catch (_) { /* segue sem contexto */ }
  }
  userPrompt += '\nResponda no formato obrigatório do system prompt.';

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return {
      ok: true,
      plan: text,
      usage: resp.usage,
      cost: _estimateCost(resp.usage),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function _estimateCost(usage) {
  if (!usage) return { brl: 0 };
  // Sonnet 4.5: ~$3/M input, $15/M output
  const usd = (usage.input_tokens || 0) / 1e6 * 3 + (usage.output_tokens || 0) / 1e6 * 15;
  return { usd, brl: usd * 5.5 };
}

module.exports = { isConfigured, orchestrate };
