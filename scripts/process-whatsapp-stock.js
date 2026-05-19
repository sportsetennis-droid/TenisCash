// =====================================================================
// process-whatsapp-stock.js
// Lê fotos dos chats WhatsApp da loja, identifica produto via Claude Vision,
// match no banco e (opcionalmente) atualiza StoreStock.
//
// Uso:
//   node scripts/process-whatsapp-stock.js \
//        --dir /c/tmp/estoque-fotos/parahyba \
//        --entries /c/tmp/estoque-fotos/parahyba.entries.json \
//        --store LOJA02 \
//        --limit 10           (default 10 — começa pequeno; --limit 0 = tudo)
//        --apply              (sem essa flag, é dry-run — só lista o que faria)
//
// Custo estimado: ~R$ 0,015 por foto (Haiku 4.5 vision ~1.5K tokens IN + 200 OUT)
// 1369 fotos ≈ R$ 20-30.
// =====================================================================

// Carrega .env manualmente (sem dotenv)
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split('\n').forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const Anthropic = require('@anthropic-ai/sdk');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));

const DIR = args.dir;
const ENTRIES_FILE = args.entries;
const STORE_CODE = args.store;
const LIMIT = args.limit === undefined ? 10 : parseInt(args.limit, 10);
const APPLY = !!args.apply;
const RESUME = args.resume || null; // arquivo de progresso pra continuar

if (!DIR || !ENTRIES_FILE || !STORE_CODE) {
  console.error('Uso: --dir <pasta> --entries <json> --store LOJA0X [--limit N] [--apply]');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const prisma = new PrismaClient();

const SYSTEM = `Você é um analista de etiquetas de produtos esportivos da rede Sports & Tennis.

Receberá foto de UM produto numa caixa, com etiqueta visível mostrando código, marca, modelo, cor e EAN.

EXTRAIA estes campos da etiqueta, em JSON puro:
{
  "marca": "use o nome da marca EXATAMENTE como aparece. Marcas comuns: TOPPER, NIKE, ADIDAS, CONVERSE, PUMA, FILA, PENALTY, UMBRO, MIZUNO, KAPPA, SPALDING, VOLLO, EVOKE, Caju Brasil, ARMY, BROOKS, ASICS, SKECHERS, REEBOK, SALOMON, KENNER, DIADORA, SPEEDO, EVERLAST, DILLY, HURLEY, CHAMPION, UNDER ARMOUR, KOLOSH, OXN, PROGNE, AURA, HIDROLIGHT, KINDAI, FIBER, LUPO, REFLEXX, Alto Giro, Body for Sure, Hope Resort, Lets Gym, Lu Martins, BOTAFOGO, JOMA. Se a marca for outra ou ilegível, retorne o texto que ler.",
  "modelo": "string curta — ex: 'DOMINATOR FUSE II KEEPER FSAL', 'GHOST MAX 2', 'GLYCERIN MAX'",
  "cor": "string — ex: 'ROSA/PRETO/DOURADO'",
  "codigoFornecedor": "código alfanumérico da etiqueta — ex: 'TP05080003', 'CK13000001', 'F01R00098', '1104471D099'. Inclua espaços se houver.",
  "ean": "código de barras 12-14 dígitos se visível, senão null"
}

Se a etiqueta NÃO estiver legível ou a foto não for de produto, retorne {"erro":"foto inválida"}.
Resposta DEVE ser SOMENTE o JSON, sem markdown, sem comentários.`;

async function visionExtract(photoPath) {
  const buf = fs.readFileSync(photoPath);
  const b64 = buf.toString('base64');
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: 'Analisa a etiqueta. Retorna SÓ o JSON.' },
      ],
    }],
  });
  const txt = resp.content[0]?.text || '{}';
  // Tenta achar o primeiro { ... }
  const m = txt.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : { erro: 'sem JSON', raw: txt }; }
  catch { return { erro: 'JSON inválido', raw: txt }; }
}

async function findProduct(ext) {
  if (!ext || ext.erro) return null;
  const ref = (ext.codigoFornecedor || '').trim().toUpperCase();
  const ean = (ext.ean || '').replace(/\D/g, '');

  // 1) Match por EAN no sku (formato 'XXXX-EAN13')
  if (ean && ean.length >= 12) {
    const byEan = await prisma.product.findFirst({
      where: { active: true, sku: { contains: ean, mode: 'insensitive' } },
      select: { id: true, sku: true, name: true, brand: true, aiContext: true },
    });
    if (byEan) return { ...byEan, matchedBy: 'ean' };
  }

  // 2) Match por supplierRef no aiContext (JSON path equals)
  if (ref) {
    const byRef = await prisma.product.findFirst({
      where: { active: true, aiContext: { path: ['supplierRef'], equals: ref } },
      select: { id: true, sku: true, name: true, brand: true, aiContext: true },
    });
    if (byRef) return { ...byRef, matchedBy: 'supplierRef' };
  }

  // 3) Match por sku exato (alguns SKUs terminam com o code)
  if (ref) {
    const bySku = await prisma.product.findFirst({
      where: { active: true, sku: { endsWith: ref, mode: 'insensitive' } },
      select: { id: true, sku: true, name: true, brand: true, aiContext: true },
    });
    if (bySku) return { ...bySku, matchedBy: 'sku' };
  }

  // 4) Match por NOME contém o code (Topper/Rainha — código vem dentro do xProd da NF)
  if (ref) {
    const byName = await prisma.product.findFirst({
      where: { active: true, name: { contains: ref, mode: 'insensitive' } },
      select: { id: true, sku: true, name: true, brand: true, aiContext: true },
    });
    if (byName) return { ...byName, matchedBy: 'name' };
  }

  // 4b) Match por PREFIXO do code (antes do primeiro '-' ou espaço).
  // Cobre casos tipo 'F01R00116-7Z41' onde sufixo é cor/grade — produto no banco
  // tem só 'F01R00116' no nome. Tamanho mínimo 5 chars pra evitar match espúrio.
  if (ref) {
    const refPrefix = ref.split(/[-\s]/)[0];
    if (refPrefix && refPrefix.length >= 5 && refPrefix !== ref) {
      const byNamePrefix = await prisma.product.findFirst({
        where: { active: true, name: { contains: refPrefix, mode: 'insensitive' } },
        select: { id: true, sku: true, name: true, brand: true, aiContext: true },
      });
      if (byNamePrefix) return { ...byNamePrefix, matchedBy: 'name_prefix' };
      const bySupplierPrefix = await prisma.product.findFirst({
        where: { active: true, aiContext: { path: ['supplierRef'], equals: refPrefix } },
        select: { id: true, sku: true, name: true, brand: true, aiContext: true },
      });
      if (bySupplierPrefix) return { ...bySupplierPrefix, matchedBy: 'supplierRef_prefix' };
    }
  }

  // 4c) Match por supplierRef.startsWith(ref) — cobre Brooks (ref na etiqueta é
  // '1104471D099' mas no banco supplierRef é '1104471D099070', com tamanho appended).
  // Também cobre alguns casos onde a etiqueta tem código curto e o banco completou.
  if (ref) {
    const refClean = ref.replace(/\s+/g, '');
    if (refClean.length >= 6) {
      // Prisma não suporta startsWith em JSON path direto — fazemos raw query.
      const rows = await prisma.$queryRaw`
        SELECT id, sku, name, brand, "aiContext"
        FROM "Product"
        WHERE active = true
          AND "aiContext"->>'supplierRef' LIKE ${refClean + '%'}
        LIMIT 1`;
      if (rows && rows[0]) {
        const r = rows[0];
        return { id: r.id, sku: r.sku, name: r.name, brand: r.brand, aiContext: r.aiContext, matchedBy: 'supplierRef_startsWith' };
      }
    }
  }

  // 5) Match por nome aproximado (marca + modelo) — última tentativa
  if (ext.marca && ext.modelo) {
    const modelTokens = ext.modelo.split(/\s+/).filter(t => t.length >= 3).slice(0, 3);
    if (modelTokens.length) {
      const candidates = await prisma.product.findMany({
        where: {
          active: true,
          brand: { contains: ext.marca, mode: 'insensitive' },
          AND: modelTokens.map(t => ({ name: { contains: t, mode: 'insensitive' } })),
        },
        select: { id: true, sku: true, name: true, brand: true, aiContext: true },
        take: 1,
      });
      if (candidates[0]) return { ...candidates[0], matchedBy: 'name_fuzzy' };
    }
  }

  return null;
}

async function applyStock(productId, sizes, storeId) {
  // Pra cada tamanho, cria/atualiza ProductSize + StoreStock
  let created = 0, updated = 0;
  for (const s of sizes) {
    let ps = await prisma.productSize.findFirst({
      where: { productId, size: String(s.size) },
    });
    if (!ps) {
      ps = await prisma.productSize.create({
        data: { productId, size: String(s.size), stock: 0 },
      });
    }
    const existing = await prisma.storeStock.findFirst({
      where: { productSizeId: ps.id, storeId },
    });
    if (existing) {
      await prisma.storeStock.update({
        where: { id: existing.id },
        data: { stock: existing.stock + (s.qty || 1) },
      });
      updated++;
    } else {
      await prisma.storeStock.create({
        data: { productSizeId: ps.id, storeId, stock: s.qty || 1 },
      });
      created++;
    }
    // Recalcula stock agregado em ProductSize.stock
    const all = await prisma.storeStock.findMany({ where: { productSizeId: ps.id } });
    await prisma.productSize.update({
      where: { id: ps.id },
      data: { stock: all.reduce((a, b) => a + (b.stock || 0), 0) },
    });
  }
  return { created, updated };
}

(async () => {
  const store = await prisma.store.findUnique({ where: { code: STORE_CODE } });
  if (!store) { console.error('Store ' + STORE_CODE + ' não existe'); process.exit(1); }

  let entries = JSON.parse(fs.readFileSync(ENTRIES_FILE, 'utf8'));
  if (LIMIT > 0) entries = entries.slice(0, LIMIT);

  const progressFile = ENTRIES_FILE.replace(/\.json$/, '.progress.json');
  let progress = {};
  if (RESUME && fs.existsSync(progressFile)) {
    progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
    console.log('• Retomando de', Object.keys(progress).length, 'fotos já processadas');
  }

  console.log('\n=== Processamento WhatsApp Stock ===');
  console.log('Diretório:', DIR);
  console.log('Loja:', STORE_CODE, '(' + store.name + ')');
  console.log('Modo:', APPLY ? 'APPLY (vai gravar no banco)' : 'DRY-RUN');
  console.log('Total a processar:', entries.length, '\n');

  let processed = 0, matched = 0, notMatched = 0, errors = 0;
  let totalSizesApplied = 0;

  for (const e of entries) {
    processed++;
    if (progress[e.photo]) continue;
    const photoPath = path.join(DIR, e.photo);
    if (!fs.existsSync(photoPath)) { console.log(`[${processed}/${entries.length}] ⚠ não existe: ${e.photo}`); continue; }

    process.stdout.write(`[${processed}/${entries.length}] ${e.photo.slice(0, 20)}... `);

    let ext = null;
    try {
      ext = await visionExtract(photoPath);
    } catch (err) {
      console.log('VISION ERR:', err.message);
      errors++;
      continue;
    }
    if (ext.erro) { console.log('SKIP (' + ext.erro + ')'); progress[e.photo] = { skipped: ext.erro }; continue; }

    const product = await findProduct(ext);
    if (!product) {
      notMatched++;
      console.log(`NOT FOUND — ${ext.marca || '?'} ${ext.codigoFornecedor || '?'}`);
      progress[e.photo] = { ext, sizes: e.sizes, matched: false };
      continue;
    }

    matched++;
    console.log(`✓ ${product.brand} ${product.sku} (${product.matchedBy}) — ${e.sizes.length} sizes`);
    progress[e.photo] = { ext, sizes: e.sizes, productId: product.id, matchedBy: product.matchedBy };

    if (APPLY && e.sizes.length) {
      const r = await applyStock(product.id, e.sizes, store.id);
      totalSizesApplied += e.sizes.reduce((a, s) => a + (s.qty || 1), 0);
      progress[e.photo].applied = r;
    }

    // Save progress every 25 fotos
    if (processed % 25 === 0) {
      fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
    }
  }

  fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));

  console.log('\n=== Resumo ===');
  console.log('  Processadas:    ', processed);
  console.log('  Match:          ', matched);
  console.log('  Não encontradas:', notMatched);
  console.log('  Erros:          ', errors);
  if (APPLY) console.log('  Estoque aplicado:', totalSizesApplied, 'unidades em', STORE_CODE);
  console.log('  Progresso salvo:', progressFile);

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nERRO FATAL:', err);
  await prisma.$disconnect();
  process.exit(1);
});
