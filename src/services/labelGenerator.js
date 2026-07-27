// =====================================================================
// Label Generator — gera PDF de etiquetas usando pdfkit + bwip-js opcional
// =====================================================================
// Suporta: A4 (5x13, 3x10, 2x5, 2x2) e térmica (40x30, 50x30, 60x40, 100x50)
// Renderiza: nome do produto, marca, SKU, preço normal, preço promo, código de barras (texto), QR.
// Para evitar dependência extra de geração visual de barcode, desenha
// código como retângulos simples (CODE128-like estético) + texto legível
// embaixo. Para produção fiscal séria, integre bwip-js depois.
// =====================================================================

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { Buffer } = require('buffer');
const fs = require('fs');
const path = require('path');

const LABEL_FONT_REGULAR = path.join(__dirname, '../../node_modules/@expo-google-fonts/roboto/400Regular/Roboto_400Regular.ttf');
const LABEL_FONT_BOLD = path.join(__dirname, '../../node_modules/@expo-google-fonts/roboto/700Bold/Roboto_700Bold.ttf');

function registerLabelFonts(doc) {
  if (!fs.existsSync(LABEL_FONT_REGULAR) || !fs.existsSync(LABEL_FONT_BOLD)) return false;
  try {
    doc.registerFont('TenisRoboto', LABEL_FONT_REGULAR);
    doc.registerFont('TenisRobotoBold', LABEL_FONT_BOLD);
    return true;
  } catch {
    return false;
  }
}

const MM_TO_PT = 2.83464567; // 1mm = 2.83464567pt

function mm(x) { return x * MM_TO_PT; }

function isSTHorizontalTemplate(template) {
  const widthMm = Number(template?.widthMm);
  const heightMm = Number(template?.heightMm);
  return (widthMm === 145 && heightMm === 25)
    || (widthMm === 150 && heightMm === 30)
    || (widthMm === 130 && heightMm >= 14 && heightMm <= 27);
}

function isDuplexTemplate(template) {
  const config = template?.layoutConfig;
  return Boolean(config && typeof config === 'object' && config.duplex === true);
}

// O padrÃ£o 5x7 cm usa duas etiquetas fÃ­sicas por produto. Cada etiqueta
// tem frente e verso, portanto as quatro faces sÃ£o: marca, loja, dados e QR.
function isFourSideProductTemplate(template) {
  const config = template?.layoutConfig;
  return isDuplexTemplate(template) && Number(config?.labelsPerProduct || 1) === 2;
}

const FOUR_SIDE_ORANGE = '#FF3300'; // aproximaÃ§Ã£o RGB de CMYK C0 M80 Y100 K0
const FOUR_SIDE_ORANGE_CMYK = { c: 0, m: 80, y: 100, k: 0 };
const FOUR_SIDE_CUT_BORDER_MM = 0.8;

function defaultTemplates() {
  return {
    st_145x25: {
      type: 'PRODUCT',
      name: 'S&T Etiqueta 14,5x2,5cm (11 por A4)',
      paperSize: 'A4',
      widthMm: 145,
      heightMm: 25,
      columns: 1,
      rows: 11,
      marginTopMm: 11,
      marginLeftMm: 32.5,
      gapHorizontalMm: 0,
      gapVerticalMm: 0,
      legacyNames: [
        'S&T Etiqueta 15x3cm (9 por A4)',
        'S&T Etiqueta 13x2cm (13 por A4)',
        'S&T Etiqueta 13x1,5cm (18 por A4)',
      ],
    },
    a4_65: {
      type: 'PRODUCT',
      name: 'A4 65 etiquetas (5x13)',
      paperSize: 'A4',
      widthMm: 38.1,
      heightMm: 21.2,
      columns: 5,
      rows: 13,
      marginTopMm: 10.7,
      marginLeftMm: 4.7,
      gapHorizontalMm: 2.5,
      gapVerticalMm: 0,
    },
    a4_30: {
      type: 'PRICE',
      name: 'A4 30 etiquetas (3x10)',
      paperSize: 'A4',
      widthMm: 63.5,
      heightMm: 29.6,
      columns: 3,
      rows: 10,
      marginTopMm: 14.5,
      marginLeftMm: 7.0,
      gapHorizontalMm: 2.5,
      gapVerticalMm: 0,
    },
    a4_10_price: {
      type: 'PRICE',
      name: 'A4 10 etiquetas de preço (2x5)',
      paperSize: 'A4',
      widthMm: 99.0,
      heightMm: 57.0,
      columns: 2,
      rows: 5,
      marginTopMm: 10,
      marginLeftMm: 5,
      gapHorizontalMm: 3,
      gapVerticalMm: 3,
    },
    a4_16_5x7_duplex: {
      type: 'PRODUCT',
      name: 'A4 16 etiquetas (5x7 cm) — frente e verso',
      paperSize: 'A4',
      widthMm: 50,
      heightMm: 70,
      columns: 4,
      rows: 4,
      // 4×50mm = 200mm em 210mm; 4×70mm = 280mm em 297mm.
      marginTopMm: 8.5,
      marginLeftMm: 5,
      gapHorizontalMm: 0,
      gapVerticalMm: 0,
      layoutConfig: {
        duplex: true,
        duplexBinding: 'long-edge',
        backLayout: 'four-sides',
        labelsPerProduct: 2,
        sides: {
          frontA: 'brand',
          frontB: 'details',
          backA: 'store',
          backB: 'qr',
        },
        backgroundCmyk: FOUR_SIDE_ORANGE_CMYK,
        backgroundHex: FOUR_SIDE_ORANGE,
      },
    },
    a4_4_promo: {
      type: 'PROMOTIONAL',
      name: 'A4 4 placas promocionais (2x2)',
      paperSize: 'A4',
      widthMm: 99.0,
      heightMm: 140.0,
      columns: 2,
      rows: 2,
      marginTopMm: 10,
      marginLeftMm: 5,
      gapHorizontalMm: 3,
      gapVerticalMm: 5,
    },
    thermal_40x30: { type: 'PRODUCT', name: 'Térmica 40x30mm', paperSize: 'THERMAL', widthMm: 40, heightMm: 30, columns: 1, rows: 1 },
    thermal_50x30: { type: 'PRODUCT', name: 'Térmica 50x30mm', paperSize: 'THERMAL', widthMm: 50, heightMm: 30, columns: 1, rows: 1 },
    thermal_60x40: { type: 'PRODUCT', name: 'Térmica 60x40mm', paperSize: 'THERMAL', widthMm: 60, heightMm: 40, columns: 1, rows: 1 },
    thermal_100x50: { type: 'SHIPPING', name: 'Térmica 100x50mm', paperSize: 'THERMAL', widthMm: 100, heightMm: 50, columns: 1, rows: 1 },
  };
}

function fmtBRL(n) {
  if (n == null) return '';
  try {
    return Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  } catch {
    // Fallback se Intl falhar: formato manual com ponto de milhar
    const fixed = Number(n).toFixed(2);
    const [int, dec] = fixed.split('.');
    return 'R$ ' + int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec;
  }
}

// Renderiza algo que parece código de barras (visual). Para etiqueta real
// passe `realBars=true` futuramente quando integrarmos bwip-js.
function drawFakeBarcode(doc, value, x, y, w, h, options = {}) {
  const code = String(value || '').slice(0, 32);
  if (!code) return;
  const color = options.color || '#000';
  const usable = w;
  const barCount = Math.min(60, Math.max(20, code.length * 4));
  const barWidth = usable / barCount;
  doc.save();
  doc.fillColor(color);
  for (let i = 0; i < barCount; i++) {
    // Pseudo-aleatório determinístico do código
    const c = code.charCodeAt(i % code.length);
    const isBar = ((c + i * 7) % 3) !== 0;
    if (isBar) {
      doc.rect(x + i * barWidth, y, barWidth * 0.75, h * 0.75).fill();
    }
  }
  doc.restore();
  doc.fontSize(6).fillColor(color).text(code, x, y + h * 0.78, { width: usable, align: 'center' });
}

async function drawQR(doc, value, x, y, size) {
  const v = String(value || '').trim();
  if (!v) { console.warn('[drawQR] valor vazio, pulando'); return; }
  try {
    const dataUrl = await QRCode.toDataURL(v, {
      width: 1024,                 // resolução máxima pra impressão nítida
      margin: 4,                   // quiet zone = 4 módulos (padrão recomendado QR ISO)
      errorCorrectionLevel: 'H',   // 30% correção — tolerante a ruído de impressão
      color: { dark: '#000000', light: '#FFFFFF' },
    });
    const b64 = dataUrl.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
    doc.image(buf, x, y, { width: size, height: size });
  } catch (e) {
    console.error('[drawQR] erro gerando QR pra "' + v.slice(0, 60) + '":', e?.message);
  }
}

// ===== Layout HORIZONTAL S&T (150mm × 30mm; mantém legado 130mm) — FUNDO LARANJA =====
// Fundo: laranja (#E5571E) pintado em generateLabelsPDF antes desta função
// Texto: branco. Preço: branco bem grande. QR: card branco atrás pra contraste.
function drawLabelHorizontal(doc, item, template, x, y, w, h) {
  const WHITE = '#FFFFFF';
  const padX = mm(1.5);
  // Card branco ocupa quase toda altura, com 0.5mm de gap das bordas da etiqueta
  const cardGap = mm(0.5);
  const qrCardSize = Math.min(mm(27), h - cardGap * 2);
  const qrCardX = x + w - qrCardSize - mm(0.5);
  const qrCardY = y + (h - qrCardSize) / 2;
  // QR ocupa o card todo (qrCode já tem margin:4 internos = quiet zone)
  const qrSize = qrCardSize;
  const qrX = qrCardX;
  const qrY = qrCardY;

  // Zona do preço — destaque grande, branco bold (espaço aumentado pra caber "R$ 1.999,99")
  const priceW = mm(42);
  const priceX = qrCardX - priceW - mm(1);
  const textW = priceX - x - padX - mm(1);

  const isTall = h >= mm(18);

  // Helper: trunca string respeitando limite de chars (com … no fim)
  const truncate = (s, max) => {
    const t = String(s || '');
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };

  // Helper: mede altura real de um texto multilinha (em pontos)
  const measureBlock = (text, fs, font, maxW) => {
    doc.font(font).fontSize(fs);
    const w = doc.widthOfString(text);
    const lines = Math.max(1, Math.ceil(w / maxW));
    return { lines, height: lines * fs * 1.15 };
  };

  // ===== NOME (1 linha) — branco bold, trunca com …
  const rawName = String(item.name || '').toUpperCase();
  const nameFs = isTall ? 11 : 8;
  const nameMaxChars = isTall ? 38 : 50;
  const name = truncate(rawName, nameMaxChars);

  // ===== TAGS — até 2 linhas, ellipsis se passar
  const ref = String(item.supplierRef || item.sku || '').toUpperCase();
  const tags = [
    ref ? 'REF ' + ref : null,
    item.gender || null,
    item.category || null,
    item.modality || null,
    item.tier || null,
  ].filter(Boolean).join(' • ');
  const tagFs = isTall ? 8 : 6.5;

  // Mede pra calcular distribuição vertical do bloco (nome + gap + tags)
  const nameBlock = { lines: 1, height: nameFs * 1.15 };
  const tagBlock = measureBlock(tags, tagFs, 'Helvetica', textW);
  const tagsMaxLines = 2;
  const tagsLines = Math.min(tagBlock.lines, tagsMaxLines);
  const tagsHeight = tagsLines * tagFs * 1.15;
  const blockGap = mm(1.5);
  const totalBlockH = nameBlock.height + blockGap + tagsHeight;
  // Centraliza verticalmente
  const blockY = y + Math.max(mm(1), (h - totalBlockH) / 2);

  // Desenha NOME
  doc.fontSize(nameFs).fillColor(WHITE).font('Helvetica-Bold')
    .text(name, x + padX, blockY, { width: textW, height: nameBlock.height, ellipsis: true, lineBreak: false });

  // Desenha TAGS (até 2 linhas)
  doc.fontSize(tagFs).fillColor(WHITE).font('Helvetica')
    .text(tags, x + padX, blockY + nameBlock.height + blockGap, {
      width: textW,
      height: tagsHeight + 1,    // tolera 1pt de folga
      ellipsis: true,
      lineBreak: true,           // permite quebra de linha
    });

  // ===== PREÇO (centro) — branco, MUITO grande, destaque máximo
  // Auto-shrink: começa em priceFsMax e reduz até caber em priceW numa linha só
  const usePromo = item.promotionalPrice != null && item.promotionalPrice < (item.price || Infinity);
  const showPrice = usePromo ? item.promotionalPrice : item.price;
  const fitFontSize = (text, maxW, maxFs, minFs) => {
    doc.font('Helvetica-Bold');
    for (let fs = maxFs; fs >= minFs; fs -= 0.5) {
      doc.fontSize(fs);
      if (doc.widthOfString(text) <= maxW) return fs;
    }
    return minFs;
  };
  if (showPrice != null) {
    const priceFsMax = isTall ? 20 : 14;
    const priceFsMin = 9;
    const priceStr = fmtBRL(showPrice);
    const priceFs = fitFontSize(priceStr, priceW - mm(2), priceFsMax, priceFsMin);
    if (usePromo && item.price) {
      const origStr = fmtBRL(item.price);
      const origFs = fitFontSize(origStr, priceW - mm(2), 7, 5);
      const promoBlockH = (origFs * 1.3) + mm(4.5) + (priceFs * 1.3);
      const yOffset = Math.max(mm(1), (h - promoBlockH) / 2);
      doc.fontSize(origFs).fillColor(WHITE).font('Helvetica')
        .text(origStr, priceX, y + yOffset, { width: priceW, align: 'center', strike: true, lineBreak: false, height: origFs * 1.3 });
      doc.fontSize(priceFs).fillColor(WHITE).font('Helvetica-Bold')
        .text(priceStr, priceX, y + yOffset + mm(4.5), { width: priceW, align: 'center', lineBreak: false, height: priceFs * 1.3 });
    } else {
      // Centraliza verticalmente o preço
      const priceY = y + (h - priceFs * 0.7) / 2 - mm(0.5);
      doc.fontSize(priceFs).fillColor(WHITE).font('Helvetica-Bold')
        .text(priceStr, priceX, priceY, { width: priceW, align: 'center', lineBreak: false, height: priceFs * 1.3 });
    }
  }

  // ===== CARD BRANCO atrás do QR (contraste sobre fundo laranja)
  doc.rect(qrCardX, qrCardY, qrCardSize, qrCardSize)
    .fillColor(WHITE).fill();
  // Marca posição do QR pra render assíncrono em cima do card branco
  if (item.qrCodeValue) {
    item._qrPos = { x: qrX, y: qrY, size: qrSize };
  }
}

async function loadLogoBuffer(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  try {
    let raw;
    if (v.startsWith('data:image/')) {
      const b64 = v.split(',')[1];
      raw = b64 ? Buffer.from(b64, 'base64') : null;
    } else {
      if (!/^https?:\/\//i.test(v) || !globalThis.fetch) return null;
      const response = await fetch(v);
      if (!response.ok) return null;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const isSvg = /image\/svg\+xml/.test(contentType) || /\.svg(?:\?|$)/i.test(v);
      const isRaster = /image\/(png|jpe?g|webp)/.test(contentType) || /\.(png|jpe?g|webp)(?:\?|$)/i.test(v);
      if (!isSvg && !isRaster) return null;
      raw = Buffer.from(await response.arrayBuffer());
    }
    if (!raw) return null;

    // Todas as logos desta etiqueta são impressas em branco sobre o laranja.
    // Mantemos o canal alfa original e trocamos apenas os pixels visíveis.
    const sharp = require('sharp');
    const { data, info } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    }
    return await sharp(data, { raw: info }).png().toBuffer();
  } catch (err) {
    console.warn('[labels] logo da loja indisponivel; usando nome textual:', err?.message || err);
    return null;
  }
}

// Layout especial 5x7 cm: cada produto ocupa dois slots fÃ­sicos.
// Slot 0 = marca na frente / dados no verso; slot 1 = loja na frente / QR no verso.
// Separa a logo oficial da Sports & Tennis em dois elementos visuais: o
// desenho grande e o wordmark que fica abaixo dele na etiqueta.
async function loadStoreLogoParts(value) {
  const v = String(value || '').trim();
  try {
    const raw = await (async () => {
      if (v.startsWith('data:image/')) {
        const b64 = v.split(',')[1];
        return b64 ? Buffer.from(b64, 'base64') : null;
      }
      if (!/^https?:\/\//i.test(v) || !globalThis.fetch) return null;
      const response = await fetch(v);
      if (!response.ok) return null;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const isSvg = /image\/svg\+xml/.test(contentType) || /\.svg(?:\?|$)/i.test(v);
      const isRaster = /image\/(png|jpe?g|webp)/.test(contentType) || /\.(png|jpe?g|webp)(?:\?|$)/i.test(v);
      if (!isSvg && !isRaster) return null;
      return Buffer.from(await response.arrayBuffer());
    })();
    if (!raw) return {};

    const sharp = require('sharp');
    const meta = await sharp(raw).metadata();
    const official = /st-logo-sports-tennis-white-transparent/i.test(v)
      && Number(meta.width) >= 900 && Number(meta.height) >= 200;
    if (!official) return { full: await loadLogoBuffer(v) };

    const makePart = async (crop) => {
      // O trim ocorre depois do extract, pois algumas versões do sharp não
      // aceitam a área extraída como entrada da operação seguinte.
      const extracted = await sharp(raw).ensureAlpha().extract(crop).png().toBuffer();
      const { data, info } = await sharp(extracted).trim().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let i = 0; i < data.length; i += info.channels) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      }
      return sharp(data, { raw: info }).png().toBuffer();
    };

    const splitX = Math.min(230, Number(meta.width) - 1);
    return {
      icon: await makePart({ left: 0, top: 0, width: splitX, height: Number(meta.height) }),
      wordmark: await makePart({ left: splitX, top: 0, width: Number(meta.width) - splitX, height: Number(meta.height) }),
    };
  } catch (err) {
    console.warn('[labels] não foi possível separar a logo da loja:', err?.message || err);
    return { full: await loadLogoBuffer(v) };
  }
}

function drawProductFourSide(doc, item, template, x, y, w, h, side) {
  const WHITE = '#FFFFFF';
  const FONT_REGULAR = doc._tenisLabelFonts ? 'TenisRoboto' : 'Helvetica';
  const FONT_BOLD = doc._tenisLabelFonts ? 'TenisRobotoBold' : 'Helvetica-Bold';
  const cmyk = template?.layoutConfig?.backgroundCmyk || FOUR_SIDE_ORANGE_CMYK;
  // PDFKit interpreta arrays de quatro componentes como CMYK em percentuais.
  const ORANGE = [Number(cmyk.c || 0), Number(cmyk.m || 80), Number(cmyk.y || 100), Number(cmyk.k || 0)];
  const pad = mm(3);
  const innerW = Math.max(mm(5), w - pad * 2);
  doc.rect(x, y, w, h).fillColor(ORANGE).fill();
  // As células da grade encostam umas nas outras. A linha branca funciona
  // como guia visual contínua para a navalha, mantendo a etiqueta em 5x7 cm.
  const cutBorder = mm(FOUR_SIDE_CUT_BORDER_MM);
  doc.save();
  doc.rect(x + cutBorder / 2, y + cutBorder / 2, w - cutBorder, h - cutBorder)
    .lineWidth(cutBorder)
    .strokeColor('#FFFFFF')
    .stroke();
  doc.restore();

  const centered = (text, fs, yy, opts = {}) => {
    doc.font(FONT_BOLD).fontSize(fs).fillColor(WHITE).text(String(text || ''), x + pad, yy, {
      width: innerW,
      align: 'center',
      lineBreak: opts.lineBreak !== false,
      height: opts.height,
      ellipsis: opts.ellipsis,
    });
  };

  if (side === 'brand') {
    if (item._brandLogoBuffer) {
      try {
        doc.image(item._brandLogoBuffer, x + pad, y + h * 0.28, {
          fit: [innerW, h * 0.56],
          align: 'center',
          valign: 'center',
        });
      } catch {
        centered('LOGO DA MARCA PENDENTE', 9, y + h * 0.42, { lineBreak: false });
      }
    } else {
      centered('LOGO DA MARCA PENDENTE', 9, y + h * 0.42, { lineBreak: false });
    }
    return;
  }

  if (side === 'store') {
    // A face sÃ³ recebe a imagem cadastrada no BrandProfile; sem imagem,
    // sinaliza pendÃªncia em vez de transformar o nome em uma falsa logo.
    if (item._storeLogoIconBuffer || item._storeLogoWordmarkBuffer || item._storeLogoBuffer) {
      try {
        if (item._storeLogoIconBuffer && item._storeLogoWordmarkBuffer) {
          // O PDFKit posiciona o box de fit pela borda esquerda. Como os dois
          // recortes possuem proporções diferentes, calculamos o tamanho real
          // e centralizamos o conteúdo, não apenas a caixa transparente.
          const iconW = innerW * 0.68;
          const iconH = iconW * (205 / 190);
          const iconAreaH = h * 0.62;
          doc.image(item._storeLogoIconBuffer, x + (w - iconW) / 2, y + h * 0.06 + (iconAreaH - iconH) / 2, {
            width: iconW,
            height: iconH,
          });
          const wordmarkW = innerW * 0.88;
          const wordmarkH = wordmarkW * (191 / 660);
          const wordmarkAreaH = h * 0.20;
          doc.image(item._storeLogoWordmarkBuffer, x + (w - wordmarkW) / 2, y + h * 0.73 + (wordmarkAreaH - wordmarkH) / 2, {
            width: wordmarkW,
            height: wordmarkH,
          });
        } else if (item._storeLogoBuffer) {
          doc.image(item._storeLogoBuffer, x + pad, y + h * 0.18, {
            fit: [innerW, h * 0.54],
            align: 'center',
            valign: 'center',
          });
        } else if (item._storeLogoIconBuffer) {
          doc.image(item._storeLogoIconBuffer, x + pad, y + h * 0.12, {
            fit: [innerW * 0.72, h * 0.62],
            align: 'center',
            valign: 'center',
          });
          centered(item.storeName || 'Sports & Tennis', 8, y + h * 0.78, { lineBreak: false });
        }
      } catch {
        centered('LOGO DA LOJA PENDENTE', 9, y + h * 0.40, { lineBreak: false });
      }
    } else {
      centered('LOGO DA LOJA PENDENTE', 9, y + h * 0.40, { lineBreak: false });
    }
    return;
  }

  if (side === 'details') {
    const productName = String(item.productName || item.name || '').trim();
    const categoryLabel = String(item.categoryLabel || item.category || '').trim();
    const sizes = item.availableSizes ? `Disponiveis: ${item.availableSizes}` : '';
    doc.font(FONT_BOLD).fontSize(7).fillColor(WHITE)
     .text('DESCRICAO DO PRODUTO', x + pad, y + pad, { width: innerW, align: 'center', lineBreak: false });
    doc.font(FONT_BOLD).fontSize(10).fillColor(WHITE)
      .text(productName, x + pad, y + pad + mm(5), { width: innerW, height: mm(11), align: 'center', ellipsis: true });
    if (categoryLabel) {
      doc.font(FONT_BOLD).fontSize(7).fillColor(WHITE)
        .text(categoryLabel, x + pad, y + mm(21), { width: innerW, height: mm(8), align: 'center', ellipsis: true });
    }
    if (sizes) {
      doc.font(FONT_REGULAR).fontSize(6.5).fillColor(WHITE)
        .text(sizes, x + pad, y + mm(30), { width: innerW, height: mm(10), align: 'center', ellipsis: true });
    }
    const usePromo = item.promotionalPrice != null && item.promotionalPrice < (item.price || Infinity);
    const value = usePromo ? item.promotionalPrice : item.price;
    if (value != null) {
      doc.font(FONT_BOLD).fontSize(16).fillColor(WHITE)
        .text(fmtBRL(value), x + pad, y + h - mm(28), { width: innerW, align: 'center', lineBreak: false });
      if (usePromo && item.price != null) {
        doc.font(FONT_REGULAR).fontSize(6.5).fillColor(WHITE)
          .text(`De ${fmtBRL(item.price)}`, x + pad, y + h - mm(34), { width: innerW, align: 'center', lineBreak: false, strike: true });
      }
    }
    if (item.barcode) {
      drawFakeBarcode(doc, item.barcode, x + pad, y + h - mm(15), innerW, mm(12), { color: WHITE });
    }
    return;
  }

  // Face QR: o cartÃ£o branco preserva o contraste e a leitura na impressÃ£o.
  centered('CONSULTE MAIS INFORMAÇÕES', 8, y + pad, { lineBreak: false });
  const qrSize = Math.min(innerW - mm(4), h - mm(21));
  const qrX = x + (w - qrSize) / 2;
  const qrY = y + mm(13);
  doc.rect(qrX, qrY, qrSize, qrSize).fillColor(WHITE).fill();
  if (item.qrCodeValue) item._qrPos = { x: qrX, y: qrY, size: qrSize };
  doc.font(FONT_REGULAR).fontSize(6.5).fillColor(WHITE)
   .text('Aponte a camera para consultar', x + pad, y + h - mm(6), { width: innerW, align: 'center', lineBreak: false });
}

function drawLabelContent(doc, item, template, x, y, w, h) {
  const t = template;
  // Detecta o layout horizontal S&T atual e os formatos legados para PDFs antigos.
  if (isSTHorizontalTemplate(t)) {
    return drawLabelHorizontal(doc, item, template, x, y, w, h);
  }
  let cursor = y + mm(2);
  const padX = x + mm(2);
  const innerW = w - mm(4);

  if (t.showBrand !== false && item.brand) {
    doc.fontSize(7).fillColor('#666').text(String(item.brand).toUpperCase(), padX, cursor, { width: innerW, ellipsis: true });
    cursor += 9;
  }
  if (t.showProductName !== false && item.name) {
    doc.fontSize(t.paperSize === 'THERMAL' ? 9 : 10).fillColor('#000')
      .text(String(item.name), padX, cursor, { width: innerW, height: 22, ellipsis: true });
    cursor += t.paperSize === 'THERMAL' ? 18 : 22;
  }
  if (t.showSize && item.size) {
    doc.fontSize(7).fillColor('#444').text('Tam: ' + item.size, padX, cursor, { width: innerW });
    cursor += 8;
  }
  if (t.showColor && item.color) {
    doc.fontSize(7).fillColor('#444').text('Cor: ' + item.color, padX, cursor, { width: innerW });
    cursor += 8;
  }
  if (t.showSku !== false && item.sku) {
    doc.fontSize(6).fillColor('#888').text('SKU ' + item.sku, padX, cursor, { width: innerW });
    cursor += 8;
  }

  if (t.type === 'PROMOTIONAL') {
    // Placa grande de promo: preço gigante
    if (item.promotionalPrice != null) {
      doc.fontSize(34).fillColor('#E5571E')
        .text(fmtBRL(item.promotionalPrice), padX, y + h * 0.45, { width: innerW, align: 'center' });
      if (item.price != null && item.price > item.promotionalPrice) {
        doc.fontSize(10).fillColor('#888')
          .text('de ' + fmtBRL(item.price) + ' por', padX, y + h * 0.35, { width: innerW, align: 'center' });
      }
    } else if (item.price != null) {
      doc.fontSize(30).fillColor('#000').text(fmtBRL(item.price), padX, y + h * 0.45, { width: innerW, align: 'center' });
    }
  } else {
    if (t.showPrice !== false && item.price != null) {
      const showPromo = t.showPromotionalPrice && item.promotionalPrice != null && item.promotionalPrice < item.price;
      if (showPromo) {
        doc.fontSize(7).fillColor('#888')
          .text(fmtBRL(item.price), padX, cursor, { width: innerW, strike: true });
        cursor += 8;
        doc.fontSize(12).fillColor('#E5571E')
          .text(fmtBRL(item.promotionalPrice), padX, cursor, { width: innerW });
        cursor += 14;
      } else {
        doc.fontSize(t.paperSize === 'THERMAL' ? 14 : 12).fillColor('#000')
          .text(fmtBRL(item.price), padX, cursor, { width: innerW });
        cursor += 16;
      }
    }
  }

  // Barcode + QR no rodapé
  const footerH = mm(7);
  const footerY = y + h - footerH - mm(1);
  if (t.showBarcode !== false && item.barcode) {
    const barW = t.showQRCode ? innerW * 0.7 : innerW;
    drawFakeBarcode(doc, item.barcode, padX, footerY, barW, footerH);
  }
  // QR é assíncrono, marcamos posição (renderizado em outra passada quando precisar)
  if (t.showQRCode && item.qrCodeValue) {
    item._qrPos = { x: padX + innerW - footerH, y: footerY, size: footerH };
  }
}

/**
 * generateLabelsPDF — gera Buffer PDF com as etiquetas.
 *
 * @param {Object} opts
 * @param {Object} opts.template - LabelTemplate object
 * @param {Array}  opts.items - [{name, brand, sku, size, color, price, promotionalPrice, barcode, qrCodeValue, quantity}]
 * @returns {Promise<Buffer>}
 */
async function generateLabelsPDF({ template, items, storeName, storeLogoUrl }) {
  const t = template;
  const paperSize = t.paperSize || 'A4';
  const layoutW = paperSize === 'A4' ? 'A4' : [mm(t.widthMm), mm(t.heightMm)];
  const duplex = isDuplexTemplate(t);
  const fourSide = isFourSideProductTemplate(t);

  const doc = new PDFDocument({
    size: layoutW,
    margins: { top: 0, left: 0, right: 0, bottom: 0 },
    bufferPages: true, // permite switchToPage no segundo pass dos QRs
  });
  doc._tenisLabelFonts = fourSide && registerLabelFonts(doc);
  // Solicita aos leitores de PDF que imprimam em tamanho real. A preferência é
  // gravada no próprio arquivo e evita que leitores compatíveis ativem "Ajustar".
  const viewerPreferences = doc._root.data.ViewerPreferences || doc.ref({});
  viewerPreferences.data.PrintScaling = 'None';
  viewerPreferences.data.PickTrayByPDFSize = true;
  if (duplex) {
    viewerPreferences.data.Duplex = t.layoutConfig?.duplexBinding === 'short-edge'
      ? 'DuplexFlipShortEdge'
      : 'DuplexFlipLongEdge';
  }
  doc._root.data.ViewerPreferences = viewerPreferences;
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => {
    doc.on('end', () => res(Buffer.concat(chunks)));
    doc.on('error', rej);
  });

  // Expande quantidades em lista plana
  const flat = [];
  for (const it of items || []) {
    const q = Math.max(1, parseInt(it.quantity || 1, 10));
    for (let i = 0; i < q; i++) {
      if (fourSide) {
        flat.push({ ...it, _pairSlot: 0 });
        flat.push({ ...it, _pairSlot: 1 });
      } else {
        flat.push({ ...it });
      }
    }
  }

  if (fourSide && storeLogoUrl) {
    const logoParts = await loadStoreLogoParts(storeLogoUrl);
    if (logoParts.icon) flat.forEach((item) => { item._storeLogoIconBuffer = logoParts.icon; });
    if (logoParts.wordmark) flat.forEach((item) => { item._storeLogoWordmarkBuffer = logoParts.wordmark; });
    if (logoParts.full) flat.forEach((item) => { item._storeLogoBuffer = logoParts.full; });
  }
  if (fourSide) {
    const brandUrls = [...new Set(flat.map((item) => String(item.brandLogoUrl || '').trim()).filter(Boolean))];
    const brandBuffers = await Promise.all(brandUrls.map(async (url) => [url, await loadLogoBuffer(url)]));
    const byUrl = new Map(brandBuffers.filter(([, buffer]) => buffer));
    flat.forEach((item) => {
      const url = String(item.brandLogoUrl || '').trim();
      if (url && byUrl.has(url)) item._brandLogoBuffer = byUrl.get(url);
    });
  }

  if (!flat.length) {
    doc.fontSize(12).text('Nenhum item para gerar etiquetas.', 50, 50);
    doc.end();
    return done;
  }

  const labelW = mm(t.widthMm);
  const labelH = mm(t.heightMm);
  const gapX = mm(t.gapHorizontalMm || 0);
  const gapY = mm(t.gapVerticalMm || 0);
  const marginX = mm(t.marginLeftMm || 0);
  const marginY = mm(t.marginTopMm || 0);
  const cols = t.columns || 1;
  const rows = t.rows || 1;
  const perPage = cols * rows;

  const qrJobs = []; // {item, x, y, size, pageIndex}
  let currentPageIndex = 0;

  function drawPage(pageItems, pageIndex, pageSide) {
    pageItems.forEach((item, slot) => {
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const x = marginX + col * (labelW + gapX);
      const y = marginY + row * (labelH + gapY);

      doc.save();
      // Layout S&T: fundo laranja sólido (145mm × 25mm; formatos anteriores suportados)
      const isST = isSTHorizontalTemplate(t);
      if (fourSide) {
        const side = pageSide === 'front'
          ? (item._pairSlot === 1 ? 'details' : 'brand')
          : (item._pairSlot === 1 ? 'qr' : 'store');
        drawProductFourSide(doc, item, t, x, y, labelW, labelH, side);
      } else if (isST) {
        doc.rect(x, y, labelW, labelH).fillColor('#E5571E').fill();
      } else {
        doc.rect(x, y, labelW, labelH).lineWidth(0.5).strokeColor('#ddd').stroke();
      }
      if (!fourSide && storeName && t.showStore) {
        doc.fontSize(6).fillColor(isST ? '#FFFFFF' : '#aaa').text(storeName, x + mm(1), y + mm(1));
      }
      // Frente e verso usam a mesma grade e os mesmos itens para manter o alinhamento.
      if (!fourSide) drawLabelContent(doc, item, t, x, y, labelW, labelH);
      if (item._qrPos) {
        qrJobs.push({ item, pageIndex, ...item._qrPos });
        delete item._qrPos;
      }
      doc.restore();
    });
  }

  for (let sheetStart = 0; sheetStart < flat.length; sheetStart += perPage) {
    const sheetItems = flat.slice(sheetStart, sheetStart + perPage);
    drawPage(sheetItems, currentPageIndex, duplex ? 'front' : null);

    if (duplex) {
      doc.addPage({ size: layoutW, margins: { top: 0, left: 0, right: 0, bottom: 0 } });
      currentPageIndex++;
      drawPage(sheetItems, currentPageIndex, 'back');
    }

    if (sheetStart + perPage < flat.length) {
      doc.addPage({ size: layoutW, margins: { top: 0, left: 0, right: 0, bottom: 0 } });
      currentPageIndex++;
    }
  }

  // Renderizar QR codes — switchToPage pra garantir QR na página certa
  for (const job of qrJobs) {
    doc.switchToPage(job.pageIndex);
    await drawQR(doc, job.item.qrCodeValue, job.x, job.y, job.size);
  }

  doc.end();
  return done;
}

module.exports = {
  generateLabelsPDF,
  defaultTemplates,
  isSTHorizontalTemplate,
  isDuplexTemplate,
  isFourSideProductTemplate,
};
