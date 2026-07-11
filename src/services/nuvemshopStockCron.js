// =====================================================================
// Nuvemshop stock/catalog reconciliation cron.
// TenisCash is the source of truth. The storefront receives only cards
// that pass the full quality gate and only real physical stock.
// =====================================================================
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const ns = require('./nuvemshop');
const nsHandlers = require('./nuvemshopHandlers');
const TZ = 'America/Fortaleza';

function physicalSig(product) {
  return (product.sizes || [])
    .map((size) => `${size.size}:${(size.storeStocks || []).reduce((sum, row) => sum + (row.stock || 0), 0)}`)
    .sort()
    .join('|');
}

function strHash(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

function cardSig(product) {
  let ctx = {};
  try {
    ctx = (typeof product.aiContext === 'string'
      ? JSON.parse(product.aiContext)
      : product.aiContext) || {};
  } catch (_) {}
  const classification = ctx.classification || {};
  return [
    physicalSig(product),
    `name=${product.name || ''}`,
    `brand=${product.brand || ''}`,
    `desc=${strHash((product.longDescription || '') + '\x1f' + (product.shortDescription || ''))}`,
    `img=${product.imageUrl || (product.imageUrls ? 'gallery' : '')}`,
    `price=${product.price || 0}`,
    `cost=${product.costPrice || 0}`,
    `promo=${product.promoPrice ?? ''}`,
    `cat=${product.category || ''}`,
    `sub=${product.subcategory || ''}`,
    `mod=${classification.modality || ''}`,
    `tier=${classification.tier || ''}`,
    `gen=${classification.gender || ''}`,
    `hide=${ctx.hideFromNuvemshop === true ? 1 : 0}`,
    `confirmed=${ctx.confirmedForNuvemshop === true ? 1 : 0}`,
  ].join('|');
}

let busy = false;

async function runNuvemshopStockSync() {
  if (busy) return;
  busy = true;
  try {
    const connection = await nsHandlers.getConnection();
    if (!connection) return;

    const mappings = await prisma.nuvemshopProductMapping.findMany({
      select: {
        id: true,
        localProductId: true,
        nuvemshopProductId: true,
        syncStatus: true,
      },
    });
    const mappedLocalIds = new Set(mappings.map((mapping) => mapping.localProductId));
    const mappedRemoteIds = new Set(mappings.map((mapping) => String(mapping.nuvemshopProductId)));
    const cleanupLimit = Math.max(1, Number(process.env.NS_CATALOG_CLEANUP_BATCH || 500));
    let cleanupActions = 0;

    // 1) Upload only cards that completed the explicit two-step confirmation.
    let uploaded = 0;
    const confirmed = await prisma.product.findMany({
      where: {
        active: true,
        aiContext: { path: ['confirmedForNuvemshop'], equals: true },
      },
      select: { id: true },
    });
    for (const product of confirmed) {
      if (mappedLocalIds.has(product.id)) continue;
      try {
        const result = await nsHandlers.pushProductToNuvemshop(product.id, connection);
        if (!result?.skipped) uploaded++;
      } catch (error) {
        console.error('[nsStockCron] upload', product.id, error.message);
      }
    }

    // 2) Reconcile mapped cards. Invalid cards are unpublished, not deleted.
    let synced = 0;
    let unpublishedInvalid = 0;
    for (const mapping of mappings) {
      try {
        const product = await prisma.product.findUnique({
          where: { id: mapping.localProductId },
          select: {
            id: true,
            active: true,
            name: true,
            brand: true,
            longDescription: true,
            shortDescription: true,
            imageUrl: true,
            imageUrls: true,
            price: true,
            costPrice: true,
            promoPrice: true,
            category: true,
            subcategory: true,
            aiContext: true,
            sizes: { include: { storeStocks: { select: { stock: true } } } },
          },
        });

        if (!product || product.active === false) {
          if (mapping.syncStatus !== 'hidden-invalid' && cleanupActions < cleanupLimit) {
            await nsHandlers.unpublishMappedProduct(
              mapping.localProductId,
              connection,
              product ? 'produto inativo' : 'produto local inexistente',
              mapping,
            );
            cleanupActions++;
            unpublishedInvalid++;
          }
          continue;
        }

        const eligibility = nsHandlers.assessProductForNuvemshop(product);
        if (!eligibility.eligible) {
          if (mapping.syncStatus !== 'hidden-invalid' && cleanupActions < cleanupLimit) {
            await nsHandlers.unpublishMappedProduct(
              mapping.localProductId,
              connection,
              eligibility.reasons.join('; '),
              mapping,
            );
            cleanupActions++;
            unpublishedInvalid++;
          }
          continue;
        }

        const signature = cardSig(product);
        let ctx = {};
        try {
          ctx = (typeof product.aiContext === 'string'
            ? JSON.parse(product.aiContext)
            : product.aiContext) || {};
        } catch (_) {}

        // A card that was hidden-invalid and is now valid must be republished.
        if (mapping.syncStatus !== 'hidden-invalid' && ctx.nsCardSig === signature) continue;

        const result = await nsHandlers.pushProductToNuvemshop(mapping.localProductId, connection);
        if (!result?.skipped) synced++;

        const fresh = await prisma.product.findUnique({
          where: { id: mapping.localProductId },
          select: { aiContext: true },
        });
        let freshCtx = {};
        try {
          freshCtx = (typeof fresh?.aiContext === 'string'
            ? JSON.parse(fresh.aiContext)
            : fresh?.aiContext) || {};
        } catch (_) {}
        freshCtx.nsCardSig = signature;
        await prisma.product.update({
          where: { id: mapping.localProductId },
          data: { aiContext: freshCtx },
        });
      } catch (error) {
        console.error('[nsStockCron] sync', mapping.localProductId, error.message);
      }
    }

    // 3) A remote product without a local mapping is outside stock/price
    // governance. Hide it reversibly. The next run continues the batch.
    let unpublishedOrphans = 0;
    if (cleanupActions < cleanupLimit) {
      try {
        const remoteProducts = await ns.fetchAllPages(connection, '/products', {
          perPage: 100,
          max: 10000,
        });
        const orphans = remoteProducts.filter((remote) =>
          remote && remote.published !== false && !mappedRemoteIds.has(String(remote.id)),
        );
        for (const remote of orphans) {
          if (cleanupActions >= cleanupLimit) break;
          try {
            await ns.nuvemshopApi(connection, 'PUT', `/products/${remote.id}`, {
              published: false,
            });
            cleanupActions++;
            unpublishedOrphans++;
          } catch (error) {
            console.error('[nsStockCron] orphan', remote.id, error.message);
          }
        }
      } catch (error) {
        console.error('[nsStockCron] auditoria de orfaos:', error.message);
      }
    }

    if (uploaded || synced || unpublishedInvalid || unpublishedOrphans) {
      console.log(
        `[nsStockCron] auto-upload=${uploaded} · espelho=${synced}`
        + ` · invalidos-ocultos=${unpublishedInvalid}`
        + ` · orfaos-ocultos=${unpublishedOrphans}`,
      );
    }
  } catch (error) {
    console.error('[nsStockCron] erro geral:', error.message);
  } finally {
    busy = false;
  }
}

function startNuvemshopStockCron() {
  if (process.env.DISABLE_NS_STOCK_CRON === '1') {
    console.log('[nsStockCron] DESLIGADO (DISABLE_NS_STOCK_CRON=1)');
    return;
  }
  cron.schedule(
    '*/5 * * * *',
    () => runNuvemshopStockSync().catch((error) => console.error('[nsStockCron]', error.message)),
    { timezone: TZ },
  );
  setTimeout(() => {
    runNuvemshopStockSync().catch((error) => console.error('[nsStockCron] startup', error.message));
  }, 5000);
  console.log('[nsStockCron] agendado: */5 min - estoque + gate + limpeza reversivel');
}

module.exports = {
  cardSig,
  runNuvemshopStockSync,
  startNuvemshopStockCron,
};
