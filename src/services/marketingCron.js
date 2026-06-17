// =====================================================================
// Cron Marketing IA — America/Fortaleza
// =====================================================================
// 05:00 → trend-watcher (log only por enquanto; futuro: web search + write trends)
// 06:00 → content-creative (seleciona produtos + gera criativos via fal.ai)
//
// Regra permanente (CLAUDE.md): timezone explícito America/Fortaleza,
// senão Railway roda em UTC e tudo dispara 21:00 horário de PB.
// =====================================================================

const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { generateDailySlate } = require('./dailySlate');
const { runBrain, runLearn } = require('./marketingLoop');

const prisma = new PrismaClient();
const TZ = 'America/Fortaleza';

// Disable via env (ex: testes locais)
const DISABLED = process.env.DISABLE_MARKETING_CRON === '1';

// ====================================================
// 05:30 → daily-slate (MOLDE do dia: 4 produtos/loja + 5 temas)
// Gera pauta+copy do estoque real e salva no Config (key=daily_slate).
// A Agência /reels.html lê esse molde. NÃO publica.
// ====================================================
async function runDailySlate() {
  const startedAt = new Date();
  console.log(`[marketingCron] daily-slate start | PB=${startedAt.toLocaleString('pt-BR', { timeZone: TZ })}`);
  try {
    const slate = await generateDailySlate({});
    console.log(`[marketingCron] daily-slate ok: ${slate.produtos.length} produtos + ${slate.temas.length} temas${slate.errors.length ? ' | erros: ' + slate.errors.join('; ') : ''}`);
  } catch (err) {
    console.error('[marketingCron] daily-slate erro:', err.message);
  }
}

// ====================================================
// 05:45 → LOOP brain (estação 1: cérebro decide a pauta lendo o aprendizado)
// 21:30 → LOOP learn (estação 6->1: aprende com a performance medida)
// O anel fechado: o que performou ontem decide a pauta de hoje.
// ====================================================
async function runMarketingBrain() {
  try {
    const s = await runBrain({});
    console.log(`[marketingCron] loop-brain ok: ${s.total} itens${s.errors.length ? ' | erros: ' + s.errors.join('; ') : ''}`);
  } catch (err) {
    console.error('[marketingCron] loop-brain erro:', err.message);
  }
}
async function runMarketingLearn() {
  try {
    const r = await runLearn();
    console.log(`[marketingCron] loop-learn: ${r.ok ? ('aprendeu (' + r.measuredCount + ' medidos)') : r.reason}`);
  } catch (err) {
    console.error('[marketingCron] loop-learn erro:', err.message);
  }
}

// ====================================================
// 05:00 → trend-watcher (placeholder)
// ====================================================
async function runTrendWatcher() {
  const startedAt = new Date();
  console.log(`[marketingCron] trend-watcher start | UTC=${startedAt.toISOString()} | PB=${startedAt.toLocaleString('pt-BR', { timeZone: TZ })}`);
  try {
    // TODO: integrar com Anthropic web search ou WebSearch tool pra buscar trends BR
    // Por enquanto, log only — quando trend-watcher-agent ficar funcional,
    // chamar aqui e salvar output em Config (key='marketing_trends_today')
    console.log('[marketingCron] trend-watcher: stub — substituir por chamada real ao agent');
  } catch (err) {
    console.error('[marketingCron] trend-watcher erro:', err.message);
  }
}

// ====================================================
// 06:00 → content-creative (gera 5 criativos)
// ====================================================
async function runContentCreative() {
  const startedAt = new Date();
  console.log(`[marketingCron] content-creative start | UTC=${startedAt.toISOString()} | PB=${startedAt.toLocaleString('pt-BR', { timeZone: TZ })}`);

  try {
    // Hard limit: max 5 criativos/dia rodando automaticamente
    // (custo cap ~$3-5/dia normal, ~$10 se trio completo por produto)
    const MAX_DAILY = 5;

    // 1. Conferir se já rodou hoje (pra não duplicar em restart)
    const todayStart = await getTodayStartFortaleza();
    const alreadyGenerated = await prisma.productCreative.count({
      where: { createdAt: { gte: todayStart } },
    });
    if (alreadyGenerated >= MAX_DAILY) {
      console.log(`[marketingCron] já gerou ${alreadyGenerated} criativos hoje, pulando`);
      return;
    }

    // 2. Selecionar candidatos usando heurística simples
    //    (versão completa: chamar content-creative-agent que cruza estoque+giro+trend)
    const candidates = await selectCandidates(MAX_DAILY - alreadyGenerated);
    if (candidates.length === 0) {
      console.log('[marketingCron] sem candidatos elegíveis pra gerar');
      return;
    }

    console.log(`[marketingCron] selecionou ${candidates.length} candidatos: ${candidates.map(p => p.sku).join(', ')}`);

    // 3. Pra cada candidato, chamar o serviço fal.ai
    //    (chama internamente; não bate no endpoint REST porque seria recursão)
    const falAi = require('./falAi');
    const copyGen = require('./copyGenerator');

    // Vídeo desabilitado no cron — gasta muito ($0.50/video Hailuo Pro).
    // Trio diário = foto editorial ($0.04) + sem-fundo ($0.01) + copies = $0.05/produto.
    // Vídeo só sob demanda (botão manual no admin) ou se ENABLE_VIDEO_IN_CRON=1.
    const includeVideo = process.env.ENABLE_VIDEO_IN_CRON === '1';

    for (const product of candidates) {
      try {
        console.log(`[marketingCron] gerando criativo pra ${product.sku} (${product.name.slice(0,50)})${includeVideo ? ' [com vídeo]' : ' [sem vídeo — econômico]'}`);
        const tasks = [
          falAi.generateEditorialPhoto({
            product,
            aspectRatio: '16:9',
          }),
          falAi.removeBackground({ imageUrl: product.imageUrl }),
          copyGen.generateCopies({
            productName: product.name,
            brand: product.brand,
            category: product.category,
            price: product.price,
            shortDesc: product.shortDescription,
          }),
        ];
        if (includeVideo) {
          tasks.splice(1, 0, falAi.generateReelVideo({
            imageUrl: product.imageUrl,
            productName: product.name,
          }));
        }
        const settled = await Promise.allSettled(tasks);

        // Indices: [editorial, video?, transparent, copies]
        const editorial = settled[0];
        const video = includeVideo ? settled[1] : { status: 'skipped' };
        const transparent = settled[includeVideo ? 2 : 1];
        const copies = settled[includeVideo ? 3 : 2];

        const c = copies.status === 'fulfilled' ? copies.value : { captionIg:'', captionTiktok:'', captionWa:'', hashtags:'' };
        const items = [
          { result: editorial, kind: 'editorial_photo' },
          ...(includeVideo ? [{ result: video, kind: 'reel_video' }] : []),
          { result: transparent, kind: 'transparent_photo' },
        ];

        for (const it of items) {
          if (it.result.status !== 'fulfilled') {
            console.warn(`[marketingCron] ${it.kind} falhou pra ${product.sku}: ${it.result.reason?.message}`);
            continue;
          }
          const r = it.result.value;
          await prisma.productCreative.create({
            data: {
              productId: product.id,
              kind: it.kind,
              outputUrl: r.outputUrl,
              model: r.model,
              prompt: r.prompt,
              costUsd: r.costUsd,
              captionIg: c.captionIg,
              captionTiktok: c.captionTiktok,
              captionWa: c.captionWa,
              hashtags: c.hashtags,
              status: 'pending_review',
            },
          });
        }
        console.log(`[marketingCron] ✓ ${product.sku} ok`);
      } catch (err) {
        console.error(`[marketingCron] erro pra ${product.sku}:`, err.message);
      }
    }

    // 4. Notificar Douglas via push
    try {
      const pushSvc = require('./pushNotifications');
      const admins = await prisma.user.findMany({
        where: { role: { in: ['admin', 'superadmin', 'manager'] }, active: true },
        select: { id: true },
      });
      for (const a of admins) {
        pushSvc.sendToUser(a.id, {
          title: '🎨 Criativos prontos pra aprovar',
          body: `${candidates.length} produtos novos no marketing IA. Toque pra revisar.`,
          url: '/admin.html?tab=marketing',
          tag: 'marketing-daily',
        }).catch(() => {});
      }
    } catch (e) { /* push best-effort */ }

    console.log('[marketingCron] content-creative concluído');
  } catch (err) {
    console.error('[marketingCron] content-creative erro:', err.message);
  }
}

// ====================================================
// Helpers
// ====================================================

async function getTodayStartFortaleza() {
  const r = await prisma.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')::timestamp AS today`;
  return r[0].today;
}

// Seleciona produtos pra gerar criativo hoje.
// Heurística simples (sem trend-watcher ainda):
//   - active=true, tem imageUrl, price > 0
//   - NÃO teve criativo nos últimos 30 dias
//   - Ordena por: featured primeiro, depois aleatório
async function selectCandidates(limit) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Produtos já usados nos últimos 30d
  const recentlyUsed = await prisma.productCreative.findMany({
    where: { createdAt: { gte: thirtyDaysAgo } },
    select: { productId: true },
    distinct: ['productId'],
  });
  const excludedIds = recentlyUsed.map(c => c.productId);

  const products = await prisma.product.findMany({
    where: {
      active: true,
      imageUrl: { not: null },
      price: { gt: 0 },
      id: { notIn: excludedIds.length > 0 ? excludedIds : ['__never__'] },
    },
    orderBy: [{ featured: 'desc' }],
    take: limit * 8,  // pool maior pra randomizar com diversidade
    select: { id: true, sku: true, name: true, brand: true, category: true, subcategory: true, price: true, imageUrl: true, imageUrls: true, aiContext: true, shortDescription: true },
  });

  // Diversifica: max 1 por marca
  const seenBrands = new Set();
  const picked = [];
  for (const p of products) {
    const brand = (p.brand || 'sem-marca').toLowerCase();
    if (seenBrands.has(brand)) continue;
    seenBrands.add(brand);
    picked.push(p);
    if (picked.length >= limit) break;
  }
  return picked;
}

// ====================================================
// Boot
// ====================================================
function startMarketingCron() {
  if (DISABLED) {
    console.log('[marketingCron] desabilitado via DISABLE_MARKETING_CRON=1');
    return;
  }
  cron.schedule('0 5 * * *', runTrendWatcher, { timezone: TZ });
  cron.schedule('30 5 * * *', runDailySlate, { timezone: TZ });
  cron.schedule('45 5 * * *', runMarketingBrain, { timezone: TZ });
  cron.schedule('0 6 * * *', runContentCreative, { timezone: TZ });
  cron.schedule('30 21 * * *', runMarketingLearn, { timezone: TZ });
  console.log(`[marketingCron] agendado: trend 05:00 + slate 05:30 + loop-brain 05:45 + content 06:00 + loop-learn 21:30 (timezone ${TZ})`);
}

module.exports = { startMarketingCron, runTrendWatcher, runContentCreative, runDailySlate, runMarketingBrain, runMarketingLearn };
