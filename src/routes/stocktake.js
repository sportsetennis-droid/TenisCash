// =====================================================================
// /api/stocktake — Contagem por bipe (público + admin)
// =====================================================================
// Endpoints públicos (sem auth) usados pela página /bipar.html:
//   GET  /api/stocktake/stores            → lista lojas ativas
//   GET  /api/stocktake/sellers?storeId=  → lista vendedores da loja
//   POST /api/stocktake/bipe              → registra um bipe
//
// Endpoints admin (com auth):
//   GET  /api/stocktake/bipes             → lista bipes p/ revisão (filtros)
//   GET  /api/stocktake/summary           → resumo por loja/vendedor
//   DELETE /api/stocktake/bipes/:id       → remove um bipe (caso erro)
// =====================================================================

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();

// Upload em memória pra foto de conferência (máx 12MB), comprimida com sharp -> webp base64.
const captureUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => (/^image\//i.test(f.mimetype) ? cb(null, true) : cb(new Error('arquivo não é imagem'))) });
async function shrinkPhoto(buf) {
  const out = await sharp(buf, { failOn: 'none' }).rotate().resize(900, 1200, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  return `data:image/webp;base64,${out.toString('base64')}`;
}

// Extrai tamanho da descricao da NFe (mesmo regex do script create-products-from-nfe-pending.js)
function inferSizeFromDescription(description) {
  if (!description) return 'Único';
  const d = String(description).toUpperCase().trim();
  const acessorios = /\b(MEIA|MEIAS|BOLSA|MOCHILA|GARRAFA|TOALHA|VISEIRA|BONE|BONÉ|BANDEIRA|FAIXA|MUNHEQUEIRA|RAQUETE|BOLA|CORDA|CASQUEIRA|GORRO|TOUCA|LUVA|ÓCULOS|OCULOS|RELOGIO|MEDALHA|TROFEU)\b/;
  if (acessorios.test(d)) return 'Único';
  // Padrao: "TAMANHO:38;COR:..."
  const mTamCol = d.match(/TAMANHO:\s*([A-Z0-9]+)\s*[;,]/);
  if (mTamCol) return mTamCol[1];
  const mTam = d.match(/\bTAM\.?\s*(\d{2})\b/);
  if (mTam) return mTam[1];
  const mTamL = d.match(/\bTAM\.?\s*(PP|P|M|G|GG|XGG|XG)\b/);
  if (mTamL) return mTamL[1];
  if (/\b\d{2}[\/\-A]\s*\d{2}\b/.test(d) || /\b\d{2}\s+A\s+\d{2}\b/.test(d)) return '?';
  const mEnd = d.match(/\s(\d{2})\s*$/);
  if (mEnd) return mEnd[1];
  if (/\b(PP|XGG|XG|GG|G|M|P)\b\s*$/.test(d)) {
    const m = d.match(/\b(PP|XGG|XG|GG|G|M|P)\b\s*$/);
    if (m) return m[1];
  }
  return 'Único';
}

// Variantes do código pra casar UPC-12 ↔ GTIN-13/14 (zero à esquerda).
// A caixa traz UPC-12 (ex 195394510652); a NFe salva GTIN-13 (0195394510652).
// O leitor lê 12 díg e não batia no banco. Aqui geramos as duas formas.
function barcodeVariants(code) {
  const c = String(code || '').trim();
  if (!c) return [];
  const out = new Set([c]);
  if (/^\d+$/.test(c)) {
    const noLead = c.replace(/^0+/, '');
    if (noLead) out.add(noLead);
    if (c.length <= 13) out.add(c.padStart(13, '0'));
    if (c.length <= 14) out.add(c.padStart(14, '0'));
  }
  return [...out];
}

// ============================================================
// TAMANHO MANUAL NO BIPE — regra Adidas (dono 2026-06-10)
// A NFe da Adidas (ALPAR) NÃO traz o tamanho por código (cProd = o
// próprio EAN, descrição só com a faixa "38/43"). O de-para
// código→tamanho vem da CAIXA física. Então: ao bipar produto ADIDAS
// cujo tamanho ainda é placeholder, a tela PEDE o tamanho manual.
// ============================================================

// Tamanho "placeholder" = ainda não confirmado pela caixa física.
// Padrões: 'T-<EAN>' (desvinculo dos chutados), '?' (faixa na NFe), vazio.
function isPlaceholderSize(size) {
  const s = String(size || '').trim();
  return !s || s === '?' || /^T-/i.test(s);
}

function isAdidas(brand) {
  return String(brand || '').toUpperCase().includes('ADIDAS');
}

// needsSize = bipe de ADIDAS com tamanho ainda NÃO confirmado por caixa física.
// Cobre placeholder (T-<EAN>/?) E chute antigo de importação (número presente
// mas sizeConfirmedAt null). Confirmou uma vez → nunca mais pede.
function needsManualSize(brand, productSizeRow) {
  if (!isAdidas(brand)) return false;
  if (!productSizeRow) return false;
  return !productSizeRow.sizeConfirmedAt;
}

// Normaliza/valida o tamanho digitado. Aceita:
//   calçado: 15–50, meio tamanho com .5 (ex "38.5", "41")
//   vestuário: PP P M G GG XG XGG EG EGG
//   infantil por idade: 2A–16A (ex "8A", "14A")
//   acessório sem tamanho: U / UNICO / ÚNICO → 'Único'
// Retorna null se não for plausível — NUNCA grava lixo.
function normalizeManualSize(raw) {
  let s = String(raw || '').trim().toUpperCase().replace(',', '.').replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d{2}(\.5)?$/.test(s)) {
    const n = parseFloat(s);
    return n >= 15 && n <= 50 ? s : null;
  }
  if (/^(PP|P|M|G|GG|XG|XGG|EG|EGG)$/.test(s)) return s;
  if (/^\d{1,2}A$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 2 && n <= 16 ? s : null;
  }
  if (/^(U|UNICO|ÚNICO)$/.test(s)) return 'Único';
  return null;
}

// Extrai a FAIXA de tamanhos escrita no ITEM do produto (descrição ALPAR/Adidas)
// e devolve a lista de opções pro modal — só os tamanhos POSSÍVEIS daquele produto.
//   "TENIS TURNAROUND 34/39"   → ['34','35','36','37','38','39']
//   "CAMISA ESTRO INF 7A/14A"  → ['7A','8A',...,'14A']
//   "CAMISA ESTRO P/GG"        → ['P','M','G','GG']
//   "TENSAUR SPORT 18/24"      → ['18',...,'24']
// Sem faixa detectável (acessório etc) → null (front usa grade padrão + Único).
const LETTER_SEQ = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG'];
function extractSizeOptions(text) {
  const t = String(text || '').toUpperCase();
  if (!t) return null;
  // idades infantis: 7A/14A
  let m = t.match(/\b(\d{1,2})A\s*\/\s*(\d{1,2})A\b/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a >= 1 && b > a && b <= 16) return Array.from({ length: b - a + 1 }, (_, i) => (a + i) + 'A');
  }
  // numérica (calçado/infantil): 38/43, 34/39, 18/24
  m = t.match(/\b(\d{2})\s*\/\s*(\d{2})\b/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a >= 15 && b > a && b <= 50 && b - a <= 14) return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  }
  // letras (vestuário): P/GG, PP/XGG
  m = t.match(/\b(PP|P|M|G|GG|XG|XGG)\s*\/\s*(PP|P|M|G|GG|XG|XGG)\b/);
  if (m) {
    const i0 = LETTER_SEQ.indexOf(m[1]), i1 = LETTER_SEQ.indexOf(m[2]);
    if (i0 >= 0 && i1 > i0) return LETTER_SEQ.slice(i0, i1 + 1);
  }
  return null;
}

// Opções de tamanho pro bipe: tenta o nome do card; se não tiver faixa,
// tenta a descrição da NFe de entrada do próprio código bipado.
async function sizeOptionsForBipe(productName, code) {
  let opts = extractSizeOptions(productName);
  if (opts) return opts;
  try {
    const item = await prisma.xmlFiscalItem.findFirst({
      where: { ean: { in: barcodeVariants(code) } },
      select: { description: true },
      orderBy: { createdAt: 'desc' },
    });
    if (item) opts = extractSizeOptions(item.description);
  } catch (_) {}
  return opts;
}

// ============== PÚBLICOS ==============

// GET /api/stocktake/stores → lojas ativas (dropdown)
router.get('/stores', async (_req, res) => {
  try {
    const stores = await prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true, code: true, mall: true },
      orderBy: { name: 'asc' },
    });
    res.json({ stores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stocktake/sellers?storeId=X → vendedores da loja (dropdown)
router.get('/sellers', async (req, res) => {
  try {
    const where = { active: true, role: 'seller' };
    if (req.query.storeId) where.storeId = String(req.query.storeId);
    const sellers = await prisma.user.findMany({
      where,
      select: { id: true, name: true, employeeCode: true, storeId: true },
      orderBy: { name: 'asc' },
    });
    res.json({ sellers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stocktake/bipe → registra bipe + retorna produto (se achou)
//
// HOTFIX-BIPE: bipe é SALVO PRIMEIRO (StocktakeBipe.create), só depois
// fazemos lookups que enriquecem o registro. Se lookup falhar, o bipe
// bruto não é perdido. Idempotência opcional via clientScanId (embutido
// no userAgent — sem mudar schema). Logs estruturados pra auditoria.
router.post('/bipe', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  const uaRaw = (req.headers['user-agent'] || '').toString().slice(0, 160);

  try {
    const { barcode, storeId, sellerId, sellerName, clientScanId } = req.body || {};

    if (!barcode) {
      console.log('[bipe] BIPE_RECEBIDO_INVALIDO', JSON.stringify({ motivo: 'barcode_ausente', storeId: storeId || null, sellerId: sellerId || null }));
      return res.status(400).json({ error: 'barcode obrigatório', retry: false });
    }

    const code = String(barcode).trim();
    if (!code) {
      console.log('[bipe] BIPE_RECEBIDO_INVALIDO', JSON.stringify({ motivo: 'barcode_vazio', storeId: storeId || null, sellerId: sellerId || null }));
      return res.status(400).json({ error: 'barcode vazio', retry: false });
    }

    console.log('[bipe] BIPE_RECEBIDO', JSON.stringify({ storeId: storeId || null, sellerId: sellerId || null, barcodeLen: code.length, clientScanId: clientScanId || null }));

    // Idempotência via clientScanId embutido no userAgent (suffix " | cs:<id>")
    // Sem mudar schema — usa userAgent como carrier. Limitação registrada.
    const csId = clientScanId ? String(clientScanId).slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '') : null;
    const ua = csId ? `${uaRaw} | cs:${csId}` : uaRaw;

    if (csId) {
      // Procura bipe recente (últimos 60s) com mesmo clientScanId pra evitar duplicação
      const sinceMs = new Date(Date.now() - 60_000);
      try {
        const existing = await prisma.stocktakeBipe.findFirst({
          where: {
            barcode: code,
            bipedAt: { gte: sinceMs },
            userAgent: { contains: `cs:${csId}` },
          },
          orderBy: { bipedAt: 'desc' },
        });
        if (existing) {
          console.log('[bipe] BIPE_DUPLICADO_IGNORADO', JSON.stringify({ bipeIdExistente: existing.id, clientScanId: csId }));
          // Regra Adidas: checa o estado ATUAL do ProductSize (snapshot pode estar velho)
          let needsSizeIdem = false;
          let sizeOptionsIdem;
          if (existing.productSizeId && isAdidas(existing.productBrand)) {
            try {
              const psNow = await prisma.productSize.findUnique({ where: { id: existing.productSizeId }, select: { size: true, sizeConfirmedAt: true } });
              needsSizeIdem = needsManualSize(existing.productBrand, psNow);
              if (needsSizeIdem) sizeOptionsIdem = await sizeOptionsForBipe(existing.productName, code);
            } catch (_) {}
          }
          return res.json({
            success: true,
            bipeId: existing.id,
            appliedToStock: existing.applied,
            found: existing.found,
            duplicate: existing.duplicate,
            idempotent: true,
            needsSize: needsSizeIdem,
            sizeOptions: sizeOptionsIdem || undefined,
            product: existing.productName ? {
              name: existing.productName,
              brand: existing.productBrand,
              size: existing.productSize,
              sku: null, imageUrl: null, active: true,
            } : null,
          });
        }
      } catch (e) {
        // Falha do check de idempotência não bloqueia: segue criando bipe normal
        console.warn('[bipe] check_idempotencia_falhou:', e.message);
      }
    }

    // ========================================================================
    // PASSO 1: SALVA O BIPE BRUTO IMEDIATAMENTE (antes de qualquer lookup)
    // Garantia: se qualquer etapa seguinte falhar, o bipe não some.
    // ========================================================================
    let bipe;
    try {
      bipe = await prisma.stocktakeBipe.create({
        data: {
          barcode: code,
          storeId: storeId || null,
          sellerId: sellerId || null,
          sellerName: sellerName || null,
          productId: null,
          productSizeId: null,
          productName: null,
          productSize: null,
          productBrand: null,
          found: false,
          duplicate: false,
          ip: ip || null,
          userAgent: ua || null,
        },
      });
      console.log('[bipe] BIPE_SALVO', JSON.stringify({ bipeId: bipe.id, barcode: code, storeId: storeId || null, sellerId: sellerId || null }));
    } catch (e) {
      // Falha em criar o bipe bruto é catastrófica — bipe será perdido. Retorna 503 pra cliente retentar.
      console.error('[bipe] BIPE_ERRO_CRIAR_BRUTO', JSON.stringify({ error: e.message, barcode: code }));
      return res.status(503).json({ error: 'Falha ao salvar bipe — tente de novo', retry: true });
    }

    // ========================================================================
    // PASSO 2: lookups enriquecedores (rede de proteção: erros não derrubam o bipe)
    // ========================================================================
    // Casa por barcode tolerando zero à esquerda (UPC-12 ↔ GTIN-13/14).
    let matched = [];
    try {
      matched = await prisma.productSize.findMany({
        where: { barcode: { in: barcodeVariants(code) } },
        include: {
          product: { select: { id: true, name: true, brand: true, sku: true, active: true, imageUrl: true } },
        },
      });
    } catch (e) {
      console.warn('[bipe] BIPE_ETAPA_SECUNDARIA_FALHOU', JSON.stringify({ bipeId: bipe.id, etapa: 'lookup_productSize', error: e.message }));
    }

    // FALLBACK NFe — regra CLAUDE.md ativa.
    if (matched.length === 0) {
      try {
        const nfeItem = await prisma.xmlFiscalItem.findFirst({
          where: { ean: { in: barcodeVariants(code) }, productId: { not: null } },
          select: { ean: true, description: true, productId: true, product: { select: { id: true, name: true, brand: true, sku: true, active: true, imageUrl: true } } },
          orderBy: { createdAt: 'desc' },
        });
        if (nfeItem && nfeItem.product) {
          // ADIDAS: a NFe NUNCA traz o tamanho por código (levantamento 2026-06-09) —
          // inferir da descrição dá lixo. Cria como placeholder → modal pede o da caixa.
          const sizeStr = isAdidas(nfeItem.product.brand)
            ? ('T-' + code)
            : inferSizeFromDescription(nfeItem.description);
          try {
            const newSize = await prisma.productSize.create({
              data: { productId: nfeItem.productId, size: sizeStr, barcode: code, stock: 0 },
            });
            matched = [{ id: newSize.id, size: sizeStr, barcode: code, product: nfeItem.product }];
            console.log('[bipe] BIPE_AUTOCRIOU_PRODUCTSIZE', JSON.stringify({ bipeId: bipe.id, productId: nfeItem.productId, size: sizeStr, barcode: code }));
          } catch (e) {
            console.warn('[bipe] BIPE_ETAPA_SECUNDARIA_FALHOU', JSON.stringify({ bipeId: bipe.id, etapa: 'fallback_create_productSize', error: e.message }));
          }
        }
      } catch (e) {
        console.warn('[bipe] BIPE_ETAPA_SECUNDARIA_FALHOU', JSON.stringify({ bipeId: bipe.id, etapa: 'fallback_nfe_query', error: e.message }));
      }
    }

    const found = matched.length > 0;
    const duplicate = matched.length > 1;
    const chosen = found ? (matched.find((m) => m.product.active) || matched[0]) : null;

    // Snapshot do vendedor (se sellerId enviado e sellerName ausente)
    let sellerNameSnap = sellerName || null;
    if (sellerId && !sellerNameSnap) {
      try {
        const u = await prisma.user.findUnique({ where: { id: sellerId }, select: { name: true } });
        sellerNameSnap = u?.name || null;
      } catch (e) {
        console.warn('[bipe] BIPE_ETAPA_SECUNDARIA_FALHOU', JSON.stringify({ bipeId: bipe.id, etapa: 'lookup_seller', error: e.message }));
      }
    }

    // ========================================================================
    // PASSO 3: enriquece o bipe (update) — não é catastrófico se falhar
    // ========================================================================
    if (found || sellerNameSnap !== sellerName) {
      try {
        await prisma.stocktakeBipe.update({
          where: { id: bipe.id },
          data: {
            sellerName: sellerNameSnap,
            productId: chosen?.product.id || null,
            productSizeId: chosen?.id || null,
            productName: chosen?.product.name || null,
            productSize: chosen?.size || null,
            productBrand: chosen?.product.brand || null,
            found,
            duplicate,
          },
        });
        console.log('[bipe] BIPE_ENRIQUECIDO', JSON.stringify({ bipeId: bipe.id, productId: chosen?.product.id || null, found }));
      } catch (e) {
        console.warn('[bipe] BIPE_ETAPA_SECUNDARIA_FALHOU', JSON.stringify({ bipeId: bipe.id, etapa: 'enriquecer_bipe', error: e.message }));
      }
    }

    if (!found) {
      console.log('[bipe] BIPE_PRODUTO_NAO_ENCONTRADO', JSON.stringify({ bipeId: bipe.id, barcode: code }));
    }

    // ========================================================================
    // PASSO 4: real-time StoreStock (já era protegido por try/catch local)
    // ========================================================================
    let appliedToStock = false;
    if (chosen && storeId && chosen.id) {
      try {
        await prisma.storeStock.upsert({
          where: { storeId_productSizeId: { storeId, productSizeId: chosen.id } },
          update: { stock: { increment: 1 } },
          create: { storeId, productSizeId: chosen.id, stock: 1 },
        });
        await prisma.stocktakeBipe.update({ where: { id: bipe.id }, data: { applied: true } });
        appliedToStock = true;
      } catch (e) {
        console.warn('[bipe] BIPE_ETAPA_SECUNDARIA_FALHOU', JSON.stringify({ bipeId: bipe.id, etapa: 'storestock_upsert', error: e.message }));
      }
    }

    // Regra Adidas (dono 2026-06-10): tamanho não-confirmado → frontend pede o número da caixa.
    // As opções vêm da FAIXA escrita no item (dono 2026-06-11): só os tamanhos daquele produto.
    const needsSizeResp = chosen ? needsManualSize(chosen.product.brand, chosen) : false;
    const sizeOptionsResp = needsSizeResp ? await sizeOptionsForBipe(chosen.product.name, code) : null;

    res.json({
      success: true,
      bipeId: bipe.id,
      appliedToStock,
      found,
      duplicate,
      needsSize: needsSizeResp,
      sizeOptions: sizeOptionsResp || undefined,
      product: chosen
        ? {
            name: chosen.product.name,
            brand: chosen.product.brand,
            size: chosen.size,
            sku: chosen.product.sku,
            imageUrl: chosen.product.imageUrl,
            active: chosen.product.active,
          }
        : null,
      candidates: duplicate ? matched.map((m) => ({ name: m.product.name, size: m.size, sku: m.product.sku, active: m.product.active })) : undefined,
    });
  } catch (err) {
    console.error('[bipe] BIPE_ERRO', JSON.stringify({ error: err.message }));
    res.status(500).json({ error: err.message, retry: true });
  }
});

// POST /api/stocktake/bipe/:id/size (PÚBLICO) — vendedor informa o TAMANHO lido na CAIXA física.
// Regra Adidas (dono 2026-06-10): a NFe não traz tamanho por código → ao bipar Adidas
// com tamanho placeholder a tela pede o número da caixa. Aqui ele é gravado.
// Proteções: só preenche PLACEHOLDER (nunca sobrescreve tamanho real já confirmado);
// valida formato plausível; recusa tamanho que já existe noutro código do mesmo card.
router.post('/bipe/:id/size', async (req, res) => {
  try {
    const size = normalizeManualSize(req.body?.size);
    if (!size) {
      return res.status(400).json({ error: 'Tamanho inválido. Use número (ex: 41, 38.5), letra (P, M, G, GG) ou idade (8A).' });
    }
    const bipe = await prisma.stocktakeBipe.findUnique({ where: { id: req.params.id } });
    if (!bipe) return res.status(404).json({ error: 'Bipe não encontrado' });
    if (!bipe.productSizeId) return res.status(400).json({ error: 'Bipe sem produto vinculado — bipe de novo' });

    const ps = await prisma.productSize.findUnique({
      where: { id: bipe.productSizeId },
      select: { id: true, size: true, barcode: true, productId: true, sizeConfirmedAt: true },
    });
    if (!ps) return res.status(404).json({ error: 'Tamanho do produto não existe mais' });

    // Já confirmado por CAIXA antes (1 código = 1 tamanho, pra sempre). Não sobrescreve.
    if (ps.sizeConfirmedAt && !isPlaceholderSize(ps.size)) {
      return res.json({ ok: true, size: ps.size, alreadySet: true });
    }

    // Conflito: o MESMO card já tem esse tamanho noutro código.
    // CAIXA VENCE CHUTE (dono 2026-06-10: "eu nao tenho autonomia pra escolher o tamanho"):
    //   - se o ocupante NUNCA foi confirmado por caixa (chute de importação) → REMANEJA:
    //     ocupante volta pra placeholder (vai pedir tamanho quando for bipado) e o
    //     código bipado AGORA (caixa na mão) fica com o número.
    //   - se o ocupante FOI confirmado por caixa → conflito real entre 2 leituras → 409.
    const clash = await prisma.productSize.findFirst({
      where: { productId: ps.productId, size, NOT: { id: ps.id } },
      select: { id: true, barcode: true, sizeConfirmedAt: true },
    });

    if (clash && clash.sizeConfirmedAt) {
      console.warn('[bipe] SIZE_CONFLITO_CONFIRMADO', JSON.stringify({ bipeId: bipe.id, productId: ps.productId, size, barcodeNovo: ps.barcode, barcodeJaTem: clash.barcode }));
      return res.status(409).json({ error: `O tamanho ${size} já foi CONFIRMADO em outro código deste produto. Confira o número na caixa — se a caixa diz ${size} mesmo, avise o admin.`, conflict: true });
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      if (clash) {
        // chute do ocupante → placeholder único ('T-<barcode>'; sem barcode usa o id)
        const ph = 'T-' + (clash.barcode || clash.id.slice(0, 12));
        await tx.productSize.update({ where: { id: clash.id }, data: { size: ph, sizeConfirmedAt: null } });
        await tx.stocktakeBipe.updateMany({ where: { productSizeId: clash.id }, data: { productSize: ph } });
        console.log('[bipe] SIZE_REMANEJADO_CHUTE', JSON.stringify({ productId: ps.productId, size, deBarcode: clash.barcode, paraBarcode: ps.barcode }));
      }
      await tx.productSize.update({ where: { id: ps.id }, data: { size, sizeConfirmedAt: now } });
      // Snapshot de TODOS os bipes desse código fica consistente na revisão do admin
      await tx.stocktakeBipe.updateMany({ where: { productSizeId: ps.id }, data: { productSize: size } });
    });
    console.log('[bipe] SIZE_MANUAL_GRAVADO', JSON.stringify({ bipeId: bipe.id, productSizeId: ps.id, barcode: ps.barcode, size, remanejou: !!clash }));
    res.json({ ok: true, size, moved: !!clash });
  } catch (e) {
    console.error('[bipe] SIZE_MANUAL_ERRO', JSON.stringify({ error: e.message }));
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stocktake/lookup/:barcode (PÚBLICO) — só CONSULTA se o código é reconhecido (NÃO grava bipe)
router.get('/lookup/:barcode', async (req, res) => {
  try {
    const code = String(req.params.barcode || '').trim();
    if (!code) return res.status(400).json({ error: 'barcode vazio' });
    const sizes = await prisma.productSize.findMany({ where: { barcode: { in: barcodeVariants(code) } }, include: { product: { select: { id: true, name: true, brand: true, active: true, price: true, promoPrice: true } } }, take: 5 });
    const active = sizes.filter((s) => s.product && s.product.active);
    if (active.length) {
      const s = active[0];
      return res.json({ recognized: true, ambiguous: active.length > 1, product: { id: s.product.id, name: s.product.name, brand: s.product.brand, size: s.size, price: s.product.price, promoPrice: s.product.promoPrice } });
    }
    const x = await prisma.xmlFiscalItem.findFirst({ where: { ean: code }, select: { id: true, description: true } });
    res.json({ recognized: false, inNfe: !!x, nfeDescription: x ? x.description : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stocktake/capture (PÚBLICO) — equipe bate foto de produto NÃO reconhecido.
// FormData: barcode?, storeId?, sellerId?, sellerName?, note?, bipeId?, files[] (1-4 fotos)
router.post('/capture',
  (req, res, next) => captureUpload.array('files', 4)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    try {
      const { barcode, storeId, sellerId, sellerName, note, bipeId } = req.body || {};
      const files = req.files || [];
      if (!files.length && !barcode) return res.status(400).json({ error: 'mande ao menos uma foto ou o código' });
      const shots = [];
      for (const f of files.slice(0, 4)) { try { shots.push(await shrinkPhoto(f.buffer)); } catch (_) {} }
      const cap = await prisma.productCapture.create({ data: {
        barcode: barcode ? String(barcode).trim() : null,
        storeId: storeId || null, sellerId: sellerId || null, sellerName: sellerName ? String(sellerName).slice(0, 80) : null,
        note: note ? String(note).slice(0, 500) : null,
        photo: shots[0] || null, photos: shots.length > 1 ? shots.slice(1) : undefined,
        bipeId: bipeId || null, status: 'pendente',
      } });
      res.json({ ok: true, id: cap.id, fotos: shots.length });
    } catch (e) { console.error('[capture] erro:', e.message); res.status(500).json({ error: e.message }); }
  }
);

// POST /api/stocktake/etiqueta (PÚBLICO) — modo scanner de etiquetas (Nike/FIBER: o de-para código↔produto
// só existe na etiqueta física). FLUXO: salva a foto e responde {salvo:true} NA HORA (a pessoa segue pro
// próximo produto); o reconhecimento (visão) + vínculo rodam em BACKGROUND e o front consulta /etiqueta-status.
//   a) sku lido casa ProductSize.barcode (cProd, ex FIBER) -> barcode vira o EAN + bipes órfãos casam + StoreStock
//   b) ean já existe em ProductSize -> religa bipes órfãos
//   c) nome lido casa EXATAMENTE 1 card ativo -> vincula (cria tamanho stock=0; 2+ candidatos = pendente)
async function processarEtiqueta(capId, photo, eanLocal, meta) {
  let lido = null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const b64 = photo.split(',')[1];
    const r = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: b64 } },
      { type: 'text', text: 'Etiqueta/caixa de produto esportivo. REGRA: se houver MAIS DE UMA etiqueta/produto na foto, considere SOMENTE a mais CENTRALIZADA/em destaque — ignore as de canto/fundo. Extraia SÓ JSON: {"ean":"dígitos impressos no código de barras (12-14) ou null","sku":"código/SKU em texto (ex PABFBR-BLACK, CALBFBR-ALLBLACK-M, MEIAIIF-BLACK-P, DH3162 101) ou null","nome":"nome do produto ou null","tamanho":"tamanho BR/letra visível ou null"}. Copie LITERAL, não invente.' },
    ] }] });
    const t = (r.content.find((c) => c.type === 'text') || {}).text || '';
    const m = t.match(/\{[\s\S]*\}/);
    if (m) lido = JSON.parse(m[0]);
  } catch (e) { console.warn('[etiqueta] visão falhou:', e.message); }

  let ean = eanLocal || null;
  let eanVisaoRejeitado = false;
  if (!ean && lido && lido.ean) {
    const cand = String(lido.ean).replace(/\D/g, '');
    if (cand.length >= 8) {
      const variants = [cand, cand.replace(/^0+/, ''), '0' + cand];
      const conhece = (await prisma.stocktakeBipe.count({ where: { barcode: { in: variants } } }))
        || (await prisma.xmlFiscalItem.count({ where: { ean: { in: variants } } }))
        || (await prisma.productSize.count({ where: { barcode: { in: variants } } }));
      if (conhece) ean = cand; else eanVisaoRejeitado = true;
    }
  }
  const sku = lido && lido.sku ? String(lido.sku).trim().toUpperCase() : null;
  let vinculado = false, bipesCasados = 0, cardNome = null, matchedProductId = null, psId = null;

  if (sku) {
    const ps = await prisma.productSize.findFirst({ where: { barcode: sku }, select: { id: true, productId: true, product: { select: { name: true } } } });
    if (ps) { psId = ps.id; matchedProductId = ps.productId; cardNome = ps.product.name; if (ean) await prisma.productSize.update({ where: { id: ps.id }, data: { barcode: ean } }).catch(() => {}); vinculado = true; }
  }
  if (!vinculado && ean) {
    const variants = [ean, ean.replace(/^0+/, ''), '0' + ean];
    const ps = await prisma.productSize.findFirst({ where: { barcode: { in: variants } }, select: { id: true, productId: true, product: { select: { name: true } } } });
    if (ps) { psId = ps.id; matchedProductId = ps.productId; cardNome = ps.product.name; vinculado = true; }
  }
  if (!vinculado && ean && lido && lido.nome) {
    const tokens = String(lido.nome).toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length > 2 && !['NIKE', 'TENIS', 'THE'].includes(t));
    if (tokens.length >= 2) {
      const cands = await prisma.product.findMany({ where: { active: true, AND: tokens.map((t) => ({ name: { contains: t, mode: 'insensitive' } })) }, select: { id: true, name: true, sizes: { select: { id: true, size: true, barcode: true } } }, take: 3 });
      if (cands.length === 1) {
        const card = cands[0];
        const tamLido = lido.tamanho ? String(lido.tamanho).replace(/[^0-9A-Z]/gi, '').replace(/^BR/i, '') : null;
        let ps = card.sizes.find((s) => s.barcode === ean)
          || (tamLido ? card.sizes.find((s) => String(s.size) === tamLido && (!s.barcode || /GTIN/i.test(String(s.barcode)))) : null);
        if (!ps && tamLido) ps = await prisma.productSize.create({ data: { productId: card.id, barcode: ean, size: tamLido, stock: 0 } }).catch(() => null);
        else if (ps && ps.barcode !== ean) await prisma.productSize.update({ where: { id: ps.id }, data: { barcode: ean, ...(tamLido ? { size: tamLido } : {}) } }).catch(() => {});
        if (ps) { psId = ps.id; matchedProductId = card.id; cardNome = card.name; vinculado = true; }
      }
    }
  }
  if (vinculado && ean && psId) {
    const upd = await prisma.stocktakeBipe.updateMany({ where: { barcode: ean }, data: { productId: matchedProductId, productSizeId: psId, found: true, applied: true } });
    bipesCasados = upd.count;
    const bipes = await prisma.stocktakeBipe.findMany({ where: { barcode: ean }, select: { storeId: true } });
    const cnt = {}; for (const b of bipes) if (b.storeId) cnt[b.storeId] = (cnt[b.storeId] || 0) + 1;
    const old = await prisma.storeStock.findMany({ where: { productSizeId: psId }, select: { id: true } });
    for (const o of old) await prisma.storeStock.delete({ where: { id: o.id } }).catch(() => {});
    for (const [st, n] of Object.entries(cnt)) await prisma.storeStock.create({ data: { productSizeId: psId, storeId: st, stock: n } }).catch(() => {});
  }
  const mensagem = vinculado
    ? '✓ ' + (cardNome || '').slice(0, 60) + (bipesCasados ? ' — ' + bipesCasados + ' bipe(s) casaram' : ' — vinculado')
    : (eanVisaoRejeitado
        ? '⚠ Li "' + ((lido && (lido.nome || lido.sku)) || '?') + '" mas o código saiu duvidoso — refotografa focando o código de barras GRANDE'
        : (lido && (lido.sku || lido.ean || lido.nome) ? '📥 Li "' + (lido.sku || lido.nome || lido.ean) + '" — guardada pra vincular' : '📥 Foto guardada — não li a etiqueta, vai pra conferência'));
  await prisma.productCapture.update({ where: { id: capId }, data: {
    barcode: ean || null,
    note: ('etiqueta ' + mensagem + ' ' + JSON.stringify(lido || {})).slice(0, 480),
    status: vinculado ? 'vinculado' : 'pendente',
    matchedProductId: matchedProductId || null,
    resolvedAt: new Date(),
  } }).catch((e) => console.warn('[etiqueta] update captura:', e.message));
  return { vinculado, mensagem };
}

router.post('/etiqueta',
  (req, res, next) => captureUpload.single('file')(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next())),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'sem foto' });
      const { storeId, sellerId, sellerName, eanLocal } = req.body || {};
      const photo = await shrinkPhoto(req.file.buffer);
      const eanCam = eanLocal ? String(eanLocal).replace(/\D/g, '') : null;
      // O SCANNER TAMBÉM É CONTAGEM (dono 2026-06-11: equipe usa o scanner no lugar do bipe).
      // Código lido pela câmera => registra StocktakeBipe igual ao bipe normal: achou card -> conta no físico;
      // não achou -> órfão (casa sozinho quando a etiqueta for vinculada).
      let bipeId = null;
      if (eanCam && eanCam.length >= 8) {
        try {
          const variants = [eanCam, eanCam.replace(/^0+/, ''), '0' + eanCam];
          const ps = await prisma.productSize.findFirst({ where: { barcode: { in: variants } }, select: { id: true, productId: true, size: true, product: { select: { name: true, brand: true } } } });
          const bipe = await prisma.stocktakeBipe.create({ data: {
            barcode: eanCam, storeId: storeId || null, sellerId: sellerId || null,
            sellerName: sellerName ? String(sellerName).slice(0, 80) : null,
            productId: ps ? ps.productId : null, productSizeId: ps ? ps.id : null,
            productName: ps ? ps.product.name : null, productSize: ps ? ps.size : null, productBrand: ps ? ps.product.brand : null,
            found: !!ps, applied: !!ps,
            ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || null,
            userAgent: 'scanner-etiqueta',
          } });
          bipeId = bipe.id;
          if (ps && storeId) {
            const ex = await prisma.storeStock.findFirst({ where: { productSizeId: ps.id, storeId }, select: { id: true, stock: true } });
            if (ex) await prisma.storeStock.update({ where: { id: ex.id }, data: { stock: (ex.stock || 0) + 1 } });
            else await prisma.storeStock.create({ data: { productSizeId: ps.id, storeId, stock: 1 } });
          }
        } catch (e) { console.warn('[etiqueta] bipe do scanner falhou:', e.message); }
      }
      const cap = await prisma.productCapture.create({ data: {
        barcode: eanCam,
        storeId: storeId || null, sellerId: sellerId || null,
        sellerName: sellerName ? String(sellerName).slice(0, 80) : null,
        note: 'etiqueta processando…', photo, status: 'processando', bipeId,
      } });
      // responde JÁ — a pessoa segue pro próximo produto; reconhecimento roda em background
      res.json({ ok: true, salvo: true, capId: cap.id, bipou: !!bipeId });
      setImmediate(() => processarEtiqueta(cap.id, photo, eanLocal ? String(eanLocal).replace(/\D/g, '') : null, {})
        .catch((e) => { console.error('[etiqueta] processar:', e.message); prisma.productCapture.update({ where: { id: cap.id }, data: { status: 'pendente', note: 'etiqueta erro-processamento' } }).catch(() => {}); }));
    } catch (e) { console.error('[etiqueta] erro:', e.message); res.status(500).json({ error: e.message }); }
  }
);

// TRATADOR CONTÍNUO (dono 2026-06-11: "todos os scanner já vá automaticamente pro card e seja tratado").
// A cada 10min re-tenta vincular as capturas pendentes: SKU lido ↔ linha do card ↔ cProd da NFe ↔ nome único.
// Pendente sem destino = produto sem NFe importada; quando a nota entrar, casa sozinho na próxima rodada.
async function tratarPendentesEtiqueta() {
  try {
    const caps = await prisma.productCapture.findMany({ where: { status: 'pendente' }, select: { id: true, note: true, barcode: true }, take: 300 });
    let vinc = 0;
    for (const c of caps) {
      const m = String(c.note || '').match(/\{[\s\S]*\}/);
      let lido = null; try { lido = m ? JSON.parse(m[0]) : null; } catch (_) {}
      const sku = lido && lido.sku ? String(lido.sku).trim().toUpperCase() : null;
      const nome = lido && lido.nome ? String(lido.nome).trim() : null;
      let pid = null, psId = null;
      if (sku) { const ps = await prisma.productSize.findFirst({ where: { barcode: sku }, select: { id: true, productId: true } }); if (ps) { pid = ps.productId; psId = ps.id; } }
      if (!pid && sku) {
        const it = await prisma.xmlFiscalItem.findFirst({ where: { supplierCode: sku, productId: { not: null }, fiscalDocument: { docType: 'entrada' } }, select: { productId: true, ean: true } });
        if (it) {
          pid = it.productId;
          const tam = (sku.match(/[-.]?(PP|P|M|G|GG|XG|U|\d{2})$/i) || [])[1];
          const bc = (it.ean && it.ean !== 'SEM GTIN') ? it.ean : sku;
          let ps = await prisma.productSize.findFirst({ where: { productId: pid, barcode: bc }, select: { id: true } });
          if (!ps && tam) ps = await prisma.productSize.create({ data: { productId: pid, barcode: bc, size: tam, stock: 0 } }).catch(() => null);
          if (ps) psId = ps.id;
        }
      }
      if (!pid && nome) {
        const tokens = nome.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length > 2 && !['NIKE', 'TENIS', 'THE'].includes(t));
        if (tokens.length >= 2) {
          const cands = await prisma.product.findMany({ where: { active: true, AND: tokens.map((t) => ({ name: { contains: t, mode: 'insensitive' } })) }, select: { id: true }, take: 2 });
          if (cands.length === 1) pid = cands[0].id;
        }
      }
      // AUTO-CRIAR (dono 2026-06-11: "todas automaticamente"): com SKU ou EAN lido e sem destino,
      // o card nasce do scanner (1 card por sku-base; comprado=0 — não inventa compra; categoria A CLASSIFICAR).
      if (!pid && (sku || (c.barcode && /^\d{8,14}$/.test(c.barcode)))) {
        const ean2 = c.barcode && /^\d{8,14}$/.test(c.barcode) ? c.barcode : null;
        const sizeDoSku = (s) => { let mm = String(s).match(/[-.](3[3-9]|4[0-8])$/); if (mm) return mm[1]; mm = String(s).match(/[-.](PP|P|M|G|GG|XG|XGG)$/i); return mm ? mm[1].toUpperCase() : null; };
        const base = sku ? (sizeDoSku(sku) ? sku.replace(new RegExp('[-.]' + sizeDoSku(sku) + '$', 'i'), '') : sku) : ('EAN-' + ean2);
        const ex2 = await prisma.product.findFirst({ where: { OR: [{ sku: base }, { aiContext: { path: ['supplierRef'], equals: base } }] }, select: { id: true } });
        if (ex2) pid = ex2.id;
        else {
          const MARCAS = ['NIKE', 'ADIDAS', 'KENNER', 'FIBER', 'PUMA', 'MIZUNO', 'OLYMPIKUS', 'FILA', 'UMBRO', 'ASICS', 'REEBOK', 'OAKLEY', 'MORMAII', 'DILLY', 'OUS', 'CONVERSE'];
          const marca = MARCAS.find((x) => (nome || '').toUpperCase().includes(x)) || 'A DEFINIR';
          let skuCard = base, n2 = 1; while (await prisma.product.findFirst({ where: { sku: skuCard }, select: { id: true } })) { n2++; skuCard = base + '-' + n2; }
          const np = await prisma.product.create({ data: { sku: skuCard, name: ((nome ? nome.toUpperCase() + ' ' : 'PRODUTO ') + 'REF ' + base).slice(0, 120), brand: marca, category: 'A CLASSIFICAR', price: 0, active: true, source: 'scanner-auto', aiContext: { supplierRef: base, scannerAuto: true, photoPending: true } }, select: { id: true } }).catch(() => null);
          if (np) pid = np.id;
        }
        if (pid) {
          const bc2 = ean2 || sku;
          const tam2 = (sku && sizeDoSku(sku)) || (lido && lido.tamanho ? String(lido.tamanho).replace(/[^0-9A-Z]/gi, '').replace(/^BR/i, '') : null);
          let ps2 = await prisma.productSize.findFirst({ where: { barcode: bc2 }, select: { id: true } });
          if (!ps2) ps2 = await prisma.productSize.create({ data: { productId: pid, barcode: bc2, size: tam2 || ('T-' + String(bc2).slice(-6)), stock: 0 } }).catch(() => null);
          if (ps2) psId = ps2.id;
        }
      }
      if (!pid) continue;
      await prisma.productCapture.update({ where: { id: c.id }, data: { status: 'vinculado', matchedProductId: pid, note: (String(c.note || '').replace(/^etiqueta\s*📥?/, 'etiqueta ✓') + ' [auto]').slice(0, 400) } });
      if (c.barcode && psId) {
        await prisma.stocktakeBipe.updateMany({ where: { barcode: c.barcode }, data: { productId: pid, productSizeId: psId, found: true, applied: true } });
        const bipes = await prisma.stocktakeBipe.findMany({ where: { barcode: c.barcode }, select: { storeId: true } });
        const cnt = {}; for (const b of bipes) if (b.storeId) cnt[b.storeId] = (cnt[b.storeId] || 0) + 1;
        const old = await prisma.storeStock.findMany({ where: { productSizeId: psId }, select: { id: true } });
        for (const o of old) await prisma.storeStock.delete({ where: { id: o.id } }).catch(() => {});
        for (const [st, n] of Object.entries(cnt)) await prisma.storeStock.create({ data: { productSizeId: psId, storeId: st, stock: n } }).catch(() => {});
      }
      vinc++;
    }
    if (vinc) console.log('[etiqueta-cron] vinculadas automaticamente: ' + vinc);
  } catch (e) { console.warn('[etiqueta-cron] erro:', e.message); }
}
setInterval(tratarPendentesEtiqueta, 10 * 60 * 1000);
setTimeout(tratarPendentesEtiqueta, 90 * 1000); // 1ª rodada após o boot

// GET /api/stocktake/etiqueta-status?ids=a,b,c (PÚBLICO) — front consulta o resultado do reconhecimento
router.get('/etiqueta-status', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 40);
    if (!ids.length) return res.json({ rows: [] });
    const rows = await prisma.productCapture.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, note: true } });
    res.json({ rows: rows.map((r) => ({ id: r.id, status: r.status, mensagem: String(r.note || '').replace(/^etiqueta\s*/, '').replace(/\s*\{.*$/, '').trim() })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============== ADMIN ==============

router.use(authMiddleware, adminMiddleware);

// GET /api/stocktake/unrecognized — bipes NÃO reconhecidos agrupados por código (pra recontagem)
router.get('/unrecognized', async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT b.barcode,
        count(*)::int vezes,
        max(b."bipedAt") ultimo,
        array_agg(DISTINCT COALESCE(s.name,'(sem loja)')) lojas,
        bool_or(EXISTS(SELECT 1 FROM "XmlFiscalItem" x WHERE ltrim(x.ean,'0')=ltrim(b.barcode,'0'))) em_nfe,
        bool_or(EXISTS(SELECT 1 FROM "ProductSize" z JOIN "Product" pr ON pr.id=z."productId" WHERE ltrim(z.barcode,'0')=ltrim(b.barcode,'0') AND pr.active)) tem_card,
        bool_or(EXISTS(SELECT 1 FROM "ProductCapture" c WHERE c.barcode=b.barcode)) tem_foto
      FROM "StocktakeBipe" b
      LEFT JOIN "Store" s ON s.id=b."storeId"
      WHERE b.found=false
      GROUP BY b.barcode
      ORDER BY vezes DESC, ultimo DESC
      LIMIT 1500`);
    res.json({ total: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stocktake/captures?status=pendente — fila de fotos de conferência
router.get('/captures', async (req, res) => {
  try {
    const status = req.query.status || 'pendente';
    const caps = await prisma.productCapture.findMany({ where: status === 'all' ? {} : { status }, orderBy: { createdAt: 'desc' }, take: 300 });
    const storeIds = [...new Set(caps.map((c) => c.storeId).filter(Boolean))];
    const stores = storeIds.length ? await prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } }) : [];
    const sm = Object.fromEntries(stores.map((s) => [s.id, s.name]));
    // marca se o barcode existe em NFe (recuperável automático)
    const out = [];
    for (const c of caps) {
      let emNfe = false;
      if (c.barcode) { const x = await prisma.xmlFiscalItem.findFirst({ where: { ean: { in: barcodeVariants(c.barcode) } }, select: { id: true } }); emNfe = !!x; }
      out.push({ ...c, storeName: sm[c.storeId] || null, emNfe });
    }
    res.json({ total: caps.length, captures: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stocktake/captures/:id/resolve { status, matchedProductId?, createdProductId?, note? }
router.post('/captures/:id/resolve', async (req, res) => {
  try {
    const { status, matchedProductId, createdProductId, note } = req.body || {};
    const ok = ['pendente', 'em_nfe', 'vinculado', 'criado', 'descartado'];
    if (status && !ok.includes(status)) return res.status(400).json({ error: 'status inválido' });
    const data = {};
    if (status) { data.status = status; if (status !== 'pendente') data.resolvedAt = new Date(); }
    if (matchedProductId !== undefined) data.matchedProductId = matchedProductId || null;
    if (createdProductId !== undefined) data.createdProductId = createdProductId || null;
    if (note !== undefined) data.note = note ? String(note).slice(0, 500) : null;
    const cap = await prisma.productCapture.update({ where: { id: req.params.id }, data });
    res.json({ ok: true, capture: { id: cap.id, status: cap.status } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stocktake/located-product-ids?minPct=&maxPct= → productIds com localizado/comprado na faixa
router.get('/located-product-ids', async (req, res) => {
  try {
    const minPct = Math.max(0, Math.min(100000, Number(req.query.minPct) || 0));
    const maxPct = Math.max(minPct, Math.min(100000, Number(req.query.maxPct) || 100000));
    const rows = await prisma.$queryRawUnsafe(`
      WITH ps AS (SELECT "productId", SUM(stock) c FROM "ProductSize" GROUP BY "productId"),
      loc AS (SELECT pz."productId", SUM(ss.stock) l FROM "StoreStock" ss JOIN "ProductSize" pz ON pz.id=ss."productSizeId" GROUP BY pz."productId")
      SELECT ps."productId" id FROM ps LEFT JOIN loc ON loc."productId"=ps."productId"
      WHERE ps.c>0 AND round(COALESCE(loc.l,0)::numeric*100/ps.c) >= ${minPct} AND round(COALESCE(loc.l,0)::numeric*100/ps.c) <= ${maxPct}`);
    res.json({ productIds: rows.map((r) => r.id), total: rows.length, minPct, maxPct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stocktake/biped-product-ids
// Retorna lista única de productIds que já apareceram em bipes (com found=true)
// Usado pelo card de classificação pra filtrar só produtos que foram bipados.
router.get('/biped-product-ids', async (req, res) => {
  try {
    const { storeId, days } = req.query;
    const where = { productId: { not: null }, found: true };
    if (storeId) where.storeId = String(storeId);
    if (days && /^\d+$/.test(String(days))) {
      const since = new Date(Date.now() - parseInt(days, 10) * 86400000);
      where.bipedAt = { gte: since };
    }
    const rows = await prisma.stocktakeBipe.findMany({
      where,
      select: { productId: true },
      distinct: ['productId'],
    });
    const productIds = rows.map(r => r.productId).filter(Boolean);
    res.json({ productIds, total: productIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stocktake/bipes?storeId=&sellerId=&dateFrom=&dateTo=&applied=&found=&today=1&limit=
router.get('/bipes', async (req, res) => {
  try {
    const { storeId, sellerId, sellerName, dateFrom, dateTo, applied, found, today, limit } = req.query;
    const where = {};
    if (storeId) where.storeId = String(storeId);
    if (sellerId) where.sellerId = String(sellerId);
    if (sellerName) where.sellerName = String(sellerName);
    if (applied === 'true') where.applied = true;
    if (applied === 'false') where.applied = false;
    if (found === 'true') where.found = true;
    if (found === 'false') where.found = false;
    if (today === '1') {
      // hoje pela timezone America/Fortaleza
      const r = await prisma.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')::timestamp AS today`;
      where.bipedAt = { gte: r[0].today };
    } else if (dateFrom || dateTo) {
      where.bipedAt = {};
      if (dateFrom) where.bipedAt.gte = new Date(dateFrom);
      if (dateTo) where.bipedAt.lte = new Date(dateTo);
    }
    const bipes = await prisma.stocktakeBipe.findMany({
      where,
      orderBy: { bipedAt: 'desc' },
      take: Math.min(parseInt(limit, 10) || 500, 5000),
    });
    res.json({ bipes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stocktake/summary?date=YYYY-MM-DD → contagem total + dia + por vendedor
// (sem ?date usa hoje no fuso America/Fortaleza)
router.get('/summary', async (req, res) => {
  try {
    let dayStart, dayEnd;
    if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date))) {
      // Range exato do dia escolhido em UTC-3 (Fortaleza)
      dayStart = new Date(req.query.date + 'T00:00:00-03:00');
      dayEnd = new Date(req.query.date + 'T23:59:59.999-03:00');
    } else {
      const r = await prisma.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')::timestamp AS today, (DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza') + INTERVAL '1 day' - INTERVAL '1 millisecond')::timestamp AS end_today`;
      dayStart = r[0].today;
      dayEnd = r[0].end_today;
    }

    const dayWhere = { bipedAt: { gte: dayStart, lte: dayEnd } };

    const [total, totalDay, foundDay, notFoundDay, sellerGroupsDay, storeGroupsDay] = await Promise.all([
      prisma.stocktakeBipe.count(),
      prisma.stocktakeBipe.count({ where: dayWhere }),
      prisma.stocktakeBipe.count({ where: { ...dayWhere, found: true } }),
      prisma.stocktakeBipe.count({ where: { ...dayWhere, found: false } }),
      prisma.stocktakeBipe.groupBy({
        by: ['sellerId', 'sellerName'],
        where: dayWhere,
        _count: { id: true },
      }),
      prisma.stocktakeBipe.groupBy({
        by: ['storeId'],
        where: dayWhere,
        _count: { id: true },
      }),
    ]);

    // Hidrata nome da loja — TODAS as ativas (mesmo as sem bipe)
    const stores = await prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true, code: true },
      orderBy: { code: 'asc' },
    });
    const storeMap = Object.fromEntries(stores.map((s) => [s.id, s]));

    // Mapa dos grupos que tiveram bipe (acesso O(1))
    const groupedById = {};
    storeGroupsDay.forEach(g => { groupedById[g.storeId || 'NULL'] = g._count.id; });

    // Loop por TODAS as lojas ativas (lista completa)
    const byStoreWithFound = [];
    for (const store of stores) {
      const where = { ...dayWhere, storeId: store.id };
      const [f, nf, total] = await Promise.all([
        prisma.stocktakeBipe.count({ where: { ...where, found: true } }),
        prisma.stocktakeBipe.count({ where: { ...where, found: false } }),
        prisma.stocktakeBipe.count({ where }),
      ]);
      byStoreWithFound.push({
        id: store.id,
        name: store.name,
        code: store.code,
        total,
        found: f,
        notFound: nf,
      });
    }
    // Bipes sem storeId (vendedor não escolheu loja)
    const semLojaCount = groupedById['NULL'] || 0;
    if (semLojaCount > 0) {
      const where = { ...dayWhere, storeId: null };
      const [f, nf] = await Promise.all([
        prisma.stocktakeBipe.count({ where: { ...where, found: true } }),
        prisma.stocktakeBipe.count({ where: { ...where, found: false } }),
      ]);
      byStoreWithFound.push({
        id: null,
        name: '(sem loja selecionada)',
        code: '⚠️',
        total: semLojaCount,
        found: f,
        notFound: nf,
      });
    }
    // Ordena: mais bipes primeiro, depois alfabético
    byStoreWithFound.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    const bySellerWithFound = [];
    for (const g of sellerGroupsDay) {
      const where = { ...dayWhere, sellerId: g.sellerId, sellerName: g.sellerName };
      const [f, nf, storeBreak] = await Promise.all([
        prisma.stocktakeBipe.count({ where: { ...where, found: true } }),
        prisma.stocktakeBipe.count({ where: { ...where, found: false } }),
        prisma.stocktakeBipe.groupBy({ by: ['storeId'], where, _count: { id: true } }),
      ]);
      // Lojas onde esse vendedor bipou no dia
      const stores = storeBreak.map(s => ({
        id: s.storeId,
        name: storeMap[s.storeId]?.name || '(sem loja)',
        count: s._count.id,
      })).sort((a, b) => b.count - a.count);
      bySellerWithFound.push({
        id: g.sellerId,
        name: g.sellerName || '(sem nome)',
        total: g._count.id,
        found: f,
        notFound: nf,
        stores,
      });
    }
    bySellerWithFound.sort((a, b) => b.total - a.total);

    res.json({
      total,
      day: {
        total: totalDay,
        found: foundDay,
        notFound: notFoundDay,
        sellers: sellerGroupsDay.length,
        stores: storeGroupsDay.length,
      },
      // alias 'today' pra compat
      today: {
        total: totalDay,
        found: foundDay,
        notFound: notFoundDay,
        sellers: sellerGroupsDay.length,
      },
      byStore: byStoreWithFound,
      bySeller: bySellerWithFound,
    });
  } catch (err) {
    console.error('[stocktake/summary]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stocktake/apply-to-stock — aplica bipes no StoreStock
// Body opcional: { date: 'YYYY-MM-DD', storeId, sellerId, dryRun: true }
// Modo "Substituir": pra cada (productSize, store), conta TODOS os bipes
// found=true daquele dia/filtro e SOBRESCREVE o stock com esse número.
// Marca bipes como applied=true.
router.post('/apply-to-stock', async (req, res) => {
  try {
    const { date, storeId, sellerId, dryRun } = req.body || {};

    // Range do dia (default: hoje America/Fortaleza)
    let dayStart, dayEnd;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dayStart = new Date(date + 'T00:00:00-03:00');
      dayEnd = new Date(date + 'T23:59:59.999-03:00');
    } else {
      const r = await prisma.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')::timestamp AS today, (DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza') + INTERVAL '1 day' - INTERVAL '1 millisecond')::timestamp AS end_today`;
      dayStart = r[0].today; dayEnd = r[0].end_today;
    }

    const where = {
      bipedAt: { gte: dayStart, lte: dayEnd },
      found: true,
      applied: false,
      productSizeId: { not: null },
      storeId: { not: null },
    };
    if (storeId) where.storeId = String(storeId);
    if (sellerId) where.sellerId = String(sellerId);

    // Agrupa por (storeId, productSizeId) e conta os bipes
    const groups = await prisma.stocktakeBipe.groupBy({
      by: ['storeId', 'productSizeId'],
      where,
      _count: { id: true },
    });

    if (groups.length === 0) {
      return res.json({ ok: true, applied: 0, products: 0, bipes: 0, dryRun: !!dryRun, message: 'Sem bipes pra aplicar' });
    }

    // Pega produtos pra mostrar mudanças
    const sizeIds = [...new Set(groups.map(g => g.productSizeId))];
    const sizes = await prisma.productSize.findMany({
      where: { id: { in: sizeIds } },
      include: { product: { select: { id: true, name: true, brand: true, sku: true } } },
    });
    const sizeMap = Object.fromEntries(sizes.map(s => [s.id, s]));

    const storeIds = [...new Set(groups.map(g => g.storeId))];
    const stores = await prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true, code: true } });
    const storeMap = Object.fromEntries(stores.map(s => [s.id, s]));

    // Estoque atual pra calcular delta
    const currentStocks = await prisma.storeStock.findMany({
      where: {
        OR: groups.map(g => ({ storeId: g.storeId, productSizeId: g.productSizeId })),
      },
    });
    const currentMap = Object.fromEntries(currentStocks.map(s => [s.storeId + ':' + s.productSizeId, s.stock]));

    // Monta plano
    const plan = groups.map(g => {
      const key = g.storeId + ':' + g.productSizeId;
      const current = currentMap[key] || 0;
      const newStock = g._count.id;
      const size = sizeMap[g.productSizeId];
      const store = storeMap[g.storeId];
      return {
        storeId: g.storeId, storeName: store?.name, storeCode: store?.code,
        productSizeId: g.productSizeId, size: size?.size, productName: size?.product?.name,
        brand: size?.product?.brand, sku: size?.product?.sku,
        currentStock: current,
        newStock,
        delta: newStock - current,
        bipes: g._count.id,
      };
    });

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, plan, total: plan.length });
    }

    // EXECUTA: upsert StoreStock + marca bipes como applied
    let appliedStocks = 0;
    for (const item of plan) {
      await prisma.storeStock.upsert({
        where: { storeId_productSizeId: { storeId: item.storeId, productSizeId: item.productSizeId } },
        update: { stock: item.newStock },
        create: { storeId: item.storeId, productSizeId: item.productSizeId, stock: item.newStock },
      });
      appliedStocks++;
    }
    const upd = await prisma.stocktakeBipe.updateMany({ where, data: { applied: true } });

    res.json({
      ok: true,
      applied: appliedStocks,
      bipes: upd.count,
      products: new Set(plan.map(p => p.productSizeId)).size,
      stores: new Set(plan.map(p => p.storeId)).size,
      plan,
    });
  } catch (err) {
    console.error('[stocktake/apply-to-stock]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stocktake/bipes/:id → remove bipe (caso erro)
router.delete('/bipes/:id', async (req, res) => {
  try {
    await prisma.stocktakeBipe.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
