// =====================================================================
// Construção de prompts pra geração de imagem (Flux + GPT compartilhado)
// =====================================================================
// Centraliza:
//   - Mapeamento marca → estética visual específica
//   - Mapeamento gênero/modalidade → cenário
//   - Persona brasileira (modelo realista nordestino)
//   - Extração de múltiplas fotos de referência do produto
//
// Tudo usado por openaiImage.js e falAi.js pra garantir consistência
// e identidade visual coerente entre os 2 providers.
// =====================================================================

// Cada marca vendida pela Sports & Tennis tem identidade visual própria.
// Pesquisado caso a caso (DNA de marca, campanhas globais recentes, paleta).
const BRAND_SCENES = {
  // Marcas globais premium
  mizuno: 'minimalist Japanese wabi-sabi aesthetic, neutral concrete or paper background, dramatic single-source lighting, generous negative space, zen composition',
  nike: 'high-fashion editorial scene, cinematic urban backdrop at golden hour, premium streetwear styling, bold contrast lighting, vogue magazine quality',
  adidas: 'contemporary urban environment, earth tones with pops of color, modern architecture or street art backdrop, casual athletic lifestyle',
  asics: 'clean technical environment focused on running, asphalt road at sunrise, sweat and motion, performance-oriented composition',
  'under armour': 'industrial gritty gym, dark moody atmosphere, dramatic side lighting, training intensity, raw concrete and steel',
  puma: 'edgy street culture aesthetic, bold colors, urban graffiti or skateboard environment, fast and rebellious energy',

  // Tênis (esporte)
  wilson: 'professional tennis court, hardcourt blue surface, US Open atmosphere, late afternoon shadows',
  babolat: 'red clay tennis court at Roland Garros, classic European tennis atmosphere, soft warm light',
  yonex: 'vibrant tennis court with bright color blocking, Tokyo or Asian tournament aesthetic, high saturation',
  head: 'modern indoor tennis court, technical premium feel, controlled studio-like lighting',

  // Futebol/futsal
  umbro: 'vintage 80s/90s futsal court aesthetic, retro typography references, blue-red-cream palette, nostalgic',
  penalty: 'Brazilian society football pitch with synthetic grass, late afternoon, community atmosphere',
  topper: 'Brazilian amateur futsal/várzea field, raw authentic local game energy, dust and texture',
  mitre: 'classic football pitch, traditional sportsmanship aesthetic',

  // Lifestyle/casual brasileiras
  fila: '90s heritage aesthetic, beige and forest green tones, urban basketball court, retro athletic styling',
  kenner: 'Brazilian beach lifestyle, sandy boardwalk or terrace, tropical casual vibe, late afternoon golden light',
  ipanema: 'Rio beach culture, vibrant turquoise water hints, sand and palm shadows',
  havaianas: 'tropical Brazilian beach, sand and water close-up, summer vibrant colors',
  rider: 'urban Brazilian casual lifestyle, street fair or boardwalk atmosphere',

  // Corrida brasileira
  olympikus: 'Brazilian urban running scene, sunrise asphalt in São Paulo or Recife, dynamic motion blur background',

  // Caju Brasil (marca local, identidade tropical/feminina)
  'caju brasil': 'tropical Brazilian aesthetic, palm leaves and warm orange-pink gradient background, beach club lifestyle, feminine and confident, Northeast Brazil sun',

  // Default (qualquer outra marca)
  _default: 'modern Brazilian sports lifestyle scene, urban Northeast environment (João Pessoa coastal architecture), warm golden hour light',
};

// Cenário por modalidade — usado quando marca não dá pista suficiente
const MODALITY_SCENES = {
  corrida: 'urban running route at sunrise, sweat and motion, athletic intensity',
  running: 'urban running route at sunrise, sweat and motion, athletic intensity',
  tennis: 'tennis court (clay or hardcourt) with net detail, professional atmosphere',
  tenis: 'tennis court (clay or hardcourt) with net detail, professional atmosphere',
  padel: 'modern padel court with glass walls, contemporary club aesthetic',
  futsal: 'indoor futsal court, polished wood floor, lively local match energy',
  futebol: 'green football pitch, late afternoon community game',
  society: 'Brazilian society football pitch, synthetic grass, weekend community atmosphere',
  basquete: 'outdoor concrete basketball court, urban skyline backdrop',
  basket: 'outdoor concrete basketball court, urban skyline backdrop',
  treino: 'industrial gym, weight room ambiance, focused training mood',
  gym: 'industrial gym, weight room ambiance, focused training mood',
  crossfit: 'crossfit box with rigs and rope, raw industrial setting, intense training',
  caminhada: 'mountain or coastal trail at dawn, soft natural light, exploration mood',
  trilha: 'mountain or coastal trail at dawn, soft natural light, exploration mood',
  praia: 'Brazilian Northeast beach, palm shadows, sand close-up, golden light',
  natacao: 'pool deck close-up, water reflections, athletic precision',
  vôlei: 'beach volleyball court, sand and net, dynamic late afternoon',
  volei: 'beach volleyball court, sand and net, dynamic late afternoon',
};

// Persona brasileira — pra evitar que GPT/Flux gerem modelo europeu/americano genérico
// quando o cliente é nordestino. Aplicada APENAS quando há figura humana na cena.
const PERSONA_BR = 'If a human appears in the scene, depict an authentic Brazilian Northeast person (mixed race, sun-kissed skin tone, natural athletic build, age 20-35), not stereotypical European or North American models. Subtle, not exoticizing.';

// Aspecto visual da marca Sports & Tennis (paleta + tom)
const BRAND_VOICE = 'Premium sports retail brand aesthetic — warm and energetic, not corporate or cold. Subtle hints of orange-pink gradient (#FF6A1F to #FF2D92) in highlights or accents are welcome but not required.';

/**
 * Escolhe a cena base — primeiro tenta marca, depois modalidade, depois fallback.
 */
function pickSceneAuto(product) {
  const brand = String(product?.brand || '').toLowerCase().trim();
  const name = String(product?.name || '').toLowerCase();
  const category = String(product?.category || '').toLowerCase();
  const aiClass = product?.aiContext?.classification || {};
  const modality = String(aiClass.modality || '').toLowerCase();

  // 1. Marca tem prioridade (identidade visual específica)
  if (brand && BRAND_SCENES[brand]) return BRAND_SCENES[brand];

  // 2. Modalidade estruturada (aiContext.classification.modality)
  if (modality && MODALITY_SCENES[modality]) return MODALITY_SCENES[modality];

  // 3. Palavra-chave no nome ou categoria
  for (const key of Object.keys(MODALITY_SCENES)) {
    if (name.includes(key) || category.includes(key)) return MODALITY_SCENES[key];
  }

  // 4. Heurística feminina
  if (name.match(/feminin|woman|moda/) || aiClass.gender === 'F') {
    return 'modern minimalist studio with soft pastel background, feminine athletic elegance';
  }

  // 5. Default
  return BRAND_SCENES._default;
}

/**
 * Constrói o prompt completo pra Flux/GPT.
 * Combina: nome+marca + cenário + contexto factual + persona BR + brand voice + travas anti-deformação.
 *
 * @param {object} product - objeto Product do Prisma
 * @param {string} sceneHint - cenário custom (vazio = automático)
 * @param {object} opts - { aspectRatio?: '16:9'|'9:16'|'1:1'|'4:5' }
 * @returns {string} prompt em inglês (modelos respondem melhor)
 */
function buildEditorialPrompt(product, sceneHint = '', opts = {}) {
  const name = product?.name || 'product';
  const brand = product?.brand || '';
  const category = product?.category || '';
  const subcategory = product?.subcategory || '';
  const shortDesc = product?.shortDescription || '';
  const aiClass = product?.aiContext?.classification || {};
  const tier = aiClass.tier;           // premium / value / mid
  const gender = aiClass.gender;       // M / F / unisex
  const type = aiClass.type;           // shoe / apparel / accessory

  const scene = (sceneHint && sceneHint.trim()) || pickSceneAuto(product);
  const aspect = opts.aspectRatio || '16:9';

  // Features factuais que ajudam o modelo a posicionar bem
  const facts = [];
  if (tier === 'premium') facts.push('premium positioning');
  else if (tier === 'value') facts.push('accessible value tier');
  if (gender === 'F') facts.push('targeted to women');
  else if (gender === 'M') facts.push('targeted to men');
  if (subcategory) facts.push(subcategory.toLowerCase());
  if (shortDesc && shortDesc.length < 200) facts.push(shortDesc.toLowerCase().slice(0, 200));
  const factsLine = facts.length ? `Product context: ${facts.join('; ')}.` : '';

  // Composição final do prompt
  return [
    `Editorial product photography of the ${name}${brand ? ` (${brand})` : ''}${category ? `, ${category}` : ''}.`,
    `Scene: ${scene}.`,
    factsLine,
    'Hyperrealistic, magazine cover quality, dramatic professional studio lighting, sharp focus on the product, shallow depth of field where appropriate.',
    BRAND_VOICE,
    PERSONA_BR,
    `Aspect ratio ${aspect}, composition optimized for ${aspect === '9:16' ? 'Instagram Reels/Stories' : aspect === '1:1' ? 'Instagram feed' : aspect === '4:5' ? 'Instagram portrait feed' : 'wide editorial landscape'}.`,
    'CRITICAL: Do not change product colors, logos, shape, or proportions. Keep the product visually faithful to the reference image(s). No text overlays unless explicitly requested.',
  ].filter(Boolean).join(' ');
}

/**
 * Extrai array de URLs de fotos do produto pra mandar como referências múltiplas.
 * Prioriza imageUrl, complementa com imageUrls[]. Limita a maxImages.
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
  pickSceneAuto,
  getReferenceImages,
  BRAND_SCENES,
  MODALITY_SCENES,
};
