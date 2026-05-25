// =====================================================================
// Construção de prompts pra geração de imagem (Flux + GPT + Composite)
// =====================================================================
// Centraliza lógica de prompt. Agora lê os defaults editáveis do
// marketingConfig (banco), com fallback pra defaults hardcoded lá.
//
// API é async porque agora bate em config DB (com cache 60s).
// =====================================================================

const cfg = require('./marketingConfig');

/**
 * Escolhe a cena base — primeiro tenta marca, depois modalidade, depois fallback.
 * @param {object} product - { brand, name, category, aiContext? }
 * @returns {Promise<string>} cenário (em inglês)
 */
async function pickSceneAuto(product) {
  const [brandScenes, modalityScenes] = await Promise.all([
    cfg.getBrandScenes(),
    cfg.getModalityScenes(),
  ]);

  const brand = String(product?.brand || '').toLowerCase().trim();
  const name = String(product?.name || '').toLowerCase();
  const category = String(product?.category || '').toLowerCase();
  const aiClass = product?.aiContext?.classification || {};
  const modality = String(aiClass.modality || '').toLowerCase();

  // 1. Marca tem prioridade
  if (brand && brandScenes[brand]) return brandScenes[brand];

  // 2. Modalidade estruturada
  if (modality && modalityScenes[modality]) return modalityScenes[modality];

  // 3. Palavra-chave no nome ou categoria
  for (const key of Object.keys(modalityScenes)) {
    if (name.includes(key) || category.includes(key)) return modalityScenes[key];
  }

  // 4. Heurística feminina
  if (name.match(/feminin|woman|moda/) || aiClass.gender === 'F') {
    return 'modern minimalist studio with soft pastel background, feminine athletic elegance';
  }

  // 5. Default
  return brandScenes._default || 'modern Brazilian sports lifestyle scene, urban Northeast environment';
}

/**
 * Constrói o prompt completo pra Flux/GPT.
 * Usa template editável (marketing_provider_prompts.editorial_base).
 *
 * @param {object} product - objeto Product do Prisma
 * @param {string} sceneHint - cenário custom (vazio = automático)
 * @param {object} opts - { aspectRatio?: '16:9'|'9:16'|'1:1'|'4:5' }
 * @returns {Promise<string>} prompt em inglês
 */
async function buildEditorialPrompt(product, sceneHint = '', opts = {}) {
  const [prompts, personaBr, brandVoice] = await Promise.all([
    cfg.getProviderPrompts(),
    cfg.getPersonaBr(),
    cfg.getBrandVoice(),
  ]);

  const name = product?.name || 'product';
  const brand = product?.brand || '';
  const category = product?.category || '';
  const subcategory = product?.subcategory || '';
  const shortDesc = product?.shortDescription || '';
  const aiClass = product?.aiContext?.classification || {};
  const tier = aiClass.tier;
  const gender = aiClass.gender;

  const scene = (sceneHint && sceneHint.trim()) || await pickSceneAuto(product);
  const aspect = opts.aspectRatio || '16:9';

  // Features factuais
  const facts = [];
  if (tier === 'premium') facts.push('premium positioning');
  else if (tier === 'value') facts.push('accessible value tier');
  if (gender === 'F') facts.push('targeted to women');
  else if (gender === 'M') facts.push('targeted to men');
  if (subcategory) facts.push(subcategory.toLowerCase());
  if (shortDesc && shortDesc.length < 200) facts.push(shortDesc.toLowerCase().slice(0, 200));
  const factsLine = facts.length ? `Product context: ${facts.join('; ')}.` : '';

  const aspectUse = aspect === '9:16' ? 'Instagram Reels/Stories'
                   : aspect === '1:1' ? 'Instagram feed'
                   : aspect === '4:5' ? 'Instagram portrait feed'
                   : 'wide editorial landscape';

  // Aplica template editável (substitui placeholders)
  const template = prompts.editorial_base || cfg.DEFAULT_PROVIDER_PROMPTS.editorial_base;
  return template
    .replace(/\{PRODUCT_NAME\}/g, name)
    .replace(/\{BRAND\}/g, brand)
    .replace(/\{CATEGORY\}/g, category)
    .replace(/\{SCENE\}/g, scene)
    .replace(/\{FACTS\}/g, factsLine)
    .replace(/\{BRAND_VOICE\}/g, brandVoice)
    .replace(/\{PERSONA_BR\}/g, personaBr)
    .replace(/\{ASPECT\}/g, aspect)
    .replace(/\{ASPECT_USE\}/g, aspectUse);
}

/**
 * Constrói prompt SÓ pra background (composite).
 * - Quando há produto (imageUrl) → modo "leave space for product overlay" (sem produto/pessoa)
 * - Quando NÃO há produto (modo conceito) → cena completa e livre (com pessoa OK)
 */
async function buildBackgroundPrompt(product, sceneHint = '') {
  const prompts = await cfg.getProviderPrompts();
  const scene = (sceneHint && sceneHint.trim()) || await pickSceneAuto(product);
  const hasProduct = !!(product?.imageUrl);

  if (hasProduct) {
    const template = prompts.composite_bg || cfg.DEFAULT_PROVIDER_PROMPTS.composite_bg;
    return template.replace(/\{SCENE\}/g, scene);
  }

  // MODO CONCEITO PURO: a cena descrita pelo user é o conteúdo total
  // (pode ter pessoa, objetos, texto sutil, qualquer coisa).
  // Persona BR é injetada pra evitar modelos genéricos europeus.
  const personaBr = await cfg.getPersonaBr();
  return [
    'Editorial photography for Brazilian social media post (Instagram feed format).',
    'Scene: ' + scene + '.',
    'Hyperrealistic, magazine quality, dramatic professional lighting, shallow depth of field.',
    personaBr,
    'CRITICAL COMPOSITION RULES:',
    '— The subject (person/object) MUST be positioned in the LOWER HALF of the frame, ideally from 45% to 90% vertical position.',
    '— The TOP 30% of the frame MUST be empty/clean (sky, blurred wall, plain background) for headline text overlay.',
    '— The BOTTOM 10% MUST also be uncluttered for logo and handle overlay.',
    '— If a person is the subject, frame from chest/waist down OR show them seated/leaning so their head sits around 30-40% from top, NOT at the very top.',
    'No fake brand logos, no random text written on the image.',
  ].join(' ');
}

/**
 * Extrai array de URLs de fotos do produto.
 */
function getReferenceImages(product, maxImages = 3) {
  const urls = [];
  if (product?.imageUrl) urls.push(product.imageUrl);
  if (Array.isArray(product?.imageUrls)) {
    for (const u of product.imageUrls) {
      if (u && !urls.includes(u)) urls.push(u);
      if (urls.length >= maxImages) break;
    }
  }
  return urls.slice(0, maxImages);
}

module.exports = {
  buildEditorialPrompt,
  buildBackgroundPrompt,
  pickSceneAuto,
  getReferenceImages,
};
