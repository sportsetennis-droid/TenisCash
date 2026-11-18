// =====================================================================
// ESPELHO DO CARD → NUVEMSHOP (automático)
// Ordem do dono (2026-11-18): "toda alteração no card — foto, tamanho,
// venda, tudo, tudo mesmo — tem que ser automático a atualização na
// Nuvemshop."
//
// Como funciona: a cada NS_CARD_MIRROR_MIN minutos (padrão 3) compara cada
// produto QUE JÁ ESTEVE NA LOJA (mapeado; inclusive o que saiu do ar) com a
// assinatura do último envio. Mudou qualquer coisa do card (nome, marca, cor,
// descrição, TODAS as fotos e a ordem delas, preço, promo, custo, as 4
// classificações e a 2ª classificação, mapeamento de categorias, oculto/
// confirmado, referência, tamanhos e códigos de barras) → reenvia pelo push
// oficial (pushProductToNuvemshop), que aplica o MESMO portão de qualidade:
// card que deixou de passar sai do ar; card que voltou a passar volta.
// Estoque e venda: reajuste de estoque físico a cada 5 min
// (nuvemshopStockCron); produto novo: subida automática de hora em hora
// (nuvemshopAutoUpload). Juntos, toda mudança chega na loja online sozinha.
//
// Funciona por COMPARAÇÃO (não por gancho de gravação), então pega mudança
// feita por qualquer tela, script ou serviço. As fotos entram por um resumo
// (md5) calculado no banco — o base64 nunca é carregado a cada rodada.
// Falha no envio espera um tempo crescente (5 min → 24 h) antes de tentar de
// novo, para um card quebrado não travar o lote. Lote por rodada:
// NS_CARD_MIRROR_BATCH (40). Desligar: NS_CARD_MIRROR=0 (só com ordem do dono).
// (auditoria 2026-11-18: conexão real, base64, fila travada, hidden-invalid)
// =====================================================================
const cron = require('node-cron');
const crypto = require('crypto');
const { mergeAiContext } = require('./aiContextMerge');

const TZ = 'America/Fortaleza';
const num = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def; };
let prismaRef = null;
const db = () => prismaRef || (prismaRef = require('../middleware').prisma);
let busy = false;
const state = {
  enabled: process.env.NS_CARD_MIRROR !== '0',
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
  lastResult: null,
};

function ctxOf(product) {
  try {
    const c = (typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext) || {};
    return typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch (_) {
    return {};
  }
}

// Resumo das fotos: igual para o mesmo conjunto e a mesma ordem.
function imagesHashJS(product) {
  let gallery = [];
  try {
    const v = typeof product.imageUrls === 'string' ? JSON.parse(product.imageUrls) : product.imageUrls;
    if (Array.isArray(v)) gallery = v;
  } catch (_) { gallery = []; }
  return crypto.createHash('md5').update([product.imageUrl || '', ...gallery.map((x) => String(x || ''))].join('\u001f')).digest('hex');
}

// Assinatura do que aparece na loja online. NÃO entra: estoque (tem reajuste
// próprio a cada 5 min) e campos internos de sincronização do aiContext
// (nsCardSig, nsImagesSig, nsPhysicalStockVerifiedSig, nsMirror*), senão o
// próprio envio mudaria a assinatura e viraria laço.
function mirrorSig(product) {
  const ctx = ctxOf(product);
  const cls = ctx.classification || {};
  const cls2 = ctx.classification2 || {};
  const sizes = (product.sizes || []).map((s) => `${s.size}:${s.barcode || ''}`).sort().join(',');
  const parts = [
    'v2',
    product.sku || '', product.name || '', product.brand || '', String(ctx.color || ''),
    product.longDescription || '', product.shortDescription || '',
    product.imagesHash || imagesHashJS(product),
    String(product.price ?? ''), String(product.promoPrice ?? ''), String(product.costPrice ?? ''),
    product.category || '', product.subcategory || '', cls.modality || '', cls.tier || '', cls.gender || '',
    cls2.category || '', cls2.subcategory || '', cls2.modality || '', cls2.tier || '', cls2.gender || '',
    JSON.stringify(ctx.nuvemshopMapping || null),
    ctx.hideFromNuvemshop === true ? 'oculto' : '', ctx.confirmedForNuvemshop === true ? 'confirmado' : '',
    String(product.active),
    sizes,
  ];
  return crypto.createHash('sha256').update(parts.join('\u001e')).digest('hex');
}

// Espera depois de falhar: 5, 10, 20… minutos, no máximo 24 h.
function esperaMs(falhas) {
  return Math.min(24 * 60, 5 * Math.pow(2, Math.max(0, falhas - 1))) * 60 * 1000;
}

async function runNuvemshopCardMirror({ prisma = db(), handlers = null, connection = null, limit, agora = Date.now() } = {}) {
  if (busy) return { skipped: true, reason: 'rodando' };
  busy = true;
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  state.lastError = null;
  const result = { checked: 0, changed: 0, pushed: 0, unpublished: 0, skipped: 0, errors: 0, waitingRetry: 0, pending: false, items: [] };
  try {
    const nsHandlers = handlers || require('./nuvemshopHandlers');
    const conn = connection || (nsHandlers.getConnection ? await nsHandlers.getConnection() : null);
    if (!conn) { result.semConexao = true; state.lastError = 'sem conexão ativa com a Nuvemshop — nada foi enviado'; return result; }
    const batch = num(limit || process.env.NS_CARD_MIRROR_BATCH, 40, 1, 500);
    const maps = await prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } });
    const ids = [...new Set(maps.map((m) => m.localProductId))];
    for (let i = 0; i < ids.length; i += 200) {
      const lote = ids.slice(i, i + 200);
      const prods = await prisma.$queryRawUnsafe(
        'SELECT p.id, p.sku, p.name, p.brand, p."longDescription", p."shortDescription", p.price, p."promoPrice", p."costPrice", ' +
        '  p.category, p.subcategory, p."aiContext", p.active, ' +
        "  md5(coalesce(p.\"imageUrl\", '') || chr(31) || coalesce(p.\"imageUrls\"::text, '')) AS \"imagesHash\" " +
        'FROM "Product" p WHERE p.id = ANY($1::text[])', lote);
      const sizes = await prisma.productSize.findMany({ where: { productId: { in: lote } }, select: { productId: true, size: true, barcode: true } });
      const S = new Map();
      for (const s of sizes) { if (!S.has(s.productId)) S.set(s.productId, []); S.get(s.productId).push(s); }
      for (const p of prods) {
        p.sizes = S.get(p.id) || [];
        result.checked++;
        const sig = mirrorSig(p);
        const ctx = ctxOf(p);
        if (ctx.nsMirrorSig === sig) continue;
        result.changed++;
        const falhas = Number(ctx.nsMirrorFails || 0);
        if (falhas > 0 && ctx.nsMirrorFailAt && agora - new Date(ctx.nsMirrorFailAt).getTime() < esperaMs(falhas)) { result.waitingRetry++; continue; }
        if (result.pushed + result.unpublished + result.skipped + result.errors >= batch) { result.pending = true; continue; }
        let r = null;
        try {
          r = await nsHandlers.pushProductToNuvemshop(p.id, conn);
        } catch (e) {
          result.errors++;
          if (result.items.length < 20) result.items.push({ productId: p.id, erro: String(e.message).slice(0, 200) });
          // não grava a assinatura: tenta de novo depois de esperar (não trava o lote)
          await mergeAiContext(prisma, p.id, { nsMirrorFails: falhas + 1, nsMirrorFailAt: new Date(agora).toISOString(), nsMirrorLastError: String(e.message).slice(0, 300) }).catch(() => {});
          continue;
        }
        if (r && r.action === 'unpublished-invalid') result.unpublished++;
        else if (r && r.skipped) result.skipped++;
        else result.pushed++;
        if (result.items.length < 20) result.items.push({ productId: p.id, acao: (r && r.action) || 'enviado', motivo: (r && r.reason) || null });
        // grava só a assinatura (atômico, não desfaz edição feita no meio do envio)
        await mergeAiContext(prisma, p.id, { nsMirrorSig: sig, nsMirrorAt: new Date(agora).toISOString() }, ['nsMirrorFails', 'nsMirrorFailAt', 'nsMirrorLastError']);
      }
    }
    return result;
  } catch (e) {
    state.lastError = e.message;
    result.erro = e.message;
    return result;
  } finally {
    state.lastResult = { checked: result.checked, changed: result.changed, pushed: result.pushed, unpublished: result.unpublished, skipped: result.skipped,
      errors: result.errors, waitingRetry: result.waitingRetry, pending: result.pending, semConexao: !!result.semConexao };
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
    busy = false;
  }
}

function getNuvemshopCardMirrorState() {
  return JSON.parse(JSON.stringify(state));
}

function startNuvemshopCardMirror() {
  if (!state.enabled) {
    console.log('[nsCardMirror] desligado (NS_CARD_MIRROR=0)');
    return;
  }
  const min = num(process.env.NS_CARD_MIRROR_MIN, 3, 1, 30);
  setTimeout(() => runNuvemshopCardMirror().catch(() => {}), 2 * 60 * 1000);
  cron.schedule(`*/${min} * * * *`, () => runNuvemshopCardMirror().catch(() => {}), { timezone: TZ });
  console.log(`[nsCardMirror] agendado: a cada ${min} min — toda mudança do card publicado vai pra Nuvemshop`);
}

module.exports = { mirrorSig, esperaMs, runNuvemshopCardMirror, startNuvemshopCardMirror, getNuvemshopCardMirrorState };
