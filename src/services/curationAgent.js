// =====================================================================
// Curation Agent — orquestra a curadoria completa de UM produto:
//   1. Busca imagens via Serper (site oficial do fornecedor)
//   2. Usa Claude Vision pra pontuar cada candidata
//   3. Pega a melhor (e adicionais ranqueadas)
//   4. Busca a descrição oficial no site do fornecedor
//   5. Salva imageUrl + imageUrls + longDescription
//   6. Sincroniza com Nuvemshop (se tem mapping)
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = global._prismaCuration || (global._prismaCuration = new PrismaClient());

const serperImg = require('./serperImageSearch');
const serperWeb = require('./serperWebSearch');
const { scrapeProductPage } = require('./productPageScraper');
const { pickBestImage, isConfigured: visionConfigured } = require('./visionValidator');
const { getSupplierMeta } = require('./supplierOfficialSites');
const { discoverBrandSite, isConfigured: brandDiscoveryConfigured } = require('./brandDiscovery');
const nsHandlers = require('./nuvemshopHandlers');

function parseCtx(p) {
  try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
  catch (_) { return {}; }
}

async function syncToNuvemshopIfMapped(productId) {
  try {
    const mapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: productId } });
    if (!mapping) return { synced: false, reason: 'sem mapping' };
    const connection = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!connection) return { synced: false, reason: 'sem conexão' };
    const result = await nsHandlers.pushProductToNuvemshop(productId, connection);
    return { synced: true, action: result.action };
  } catch (err) {
    return { synced: false, error: err.message };
  }
}

/**
 * Cura um produto inteiramente.
 * @param {string} productId
 * @param {Object} opts
 * @param {boolean} [opts.skipImage=false]
 * @param {boolean} [opts.skipDescription=false]
 * @param {boolean} [opts.skipNuvemshop=false]
 * @param {number}  [opts.imageCandidates=8]      — quantas imagens analisar
 * @param {number}  [opts.minScore=5]            — score mínimo pra aceitar imagem
 * @returns {Promise<Object>} relatório
 */
async function curateProduct(productId, opts = {}) {
  const report = {
    productId,
    sku: null,
    steps: { image: null, description: null, nuvemshop: null },
    costBRL: 0,
    error: null,
  };

  try {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      report.error = 'produto não encontrado';
      return report;
    }
    report.sku = product.sku;
    const ctx = parseCtx(product);
    const supplierCnpj = ctx.supplierCnpj;
    const supplierMeta = getSupplierMeta(supplierCnpj);
    let officialSite = supplierMeta?.site || null;
    let brandToUse = supplierMeta?.brand || product.brand;

    // Se NÃO tem site mapeado E temos a IA, tenta descobrir o site oficial
    // pela marca + categoria. Cache por marca evita pagar várias vezes.
    if (!officialSite && brandDiscoveryConfigured() && brandToUse && !/^(A\s*DEFINIR|-+|sem\s*marca)?$/i.test(brandToUse.trim())) {
      const disc = await discoverBrandSite(brandToUse, product.category);
      if (disc.ok) {
        if (disc.site && disc.confidence >= 7) officialSite = disc.site;
        if (disc.brandCanonical) brandToUse = disc.brandCanonical;
        report.brandDiscovery = { site: disc.site, confidence: disc.confidence, canonical: disc.brandCanonical, source: disc.source || 'ai' };
        report.costBRL += disc.cost?.brl || 0;
      }
    }

    const cleanName = (product.name || '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const productInfo = {
      name: cleanName || product.name,
      brand: brandToUse,
      color: ctx.color,
      category: product.category,
    };

    // ============ 1. IMAGEM ============
    if (!opts.skipImage && !product.imageUrl) {
      let imgQuery = serperImg.buildProductQuery({
        brand: brandToUse,
        supplierRef: ctx.supplierRef,
        model: cleanName,
        color: ctx.color,
        category: product.category,
      });
      if (officialSite) imgQuery = `${imgQuery} site:${officialSite}`.trim();

      const searchResult = await serperImg.searchImages(imgQuery, { count: opts.imageCandidates || 8 });

      if (!searchResult.ok || !searchResult.items?.length) {
        // Fallback: busca ampla sem site filter
        const broadQuery = serperImg.buildProductQuery({
          brand: brandToUse,
          supplierRef: ctx.supplierRef,
          model: cleanName,
          color: ctx.color,
          category: product.category,
        });
        const broad = await serperImg.searchImages(broadQuery, { count: opts.imageCandidates || 8 });
        if (broad.ok && broad.items?.length) searchResult.items = broad.items;
      }

      if (searchResult.items?.length) {
        const candidates = searchResult.items;
        let chosen = candidates[0];
        let rankedScored = candidates.map((c, i) => ({ ...c, _score: candidates.length - i }));
        let visionCost = 0;

        if (visionConfigured()) {
          // pontua com vision, pega a melhor (com early stop pra economizar custo)
          const r = await pickBestImage(candidates, productInfo, {
            earlyStopScore: 9,
            maxCalls: Math.min(candidates.length, opts.imageCandidates || 8),
          });
          if (r.ranked.length) {
            rankedScored = r.ranked;
            chosen = r.ranked[0];
            visionCost = r.totalCostBRL || 0;
          }
        }

        // Só salva se score >= minScore (ou se sem vision, sempre salva)
        const minScore = opts.minScore ?? 5;
        const acceptable = !visionConfigured() || (chosen._score || 0) >= minScore;

        if (acceptable && chosen.url) {
          // Junta as analisadas (sem a escolhida) + as não-analisadas (ordem do Serper).
          // Garante até 5 extras mesmo quando early stop terminou cedo.
          const seen = new Set([chosen.url]);
          const extras = [];
          for (const c of rankedScored) {
            if (c.url && !seen.has(c.url) && extras.length < 5) {
              extras.push(c.url);
              seen.add(c.url);
            }
          }
          for (const c of candidates) {
            if (extras.length >= 5) break;
            if (c.url && !seen.has(c.url)) {
              extras.push(c.url);
              seen.add(c.url);
            }
          }
          await prisma.product.update({
            where: { id: product.id },
            data: { imageUrl: chosen.url, imageUrls: extras.length ? extras : undefined },
          });
          report.steps.image = {
            ok: true,
            url: chosen.url,
            score: chosen._score,
            reason: chosen._reason || null,
            candidates: rankedScored.length,
            extras: extras.length,
          };
          report.costBRL += visionCost;
        } else {
          report.steps.image = {
            ok: false,
            reason: `melhor score (${chosen._score}) abaixo do mínimo (${minScore})`,
            candidates: rankedScored.length,
            topScore: chosen._score,
          };
          report.costBRL += visionCost;
        }
      } else {
        report.steps.image = { ok: false, reason: 'nenhuma imagem encontrada' };
      }
    } else if (product.imageUrl) {
      report.steps.image = { ok: true, reason: 'já tinha imagem', url: product.imageUrl };
    }

    // ============ 2. DESCRIÇÃO ============
    if (!opts.skipDescription && !product.longDescription && serperWeb.isConfigured()) {
      const queryParts = [];
      if (brandToUse) queryParts.push(brandToUse);
      if (cleanName) queryParts.push(cleanName);
      if (ctx.color && !cleanName.toLowerCase().includes(String(ctx.color).toLowerCase())) {
        queryParts.push(ctx.color);
      }
      const baseQuery = queryParts.join(' ');

      // Tentativa 1: site oficial (se temos)
      let productUrl = null;
      let triedQueries = [];
      if (officialSite) {
        const q1 = `${baseQuery} site:${officialSite}`;
        triedQueries.push(q1);
        const r1 = await serperWeb.searchWeb(q1, { count: 5 });
        const siteRe = new RegExp(officialSite.replace(/\./g, '\\.') + '(/|$)', 'i');
        productUrl = (r1.results || []).find((r) => siteRe.test(r.url || ''))?.url || null;
      }

      // Tentativa 2: busca ampla — qualquer página com nome+marca, prioriza páginas que tenham
      // descrição estruturada (e-commerce). Filtra fora redes sociais e marketplaces ruins.
      if (!productUrl) {
        triedQueries.push(baseQuery);
        const r2 = await serperWeb.searchWeb(baseQuery, { count: 10 });
        const blacklist = /facebook|instagram|tiktok|youtube|pinterest|twitter|wikipedia/i;
        const candidates = (r2.results || []).filter((r) => !blacklist.test(r.url || ''));
        productUrl = candidates[0]?.url || null;
      }

      if (productUrl) {
        const scraped = await scrapeProductPage(productUrl);
        if (scraped.ok && (scraped.description || scraped.descriptionHtml)) {
          const longDesc = scraped.descriptionHtml || scraped.description;
          const shortBase = scraped.overview || scraped.description;
          await prisma.product.update({
            where: { id: product.id },
            data: {
              longDescription: longDesc,
              shortDescription: shortBase ? (shortBase.length > 200 ? shortBase.slice(0, 200) + '…' : shortBase) : null,
            },
          });
          report.steps.description = { ok: true, url: productUrl, length: longDesc.length, source: officialSite ? 'site oficial' : 'busca ampla' };
        } else {
          report.steps.description = { ok: false, reason: 'página sem descrição extraível', url: productUrl, triedQueries };
        }
      } else {
        report.steps.description = { ok: false, reason: 'nenhuma página relevante encontrada', triedQueries };
      }
    } else if (product.longDescription) {
      report.steps.description = { ok: true, reason: 'já tinha descrição' };
    }

    // ============ 3. NUVEMSHOP ============
    if (!opts.skipNuvemshop) {
      const sync = await syncToNuvemshopIfMapped(product.id);
      report.steps.nuvemshop = sync;
    }

    return report;
  } catch (err) {
    report.error = err.message;
    return report;
  }
}

module.exports = { curateProduct };
