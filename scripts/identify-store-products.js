// =====================================================================
// Identifica produtos por foto de etiqueta (WhatsApp) e marca no
// StoreStock da loja correspondente.
//
// FLUXO:
//   1. Pega N fotos da pasta da loja
//   2. Manda pro Claude Haiku 4.5 com vision: extrai marca, modelo,
//      EAN, tamanho disponível, cor
//   3. Match no banco: por EAN exato, fallback por nome+marca
//   4. Cria/atualiza StoreStock(storeId, productSizeId, stock++)
//   5. Relatório CSV
//
// Uso:
//   node scripts/identify-store-products.js --sample=20         # testa 20
//   node scripts/identify-store-products.js --store=parahyba    # toda parahyba
//   node scripts/identify-store-products.js --store=piramide    # toda piramide
// =====================================================================

const fs = require('fs');
const path = require('path');
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^#=][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  }
} catch {}

const Anthropic = require('@anthropic-ai/sdk');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const MODEL = 'claude-haiku-4-5';
const ROOT = 'C:/Users/sport/Downloads/_estoque_lojas';

const STORES = {
  parahyba: { code: 'LOJA01', name: 'Sports & Tennis Praia do Bessa', folder: 'parahyba' },
  piramide: { code: 'LOJA02', name: 'Sports & Tennis Praia de Tambaú', folder: 'piramide' },
};

const argv = process.argv.slice(2);
const sampleArg = argv.find(a => a.startsWith('--sample='));
const storeArg = argv.find(a => a.startsWith('--store='));
const dryRun = argv.includes('--dry-run');
const sampleSize = sampleArg ? parseInt(sampleArg.split('=')[1], 10) : null;
const targetStore = storeArg ? storeArg.split('=')[1] : null;

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

const SYSTEM = `Você é um leitor de etiquetas de calçados em fotos do WhatsApp.

A foto mostra um tênis/chuteira em cima da CAIXA, com a ETIQUETA da caixa visível (geralmente circulada de azul).

Extraia da ETIQUETA da caixa estes dados (NÃO do tênis, da etiqueta):
- brand: marca em UPPERCASE (ex: TOPPER, NIKE, MIZUNO, OLYMPIKUS, FILA, ADIDAS, PUMA, ASICS)
- model: modelo + variante (ex: "DOMINATOR FUSE II KEEPER FSAL")
- color: cor escrita na etiqueta (ex: "ROSA/PRETO/DOURADO")
- ean: código de barras de 13 dígitos (sem espaços, NÚMEROS apenas)
- size: tamanho mostrado destacado na etiqueta (ex: "40", "M 38", "P", "G")
- supplierCode: código interno/SKU do fornecedor (ex: "TP08090001")

REGRAS:
- Se NÃO consegue ler algo, devolve null
- EAN tem que ter EXATAMENTE 13 dígitos numéricos, ou null
- Size: só o número/letra principal, sem prefixo (ex: "40" não "M 40")

OUTPUT: SOMENTE JSON válido, sem markdown:
{"brand":"...","model":"...","color":"...","ean":"...","size":"...","supplierCode":"...","confidence":0-1}

Onde confidence é seu grau de certeza geral (0=adivinhei, 1=etiqueta cristalina).`;

async function readImageBase64(filepath) {
  const buf = fs.readFileSync(filepath);
  return buf.toString('base64');
}

async function analyzeImage(client, filepath) {
  const b64 = await readImageBase64(filepath);
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: 'Extraia da etiqueta:' },
      ],
    }],
  });
  const text = resp.content[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Sem JSON');
  return { ...JSON.parse(m[0]), usage: resp.usage };
}

async function matchProduct(extracted) {
  // 1. EAN exato
  if (extracted.ean && /^\d{13}$/.test(extracted.ean)) {
    const sz = await prisma.productSize.findFirst({
      where: { barcode: extracted.ean },
      include: { product: { select: { id: true, sku: true, name: true, brand: true, active: true } } },
    });
    if (sz) return { match: sz, by: 'ean' };
  }

  // 2. SupplierCode no SKU
  if (extracted.supplierCode) {
    const p = await prisma.product.findFirst({
      where: { sku: { contains: extracted.supplierCode, mode: 'insensitive' }, active: true },
      include: { sizes: true },
    });
    if (p) {
      const targetSize = extracted.size ? p.sizes.find(s => String(s.size) === String(extracted.size)) : null;
      return { match: { ...targetSize, product: p }, by: 'supplierCode' };
    }
  }

  // 3. Marca + modelo
  if (extracted.brand && extracted.model) {
    const tokens = String(extracted.model).split(/\s+/).filter(t => t.length > 2).slice(0, 4);
    if (tokens.length) {
      // Constrói cláusula AND com cada token
      const ands = tokens.map(t => ({ name: { contains: t, mode: 'insensitive' } }));
      const candidate = await prisma.product.findFirst({
        where: {
          active: true,
          AND: ands,
        },
        include: { sizes: true },
      });
      if (candidate) {
        const targetSize = extracted.size ? candidate.sizes.find(s => String(s.size) === String(extracted.size)) : null;
        return { match: { ...targetSize, product: candidate }, by: 'name' };
      }
    }
  }

  return { match: null, by: null };
}

async function applyToStoreStock(storeId, productSizeId) {
  if (!productSizeId) return false;
  const existing = await prisma.storeStock.findFirst({ where: { storeId, productSizeId } });
  if (existing) {
    await prisma.storeStock.update({ where: { id: existing.id }, data: { stock: { increment: 1 } } });
  } else {
    await prisma.storeStock.create({ data: { storeId, productSizeId, stock: 1 } });
  }
  return true;
}

async function processStore(client, storeKey, files) {
  const cfg = STORES[storeKey];
  const store = await prisma.store.findFirst({ where: { code: cfg.code } });
  if (!store) throw new Error(`Loja ${cfg.code} não encontrada no banco`);
  log(`\n=== ${cfg.name} (${store.id}) ===`);
  log(`Fotos a processar: ${files.length}`);

  const report = [];
  let totalCost = 0, matchedEan = 0, matchedSku = 0, matchedName = 0, noMatch = 0, errored = 0, applied = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filepath = path.join(ROOT, cfg.folder, file);
    try {
      const r = await analyzeImage(client, filepath);
      // Custo: Haiku 4.5 ~$0.0008 por imagem
      const c = (r.usage?.input_tokens || 0) * 0.8e-6 + (r.usage?.output_tokens || 0) * 4e-6 + (r.usage?.cache_read_input_tokens || 0) * 0.08e-6;
      totalCost += c;

      const { match, by } = await matchProduct(r);
      if (!match) {
        noMatch++;
        report.push({ file, brand: r.brand, model: r.model, ean: r.ean, size: r.size, status: 'NO_MATCH', sku: '', conf: r.confidence });
        console.log(`  ✗ ${i+1}/${files.length} ${file.slice(0,40)} | ${r.brand}/${(r.model||'').slice(0,30)} | NO MATCH`);
        continue;
      }
      if (by === 'ean') matchedEan++;
      else if (by === 'supplierCode') matchedSku++;
      else matchedName++;

      const ps = match.id ? match : null; // se veio sem size (apenas product), não tem productSizeId
      if (!dryRun && ps?.id) {
        const ok = await applyToStoreStock(store.id, ps.id);
        if (ok) applied++;
      }

      report.push({
        file, brand: r.brand, model: r.model, ean: r.ean, size: r.size,
        status: 'MATCH_' + by.toUpperCase(),
        sku: match.product?.sku || '',
        productName: (match.product?.name || '').slice(0, 60),
        conf: r.confidence,
      });
      console.log(`  ✓ ${i+1}/${files.length} ${file.slice(0,40)} | ${(r.brand||'?').padEnd(10)} ${(r.model||'').slice(0,30).padEnd(30)} | tam ${r.size} → ${match.product?.sku} [${by}]`);

    } catch (err) {
      errored++;
      report.push({ file, status: 'ERROR', error: err.message?.slice(0,100) });
      console.log(`  ⚠ ${i+1}/${files.length} ${file} ERROR: ${err.message?.slice(0,80)}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  log(`\n--- ${cfg.name} ---`);
  log(`Match EAN:           ${matchedEan}`);
  log(`Match supplierCode:  ${matchedSku}`);
  log(`Match nome:          ${matchedName}`);
  log(`Sem match:           ${noMatch}`);
  log(`Erros API:           ${errored}`);
  log(`StoreStock aplicado: ${applied}`);
  log(`Custo:               $${totalCost.toFixed(4)} (~R$ ${(totalCost * 6).toFixed(2)})`);

  return { storeKey, report, totalCost, matchedEan, matchedSku, matchedName, noMatch, errored, applied };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { log('SEM ANTHROPIC_API_KEY'); process.exit(1); }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const allResults = [];
  const storesToRun = targetStore ? [targetStore] : ['parahyba', 'piramide'];

  for (const sk of storesToRun) {
    const cfg = STORES[sk];
    const folder = path.join(ROOT, cfg.folder);
    let files = fs.readdirSync(folder).filter(f => /\.(jpg|jpeg)$/i.test(f));
    files.sort(); // deterministico
    if (sampleSize) files = files.slice(0, Math.ceil(sampleSize / storesToRun.length));
    const result = await processStore(client, sk, files);
    allResults.push(result);
  }

  // Relatório CSV consolidado
  const allReport = allResults.flatMap(r => r.report.map(x => ({ ...x, store: r.storeKey })));
  const reportPath = path.join(__dirname, '.identify-store-products-' + Date.now() + '.csv');
  fs.writeFileSync(reportPath, 'store,file,status,sku,brand,model,size,ean,conf,productName,error\n' + allReport.map(r => [
    r.store, r.file, r.status, r.sku || '', (r.brand||'').replace(/,/g,';'), (r.model||'').replace(/,/g,';'),
    r.size || '', r.ean || '', r.conf || '', (r.productName||'').replace(/,/g,';'), (r.error||'').replace(/,/g,';'),
  ].join(',')).join('\n'));

  log(`\n=== RELATÓRIO ===`);
  const totalCost = allResults.reduce((s, r) => s + r.totalCost, 0);
  log(`Custo total: $${totalCost.toFixed(4)} (~R$ ${(totalCost * 6).toFixed(2)})`);
  log(`CSV: ${reportPath}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
