const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { designIsolationMiddleware } = require('./middleware');
const { publicDomain, canonicalRedirectUrl } = require('./config/publicUrl');
const PUBLIC_DOMAIN = publicDomain();

const authRoutes = require('./routes/auth');
const webauthnRoutes = require('./routes/webauthn');
const faceRoutes = require('./routes/face');
const walletRoutes = require('./routes/wallet');
const transferRoutes = require('./routes/transfer');
const promoRoutes = require('./routes/promo');
const adminRoutes = require('./routes/admin');
const qrRoutes = require('./routes/qr');
const sellerRoutes = require('./routes/seller');
const storesRoutes = require('./routes/stores');
const messagesRoutes = require('./routes/messages');
const sellersRoutes = require('./routes/sellers');
const catalogRoutes = require('./routes/catalog');
const tryonRoutes = require('./routes/tryon');
const aiRoutes = require('./routes/ai');
const adminCatalogRoutes = require('./routes/adminCatalog');
const partnersRoutes = require('./routes/partners');
const creationCampaignsRoutes = require('./routes/creationCampaigns');
const cashbackRedeemRoutes = require('./routes/cashbackRedeem');
const adminAIRoutes = require('./ai/orchestrator/orchestrator.routes');
const lifeRoutes = require('./routes/life');
const labelsRoutes = require('./routes/labels');
const fiscalRoutes = require('./routes/fiscal');
const curationRoutes = require('./routes/curation');
const sellerPortfolioRoutes = require('./routes/sellerPortfolio');
const sellerAgentRoutes = require('./routes/sellerAgent');
const sellerProductionRoutes = require('./routes/sellerProduction');
const sellerScheduleRoutes = require('./routes/sellerSchedule');
const weeklyInterviewRoutes = require('./routes/weeklyInterview');
const xmlImportRoutes = require('./routes/xmlImport');
const recommendationsRoutes = require('./routes/recommendations');
const nuvemshopRoutes = require('./routes/nuvemshop');
const tiktokShopRoutes = require('./routes/tiktokShop');
const shippingRoutes = require('./routes/shipping');
const financialRoutes = require('./routes/financial');
const finRoutes = require('./routes/fin');
const suppliersRoutes = require('./routes/suppliers');
const categoriesRoutes = require('./routes/categories');
const campaignsRoutes = require('./routes/campaigns');
const qrOffersRoutes = require('./routes/qrOffers');
const inventoryRoutes = require('./routes/inventory');
const productImagesRoutes = require('./routes/productImages');
const markupRoutes = require('./routes/markup');
const productsRoutes = require('./routes/products');
const aiCurationRoutes = require('./routes/aiCuration');
const anthropicToolsRoutes = require('./routes/anthropicTools');
const orchestratorRoutes = require('./routes/orchestrator');
const activitiesRoutes = require('./routes/activities');
const coachRoutes = require('./routes/coach');
const tournamentsRoutes = require('./routes/tournaments');
const copaRoutes = require('./routes/copa');
const adminClassificationRoutes = require('./routes/adminClassification');
const adminVitrineRoutes = require('./routes/adminVitrine');
const imagensSiteRoutes = require('./routes/imagensSite');
const reelsAgencyRoutes = require('./routes/reelsAgency');
const whatsappRoutes = require('./routes/whatsapp');
const adminWhatsappRoutes = require('./routes/adminWhatsapp');
const adminScheduleRoutes = require('./routes/adminSchedule');
const pvmRoutes = require('./routes/pvm');
const leadsRoutes = require('./routes/leads');
const securityRoutes = require('./routes/security');
const storeRadioRoutes = require('./routes/storeRadio');
const stocktakeRoutes = require('./routes/stocktake');
const classificationRoutes = require('./routes/classification');
const messagesV2Routes = require('./routes/messagesV2');
const marketingRoutes = require('./routes/marketing');
const marketingConfigRoutes = require('./routes/marketingConfig');
const brandProfilesRoutes = require('./routes/brandProfiles');
const priceCheckRoutes = require('./routes/priceCheck');
const professionalsRoutes = require('./routes/professionals');
const liveCommerceRoutes = require('./routes/liveCommerce');
const infoproductsRoutes = require('./routes/infoproducts');
const desapegaRoutes = require('./routes/desapega');
const mfRoutes = require('./routes/mf'); // Meta Fardamentos — sistema proprio (ERP/CRM/estoque/ponto)
const pagbankRoutes = require('./routes/pagbank');
const stoneRoutes = require('./routes/stone');
const catalogEngineRoutes = require('./routes/catalogEngine');
const servicesRoutes = require('./routes/services');
const servicesPackagesRouter = require('./routes/services-packages');
const servicesFinanceRoutes = require('./routes/services-finance');
const servicesStockRouter = require('./routes/services-stock');
const servicesMarketingRoutes = require('./routes/services-marketing');
const servicesClubRouter = require('./routes/services-club');
const brandProfiles = require('./services/brandProfiles');
const { startMessagesCron } = require('./services/messagesCron');
const { startWhatsappHealthCron, getWhatsappHealthState } = require('./services/whatsappHealthCron');
const { startMarketingCron } = require('./services/marketingCron');
const { startDailyAgentsCron } = require('./services/dailyAgentsCron');
const { startCatalogEngineCron } = require('./services/catalogEngineCron');
const { startNuvemshopStockCron } = require('./services/nuvemshopStockCron');
const { startServicesCron } = require('./services/servicesCron');
const { startEquipeReportsCron } = require('./services/equipeReports');
const { startSellerProductionCron } = require('./services/sellerProductionCron');
const { startQROffersCron } = require('./services/qrOffersCron');
const { startImageRepairCron } = require('./services/imageRepairCron');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Compressão gzip — reduz payload da listagem de produtos em ~70%
// Threshold 1KB pra não desperdiçar CPU em respostas pequenas
app.use(compression({ threshold: 1024 }));

// Segurança — referrer policy ajustada pra CDNs externos (moovin/vtex/simplo7
// bloqueiam hotlink quando Referer está vazio). 'strict-origin-when-cross-origin'
// envia só o origin pra HTTPS, o suficiente pros CDNs liberarem a imagem.
app.use(helmet({
  contentSecurityPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Redirect canônico pro domínio principal (OPT-IN via env CANONICAL_HOST).
// Desligado por padrão: sem a env, nada muda. Quando o dono setar
// CANONICAL_HOST=clubsportsetennis.com.br, os hosts antigos (teniscash + www)
// fazem 301 pro novo — SÓ páginas GET/HEAD; /api, /webhooks, /oauth e
// /.well-known ficam de fora (não quebra OAuth/webhook/integração).
const CANONICAL_HOST = String(process.env.CANONICAL_HOST || '').trim().toLowerCase();
if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    try {
      const dest = canonicalRedirectUrl({
        host: req.hostname,
        method: req.method,
        path: req.path,
        originalUrl: req.originalUrl,
        canonicalHost: CANONICAL_HOST,
      });
      return dest ? res.redirect(301, dest) : next();
    } catch (_) { return next(); }
  });
}
app.use(express.json({
  // 1.5mb pra acomodar foto/audio em base64 do /api/messages-v2
  limit: '1.5mb',
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/whatsapp/webhook')) {
      req.rawBody = buf;
    }
  },
}));

function isCameraAssetPath(pathname) {
  return /^\/(?:api\/)?live\/camera\//.test(pathname || '')
    || /^\/(?:api\/)?admin\/security\/camera-live\//.test(pathname || '');
}

// HLS precisa de um limite separado: uma pagina com varias cameras faz muitas
// requisicoes curtas e nao pode consumir o limite das rotas de cadastro.
const cameraLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !isCameraAssetPath(req.path),
  message: { error: 'Muitas requisicoes de video. Aguarde alguns minutos.' },
});
app.use('/api/', cameraLimiter);

// Rate limiting global — generoso pra não travar admin trabalhando em massa,
// mas o suficiente pra bloquear scripts maliciosos.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 3000, // ~3 req/seg sustentado por 15 min
  standardHeaders: true,
  legacyHeaders: false,
  // Pula rotas administrativas internas com auth (já protegidas via authMiddleware+adminMiddleware)
  // HLS de cameras gera muitas requisicoes curtas por minuto. Ele possui
  // controles proprios e nao pode consumir o limite das rotas de cadastro,
  // login e WhatsApp do mesmo endereco IP.
  skip: (req) => {
    const path = req.path || '';
    return (
      /^\/(?:api\/)?admin\//.test(path)
      || /^\/(?:api\/)?radio\//.test(path)
      || /^\/(?:api\/)?labels\//.test(path)
      || /^\/(?:api\/)?auth\/agent-camera-live(?:\/|$)/.test(path)
      || isCameraAssetPath(path)
    );
  },
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});
app.use('/api/', limiter);

// Rate limiting mais restrito SÓ para login (anti força-bruta)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Isenta os endpoints de AGENTE (token-auth, NAO login) — senao os heartbeats dos
  // Supervisores (a cada 45s, varias maquinas) + o instalador estouram 20/15min e travam o rollout.
  skip: (req) => /\/agent-(update|control|capture|camera-segment|camera-live)(\/|$|\?)/.test(req.originalUrl || req.url || ''),
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});
app.use('/api/auth/', authLimiter);

// Enforce the current product-only role before legacy routers with independent
// JWT validation. Anonymous/public traffic and service webhook keys keep their
// original authentication flow.
app.use('/api', designIsolationMiddleware);

// Rotas
// TEMPORÁRIO (remover após uso): re-pull foto 2026 COM COR, fora de /api/admin. Guard por ?g=.
app.post('/api/_px2026col', aiCurationRoutes.pull2026ColHandler);
app.post('/api/_catengine', catalogEngineRoutes.catEngineRunHandler); // motor de catálogo (teste/cron guardado)
// Leitura PÚBLICA (read-only, sem login) da pauta do loop — pro dono ver no /loop.html.
// Token próprio 'stloop2026' (≠ reinado2026) — NÃO destrava nada que gera custo.
app.get('/api/_loopview', async (req, res) => {
  if (req.query.g !== 'stloop2026') return res.status(403).json({ error: 'forbidden' });
  try {
    const loop = require('./services/marketingLoop');
    const state = await loop.getLoopState();
    const slate = await loop.getLoopSlate();
    res.json({
      ok: true,
      learnings: state.learnings || '',
      learningsUpdatedAt: state.learningsUpdatedAt || null,
      lastBrainAt: state.lastBrainAt || null,
      brain: loop.BRAIN_MODEL,
      slate,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// TEMPORÁRIO (remover após uso): diagnóstico "por que o cupom não sai" — READ-ONLY,
// roda NO SERVIDOR (tem banco + enxerga os agentes das lojas). O dono abre no navegador.
app.get('/api/_fiscaldiag', async (req, res) => {
  if (req.query.g !== 'stxdiag2026') return res.status(403).json({ error: 'forbidden' });
  try {
    const { prisma } = require('./middleware');
    const { buildFiscalDiagnoseReport } = require('./services/fiscalDiagnose');
    const report = await buildFiscalDiagnoseReport(prisma);
    res.set('Content-Type', 'text/plain; charset=utf-8').send(report);
  } catch (e) {
    res.status(500).set('Content-Type', 'text/plain; charset=utf-8').send('ERRO: ' + e.message);
  }
});
// TEMPORÁRIO (remover após uso): teste fiscal de UMA loja. Sem &emit=1 é READ-ONLY
// (config do emissor + bloco <emit> da última nota autorizada vs a última rejeitada).
// Com &emit=1&nnf=9000NN emite NFC-e de R$1 pela máquina da loja e CANCELA na hora.
app.get('/api/_fiscaltest', async (req, res) => {
  if (req.query.g !== 'stxdiag2026') return res.status(403).json({ error: 'forbidden' });
  try {
    const { prisma } = require('./middleware');
    const agentClient = require('./services/fiscalAgentClient');
    const code = String(req.query.store || 'LOJA05');
    const store = await prisma.store.findUnique({ where: { code }, include: { fiscalIssuer: true } });
    if (!store || !store.fiscalIssuer) return res.status(404).json({ error: 'loja/emissor nao achado' });
    const pick = (i) => ({ cnpj: i.cnpj, ie: i.ie, crt: i.crt, companyName: i.companyName, cityCode: i.cityCode, city: i.city, state: i.state, zip: i.zip, environment: i.environment, active: i.active, cscId: i.cscId, hasCsc: !!i.csc, nfceSerie: i.nfceSerie, nfceNextNumber: i.nfceNextNumber, updatedAt: i.updatedAt });
    const allIssuers = (await prisma.fiscalIssuer.findMany({ orderBy: { cnpj: 'asc' } })).map(pick);
    const emitBlock = (xml) => { const m = String(xml || '').match(/<emit>[\s\S]*?<\/emit>/); return m ? m[0] : null; };
    const ideBlock = (xml) => { const m = String(xml || '').match(/<ide>[\s\S]*?<\/ide>/); return m ? m[0] : null; };
    const lastOk = await prisma.fiscalDocument.findFirst({ where: { issuerId: store.fiscalIssuerId, docType: 'NFCE', status: 'authorized' }, orderBy: { createdAt: 'desc' } });
    const lastBad = await prisma.fiscalDocument.findFirst({ where: { issuerId: store.fiscalIssuerId, docType: 'NFCE', status: 'rejected' }, orderBy: { createdAt: 'desc' } });
    const badResp = (lastBad && lastBad.response) || {};
    const out = {
      store: { code: store.code, name: store.name, fiscalAgentUrl: store.fiscalAgentUrl, fiscalAgentEnabled: store.fiscalAgentEnabled },
      issuer: pick(store.fiscalIssuer),
      allIssuers,
      lastAuthorized: lastOk && { number: lastOk.number, createdAt: lastOk.createdAt, emit: emitBlock(lastOk.xmlContent), ide: ideBlock(lastOk.xmlContent) },
      lastRejected: lastBad && { number: lastBad.number, createdAt: lastBad.createdAt, emit: emitBlock(badResp.xmlSigned || badResp.xml), ide: ideBlock(badResp.xmlSigned || badResp.xml), respKeys: Object.keys(badResp) },
    };
    if (req.query.emit === '1') {
      const nNF = parseInt(req.query.nnf, 10);
      if (!(nNF >= 900000 && nNF < 1000000)) return res.status(400).json({ error: 'nnf de teste obrigatorio (900000-999999)' });
      out.health = await agentClient.ping(store).catch((e) => ({ ok: false, error: e.message }));
      const emit = await agentClient.emitNFCe(store, {
        issuer: store.fiscalIssuer, nNF,
        items: [{ sku: 'TESTE', name: 'TESTE EMISSAO ' + code, ncm: '64041100', cfop: '5102', unidade: 'UN', qty: 1, unitPrice: 1.00 }],
        payments: [{ tPag: '01', valor: 1.00 }],
      });
      out.testEmit = { ok: emit.ok, status: emit.status, motivo: emit.motivo, error: emit.error, accessKey: emit.accessKey, emit: emitBlock(emit.xmlSigned), ide: ideBlock(emit.xmlSigned) };
      if (emit.ok && String(emit.status) === '100') {
        const prot = emit.protocol || (String(emit.rawResponse || '').match(/<nProt>(\d+)<\/nProt>/) || [])[1];
        const c = await agentClient.cancel(store, { issuer: store.fiscalIssuer, accessKey: emit.accessKey, protocol: prot, reason: 'Teste de emissao da loja - cancelamento imediato' });
        out.testCancel = { ok: c.ok, status: c.status, motivo: c.motivo, error: c.error };
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// TEMPORÁRIO (remover junto com /api/_fiscaldiag): manda TODOS os agentes
// fiscais se auto-atualizarem AGORA (POST /selfupdate com o token do banco).
// Usado pra subir o agente v2.4-certinfo sem ninguém ir nas lojas.
app.post('/api/_agentpush', async (req, res) => {
  if (req.query.g !== 'stxdiag2026') return res.status(403).json({ error: 'forbidden' });
  try {
    const { prisma } = require('./middleware');
    const stores = await prisma.store.findMany({
      where: { fiscalAgentUrl: { not: null }, fiscalAgentToken: { not: null } },
      select: { code: true, fiscalAgentUrl: true, fiscalAgentToken: true },
      orderBy: { code: 'asc' },
    });
    const results = {};
    await Promise.all(stores.map(async (s) => {
      try {
        const r = await fetch(s.fiscalAgentUrl.replace(/\/$/, '') + '/selfupdate', {
          method: 'POST',
          headers: { 'X-Agent-Token': s.fiscalAgentToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: req.query.force === '1' }),
          signal: AbortSignal.timeout(45000),
        });
        results[s.code] = await r.json();
      } catch (e) { results[s.code] = { ok: false, error: e.message }; }
    }));
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// TEMPORÁRIO (remover após uso): roda o cérebro do loop de marketing em prod + retorna resumo. Guard ?g=.
app.post('/api/_loopbrain', async (req, res) => {
  if (req.query.g !== 'reinado2026') return res.status(403).json({ error: 'forbidden' });
  try {
    const loop = require('./services/marketingLoop');
    const slate = await loop.runBrain({ ctx: req.query.ctx || undefined });
    res.json({ ok: true, total: slate.total, brain: slate.brain, errors: slate.errors, sample: (slate.itens || []).slice(0, 2).map((i) => ({ conta: i.conta, produto: i.produto || i.tipo, gancho: i.gancho, voz: i.voz, horario: i.horario })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// TEMPORÁRIO (remover após uso): gera 1 foto editorial premium server-side (Railway tem FAL_KEY). Guard ?g=.
app.post('/api/_falgen', async (req, res) => {
  if (req.query.g !== 'reinado2026') return res.status(403).json({ error: 'forbidden' });
  const keys = { falKey: !!process.env.FAL_KEY, openaiKey: !!process.env.OPENAI_API_KEY };
  try {
    const { prisma } = require('./middleware');
    const eng = String(req.query.engine || 'composite');
    const svc = eng === 'openai' ? require('./services/openaiImage') : eng === 'fal' ? require('./services/falAi') : require('./services/compositeImage');
    const product = req.query.pid ? await prisma.product.findUnique({ where: { id: String(req.query.pid) } }) : null;
    if (req.query.concept === '1') {
      // MODO CONCEITO/ESTADO: cena com PESSOA usando o produto (Flux text-to-image puro, sem compositar)
      const people = { mode: 'specific', gender: req.query.gender || 'any', age: req.query.age || 'young', ethnicity: req.query.eth || 'mixed' };
      const ci = require('./services/compositeImage');
      const r = await ci.generateEditorialPhoto({
        productName: (product && product.name) || req.query.pn || 'lifestyle sneakers',
        brand: (product && product.brand) || '',
        aspectRatio: req.query.ar || '9:16',
        sceneHint: req.query.scene || '',
        people,
      });
      return res.json({ ok: true, mode: 'concept', outputUrl: r.outputUrl, ...keys });
    }
    if (req.query.op === 'music') {
      // TRILHA: gera musica instrumental (fal stable-audio) por mood. Nao precisa de produto.
      const fal = require('./services/falAi');
      const r = await fal.generateMusic({ prompt: req.query.prompt || 'cinematic instrumental', seconds: parseInt(req.query.sec || '12', 10) });
      return res.json({ ok: true, op: 'music', outputUrl: r.outputUrl, ...keys });
    }
    if (req.query.op === 'tts') {
      // VOZ DA MARCA (ElevenLabs via fal). Le o roteiro REAL. Nao precisa de produto.
      const fal = require('./services/falAi');
      const text = req.query.text || (req.body && req.body.text);
      if (!text) return res.status(400).json({ error: 'falta text', ...keys });
      const r = await fal.generateVoice({
        text,
        voice: req.query.voice || 'Rachel',
        languageCode: req.query.lang || 'pt',
        speed: parseFloat(req.query.speed || '0.95'),
        stability: req.query.stab ? parseFloat(req.query.stab) : 0.45,
        style: req.query.style ? parseFloat(req.query.style) : 0.3,
      });
      return res.json({ ok: true, op: 'tts', voice: r.voice, outputUrl: r.outputUrl, costUsd: r.costUsd, ...keys });
    }
    if (req.query.op === 'cena') {
      // CENA LIVRE text-to-image (gpt-image-1). Nao precisa de produto. Devolve b64 direto
      // (sem fal storage no caminho — fal retornou 403 em 2026-07-05).
      const fp = String(req.query.fp || '');
      if (!fp) return res.status(400).json({ error: 'falta fp', ...keys });
      const rr = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-1', prompt: fp, size: '1024x1536', quality: String(req.query.q || 'medium') }),
      });
      const jj = await rr.json();
      if (!rr.ok) return res.json({ ok: false, error: String((jj.error && jj.error.message) || 'openai error').slice(0, 200), ...keys });
      return res.json({ ok: true, op: 'cena', b64: (jj.data && jj.data[0] && jj.data[0].b64_json) || null, ...keys });
    }
    if (req.query.op === 'video') {
      // VIDEO image-to-video. Nao precisa de produto: aceita imgUrl direto.
      // model=veo -> Google Veo 3.1 com AUDIO NATIVO (fp = prompt). senao Hailuo (produto em movimento).
      const fal = require('./services/falAi');
      // POLL por rid NAO precisa de imagem (so consulta a fila). Fica no topo.
      if (req.query.model === 'veo' && req.query.rid) {
        const p = await fal.pollVeoVideo({ requestId: req.query.rid });
        return res.json({ ok: true, op: 'video', model: 'veo', status: p.status, outputUrl: p.outputUrl || null, ...keys });
      }
      const imageUrl = req.query.imgUrl || (product && product.imageUrl);
      if (!imageUrl) return res.status(400).json({ error: 'falta imgUrl', ...keys });
      if (req.query.model === 'veo') {
        // FILA (evita 524 do Cloudflare): submit devolve requestId; depois poll com &rid=.
        const r = await fal.submitVeoVideo({
          imageUrl,
          prompt: req.query.fp || 'cinematic vertical shot, natural realistic motion, premium sports brand commercial, native ambient audio',
          duration: (req.query.sec || '8') + 's',
          aspectRatio: req.query.ar || '9:16',
          resolution: req.query.res || '1080p',
        });
        return res.json({ ok: true, op: 'video', model: r.model, requestId: r.requestId, costUsd: r.costUsd, ...keys });
      }
      const r = await fal.generateReelVideo({ imageUrl, productName: String((product && product.name) || req.query.name || 'produto').slice(0, 60), duration: parseInt(req.query.sec || '6', 10) });
      return res.json({ ok: true, op: 'video', model: r.model, outputUrl: r.outputUrl, costUsd: r.costUsd, ...keys });
    }
    if (req.query.op === 'gbglist') {
      // Lista modelos Gemini com geração de imagem disponíveis pra GOOGLE_API_KEY.
      const rr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${process.env.GOOGLE_API_KEY}`);
      const jj = await rr.json();
      const names = ((jj && jj.models) || []).map(m => m.name).filter(n => /image|imagen/i.test(n));
      return res.json({ ok: rr.ok, models: names, error: jj.error && jj.error.message, ...keys });
    }
    if (req.query.op === 'gbg') {
      // FUNDO LIVRE via Gemini (GOOGLE_API_KEY). fp no body. ar = 4:5 | 9:16 | 3:4 ... gm = modelo.
      const fp = String((req.body && req.body.fp) || req.query.fp || '');
      if (!fp) return res.status(400).json({ error: 'falta fp', ...keys });
      const gm = String(req.query.gm || 'gemini-2.5-flash-image');
      const rr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gm)}:generateContent?key=${process.env.GOOGLE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fp }] }],
          generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: String(req.query.ar || '4:5') } },
        }),
      });
      const jj = await rr.json();
      const parts = (jj && jj.candidates && jj.candidates[0] && jj.candidates[0].content && jj.candidates[0].content.parts) || [];
      const imgPart = parts.find(p => p.inlineData || p.inline_data);
      const data = imgPart && (imgPart.inlineData || imgPart.inline_data);
      if (!data) return res.json({ ok: false, model: gm, error: String((jj.error && jj.error.message) || (jj.candidates && jj.candidates[0] && jj.candidates[0].finishReason) || 'sem imagem').slice(0, 300), ...keys });
      return res.json({ ok: true, op: 'gbg', model: gm, mime: data.mimeType || data.mime_type, b64: data.data, ...keys });
    }
    if (req.query.op === 'bg') {
      // FUNDO LIVRE text-to-image via fal (campanha sem produto/pessoa). fp = prompt (query ou body).
      // model=nano -> fal-ai/nano-banana (aceita 4:5); padrao flux-pro v1.1 ultra (3:4 / 9:16, alta resolucao).
      const fp = String(req.query.fp || (req.body && req.body.fp) || '');
      if (!fp) return res.status(400).json({ error: 'falta fp', ...keys });
      const { fal } = await import('@fal-ai/client');
      fal.config({ credentials: process.env.FAL_KEY });
      const nano = req.query.model === 'nano';
      const model = nano ? 'fal-ai/nano-banana' : 'fal-ai/flux-pro/v1.1-ultra';
      const input = nano
        ? { prompt: fp, num_images: 1, output_format: 'png', aspect_ratio: String(req.query.ar || '4:5') }
        : { prompt: fp, num_images: 1, output_format: 'png', aspect_ratio: String(req.query.ar || '3:4'), raw: req.query.raw === '1', safety_tolerance: '2' };
      const r = await fal.subscribe(model, { input, logs: false });
      const img = r && r.data && r.data.images && r.data.images[0];
      return res.json({ ok: !!img, op: 'bg', model, outputUrl: img ? img.url : null, ...keys });
    }
    if (!product) return res.status(404).json({ error: 'produto nao encontrado', ...keys });
    if (req.query.op === 'worn') {
      // EDITOR FIEL (nano-banana/Gemini): PESSOA usando o produto REAL — fiel + tamanho certo
      const fal = require('./services/falAi');
      const r = await fal.generateWornScene({ product, fullPrompt: req.query.fp || '', scene: req.query.scene || '', aspectRatio: req.query.ar || '9:16' });
      return res.json({ ok: true, op: 'worn', model: r.model, outputUrl: r.outputUrl, ...keys });
    }
    if (req.query.op === 'studio') {
      // ESTUDIO DE LUXO (nano-banana): re-fotografa o produto REAL numa cena nivel Gucci/LV
      const fal = require('./services/falAi');
      const setup = req.query.scene ? String(req.query.scene)
        : 'an elegant refined three-quarter angle on a SEAMLESS studio backdrop with a soft warm grey-to-bone gradient (no horizon line), soft directional studio light from upper left, a gentle realistic contact shadow and a subtle soft reflection on a smooth matte surface';
      const prompt = req.query.fp ? String(req.query.fp)
        : ('Luxury fashion house product photography of THESE EXACT sneakers shown in the reference image, in the style of a Gucci or Louis Vuitton e-commerce campaign. SETUP: '
        + setup + '. Minimal high-end still life, lots of empty negative space, soft premium lighting. '
        + 'CRITICAL: keep the sneakers ABSOLUTELY IDENTICAL to the reference — same model, colors, materials, logo, stitching and proportions — at correct realistic scale. Photorealistic, premium, no text, no extra objects, no people.');
      const r = await fal.generateWornScene({ product, fullPrompt: prompt, aspectRatio: req.query.ar || '4:5' });
      return res.json({ ok: true, op: 'studio', model: r.model, outputUrl: r.outputUrl, ...keys });
    }
    if (req.query.op === 'removebg') {
      const fal = require('./services/falAi');
      const rb = await fal.removeBackground({ imageUrl: product.imageUrl });
      return res.json({ ok: true, op: 'removebg', outputUrl: rb.outputUrl, ...keys });
    }
    const r = await svc.generateEditorialPhoto({ product, aspectRatio: req.query.ar || '4:5', sceneHint: req.query.scene || '', quality: 'medium' });
    return res.json({ ok: true, engine: eng, outputUrl: r.outputUrl, ...keys });
  } catch (e) {
    return res.json({ ok: false, error: String(e.message).slice(0, 200), ...keys });
  }
});
app.use('/api/auth', authRoutes);
app.use('/api/webauthn', webauthnRoutes);
app.use('/api/face', faceRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/transfer', transferRoutes);
app.use('/api/promos', promoRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/stores', storesRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/sellers', sellersRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/tryon', tryonRoutes);

// POST /api/locate — LocateAnything: detecta qualquer objeto em imagem por texto.
// Body: { imageUrl?, imageBase64?, query, many?: string[] }
// Retorna: { bbox, found } ou { results: {[query]: bbox} } se many
app.post('/api/locate', async (req, res) => {
  try {
    const la = require('./services/locateAnything');
    const { imageUrl, imageBase64, query, many } = req.body || {};
    const src = imageBase64 || imageUrl;
    if (!src) return res.status(400).json({ error: 'imageUrl ou imageBase64 obrigatório' });
    if (Array.isArray(many) && many.length) {
      const results = await la.locateMany(src, many);
      return res.json({ results });
    }
    if (!query) return res.status(400).json({ error: 'query obrigatório' });
    const bbox = await la.locate(src, query);
    res.json({ bbox, found: !!bbox });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.use('/api/ai', aiRoutes);
app.use('/api/admin/catalog', adminCatalogRoutes);
app.use('/api/admin/whatsapp', adminWhatsappRoutes);
app.use('/api/admin/schedule', adminScheduleRoutes);
app.use('/api/admin/pvm', pvmRoutes);
app.use('/api/admin/leads', leadsRoutes);
app.use('/api/admin/ai', adminAIRoutes);
app.use('/api/life', lifeRoutes);
app.use('/api/admin/labels', labelsRoutes);
// Etiquetas no balcão: MESMO router, mas FORA de /api/admin (que bloqueia não-admin).
// Aqui vendedores (seller) e contas de loja (store) acessam — o gate labelAccess
// dentro do router faz o controle. Usado pela página /etiquetas do portal das lojas.
app.use('/api/labels', labelsRoutes);
app.use('/api/admin/fiscal', fiscalRoutes);
app.use('/api/admin/curation', curationRoutes);
app.use('/api/seller/portfolio', sellerPortfolioRoutes);
app.use('/api/seller/agent', sellerAgentRoutes);
app.use('/api/seller/production', sellerProductionRoutes);
app.use('/api/seller/schedule', sellerScheduleRoutes);
app.use('/api/seller/interview', weeklyInterviewRoutes);
app.use('/api/admin/xml', xmlImportRoutes);
app.use('/api/admin/recommendations', recommendationsRoutes);
app.use('/api/admin/financial', financialRoutes);
app.use('/api/fin', finRoutes); // financeiro do varejo (plano de contas, contas, auditoria)
app.use('/api/admin/security', securityRoutes);
app.use('/api/admin/store-radio', storeRadioRoutes);
// Player da rádio: mesmo router, mas FORA de /api/admin (autentica pela chave fixa da loja, sem token).
app.use('/api/radio', storeRadioRoutes);
app.use('/api/admin/suppliers', suppliersRoutes);
app.use('/api/admin/categories', categoriesRoutes);
app.use('/api/admin/campaigns', campaignsRoutes);
app.use('/api/admin/qr-offers', qrOffersRoutes.adminRouter);
app.use(qrOffersRoutes.publicRouter);
app.use('/api/admin/inventory', inventoryRoutes);
app.use('/api/admin/product-images', productImagesRoutes);
app.use('/api/admin/markup', markupRoutes);
app.use('/api/admin/products', productsRoutes);
app.use('/api/admin/ai-curation', aiCurationRoutes);
app.use('/api/admin/catalog-engine', catalogEngineRoutes);
app.use('/api/admin/anthropic-tools', anthropicToolsRoutes);
app.use('/api/admin/orchestrator', orchestratorRoutes);
app.use('/api/admin/classification', adminClassificationRoutes);
app.use('/api/admin/vitrine', adminVitrineRoutes);
app.use('/api/admin/imagens-site', imagensSiteRoutes);
app.use('/api/admin/reels-agency', reelsAgencyRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/coach', coachRoutes);
app.use('/api/tournaments', tournamentsRoutes);
app.use('/api/copa', copaRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/stocktake', stocktakeRoutes);
app.use('/api/scan-transfers', require('./routes/scanTransfers'));
app.use('/api/classification', classificationRoutes);
app.use('/api/messages-v2', messagesV2Routes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/marketing-config', marketingConfigRoutes);
app.use('/api/brand-profiles', brandProfilesRoutes);
app.use('/api/price-check', priceCheckRoutes);
app.use('/api/professionals', professionalsRoutes);
app.use('/api/live', liveCommerceRoutes);
app.use('/api/infoproducts', infoproductsRoutes);
app.use('/api/desapega', desapegaRoutes);
app.use('/api/mf', mfRoutes); // Meta Fardamentos — API isolada (so tabelas Mf*)
app.use('/api/pagbank', pagbankRoutes); // webhook PIX PagBank + status (fora de /api/admin)
app.use('/api/stone', stoneRoutes); // maquininha Stone integrada: webhook + status + config (fora de /api/admin)
app.use('/api/services', servicesRoutes); // agendamento + marketplace + T$ no serviço
app.use('/api/services', servicesPackagesRouter);
app.use('/api/services', servicesFinanceRoutes);
app.use('/api/services', servicesStockRouter);
app.use('/api/services', servicesMarketingRoutes);
app.use('/api/services', servicesClubRouter);
// Seed inicial das 9 marcas (idempotente)
brandProfiles.seedDefaults().catch(e => console.warn('[brandProfiles] seed falhou:', e.message));
app.use('/api', nuvemshopRoutes);
app.use('/api', tiktokShopRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api', partnersRoutes);
app.use('/api', creationCampaignsRoutes);
app.use('/api', cashbackRedeemRoutes);

// Health check
// =====================================================================
// Ponte WhatsApp (não-oficial): fila de saída puxada pela ponte externa.
// Protegido pela WA_BRIDGE_KEY (sem a chave configurada, 503 — desligado).
// =====================================================================
function waAuth(req) {
  const key = process.env.WA_BRIDGE_KEY;
  if (!key) return false;
  const got = (req.query && req.query.key) || (req.body && req.body.key) || '';
  return String(got) === String(key);
}
app.get('/api/wa/pending', async (req, res) => {
  try {
    if (!process.env.WA_BRIDGE_KEY) return res.status(503).json({ error: 'whatsapp desligado' });
    if (!waAuth(req)) return res.status(401).json({ error: 'chave inválida' });
    const { prisma } = require('./middleware');
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const rows = await prisma.whatsAppOutbox.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: limit });
    res.json({ messages: rows.map((r) => ({ id: r.id, phone: r.phone, body: r.body })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/wa/sent', async (req, res) => {
  try {
    if (!process.env.WA_BRIDGE_KEY) return res.status(503).json({ error: 'whatsapp desligado' });
    if (!waAuth(req)) return res.status(401).json({ error: 'chave inválida' });
    const { prisma } = require('./middleware');
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: 'id obrigatório' });
    await prisma.whatsAppOutbox.updateMany({
      where: { id: String(b.id) },
      data: b.ok ? { status: 'SENT', sentAt: new Date(), error: null } : { status: 'FAILED', error: b.error ? String(b.error).slice(0, 300) : 'falhou' },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Teste de envio pela Cloud API oficial (eu disparo daqui p/ validar). Guardado por WA_BRIDGE_KEY.
app.post('/api/wa/test', async (req, res) => {
  try {
    const key = process.env.WA_BRIDGE_KEY;
    const got = (req.query && req.query.key) || (req.body && req.body.key) || '';
    if (!key || String(got) !== String(key)) return res.status(401).json({ error: 'chave inválida' });
    const whatsappCloud = require('./services/whatsappCloud');
    if (!whatsappCloud.enabled()) return res.status(503).json({ error: 'cloud desligado (faltam WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)' });
    const to = (req.query && req.query.to) || (req.body && req.body.to);
    if (!to) return res.status(400).json({ error: 'informe to=<telefone>' });
    const text = (req.body && req.body.text) || 'Teste TenisCash — WhatsApp oficial funcionando.';
    const r = await whatsappCloud.sendNotification(to, text);
    res.status(r.ok ? 200 : 400).json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Status da config do WhatsApp (sem vazar segredo): o que falta ligar.
app.get('/api/wa/status', (req, res) => {
  const whatsappCloud = require('./services/whatsappCloud');
  res.json({
    cloudOficial: whatsappCloud.enabled(),
    temToken: !!process.env.WHATSAPP_TOKEN,
    temPhoneId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
    template: process.env.WHATSAPP_TEMPLATE || 'hello_world',
    chaveTeste: !!process.env.WA_BRIDGE_KEY,
  });
});

app.get('/api/health', (req, res) => {
  let nuvemshopCatalog = null;
  try {
    nuvemshopCatalog = require('./services/nuvemshopStockCron').getNuvemshopCronState();
    if (nuvemshopCatalog.automation) {
      const automation = nuvemshopCatalog.automation;
      nuvemshopCatalog.automation = { version: automation.version, lastCheckedAt: automation.lastCheckedAt,
        ordersChecked: automation.orders.length, errors: automation.errors.length, webhooks: !!automation.webhooks };
    }
  } catch (_) {}
  let qrOffers = null;
  try { qrOffers = require('./services/qrOffersCron').getQROffersCronState(); } catch (_) {}
  let imageRepair = null;
  try { imageRepair = require('./services/imageRepairCron').getImageRepairCronState(); } catch (_) {}
  let waHealth = null;
  try { waHealth = getWhatsappHealthState(); } catch (_) {}
  res.json({
    status: 'ok',
    service: 'TenisCash API',
    version: '1.0.0',
    nuvemshopCatalog,
    qrOffers,
    imageRepair,
    waHealth,
    scannerPipeline: 'durable-queue-v1',
    scannerRuntime: process.versions.node,
  });
});

async function proxyContabilidade(req, res) {
  const baseUrl = (process.env.CONTABILIDADE_URL || '').replace(/\/$/, '');

  if (!baseUrl) {
    return res.status(503).send('Modulo contabil ainda nao configurado.');
  }

  try {
    const targetUrl = new URL(req.originalUrl, baseUrl);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];

    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      redirect: 'manual',
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    return res.send(buffer);
  } catch (e) {
    console.error('[contabilidade] proxy falhou:', e.message);
    return res.status(502).send('Modulo contabil indisponivel.');
  }
}

app.use('/contabilidade', proxyContabilidade);

// =====================================================================
// Streaming do VÍDEO do produto — PÚBLICO (a PDP do cliente precisa carregar
// sem login). Lê do volume e suporta HTTP Range (player dá seek/play sem baixar
// o arquivo todo). resolvePublic trava path-traversal.
// =====================================================================
const productVideoStore = require('./services/productVideoStore');
app.get('/media/product-video/:file', (req, res) => {
  try {
    const fpath = productVideoStore.resolvePublic(req.params.file);
    if (!fpath) return res.status(404).send('vídeo não encontrado');
    const fsx = require('fs');
    const total = fsx.statSync(fpath).size;
    const ext = String(req.params.file).split('.').pop().toLowerCase();
    const mime = ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
      if (start > end) { start = 0; end = total - 1; }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      return fsx.createReadStream(fpath, { start, end }).pipe(res);
    }
    res.setHeader('Content-Length', total);
    fsx.createReadStream(fpath).pipe(res);
  } catch (err) {
    console.error('[media/product-video] erro:', err.message);
    if (!res.headersSent) res.status(500).send('erro ao servir vídeo');
  }
});

// Servir frontend (produção)
const path = require('path');

// Site proprio da loja Praia de Tambau. O dominio exclusivo abre a
// transmissao diretamente, sem depender da plataforma de e-commerce.
app.get('/', (req, res, next) => {
  if (String(req.hostname || '').toLowerCase() !== 'praiadetambau.sportsetennis.com.br') return next();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.sendFile(path.join(__dirname, '../public/praiadetambau.html'), { cacheControl: false });
});

// Domínio clubsportsetennis.com.br = mesmo sistema com a marca Sports & Tennis.
const siteBrand = require('./services/siteBrand');
siteBrand.mount(app);

app.get(['/transferencia','/transferencia/'], (_req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(__dirname,'../public/transferencia.html'),{cacheControl:false});});
app.use(express.static(path.join(__dirname, '../public'), {
  // ETag pro browser revalidar; imagens estáticas cacheiam normal,
  // arquivos com ?v=NNN são cacheados forever (immutable).
  etag: true,
  lastModified: true,
  setHeaders(res, filePath, stat) {
    // JS/CSS sem query string → must-revalidate; com query string → immutable
    if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (/\.html$/.test(filePath)) {
      // HTML é o ponto de entrada do app (JS inline) — NUNCA cachear,
      // senão PWA/Safari servem versão velha e o app fica desatualizado.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    }
  },
}));

// Rota amigável: teniscash.com.br/loja → portal das lojas
app.get('/loja', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/loja.html'), { cacheControl: false });
});

// Rota amigável: teniscash.com.br/etiquetas → impressão de etiquetas no balcão
app.get('/etiquetas', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/etiquetas.html'), { cacheControl: false });
});

// Rota amigável: teniscash.com.br/barber → marketplace de barbearias/salões + agendamento
app.get('/barber', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/barber.html'), { cacheControl: false });
});
// alias do nome antigo → redireciona pro novo /barber
app.get('/barbeiros', (req, res) => res.redirect(301, '/barber'));

// Vitrine por loja — consumidor vê só os produtos com estoque NAQUELA loja.
// Ex: teniscash.com.br/praiadobessa  (a página lê o slug pelo path)
const VITRINE_SLUGS = ['praiadobessa', 'bessa', 'tambau', 'tambia', 'rainhadaborborema', 'rainha', 'baratao', 'ecommerce'];
VITRINE_SLUGS.forEach((slug) => {
  app.get('/' + slug, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(path.join(__dirname, '../public/vitrine.html'), { cacheControl: false });
  });
});

// Página pública da NOTA FISCAL (cliente abre pelo link que recebe no WhatsApp; sem login).
// A chave de acesso já é impressa no cupom (semi-pública) — a SEFAZ deixa qualquer um
// consultar por ela, então renderizar o cupom por chave aqui é seguro.
// Loja Tambaú ao vivo — incorporada em sportsetennis.com.br/praiadetambau.
app.get('/praiadetambau', (req, res) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://sportsetennis.com.br https://www.sportsetennis.com.br");
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/praiadetambau.html'), { cacheControl: false });
});

app.get('/nota/:accessKey', async (req, res) => {
  try {
    const { prisma } = require('./middleware');
    const { buildCupomThermalHtml } = require('./services/cupomThermal');
    const key = String(req.params.accessKey || '').replace(/\D/g, '');
    const wrap = (msg) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:system-ui,sans-serif;padding:40px 24px;text-align:center;color:#1d1d1f">' + msg + '</div>';
    if (key.length !== 44) return res.status(400).type('text/html').send(wrap('Link de nota inválido.'));
    const doc = await prisma.fiscalDocument.findFirst({ where: { accessKey: key }, include: { issuer: true } });
    if (!doc || !doc.xmlContent) return res.status(404).type('text/html').send(wrap('Nota não encontrada.'));
    if (doc.status !== 'authorized' && doc.status !== 'cancelled') return res.status(400).type('text/html').send(wrap('Nota ainda não disponível.'));
    res.type('text/html').send(await buildCupomThermalHtml(doc));
  } catch (err) {
    console.error('[/nota]', err.message);
    res.status(500).send('Erro ao abrir a nota');
  }
});

// PDF público da nota (o WhatsApp baixa esta URL e manda como documento; cliente abre/salva).
app.get('/nota/:accessKey/pdf', async (req, res) => {
  try {
    const { prisma } = require('./middleware');
    const { buildDanfePdf } = require('./services/danfePdf');
    const key = String(req.params.accessKey || '').replace(/\D/g, '');
    if (key.length !== 44) return res.status(400).send('Link inválido');
    const doc = await prisma.fiscalDocument.findFirst({ where: { accessKey: key }, include: { issuer: true } });
    if (!doc || !doc.xmlContent || (doc.status !== 'authorized' && doc.status !== 'cancelled')) return res.status(404).send('Nota não encontrada');
    const pdf = await buildDanfePdf(doc);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="cupom-' + doc.number + '.pdf"', 'Cache-Control': 'public, max-age=600' });
    res.send(pdf);
  } catch (err) {
    console.error('[/nota/pdf]', err.message);
    res.status(500).send('Erro ao gerar o PDF da nota');
  }
});

// Página pública de produto (QR Code aponta pra cá)
app.get('/p/:id', async (req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prismaP = new PrismaClient();
    const id = req.params.id;
    console.log('[/p/:id] lookup id=' + id);

    const includeOpts = {
      sizes: {
        orderBy: { size: 'asc' },
        include: { storeStocks: { include: { store: { select: { code: true, name: true } } } } },
      },
    };

    // 1ª tentativa: busca por id (ativo OU inativo)
    let p = await prismaP.product.findUnique({
      where: { id },
      include: includeOpts,
    });

    // 2ª tentativa: busca por SKU (talvez QR carregou SKU em vez de id)
    if (!p) {
      p = await prismaP.product.findFirst({
        where: { sku: id, active: true },
        include: includeOpts,
      });
    }

    // 3ª: produto está inativo mas foi unificado → redireciona pro canônico
    if (p && p.active === false) {
      let ctxObj = {};
      try { ctxObj = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch {}
      const unifiedInto = ctxObj.unifiedInto;
      if (unifiedInto) {
        console.log('[/p/:id] produto unificado → redirecionando pra ' + unifiedInto);
        return res.redirect(302, '/p/' + unifiedInto);
      }
    }

    if (!p) {
      console.warn('[/p/:id] não encontrado: ' + id);
      return res.status(404).send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>Produto não encontrado</h1><p style="color:#888;font-size:12px;">ID: ' + String(id).replace(/[<>]/g, '') + '</p></body></html>');
    }
    if (p.active === false) {
      return res.status(410).send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>Produto fora de linha</h1><p>Esse produto não está mais ativo no catálogo.</p></body></html>');
    }
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const ctx = (() => { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch { return {}; } })();
    const cls = ctx.classification || {};
    const ref = ctx.supplierRef || '';
    const photos = [];
    if (p.imageUrl) photos.push(p.imageUrl);
    try {
      const extras = typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : (p.imageUrls || []);
      if (Array.isArray(extras)) extras.forEach(u => { if (u && !photos.includes(u)) photos.push(u); });
    } catch {}

    // Tamanhos por loja
    const storeColors = { LOJA01: '#0066cc', LOJA02: '#0a843d', LOJA03: '#b06b00', LOJA04: '#8a2be2', LOJA05: '#d70015', LOJA06: '#1d1d1f' };
    const byStore = {};
    (p.sizes || []).forEach(sz => {
      (sz.storeStocks || []).forEach(ss => {
        const code = ss.store?.code || '?';
        const name = ss.store?.name || code;
        if (!byStore[code]) byStore[code] = { color: storeColors[code] || '#8e8e93', name, items: [] };
        for (let i = 0; i < (ss.stock || 0); i++) byStore[code].items.push(sz.size);
      });
    });

    let storesHtml = '';
    Object.keys(byStore).sort().forEach(code => {
      const info = byStore[code];
      const counts = {};
      info.items.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
      const sortedSizes = Object.keys(counts).sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
      const pills = sortedSizes.map(sz => {
        const q = counts[sz];
        return `<span style="display:inline-flex;align-items:center;gap:4px;padding:8px 14px;background:white;border:2px solid ${info.color};border-radius:12px;font-size:16px;font-weight:800;color:#1d1d1f;margin:4px;">${sz}${q > 1 ? `<span style="background:${info.color};color:white;padding:2px 8px;border-radius:8px;font-size:12px;">×${q}</span>` : ''}</span>`;
      }).join('');
      storesHtml += `
        <div style="margin-bottom:14px;padding:14px;background:white;border-radius:12px;border-left:5px solid ${info.color};">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
            <span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${info.color};"></span>
            <div style="flex:1;">
              <div style="font-size:15px;font-weight:800;color:${info.color};">${esc(code)}</div>
              <div style="font-size:12px;color:#8e8e93;">${esc(info.name)}</div>
            </div>
            <span style="font-size:14px;font-weight:800;color:${info.color};background:${info.color}20;padding:5px 12px;border-radius:8px;">${info.items.length} un.</span>
          </div>
          <div>${pills}</div>
        </div>`;
    });

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name || 'Produto')} — Sports & Tennis</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f7;color:#1d1d1f;line-height:1.5}
  .container{max-width:680px;margin:0 auto;padding:16px;}
  .header{background:linear-gradient(135deg,#E5571E,#EE7240);color:white;padding:16px 20px;border-radius:14px;margin-bottom:14px;text-align:center;box-shadow:0 8px 24px rgba(229,87,30,0.25);}
  .header h1{font-size:18px;font-weight:800;}
  .header p{font-size:12px;opacity:0.9;margin-top:2px;}
  .card{background:white;border-radius:14px;overflow:hidden;margin-bottom:14px;box-shadow:0 4px 12px rgba(0,0,0,0.04);}
  /* CARROSSEL */
  .crsl{position:relative;width:100%;aspect-ratio:1;background:#f5f5f7;}
  .crsl img.crsl-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:12px;display:none}
  .crsl img.crsl-img.active{display:block}
  .crsl-arrow{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.95);border:1px solid #e5e5ea;color:#1d1d1f;font-size:20px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:2;-webkit-tap-highlight-color:transparent;}
  .crsl-arrow:active{background:#FCDAC4;}
  .crsl-arrow.prev{left:10px}
  .crsl-arrow.next{right:10px}
  .crsl-counter{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.65);color:white;font-size:12px;font-weight:700;padding:4px 12px;border-radius:14px;z-index:2;}
  .thumbs{display:flex;gap:6px;padding:8px;overflow-x:auto;scrollbar-width:none;}
  .thumbs::-webkit-scrollbar{display:none}
  .thumb{flex-shrink:0;width:64px;height:64px;border:2px solid #e5e5ea;border-radius:8px;cursor:pointer;padding:3px;background:#f5f5f7;transition:all 0.15s;}
  .thumb.active{border-color:#E5571E;box-shadow:0 0 0 2px rgba(229,87,30,0.2);}
  .thumb img{width:100%;height:100%;object-fit:contain;}
  .info{padding:18px;}
  .brand{display:inline-block;padding:4px 12px;background:linear-gradient(135deg,#1d1d1f,#3a3a3c);color:white;font-size:12px;font-weight:800;border-radius:8px;letter-spacing:0.5px;}
  .price{font-size:28px;font-weight:800;color:#E5571E;margin-top:8px;}
  .name{font-size:20px;font-weight:700;color:#1d1d1f;line-height:1.3;margin-top:8px;}
  .sku{font-size:12px;color:#8e8e93;font-family:monospace;margin-top:6px;}
  .ref{display:inline-block;background:#FCDAC4;color:#E5571E;padding:3px 10px;border-radius:6px;font-weight:700;font-size:11px;font-family:monospace;margin-top:6px;}
  .pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;}
  .pill{padding:5px 10px;border-radius:8px;font-size:11px;font-weight:700;}
  .pill-type{background:#FCDAC4;color:#E5571E;}
  .pill-gender{background:#e3f2fd;color:#0066cc;}
  .pill-modality{background:#f0f0f3;color:#1d1d1f;}
  .pill-tier{background:#fff8e0;color:#b06b00;}
  .section{padding:16px 18px;border-top:1px solid #f0f0f3;}
  .section h3{font-size:11px;color:#8e8e93;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:10px;}
  .desc{font-size:14px;color:#1d1d1f;line-height:1.6;}
  .specs{background:#fafafa;border-radius:10px;padding:14px;font-family:monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;color:#1d1d1f;}
  .footer{text-align:center;padding:20px;color:#8e8e93;font-size:11px;}
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>🏪 Sports & Tennis</h1><p>Informações do produto</p></div>

    <div class="card">
      ${photos.length ? `
        <div class="crsl" id="crsl">
          ${photos.map((u, i) => `<img class="crsl-img${i === 0 ? ' active' : ''}" data-idx="${i}" src="${esc(u)}" onerror="this.style.opacity='0.3'">`).join('')}
          ${photos.length > 1 ? `
            <button class="crsl-arrow prev" onclick="crslNav(-1)">‹</button>
            <button class="crsl-arrow next" onclick="crslNav(1)">›</button>
            <div class="crsl-counter"><span id="crsl-idx">1</span> / ${photos.length}</div>
          ` : ''}
        </div>
        ${photos.length > 1 ? `
          <div class="thumbs">
            ${photos.map((u, i) => `<button class="thumb${i === 0 ? ' active' : ''}" data-idx="${i}" onclick="crslGo(${i})"><img src="${esc(u)}" onerror="this.style.opacity='0.3'"></button>`).join('')}
          </div>
        ` : ''}
      ` : ''}
      ${p.videoUrl ? `<video controls preload="metadata" playsinline poster="${esc(p.imageUrl || '')}" src="${esc(p.videoUrl)}" style="display:block;width:100%;max-height:60vh;background:#000;border-top:1px solid #f0f0f3;"></video>` : ''}

      <div class="info">
        ${!ctx.deactivatedReason ? `<span class="brand">${esc(p.brand || 'A DEFINIR')}</span>` : ''}
        <div class="name">${esc(p.name || '?')}</div>
        <div class="price">R$ ${Number(p.price || 0).toFixed(2)}</div>
        <div class="sku">📋 ${esc(p.sku || '')}</div>
        ${ref ? `<div><span class="ref">REF: ${esc(ref)}</span></div>` : ''}
        ${(cls.type || cls.gender || cls.modality || cls.tier) ? `
          <div class="pills">
            ${cls.type ? `<span class="pill pill-type">${esc(cls.type)}</span>` : ''}
            ${cls.gender ? `<span class="pill pill-gender">${esc(cls.gender)}</span>` : ''}
            ${cls.modality ? `<span class="pill pill-modality">${esc(cls.modality)}</span>` : ''}
            ${cls.tier ? `<span class="pill pill-tier">⭐ ${esc(cls.tier)}</span>` : ''}
          </div>
        ` : ''}
      </div>

      ${p.shortDescription ? `<div class="section"><h3>📝 Descrição</h3><p class="desc">${esc(p.shortDescription)}</p></div>` : ''}
      ${p.longDescription ? `<div class="section"><h3>📋 Especificações Técnicas</h3><div class="specs">${esc(p.longDescription)}</div></div>` : ''}
      ${Object.keys(byStore).length ? `<div class="section"><h3>📦 Estoque por loja</h3>${storesHtml}</div>` : ''}
    </div>

    <div class="footer">${PUBLIC_DOMAIN} · Sports &amp; Tennis</div>
  </div>
  <script>
  (function(){
    const total = ${photos.length};
    if (total <= 1) return;
    let cur = 0;
    function update() {
      document.querySelectorAll('.crsl-img').forEach((el, i) => el.classList.toggle('active', i === cur));
      document.querySelectorAll('.thumb').forEach((el, i) => el.classList.toggle('active', i === cur));
      const c = document.getElementById('crsl-idx'); if (c) c.textContent = (cur + 1);
    }
    window.crslNav = function(dir) { cur = (cur + dir + total) % total; update(); };
    window.crslGo = function(idx) { cur = idx; update(); };
    // Swipe touch
    let startX = 0, dx = 0;
    const crsl = document.getElementById('crsl');
    if (crsl) {
      crsl.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; dx = 0; }, { passive: true });
      crsl.addEventListener('touchmove', (e) => { dx = e.touches[0].clientX - startX; }, { passive: true });
      crsl.addEventListener('touchend', () => {
        if (Math.abs(dx) > 50) crslNav(dx < 0 ? 1 : -1);
      });
    }
    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') crslNav(-1);
      if (e.key === 'ArrowRight') crslNav(1);
    });
  })();
  </script>
</body>
</html>`;
    res.send(html);
    await prismaP.$disconnect();
  } catch (err) {
    console.error('[/p/:id] erro:', err);
    res.status(500).send('Erro ao carregar produto');
  }
});

// =====================================================================
// Página pública de produto do BARATAO DOS ESPORTES (link do robô do Baratao).
// Mesmo card do catalogo, mas mostra SO o estoque da loja Baratao (LOJA01)
// e com identidade do Baratao. Preco = preco do catalogo (se o Baratao
// praticar preco diferente, isso vira preco-por-loja na Fase 2).
// =====================================================================
app.get('/b/:id', async (req, res) => {
  try {
    const { prisma: prismaB } = require('./middleware');
    const id = req.params.id;
    console.log('[/b/:id] lookup id=' + id);

    const includeOpts = {
      sizes: {
        orderBy: { size: 'asc' },
        include: { storeStocks: { include: { store: { select: { code: true, name: true } } } } },
      },
    };

    let p = await prismaB.product.findUnique({ where: { id }, include: includeOpts });
    if (!p) p = await prismaB.product.findFirst({ where: { sku: id, active: true }, include: includeOpts });

    if (p && p.active === false) {
      let ctxObj = {};
      try { ctxObj = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch {}
      if (ctxObj.unifiedInto) return res.redirect(302, '/b/' + ctxObj.unifiedInto);
    }
    if (!p) {
      console.warn('[/b/:id] não encontrado: ' + id);
      return res.status(404).send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>Produto não encontrado</h1></body></html>');
    }
    if (p.active === false) {
      return res.status(410).send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>Produto fora de linha</h1></body></html>');
    }

    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const ctx = (() => { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch { return {}; } })();
    const cls = ctx.classification || {};
    const ref = ctx.supplierRef || '';
    const photos = [];
    if (p.imageUrl) photos.push(p.imageUrl);
    try {
      const extras = typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : (p.imageUrls || []);
      if (Array.isArray(extras)) extras.forEach(u => { if (u && !photos.includes(u)) photos.push(u); });
    } catch {}

    // SO o estoque da loja Baratao (LOJA01). Conta unidades por tamanho.
    const ehBaratao = (st) => !!st && (st.code === 'LOJA01' || /barat/i.test(st.name || ''));
    const counts = {};
    let unitsBaratao = 0;
    (p.sizes || []).forEach(sz => {
      (sz.storeStocks || []).forEach(ss => {
        if (!ehBaratao(ss.store)) return;
        const q = ss.stock || 0;
        if (q <= 0) return;
        counts[sz.size] = (counts[sz.size] || 0) + q;
        unitsBaratao += q;
      });
    });
    const sortedSizes = Object.keys(counts).sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
    const RED = '#d11a1a', AMBER = '#f5a623';
    const sizesHtml = sortedSizes.length
      ? sortedSizes.map(sz => {
          const q = counts[sz];
          return `<span style="display:inline-flex;align-items:center;gap:4px;padding:8px 14px;background:white;border:2px solid ${RED};border-radius:12px;font-size:16px;font-weight:800;color:#1d1d1f;margin:4px;">${esc(sz)}${q > 1 ? `<span style="background:${RED};color:white;padding:2px 8px;border-radius:8px;font-size:12px;">×${q}</span>` : ''}</span>`;
        }).join('')
      : `<p style="color:#8e8e93;font-size:14px;">Disponibilidade sob consulta — chama a gente no WhatsApp que a equipe confirma. 🙂</p>`;

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name || 'Produto')} — Baratão dos Esportes</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f7;color:#1d1d1f;line-height:1.5}
  .container{max-width:680px;margin:0 auto;padding:16px;}
  .header{background:linear-gradient(135deg,${RED},${AMBER});color:white;padding:16px 20px;border-radius:14px;margin-bottom:14px;text-align:center;box-shadow:0 8px 24px rgba(209,26,26,0.25);}
  .header h1{font-size:18px;font-weight:800;}
  .header p{font-size:12px;opacity:0.95;margin-top:2px;}
  .card{background:white;border-radius:14px;overflow:hidden;margin-bottom:14px;box-shadow:0 4px 12px rgba(0,0,0,0.04);}
  .crsl{position:relative;width:100%;aspect-ratio:1;background:#f5f5f7;}
  .crsl img.crsl-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:12px;display:none}
  .crsl img.crsl-img.active{display:block}
  .crsl-arrow{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.95);border:1px solid #e5e5ea;color:#1d1d1f;font-size:20px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:2;-webkit-tap-highlight-color:transparent;}
  .crsl-arrow.prev{left:10px}
  .crsl-arrow.next{right:10px}
  .crsl-counter{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.65);color:white;font-size:12px;font-weight:700;padding:4px 12px;border-radius:14px;z-index:2;}
  .thumbs{display:flex;gap:6px;padding:8px;overflow-x:auto;scrollbar-width:none;}
  .thumbs::-webkit-scrollbar{display:none}
  .thumb{flex-shrink:0;width:64px;height:64px;border:2px solid #e5e5ea;border-radius:8px;cursor:pointer;padding:3px;background:#f5f5f7;transition:all 0.15s;}
  .thumb.active{border-color:${RED};box-shadow:0 0 0 2px rgba(209,26,26,0.2);}
  .thumb img{width:100%;height:100%;object-fit:contain;}
  .info{padding:18px;}
  .brand{display:inline-block;padding:4px 12px;background:linear-gradient(135deg,#1d1d1f,#3a3a3c);color:white;font-size:12px;font-weight:800;border-radius:8px;letter-spacing:0.5px;}
  .price{font-size:28px;font-weight:800;color:${RED};margin-top:8px;}
  .name{font-size:20px;font-weight:700;color:#1d1d1f;line-height:1.3;margin-top:8px;}
  .sku{font-size:12px;color:#8e8e93;font-family:monospace;margin-top:6px;}
  .ref{display:inline-block;background:#ffe9c7;color:#a85d00;padding:3px 10px;border-radius:6px;font-weight:700;font-size:11px;font-family:monospace;margin-top:6px;}
  .pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;}
  .pill{padding:5px 10px;border-radius:8px;font-size:11px;font-weight:700;}
  .pill-type{background:#ffe9c7;color:#a85d00;}
  .pill-gender{background:#e3f2fd;color:#0066cc;}
  .pill-modality{background:#f0f0f3;color:#1d1d1f;}
  .section{padding:16px 18px;border-top:1px solid #f0f0f3;}
  .section h3{font-size:11px;color:#8e8e93;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:10px;}
  .desc{font-size:14px;color:#1d1d1f;line-height:1.6;}
  .specs{background:#fafafa;border-radius:10px;padding:14px;font-family:monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;color:#1d1d1f;}
  .footer{text-align:center;padding:20px;color:#8e8e93;font-size:11px;}
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>🏷️ Baratão dos Esportes</h1><p>Preço bom é aqui</p></div>

    <div class="card">
      ${photos.length ? `
        <div class="crsl" id="crsl">
          ${photos.map((u, i) => `<img class="crsl-img${i === 0 ? ' active' : ''}" data-idx="${i}" src="${esc(u)}" onerror="this.style.opacity='0.3'">`).join('')}
          ${photos.length > 1 ? `
            <button class="crsl-arrow prev" onclick="crslNav(-1)">‹</button>
            <button class="crsl-arrow next" onclick="crslNav(1)">›</button>
            <div class="crsl-counter"><span id="crsl-idx">1</span> / ${photos.length}</div>
          ` : ''}
        </div>
        ${photos.length > 1 ? `
          <div class="thumbs">
            ${photos.map((u, i) => `<button class="thumb${i === 0 ? ' active' : ''}" data-idx="${i}" onclick="crslGo(${i})"><img src="${esc(u)}" onerror="this.style.opacity='0.3'"></button>`).join('')}
          </div>
        ` : ''}
      ` : ''}
      ${p.videoUrl ? `<video controls preload="metadata" playsinline poster="${esc(p.imageUrl || '')}" src="${esc(p.videoUrl)}" style="display:block;width:100%;max-height:60vh;background:#000;border-top:1px solid #f0f0f3;"></video>` : ''}

      <div class="info">
        ${!ctx.deactivatedReason ? `<span class="brand">${esc(p.brand || 'A DEFINIR')}</span>` : ''}
        <div class="name">${esc(p.name || '?')}</div>
        <div class="price">R$ ${Number(p.price || 0).toFixed(2)}</div>
        <div class="sku">📋 ${esc(p.sku || '')}</div>
        ${ref ? `<div><span class="ref">REF: ${esc(ref)}</span></div>` : ''}
        ${(cls.type || cls.gender || cls.modality) ? `
          <div class="pills">
            ${cls.type ? `<span class="pill pill-type">${esc(cls.type)}</span>` : ''}
            ${cls.gender ? `<span class="pill pill-gender">${esc(cls.gender)}</span>` : ''}
            ${cls.modality ? `<span class="pill pill-modality">${esc(cls.modality)}</span>` : ''}
          </div>
        ` : ''}
      </div>

      ${p.shortDescription ? `<div class="section"><h3>📝 Descrição</h3><p class="desc">${esc(p.shortDescription)}</p></div>` : ''}
      ${p.longDescription ? `<div class="section"><h3>📋 Especificações</h3><div class="specs">${esc(p.longDescription)}</div></div>` : ''}
      <div class="section"><h3>📦 Tamanhos na loja Baratão${unitsBaratao ? ` · ${unitsBaratao} un.` : ''}</h3><div>${sizesHtml}</div></div>
    </div>

    <div class="footer">Baratão dos Esportes · João Pessoa - PB</div>
  </div>
  <script>
  (function(){
    const total = ${photos.length};
    if (total <= 1) return;
    let cur = 0;
    function update() {
      document.querySelectorAll('.crsl-img').forEach((el, i) => el.classList.toggle('active', i === cur));
      document.querySelectorAll('.thumb').forEach((el, i) => el.classList.toggle('active', i === cur));
      const c = document.getElementById('crsl-idx'); if (c) c.textContent = (cur + 1);
    }
    window.crslNav = function(dir) { cur = (cur + dir + total) % total; update(); };
    window.crslGo = function(idx) { cur = idx; update(); };
    let startX = 0, dx = 0;
    const crsl = document.getElementById('crsl');
    if (crsl) {
      crsl.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; dx = 0; }, { passive: true });
      crsl.addEventListener('touchmove', (e) => { dx = e.touches[0].clientX - startX; }, { passive: true });
      crsl.addEventListener('touchend', () => { if (Math.abs(dx) > 50) crslNav(dx < 0 ? 1 : -1); });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') crslNav(-1);
      if (e.key === 'ArrowRight') crslNav(1);
    });
  })();
  </script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error('[/b/:id] erro:', err);
    res.status(500).send('Erro ao carregar produto');
  }
});

// Painel logado do profissional (cria ofertas, alunos, cobranças)
app.get('/painel', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/painel.html'), { cacheControl: false });
});

// Card público do profissional esportivo (/pro/:slug)
app.get('/pro/:slug', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/pro.html'), { cacheControl: false });
});

// Página pública de pagamento de cobrança (/c/:token)
app.get('/c/:token', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/cobranca.html'), { cacheControl: false });
});

// ===================================================================
// APEX COMPETIÇÃO — páginas públicas server-rendered (mobile-first)
// ===================================================================

const APEX_SPORT_LABEL = {
  TENNIS: '🎾 Tênis', BEACH_TENNIS: '🏖️ Beach Tennis', PADEL: '🎾 Padel',
  FUTSAL: '⚽ Futsal', SOCCER: '⚽ Futebol', VOLLEY: '🏐 Vôlei',
  BASKETBALL: '🏀 Basquete', HANDBALL: '🤾 Handebol', TABLE_TENNIS: '🏓 Tênis de Mesa',
  OTHER: '🏅 Esporte',
};
const apexEsc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Página pública do torneio (chave, jogos, classificação)
app.get('/t/:slug', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const { prisma } = require('./middleware');
    const slug = req.params.slug;
    const t = await prisma.tournament.findFirst({
      where: { OR: [{ slug }, { id: slug }] },
      include: {
        categories: { include: { _count: { select: { entries: true } } } },
        _count: { select: { entries: true } },
      },
    });
    if (!t) {
      return res
        .status(404)
        .send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Torneio não encontrado</h1></body></html>');
    }

    const STATUS = {
      DRAFT: ['Rascunho', '#8e8e93'], OPEN: ['Inscrições abertas', '#0a843d'],
      ONGOING: ['Em andamento', '#E5571E'], FINISHED: ['Encerrado', '#1d1d1f'],
      CANCELED: ['Cancelado', '#d70015'],
    };
    const st = STATUS[t.status] || STATUS.DRAFT;
    const fmtDate = (d) =>
      d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Fortaleza' }) : '';
    const dateLine = t.startDate
      ? fmtDate(t.startDate) + (t.endDate ? ' a ' + fmtDate(t.endDate) : '')
      : '';
    const place = [t.city, t.state].filter(Boolean).join('/');

    const catData = t.categories.map((c) => ({
      id: c.id, name: c.name, entries: c._count.entries,
    }));
    const catJson = JSON.stringify(catData).replace(/</g, '\\u003c');

    // Mural de avisos (texto, sem foto) — renderizado no servidor
    const posts = await prisma.tournamentPost.findMany({
      where: { tournamentId: t.id },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
    const fmtDateTime = (d) =>
      new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' });
    const muralHtml = posts.length
      ? '<div class="sec-h">📢 Mural de avisos</div>' + posts.map((p) =>
          '<div class="post">' +
          (p.pinned ? '<span class="pin">📌 fixado</span>' : '') +
          (p.title ? '<div class="post-t">' + apexEsc(p.title) + '</div>' : '') +
          '<div class="post-b">' + apexEsc(p.body) + '</div>' +
          '<div class="post-d">' + apexEsc(fmtDateTime(p.createdAt)) + '</div>' +
          '</div>'
        ).join('')
      : '';

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${apexEsc(t.name)} — Sports & Tennis</title>
<meta property="og:title" content="${apexEsc(t.name)}">
<meta property="og:description" content="${apexEsc((APEX_SPORT_LABEL[t.sport] || t.sport) + ' · ' + t._count.entries + ' inscritos · ' + st[0])}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#0b0e14">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
  :root{--bg:#0a0d13;--card:#141924;--card2:#1b2130;--line:rgba(255,255,255,.08);--red:#ee2b2b;--red2:#ff4747;--gold:#f5c542;--txt:#eef1f6;--mut:#8b94a7;--green:#28c76f}
  html,body{background:var(--bg)}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--txt);line-height:1.5;padding-bottom:calc(env(safe-area-inset-bottom) + 20px);background:
    radial-gradient(1200px 500px at 50% -120px,rgba(238,43,43,.22),transparent 60%),
    radial-gradient(900px 400px at 100% 10%,rgba(245,197,66,.08),transparent 55%),
    var(--bg)}
  .container{max-width:560px;margin:0 auto;padding:16px}
  /* HERO */
  .hero{position:relative;background:linear-gradient(180deg,#0e1420,#0a0d13);border:1px solid var(--line);border-radius:22px;padding:22px 18px 20px;text-align:center;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.5)}
  .hero:before{content:"";position:absolute;inset:0;background:radial-gradient(400px 220px at 50% 0,rgba(238,43,43,.28),transparent 70%);pointer-events:none}
  .hero .logo{width:62%;max-width:230px;height:auto;filter:drop-shadow(0 10px 26px rgba(0,0,0,.6));position:relative}
  .hero h1{font-family:'Oswald',sans-serif;font-weight:700;font-size:30px;line-height:1.02;letter-spacing:.5px;text-transform:uppercase;margin-top:14px;position:relative;text-shadow:0 2px 14px rgba(0,0,0,.5)}
  .badge{position:relative;display:inline-flex;align-items:center;gap:6px;background:${st[1]};color:#fff;font-size:11px;font-weight:800;padding:5px 12px;border-radius:999px;text-transform:uppercase;letter-spacing:1px;box-shadow:0 4px 14px rgba(0,0,0,.35)}
  .badge .bdot{width:7px;height:7px;border-radius:50%;background:#fff;opacity:.9}
  .chips{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:14px;position:relative}
  .chip{display:inline-flex;align-items:center;gap:6px;background:var(--card2);border:1px solid var(--line);color:var(--txt);font-size:12.5px;font-weight:600;padding:7px 12px;border-radius:999px}
  .chip b{color:var(--gold);font-weight:800}
  .prize{margin-top:14px;background:linear-gradient(90deg,rgba(245,197,66,.16),rgba(245,197,66,.05));border:1px solid rgba(245,197,66,.3);color:var(--gold);border-radius:12px;padding:11px 14px;font-size:13px;font-weight:700;position:relative}
  .about{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;color:#c9d0dc;font-size:14px}
  /* CATS */
  .cats{display:flex;flex-wrap:wrap;gap:9px;padding:18px 2px 6px}
  .cats::-webkit-scrollbar{display:none}
  .cat{flex-shrink:0;border:1px solid var(--line);background:var(--card);color:var(--txt);font-family:'Oswald',sans-serif;font-size:15px;font-weight:600;letter-spacing:.5px;padding:9px 16px;border-radius:12px;cursor:pointer;-webkit-tap-highlight-color:transparent;display:flex;align-items:center;gap:7px;transition:.15s}
  .cat.active{border-color:transparent;color:#fff;background:linear-gradient(135deg,var(--red),#c81e1e);box-shadow:0 8px 20px rgba(238,43,43,.35)}
  .cat .cnt{background:rgba(255,255,255,.08);color:var(--mut);font-size:11px;font-weight:700;padding:1px 8px;border-radius:7px}
  .cat.active .cnt{background:rgba(0,0,0,.25);color:#fff}
  .views{display:flex;gap:5px;margin:14px 2px 4px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .views::-webkit-scrollbar{display:none}
  .vtab{flex:1 1 auto;white-space:nowrap;border:none;background:transparent;color:var(--mut);font-family:'Oswald',sans-serif;font-size:12px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;padding:9px 9px;border-radius:9px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:.15s}
  .vtab.active{background:linear-gradient(135deg,var(--red),#c81e1e);color:#fff;box-shadow:0 4px 12px rgba(238,43,43,.3)}
  /* card do campeão (mata-mata) */
  .bchamp{margin:6px 0 4px;background:linear-gradient(135deg,rgba(247,181,0,.16),rgba(238,43,43,.1));border:1px solid var(--gold);border-radius:12px;padding:12px;display:flex;align-items:center;gap:12px}
  .bchamp .tb.big{width:38px;height:38px}
  .bchamp-t{display:flex;flex-direction:column;line-height:1.2}
  .bchamp-l{font-size:11px;color:var(--gold);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
  .bchamp-n{font-family:'Oswald',sans-serif;font-size:18px;font-weight:600;color:#fff}
  .sec-h{font-family:'Oswald',sans-serif;font-size:15px;color:#fff;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;margin:24px 2px 12px;display:flex;align-items:center;gap:9px}
  .views+#catbody .sec-h:first-child,.views~#catbody>.sec-h:first-child{margin-top:16px}
  .sec-h:before{content:"";width:4px;height:17px;background:linear-gradient(var(--red),var(--gold));border-radius:3px;display:inline-block}
  .grp-h{font-family:'Oswald',sans-serif;font-size:16px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--gold);margin:20px 2px 10px;padding-left:10px;border-left:3px solid var(--red)}
  .stbar{margin:16px 0 4px}
  .stteam{width:100%;min-height:44px;background:var(--card);color:#fff;border:1px solid var(--line);border-radius:12px;padding:0 14px;font-family:'Chakra Petch',sans-serif;font-size:14px;font-weight:600;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23c9a24a' stroke-width='3'><path d='M6 9l6 6 6-6'/></svg>");background-repeat:no-repeat;background-position:right 14px center}
  .rnd{margin-bottom:16px}
  .rnd-h{font-size:11px;font-weight:800;color:var(--mut);text-transform:uppercase;letter-spacing:1.5px;margin:0 2px 9px}
  /* MATCH CARD */
  .mt{background:linear-gradient(180deg,var(--card),#10141d);border:1px solid var(--line);border-radius:16px;padding:0;margin-bottom:11px;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,.3)}
  .mt.is-live{border-color:rgba(238,43,43,.5);box-shadow:0 0 0 1px rgba(238,43,43,.3),0 6px 20px rgba(238,43,43,.18)}
  .sched{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--mut);font-weight:600;padding:10px 14px;background:rgba(255,255,255,.02);border-bottom:1px solid var(--line);letter-spacing:.2px}
  .tb{flex-shrink:0;width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;font-weight:700;font-size:13px;color:#fff;letter-spacing:.3px;background:linear-gradient(135deg,hsl(var(--h,220),55%,44%),hsl(var(--h,220),60%,26%));box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
  /* confronto HORIZONTAL: time × placar × time */
  .confront{display:flex;align-items:flex-start;gap:8px;padding:16px 10px 15px}
  .side{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:9px;text-align:center}
  .tb.big{width:48px;height:48px;border-radius:13px;font-size:17px}
  .sn{font-size:13px;font-weight:700;color:#cfd6e2;line-height:1.2;word-break:break-word;max-width:100%}
  .sn.win{color:#fff}
  .sn.win:after{content:" ✓";color:var(--green)}
  img.tb.big.logo{object-fit:contain;background:transparent;box-shadow:none;padding:0}
  .tb.big.tbd{background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px var(--line);color:var(--mut);font-weight:700}
  .sn.tbd{color:var(--mut);font-weight:600;font-size:12px}
  .score{flex:0 0 auto;min-width:82px;display:flex;align-items:center;justify-content:center;gap:7px;padding-top:12px}
  .score .sc{font-family:'Oswald',sans-serif;font-weight:700;font-size:31px;line-height:1;color:#fff}
  .score .sc.w{color:var(--gold)}
  .score .x{color:var(--mut);font-size:15px;font-weight:600}
  .score .vs{font-family:'Oswald',sans-serif;font-weight:600;font-size:15px;color:var(--mut);letter-spacing:1.5px;border:1px solid var(--line);padding:7px 11px;border-radius:9px}
  .score .vs.lv{color:var(--red2);border-color:rgba(238,43,43,.45)}
  .liverow{display:flex;align-items:center;gap:8px;padding:9px 14px;background:rgba(238,43,43,.08);border-top:1px solid var(--line)}
  .livebadge{display:inline-flex;align-items:center;gap:6px;background:var(--red);color:#fff;font-size:10px;font-weight:900;padding:4px 9px;border-radius:7px;text-transform:uppercase;letter-spacing:.7px}
  .livebadge .dot{width:7px;height:7px;border-radius:50%;background:#fff;animation:lp 1.1s infinite}
  @keyframes lp{0%,100%{opacity:1}50%{opacity:.2}}
  .livesets{font-family:'Oswald',sans-serif;font-size:15px;font-weight:700;color:#fff;letter-spacing:.5px}
  .sumula{font-size:11.5px;color:var(--mut);font-weight:600;padding:8px 14px;background:rgba(255,255,255,.02);border-top:1px solid var(--line);letter-spacing:.3px}
  /* TABLES */
  .tbl{width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;border-collapse:separate;border-spacing:0;font-size:13px;margin-bottom:12px}
  .tbl th{background:#0e1420;color:var(--gold);font-family:'Oswald',sans-serif;font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;padding:11px 4px;text-align:center}
  .tbl td{padding:11px 4px;text-align:center;border-top:1px solid var(--line);color:#cfd6e2;font-weight:600}
  .tbl tbody tr:nth-child(odd) td{background:rgba(255,255,255,.015)}
  .tbl .tl{text-align:left;font-weight:700;color:#fff;padding-left:12px}
  .tbl th.tl{text-align:left;padding-left:12px}
  .tbl tr.q td:first-child{box-shadow:inset 3px 0 0 var(--green)}
  .tbl tr.q td:first-child{color:var(--green);font-weight:800}
  .tbl td b{color:#fff}
  .tlogo{width:19px;height:19px;object-fit:contain;vertical-align:middle;margin-right:7px}
  .pos{display:inline-flex;align-items:center;justify-content:center;min-width:20px}
  .empty{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:30px 16px;text-align:center;color:var(--mut);font-size:14px}
  .post{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 15px;margin-bottom:9px}
  .pin{display:inline-block;background:rgba(245,197,66,.16);color:var(--gold);font-size:10px;font-weight:800;padding:3px 9px;border-radius:7px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:7px}
  .post-t{font-weight:800;font-size:15px;margin-bottom:3px;color:#fff}
  .post-b{font-size:14px;white-space:pre-wrap;color:#c9d0dc}
  .post-d{font-size:11px;color:var(--mut);margin-top:7px}
  .footer{text-align:center;padding:26px 16px;color:var(--mut);font-size:11px;letter-spacing:.3px}
</style>
</head>
<body>
  <div class="container">
    <div class="hero">
      ${t.bannerUrl ? '<img class="logo" src="' + apexEsc(t.bannerUrl) + '" alt="' + apexEsc(t.name) + '">' : ''}
      <div style="margin-top:14px"><span class="badge"><span class="bdot"></span>${apexEsc(st[0])}</span></div>
      <h1>${apexEsc(t.name)}</h1>
      <div class="chips">
        <span class="chip">⚽ ${apexEsc(APEX_SPORT_LABEL[t.sport] || t.sport)}</span>
        ${t.isDoubles ? '<span class="chip">👥 Duplas</span>' : ''}
        ${dateLine ? '<span class="chip">📅 ' + apexEsc(dateLine) + '</span>' : ''}
        ${place ? '<span class="chip">📍 ' + apexEsc(place) + '</span>' : ''}
        <span class="chip"><b>${t._count.entries}</b> inscritos</span>
      </div>
      ${t.prizeDescription ? '<div class="prize">🏆 ' + apexEsc(t.prizeDescription) + '</div>' : ''}
    </div>

    ${muralHtml}

    <div class="cats" id="cats"></div>
    <div class="views" id="views"></div>
    <div id="catbody"></div>

    <div class="footer">${PUBLIC_DOMAIN} · Sports &amp; Tennis</div>
  </div>
<script>
(function(){
  var TID = ${JSON.stringify(t.id)};
  var CATS = ${catJson};
  var elTabs = document.getElementById('cats');
  var elViews = document.getElementById('views');
  var elBody = document.getElementById('catbody');
  var VIEW = 'jogos', DATA = null, CURID = null, STATS_TEAM = '';
  var VIEWS = [['jogos','Jogos'],['tabela','Classificação'],['mata','Mata-mata'],['stats','Estatísticas']];
  var STAGE = {FINAL:'Final',THIRD:'Disputa de 3º lugar',SEMI:'Semifinais',QUARTER:'Quartas de final',RO16:'Oitavas de final',RO32:'16-avos',RO64:'32-avos'};
  function esc(s){s=(s==null?'':''+s);return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function ini(s){s=(s==null?'':''+s).replace(/[^0-9A-Za-zÀ-ÿ ]/g,' ').trim();var p=s.split(/\\s+/);var a=(p[0]||'?').charAt(0);var b=(p[1]||'').charAt(0);return ((a+b).toUpperCase())||'?';}
  function hue(s){var h=0;s=(s==null?'':''+s);for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h%360;}
  function crest(entry){
    if(entry.logoUrl) return '<img class="tb big logo" src="'+esc(entry.logoUrl)+'" alt="">';
    return '<span class="tb big" style="--h:'+hue(entry.name)+'">'+ini(entry.name)+'</span>';
  }
  function sideEl(entry,label,win){
    if(!entry){var t=label||'A definir';return '<div class="side"><span class="tb big tbd">?</span><span class="sn tbd">'+esc(t)+'</span></div>';}
    return '<div class="side">'+crest(entry)+'<span class="sn'+(win?' win':'')+'">'+esc(entry.name)+'</span></div>';
  }
  function fmtWhen(d){try{var s=new Date(d).toLocaleString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'America/Fortaleza'});return s.charAt(0).toUpperCase()+s.slice(1);}catch(e){return '';}}
  function matchHtml(m){
    var h=m.homeEntry?m.homeEntry.name:'A definir';
    var a=m.awayEntry?m.awayEntry.name:'A definir';
    var whenStr=m.scheduledAt?fmtWhen(m.scheduledAt):'';
    var locStr=m.location||'';
    var schedLine=(whenStr||locStr)?'<div class="sched">'+(whenStr?'📅 '+esc(whenStr):'')+(locStr?(whenStr?'  ·  ':'')+'📍 '+esc(locStr):'')+'</div>':'';
    var done=(m.status==='FINISHED'||m.status==='WALKOVER');
    var live=(m.status==='LIVE');
    var hs=done&&m.homeScore!=null?m.homeScore:'';
    var as=done&&m.awayScore!=null?m.awayScore:'';
    var hw=m.winnerEntryId&&m.homeEntry&&m.winnerEntryId===m.homeEntry.id;
    var aw=m.winnerEntryId&&m.awayEntry&&m.winnerEntryId===m.awayEntry.id;
    var setsStr='';
    if(live&&m.liveState&&m.liveState.sets&&m.liveState.sets.length){
      setsStr=m.liveState.sets.map(function(s){return (s.h!=null?s.h:0)+'-'+(s.a!=null?s.a:0);}).join('  ');
    }
    var sumula=(done&&m.games&&m.games.length)?m.games.map(function(s){return s.homeGames+'-'+s.awayGames;}).join('  '):'';
    var pen=(done&&m.decidedByPenalties&&m.homePenalties!=null&&m.awayPenalties!=null)?'<div class="sumula">🥅 Pênaltis '+esc(m.homePenalties)+'–'+esc(m.awayPenalties)+'</div>':'';
    var ctr = done
      ? '<span class="sc'+(hw?' w':'')+'">'+esc(hs)+'</span><span class="x">×</span><span class="sc'+(aw?' w':'')+'">'+esc(as)+'</span>'
      : '<span class="vs'+(live?' lv':'')+'">VS</span>';
    return '<div class="mt'+(live?' is-live':'')+'">'
      +schedLine
      +'<div class="confront">'
      +sideEl(m.homeEntry, m.homeSourceLabel, hw)
      +'<div class="score">'+ctr+'</div>'
      +sideEl(m.awayEntry, m.awaySourceLabel, aw)
      +'</div>'
      +pen
      +(sumula?'<div class="sumula">📋 '+esc(sumula)+'</div>':(m.status==='WALKOVER'?'<div class="sumula">W.O.</div>':''))
      +(live?'<div class="liverow"><span class="livebadge"><span class="dot"></span>Ao vivo</span><span class="livesets">'+esc(setsStr)+'</span></div>':'')
      +'</div>';
  }
  function renderRoundBlocks(matches){
    var groups={},order=[];
    matches.forEach(function(m){var k=(m.stage==='LEAGUE'||m.stage==='GROUP')?('R'+m.round):m.stage;if(!groups[k]){groups[k]=[];order.push(k);}groups[k].push(m);});
    var html='';
    order.forEach(function(k){
      var ms=groups[k];var label=STAGE[k]||('Rodada '+ms[0].round);
      html+='<div class="rnd"><div class="rnd-h">'+esc(label)+'</div>';
      ms.forEach(function(m){html+=matchHtml(m);});
      html+='</div>';
    });
    return html;
  }
  // Jogos = SÓ fase regular (grupos / pontos corridos). O mata-mata fica na aba Mata-mata (dono 2026-11-09).
  function renderMatches(matches){
    if(!matches.length) return '<div class="empty">Chave ainda não gerada.</div>';
    var reg=matches.filter(function(m){return m.stage==='GROUP'||m.stage==='LEAGUE';});
    if(!reg.length) return '<div class="empty" style="padding:16px">Os jogos da fase de grupos aparecem aqui. O mata-mata está na aba <b>Mata-mata</b>.</div>';
    var groupM=reg.filter(function(m){return m.stage==='GROUP';});
    var leagueM=reg.filter(function(m){return m.stage!=='GROUP';});
    var html='';
    if(groupM.length){
      var byG={},go=[];
      groupM.forEach(function(m){var g=m.groupName||'?';if(!byG[g]){byG[g]=[];go.push(g);}byG[g].push(m);});
      go.sort();
      go.forEach(function(g){html+='<div class="grp-h">Grupo '+esc(g)+'</div>'+renderRoundBlocks(byG[g]);});
    }
    if(leagueM.length) html+=renderRoundBlocks(leagueM);
    return html;
  }
  function stdTableHtml(rows){
    var body=rows.map(function(s,i){
      var nm=s.entry?s.entry.name:'?';
      var lg=s.entry&&s.entry.logoUrl?'<img class="tlogo" src="'+esc(s.entry.logoUrl)+'">':'';
      return '<tr'+(i<2?' class="q"':'')+'><td>'+(s.rank||i+1)+'</td><td class="tl">'+lg+esc(nm)+'</td><td>'+s.played+'</td><td>'+s.won+'</td><td>'+s.drawn+'</td><td>'+s.lost+'</td><td>'+(s.scoreFor-s.scoreAgainst)+'</td><td><b>'+s.points+'</b></td></tr>';
    }).join('');
    return '<table class="tbl" style="margin-bottom:10px"><thead><tr><th>#</th><th class="tl">Equipe</th><th>J</th><th>V</th><th>E</th><th>D</th><th>SG</th><th>Pts</th></tr></thead><tbody>'+body+'</tbody></table>';
  }
  function renderStandings(stand){
    if(!stand.length) return '';
    var byG={},order=[];
    stand.forEach(function(s){var g=s.groupName||'_';if(!byG[g]){byG[g]=[];order.push(g);}byG[g].push(s);});
    order.sort();
    return order.map(function(g){
      return (g!=='_'?'<div class="grp-h">Grupo '+esc(g)+'</div>':'')+stdTableHtml(byG[g]);
    }).join('');
  }
  function rankTable(rows, kind){
    if(!rows||!rows.length) return '';
    if(STATS_TEAM) rows=rows.filter(function(r){return r.entryId===STATS_TEAM;});
    var top=rows.filter(function(r){return (kind==='cards'?(r.yellow+r.red):(kind==='assists'?r.assists:r.goals))>0;}).slice(0,10);
    if(!top.length) return '';
    var MED=['🥇','🥈','🥉'];
    var pos=function(i){return '<td class="pos">'+(i<3?MED[i]:(i+1))+'</td>';};
    var nm=function(r){return esc((r.number!=null?r.number+' ':'')+r.name);};
    var tm=function(r){return '<td style="text-align:left;color:#8e8e93">'+esc(r.team||'')+'</td>';};
    var av=function(v){return (v==null?'—':(Math.round(v*100)/100).toString().replace('.',','));};
    var head,body;
    if(kind==='cards'){
      head='<th>J</th><th>🟨</th><th>🟥</th>';
      body=top.map(function(r,i){return '<tr>'+pos(i)+'<td class="tl">'+nm(r)+'</td>'+tm(r)+'<td>'+(r.games||0)+'</td><td>'+r.yellow+'</td><td>'+r.red+'</td></tr>';}).join('');
    }else{
      var col=kind==='assists'?'assists':'goals', label=kind==='assists'?'A':'G';
      head='<th>J</th><th>'+label+'</th><th>Méd</th>';
      body=top.map(function(r,i){return '<tr>'+pos(i)+'<td class="tl">'+nm(r)+'</td>'+tm(r)+'<td>'+(r.games||0)+'</td><td><b>'+r[col]+'</b></td><td>'+av(r.avg)+'</td></tr>';}).join('');
    }
    return '<table class="tbl" style="margin-bottom:10px"><thead><tr><th>#</th><th class="tl">Jogador</th><th class="tl">Equipe</th>'+head+'</tr></thead><tbody>'+body+'</tbody></table>';
  }
  // Times presentes nos rankings (pro filtro da aba Estatísticas), únicos por entryId.
  function statsTeams(){
    var seen={},out=[];
    ['scorers','assists','cards'].forEach(function(k){
      (DATA&&DATA[k]||[]).forEach(function(r){ if(r.entryId&&!seen[r.entryId]){seen[r.entryId]=1;out.push({id:r.entryId,name:r.team||''});} });
    });
    out.sort(function(a,b){return String(a.name).localeCompare(String(b.name));});
    return out;
  }
  function teamFilterHtml(){
    var ts=statsTeams();
    if(ts.length<2) return '';
    var opts='<option value="">Todos os times</option>'+ts.map(function(t){return '<option value="'+esc(t.id)+'"'+(t.id===STATS_TEAM?' selected':'')+'>'+esc(t.name)+'</option>';}).join('');
    return '<select id="stTeam" class="stteam">'+opts+'</select>';
  }
  function teamStatTable(stand, kind){
    var map={},arr=[];
    stand.forEach(function(s){ if(!s.entry)return; var id=s.entry.id||s.entry.name; if(!map[id]){map[id]={entry:s.entry,gf:0,ga:0,pl:0};arr.push(map[id]);} map[id].gf+=(s.scoreFor||0);map[id].ga+=(s.scoreAgainst||0);map[id].pl+=(s.played||0); });
    var played=arr.filter(function(x){return x.pl>0;});
    if(!played.length) return '';
    var val=kind==='defense'?function(x){return x.ga;}:function(x){return x.gf;};
    played.sort(function(a,b){return kind==='defense'?(val(a)-val(b)||a.gf-b.gf):(val(b)-val(a)||a.ga-b.ga);});
    var MED=['🥇','🥈','🥉'];
    var body=played.slice(0,10).map(function(x,i){
      var lg=x.entry.logoUrl?'<img class="tlogo" src="'+esc(x.entry.logoUrl)+'">':'';
      return '<tr><td class="pos">'+(i<3?MED[i]:(i+1))+'</td><td class="tl">'+lg+esc(x.entry.name)+'</td><td>'+x.pl+'</td><td><b>'+val(x)+'</b></td></tr>';
    }).join('');
    return '<table class="tbl" style="margin-bottom:10px"><thead><tr><th>#</th><th class="tl">Equipe</th><th>J</th><th>'+(kind==='defense'?'GC':'GP')+'</th></tr></thead><tbody>'+body+'</tbody></table>';
  }
  // Mata-mata: MESMOS cards do Jogos (com data/ginásio/placar), isolados só no mata-mata,
  // ordenados por fase (…→Semifinais→3º lugar→Final) + card do Campeão quando a final encerra.
  function renderBracket(matches){
    var ko=matches.filter(function(m){return m.stage!=='GROUP'&&m.stage!=='LEAGUE';});
    if(!ko.length) return ek('O mata-mata (semifinais e final) aparece aqui quando a fase de grupos terminar.');
    var SO={RO128:1,RO64:2,RO32:3,RO16:4,QUARTER:5,SEMI:6,THIRD:7,FINAL:8};
    var sorted=ko.slice().sort(function(a,b){return (SO[a.stage]||9)-(SO[b.stage]||9)||(a.round||0)-(b.round||0)||(a.ordering||0)-(b.ordering||0);});
    var html=renderRoundBlocks(sorted);
    var finM=ko.filter(function(m){return m.stage==='FINAL';}).sort(function(a,b){return (a.ordering||0)-(b.ordering||0);})[0];
    if(finM&&(finM.status==='FINISHED'||finM.status==='WALKOVER')&&finM.winnerEntryId){
      var champ=(finM.homeEntry&&finM.homeEntry.id===finM.winnerEntryId)?finM.homeEntry:((finM.awayEntry&&finM.awayEntry.id===finM.winnerEntryId)?finM.awayEntry:null);
      if(champ) html='<div class="bchamp">'+crest(champ)+'<div class="bchamp-t"><span class="bchamp-l">🏆 Campeão</span><span class="bchamp-n">'+esc(champ.name)+'</span></div></div>'+html;
    }
    return html;
  }
  var POLL=null;
  var ek=function(t){return '<div class="empty" style="padding:16px">'+t+'</div>';};
  function renderView(){
    if(!DATA){elBody.innerHTML=ek('Carregando…');return;}
    var html='';
    if(VIEW==='tabela'){
      html=renderStandings(DATA.stand)||ek('A classificação aparece quando os jogos começarem.');
    }else if(VIEW==='mata'){
      html=renderBracket(DATA.matches);
    }else if(VIEW==='stats'){
      var tf=teamFilterHtml();
      if(tf) html+='<div class="stbar">'+tf+'</div>';
      var nt=STATS_TEAM?' deste time':'';
      html+='<div class="sec-h">⚽ Artilheiros</div>'+(rankTable(DATA.scorers,'scorers')||ek('Sem gols'+nt+' ainda — aparece quando os jogos começarem.'));
      html+='<div class="sec-h">🅰 Assistências</div>'+(rankTable(DATA.assists,'assists')||ek('Sem assistências'+nt+' ainda.'));
      html+='<div class="sec-h">🟨 Cartões</div>'+(rankTable(DATA.cards,'cards')||ek('Sem cartões'+nt+' ainda.'));
      if(!STATS_TEAM){
        html+='<div class="sec-h">🎯 Melhor ataque (gols marcados)</div>'+(teamStatTable(DATA.stand,'attack')||ek('Aparece quando os jogos começarem.'));
        html+='<div class="sec-h">🛡 Melhor defesa (gols sofridos)</div>'+(teamStatTable(DATA.stand,'defense')||ek('Aparece quando os jogos começarem.'));
      }
    }else{
      html=renderMatches(DATA.matches);
    }
    elBody.innerHTML=html;
    if(VIEW==='stats'){
      var sel=document.getElementById('stTeam');
      if(sel) sel.addEventListener('change',function(){ STATS_TEAM=this.value; renderView(); });
    }
  }
  function renderViews(){
    elViews.innerHTML=VIEWS.map(function(v){return '<button class="vtab'+(v[0]===VIEW?' active':'')+'" data-v="'+v[0]+'">'+esc(v[1])+'</button>';}).join('');
    Array.prototype.forEach.call(elViews.querySelectorAll('.vtab'),function(b){
      b.addEventListener('click',function(){
        VIEW=b.getAttribute('data-v');
        Array.prototype.forEach.call(elViews.querySelectorAll('.vtab'),function(x){x.classList.remove('active');});
        b.classList.add('active');renderView();
      });
    });
  }
  // cache-buster: URL única a cada chamada + fetch no-store → nunca pega resposta cacheada (iPhone/Safari)
  var cb=function(u){return u+(u.indexOf('?')<0?'?':'&')+'_='+Date.now();};
  var FO={cache:'no-store'};
  function load(catId, silent){
    if(POLL){clearTimeout(POLL);POLL=null;}
    CURID=catId;
    if(!silent){STATS_TEAM='';DATA=null;renderView();}
    var S='/api/tournaments/'+TID+'/stats/';
    var cq='?categoryId='+catId;
    var J=function(u){return fetch(cb(u),FO).then(function(r){return r.json();}).catch(function(){return {};});};
    Promise.all([
      fetch(cb('/api/tournaments/'+TID+'/categories/'+catId+'/matches'),FO).then(function(r){return r.json();}),
      fetch(cb('/api/tournaments/'+TID+'/categories/'+catId+'/standings'),FO).then(function(r){return r.json();}),
      J(S+'scorers'+cq), J(S+'assists'+cq), J(S+'cards'+cq)
    ]).then(function(res){
      if(CURID!==catId) return;
      DATA={ matches:(res[0]&&res[0].matches)||[], stand:(res[1]&&res[1].standings)||[], scorers:(res[2]&&res[2].ranking)||[], assists:(res[3]&&res[3].ranking)||[], cards:(res[4]&&res[4].ranking)||[] };
      renderView();
      if(DATA.matches.some(function(m){return m.status==='LIVE';})){POLL=setTimeout(function(){load(catId,true);},20000);}
    }).catch(function(){if(!silent)elBody.innerHTML=ek('Erro ao carregar.');});
  }
  function renderTabs(){
    elTabs.innerHTML=CATS.map(function(c,i){
      return '<button class="cat'+(i===0?' active':'')+'" data-id="'+c.id+'">'+esc(c.name)+' <span class="cnt">'+c.entries+'</span></button>';
    }).join('');
    Array.prototype.forEach.call(elTabs.querySelectorAll('.cat'),function(b){
      b.addEventListener('click',function(){
        Array.prototype.forEach.call(elTabs.querySelectorAll('.cat'),function(x){x.classList.remove('active');});
        b.classList.add('active');load(b.getAttribute('data-id'));
      });
    });
  }
  if(CATS.length){renderTabs();renderViews();load(CATS[0].id);}else{elBody.innerHTML='<div class="empty">Nenhuma categoria criada ainda.</div>';}
  // Safari restaura a página do bfcache (voltar pra aba) com dado velho → recarrega os dados.
  window.addEventListener('pageshow',function(e){ if(e.persisted && CURID){ load(CURID); } });
})();
</script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error('[/t/:slug] erro:', err);
    res.status(500).send('Erro ao carregar torneio');
  }
});

// Card público do atleta (estilo FIFA) — compartilhável
app.get('/atleta/:username', async (req, res) => {
  try {
    const engine = require('./services/tournamentEngine');
    const userId = await engine.resolveUserId(req.params.username);
    if (!userId) {
      return res
        .status(404)
        .send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Atleta não encontrado</h1></body></html>');
    }
    const card = await engine.buildAthleteCard(userId);
    if (!card) return res.status(404).send('Atleta não encontrado');

    const u = card.user;
    const s = card.stats;
    const overall = card.ratings.length ? card.ratings[0].rating.toFixed(1) : '—';
    const bestSport = card.ratings.length ? APEX_SPORT_LABEL[card.ratings[0].sport] || card.ratings[0].sport : '';
    const initials = (u.name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const place = [u.city, u.state].filter(Boolean).join('/');

    const ratingChips = card.ratings
      .map(
        (r) =>
          '<div class="rt"><div class="rt-v">' + r.rating.toFixed(1) + '</div><div class="rt-s">' +
          apexEsc(APEX_SPORT_LABEL[r.sport] || r.sport) + '</div><div class="rt-w">' + r.wins + 'V · ' + r.losses + 'D</div></div>'
      )
      .join('');

    const statCell = (val, label) =>
      '<div class="sc"><div class="sc-v">' + val + '</div><div class="sc-l">' + label + '</div></div>';

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${apexEsc(u.name)} — Card do Atleta</title>
<meta property="og:title" content="${apexEsc(u.name)} — Card do Atleta">
<meta property="og:description" content="${apexEsc('Rating ' + overall + ' · ' + s.matchesPlayed + ' jogos · ' + s.wins + ' vitórias · ' + s.trainings + ' treinos · Sports & Tennis')}">
<meta property="og:type" content="profile">
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0b0d;color:#fff;line-height:1.5;min-height:100vh;padding:18px 14px env(safe-area-inset-bottom)}
  .wrap{max-width:440px;margin:0 auto}
  .card{position:relative;background:linear-gradient(155deg,#2a2118 0%,#1a1a1f 45%,#0f0f12 100%);border:1.5px solid #E5571E;border-radius:22px;padding:22px;box-shadow:0 18px 50px rgba(229,87,30,.22),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden}
  .card:before{content:"";position:absolute;top:-60px;right:-60px;width:180px;height:180px;background:radial-gradient(circle,rgba(229,87,30,.35),transparent 70%);}
  .top{display:flex;gap:16px;align-items:center;position:relative}
  .ovr{text-align:center;flex-shrink:0}
  .ovr-v{font-size:46px;font-weight:900;line-height:1;color:#fff;text-shadow:0 2px 10px rgba(229,87,30,.5)}
  .ovr-l{font-size:10px;font-weight:800;letter-spacing:1.5px;color:#E5571E;margin-top:2px}
  .ovr-s{font-size:11px;color:#b9b9c0;margin-top:4px}
  .avatar{width:80px;height:80px;border-radius:50%;border:2.5px solid #E5571E;object-fit:cover;background:#E5571E;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:900;color:#fff;flex-shrink:0;margin-left:auto}
  .who{margin-top:18px;position:relative}
  .who h1{font-size:23px;font-weight:900;letter-spacing:.3px}
  .who .at{color:#E5571E;font-size:14px;font-weight:700;margin-top:1px}
  .who .loc{color:#9a9aa2;font-size:13px;margin-top:3px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:20px;position:relative}
  .sc{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:13px;padding:12px 6px;text-align:center}
  .sc-v{font-size:22px;font-weight:900;color:#fff}
  .sc-l{font-size:10px;color:#9a9aa2;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:3px}
  .rts{display:flex;gap:10px;overflow-x:auto;margin-top:18px;scrollbar-width:none;position:relative}
  .rts::-webkit-scrollbar{display:none}
  .rt{flex-shrink:0;background:linear-gradient(135deg,#E5571E,#EE7240);border-radius:13px;padding:12px 16px;text-align:center;min-width:96px}
  .rt-v{font-size:24px;font-weight:900}
  .rt-s{font-size:11px;font-weight:700;margin-top:2px}
  .rt-w{font-size:10px;opacity:.85;margin-top:2px}
  .bdg{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px;position:relative}
  .bdg span{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;color:#ffd479}
  .actions{display:flex;gap:10px;margin-top:18px}
  .btn{flex:1;border:none;border-radius:13px;padding:14px;font-size:14px;font-weight:800;cursor:pointer;-webkit-tap-highlight-color:transparent}
  .btn-p{background:#E5571E;color:#fff}
  .btn-s{background:rgba(255,255,255,.1);color:#fff}
  .foot{text-align:center;color:#5a5a62;font-size:11px;margin-top:18px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="top">
        <div class="ovr">
          <div class="ovr-v">${overall}</div>
          <div class="ovr-l">RATING</div>
          ${bestSport ? '<div class="ovr-s">' + apexEsc(bestSport) + '</div>' : ''}
        </div>
        ${u.avatarUrl ? '<img class="avatar" src="' + apexEsc(u.avatarUrl) + '" alt="">' : '<div class="avatar">' + apexEsc(initials) + '</div>'}
      </div>
      <div class="who">
        <h1>${apexEsc(u.name)}</h1>
        ${u.username ? '<div class="at">@' + apexEsc(u.username) + '</div>' : ''}
        ${place ? '<div class="loc">📍 ' + apexEsc(place) + '</div>' : ''}
      </div>
      <div class="grid">
        ${statCell(s.trainings, 'Treinos')}
        ${statCell(s.matchesPlayed, 'Jogos')}
        ${statCell(s.wins, 'Vitórias')}
        ${statCell(s.winRate + '%', 'Aproveit.')}
        ${statCell(s.tournaments, 'Torneios')}
        ${statCell(s.xp, 'XP')}
      </div>
      ${ratingChips ? '<div class="rts">' + ratingChips + '</div>' : ''}
      ${card.badges.length ? '<div class="bdg">' + card.badges.map((b) => '<span>🏅 ' + apexEsc(b.key) + '</span>').join('') + '</div>' : ''}
      <div class="actions">
        <button class="btn btn-p" id="shareBtn">Compartilhar</button>
        <a class="btn btn-s" href="/" style="text-decoration:none;text-align:center">Abrir o app</a>
      </div>
    </div>
    <div class="foot">${PUBLIC_DOMAIN} · Sports &amp; Tennis</div>
  </div>
<script>
(function(){
  var NAME=${JSON.stringify(u.name)};
  function share(){
    var url=location.href;
    var txt='Confira o card de '+NAME+' no Sports & Tennis: '+url;
    if(navigator.share){navigator.share({title:NAME,text:txt,url:url}).catch(function(){});}
    else{window.open('https://wa.me/?text='+encodeURIComponent(txt),'_blank');}
  }
  document.getElementById('shareBtn').addEventListener('click',share);
})();
</script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error('[/atleta/:username] erro:', err);
    res.status(500).send('Erro ao carregar card');
  }
});

// Live commerce — vitrine ao vivo do cliente. /aovivo/LOJA01 (slug lido no front).
app.get(['/aovivo', '/aovivo/:loja'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/aovivo.html'), { cacheControl: false });
});

// Live commerce — painel do vendedor (login próprio + chat + ligar/desligar transmissão).
app.get('/atendimento', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/atendimento.html'), { cacheControl: false });
});

// ===================================================================
// INFOPRODUTOS — páginas públicas (mobile-first)
// ===================================================================
const _infoPage = (file) => (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/' + file), { cacheControl: false });
};
// Página de vendas do produto digital + checkout inline (/pd/:slug e /pay/:slug autocompra)
app.get('/copa', _infoPage('copa.html'));
app.get('/copa-figurinhas', _infoPage('copa-figurinhas.html'));
app.get(['/pd/:slug', '/pay/:slug'], _infoPage('produto.html'));
// Área de membros: player do curso (login-free via accessToken)
app.get('/curso/:token', _infoPage('curso.html'));
// Meus cursos (compras do cliente logado)
app.get('/membros', _infoPage('membros.html'));
// Painel do afiliado
app.get('/afiliado', _infoPage('afiliado.html'));
// Verificação pública de certificado
app.get('/cert/:code', _infoPage('certificado.html'));

// ===================================================================
// DESAPEGA — marketplace de usados (mobile-first)
// ===================================================================
// Vitrine pública + detalhe (detalhe é resolvido no client via /item/:id)
app.get(['/desapega', '/desapega/item/:id'], _infoPage('desapega.html'));
// Link de cadastro do vendedor (fotos + descrição) + acompanhamento por token
app.get(['/desapega/vender', '/desapega/acompanhar/:token'], _infoPage('desapega-vender.html'));
// Painel de moderação (login admin + fila aprovar/reprovar)
app.get('/desapega/admin', _infoPage('desapega-admin.html'));

// META FARDAMENTOS — sistema proprio (ERP/CRM/estoque/categoria/ponto)
app.get('/metafardamentos', _infoPage('metafardamentos.html'));

// Link de afiliado rastreado: conta clique, grava cookie tc_ref, redireciona pra página de vendas
app.get('/r/:code', async (req, res) => {
  const code = String(req.params.code || '').trim();
  try {
    const { prisma } = require('./middleware');
    const link = await prisma.affiliateLink.findUnique({
      where: { code },
      include: { product: { select: { slug: true, visible: true, status: true } } },
    });
    if (!link || !link.product || !link.product.slug) {
      return res.redirect(302, '/');
    }
    // grava clique (não bloqueia o redirect se falhar)
    prisma.affiliateLink.update({ where: { code }, data: { clicks: { increment: 1 } } }).catch(() => {});
    prisma.affiliateClick.create({
      data: {
        affiliateId: link.affiliateId,
        productId: link.productId,
        linkCode: code,
        visitorToken: code,
        ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64),
        userAgent: (req.headers['user-agent'] || '').toString(),
      },
    }).catch(() => {});
    // cookie 30 dias, legível pelo front (httpOnly:false)
    res.cookie('tc_ref', code, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
    });
    return res.redirect(302, '/pd/' + encodeURIComponent(link.product.slug) + '?ref=' + encodeURIComponent(code));
  } catch (e) {
    console.error('[/r/:code] erro:', e.message);
    return res.redirect(302, '/');
  }
});

// Fallback SPA → app cliente
app.get('*', (req, res) => {
  if (siteBrand.isSportsTennisHost(req)) {
    try { return res.type('html').send(siteBrand.brandedIndexHtml()); } catch (_) { /* cai no padrão */ }
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`TenisCash API rodando na porta ${PORT}`);

  // Migração aditiva/idempotente das colunas novas do APEX (o deploy não roda
  // prisma db push). Garante cashEnabled/prizePaidAt/entryTxId/AppNotification.
  try {
    const { prisma } = require('./middleware');
    const { ensureApexSchema } = require('./services/ensureApexSchema');
    ensureApexSchema(prisma).catch((e) => console.error('[ensureApexSchema] erro:', e.message));
  } catch (e) {
    console.error('[ensureApexSchema] falha ao iniciar:', e.message);
  }

  // Financeiro do varejo: SQL aditivo/idempotente (as rotas /api/fin também garantem antes de responder).
  try {
    finRoutes.ensureFinSchema().then(() => console.log('[finSchema] ok')).catch((e) => console.error('[finSchema] erro:', e.message));
  } catch (e) {
    console.error('[finSchema] falha ao iniciar:', e.message);
  }

  try {
    require('./services/cameraBandCorrection').startCameraBandCorrection(PORT);
  } catch (e) {
    console.error('[camera-correction] falha ao iniciar:', e.message);
  }

  // Estoque, gate e limpeza reversivel da Nuvemshop nao dependem dos crons de IA.
  try { startNuvemshopStockCron(); } catch (e) { console.error('[nsStockCron] falha ao iniciar:', e.message); }
  try { startQROffersCron(); } catch (e) { console.error('[qrOffersCron] falha ao iniciar:', e.message); }
  try { startImageRepairCron(); } catch (e) { console.error('[imageRepairCron] falha ao iniciar:', e.message); }

  // Cron mensagens (expira posts de timeline 00:00 America/Fortaleza)
  if (process.env.DISABLE_MESSAGES_CRON !== '1') {
    try { startMessagesCron(); } catch (e) { console.error('[messagesCron] falha ao iniciar:', e.message); }
  }

  // Cron marketing IA (trend 05:00 + content 06:00 America/Fortaleza)
  // Só ativa se FAL_KEY estiver configurada (senão não tem como gerar)
  if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
    try { startDailyAgentsCron(); } catch (e) { console.error('[dailyAgentsCron] falha ao iniciar:', e.message); }
  } else {
    console.log('[dailyAgentsCron] desativado - sem OPENAI_API_KEY/ANTHROPIC_API_KEY');
  }

  if (process.env.FAL_KEY) {
    try { startMarketingCron(); } catch (e) { console.error('[marketingCron] falha ao iniciar:', e.message); }
    try { startCatalogEngineCron(); } catch (e) { console.error('[catalogEngineCron] falha ao iniciar:', e.message); }
  } else {
    console.log('[marketingCron] desativado — FAL_KEY não configurada');
  }

  // Cron serviços (barbearia/salão): cobrança do clube de assinatura + lembretes
  if (process.env.DISABLE_SERVICES_CRON !== '1') {
    try { startServicesCron(); } catch (e) { console.error('[servicesCron] falha ao iniciar:', e.message); }
  }

  // Robô do grupo da empresa (relatórios de vendas/presença/tarefas 13h/18h/21h no WhatsApp):
  // DESATIVADO a pedido do dono em 2026-07-29 — não publicar relatórios das pessoas no grupo.
  // Para reativar, descomente a linha abaixo (e faça deploy).
  // try { startEquipeReportsCron(); } catch (e) { console.error('[equipeReports] falha ao iniciar:', e.message); }
  try { startWhatsappHealthCron(); } catch (e) { console.error('[waHealth] falha ao iniciar:', e.message); }

  // Checklist diario dos vendedores escalados. Nao aplica penalidades automaticamente.
  if (process.env.DISABLE_SELLER_PRODUCTION_CRON !== '1') {
    try { startSellerProductionCron(); } catch (e) { console.error('[sellerProductionCron] falha ao iniciar:', e.message); }
  }

  // Cron jobs em background
  if (process.env.DISABLE_FISCAL_DRAFT_JOB !== '1') {
    try {
      const { startFiscalDraftJob } = require('./services/fiscalDraftJob');
      startFiscalDraftJob();
    } catch (e) {
      console.error('[boot] falha ao iniciar fiscalDraftJob:', e.message);
    }
  }

  // Robô do NCM: 1x/dia preenche o NCM faltante/inválido pela NFe de entrada
  if (process.env.DISABLE_NCM_ROBOT !== '1') {
    try {
      const { startNcmRobot } = require('./services/ncmRobot');
      startNcmRobot();
    } catch (e) {
      console.error('[boot] falha ao iniciar ncmRobot:', e.message);
    }
  }
});

// Stop accepting new uploads before retiring workers. Any unacknowledged
// durable job remains in PostgreSQL for the next process to recover.
let shuttingDown = false;
async function shutdownScanner() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  const drained = new Promise(resolve => server.close(resolve));
  try {
    await require('./services/stockReplacementQueue').stopAll();
    await require('./services/scannerImageBroker').shutdown();
    await drained;
    await require('./middleware').prisma.$disconnect();
    process.exitCode = 0;
  } catch (_) { process.exitCode = 1; }
  finally { clearTimeout(deadline); process.exit(process.exitCode || 0); }
}
process.once('SIGTERM', shutdownScanner);
process.once('SIGINT', shutdownScanner);
