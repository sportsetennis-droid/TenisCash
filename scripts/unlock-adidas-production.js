/*
 * Remove somente as travas de disponibilidade dos tênis Adidas.
 * Mantém saldo, tamanho técnico e trilha de revisão. Dry-run por padrão;
 * use --apply para gravar. Não chama a API da Nuvemshop.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

function normalize(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const NON_FOOTWEAR = /\b(SOCK|MEIA|MEIAO|BONE|BOLSA|MALA|MOCHILA|CAM|CAMISA|CAMISETA|REGATA|BERMUDA|SHORT|CALCA|JAQUETA|AGASALHO|TOP|LEGGING|SAIA|CUECA|MAIO|LUVA|BOLA|CHINELO|SANDALIA|CARTEIRA|VISEIRA|TOUCA|GARRAFA|SQUEEZE)\b/;
const SHOE_HINT = /\b(TENIS|SHOES|RUNFALCON|DURAMO|ADIZERO|CLOUDFOAM|QUESTAR|BARREDA|ALPHAEDGE|COURT|SUPERNOVA|UBERSONIC|BRAVADA|DEPORTIVO|ULTRABOUNCE|GALAXY|RESPONSE|RACER|BREAKNET|GRAND COURT|VL COURT|TERREX|RIVALRY|HOOPS|ADVANTAGE|OWNTHEGAME|AMPLIMOVE|PUREBOOST|DROPSSET)\b/;

function isFootwear(product) {
  if (!normalize(product.brand).includes('ADIDAS')) return false;
  const category = normalize(product.category);
  const name = normalize(product.name);
  if (NON_FOOTWEAR.test(name)) return false;
  if (['TENIS', 'CALCADOS'].includes(category)) return true;
  if (!['A CLASSIFICAR', 'OUTROS'].includes(category)) return false;
  return SHOE_HINT.test(name) || /\b\d{2}\s*\d{2}\b/.test(name);
}

function contextOf(product) {
  try {
    return typeof product.aiContext === 'string'
      ? JSON.parse(product.aiContext)
      : (product.aiContext || {});
  } catch (_) {
    return {};
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
  const all = await prisma.product.findMany({
    where: { active: true, brand: { contains: 'ADIDAS', mode: 'insensitive' } },
    include: { sizes: { include: { storeStocks: { select: { stock: true } } } } },
  });
  const products = all.filter(isFootwear);
  const at = new Date().toISOString();
  const plan = products.map((product) => {
    const ctx = contextOf(product);
    const pendingVariants = product.sizes.filter((size) => !size.sizeConfirmedAt && size.storeStocks.some((stock) => stock.stock > 0));
    const pendingUnits = pendingVariants.reduce(
      (sum, size) => sum + size.storeStocks.reduce((n, stock) => n + Math.max(0, stock.stock), 0),
      0,
    );
    return {
      productId: product.id,
      name: product.name,
      before: {
        confirmedForNuvemshop: ctx.confirmedForNuvemshop,
        hideFromNuvemshop: ctx.hideFromNuvemshop,
        adidasStockReview: ctx.adidasStockReview || null,
      },
      pendingVariants: pendingVariants.length,
      pendingUnits,
    };
  });

  const outDir = APPLY ? path.join(process.cwd(), 'backups') : path.join(process.cwd(), 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const planFile = path.join(outDir, `adidas-unlock-${APPLY ? 'apply' : 'dry-run'}-${stamp}.json`);
  fs.writeFileSync(planFile, JSON.stringify({ generatedAt: at, apply: APPLY, products: plan }, null, 2));

  if (!APPLY) {
    console.log(JSON.stringify({
      ok: true,
      applied: false,
      products: plan.length,
      pendingUnits: plan.reduce((n, row) => n + row.pendingUnits, 0),
      currentlyHidden: plan.filter((row) => row.before.hideFromNuvemshop === true).length,
      awaitingConfirmation: plan.filter((row) => row.before.confirmedForNuvemshop !== true).length,
      planFile,
    }));
    return;
  }

  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const row of plan) {
      const product = await tx.product.findUnique({ where: { id: row.productId } });
      if (!product || !product.active) continue;
      const ctx = contextOf(product);
      await tx.product.update({
        where: { id: product.id },
        data: {
          aiContext: {
            ...ctx,
            confirmedForNuvemshop: true,
            hideFromNuvemshop: false,
            adidasStockReview: {
              ...(ctx.adidasStockReview || {}),
              status: 'warning_only_unlocked_by_owner',
              enforcement: 'warning_only',
              pendingVariants: row.pendingVariants,
              pendingUnits: row.pendingUnits,
              unlockedAt: at,
              source: 'owner-request-2026-07-14',
            },
          },
        },
      });
      updated++;
    }
  }, { timeout: 120_000, maxWait: 15_000 });

  console.log(JSON.stringify({ ok: true, applied: true, updated, pendingUnits: plan.reduce((n, row) => n + row.pendingUnits, 0), backupFile: planFile }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
