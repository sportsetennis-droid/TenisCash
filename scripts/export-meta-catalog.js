// =====================================================================
// Export catálogo TenisCash -> CSV do CATÁLOGO DA META (Commerce Manager)
// Alimenta Facebook (loja), Instagram (shopping) e WhatsApp (catálogo).
// =====================================================================
// Mesma REGRA DE OURO da loja/TikTok:
//   - active + classificado nas 4 (Categoria+Subcategoria+Modalidade+Especialidade)
//   - preço de VENDA com markup (price > 0 e > custo)
//   - ESTOQUE = Σ StoreStock das LOJAS SPORTS & TENNIS (localizado/bipado),
//     NUNCA o comprado, e EXCLUI o Baratão (LOJA01 = outra empresa)
//   - só tamanhos com estoque > 0 e foto http (Meta exige image_link)
// 1 linha por TAMANHO; item_group_id = produto (agrupa as variações/tamanhos).
//   node scripts/export-meta-catalog.js
// =====================================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br').replace(/\/+$/, '');
const OUT = path.join('C:', 'Users', 'sport', 'Downloads', 'meta-catalogo-sports-tennis.csv');

function ctxOf(p) {
  try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
  catch { return {}; }
}
function isValidGtin(code) {
  const s = String(code || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(s.length)) return false;
  const d = s.split('').map(Number); const chk = d.pop();
  let sum = 0; d.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === chk;
}
function httpImages(p) {
  const out = [];
  const push = (u) => { if (u && typeof u === 'string' && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u); };
  push(p.imageUrl);
  try {
    const arr = typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : p.imageUrls;
    if (Array.isArray(arr)) arr.forEach(push);
  } catch (_) {}
  return out.slice(0, 20);
}
function isRealSize(sz) {
  const s = String(sz || '').trim().toUpperCase().replace(',', '.');
  if (!s) return false;
  if (['UNICO', 'ÚNICO', 'U', 'UN'].includes(s)) return true;
  if (/^(PP|P|M|G|GG|XG|XGG|XS|S|L|XL|XXL|XXG)$/.test(s)) return true;
  if (/^\d{1,2}(\.5)?$/.test(s)) { const n = parseFloat(s); if (n >= 1 && n <= 48) return true; }
  return false;
}
function cleanName(name) {
  let n = String(name || '');
  n = n.replace(/\bREF[:.\s]*[A-Z0-9][A-Z0-9\-\/.]*/gi, ' ');
  n = n.replace(/\b\d{2,3}\s*\/\s*\d{2,3}\b/g, ' ');
  n = n.replace(/\b\d{5,}\b/g, ' ');
  n = n.replace(/\s{2,}/g, ' ').replace(/[\s\-]+$/, '').trim();
  return n || String(name || '').trim();
}

async function main() {
  // Baratão (LOJA01) = outra empresa -> NÃO entra no catálogo da S&T
  const baratao = await prisma.store.findFirst({
    where: { OR: [{ code: 'LOJA01' }, { name: { contains: 'barat', mode: 'insensitive' } }] },
    select: { id: true, name: true },
  });
  const baratoId = baratao?.id || null;
  console.log('Excluindo do feed a loja:', baratao?.name || '(nenhuma Baratão encontrada)');

  const products = await prisma.product.findMany({
    where: { active: true },
    include: { sizes: { include: { storeStocks: true } } },
    orderBy: [{ brand: 'asc' }, { name: 'asc' }],
  });
  console.log(`Produtos ativos: ${products.length}`);

  const rows = [];
  const stat = { prod: 0, sku: 0, units: 0, semClass: 0, semPreco: 0, semEstoque: 0, semFoto: 0 };
  const byBrand = {};

  for (const p of products) {
    const ctx = ctxOf(p);
    const cls = ctx.classification || {};
    const badCat = ['', 'A CLASSIFICAR', 'A DEFINIR'];
    const has = (v) => v != null && String(v).trim() !== '';

    const classified = has(p.category) && !badCat.includes(String(p.category).trim())
      && has(p.subcategory) && has(cls.modality) && has(cls.tier);
    if (!classified) { stat.semClass++; continue; }

    const price = Number(p.price || 0), cost = Number(p.costPrice || 0);
    if (!(price > 0) || (cost > 0 && price <= cost)) { stat.semPreco++; continue; }

    // ESTOQUE = Σ StoreStock das lojas S&T (exclui Baratão), por tamanho; só > 0
    const sizes = (p.sizes || []).map((s) => ({
      size: s.size, barcode: s.barcode,
      loc: (s.storeStocks || [])
        .filter((ss) => ss.storeId !== baratoId)
        .reduce((a, ss) => a + (ss.stock || 0), 0),
    })).filter((s) => s.loc > 0 && isRealSize(s.size));
    if (!sizes.length) { stat.semEstoque++; continue; }

    const imgs = httpImages(p);
    if (!imgs.length) { stat.semFoto++; continue; } // Meta EXIGE image_link

    const color = ctx.color || '';
    let title = cleanName(p.name);
    const brand = (p.brand || '').trim();
    if (brand && !title.toLowerCase().includes(brand.toLowerCase())) title = `${brand} ${title}`;
    if (color && !title.toLowerCase().includes(color.toLowerCase())) title = `${title} ${color}`;
    title = title.trim().slice(0, 200);
    const desc = String(p.longDescription || p.shortDescription || title).replace(/\s+/g, ' ').trim().slice(0, 9999);
    const link = `${PUBLIC_BASE}/p/${p.id}`;
    const promo = Number(p.promoPrice || 0);
    const gender = ctx.gender || cls.gender || '';

    stat.prod++;
    byBrand[brand || '(sem marca)'] = (byBrand[brand || '(sem marca)'] || 0) + 1;
    for (const s of sizes) {
      stat.sku++; stat.units += s.loc;
      const gtin = isValidGtin(s.barcode) ? String(s.barcode).replace(/\D/g, '') : '';
      rows.push({
        id: gtin || `${p.sku || p.id}-${s.size}`,
        title,
        description: desc,
        availability: 'in stock',
        condition: 'new',
        price: `${price.toFixed(2)} BRL`,
        ...(promo > 0 && promo < price ? { sale_price: `${promo.toFixed(2)} BRL` } : { sale_price: '' }),
        link,
        image_link: imgs[0],
        additional_image_link: imgs.slice(1, 11).join(','),
        brand: brand || 'Sports & Tennis',
        item_group_id: p.id,
        google_product_category: '',
        color,
        size: s.size,
        gender,
        gtin,
        quantity_to_sell_on_facebook: s.loc,
      });
    }
  }

  const csv = Papa.unparse(rows, { quotes: true });
  fs.writeFileSync(OUT, '﻿' + csv, 'utf8');

  console.log('\n===== FEED DA META =====');
  console.log(`Produtos no catalogo  : ${stat.prod}`);
  console.log(`Variacoes (linhas)    : ${stat.sku}`);
  console.log(`Unidades em estoque   : ${stat.units}`);
  console.log('\nFicaram de fora:');
  console.log(`  sem classificacao   : ${stat.semClass}`);
  console.log(`  sem preco de venda  : ${stat.semPreco}`);
  console.log(`  sem estoque S&T     : ${stat.semEstoque} (so comprado/NFe, ou so no Baratao)`);
  console.log(`  sem foto (Meta exige): ${stat.semFoto}`);
  console.log('\nTop marcas no feed:');
  Object.entries(byBrand).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([b, n]) => console.log(`  ${String(b).padEnd(20)} ${n}`));
  console.log(`\nArquivo: ${OUT}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
