// =====================================================================
// fetch-all-images.js — busca imagens pra TODOS produtos ativos sem imagem
// =====================================================================
// Estratégia universal por marca:
//   - Extrai código do modelo do nome (regex por padrão)
//   - Limpa "TENIS", "CALCADO", "REF: XXX -" do nome
//   - Query: marca + modelo + código + cores
//   - Filtra URLs ruins (banner, logo, sprite, capa, hero)
//   - Múltiplas tentativas com queries diferentes
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split(/\r?\n/).forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const { PrismaClient } = require('@prisma/client');
const serperGis = require('../src/services/serperImageSearch');
const prisma = new PrismaClient();

const BAD_URL_RX = /banner|logo|hero|sprite|favicon|loading|placeholder|capa-|^https?:\/\/[^/]+\/?$/i;
const GOOD_URL_RX = /product|produto|\/prod|\/item|photos|imagens|\/p\/|catalog|media|tcdn|vtex|fbits|mercadoshops/i;

function looksLikeProduct(url) {
  if (!url || typeof url !== 'string') return false;
  if (BAD_URL_RX.test(url)) return false;
  if (GOOD_URL_RX.test(url)) return true;
  return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
}

function buildQuery(product, brand, attempt) {
  const name = (product.name || '').toUpperCase();
  // Extrai códigos comuns (modelos esportivos)
  const codePatterns = [
    /\b([A-Z]{2}\d{6,10})\b/,    // CK00010007, CO05440002 (Converse)
    /\b([A-Z]{3,4}\d{2,4})\b/,    // ASICS 5061, etc
    /\bREF:\s*([A-Z0-9]+)/i,
    /\b(\d{6,12})\b/,             // EAN/código numérico
  ];
  let code = null;
  for (const rx of codePatterns) {
    const m = name.match(rx);
    if (m) { code = m[1]; break; }
  }
  // Modelos esportivos comuns
  const modelRx = /(CHUCK TAYLOR ALL STAR(?:\s+LIFT)?|STAR PLAYER|PRO BLAZE\s*(?:STRAP|CLASSIC)?|RUN STAR\s*\w*|JACK PURCELL|ONE STAR|GEL[\s\-][A-Z]+(?:\s+\d+)?|NIMBUS\s*\d*|KAYANO\s*\d*|CUMULUS\s*\d*|FUELCELL|GO RUN|GO WALK|ARCH FIT|BOBS|BRAVADA|GALAXY|DURAMO|SUPERSTAR|STAN SMITH|FORUM|CAMPUS|GAZELLE|MERCURIAL|TIEMPO|PHANTOM|MERLIN|MORELIA|MONARCIDA|REBULA|PRO MAX|ULTRA|FUTURE|KING|JOGGING|GALAXY|TRAILER)/i;
  const modelMatch = name.match(modelRx);
  const model = modelMatch ? modelMatch[1] : null;
  // Cores
  const colorWords = (name.match(/\b(PRETO|BRANCO|VERMELHO|AZUL|VERDE|ROSA|AMARELO|MARROM|CINZA|LILAS|LIL[ÁA]S|VIOLETA|MARINHO|BEGE|CAQUI|C[ÁA]QUI|VINHO|GRAFITE|CRU|PINK|CHUMBO|MENTA|CARAMELO|OLIVA|NUDE|GELO|TURQUESA|LARANJA|MUSTARD|MOSTARDA|COBALTO|FUCSIA|ROXO|DOURADO|PRATA|BORDO|TINTO|VINHO|MARSALA|VINHO|ESCURO|CLARO)\b/gi) || []).slice(0, 2).join(' ');

  // Nome limpo (remove TENIS, CALCADO, REF: prefix)
  const cleanName = (product.name || '')
    .replace(/^(T[ÊE]NIS|CALCADO|CAL[ÇC]ADO|TENIS)\s+/i, '')
    .replace(/^REF:\s*[A-Z0-9]+\s*-\s*/i, '')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/\s+\d+\s*$/, '')  // remove tamanho do final
    .replace(/\s+/g, ' ').trim();

  if (attempt === 0) {
    // Mais específica: marca + modelo + código + cor
    const parts = [];
    if (brand) parts.push(brand);
    if (model) parts.push(model);
    if (code) parts.push(code);
    if (colorWords) parts.push(colorWords);
    if (!model && !code && cleanName) parts.push(cleanName.slice(0, 50));
    return parts.join(' ');
  } else if (attempt === 1) {
    // Sem código, mais nome
    const parts = [];
    if (brand) parts.push(brand);
    if (cleanName) parts.push(cleanName.slice(0, 60));
    return parts.join(' ');
  } else {
    // Fallback: marca + nome cru limitado
    return `${brand || ''} ${cleanName}`.trim().slice(0, 80);
  }
}

(async () => {
  const products = await prisma.$queryRaw`
    SELECT p.id, p.sku, p.name, p.brand, p."aiContext"::jsonb as ctx,
           s."suppliedBrands"
    FROM "Product" p
    LEFT JOIN "Supplier" s ON s.cnpj = p."aiContext"::jsonb->>'supplierCnpj'
    WHERE p.active = true
      AND (p."imageUrl" IS NULL OR p."imageUrl" = '')
      AND p."aiContext"::jsonb->>'supplierCnpj' IS NOT NULL
    ORDER BY p."aiContext"::jsonb->>'supplierCnpj', p.id
  `;
  console.log('Total a processar:', products.length);

  let ok = 0, fail = 0;
  const startTs = Date.now();
  const failByBrand = {};

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const ctx = p.ctx || {};
    const supplierBrands = Array.isArray(p.suppliedBrands) ? p.suppliedBrands : [];
    const brand = (p.brand && p.brand !== 'A DEFINIR') ? p.brand : (supplierBrands[0] || null);

    let found = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const q = buildQuery(p, brand, attempt);
      if (!q) continue;
      try {
        const r = await serperGis.searchImages(q, { count: 10 });
        if (!r.ok || !r.items?.length) continue;
        const good = r.items.find(it => looksLikeProduct(it.url));
        if (good) { found = good; break; }
      } catch (e) { /* tenta próxima */ }
      await new Promise(rr => setTimeout(rr, 200));
    }

    if (!found) {
      fail++;
      failByBrand[brand || 'unknown'] = (failByBrand[brand || 'unknown'] || 0) + 1;
    } else {
      try {
        await prisma.product.update({
          where: { id: p.id },
          data: { imageUrl: found.url },
        });
        ok++;
      } catch (e) { fail++; }
    }

    if ((i + 1) % 50 === 0) {
      const pct = ((i + 1) / products.length * 100).toFixed(0);
      const eta = Math.round(((Date.now() - startTs) / (i + 1)) * (products.length - i - 1) / 1000);
      console.log(`  ${i + 1}/${products.length} (${pct}%) | ok:${ok} fail:${fail} | ETA: ${eta}s`);
    }
    await new Promise(rr => setTimeout(rr, 150));
  }

  console.log('\n=== RESULTADO FINAL ===');
  console.log('Sucesso:', ok);
  console.log('Falhas:', fail);
  console.log('Falhas por marca:');
  Object.entries(failByBrand).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([b, n]) => console.log('  ' + n.toString().padStart(4) + ' | ' + b));
  console.log('Tempo total:', Math.round((Date.now() - startTs) / 1000) + 's');

  await prisma.$disconnect();
})().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
