// =====================================================================
// Brand Profiles — multi-tenant pra IA de marketing
// =====================================================================
// Service CRUD + cache + seed das 9 marcas do Douglas.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Cache simples (60s)
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

async function listAll(includeInactive = false) {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) {
    return includeInactive ? cache : cache.filter(b => b.active);
  }
  const all = await prisma.brandProfile.findMany({ orderBy: [{ displayOrder: 'asc' }, { displayName: 'asc' }] });
  cache = all;
  cacheTime = now;
  return includeInactive ? all : all.filter(b => b.active);
}

async function getBySlug(slug) {
  const list = await listAll(true);
  return list.find(b => b.slug === slug);
}

async function getById(id) {
  const list = await listAll(true);
  return list.find(b => b.id === id);
}

async function upsert(data) {
  const { slug, ...rest } = data;
  if (!slug) throw new Error('slug obrigatório');
  // Fallback pra create: displayName é obrigatório
  const createData = {
    slug,
    displayName: rest.displayName || slug.replace(/[-_]/g, ' '),
    ...rest,
  };
  const saved = await prisma.brandProfile.upsert({
    where: { slug },
    update: { ...rest, updatedAt: new Date() },
    create: createData,
  });
  cache = null; // invalida
  return saved;
}

// Update simples — falha se brand não existe (evita criar marca incompleta)
async function update(slug, patch) {
  if (!slug) throw new Error('slug obrigatório');
  const saved = await prisma.brandProfile.update({
    where: { slug },
    data: { ...patch, updatedAt: new Date() },
  });
  cache = null;
  return saved;
}

async function deleteBrand(id) {
  await prisma.brandProfile.delete({ where: { id } });
  cache = null;
}

// =====================================================
// Seed inicial — 9 marcas do Douglas como rascunhos
// =====================================================
// O DNA fica VAZIO de propósito (ele preenche pela UI).
// Só populamos slug, handle, archetype-default, ordem.

const SEED_BRANDS = [
  // Sports retail (3)
  { slug: 'sportsetennis',     displayName: 'Sports & Tennis',           archetype: 'mass_retail',   instagramHandle: '@sportsetennis',     displayOrder: 1},
  { slug: 'metaesportes',      displayName: 'Meta Esportes',             archetype: 'mass_retail',   instagramHandle: '@metaesportes',      displayOrder: 2 },
  { slug: 'barataodosesportes', displayName: 'Baratão dos Esportes',     archetype: 'mass_retail',   instagramHandle: '@barataodosesportes', displayOrder: 3 },
  // B2B premium uniformes
  { slug: 'metafardamentos',   displayName: 'Meta Fardamentos',          archetype: 'b2b_premium',   instagramHandle: '@metafardamentos',   displayOrder: 4 },
  // Institucional saúde
  { slug: 'metasaudeaps',      displayName: 'Meta Saúde APS',            archetype: 'institutional', instagramHandle: '@metasaudeaps',      displayOrder: 5 },
  { slug: 'metasaudesus',      displayName: 'Meta Saúde SUS',            archetype: 'institutional', instagramHandle: '@metasaudesus',      displayOrder: 6 },
  { slug: 'iaaps',             displayName: 'IA APS',                    archetype: 'institutional', instagramHandle: '@ia.aps',            displayOrder: 7 },
  // Marca pessoal
  { slug: 'transpireproposito', displayName: 'Transpire Propósito',      archetype: 'personal',      instagramHandle: '@transpireproposito', displayOrder: 8 },
  { slug: 'yyyouforyou',       displayName: 'You For You',               archetype: 'personal',      instagramHandle: '@yyyouforyou',       displayOrder: 9 },
  // Político
  { slug: 'douglasbr2026',     displayName: 'Douglas BR 2026',           archetype: 'political',     instagramHandle: '@douglasbr2026',     displayOrder: 10 },
];

async function seedDefaults() {
  // Defensivo: se prisma client ainda não tem o model (cache de build velho),
  // não crasha. Retry no próximo boot/redeploy.
  if (!prisma.brandProfile) {
    console.warn('[brandProfiles] prisma.brandProfile não disponível — pulando seed (regenerar client?)');
    return 0;
  }
  let created = 0;
  try {
    for (const b of SEED_BRANDS) {
      const exists = await prisma.brandProfile.findUnique({ where: { slug: b.slug } });
      if (!exists) {
        await prisma.brandProfile.create({ data: b });
        created++;
      }
    }
    if (created > 0) {
      console.log(`[brandProfiles] seed criou ${created} marcas (rascunho — preencher DNA via UI)`);
    }
  } catch (e) {
    console.warn('[brandProfiles] seed falhou (segue boot):', e.message);
  }
  cache = null;
  return created;
}

// Defaults de tom/CTA por archetype (sugestão inicial quando user clica "Aplicar default do archetype")
const ARCHETYPE_DEFAULTS = {
  mass_retail: {
    description: 'Varejo esportivo popular, foco em preço e variedade',
    voiceTone: { formal: 3, energy: 9, technical: 3, humor: 6, intimacy: 7 },
    paletteHex: ['#FF6A1F', '#FF2D92', '#FFFFFF'],
    contentPillars: ['produto', 'promoção', 'lifestyle esportivo', 'bastidor loja'],
    ctaTemplates: ['Vem na loja', 'Compra no link da bio', 'Chama no WhatsApp', 'Hoje tá com preço novo'],
    taboo: ['preço cheio sem oferta', 'jargão técnico demais'],
  },
  b2b_premium: {
    description: 'B2B premium, foco em qualidade técnica e relacionamento longo prazo',
    voiceTone: { formal: 8, energy: 5, technical: 8, humor: 2, intimacy: 4 },
    paletteHex: ['#1A1A1A', '#C9A961', '#F5F5F0'],
    contentPillars: ['case real', 'tecido/material', 'bastidor produção', 'cliente há X anos'],
    ctaTemplates: ['Solicite orçamento', 'Conheça nosso portfólio', 'Atendimento consultivo'],
    taboo: ['preço grande', 'emoji excessivo', 'linguagem coloquial', 'urgência forçada'],
  },
  institutional: {
    description: 'Comunicação institucional educativa, autoridade técnica',
    voiceTone: { formal: 7, energy: 4, technical: 9, humor: 1, intimacy: 5 },
    paletteHex: ['#1976D2', '#FFFFFF', '#43A047'],
    contentPillars: ['dado/estatística', 'educativo', 'caso de uso', 'política pública'],
    ctaTemplates: ['Saiba mais', 'Acesse o protocolo', 'Compartilhe com sua equipe'],
    taboo: ['comercial demais', 'partidarismo'],
  },
  personal: {
    description: 'Marca pessoal autêntica, jornada e propósito',
    voiceTone: { formal: 3, energy: 6, technical: 4, humor: 5, intimacy: 9 },
    paletteHex: ['#8B5A3C', '#E8D5C4', '#2D2D2D'],
    contentPillars: ['reflexão', 'aprendizado', 'rotina', 'vulnerabilidade'],
    ctaTemplates: ['Salva esse post', 'Conta nos comentários', 'Marca alguém que precisa ler'],
    taboo: ['vendedor demais', 'arrogância', 'falsa modéstia'],
  },
  political: {
    description: 'Comunicação política de proximidade e propósito',
    voiceTone: { formal: 5, energy: 7, technical: 4, humor: 3, intimacy: 8 },
    paletteHex: ['#009B3A', '#FFD400', '#0033A0'],
    contentPillars: ['proposta', 'agenda no campo', 'depoimento', 'pauta'],
    ctaTemplates: ['Conheça a proposta completa', 'Compartilhe', 'Estaremos em [local] amanhã'],
    taboo: ['ataque pessoal a adversário', 'promessa irrealista', 'jargão político'],
  },
  custom: {
    description: '',
    voiceTone: { formal: 5, energy: 5, technical: 5, humor: 5, intimacy: 5 },
    paletteHex: ['#FF6A1F', '#FFFFFF'],
    contentPillars: [],
    ctaTemplates: [],
    taboo: [],
  },
};

module.exports = {
  listAll,
  getBySlug,
  getById,
  upsert,
  update,
  deleteBrand,
  seedDefaults,
  SEED_BRANDS,
  ARCHETYPE_DEFAULTS,
};
