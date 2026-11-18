// =====================================================================
// ESPELHO DO CARD → NUVEMSHOP (automático)
// Ordem do dono (2026-11-18): "toda alteração no card — foto, tamanho,
// venda, tudo, tudo mesmo — tem que ser automático a atualização na
// Nuvemshop."
//
// Como funciona: a cada NS_CARD_MIRROR_MIN minutos (padrão 3) compara cada
// produto PUBLICADO com a assinatura do último envio. Mudou qualquer coisa
// do card (nome, marca, cor, descrição, TODAS as fotos e a ordem delas,
// preço, promo, custo, as 4 classificações, gênero, oculto/confirmado,
// tamanhos e códigos de barras) → reenvia pelo push oficial
// (pushProductToNuvemshop), que aplica o MESMO portão de qualidade:
// card que deixou de passar é despublicado, nunca fica errado no ar.
// Estoque e venda: o reajuste de estoque físico já roda a cada 5 min
// (nuvemshopStockCron); produto novo: subida automática de hora em hora
// (nuvemshopAutoUpload). Juntos, toda mudança chega na loja online sozinha.
//
// Funciona por COMPARAÇÃO (não por gancho de gravação), então pega mudança
// feita por qualquer tela, script ou serviço. Lote por rodada para não
// estourar a API: NS_CARD_MIRROR_BATCH (40). Desligar: NS_CARD_MIRROR=0.
// =====================================================================
const cron = require('node-cron');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const TZ = 'America/Fortaleza';
let prismaRef = null;
const db = () => prismaRef || (prismaRef = new PrismaClient());
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
    return (typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext) || {};
  } catch (_) {
    return {};
  }
}

function imagesOf(product) {
  let gallery = [];
  try {
    const v = typeof product.imageUrls === 'string' ? JSON.parse(product.imageUrls) : product.imageUrls;
    if (Array.isArray(v)) gallery = v;
  } catch (_) { gallery = []; }
  return [product.imageUrl || '', ...gallery.map((x) => String(x || ''))];
}

// Assinatura do que aparece na loja online. NÃO entra: estoque (tem reajuste
// próprio a cada 5 min) e campos internos de sincronização do aiContext
// (nsCardSig, nsPhysicalStockVerifiedSig, nsMirrorSig…), senão o próprio envio
// mudaria a assinatura e viraria laço.
function mirrorSig(product) {
  const ctx = ctxOf(product);
  const cls = ctx.classification || {};
  const cls2 = ctx.classification2 || {};
  const sizes = (product.sizes || [])
    .map((s) => `${s.size}:${s.barcode || ''}`)
    .sort()
    .join(',');
  const parts = [
    'v1',
    product.name || '', product.brand || '', String(ctx.color || ''),
    product.longDescription || '', product.shortDescription || '',
    imagesOf(product).join('\u001f'),
    String(product.price ?? ''), String(product.promoPrice ?? ''), String(product.costPrice ?? ''),
    product.category || '', product.subcategory || '', cls.modality || '', cls.tier || '', cls.gender || '',
    cls2.category || '', cls2.subcategory || '', cls2.modality || '', cls2.tier || '',
    ctx.hideFromNuvemshop === true ? 'oculto' : '', ctx.confirmedForNuvemshop === true ? 'confirmado' : '',
    String(product.active),
    sizes,
  ];
  return crypto.createHash('sha256').update(parts.join('\u001e')).digest('hex');
}

async function runNuvemshopCardMirror({ prisma = db(), handlers = null, connection = null, limit } = {}) {
  if (busy) return { skipped: true, reason: 'rodando' };
  busy = true;
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  state.lastError = null;
  const result = { checked: 0, changed: 0, pushed: 0, unpublished: 0, skipped: 0, errors: 0, pending: false, items: [] };
  try {
    const nsHandlers = handlers || require('./nuvemshopHandlers');
    const conn = connection || await prisma.nuvemshopConnection.findFirst({ where: { active: true } }).catch(() => null);
    if (!conn) { result.semConexao = true; return result; }
    const batch = Math.max(1, Number(limit || process.env.NS_CARD_MIRROR_BATCH || 40));
    const maps = await prisma.nuvemshopProductMapping.findMany({
      where: { NOT: { syncStatus: 'hidden-invalid' } },
      select: { localProductId: true },
    });
    for (let i = 0; i < maps.length; i += 200) {
      const ids = maps.slice(i, i + 200).map((m) => m.localProductId);
      const prods = await prisma.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, name: true, brand: true, longDescription: true, shortDescription: true, imageUrl: true, imageUrls: true,
          price: true, promoPrice: true, costPrice: true, category: true, subcategory: true, aiContext: true, active: true,
          sizes: { select: { size: true, barcode: true } },
        },
      });
      for (const p of prods) {
        result.checked++;
        const sig = mirrorSig(p);
        const ctx = ctxOf(p);
        if (ctx.nsMirrorSig === sig) continue;
        result.changed++;
        if (result.pushed + result.unpublished + result.skipped + result.errors >= batch) { result.pending = true; continue; }
        let r = null;
        try {
          r = await nsHandlers.pushProductToNuvemshop(p.id, conn);
        } catch (e) {
          result.errors++;
          if (result.items.length < 20) result.items.push({ productId: p.id, erro: String(e.message).slice(0, 200) });
          continue; // não grava a assinatura: tenta de novo na próxima rodada
        }
        if (r && r.action === 'unpublished-invalid') result.unpublished++;
        else if (r && r.skipped) result.skipped++;
        else result.pushed++;
        if (result.items.length < 20) result.items.push({ productId: p.id, acao: (r && r.action) || 'enviado', motivo: (r && r.reason) || null });
        // grava só a assinatura, de forma atômica, sem sobrescrever o resto do aiContext
        await prisma.$executeRawUnsafe(
          'UPDATE "Product" SET "aiContext" = COALESCE("aiContext", \'{}\'::jsonb) || jsonb_build_object(\'nsMirrorSig\', $2::text, \'nsMirrorAt\', $3::text) WHERE id = $1',
          p.id, sig, new Date().toISOString());
      }
    }
    return result;
  } catch (e) {
    state.lastError = e.message;
    result.erro = e.message;
    return result;
  } finally {
    state.lastResult = { checked: result.checked, changed: result.changed, pushed: result.pushed, unpublished: result.unpublished, skipped: result.skipped, errors: result.errors, pending: result.pending };
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
  const min = Math.min(30, Math.max(1, Number(process.env.NS_CARD_MIRROR_MIN || 3)));
  setTimeout(() => runNuvemshopCardMirror().catch(() => {}), 2 * 60 * 1000);
  cron.schedule(`*/${min} * * * *`, () => runNuvemshopCardMirror().catch(() => {}), { timezone: TZ });
  console.log(`[nsCardMirror] agendado: a cada ${min} min — toda mudança do card publicado vai pra Nuvemshop`);
}

module.exports = { mirrorSig, runNuvemshopCardMirror, startNuvemshopCardMirror, getNuvemshopCardMirrorState };
