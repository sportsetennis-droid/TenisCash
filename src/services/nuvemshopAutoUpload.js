// =====================================================================
// Subida AUTOMÁTICA de produto novo para a Nuvemshop (dono 2026-11-16:
// "deixe isso automático").
//
// Sobe sozinho todo card que passa na TRAVA COMPLETA do site
// (assessProductForNuvemshop — classificação, foto, descrição, preço > custo,
// nome/cor limpos, estoque físico nas lojas que valem pro site, sem oculto)
// e que NÃO repete nada que já está na loja (dono 2026-11-15: "é proibido
// repetir produto"):
//   1) não mapeado (NuvemshopProductMapping);
//   2) nenhum código de barras dele já está em produto mapeado NEM em
//      variante publicada na loja (lido da API da Nuvemshop);
//   3) referência+cor não repete card já mapeado;
//   4) dentro da própria rodada, o 1º card vence e o 2º fica de fora.
// Produto oculto manualmente (hideFromNuvemshop) nunca sobe.
// Falha de envio (ex: foto que a Nuvemshop não baixa) espera 24h pra tentar de
// novo, salvo se o card for editado.
// Desligar: env NS_AUTO_UPLOAD=0. Lote por rodada: NS_AUTO_UPLOAD_BATCH (40).
// =====================================================================
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const ns = require('./nuvemshop');
const nsHandlers = require('./nuvemshopHandlers');
const { assessProductForNuvemshop, nuvemshopStoreStocksQuery } = require('./nuvemshopEligibility');

const TZ = 'America/Fortaleza';
const RETRY_MS = 24 * 60 * 60 * 1000;
let busy = false;
const state = {
  enabled: process.env.NS_AUTO_UPLOAD !== '0',
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
  lastResult: null,
};

function ctxOf(product) {
  try {
    return (typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext) || {};
  } catch (_) {
    return {};
  }
}

function realBarcode(code) {
  const c = String(code || '').trim();
  if (!c || /^SEM\s*GTIN$/i.test(c)) return null;
  return c;
}

function refColorKey(product) {
  const sku = String(product.sku || '').trim().toUpperCase();
  if (!sku) return null;
  const color = String(ctxOf(product).color || '').trim().toUpperCase();
  return `${sku}|${color}`;
}

const LIGHT_SELECT = {
  id: true, active: true, name: true, sku: true, brand: true, category: true, subcategory: true,
  shortDescription: true, longDescription: true, price: true, costPrice: true, aiContext: true,
  updatedAt: true,
  sizes: { include: { storeStocks: nuvemshopStoreStocksQuery() } },
};

async function runNuvemshopAutoUpload({ limit } = {}) {
  if (busy) return state.lastResult;
  busy = true;
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  state.lastError = null;
  const batch = Math.max(1, Number(limit || process.env.NS_AUTO_UPLOAD_BATCH || 40));
  const result = {
    candidates: 0, eligible: 0, uploaded: 0, failed: 0, waitingRetry: 0,
    skippedDuplicate: 0, duplicates: [], failures: [], uploadedIds: [],
  };
  try {
    const connection = await nsHandlers.getConnection();
    if (!connection) throw new Error('sem conexao Nuvemshop ativa');

    // ---- O que JÁ está na loja (pra nunca repetir) ----
    const mappings = await prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } });
    const mappedIds = new Set(mappings.map((m) => m.localProductId));
    const takenBarcodes = new Set();
    const takenRefColor = new Set();
    const mappedProducts = await prisma.product.findMany({
      where: { id: { in: [...mappedIds] } },
      select: { sku: true, aiContext: true, sizes: { select: { barcode: true } } },
    });
    for (const p of mappedProducts) {
      for (const s of p.sizes) { const b = realBarcode(s.barcode); if (b) takenBarcodes.add(b); }
      const k = refColorKey(p);
      if (k) takenRefColor.add(k);
    }
    // Variantes publicadas na loja de verdade (cobre produto na loja sem mapping local).
    const remote = await ns.fetchAllPages(connection, '/products', { perPage: 100, max: 10000 });
    for (const rp of remote || []) {
      for (const v of rp.variants || []) {
        const b1 = realBarcode(v.barcode); if (b1) takenBarcodes.add(b1);
        const b2 = realBarcode(v.sku); if (b2) takenBarcodes.add(b2);
      }
    }

    // ---- Candidatos: ativos, não mapeados, passam na trava (sem confirmação) ----
    const rows = await prisma.product.findMany({
      where: { active: true, id: { notIn: [...mappedIds] } },
      select: LIGHT_SELECT,
    });
    result.candidates = rows.length;
    const now = Date.now();
    const queue = [];
    for (const p of rows) {
      // 1ª passada sem carregar as fotos (base64 pesa): finge foto pra ver o resto da trava.
      const pre = assessProductForNuvemshop({ ...p, imageUrl: 'https://check' }, { requireConfirmation: false });
      if (!pre.eligible) continue;
      const ctx = ctxOf(p);
      const lastFail = ctx.nsAutoUpload && ctx.nsAutoUpload.lastFailAt ? Date.parse(ctx.nsAutoUpload.lastFailAt) : 0;
      // editado depois da falha (ex: foto nova) = tenta de novo na hora
      const editedAfterFail = lastFail && new Date(p.updatedAt).getTime() - lastFail > 60 * 1000;
      if (lastFail && now - lastFail < RETRY_MS && !editedAfterFail) { result.waitingRetry++; continue; }
      queue.push(p);
    }

    for (const light of queue) {
      if (result.uploaded + result.failed >= batch) break;
      const full = await prisma.product.findUnique({
        where: { id: light.id },
        include: { sizes: { include: { storeStocks: nuvemshopStoreStocksQuery() } } },
      });
      if (!full || mappedIds.has(full.id)) continue;
      const check = assessProductForNuvemshop(full, { requireConfirmation: false, isNew: true });
      if (!check.eligible) continue;
      result.eligible++;

      const codes = (full.sizes || []).map((s) => realBarcode(s.barcode)).filter(Boolean);
      const key = refColorKey(full);
      const clash = codes.find((c) => takenBarcodes.has(c));
      if (clash || (key && takenRefColor.has(key))) {
        result.skippedDuplicate++;
        if (result.duplicates.length < 30) {
          result.duplicates.push({ id: full.id, name: full.name, why: clash ? `codigo ${clash} ja na loja` : 'ref+cor ja na loja' });
        }
        continue;
      }

      const ctx = ctxOf(full);
      ctx.releaseToNuvemshop = true;
      ctx.confirmedForNuvemshop = true;
      ctx.nsAutoUpload = { ...(ctx.nsAutoUpload || {}), confirmedAt: new Date().toISOString() };
      await prisma.product.update({ where: { id: full.id }, data: { aiContext: ctx } });

      let pushed = null;
      let error = null;
      try { pushed = await nsHandlers.pushProductToNuvemshop(full.id, connection); } catch (e) { error = e; }
      if (!error && pushed && !pushed.skipped) {
        result.uploaded++;
        result.uploadedIds.push(full.id);
        mappedIds.add(full.id);
        codes.forEach((c) => takenBarcodes.add(c));
        if (key) takenRefColor.add(key);
        continue;
      }
      const reason = String(error ? error.message : (pushed && pushed.reason) || 'falhou').slice(0, 200);
      result.failed++;
      if (result.failures.length < 30) result.failures.push({ id: full.id, name: full.name, reason });
      const after = await prisma.product.findUnique({ where: { id: full.id }, select: { aiContext: true } });
      const ctx2 = ctxOf(after || {});
      ctx2.nsAutoUpload = { ...(ctx2.nsAutoUpload || {}), lastFailAt: new Date().toISOString(), lastFailReason: reason };
      await prisma.product.update({ where: { id: full.id }, data: { aiContext: ctx2 } });
    }
    state.lastResult = result;
    console.log(`[nsAutoUpload] candidatos=${result.candidates} elegiveis=${result.eligible} subiram=${result.uploaded} falharam=${result.failed} repetidos=${result.skippedDuplicate} aguardando=${result.waitingRetry}`);
    return result;
  } catch (e) {
    state.lastError = e.message;
    console.error('[nsAutoUpload]', e.message);
    return result;
  } finally {
    busy = false;
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
  }
}

function getNuvemshopAutoUploadState() {
  const r = state.lastResult;
  return {
    enabled: state.enabled,
    running: state.running,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastError: state.lastError,
    lastResult: r ? {
      candidates: r.candidates, eligible: r.eligible, uploaded: r.uploaded, failed: r.failed,
      skippedDuplicate: r.skippedDuplicate, waitingRetry: r.waitingRetry,
    } : null,
  };
}

function startNuvemshopAutoUpload() {
  if (!state.enabled) {
    console.log('[nsAutoUpload] desligado (NS_AUTO_UPLOAD=0)');
    return;
  }
  // De hora em hora (min 23), horário de João Pessoa. Primeira rodada 3 min após o boot.
  setTimeout(() => runNuvemshopAutoUpload().catch(() => {}), 3 * 60 * 1000);
  cron.schedule('23 * * * *', () => runNuvemshopAutoUpload().catch(() => {}), { timezone: TZ });
  console.log('[nsAutoUpload] agendado: de hora em hora (min 23), trava completa + sem repetir');
}

module.exports = { runNuvemshopAutoUpload, startNuvemshopAutoUpload, getNuvemshopAutoUploadState };
