// =====================================================================
// Marketing Config — defaults editáveis pela UI
// =====================================================================
// Tudo que era hard-coded em marketingPrompts.js / compositeImage.js
// agora é configurável via banco (tabela Config: key/value JSON).
//
// Fallback: se não existir no banco, usa os defaults daqui.
// Cache em memória de 60s pra não bater no banco a cada geração.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

// Cache simples (60s)
const cache = new Map();
const CACHE_TTL = 60_000;

async function getJson(key, defaultValue) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < CACHE_TTL) return c.v;
  try {
    const row = await prisma.config.findUnique({ where: { key } });
    const value = row?.value ? JSON.parse(row.value) : defaultValue;
    cache.set(key, { t: Date.now(), v: value });
    return value;
  } catch {
    return defaultValue;
  }
}

async function setJson(key, value) {
  await prisma.config.upsert({
    where: { key },
    update: { value: JSON.stringify(value) },
    create: { key, value: JSON.stringify(value) },
  });
  cache.set(key, { t: Date.now(), v: value });
  return value;
}

// =====================================================
// DEFAULTS
// =====================================================

const DEFAULT_BRAND_SCENES = {
  mizuno: 'minimalist Japanese wabi-sabi aesthetic, neutral concrete or paper background, dramatic single-source lighting, generous negative space, zen composition',
  nike: 'high-fashion editorial scene, cinematic urban backdrop at golden hour, premium streetwear styling, bold contrast lighting, vogue magazine quality',
  adidas: 'contemporary urban environment, earth tones with pops of color, modern architecture or street art backdrop, casual athletic lifestyle',
  asics: 'clean technical environment focused on running, asphalt road at sunrise, sweat and motion, performance-oriented composition',
  'under armour': 'industrial gritty gym, dark moody atmosphere, dramatic side lighting, training intensity, raw concrete and steel',
  puma: 'edgy street culture aesthetic, bold colors, urban graffiti or skateboard environment, fast and rebellious energy',
  wilson: 'professional tennis court, hardcourt blue surface, US Open atmosphere, late afternoon shadows',
  babolat: 'red clay tennis court at Roland Garros, classic European tennis atmosphere, soft warm light',
  yonex: 'vibrant tennis court with bright color blocking, Tokyo or Asian tournament aesthetic, high saturation',
  head: 'modern indoor tennis court, technical premium feel, controlled studio-like lighting',
  umbro: 'vintage 80s/90s futsal court aesthetic, retro typography references, blue-red-cream palette, nostalgic',
  penalty: 'Brazilian society football pitch with synthetic grass, late afternoon, community atmosphere',
  topper: 'Brazilian amateur futsal/várzea field, raw authentic local game energy, dust and texture',
  mitre: 'classic football pitch, traditional sportsmanship aesthetic',
  fila: '90s heritage aesthetic, beige and forest green tones, urban basketball court, retro athletic styling',
  kenner: 'Brazilian beach lifestyle, sandy boardwalk or terrace, tropical casual vibe, late afternoon golden light',
  ipanema: 'Rio beach culture, vibrant turquoise water hints, sand and palm shadows',
  havaianas: 'tropical Brazilian beach, sand and water close-up, summer vibrant colors',
  rider: 'urban Brazilian casual lifestyle, street fair or boardwalk atmosphere',
  olympikus: 'Brazilian urban running scene, sunrise asphalt in São Paulo or Recife, dynamic motion blur background',
  'caju brasil': 'tropical Brazilian aesthetic, palm leaves and warm orange-pink gradient background, beach club lifestyle, feminine and confident, Northeast Brazil sun',
  _default: 'modern Brazilian sports lifestyle scene, urban Northeast environment (João Pessoa coastal architecture), warm golden hour light',
};

const DEFAULT_MODALITY_SCENES = {
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

const DEFAULT_SCENE_HINTS = [
  '',  // 1ª: cenário default
  'close-up extremo do produto sobre superfície de mármore branco, luz lateral dramática, sombras suaves',
  'produto em ambiente outdoor de quadra de tênis ao pôr do sol, luz dourada, atleta desfocado ao fundo',
  'flat lay top-down sobre fundo neutro cinza claro, com acessórios esportivos (toalha, garrafa) ao redor',
  'produto em destaque dentro de um vestiário moderno minimalista, iluminação cinematográfica suave',
];

const DEFAULT_PERSONA_BR = 'If a human appears in the scene, depict an authentic Brazilian Northeast person (mixed race, sun-kissed skin tone, natural athletic build, age 20-35), not stereotypical European or North American models. Subtle, not exoticizing.';

const DEFAULT_BRAND_VOICE = 'Premium sports retail brand aesthetic — warm and energetic, not corporate or cold. Subtle hints of orange-pink gradient (#FF6A1F to #FF2D92) in highlights or accents are welcome but not required.';

const DEFAULT_PROVIDER_PROMPTS = {
  composite_bg: `Editorial background scene for sports lifestyle product photography:
{SCENE}.
Empty scene with clean focal point — no products, no people, no text.
Hyperrealistic, magazine quality, dramatic professional lighting, shallow depth of field.
Subtle warm orange-pink gradient accents are welcome but not required.
IMPORTANT: Do not include any product, person, animal, or text in the image. Leave space in the center-bottom area for a product overlay.`,

  editorial_base: `Editorial product photography of the {PRODUCT_NAME} ({BRAND}), {CATEGORY}.
Scene: {SCENE}.
{FACTS}
Hyperrealistic, magazine cover quality, dramatic professional studio lighting, sharp focus on the product, shallow depth of field where appropriate.
{BRAND_VOICE}
{PERSONA_BR}
Aspect ratio {ASPECT}, composition optimized for {ASPECT_USE}.
CRITICAL: Do not change product colors, logos, shape, or proportions. Keep the product visually faithful to the reference image(s). No text overlays unless explicitly requested.`,
};

// =====================================================
// API publica
// =====================================================

const getBrandScenes = () => getJson('marketing_brand_scenes', DEFAULT_BRAND_SCENES);
const setBrandScenes = (v) => setJson('marketing_brand_scenes', v);

const getModalityScenes = () => getJson('marketing_modality_scenes', DEFAULT_MODALITY_SCENES);
const setModalityScenes = (v) => setJson('marketing_modality_scenes', v);

const getSceneHints = () => getJson('marketing_scene_hints', DEFAULT_SCENE_HINTS);
const setSceneHints = (v) => setJson('marketing_scene_hints', v);

const getProviderPrompts = () => getJson('marketing_provider_prompts', DEFAULT_PROVIDER_PROMPTS);
const setProviderPrompts = (v) => setJson('marketing_provider_prompts', v);

const getPersonaBr = () => getJson('marketing_persona_br', DEFAULT_PERSONA_BR);
const setPersonaBr = (v) => setJson('marketing_persona_br', v);

const getBrandVoice = () => getJson('marketing_brand_voice', DEFAULT_BRAND_VOICE);
const setBrandVoice = (v) => setJson('marketing_brand_voice', v);

// =====================================================
// Agentes da Central IA — leitura/escrita de .md
// =====================================================
// Estão em .claude/agents/*.md no repo. Read/Write via filesystem.

const AGENTS_DIR = path.resolve(__dirname, '../../.claude/agents');

function listAgents() {
  try {
    if (!fs.existsSync(AGENTS_DIR)) return [];
    return fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))
      .sort();
  } catch (e) {
    return [];
  }
}

function readAgent(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(AGENTS_DIR, safe + '.md');
  if (!fs.existsSync(file)) throw new Error('agente não encontrado: ' + safe);
  return fs.readFileSync(file, 'utf-8');
}

function writeAgent(name, content) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(AGENTS_DIR, safe + '.md');
  if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return { name: safe, size: content.length };
}

module.exports = {
  // Marketing prompts
  getBrandScenes, setBrandScenes,
  getModalityScenes, setModalityScenes,
  getSceneHints, setSceneHints,
  getProviderPrompts, setProviderPrompts,
  getPersonaBr, setPersonaBr,
  getBrandVoice, setBrandVoice,
  // Agentes
  listAgents, readAgent, writeAgent,
  // Defaults exportados (pra reset/UI mostrar default)
  DEFAULT_BRAND_SCENES, DEFAULT_MODALITY_SCENES, DEFAULT_SCENE_HINTS,
  DEFAULT_PROVIDER_PROMPTS, DEFAULT_PERSONA_BR, DEFAULT_BRAND_VOICE,
};
