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
 * Constrói system prompt dinâmico baseado no BrandProfile (se houver).
 * Fallback: tom Sports & Tennis (default histórico).
 */
function buildSystemPrompt(brandProfile) {
  // Fallback Sports & Tennis (quando não recebe brandProfile)
  if (!brandProfile) {
    return `Você é copywriter da Sports & Tennis (rede de lojas esportivas em João Pessoa/PB).
Tom: direto, esportivo, brasileiro, sem cringe. NUNCA usar "Adquira já", "Confira", "Aproveite essa oportunidade".
Usar gírias do meio: "tá no estoque", "saiu da caixa", "ace", "raquete brasileira", "calçado pra real".
Foco: levar o cliente pra loja física (Bessa, Tambaú, Rainha da Borborema, Tambiá) OU pro nosso e-commerce.
Sempre que mencionar cashback, chama de "TenisCash" (nome do programa).`;
  }

  // Construção dinâmica baseada no BrandProfile
  const lines = [`Você é copywriter da ${brandProfile.displayName}.`];

  if (brandProfile.description) lines.push(`Sobre a marca: ${brandProfile.description}`);
  if (brandProfile.mission)     lines.push(`Propósito: ${brandProfile.mission}`);
  if (brandProfile.audience)    lines.push(`Persona-alvo: ${brandProfile.audience}`);

  // Tom de voz (voiceTone é Json com escalas 0-10)
  if (brandProfile.voiceTone && typeof brandProfile.voiceTone === 'object') {
    const v = brandProfile.voiceTone;
    const tomBits = [];
    if (v.formal != null)   tomBits.push(v.formal > 6 ? 'formal/profissional' : v.formal < 4 ? 'casual/intimo' : 'meio termo formal/casual');
    if (v.energy != null)   tomBits.push(v.energy > 6 ? 'energetico' : v.energy < 4 ? 'calmo' : 'energia moderada');
    if (v.technical != null) tomBits.push(v.technical > 6 ? 'tecnico/especifico' : v.technical < 4 ? 'simples/acessivel' : '');
    if (v.humor != null)    tomBits.push(v.humor > 6 ? 'com humor' : '');
    const tomStr = tomBits.filter(Boolean).join(', ');
    if (tomStr) lines.push(`Tom de voz: ${tomStr}.`);
  }

  // Tabu
  if (Array.isArray(brandProfile.taboo) && brandProfile.taboo.length) {
    lines.push(`NUNCA usar/falar: ${brandProfile.taboo.join(', ')}.`);
  }

  // CTAs preferenciais
  if (Array.isArray(brandProfile.ctaTemplates) && brandProfile.ctaTemplates.length) {
    lines.push(`CTAs preferenciais (use um deles ou variação): ${brandProfile.ctaTemplates.slice(0, 4).join(' | ')}.`);
  }

  // Exemplo de copy bem-sucedida pra IA imitar tom
  if (brandProfile.exampleCopy) {
    lines.push(`Exemplo de tom da marca (imite o estilo, NÃO copie literal):\n"""${brandProfile.exampleCopy.slice(0, 400)}"""`);
  }

  // Handle pro fim das captions
  if (brandProfile.instagramHandle) {
    lines.push(`Quando assinar, use: ${brandProfile.instagramHandle}.`);
  }

  // PROTEÇÃO: nunca misturar marcas
  lines.push(`IMPORTANTE: você é EXCLUSIVAMENTE copywriter da ${brandProfile.displayName}. NÃO mencione Sports & Tennis, TenisCash, lojas físicas Bessa/Tambaú/Rainha/Tambiá, OU qualquer outra marca/projeto a menos que a marca em questão seja a propria Sports & Tennis.`);

  return lines.join('\n');
}

/**
 * Gera copies pra IG, TikTok, WhatsApp.
 * @param {object} opts { productName, brand, category, price, shortDesc, sceneHint, brandProfile? }
 *   brandProfile: objeto BrandProfile completo (carregado pelo caller via brandProfiles.getBySlug)
 * @returns {Promise<{captionIg, captionTiktok, captionWa, hashtags}>}
 */
async function generateCopies({ productName, brand, category, price, shortDesc = '', sceneHint = '', brandProfile = null }) {
  const anthropic = getAnthropic();

  const priceStr = price ? `R$ ${Number(price).toFixed(2)}` : null;
  const productInfo = [
    `Produto: ${productName}`,
    brand ? `Marca/produto-marca: ${brand}` : null,
    category ? `Categoria: ${category}` : null,
    priceStr ? `Preço: ${priceStr}` : null,
    shortDesc ? `Sobre: ${shortDesc}` : null,
    sceneHint ? `Estilo da foto: ${sceneHint}` : null,
  ].filter(Boolean).join('\n');

  const systemPrompt = buildSystemPrompt(brandProfile);

  const userPrompt = `Gere copies pra este produto:

${productInfo}

Retorne JSON estrito com 4 campos:
{
  "captionIg":     "legenda Instagram, MAX 150 caracteres, sem hashtags inline (vão separadas), gancho forte na primeira linha, 1 emoji no máximo",
  "captionTiktok": "legenda TikTok, MAX 120 caracteres, gancho irresistível nos primeiros 3 segundos do vídeo, CTA no fim",
  "captionWa":     "texto WhatsApp Broadcast, direto e curto, MAX 200 caracteres, com 1-2 emojis, terminando com CTA da marca",
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
