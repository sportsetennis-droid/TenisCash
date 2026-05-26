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
 * Helper: monta diretrizes sobre pessoa no prompt, baseado em opts.people.
 *
 * opts.people = {
 *   mode: 'auto' | 'none' | 'specific',
 *   gender: 'F' | 'M' | 'any',          // só usado quando mode='specific'
 *   age: 'child' | 'teen' | 'young' | 'adult' | 'senior',
 *   ethnicity?: 'mixed' | 'brown' | 'white' | 'black',  // opcional, default 'mixed'
 * }
 *
 * Retorna string vazia se mode='auto' (deixa IA decidir baseado na cena).
 */
function buildPeopleClause(people) {
  if (!people || people.mode === 'auto' || !people.mode) return '';

  if (people.mode === 'none') {
    return 'STRICT RULE: NO PEOPLE in the scene. Show only the product/object/environment. No human figures, no hands, no body parts, no silhouettes. Pure product or environmental photography.';
  }

  // mode === 'specific'
  const genderMap = { F: 'woman', M: 'man', any: 'person' };
  const ageMap = {
    child:  'child aged 6 to 10 years old',
    teen:   'teenager aged 14 to 18 years old',
    young:  'young adult aged 22 to 30 years old',
    adult:  'adult aged 35 to 45 years old',
    senior: 'senior aged 55 to 65 years old',
  };
  const ethnicityMap = {
    mixed: 'mixed-race Brazilian',
    brown: 'brown-skinned Brazilian (pele morena)',
    white: 'light-skinned Brazilian',
    black: 'black Brazilian',
  };
  const g = genderMap[people.gender] || 'person';
  const a = ageMap[people.age] || ageMap.young;
  const eth = ethnicityMap[people.ethnicity || 'mixed'];

  return `HUMAN SUBJECT REQUIRED: feature exactly ONE ${eth} ${g}, ${a}, as the main subject. Realistic Brazilian features (NOT a European/American stock model). Natural pose appropriate to the scene. Frame so the person's head sits around 30-40% from the top of the image, body extending downward.`;
}

/**
 * Constrói prompt SÓ pra background (composite).
 * - Quando há produto (imageUrl) → modo "leave space for product overlay" (sem produto/pessoa por default)
 * - Quando NÃO há produto (modo conceito) → cena completa e livre (com pessoa OK)
 *
 * opts.people permite forçar/proibir pessoa na cena (ver buildPeopleClause).
 */
async function buildBackgroundPrompt(product, sceneHint = '', opts = {}) {
  const prompts = await cfg.getProviderPrompts();
  const scene = (sceneHint && sceneHint.trim()) || await pickSceneAuto(product);
  const hasProduct = !!(product?.imageUrl);
  const peopleClause = buildPeopleClause(opts.people);

  if (hasProduct) {
    const template = prompts.composite_bg || cfg.DEFAULT_PROVIDER_PROMPTS.composite_bg;
    let result = template.replace(/\{SCENE\}/g, scene);
    // No modo composite (com produto), por default a IA não deve gerar pessoa
    // (o produto vai ser sobreposto). Só inclui pessoa se user pediu explicitamente.
    if (opts.people && opts.people.mode === 'specific') {
      result += ' ' + peopleClause;
    } else if (!opts.people || opts.people.mode === 'auto' || opts.people.mode === 'none') {
      // Default composite: sem pessoa (background limpo pro produto compor por cima)
      result += ' STRICT: NO PEOPLE in this background — it will be composited with the product later.';
    }
    return result;
  }

  // MODO CONCEITO PURO: a cena descrita pelo user é o conteúdo total
  // (pode ter pessoa, objetos, texto sutil, qualquer coisa).
  // Persona BR é injetada pra evitar modelos genéricos europeus.
  const personaBr = await cfg.getPersonaBr();
  const parts = [
    'Editorial photography for Brazilian social media post (Instagram feed format).',
    'Scene: ' + scene + '.',
    'Hyperrealistic, magazine quality, dramatic professional lighting, shallow depth of field.',
    personaBr,
  ];
  // Insere clausula de pessoa ANTES das regras de composição (peso maior)
  if (peopleClause) parts.push(peopleClause);
  parts.push(
    'CRITICAL COMPOSITION RULES:',
    '— The subject (person/object) MUST be positioned in the LOWER HALF of the frame, ideally from 45% to 90% vertical position.',
    '— The TOP 30% of the frame MUST be empty/clean (sky, blurred wall, plain background) for headline text overlay.',
    '— The BOTTOM 10% MUST also be uncluttered for logo and handle overlay.',
    '— If a person is the subject, frame from chest/waist down OR show them seated/leaning so their head sits around 30-40% from top, NOT at the very top.',
    'No fake brand logos, no random text written on the image.'
  );
  return parts.join(' ');
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
  buildPeopleClause,
  pickSceneAuto,
  getReferenceImages,
};
