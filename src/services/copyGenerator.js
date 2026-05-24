// =====================================================================
// Copy Generator — usa Claude pra gerar legendas (IG, TikTok, WhatsApp)
// =====================================================================
// Já temos @anthropic-ai/sdk instalado. Usa modelo Haiku (rápido + barato)
// pra gerar 3 variações de copy por produto.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY não configurada');
  }
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

/**
 * Gera copies pra IG, TikTok, WhatsApp.
 * @param {object} opts { productName, brand, category, price, shortDesc, sceneHint }
 * @returns {Promise<{captionIg, captionTiktok, captionWa, hashtags}>}
 */
async function generateCopies({ productName, brand, category, price, shortDesc = '', sceneHint = '' }) {
  const anthropic = getAnthropic();

  const priceStr = price ? `R$ ${Number(price).toFixed(2)}` : null;
  const productInfo = [
    `Produto: ${productName}`,
    brand ? `Marca: ${brand}` : null,
    category ? `Categoria: ${category}` : null,
    priceStr ? `Preço: ${priceStr}` : null,
    shortDesc ? `Sobre: ${shortDesc}` : null,
    sceneHint ? `Estilo da foto: ${sceneHint}` : null,
  ].filter(Boolean).join('\n');

  const systemPrompt = `Você é copywriter da Sports & Tennis (rede de lojas esportivas em João Pessoa/PB).
Tom: direto, esportivo, brasileiro, sem cringe. NUNCA usar "Adquira já", "Confira", "Aproveite essa oportunidade".
Usar gírias do meio: "tá no estoque", "saiu da caixa", "ace", "raquete brasileira", "calçado pra real".
Foco: levar o cliente pra loja física (Bessa, Tambaú, Rainha da Borborema, Tambiá) OU pro nosso e-commerce.
Sempre que mencionar cashback, chama de "TenisCash" (nome do programa).`;

  const userPrompt = `Gere copies pra este produto:

${productInfo}

Retorne JSON estrito com 4 campos:
{
  "captionIg":     "legenda Instagram, MAX 150 caracteres, sem hashtags inline (vão separadas), gancho forte na primeira linha, 1 emoji no máximo",
  "captionTiktok": "legenda TikTok, MAX 120 caracteres, gancho irresistível nos primeiros 3 segundos do vídeo, CTA no fim",
  "captionWa":     "texto WhatsApp Broadcast, direto e curto, MAX 200 caracteres, com 1-2 emojis, terminando com 'pede aqui' ou similar",
  "hashtags":      "5 hashtags relevantes separadas por espaço, sem #, exemplo: tenis corrida fitness brasilia gym"
}

Sem comentários, só JSON puro.`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = message.content?.[0]?.text || '{}';
  // Tenta extrair JSON (caso venha com ```json … ```)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Copy generator não retornou JSON válido');

  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); }
  catch (e) { throw new Error('JSON inválido do Claude: ' + e.message); }

  return {
    captionIg: parsed.captionIg || '',
    captionTiktok: parsed.captionTiktok || '',
    captionWa: parsed.captionWa || '',
    hashtags: parsed.hashtags || '',
  };
}

module.exports = { generateCopies };
