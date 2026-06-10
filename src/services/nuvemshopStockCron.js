// =====================================================================
// Cron de SINCRONIZAÇÃO de estoque com a Nuvemshop (estoque interligado).
// Regra do dono 2026-06-08: o sistema é a fonte da verdade; a loja espelha o
// ESTOQUE FÍSICO real (Σ StoreStock de todas as lojas) e só os tamanhos com estoque.
//   1) AUTO-UPLOAD: produtos marcados (aiContext.releaseToNuvemshop) que ainda não
//      estão na loja → sobe (respeita as regras de pushProductToNuvemshop).
//   2) ESPELHO: pra cada produto ATIVO já na loja, se QUALQUER campo do card mudou
//      (assinatura ampla: estoque, nome, descrição, preço, classificação, hide),
//      re-sincroniza — cobre venda, bipe, ajuste, NFe, edição, classificação, ocultar.
// Timezone explícito (Railway roda em UTC). Otimizado por assinatura: só bate na API
// quando o estoque físico realmente mudou.
// =====================================================================
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const nsHandlers = require('./nuvemshopHandlers');
const TZ = 'America/Fortaleza';

// Assinatura do estoque físico por tamanho (ordenada, estável).
function physicalSig(product) {
  return (product.sizes || [])
    .map((s) => `${s.size}:${(s.storeStocks || []).reduce((a, x) => a + (x.stock || 0), 0)}`)
    .sort()
    .join('|');
}

// Hash leve (djb2) pra detectar mudança de texto sem carregar/guardar o texto inteiro.
function strHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return h >>> 0; }

// Assinatura AMPLA do card: estoque + TODOS os campos que a loja mostra (nome, descrição,
// preço, classificação, hide). Muda quando QUALQUER alteração relevante ocorre → o cron
// re-sincroniza, não importa qual endpoint editou (rede de segurança). Imagem fica de fora
// (coberta no push via nsImagesSig + pelos endpoints de foto) pra não carregar base64 a cada
// ciclo. NÃO inclui os campos ns*Sig (gravados pelo próprio push) pra evitar loop infinito.
function cardSig(product) {
  let ctx = {};
  try { ctx = (typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext) || {}; } catch {}
  const cls = ctx.classification || {};
  return [
    physicalSig(product),
    'name=' + (product.name || ''),
    'desc=' + strHash((product.longDescription || '') + '\x1f' + (product.shortDescription || '')),
    'price=' + (product.price || 0),
    'promo=' + (product.promoPrice ?? ''),
    'cat=' + (product.category || ''),
    'sub=' + (product.subcategory || ''),
    'mod=' + (cls.modality || ''),
    'tier=' + (cls.tier || ''),
    'gen=' + (cls.gender || ''),
    'hide=' + (ctx.hideFromNuvemshop === true ? 1 : 0),
  ].join('|');
}

let busy = false;
async function runNuvemshopStockSync() {
  if (busy) return; // não empilha
  busy = true;
  try {
    const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!conn) return;

    const maps = await prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } });
    const mappedIds = new Set(maps.map((m) => m.localProductId));

    // 1) AUTO-UPLOAD dos CONFIRMADOS que ainda não estão na loja.
    // GATE de 2 passos (dono 2026-06-10): LIBERAR (releaseToNuvemshop) só marca candidato e NÃO
    // sobe; o dono RECONFERE e CONFIRMA (confirmedForNuvemshop) — só aí sobe. O cron sobe somente
    // os CONFIRMADOS; os apenas-liberados ficam parados na fila de conferência.
    let uploaded = 0;
    const confirmed = await prisma.product.findMany({
      where: { active: true, aiContext: { path: ['confirmedForNuvemshop'], equals: true } },
      select: { id: true },
    });
    for (const p of confirmed) {
      if (mappedIds.has(p.id)) continue;
      try { const r = await nsHandlers.pushProductToNuvemshop(p.id, conn); if (!r?.skipped) uploaded++; }
      catch (e) { console.error('[nsStockCron] upload', p.id, e.message); }
    }

    // 2) ESPELHO do físico pros já mapeados e ATIVOS (só re-sincroniza se a assinatura mudou)
    let synced = 0;
    for (const m of maps) {
      try {
        const product = await prisma.product.findUnique({
          where: { id: m.localProductId },
          select: {
            id: true, active: true, name: true, longDescription: true, shortDescription: true,
            price: true, promoPrice: true, category: true, subcategory: true, aiContext: true,
            sizes: { include: { storeStocks: { select: { stock: true } } } },
          },
        });
        if (!product || product.active === false) continue; // inativo: não mexe (remoção é ação explícita)
        const sig = cardSig(product);
        let ctx = {};
        try { ctx = (typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext) || {}; } catch {}
        if (ctx.nsCardSig === sig) continue; // nada relevante mudou no card → pula (sem bater na API)
        await nsHandlers.pushProductToNuvemshop(m.localProductId, conn);
        synced++;
        // grava a assinatura SEM clobberar o que o push escreveu (ex: nsImagesSig)
        const fresh = await prisma.product.findUnique({ where: { id: m.localProductId }, select: { aiContext: true } });
        let fctx = {};
        try { fctx = (typeof fresh.aiContext === 'string' ? JSON.parse(fresh.aiContext) : fresh.aiContext) || {}; } catch {}
        fctx.nsCardSig = sig;
        await prisma.product.update({ where: { id: m.localProductId }, data: { aiContext: fctx } });
      } catch (e) { console.error('[nsStockCron] sync', m.localProductId, e.message); }
    }

    if (uploaded || synced) console.log(`[nsStockCron] auto-upload=${uploaded} · espelho-estoque=${synced}`);
  } catch (e) {
    console.error('[nsStockCron] erro geral:', e.message);
  } finally {
    busy = false;
  }
}

function startNuvemshopStockCron() {
  if (process.env.DISABLE_NS_STOCK_CRON === '1') {
    console.log('[nsStockCron] DESLIGADO (DISABLE_NS_STOCK_CRON=1)');
    return;
  }
  // A cada 5 min: espelha físico → Nuvemshop + sobe marcados pendentes.
  cron.schedule('*/5 * * * *', () => { runNuvemshopStockSync().catch((e) => console.error('[nsStockCron]', e.message)); }, { timezone: TZ });
  console.log('[nsStockCron] agendado: */5 min (' + TZ + ') — espelho estoque físico → Nuvemshop + auto-upload marcados');
}

module.exports = { startNuvemshopStockCron, runNuvemshopStockSync };
