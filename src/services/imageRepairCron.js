// Safe, resumable repair queue for active catalog products without an image.
// A candidate is written only after Claude Vision explicitly confirms the
// exact product with score >= 8. Rejections and attempts are persisted in
// Product.aiContext so a restart never spends twice on the same batch.
const cron = require('node-cron');
const { prisma } = require('../middleware');
const { curateProduct } = require('./curationAgent');
const serperImages = require('./serperImageSearch');
const vision = require('./visionValidator');

const TZ = 'America/Fortaleza';
const ACCEPTED_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
const ERROR_RETRY_MS = 6 * 60 * 60 * 1000;
let running = false;
let continuationTimer = null;

const state = {
  running: false,
  enabled: null,
  configured: null,
  phase: 'idle',
  progress: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
  lastResult: null,
};

function parseContext(value) {
  try {
    return (typeof value === 'string' ? JSON.parse(value) : value) || {};
  } catch (_) {
    return {};
  }
}

function shouldAttemptImage(aiContext, now = new Date()) {
  const review = parseContext(aiContext).imageAutoReview;
  if (!review || !review.attemptedAt) return true;
  const attemptedAt = new Date(review.attemptedAt).getTime();
  if (!Number.isFinite(attemptedAt)) return true;
  const retryMs = review.state === 'error' ? ERROR_RETRY_MS : ACCEPTED_RETRY_MS;
  return now.getTime() - attemptedAt >= retryMs;
}

function stockUnits(product) {
  return (product.sizes || []).reduce(
    (total, size) => total + (size.storeStocks || []).reduce((sum, row) => sum + Math.max(0, Number(row.stock) || 0), 0),
    0,
  );
}

async function recordAttempt(productId, review) {
  const current = await prisma.product.findUnique({
    where: { id: productId },
    select: { aiContext: true },
  });
  if (!current) return;
  const context = parseContext(current.aiContext);
  context.imageAutoReview = review;
  await prisma.product.update({ where: { id: productId }, data: { aiContext: context } });
}

function reviewState(report) {
  const image = report?.steps?.image;
  if (report?.error) return { state: 'error', reason: report.error };
  if (image?.ok && image?.url) {
    return { state: 'accepted', reason: image.reason || null, score: Number(image.score) || null };
  }
  const reason = String(image?.reason || 'imagem nao aprovada');
  const transient = /indispon.vel|falhou|timeout|rate|429|500|502|503/i.test(reason);
  return {
    state: transient ? 'error' : 'rejected',
    reason: reason.slice(0, 500),
    score: Number(image?.topScore) || null,
  };
}

async function runImageRepairBatch(options = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  state.running = true;
  state.phase = 'checking';
  state.progress = null;
  state.lastStartedAt = new Date().toISOString();
  state.lastError = null;
  try {
    const configured = {
      search: serperImages.isConfigured(),
      vision: vision.isConfigured(),
    };
    state.configured = configured;
    if (!configured.search || !configured.vision) {
      const missing = [!configured.search && 'SERPER_API_KEY', !configured.vision && 'ANTHROPIC_API_KEY'].filter(Boolean);
      const result = { blocked: true, reason: `configuracao ausente: ${missing.join(', ')}` };
      state.phase = 'blocked';
      state.lastResult = result;
      return result;
    }

    const batchSize = Math.min(Math.max(Number(options.batchSize || process.env.IMAGE_REPAIR_BATCH || 50), 1), 250);
    const now = new Date();
    state.phase = 'loading';
    const [products, mappings] = await Promise.all([
      prisma.product.findMany({
        where: { active: true, OR: [{ imageUrl: null }, { imageUrl: '' }] },
        select: {
          id: true,
          sku: true,
          aiContext: true,
          updatedAt: true,
          sizes: { select: { storeStocks: { select: { stock: true } } } },
        },
      }),
      prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } }),
    ]);
    const mapped = new Set(mappings.map((row) => row.localProductId));
    const eligible = products
      .filter((product) => shouldAttemptImage(product.aiContext, now))
      .sort((a, b) => {
        const stockDiff = stockUnits(b) - stockUnits(a);
        if (stockDiff) return stockDiff;
        const mappedDiff = Number(mapped.has(b.id)) - Number(mapped.has(a.id));
        if (mappedDiff) return mappedDiff;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
    const candidates = eligible.slice(0, batchSize);
    const progress = {
      totalMissing: products.length,
      eligible: eligible.length,
      batchSize,
      processed: 0,
      accepted: 0,
      rejected: 0,
      errors: 0,
      costBRL: 0,
      recentIssues: [],
    };
    state.progress = progress;
    state.phase = candidates.length ? 'curating' : 'complete';

    for (const product of candidates) {
      let report;
      try {
        report = await curateProduct(product.id, {
          skipDescription: true,
          skipNuvemshop: true,
          imageCandidates: 6,
          minScore: 8,
        });
      } catch (error) {
        report = { error: error.message, steps: { image: null } };
      }
      const review = reviewState(report);
      try {
        await recordAttempt(product.id, {
          ...review,
          attemptedAt: new Date().toISOString(),
          source: 'automatic-safe-repair',
        });
      } catch (error) {
        review.state = 'error';
        review.reason = `nao foi possivel registrar a revisao: ${error.message}`;
      }
      progress.processed++;
      progress[review.state === 'accepted' ? 'accepted' : review.state === 'rejected' ? 'rejected' : 'errors']++;
      progress.costBRL = Number((progress.costBRL + (Number(report?.costBRL) || 0)).toFixed(4));
      if (review.state !== 'accepted') {
        progress.recentIssues.push({ state: review.state, reason: String(review.reason || '').slice(0, 240) });
        if (progress.recentIssues.length > 8) progress.recentIssues.shift();
      }
    }

    const remainingMissing = await prisma.product.count({
      where: { active: true, OR: [{ imageUrl: null }, { imageUrl: '' }] },
    });
    const result = {
      ...progress,
      remainingMissing,
      moreEligible: eligible.length > candidates.length,
    };
    state.lastResult = result;
    state.phase = 'complete';
    return result;
  } catch (error) {
    state.lastError = error.message;
    state.phase = 'error';
    throw error;
  } finally {
    running = false;
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
  }
}

async function tick() {
  let result;
  try {
    result = await runImageRepairBatch();
    if (result && !result.skipped) console.log('[imageRepairCron]', JSON.stringify(result));
  } catch (error) {
    console.error('[imageRepairCron] falha:', error.message);
  }
  if (result?.moreEligible && !continuationTimer) {
    continuationTimer = setTimeout(() => {
      continuationTimer = null;
      tick();
    }, 15000);
  }
}

function getImageRepairCronState() {
  return JSON.parse(JSON.stringify(state));
}

function startImageRepairCron() {
  state.enabled = process.env.DISABLE_IMAGE_REPAIR_CRON !== '1';
  if (!state.enabled) {
    state.phase = 'disabled';
    return;
  }
  setTimeout(() => tick(), 30000);
  cron.schedule('0 */6 * * *', tick, { timezone: TZ });
}

module.exports = {
  getImageRepairCronState,
  parseContext,
  reviewState,
  runImageRepairBatch,
  shouldAttemptImage,
  startImageRepairCron,
  stockUnits,
  tick,
};
