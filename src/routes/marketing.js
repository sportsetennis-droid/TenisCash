// =====================================================================
// /api/marketing — geração e curadoria de criativos IA
// =====================================================================
// Endpoints:
//   POST   /generate/:productId              gera trio (foto editorial + reel + sem fundo) + copies
//   GET    /creatives                        lista criativos (filtro por status, productId)
//   GET    /creatives/:id                    detalhe
//   PATCH  /creatives/:id                    aprovar/rejeitar/editar copy
//   DELETE /creatives/:id                    apaga (só pending)
//   POST   /creatives/:id/publish            publica em IG/TikTok/WA (futuro)
//   GET    /publications                     histórico
//   GET    /stats                            volume gerado, custo do mês, taxa aprovação
// =====================================================================

const express = require('express');
const multer = require('multer');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const falAi = require('../services/falAi');
const openaiImage = require('../services/openaiImage');
const compositeImage = require('../services/compositeImage');
const collageImage = require('../services/collageImage');
const copyGen = require('../services/copyGenerator');
const brandProfiles = require('../services/brandProfiles');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Upload pra fal.storage (reutilizado de brand logo)
async function uploadFileToFal(buffer, filename, mimetype) {
  const mod = await import('@fal-ai/client');
  const fal = mod.fal;
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY não configurada');
  fal.config({ credentials: process.env.FAL_KEY });
  let FileC = (typeof File !== 'undefined') ? File : null;
  if (!FileC) { try { FileC = require('node:buffer').File; } catch {} }
  const payload = FileC
    ? new FileC([buffer], filename, { type: mimetype })
    : new Blob([buffer], { type: mimetype });
  const url = await fal.storage.upload(payload);
  if (!url) throw new Error('fal.storage retornou vazio');
  return url;
}

const router = express.Router();
router.use(authMiddleware);

// Só admin/superadmin pode mexer em marketing
function requireAdmin(req, res, next) {
  prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } })
    .then((u) => {
      if (!u || !['admin', 'superadmin', 'manager'].includes(u.role)) {
        return res.status(403).json({ error: 'apenas admin' });
      }
      next();
    })
    .catch((e) => res.status(500).json({ error: e.message }));
}
router.use(requireAdmin);

// =====================================================
// Heurística pra gerar headline curta automaticamente.
// Aceita brandProfile pra usar templates apropriados ao arquétipo.
// =====================================================
function autoHeadline(product, brandProfile = null) {
  if (!product) return 'NOVIDADE';
  const name = (product.name || '').toUpperCase().trim();
  const brand = (product.brand || '').toUpperCase().trim();
  const core = (name.split(/[/\-]/)[0] || '').trim().slice(0, 30);
  const archetype = brandProfile?.archetype || 'mass_retail';

  // Templates por arquétipo (não usa "CHEGOU X" pra B2B/institucional)
  let t = [];
  if (archetype === 'b2b_premium' || archetype === 'institutional') {
    // B2B / Institucional: tom profissional, sem "CHEGOU"
    if (core) {
      t.push(core);
      t.push(`LINHA ${core.slice(0, 20)}`);
    }
    if (brand && brand.length < 25) t.push(brand);
    t.push('NOVA LINHA');
    t.push('CONHEÇA');
    t.push('LANÇAMENTO');
  } else if (archetype === 'personal' || archetype === 'political') {
    // Personal/político: foco no propósito, não no produto
    t.push('PROPÓSITO');
    t.push('COMPROMISSO');
    t.push('SOMOS JUNTOS');
    if (brandProfile?.mission) {
      const m = brandProfile.mission.split('.')[0].toUpperCase().slice(0, 40);
      if (m.length > 8) t.push(m);
    }
  } else {
    // mass_retail / custom (S&T e similares — varejo esportivo)
    if (brand) {
      t.push(`CHEGOU ${brand}`);
      t.push(`${brand} NA LOJA`);
      t.push(`NOVIDADE ${brand}`);
    }
    if (core) {
      t.push(`${core} — JÁ NA LOJA`);
      t.push(`PEGA O ${core.slice(0, 22)}`);
    }
    t.push('NOVIDADE NA LOJA');
    t.push('CHEGOU PRA TI');
  }

  // CTAs preferenciais da marca (se houver) entram no rodízio
  if (Array.isArray(brandProfile?.ctaTemplates)) {
    brandProfile.ctaTemplates.slice(0, 3).forEach(c => {
      if (c && c.length < 50) t.push(String(c).toUpperCase());
    });
  }

  const seed = (product.id || product.sku || product.name || 'x').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const out = t[seed % t.length] || (brand || 'NOVIDADE');
  return out.length > 0 ? out : 'NOVIDADE';
}

// ====================================================
// POST /generate/:productId — gera trio + copies
// ====================================================
// Body opcional: { skipVideo: bool, skipBgRemove: bool, sceneHint: string }

router.post('/generate/:productId', async (req, res) => {
  try {
    const {
      skipVideo = false,
      skipBgRemove = false,
      sceneHint = '',
      provider = 'composite',         // 'composite' (default — fidelidade 100%) | 'fal' | 'openai' | 'both'
      openaiQuality = 'medium',  // 'low' | 'medium' | 'high'
    } = req.body || {};
    const product = await prisma.product.findUnique({
      where: { id: req.params.productId },
      select: {
        id: true, name: true, brand: true, category: true, subcategory: true,
        price: true, shortDescription: true,
        imageUrl: true, imageUrls: true,
        aiContext: true,
        sku: true,
      },
    });
    if (!product) return res.status(404).json({ error: 'produto não encontrado' });
    if (!product.imageUrl) return res.status(400).json({ error: 'produto sem imageUrl — não dá pra usar como referência' });

    // Aspect ratio configurável via body (default 16:9). Aceita 1:1, 4:5, 9:16.
    const aspectRatio = req.body?.aspectRatio || '16:9';

    // Carrega BrandProfile uma vez (usado pra logo, handle, autoHeadline e copies)
    let brandProfile = null;
    if (req.body?.brandSlug) {
      try { brandProfile = await brandProfiles.getBySlug(req.body.brandSlug); }
      catch (e) { console.warn('[marketing/generate] brand load fail:', e.message); }
    }

    console.log(`[marketing/generate] iniciando ${product.sku} (${product.name}) · provider=${provider} · ar=${aspectRatio} · brand=${brandProfile?.slug || 'none'}`);

    // Roda as gerações em paralelo (fal.ai e OpenAI aguentam)
    const tasks = [];

    // Foto editorial — pelo provider escolhido.
    // 'composite' (default): produto REAL + cenário IA (fidelidade 100%)
    // 'fal'/'openai': image-to-image generativo (cenas mais ricas, mas pode deformar produto)
    // === OVERLAY CONFIGURÁVEL (válido pra TODOS os providers) ===
    // Aplica no composite via opts; aplica em Flux/OpenAI via applyOverlayToUrl
    const includeHeadline = req.body?.includeHeadline !== false; // default true
    const includePrice    = req.body?.includePrice === true;     // default false
    const includeLogo     = req.body?.includeLogo === true;
    const includeHandle   = req.body?.includeHandle === true;
    const includeSubline  = req.body?.includeSubline === true;

    const headline = includeHeadline
      ? (req.body?.headline?.trim() || autoHeadline(product, brandProfile)).toString().slice(0, 60)
      : '';
    const subline = includeSubline ? (req.body?.subline ?? '').toString().slice(0, 80) : '';

    const logoUrl = includeLogo ? (brandProfile?.logoUrl || null) : null;
    const handle  = includeHandle ? (brandProfile?.instagramHandle || '') : '';
    if (includeLogo && !logoUrl) {
      console.warn(`[marketing] AVISO: marca ${brandProfile?.slug || 'none'} sem logoUrl — logo nao vai sair no criativo`);
    }

    const overlayOpts = {
      includeHeadline, includePrice, includeLogo, includeHandle, includeSubline,
      headline, subline, price: product.price,
      logoUrl, handle,
    };

    if (provider === 'composite' || provider === 'all') {
      tasks.push(
        compositeImage.generateEditorialPhoto({
          product,
          aspectRatio,
          sceneHint,
          ...overlayOpts,
          people: req.body?.people || null,  // { mode, gender, age, ethnicity }
        }).then(r => ({ kind: 'editorial_photo', provider: 'composite', ...r }))
      );
    }
    if (provider === 'fal' || provider === 'both' || provider === 'all') {
      tasks.push(
        falAi.generateEditorialPhoto({
          product,
          aspectRatio,
          sceneHint,
        }).then(async r => {
          // Aplica overlay no resultado do Flux (logo/preço/headline)
          try {
            const newUrl = await compositeImage.applyOverlayToUrl(r.outputUrl, overlayOpts);
            return { kind: 'editorial_photo', provider: 'fal', ...r, outputUrl: newUrl };
          } catch (e) { console.warn('[overlay/fal] falhou:', e.message); return { kind: 'editorial_photo', provider: 'fal', ...r }; }
        })
      );
    }
    if (provider === 'openai' || provider === 'both' || provider === 'all') {
      tasks.push(
        openaiImage.generateEditorialPhoto({
          product,
          aspectRatio,
          sceneHint,
          quality: openaiQuality,
        }).then(async r => {
          try {
            const newUrl = await compositeImage.applyOverlayToUrl(r.outputUrl, overlayOpts);
            return { kind: 'editorial_photo', provider: 'openai', ...r, outputUrl: newUrl };
          } catch (e) { console.warn('[overlay/openai] falhou:', e.message); return { kind: 'editorial_photo', provider: 'openai', ...r }; }
        })
      );
    }

    if (!skipVideo) {
      // Pra video, ideal seria usar a foto editorial gerada. Mas pra paralelizar usamos a do catálogo.
      tasks.push(
        falAi.generateReelVideo({
          imageUrl: product.imageUrl,
          productName: product.name,
        }).then(r => ({ kind: 'reel_video', provider: 'fal', ...r }))
      );
    }
    if (!skipBgRemove) {
      tasks.push(
        falAi.removeBackground({ imageUrl: product.imageUrl })
          .then(r => ({ kind: 'transparent_photo', provider: 'fal', ...r }))
      );
    }

    // Espera as 3 (ou 1, dependendo dos skips)
    const settled = await Promise.allSettled(tasks);
    const created = [];
    const errors = [];

    // Em paralelo, gera as copies (brandProfile ja carregado no inicio do handler)
    let copies = { captionIg: '', captionTiktok: '', captionWa: '', hashtags: '' };
    try {
      copies = await copyGen.generateCopies({
        productName: product.name,
        brand: product.brand,
        category: product.category,
        price: product.price,
        shortDesc: product.shortDescription,
        sceneHint,
        brandProfile,
      });
    } catch (e) {
      console.warn('[marketing/generate] copy gen falhou:', e.message);
      errors.push({ step: 'copy_generator', error: e.message });
    }

    // Salva cada criativo no banco
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        errors.push({ step: 'fal_ai', error: result.reason?.message || String(result.reason) });
        continue;
      }
      const r = result.value;
      const creative = await prisma.productCreative.create({
        data: {
          productId: product.id,
          kind: r.kind,
          outputUrl: r.outputUrl,
          model: r.model,
          prompt: r.prompt,
          costUsd: r.costUsd,
          captionIg: copies.captionIg,
          captionTiktok: copies.captionTiktok,
          captionWa: copies.captionWa,
          hashtags: copies.hashtags,
          status: 'pending_review',
          params: { sceneHint },
        },
      });
      created.push(creative);
    }

    res.json({
      product: { id: product.id, name: product.name, sku: product.sku },
      created,
      copies,
      errors,
      totalCostUsd: created.reduce((s, c) => s + (c.costUsd || 0), 0),
    });
  } catch (err) {
    console.error('[marketing/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// POST /generate-upload — gera criativo a partir de UPLOAD de foto
// (sem produto cadastrado no catálogo). Para marcas como Meta Fardamentos,
// APS, político, etc. Aceita multipart com:
//   - file: foto do produto (jpg/png/webp, max 10MB)
//   - brandSlug: marca da BrandProfile
//   - name: nome do produto/conceito
//   - category, price, description: opcionais
//   - flags de overlay: includeHeadline, includePrice, includeLogo, includeHandle, includeSubline
//   - headline, subline: textos custom
//   - provider, aspectRatio: opções de geração
// ====================================================
router.post('/generate-upload', upload.single('file'), async (req, res) => {
  try {
    const body = req.body || {};
    const mode = body.mode || 'photo'; // 'photo' | 'concept' | 'both'
    const brandSlug = body.brandSlug;
    if (!brandSlug) return res.status(400).json({ error: 'brandSlug obrigatório' });
    const brand = await brandProfiles.getBySlug(brandSlug);
    if (!brand) return res.status(404).json({ error: 'marca não encontrada: ' + brandSlug });

    const description = body.description || '';
    const hasFile = !!req.file;
    const hasDesc = description.trim().length > 0;

    // Validação por modo
    if (mode === 'photo' && !hasFile) return res.status(400).json({ error: 'modo "photo" exige arquivo' });
    if (mode === 'concept' && !hasDesc) return res.status(400).json({ error: 'modo "concept" exige descrição da cena' });

    // 1. Upload da foto (se houver)
    let imageUrl = null;
    if (hasFile) {
      const ext = (req.file.originalname?.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
      const safeName = (body.name || 'produto').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      const filename = `adhoc-${brandSlug}-${Date.now()}-${safeName}.${ext}`;
      imageUrl = await uploadFileToFal(req.file.buffer, filename, req.file.mimetype);
    }

    // 2. Monta product virtual. No modo conceito, imageUrl=null e a descrição
    //    vira sceneHint pra IA gerar tudo do zero (Flux text-to-image puro)
    const virtualProduct = {
      id: null,
      sku: 'adhoc-' + Date.now(),
      name: body.name || 'Conceito',
      brand: brand.displayName,
      category: body.category || '',
      subcategory: '',
      shortDescription: description,
      price: body.price ? parseFloat(body.price) : null,
      imageUrl,
      imageUrls: [],
      aiContext: null,
    };

    const provider = body.provider || 'composite';
    const aspectRatio = body.aspectRatio || '1:1';
    // No modo conceito, a descrição vira a CENA pro Flux background gerar do zero
    const sceneHint = (mode === 'concept' || mode === 'both')
      ? (description || body.sceneHint || '')
      : (body.sceneHint || '');

    // 3. Resolve overlay options
    const includeHeadline = body.includeHeadline === 'true' || body.includeHeadline === true;
    const includePrice    = body.includePrice === 'true'    || body.includePrice === true;
    const includeLogo     = body.includeLogo === 'true'     || body.includeLogo === true;
    const includeHandle   = body.includeHandle === 'true'   || body.includeHandle === true;
    const includeSubline  = body.includeSubline === 'true'  || body.includeSubline === true;
    const headlineRaw = (body.headline || '').toString().trim();
    const headline = includeHeadline
      ? (headlineRaw || autoHeadline(virtualProduct, brand)).slice(0, 60)
      : '';
    const subline = includeSubline ? (body.subline || '').toString().slice(0, 80) : '';

    // Parse de people (FormData manda string JSON ou campos separados)
    let people = null;
    try {
      if (body.people) {
        people = typeof body.people === 'string' ? JSON.parse(body.people) : body.people;
      } else if (body.peopleMode) {
        people = {
          mode: body.peopleMode,
          gender: body.peopleGender || 'any',
          age: body.peopleAge || 'young',
          ethnicity: body.peopleEthnicity || 'mixed',
        };
      }
    } catch (e) { console.warn('[marketing] people parse fail:', e.message); }

    console.log(`[marketing/generate-upload] ${virtualProduct.name} · brand=${brand.slug} · provider=${provider} · people=${people?.mode || 'auto'} · logo=${includeLogo}${includeLogo && !brand.logoUrl ? ' (MAS LOGO VAZIA!)' : ''}`);

    // Overlay opts (valido pra TODOS providers)
    const overlayOptsUpload = {
      includeHeadline, includePrice, includeLogo, includeHandle, includeSubline,
      headline, subline, price: virtualProduct.price,
      logoUrl: includeLogo ? (brand.logoUrl || null) : null,
      handle: includeHandle ? (brand.instagramHandle || '') : '',
    };

    // 4. Roda composite (e/ou outros providers se solicitado)
    const tasks = [];
    if (provider === 'composite' || provider === 'all') {
      tasks.push(
        compositeImage.generateEditorialPhoto({
          product: virtualProduct,
          aspectRatio,
          sceneHint,
          ...overlayOptsUpload,
          people,
        }).then(r => ({ kind: 'editorial_photo', provider: 'composite', ...r }))
      );
    }
    if (provider === 'fal' || provider === 'all') {
      tasks.push(
        falAi.generateEditorialPhoto({ product: virtualProduct, aspectRatio, sceneHint })
          .then(async r => {
            try {
              const newUrl = await compositeImage.applyOverlayToUrl(r.outputUrl, overlayOptsUpload);
              return { kind: 'editorial_photo', provider: 'fal', ...r, outputUrl: newUrl };
            } catch (e) { console.warn('[overlay/fal-upload]', e.message); return { kind: 'editorial_photo', provider: 'fal', ...r }; }
          })
      );
    }
    if (provider === 'openai' || provider === 'all') {
      tasks.push(
        openaiImage.generateEditorialPhoto({ product: virtualProduct, aspectRatio, sceneHint, quality: 'medium' })
          .then(async r => {
            try {
              const newUrl = await compositeImage.applyOverlayToUrl(r.outputUrl, overlayOptsUpload);
              return { kind: 'editorial_photo', provider: 'openai', ...r, outputUrl: newUrl };
            } catch (e) { console.warn('[overlay/openai-upload]', e.message); return { kind: 'editorial_photo', provider: 'openai', ...r }; }
          })
      );
    }

    const settled = await Promise.allSettled(tasks);
    const created = [];
    const errors = [];

    // 5. Gera copy via Claude usando tom da marca ativa (brand já foi carregado)
    let copies = { captionIg: '', captionTiktok: '', captionWa: '', hashtags: '' };
    try {
      copies = await copyGen.generateCopies({
        productName: virtualProduct.name,
        brand: brand.displayName,
        category: virtualProduct.category,
        price: virtualProduct.price,
        shortDesc: virtualProduct.shortDescription,
        sceneHint,
        brandProfile: brand,
      });
    } catch (e) { errors.push({ step: 'copy', error: e.message }); }

    // 6. Salva cada criativo no banco (productId=null, brandProfileId setado, dados ad-hoc preservados)
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        errors.push({ step: 'image_gen', error: result.reason?.message || String(result.reason) });
        continue;
      }
      const r = result.value;
      const creative = await prisma.productCreative.create({
        data: {
          productId: null,
          brandProfileId: brand.id,
          adhocName: virtualProduct.name,
          adhocImageUrl: imageUrl,
          adhocCategory: virtualProduct.category || null,
          adhocPrice: virtualProduct.price || null,
          adhocDesc: virtualProduct.shortDescription || null,
          kind: r.kind,
          outputUrl: r.outputUrl,
          model: r.model,
          prompt: r.prompt,
          costUsd: r.costUsd,
          captionIg: copies.captionIg,
          captionTiktok: copies.captionTiktok,
          captionWa: copies.captionWa,
          hashtags: copies.hashtags,
          status: 'pending_review',
          params: { aspectRatio, sceneHint, provider, brandSlug },
        },
      });
      created.push(creative);
    }

    res.json({
      brand: { slug: brand.slug, displayName: brand.displayName },
      virtualProduct: { name: virtualProduct.name, imageUrl },
      created,
      copies,
      errors,
      totalCostUsd: created.reduce((s, c) => s + (c.costUsd || 0), 0),
    });
  } catch (err) {
    console.error('[marketing/generate-upload]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// POST /generate-collage — monta colagem 2x1/1x2/2x2 a partir de:
//   - panels: array de { productId? OR imageUrl?, label?, sceneHint? }
//   - layout: '2x1' | '1x2' | '2x2'
//   - aspectRatio: '1:1' | '4:5' | '9:16' | '16:9'
//   - brandSlug: marca pra contexto (cores, persona, copy)
//   - generatePanels: true (gera cada painel via composite) | false (usa imageUrls direto)
// ====================================================
router.post('/generate-collage', async (req, res) => {
  try {
    const {
      panels = [],
      layout = '2x2',
      aspectRatio = '1:1',
      brandSlug = null,
      generatePanels = true,
      labelStyle = 'belowImg',
      people = null,
    } = req.body || {};

    if (!Array.isArray(panels) || panels.length < 2) {
      return res.status(400).json({ error: 'Forneca pelo menos 2 paineis em "panels"' });
    }
    if (!['2x1', '1x2', '2x2'].includes(layout)) {
      return res.status(400).json({ error: 'layout deve ser 2x1, 1x2 ou 2x2' });
    }

    const expected = layout === '2x2' ? 4 : 2;
    if (panels.length < expected) {
      return res.status(400).json({ error: `layout ${layout} exige ${expected} paineis, recebi ${panels.length}` });
    }

    // Carrega brand
    let brand = null;
    if (brandSlug) {
      try { brand = await brandProfiles.getBySlug(brandSlug); }
      catch (e) { console.warn('[collage] brand load fail:', e.message); }
    }

    // Pra cada painel, resolver a imagem final (composite ou imageUrl direto)
    const panelInputs = panels.slice(0, expected);
    const resolved = await Promise.all(panelInputs.map(async (p, idx) => {
      let imageUrl = null;
      let label = p.label || '';
      let product = null;

      if (p.productId) {
        product = await prisma.product.findUnique({
          where: { id: p.productId },
          select: { id: true, name: true, brand: true, category: true, price: true, imageUrl: true, imageUrls: true, aiContext: true, sku: true, shortDescription: true },
        });
        if (!product) throw new Error(`Produto ${p.productId} nao encontrado`);
        if (!label) label = product.name?.slice(0, 30) || '';

        if (generatePanels) {
          // Gera composite editorial pra esse produto (cell tamanho aproximado)
          // Aspect ratio dos paineis = quadrado se 2x2/2x1/1x2 (cells sao retangulos)
          const r = await compositeImage.generateEditorialPhoto({
            product,
            aspectRatio: layout === '2x1' ? '1:1' : layout === '1x2' ? '1:1' : '1:1',
            sceneHint: p.sceneHint || '',
            includeHeadline: false, // sem texto no painel (label vem por fora)
            includePrice: false,
            includeLogo: false,
            includeHandle: false,
            includeSubline: false,
            people,
          });
          imageUrl = r.outputUrl;
        } else {
          imageUrl = product.imageUrl;
        }
      } else if (p.imageUrl) {
        imageUrl = p.imageUrl;
      } else {
        throw new Error(`Painel ${idx + 1}: forneca productId OU imageUrl`);
      }

      return { imageUrl, label, product };
    }));

    console.log(`[marketing/generate-collage] layout=${layout} paineis=${resolved.length} brand=${brandSlug || 'none'}`);

    // Monta colagem
    const collageBuf = await collageImage.buildCollage({
      panels: resolved.map(r => ({ imageUrl: r.imageUrl, label: r.label })),
      layout,
      aspectRatio,
      labelStyle,
    });

    // Upload final
    const filename = `collage-${layout}-${Date.now()}.jpg`;
    const outputUrl = await uploadFileToFal(collageBuf, filename, 'image/jpeg');

    // Calcula custo: cada composite gerado custou ~$0.05 (Bria $0.01 + Flux bg $0.04)
    const costUsd = generatePanels ? (resolved.length * 0.05) : 0;

    // Gera copy unica pra colagem (usa primeira marca/produto como base)
    let copies = { captionIg: '', captionTiktok: '', captionWa: '', hashtags: '' };
    const firstProd = resolved.find(r => r.product)?.product;
    try {
      copies = await copyGen.generateCopies({
        productName: firstProd ? `${firstProd.name} (+ ${resolved.length - 1} produtos)` : 'Colagem multi-produto',
        brand: brand?.displayName || firstProd?.brand,
        category: firstProd?.category,
        price: firstProd?.price,
        shortDesc: `Colagem ${layout} mostrando ${resolved.length} produtos`,
        brandProfile: brand,
      });
    } catch (e) { console.warn('[collage] copy gen fail:', e.message); }

    // Salva no banco (productId = primeiro produto se houver; sempre brandProfileId)
    const creative = await prisma.productCreative.create({
      data: {
        productId: firstProd?.id || null,
        brandProfileId: brand?.id || null,
        kind: 'editorial_photo',
        outputUrl,
        model: `collage-${layout}`,
        prompt: `Colagem ${layout} com ${resolved.length} paineis`,
        costUsd,
        captionIg: copies.captionIg,
        captionTiktok: copies.captionTiktok,
        captionWa: copies.captionWa,
        hashtags: copies.hashtags,
        status: 'pending_review',
        adhocName: !firstProd ? `Colagem ${layout}` : null,
        params: {
          layout,
          aspectRatio,
          panels: resolved.map(r => ({ productId: r.product?.id || null, label: r.label })),
          isCollage: true,
        },
      },
    });

    res.json({ creative, copies, costUsd, outputUrl });
  } catch (err) {
    console.error('[marketing/generate-collage]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// POST /generate-collage-upload — colagem com fotos UPLOADADAS
// FormData: files (multi), layout, brandSlug, labels[] (array)
// ====================================================
router.post('/generate-collage-upload', upload.array('files', 4), async (req, res) => {
  try {
    const files = req.files || [];
    const body = req.body || {};
    const layout = body.layout || '2x2';
    const expected = layout === '2x2' ? 4 : 2;
    if (files.length < expected) {
      return res.status(400).json({ error: `layout ${layout} exige ${expected} arquivos, recebi ${files.length}` });
    }
    const aspectRatio = body.aspectRatio || '1:1';
    const brandSlug = body.brandSlug || null;
    let labels = [];
    try { labels = body.labels ? JSON.parse(body.labels) : []; } catch {}

    // Brand
    let brand = null;
    if (brandSlug) {
      try { brand = await brandProfiles.getBySlug(brandSlug); }
      catch {}
    }

    // Upload cada foto pra fal.storage
    const panels = await Promise.all(files.slice(0, expected).map(async (f, idx) => {
      const ext = (f.originalname?.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
      const filename = `collage-input-${Date.now()}-${idx}.${ext}`;
      const url = await uploadFileToFal(f.buffer, filename, f.mimetype);
      return { imageUrl: url, label: labels[idx] || '' };
    }));

    const collageBuf = await collageImage.buildCollage({
      panels,
      layout,
      aspectRatio,
      labelStyle: body.labelStyle || 'belowImg',
    });

    const filename = `collage-upload-${layout}-${Date.now()}.jpg`;
    const outputUrl = await uploadFileToFal(collageBuf, filename, 'image/jpeg');

    const creative = await prisma.productCreative.create({
      data: {
        productId: null,
        brandProfileId: brand?.id || null,
        kind: 'editorial_photo',
        outputUrl,
        model: `collage-upload-${layout}`,
        prompt: `Colagem upload ${layout} (${expected} fotos)`,
        costUsd: 0,
        status: 'pending_review',
        adhocName: `Colagem upload ${layout}`,
        params: { layout, aspectRatio, isCollage: true, fromUpload: true },
      },
    });

    res.json({ creative, outputUrl });
  } catch (err) {
    console.error('[marketing/generate-collage-upload]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// GET /creatives — lista com filtros
// ====================================================
router.get('/creatives', async (req, res) => {
  try {
    const { status, productId, kind, brandSlug, limit = '50' } = req.query;
    const where = {};
    if (status) where.status = String(status);
    if (productId) where.productId = String(productId);
    if (kind) where.kind = String(kind);
    if (brandSlug) {
      const b = await brandProfiles.getBySlug(String(brandSlug));
      if (b) where.brandProfileId = b.id;
    }

    const creatives = await prisma.productCreative.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit, 10) || 50, 200),
      include: {
        product: { select: { id: true, name: true, sku: true, brand: true, category: true, price: true, imageUrl: true } },
        publications: { select: { id: true, platform: true, status: true, externalUrl: true, publishedAt: true } },
      },
    });

    // Pra criativos ad-hoc (productId=null), monta um product virtual a partir
    // dos campos adhoc* salvos. Frontend exibe igual.
    const list = creatives.map(c => {
      if (!c.product && c.adhocName) {
        c.product = {
          id: null,
          name: c.adhocName,
          sku: 'adhoc',
          brand: '',
          category: c.adhocCategory || '',
          price: c.adhocPrice || 0,
          imageUrl: c.adhocImageUrl || null,
        };
      }
      return c;
    });

    res.json({ creatives: list });
  } catch (err) {
    console.error('[marketing/creatives GET]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/creatives/:id', async (req, res) => {
  try {
    const c = await prisma.productCreative.findUnique({
      where: { id: req.params.id },
      include: {
        product: true,
        publications: true,
      },
    });
    if (!c) return res.status(404).json({ error: 'criativo não encontrado' });
    res.json({ creative: c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// PATCH /creatives/:id — aprovar/rejeitar/editar
// ====================================================
// Body: { status?: 'approved'|'rejected', captionIg?, captionTiktok?, captionWa?, hashtags?, rejectionReason? }
router.patch('/creatives/:id', async (req, res) => {
  try {
    const data = {};
    const allowed = ['status', 'captionIg', 'captionTiktok', 'captionWa', 'hashtags', 'rejectionReason'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) data[k] = req.body[k];
    }
    if (data.status && ['approved', 'rejected'].includes(data.status)) {
      data.reviewedById = req.userId;
      data.reviewedAt = new Date();
    }
    const c = await prisma.productCreative.update({ where: { id: req.params.id }, data });
    res.json({ creative: c });
  } catch (err) {
    console.error('[marketing/creatives PATCH]', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/creatives/:id', async (req, res) => {
  try {
    const c = await prisma.productCreative.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'não encontrado' });
    if (c.status === 'published') return res.status(400).json({ error: 'criativo já publicado, não pode apagar' });
    await prisma.productCreative.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// POST /creatives/:id/publish — publica no Instagram (e futuramente outros)
// ====================================================
// Body: { platform: 'instagram', caption?: string (override) }
router.post('/creatives/:id/publish', async (req, res) => {
  try {
    const platform = String(req.body?.platform || 'instagram').toLowerCase();
    const caption = req.body?.caption || null;

    const creative = await prisma.productCreative.findUnique({
      where: { id: req.params.id },
      include: { product: { select: { id: true, name: true, sku: true } } },
    });
    if (!creative) return res.status(404).json({ error: 'criativo não existe' });
    if (creative.status !== 'approved') {
      return res.status(400).json({ error: 'criativo precisa estar approved antes de publicar' });
    }

    // Cria registro de publication (status queued) ANTES de chamar API
    const pub = await prisma.marketingPublication.create({
      data: {
        creativeId: creative.id,
        productId: creative.productId,
        platform,
        caption: caption || creative.captionIg || '',
        mediaUrl: creative.outputUrl,
        status: 'publishing',
        publishedById: req.userId,
      },
    });

    try {
      let result;
      if (platform === 'instagram') {
        const ig = require('../services/instagramPublisher');
        const captionFull = (caption || creative.captionIg || '') + (creative.hashtags ? '\n\n' + creative.hashtags.split(/\s+/).filter(Boolean).map(h => '#' + h.replace(/^#/, '')).join(' ') : '');
        if (creative.kind === 'reel_video') {
          result = await ig.publishReel({ videoUrl: creative.outputUrl, caption: captionFull });
        } else {
          result = await ig.publishPhoto({ imageUrl: creative.outputUrl, caption: captionFull });
        }
      } else {
        throw new Error('platform não suportada ainda: ' + platform);
      }

      // Marca como sucesso
      await prisma.marketingPublication.update({
        where: { id: pub.id },
        data: {
          status: 'success',
          externalId: result.mediaId,
          externalUrl: result.permalink,
          publishedAt: new Date(),
        },
      });
      // Marca o criativo como published
      await prisma.productCreative.update({
        where: { id: creative.id },
        data: { status: 'published' },
      });

      res.json({ success: true, publication: { id: pub.id, externalId: result.mediaId, externalUrl: result.permalink } });
    } catch (apiErr) {
      await prisma.marketingPublication.update({
        where: { id: pub.id },
        data: { status: 'failed', errorMessage: apiErr.message },
      });
      throw apiErr;
    }
  } catch (err) {
    console.error('[marketing/publish]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// GET /publications — histórico
// ====================================================
router.get('/publications', async (req, res) => {
  try {
    const { platform, status, limit = '100' } = req.query;
    const where = {};
    if (platform) where.platform = String(platform);
    if (status) where.status = String(status);
    const pubs = await prisma.marketingPublication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit, 10) || 100, 300),
      include: {
        creative: { include: { product: { select: { id: true, name: true, sku: true, imageUrl: true } } } },
      },
    });
    res.json({ publications: pubs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// GET /stats — KPIs do mês
// ====================================================
router.get('/stats', async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

    const [
      totalGeneratedThisMonth,
      totalApprovedThisMonth,
      totalPublishedThisMonth,
      totalCostThisMonth,
      byStatus,
    ] = await Promise.all([
      prisma.productCreative.count({ where: { createdAt: { gte: startOfMonth } } }),
      prisma.productCreative.count({ where: { createdAt: { gte: startOfMonth }, status: 'approved' } }),
      prisma.productCreative.count({ where: { createdAt: { gte: startOfMonth }, status: 'published' } }),
      prisma.productCreative.aggregate({
        where: { createdAt: { gte: startOfMonth } },
        _sum: { costUsd: true },
      }),
      prisma.productCreative.groupBy({
        by: ['status'],
        _count: true,
      }),
    ]);

    res.json({
      thisMonth: {
        generated: totalGeneratedThisMonth,
        approved: totalApprovedThisMonth,
        published: totalPublishedThisMonth,
        costUsd: totalCostThisMonth._sum.costUsd || 0,
        approvalRate: totalGeneratedThisMonth ? (totalApprovedThisMonth / totalGeneratedThisMonth) : 0,
      },
      byStatus,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
