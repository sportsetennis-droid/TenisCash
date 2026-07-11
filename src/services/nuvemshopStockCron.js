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
const { assessRemoteProductForNuvemshop } = require('./nuvemshopEligibility');
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
const cronState = {
  running: false,
  scheduleEnabled: null,
  stockScheduleEnabled: true,
  phase: 'idle',
  progress: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
  lastResult: null,
};

async function runNuvemshopStockSync({
  uploadConfirmed = true,
  cleanupOnly = false,
  reconcileStock = false,
} = {}) {
  if (busy) return;
  busy = true;
  cronState.running = true;
  cronState.phase = 'connecting';
  cronState.progress = null;
  cronState.lastStartedAt = new Date().toISOString();
  cronState.lastError = null;
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
    let remoteProducts = [];
    try {
      remoteProducts = await ns.fetchAllPages(connection, '/products', {
        perPage: 100,
        max: 10000,
      });
    } catch (error) {
      console.error('[nsStockCron] leitura do catalogo remoto:', error.message);
    }
    const remoteById = new Map(
      remoteProducts
        .filter((remote) => remote && remote.id != null)
        .map((remote) => [String(remote.id), remote]),
    );
    const cleanupLimit = Math.max(1, Number(process.env.NS_CATALOG_CLEANUP_BATCH || 500));
    const stockLimit = Math.max(1, Number(process.env.NS_STOCK_RECONCILE_BATCH || 500));
    let cleanupActions = 0;
    let stockProductsProcessed = 0;
    let stockProductsChanged = 0;
    let stockVariantsUpdated = 0;
    let stockVariantsCreated = 0;
    let stockVariantsDeleted = 0;
    let stockErrors = 0;
    let stockPending = false;
    cronState.progress = {
      mappedProducts: mappings.length,
      mappedProcessed: 0,
      cleanupActions: 0,
      cleanupLimit,
      stockProductsProcessed: 0,
      stockProductsChanged: 0,
      stockLimit,
      stockPending: false,
    };

    // 1) Upload only cards that completed the explicit two-step confirmation.
    let uploaded = 0;
    if (uploadConfirmed) {
      cronState.phase = 'uploading-confirmed';
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
    }

    // 2) Reconcile mapped cards. Invalid cards are unpublished, not deleted.
    cronState.phase = 'reconciling-mapped';
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
          const remote = remoteById.get(String(mapping.nuvemshopProductId));
          const stillPublished = remote && remote.published !== false;
          if ((mapping.syncStatus !== 'hidden-invalid' || stillPublished) && cleanupActions < cleanupLimit) {
            await nsHandlers.unpublishMappedProduct(
              mapping.localProductId,
              connection,
              product ? 'produto inativo' : 'produto local inexistente',
              mapping,
            );
            cleanupActions++;
            unpublishedInvalid++;
            if (remote) remote.published = false;
          }
          continue;
        }

        const eligibility = nsHandlers.assessProductForNuvemshop(product);
        if (!eligibility.eligible) {
          const remote = remoteById.get(String(mapping.nuvemshopProductId));
          const stillPublished = remote && remote.published !== false;
          if ((mapping.syncStatus !== 'hidden-invalid' || stillPublished) && cleanupActions < cleanupLimit) {
            await nsHandlers.unpublishMappedProduct(
              mapping.localProductId,
              connection,
              eligibility.reasons.join('; '),
              mapping,
            );
            cleanupActions++;
            unpublishedInvalid++;
            if (remote) remote.published = false;
          }
          continue;
        }

        // O local pode estar correto enquanto a copia remota ainda carrega
        // marca/preco/tamanho placeholder antigos. No modo de limpeza, a
        // vitrine real tambem precisa passar pelo gate antes de permanecer.
        if (cleanupOnly) {
          const remote = remoteById.get(String(mapping.nuvemshopProductId));
          const remoteEligibility = assessRemoteProductForNuvemshop(remote);
          if (remote && remote.published !== false && !remoteEligibility.eligible) {
            if (cleanupActions < cleanupLimit) {
              await nsHandlers.unpublishMappedProduct(
                mapping.localProductId,
                connection,
                `copia remota invalida: ${remoteEligibility.reasons.join('; ')}`,
                mapping,
              );
              remote.published = false;
              cleanupActions++;
              unpublishedInvalid++;
            }
            continue;
          }

          if (reconcileStock && remote && remote.published !== false) {
            let ctx = {};
            try {
              ctx = (typeof product.aiContext === 'string'
                ? JSON.parse(product.aiContext)
                : product.aiContext) || {};
            } catch (_) {}
            const stockSignature = `physical-v1|${physicalSig(product)}`;
            if (ctx.nsPhysicalStockVerifiedSig !== stockSignature) {
              if (stockProductsProcessed >= stockLimit) {
                stockPending = true;
              } else {
                cronState.phase = 'reconciling-stock';
                const variantResult = await nsHandlers.updateNuvemshopVariants(
                  connection,
                  mapping.nuvemshopProductId,
                  product,
                  eligibility.locatedSizes,
                  { stockOnly: true },
                );
                stockProductsProcessed++;
                stockVariantsUpdated += variantResult.updated || 0;
                stockVariantsCreated += variantResult.created || 0;
                stockVariantsDeleted += variantResult.deleted || 0;
                stockErrors += (variantResult.errors || []).length;
                if ((variantResult.updated || 0) + (variantResult.created || 0)
                  + (variantResult.deleted || 0) > 0) {
                  stockProductsChanged++;
                }
                if (!(variantResult.errors || []).length) {
                  ctx.nsPhysicalStockVerifiedSig = stockSignature;
                  await prisma.product.update({
                    where: { id: product.id },
                    data: { aiContext: ctx },
                  });
                }
                cronState.progress.stockProductsProcessed = stockProductsProcessed;
                cronState.progress.stockProductsChanged = stockProductsChanged;
              }
            }
          }
          continue;
        }

        // No modo de limpeza autorizado, produto valido nao sofre update de
        // estoque/preco/card. A operacao fica restrita a ocultar invalidos.
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
      } finally {
        cronState.progress.mappedProcessed++;
        cronState.progress.cleanupActions = cleanupActions;
      }
    }

    // 3) A remote product without a local mapping is outside stock/price
    // governance. Hide it reversibly. The next run continues the batch.
    let unpublishedOrphans = 0;
    if (cleanupActions < cleanupLimit) {
      cronState.phase = 'hiding-orphans';
      try {
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
            cronState.progress.cleanupActions = cleanupActions;
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
    cronState.lastResult = {
      targetUserId: String(connection.nuvemshopUserId),
      mappedProducts: mappings.length,
      autoUploaded: uploaded,
      synced,
      unpublishedInvalid,
      unpublishedOrphans,
      cleanupActions,
      cleanupLimit,
      stockProductsProcessed,
      stockProductsChanged,
      stockVariantsUpdated,
      stockVariantsCreated,
      stockVariantsDeleted,
      stockErrors,
      stockPending,
      stockLimit,
    };
    cronState.phase = 'complete';
  } catch (error) {
    console.error('[nsStockCron] erro geral:', error.message);
    cronState.lastError = error.message;
    cronState.phase = 'error';
  } finally {
    busy = false;
    cronState.running = false;
    cronState.lastFinishedAt = new Date().toISOString();
  }
}

function getNuvemshopCronState() {
  return JSON.parse(JSON.stringify(cronState));
}

function startNuvemshopStockCron() {
  const scheduleEnabled = process.env.DISABLE_NS_STOCK_CRON !== '1';
  cronState.scheduleEnabled = scheduleEnabled;

  // A chave desliga o espelho continuo, mas nao pode impedir a governanca
  // autorizada do catalogo. Executa ao menos uma reconciliacao no boot; se o
  // lote encher, continua em lotes ate nao haver mais uma pagina cheia.
  const runStartupCleanup = async () => {
    await runNuvemshopStockSync({
      uploadConfirmed: scheduleEnabled,
      cleanupOnly: !scheduleEnabled,
      reconcileStock: !scheduleEnabled,
    })
      .catch((error) => console.error('[nsStockCron] startup', error.message));
    const result = cronState.lastResult;
    if (!scheduleEnabled && result
      && (result.cleanupActions >= result.cleanupLimit || result.stockPending)) {
      setTimeout(runStartupCleanup, 60 * 1000);
    }
  };
  setTimeout(runStartupCleanup, 5000);

  if (!scheduleEnabled) {
    cron.schedule(
      '*/5 * * * *',
      () => runNuvemshopStockSync({
        uploadConfirmed: false,
        cleanupOnly: true,
        reconcileStock: true,
      }).catch((error) => console.error('[nsStockCron] estoque fisico', error.message)),
      { timezone: TZ },
    );
    console.log('[nsStockCron] catalogo completo pausado; estoque fisico ativo a cada 5 min');
    return;
  }
  cron.schedule(
    '*/5 * * * *',
    () => runNuvemshopStockSync().catch((error) => console.error('[nsStockCron]', error.message)),
    { timezone: TZ },
  );
  console.log('[nsStockCron] agendado: */5 min - estoque + gate + limpeza reversivel');
}

module.exports = {
  cardSig,
  getNuvemshopCronState,
  runNuvemshopStockSync,
  startNuvemshopStockCron,
};
