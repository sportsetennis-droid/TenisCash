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

// A etiqueta usa famílias locais para manter o mesmo resultado no PDF e na
// impressão. Roboto Slab é a tipografia principal, com peso e desenho clássico.
const LABEL_FONT_REGULAR = path.join(__dirname, '../../node_modules/@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf');
const LABEL_FONT_MEDIUM = path.join(__dirname, '../../node_modules/@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf');
const LABEL_FONT_BOLD = path.join(__dirname, '../../node_modules/@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf');
const LABEL_FONT_CLASSIC_REGULAR = path.join(__dirname, '../../assets/fonts/RobotoSlab-Regular.ttf');
const LABEL_FONT_CLASSIC_SEMIBOLD = path.join(__dirname, '../../assets/fonts/RobotoSlab-SemiBold.ttf');
const LABEL_FONT_CLASSIC_BOLD = path.join(__dirname, '../../assets/fonts/RobotoSlab-Bold.ttf');
const SPORTS_TENNIS_ICON_HIRES = path.join(__dirname, '../../assets/logos/sports-tennis-icon-white-hires.png');
const SPORTS_TENNIS_WORDMARK_HIRES = path.join(__dirname, '../../assets/logos/sports-tennis-wordmark-white-hires.png');
const PRODUCT_ORANGE_RGB = '#F4511E';
// Bloco sRGB 8x8 sem transparencia. No verso ele substitui o retangulo CMYK
// que produzia duas faixas na Epson ao iniciar a area laranja continua.
const PRODUCT_ORANGE_RGB_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR42mP4EiiHFTEMLQkA40ZYwQZmizoAAAAASUVORK5CYII=',
  'base64',
);

function registerLabelFonts(doc) {
  let interRegistered = false;
  if (fs.existsSync(LABEL_FONT_REGULAR) && fs.existsSync(LABEL_FONT_MEDIUM) && fs.existsSync(LABEL_FONT_BOLD)) {
    try {
      doc.registerFont('TenisInter', LABEL_FONT_REGULAR);
      doc.registerFont('TenisInterMedium', LABEL_FONT_MEDIUM);
      doc.registerFont('TenisInterBold', LABEL_FONT_BOLD);
      interRegistered = true;
    } catch {
      interRegistered = false;
    }
  }

  doc._tenisClassicLabelFonts = false;
  if (fs.existsSync(LABEL_FONT_CLASSIC_REGULAR) && fs.existsSync(LABEL_FONT_CLASSIC_SEMIBOLD) && fs.existsSync(LABEL_FONT_CLASSIC_BOLD)) {
    try {
      doc.registerFont('TenisSlab', LABEL_FONT_CLASSIC_REGULAR);
      doc.registerFont('TenisSlabSemiBold', LABEL_FONT_CLASSIC_SEMIBOLD);
      doc.registerFont('TenisSlabBold', LABEL_FONT_CLASSIC_BOLD);
      doc._tenisClassicLabelFonts = true;
    } catch {
      doc._tenisClassicLabelFonts = false;
    }
  }
  return interRegistered;
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

// Compatibilidade com lotes antigos, que usavam duas etiquetas fisicas
// por produto e quatro faces separadas.
function isFourSideProductTemplate(template) {
  const config = template?.layoutConfig;
  return isDuplexTemplate(template) && Number(config?.labelsPerProduct || 1) === 2;
}

function isSingleProductDuplexTemplate(template) {
  const config = template?.layoutConfig;
  return isDuplexTemplate(template)
    && Number(template?.widthMm) === 50
    && Number(template?.heightMm) === 70
    && Number(config?.labelsPerProduct || 1) === 1
    && config?.backLayout === 'store-and-codes';
}

function isProductDuplexTemplate(template) {
  return isFourSideProductTemplate(template) || isSingleProductDuplexTemplate(template);
}

function isSaldoTemplate(template) {
  return String(template?.layoutConfig?.labelDesign || '').startsWith('saldo-5x7');
}

const FOUR_SIDE_ORANGE = '#FF3300'; // aproximaÃ§Ã£o RGB de CMYK C0 M80 Y100 K0
const FOUR_SIDE_ORANGE_CMYK = { c: 0, m: 80, y: 100, k: 0 };
const FOUR_SIDE_FRONT_BLEED_MM = 2;
const FOUR_SIDE_BACK_BLEED_MM = 2;

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
        backLayout: 'store-and-codes',
        labelsPerProduct: 1,
        sides: {
          front: 'brand-product-price-warranty',
          back: 'store-barcode-qr',
        },
        labelDesign: 'single-product-v1',
        backgroundCmyk: FOUR_SIDE_ORANGE_CMYK,
        backgroundHex: PRODUCT_ORANGE_RGB,
        // Sangria adicional no verso absorve a tolerância mecânica do duplex
        // sem expor bordas brancas depois do corte.
        backBleedMm: 4.5,
        // Compensa o registro horizontal medido na Epson L4360: depois do
        // corte sobravam 5 mm à esquerda e 2 mm à direita. Metade da diferença
        // (1,5 mm) é antecipada à esquerda para deixar 3,5 mm em cada lado.
        backPrintOffsetXMm: -1.5,
        // Restaura o plano de corte implantado: cada encontro da grade recebe
        // uma cruz, permitindo identificar os limites das 16 etiquetas.
        cutMarksInsideArtwork: true,
        cutMarkSafeGapMm: 0.35,
        // O verso usa um unico fundo, sem emendas entre as 16 etiquetas.
        // Isso evita que o driver revele bordas de retangulos sobrepostos.
        backFullPageBackground: true,
        // Nas laterais, a borda real do retangulo fica fora da pagina. No topo
        // e na base, o fundo comeca dentro da sangria externa (4 mm e 293 mm),
        // antes das linhas de corte (8,5 mm e 288,5 mm). Assim a Epson nao
        // inicia a carga de tinta na borda fisica da folha e qualquer transicao
        // permanece integralmente na sobra descartada depois do corte.
        backBackgroundOverscanMm: 10,
        backBackgroundStopsInOuterBleed: true,
        // A mesma codificacao RGB da faixa laranja da frente evita que o
        // driver trate o verso como uma chapa CMYK separada.
        backBackgroundRenderMode: 'rgb-image',
      },
    },
    a4_16_5x7_saldo: {
      type: 'PROMOTIONAL',
      name: 'SALDO REPETIDO — A4 16 etiquetas (5x7 cm) — frente e costas',
      legacyNames: ['SALDO — A4 16 etiquetas (5x7 cm)'],
      paperSize: 'A4',
      widthMm: 50,
      heightMm: 70,
      columns: 4,
      rows: 4,
      marginTopMm: 8.5,
      marginLeftMm: 5,
      gapHorizontalMm: 0,
      gapVerticalMm: 0,
      layoutConfig: {
        duplex: true,
        duplexBinding: 'long-edge',
        labelsPerProduct: 1,
        sides: {
          front: 'saldo',
          back: 'saldo',
        },
        saldoRepeatColumns: 2,
        saldoRepeatRows: 5,
        saldoFontSize: 14,
        labelDesign: 'saldo-5x7-repeated-v3',
        cutMarksOnBothSides: true,
        cutContourEachLabel: true,
        cutContourColor: '#FF8A3D',
        backgroundCmyk: { c: 0, m: 80, y: 100, k: 0 },
        backgroundHex: '#E5571E',
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

// Padrões Code 128 (cada símbolo tem 11 módulos; STOP tem 13). O desenho
// vetorial permite leitura por leitor de caixa sem depender de imagem raster.
const CODE128_BARS = [
  11011001100, 11001101100, 11001100110, 10010011000, 10010001100,
  10001001100, 10011001000, 10011000100, 10001100100, 11001001000,
  11001000100, 11000100100, 10110011100, 10011011100, 10011001110,
  10111001100, 10011101100, 10011100110, 11001110010, 11001011100,
  11001001110, 11011100100, 11001110100, 11101101110, 11101001100,
  11100101100, 11100100110, 11101100100, 11100110100, 11100110010,
  11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
  10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
  11000101000, 11000100010, 10110111000, 10110001110, 10001101110,
  10111011000, 10111000110, 10001110110, 11101110110, 11010001110,
  11000101110, 11011101000, 11011100010, 11011101110, 11101011000,
  11101000110, 11100010110, 11101101000, 11101100010, 11100011010,
  11101111010, 11001000010, 11110001010, 10100110000, 10100001100,
  10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
  10110000100, 10011010000, 10011000010, 10000110100, 10000110010,
  11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
  10100111100, 10010111100, 10010011110, 10111100100, 10011110100,
  10011110010, 11110100100, 11110010100, 11110010010, 11011011110,
  11011110110, 11110110110, 10101111000, 10100011110, 10001011110,
  10111101000, 10111100010, 11110101000, 11110100010, 10111011110,
  10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
  11010011100, 1100011101011,
];

function code128Pattern(value) {
  const code = String(value || '').replace(/[^\x20-\x7E]/g, '?').slice(0, 48);
  if (!code) return null;
  let symbols;
  if (/^\d{4,}$/.test(code)) {
    // START C compacta dois dígitos por símbolo. Em códigos numéricos ímpares,
    // troca para o conjunto B apenas no último dígito. Isso deixa as barras
    // mais largas e confiáveis na impressão pequena da etiqueta.
    symbols = [105];
    const pairedLength = code.length - (code.length % 2);
    for (let i = 0; i < pairedLength; i += 2) {
      symbols.push(Number(code.slice(i, i + 2)));
    }
    if (pairedLength < code.length) {
      symbols.push(100, code.charCodeAt(code.length - 1) - 32);
    }
  } else {
    symbols = [104]; // START B: texto ASCII imprimível
    for (const char of code) symbols.push(char.charCodeAt(0) - 32);
  }
  let checksum = symbols[0];
  for (let i = 1; i < symbols.length; i++) checksum += symbols[i] * i;
  symbols.push(checksum % 103, 106);
  return symbols.map((symbol) => String(CODE128_BARS[symbol])).join('');
}

function drawBarcode128(doc, value, x, y, w, h, options = {}) {
  const code = String(value || '').trim().slice(0, 48);
  if (!code) return;
  const pattern = code128Pattern(code);
  if (!pattern) return;
  const color = options.color || '#000';
  const caption = options.captionText || (options.caption ? `${options.caption}: ${code}` : code);
  const quiet = Math.min(mm(1), w * 0.04);
  const moduleWidth = (w - quiet * 2) / pattern.length;
  const barHeight = h * 0.74;
  doc.save();
  if (options.background) {
    doc.fillColor(options.background).rect(x, y, w, h).fill();
  }
  doc.fillColor(color);
  let runStart = null;
  for (let i = 0; i <= pattern.length; i++) {
    const isBar = i < pattern.length && pattern[i] === '1';
    if (isBar && runStart == null) runStart = i;
    if ((!isBar || i === pattern.length) && runStart != null) {
      doc.rect(x + quiet + runStart * moduleWidth, y, (i - runStart) * moduleWidth, barHeight).fill();
      runStart = null;
    }
  }
  doc.restore();
  doc.fontSize(options.captionSize || 5.5).fillColor(color).text(caption, x, y + barHeight + mm(0.4), {
    width: w,
    align: 'center',
    lineBreak: false,
    ellipsis: true,
  });
}

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

// PDFKit preserva a proporção quando recebe `fit`, mas logos recortadas e
// imagens com orientação EXIF podem chegar com caixas transparentes diferentes.
// Calculamos explicitamente o maior retângulo proporcional para nunca deformar
// o desenho, centralizando-o dentro da área reservada da etiqueta.
// Abre a imagem UMA vez por documento e reusa o mesmo objeto nas demais etiquetas.
// Sem isso o PDFKit embute uma cópia inteira da logo em CADA etiqueta — era o que
// fazia o PDF da loja passar de 600 MB e estourar o timeout (erro 524).
function openImageCached(doc, source) {
  if (!doc._tcImageCache) doc._tcImageCache = new Map();
  const cache = doc._tcImageCache;
  if (cache.has(source)) return cache.get(source);
  const opened = doc.openImage(source);
  cache.set(source, opened);
  return opened;
}

function drawImageContain(doc, source, x, y, boxW, boxH) {
  if (!source || boxW <= 0 || boxH <= 0) return;
  const image = openImageCached(doc, source);
  const imageW = Number(image.width);
  const imageH = Number(image.height);
  if (!Number.isFinite(imageW) || !Number.isFinite(imageH) || imageW <= 0 || imageH <= 0) return;
  const scale = Math.min(boxW / imageW, boxH / imageH);
  const drawW = imageW * scale;
  const drawH = imageH * scale;
  doc.image(image, x + (boxW - drawW) / 2, y + (boxH - drawH) / 2, {
    width: drawW,
    height: drawH,
    ignoreOrientation: true,
  });
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
    let isSvg = false;
    if (v.startsWith('data:image/')) {
      const b64 = v.split(',')[1];
      raw = b64 ? Buffer.from(b64, 'base64') : null;
      isSvg = /^data:image\/svg\+xml/i.test(v);
    } else {
      if (!/^https?:\/\//i.test(v) || !globalThis.fetch) return null;
      const response = await fetch(v);
      if (!response.ok) return null;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      isSvg = /image\/svg\+xml/.test(contentType) || /\.svg(?:\?|$)/i.test(v);
      const isRaster = /image\/(png|jpe?g|webp)/.test(contentType) || /\.(png|jpe?g|webp)(?:\?|$)/i.test(v);
      if (!isSvg && !isRaster) return null;
      raw = Buffer.from(await response.arrayBuffer());
    }
    if (!raw) return null;

    // Todas as logos desta etiqueta são impressas em branco sobre o laranja.
    // Mantemos o canal alfa original e trocamos apenas os pixels visíveis.
    const sharp = require('sharp');
    // O Simple Icons entrega SVG em dimensões pequenas (geralmente 24 px).
    // Renderizamos antes em alta resolução para que o PDF não amplie um bitmap
    // minúsculo e deixe a marca serrilhada na impressão.
    const sourceOptions = isSvg ? { density: 300 } : {};
    const metadata = await sharp(raw, sourceOptions).metadata();
    const source = sharp(raw, sourceOptions)
      .ensureAlpha()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: false })
      .sharpen({ sigma: 1 });
    const { data, info } = await source.raw().toBuffer({ resolveWithObject: true });

    // Algumas logos foram cadastradas como JPG com fundo laranja. Retiramos
    // apenas um fundo de cor uniforme, preservando a borda antialiasada do
    // desenho. Logos PNG/SVG já transparentes não passam por esta máscara.
    let background = null;
    if (!metadata.hasAlpha && info.channels >= 4) {
      const points = [
        [0, 0],
        [Math.max(0, info.width - 1), 0],
        [0, Math.max(0, info.height - 1)],
        [Math.max(0, info.width - 1), Math.max(0, info.height - 1)],
      ].map(([x, y]) => {
        const offset = (y * info.width + x) * info.channels;
        return [data[offset], data[offset + 1], data[offset + 2]];
      });
      const spread = Math.max(...[0, 1, 2].map((channel) => Math.max(...points.map((point) => point[channel])) - Math.min(...points.map((point) => point[channel]))));
      if (spread < 45) {
        background = [0, 1, 2].map((channel) => Math.round(points.reduce((sum, point) => sum + point[channel], 0) / points.length));
      }
    }
    for (let i = 0; i < data.length; i += info.channels) {
      if (background) {
        const distance = Math.sqrt(
          ((data[i] - background[0]) ** 2)
          + ((data[i + 1] - background[1]) ** 2)
          + ((data[i + 2] - background[2]) ** 2),
        );
        if (distance < 85) {
          const edgeAlpha = Math.max(0, Math.min(255, Math.round(((distance - 12) / 73) * 255)));
          data[i + 3] = Math.min(data[i + 3], edgeAlpha);
        }
      }
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    }
    return await sharp(data, { raw: info }).trim().png().toBuffer();
  } catch (err) {
    console.warn('[labels] logo da loja indisponivel; usando nome textual:', err?.message || err);
    return null;
  }
}

// Layout legado 5x7 cm: cada produto ocupa dois slots fisicos.
// Slot 0 = marca na frente / dados no verso; slot 1 = loja na frente / QR no verso.
// Separa a logo oficial da Sports & Tennis em dois elementos visuais: o
// desenho grande e o wordmark que fica abaixo dele na etiqueta.
async function loadStoreLogoParts(value) {
  const v = String(value || '').trim();
  try {
    const officialSportsTennis = /st-logo-sports-tennis-white-transparent/i.test(v);
    if (
      officialSportsTennis
      && fs.existsSync(SPORTS_TENNIS_ICON_HIRES)
      && fs.existsSync(SPORTS_TENNIS_WORDMARK_HIRES)
    ) {
      // A imagem oficial horizontal tem somente 230 px de largura no símbolo.
      // Usar os recortes locais em 600 dpi evita ampliar essa miniatura e
      // preserva bordas nítidas na impressão.
      return {
        icon: fs.readFileSync(SPORTS_TENNIS_ICON_HIRES),
        wordmark: fs.readFileSync(SPORTS_TENNIS_WORDMARK_HIRES),
      };
    }

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
    const official = officialSportsTennis
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
  const FONT_REGULAR = doc._tenisLabelFonts ? 'TenisInter' : 'Helvetica';
  const FONT_MEDIUM = doc._tenisLabelFonts ? 'TenisInterMedium' : 'Helvetica';
  const FONT_BOLD = doc._tenisLabelFonts ? 'TenisInterBold' : 'Helvetica-Bold';
  const FONT_CLASSIC = doc._tenisClassicLabelFonts ? 'TenisSlab' : FONT_REGULAR;
  const FONT_CLASSIC_SEMIBOLD = doc._tenisClassicLabelFonts ? 'TenisSlabSemiBold' : FONT_MEDIUM;
  const FONT_CLASSIC_BOLD = doc._tenisClassicLabelFonts ? 'TenisSlabBold' : FONT_BOLD;
  const pad = mm(3);
  const innerW = Math.max(mm(5), w - pad * 2);

  const centered = (text, fs, yy, opts = {}) => {
    doc.font(FONT_CLASSIC_BOLD).fontSize(fs).fillColor(WHITE).text(String(text || ''), x + pad, yy, {
      width: innerW,
      align: 'center',
      lineBreak: opts.lineBreak !== false,
      height: opts.height,
      ellipsis: opts.ellipsis,
    });
  };
  const fitSingleLineFont = (text, font, maxSize, minSize, maxWidth = innerW) => {
    for (let size = maxSize; size >= minSize; size -= 0.2) {
      doc.font(font).fontSize(size);
      if (doc.widthOfString(String(text || '')) <= maxWidth) return size;
    }
    return minSize;
  };

  if (side === 'brand') {
    if (item._brandLogoBuffer) {
      try {
        drawImageContain(doc, item._brandLogoBuffer, x + pad, y + h * 0.22, innerW, h * 0.56);
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
          const iconAreaH = h * 0.62;
          drawImageContain(doc, item._storeLogoIconBuffer, x + (w - iconW) / 2, y + h * 0.06, iconW, iconAreaH);
          const wordmarkW = innerW * 0.88;
          const wordmarkAreaH = h * 0.20;
          drawImageContain(doc, item._storeLogoWordmarkBuffer, x + (w - wordmarkW) / 2, y + h * 0.73, wordmarkW, wordmarkAreaH);
        } else if (item._storeLogoBuffer) {
          drawImageContain(doc, item._storeLogoBuffer, x + pad, y + h * 0.18, innerW, h * 0.54);
        } else if (item._storeLogoIconBuffer) {
          drawImageContain(doc, item._storeLogoIconBuffer, x + pad, y + h * 0.12, innerW * 0.72, h * 0.62);
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
    const referenceSource = String(item.reference || item.supplierRef || '').trim();
    const ckReference = referenceSource.match(/\b(CK\d{8})/i);
    const reference = (ckReference ? ckReference[1] : referenceSource).toUpperCase();
    const categoryLabel = String(item.categoryLabel || item.category || '').trim();
    const promotionText = String(item.promotionText || '').trim();
    const motivationText = String(item.motivationText || '').trim().toUpperCase();
    const sizes = item.availableSizes ? `DISPONÍVEIS: ${item.availableSizes}` : '';
    // Reserva física para o furo: nenhum texto da face de descrição pode
    // ocupar os primeiros 10 mm da etiqueta.
    const punchClearance = mm(10);
    const descriptionTop = y + punchClearance + mm(1.5);
    // A descrição é a informação principal: maior, pesada e com até duas
    // linhas, sem sacrificar a área de 10 mm reservada para o furo.
    let descriptionFs = 12.5;
    for (; descriptionFs >= 9.5; descriptionFs -= 0.25) {
      doc.font(FONT_CLASSIC_BOLD).fontSize(descriptionFs);
      if (doc.heightOfString(productName, { width: innerW, align: 'center' }) <= mm(9.2)) break;
    }
    doc.font(FONT_CLASSIC_BOLD).fontSize(Math.max(9.5, descriptionFs)).fillColor(WHITE)
      .text(productName, x + pad, descriptionTop, {
        width: innerW,
        height: mm(9.2),
        align: 'center',
        ellipsis: true,
      });
    // O estilo fica imediatamente abaixo do nome do produto, para que a
    // categoria seja lida como parte da identificação principal.
    if (categoryLabel) {
      // A categoria/estilo nunca deve receber reticÃªncias. Ajustamos a
      // fonte atÃ© a frase inteira caber na largura da etiqueta.
      const categoryText = categoryLabel.toUpperCase();
      let categoryFs = 6.5;
      for (; categoryFs >= 4; categoryFs -= 0.25) {
        doc.font(FONT_CLASSIC_BOLD).fontSize(categoryFs);
        if (doc.widthOfString(categoryText) <= innerW) break;
      }
      doc.font(FONT_CLASSIC_BOLD).fontSize(Math.max(4, categoryFs)).fillColor(WHITE)
        .text(categoryText, x + pad, y + mm(22), {
          width: innerW,
          height: mm(4),
          align: 'center',
          ellipsis: false,
          lineBreak: false,
        });
    }
    if (reference) {
      doc.font(FONT_CLASSIC).fontSize(6.1).fillColor(WHITE)
        .text(`REF.: ${reference}`, x + pad, y + mm(26.2), {
          width: innerW,
          height: mm(3.8),
          align: 'center',
          ellipsis: true,
          lineBreak: false,
        });
    }
    if (sizes) {
      doc.font(FONT_CLASSIC).fontSize(5.9).fillColor(WHITE)
        .text(sizes, x + pad, y + mm(30.1), {
          width: innerW,
          height: mm(3.8),
          align: 'center',
          ellipsis: true,
          lineBreak: false,
        });
    }
    const usePromo = item.promotionalPrice != null && item.promotionalPrice < (item.price || Infinity);
    const value = usePromo ? item.promotionalPrice : item.price;
    if (value != null) {
      const fitPriceFont = (text, font, maxSize, minSize) => {
        for (let size = maxSize; size >= minSize; size -= 0.25) {
          doc.font(font).fontSize(size);
          if (doc.widthOfString(text) <= innerW) return size;
        }
        return minSize;
      };
      if (usePromo && item.price != null) {
        const oldPriceText = `DE ${fmtBRL(item.price)}`;
        const oldPriceY = y + mm(33.4);
        const oldPriceSize = fitPriceFont(oldPriceText, FONT_CLASSIC_SEMIBOLD, 16.5, 12.5);
        doc.font(FONT_CLASSIC_SEMIBOLD).fontSize(oldPriceSize).fillColor(WHITE)
          .text(oldPriceText, x + pad, oldPriceY, { width: innerW, align: 'center', lineBreak: false });
        // Risco explícito no centro do texto: não depende do suporte do
        // PDFKit à opção strike e permanece visível na impressão.
        const oldPriceWidth = Math.min(innerW, doc.widthOfString(oldPriceText));
        const oldPriceX = x + (w - oldPriceWidth) / 2;
        const oldPriceLineY = oldPriceY + oldPriceSize * 0.72;
        doc.save().strokeColor(WHITE).lineWidth(0.9)
          .moveTo(oldPriceX, oldPriceLineY)
          .lineTo(oldPriceX + oldPriceWidth, oldPriceLineY)
          .stroke().restore();
        const finalPriceText = `POR ${fmtBRL(value)}`;
        const finalPriceSize = fitPriceFont(finalPriceText, FONT_CLASSIC_BOLD, 19.5, 14.2);
        doc.font(FONT_CLASSIC_BOLD).fontSize(finalPriceSize).fillColor(WHITE)
          .text(finalPriceText, x + pad, y + mm(39.6), {
            width: innerW,
            align: 'center',
            lineBreak: false,
          });
      } else {
        const finalPriceText = fmtBRL(value);
        const finalPriceSize = fitPriceFont(finalPriceText, FONT_CLASSIC_BOLD, 20, 14.2);
        doc.font(FONT_CLASSIC_BOLD).fontSize(finalPriceSize).fillColor(WHITE)
          .text(finalPriceText, x + pad, y + mm(39.6), {
            width: innerW,
            align: 'center',
            lineBreak: false,
          });
      }
    }
    if (promotionText && usePromo) {
      const offer = promotionText.toUpperCase();
      const percentMatch = offer.match(/(\d+)\s*%/);
      const calculatedPercent = Number.isFinite(Number(item.price)) && Number(item.price) > 0
        ? Math.round((1 - Number(value) / Number(item.price)) * 100)
        : null;
      const percent = percentMatch ? percentMatch[1] : calculatedPercent;
      const discountLine = percent ? `COM ${percent}% DE DESCONTO` : 'COM DESCONTO';
      const conditionMatch = offer.match(/LEVANDO\s+(.+)/i);
      const conditionLine = conditionMatch ? `LEVANDO ${conditionMatch[1]}` : 'LEVANDO 3 PRODUTOS';

      // Vincula visualmente a porcentagem ao preço final, em vez de deixar
      // uma frase promocional solta no rodapé da etiqueta.
      doc.font(FONT_CLASSIC_BOLD).fontSize(7.2).fillColor(WHITE)
        .text(discountLine, x + pad, y + h - mm(22.5), {
          width: innerW,
          height: mm(2.6),
          align: 'center',
          lineBreak: false,
          ellipsis: false,
        });
      const conditionFs = fitSingleLineFont(conditionLine, FONT_CLASSIC_SEMIBOLD, 5.9, 4.2);
      doc.font(FONT_CLASSIC_SEMIBOLD).fontSize(conditionFs).fillColor(WHITE)
        .text(conditionLine, x + pad, y + h - mm(19.7), {
          width: innerW,
          height: mm(2.4),
          align: 'center',
          lineBreak: false,
          ellipsis: false,
        });
    }
    if (motivationText) {
      const phraseBoxY = y + h - mm(14);
      const phraseBoxH = mm(8.6);
      let phraseFs = 7.4;
      for (; phraseFs >= 6.2; phraseFs -= 0.2) {
        doc.font(FONT_CLASSIC_BOLD).fontSize(phraseFs);
        if (doc.heightOfString(motivationText, { width: innerW, align: 'center' }) <= phraseBoxH) break;
      }
      doc.font(FONT_CLASSIC_BOLD).fontSize(Math.max(6.2, phraseFs)).fillColor(WHITE);
      const phraseHeight = Math.min(
        phraseBoxH,
        doc.heightOfString(motivationText, { width: innerW, align: 'center' }),
      );
      doc.text(motivationText, x + pad, phraseBoxY + (phraseBoxH - phraseHeight) / 2, {
        width: innerW,
        height: phraseBoxH,
        align: 'center',
        ellipsis: false,
      });
    }
    return;
  }

  // QR e código interno compartilham um único painel de leitura.
  const qrPunchClearance = mm(10);
  const qrHeading = 'CONSULTE MAIS INFORMAÇÕES';
  const qrHeadingFs = fitSingleLineFont(qrHeading, FONT_CLASSIC_BOLD, 7.4, 4.2);
  centered(qrHeading, qrHeadingFs, y + qrPunchClearance + mm(1.8), {
    height: mm(4.5),
    ellipsis: false,
    lineBreak: false,
  });
  const scanX = x + mm(4);
  const scanY = y + mm(18.5);
  const scanW = w - mm(8);
  const scanH = mm(41);
  doc.save().roundedRect(scanX, scanY, scanW, scanH, mm(1.4)).fillColor(WHITE).fill().restore();
  const qrSize = mm(24.5);
  const qrX = x + (w - qrSize) / 2;
  const qrY = y + mm(19.2);
  if (item.qrCodeValue) item._qrPos = { x: qrX, y: qrY, size: qrSize };
  if (item.internalBarcode) {
    drawBarcode128(doc, item.internalBarcode, scanX + mm(2.5), y + mm(45.4), scanW - mm(5), mm(10.8), {
      color: '#000000',
      caption: 'INTERNO',
      captionSize: 4.5,
    });
  }
  doc.font(FONT_CLASSIC_SEMIBOLD).fontSize(6.2).fillColor(WHITE)
    .text('APONTE A CÂMERA  •  CONFIRA', x + pad, y + h - mm(6.2), {
      width: innerW,
      align: 'center',
      lineBreak: false,
    });
}

// Etiqueta 5x7 em uma unica peca fisica por produto.
// Frente: marca, descricao, preco e garantia.
// Verso: loja, codigo de barras e QR Code.
function drawProductSingleDuplex(doc, item, template, x, y, w, h, side) {
  const CREAM = '#F6F0E5';
  const CHARCOAL = '#191A18';
  const ORANGE = PRODUCT_ORANGE_RGB;
  const WHITE = '#FFFFFF';
  const MUTED = '#716B62';
  const FONT_MEDIUM = doc._tenisLabelFonts ? 'TenisInterMedium' : 'Helvetica';
  const FONT_BOLD = doc._tenisLabelFonts ? 'TenisInterBold' : 'Helvetica-Bold';
  const pad = mm(3);
  const innerW = w - pad * 2;

  const fitSingleLine = (text, font, maxSize, minSize, maxWidth = innerW) => {
    for (let size = maxSize; size >= minSize; size -= 0.2) {
      doc.font(font).fontSize(size);
      if (doc.widthOfString(String(text || '')) <= maxWidth) return size;
    }
    return minSize;
  };

  if (side === 'front') {
    // Os 10 mm superiores ficam livres para o furo.
    const brandTop = y + mm(10.8);
    const brandBottom = y + mm(22.4);
    doc.save();
    // Faixa reta de ponta a ponta. O recorte diagonal anterior parecia uma
    // falha de impressão quando duas etiquetas ficavam lado a lado.
    doc.fillColor(ORANGE).rect(x, brandTop, w, brandBottom - brandTop).fill();
    doc.restore();

    const _drawBrandText = () => {
      const brandText = String(item.brand || 'MARCA').toUpperCase();
      const brandFs = fitSingleLine(brandText, FONT_BOLD, 12, 7.5, w - mm(10));
      doc.font(FONT_BOLD).fontSize(brandFs).fillColor(WHITE)
        .text(brandText, x + mm(5), brandTop + mm(3.1), {
          width: w - mm(10),
          align: 'center',
          lineBreak: false,
        });
    };
    if (item._brandLogoBuffer) {
      try {
        drawImageContain(doc, item._brandLogoBuffer, x + mm(5), brandTop + mm(1.1), w - mm(10), mm(8.8));
      } catch { _drawBrandText(); }
    } else {
      _drawBrandText(); // marca sem logo cadastrada → nome da marca em texto (ex: Detony)
    }

    let productName = String(item.productName || item.name || '').trim().toUpperCase();
    const descriptionY = y + mm(23.4);
    const descriptionH = mm(12.4);
    const descriptionFitH = descriptionH - mm(0.8);
    const productWords = productName.split(/\s+/).filter(Boolean);
    const requiredPrefixWords = Math.min(
      productWords.length,
      1 + String(item.brand || '').trim().split(/\s+/).filter(Boolean).length,
    );
    doc.font(FONT_BOLD).fontSize(8);
    while (productWords.length > Math.max(2, requiredPrefixWords) && doc.heightOfString(productWords.join(' '), {
      width: innerW,
      align: 'left',
      lineGap: -0.4,
    }) > descriptionFitH) {
      productWords.pop();
    }
    productName = productWords.join(' ');
    let descriptionFs = 11.6;
    for (; descriptionFs >= 8; descriptionFs -= 0.2) {
      doc.font(FONT_BOLD).fontSize(descriptionFs);
      if (doc.heightOfString(productName, {
        width: innerW,
        align: 'left',
        lineGap: -0.4,
      }) <= descriptionFitH) break;
    }
    doc.font(FONT_BOLD).fontSize(Math.max(8, descriptionFs)).fillColor(CHARCOAL)
      .text(productName, x + pad, descriptionY, {
        width: innerW,
        height: descriptionH,
        align: 'left',
        lineGap: -0.4,
        ellipsis: false,
      });

    const category = String(item.categoryLabel || item.category || '').trim().toUpperCase();
    if (category) {
      const categoryFs = fitSingleLine(category, FONT_BOLD, 6.8, 4.8);
      doc.font(FONT_BOLD).fontSize(categoryFs).fillColor(ORANGE)
        .text(category, x + pad, y + mm(36.1), {
          width: innerW,
          height: mm(3.2),
          lineBreak: false,
        });
    }

    const color = String(item.color || '').trim().toUpperCase();
    const sizes = String(item.availableSizes || '').trim();
    const productDetails = [
      color ? `COR: ${color}` : '',
      sizes ? `TAM: ${sizes}` : '',
    ].filter(Boolean).join('  •  ');
    if (productDetails) {
      const detailsFs = fitSingleLine(productDetails, FONT_MEDIUM, 5.8, 4.2);
      doc.font(FONT_MEDIUM).fontSize(detailsFs).fillColor(MUTED)
        .text(productDetails, x + pad, y + mm(39.1), {
          width: innerW,
          height: mm(2.8),
          lineBreak: false,
          ellipsis: true,
        });
    }

    const usePromo = item.promotionalPrice != null
      && Number(item.promotionalPrice) < Number(item.price || Infinity);
    const value = usePromo ? Number(item.promotionalPrice) : Number(item.price);
    if (Number.isFinite(value)) {
      if (usePromo && Number.isFinite(Number(item.price))) {
        const oldPrice = `PREÇO NORMAL ${fmtBRL(item.price)}`;
        const oldFs = fitSingleLine(oldPrice, FONT_BOLD, 8.8, 6.8);
        const oldY = y + mm(42);
        doc.font(FONT_BOLD).fontSize(oldFs).fillColor(CHARCOAL)
          .text(oldPrice, x + pad, oldY, {
            width: innerW,
            align: 'left',
            lineBreak: false,
          });
      }
      const priceText = fmtBRL(value);
      const priceFs = fitSingleLine(priceText, FONT_BOLD, 22, 15.5);
      doc.font(FONT_BOLD).fontSize(priceFs).fillColor(ORANGE)
        .text(priceText, x + pad, y + mm(45.2), {
          width: innerW,
          height: mm(8.5),
          align: 'left',
          lineBreak: false,
        });
    }

    if (usePromo && item.promotionText) {
      const offer = String(item.promotionText).toUpperCase();
      const percentMatch = offer.match(/(\d+)\s*%/);
      const percent = percentMatch ? percentMatch[1] : null;
      const conditionMatch = offer.match(/LEVANDO\s+(.+?)(?:\.|$)/i);
      const offerHeadline = percent ? `PREÇO COM ${percent}% OFF` : 'PREÇO PROMOCIONAL';
      const offerFs = fitSingleLine(offerHeadline, FONT_BOLD, 6.0, 5.0);
      doc.font(FONT_BOLD).fontSize(offerFs).fillColor(ORANGE)
        .text(offerHeadline, x + pad, y + mm(54.3), {
          width: innerW,
          height: mm(2.6),
          lineBreak: false,
        });
      if (conditionMatch) {
        const conditionText = `LEVANDO ${conditionMatch[1]}`;
        const conditionFs = fitSingleLine(conditionText, FONT_BOLD, 5.4, 4.6);
        // Mais respiro entre as duas linhas (antes 54.7→57 = ~2.3mm, coladas). Agora ~3.5mm.
        doc.font(FONT_BOLD).fontSize(conditionFs).fillColor(CHARCOAL)
          .text(conditionText, x + pad, y + mm(57.8), {
            width: innerW,
            height: mm(2.5),
            lineBreak: false,
          });
      }
    }

    const warrantyText = String(item.guaranteeText || 'PRODUTO ORIGINAL E GARANTIA.').toUpperCase();
    doc.save().strokeColor(ORANGE).lineWidth(mm(0.45))
      .moveTo(x + pad, y + mm(60.8))
      .lineTo(x + w - pad, y + mm(60.8))
      .stroke().restore();

    doc.save().fillColor(ORANGE)
      .rect(x + pad, y + mm(63.2), mm(0.75), mm(3.1))
      .fill().restore();
    const warrantyFs = fitSingleLine(warrantyText, FONT_BOLD, 6.4, 5.1, innerW - mm(2.2));
    doc.font(FONT_BOLD).fontSize(warrantyFs).fillColor(CHARCOAL)
      .text(warrantyText, x + pad + mm(2.2), y + mm(63.05), {
        width: innerW - mm(2.2),
        height: mm(3.8),
        lineBreak: false,
      });
    return;
  }

  // Verso: os 10 mm superiores continuam livres para o mesmo furo.
  const storeTop = y + mm(10.6);
  // Os recortes oficiais (ícone + wordmark) têm pesos visuais diferentes.
  // O pequeno ajuste óptico coloca a composição no mesmo eixo da logo frontal,
  // do QR Code e do cartão de leitura depois que a etiqueta é cortada.
  const storeLogoOpticalOffsetX = mm(0.6);
  if (item._storeLogoIconBuffer || item._storeLogoWordmarkBuffer || item._storeLogoBuffer) {
    try {
      if (item._storeLogoIconBuffer && item._storeLogoWordmarkBuffer) {
        drawImageContain(doc, item._storeLogoIconBuffer, x + mm(4) + storeLogoOpticalOffsetX, storeTop, mm(11), mm(12.2));
        drawImageContain(doc, item._storeLogoWordmarkBuffer, x + mm(16) + storeLogoOpticalOffsetX, storeTop + mm(2.1), mm(30), mm(8));
      } else if (item._storeLogoBuffer) {
        drawImageContain(doc, item._storeLogoBuffer, x + mm(5), storeTop, w - mm(10), mm(12));
      }
    } catch {
      const fallback = String(item.storeName || 'SPORTS & TENNIS').toUpperCase();
      const fallbackFs = fitSingleLine(fallback, FONT_BOLD, 10, 6.5);
      doc.font(FONT_BOLD).fontSize(fallbackFs).fillColor(WHITE)
        .text(fallback, x + pad, storeTop + mm(3), {
          width: innerW,
          align: 'center',
          lineBreak: false,
        });
    }
  }

  const scanX = x + mm(4);
  const scanY = y + mm(25.7);
  const scanW = w - mm(8);
  const scanH = mm(40.8);
  doc.save().roundedRect(scanX, scanY, scanW, scanH, mm(1.5)).fillColor(CREAM).fill().restore();

  const qrSize = mm(23.2);
  const qrX = x + (w - qrSize) / 2;
  const qrY = y + mm(26.4);
  if (item.qrCodeValue) item._qrPos = { x: qrX, y: qrY, size: qrSize };
  if (item.internalBarcode) {
    const color = String(item.color || '').trim().toUpperCase();
    const colorDetail = String(item.colorDetail || color).trim().toUpperCase();
    const barcodeCaption = `INTERNO: ${item.internalBarcode}${colorDetail ? `  •  COR: ${colorDetail}` : ''}`;
    const captionSize = fitSingleLine(barcodeCaption, FONT_MEDIUM, 4.6, 3.6, scanW - mm(6));
    drawBarcode128(doc, item.internalBarcode, scanX + mm(3), y + mm(53.7), scanW - mm(6), mm(9.6), {
      color: '#000000',
      captionText: barcodeCaption,
      captionSize,
    });
  }
}

// Etiqueta SALDO 5x7 duplex e totalmente separada do modelo de produto.
// Frente e verso recebem um padrão repetido somente com SALDO em branco.
function drawSaldoLabel(doc, item, template, x, y, w, h) {
  const orange = template?.layoutConfig?.backgroundHex || '#E5571E';
  const font = doc._tenisLabelFonts ? 'TenisInterBold' : 'Helvetica-Bold';
  const columns = Math.max(1, Number(template?.layoutConfig?.saldoRepeatColumns || 2));
  const rows = Math.max(1, Number(template?.layoutConfig?.saldoRepeatRows || 5));
  const cellW = w / columns;
  const cellH = h / rows;
  const fontSize = Number(template?.layoutConfig?.saldoFontSize || 14);
  doc.rect(x, y, w, h).fillColor(orange).fill();
  doc.font(font).fontSize(fontSize).fillColor('#FFFFFF');
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      doc.text('SALDO', x + column * cellW, y + row * cellH + (cellH - fontSize) / 2 - 1, {
        width: cellW,
        height: cellH,
        align: 'center',
        lineBreak: false,
      });
    }
  }
}

function drawFourSideCutMarks(doc, template, geometry) {
  const cmyk = template?.layoutConfig?.backgroundCmyk || FOUR_SIDE_ORANGE_CMYK;
  const orange = [Number(cmyk.c || 0), Number(cmyk.m || 80), Number(cmyk.y || 100), Number(cmyk.k || 0)];
  const {
    labelW,
    labelH,
    gapX,
    gapY,
    marginX,
    marginY,
    cols,
    rows,
  } = geometry;
  const gridRight = marginX + cols * labelW + Math.max(0, cols - 1) * gapX;
  const gridBottom = marginY + rows * labelH + Math.max(0, rows - 1) * gapY;
  // Os traços ficam visíveis somente no papel branco, fora das etiquetas.
  // O comprimento maior facilita alinhar a régua/navalha pelos dois lados.
  const markLength = mm(5);
  const fixedSingleDuplexCutPlan = isSingleProductDuplexTemplate(template);
  const configuredSafeGapMm = Number(template?.layoutConfig?.cutMarkSafeGapMm);
  const safeGapMm = fixedSingleDuplexCutPlan
    ? 0.35
    : Number.isFinite(configuredSafeGapMm)
    ? configuredSafeGapMm
    : 0.35;
  const edgeGap = mm(safeGapMm);
  const pageW = doc.page.width;
  const pageH = doc.page.height;

  const verticalCuts = [];
  for (let col = 0; col < cols; col += 1) {
    verticalCuts.push(marginX + col * (labelW + gapX));
    verticalCuts.push(marginX + col * (labelW + gapX) + labelW);
  }
  const horizontalCuts = [];
  for (let row = 0; row < rows; row += 1) {
    horizontalCuts.push(marginY + row * (labelH + gapY));
    horizontalCuts.push(marginY + row * (labelH + gapY) + labelH);
  }
  const uniqueVerticalCuts = [...new Set(verticalCuts.map((value) => Number(value.toFixed(3))))];
  const uniqueHorizontalCuts = [...new Set(horizontalCuts.map((value) => Number(value.toFixed(3))))];

  // Marcas externas laranja continuam sobre as margens brancas.
  doc.save().strokeColor(orange).lineWidth(1).lineCap('butt');
  uniqueVerticalCuts.forEach((x) => {
    if (marginY > edgeGap) {
      doc.moveTo(x, Math.max(0, marginY - markLength))
        .lineTo(x, Math.max(0, marginY - edgeGap))
        .stroke();
    }
    if (gridBottom < pageH - edgeGap) {
      doc.moveTo(x, Math.min(pageH, gridBottom + edgeGap))
        .lineTo(x, Math.min(pageH, gridBottom + markLength))
        .stroke();
    }
  });
  uniqueHorizontalCuts.forEach((y) => {
    if (marginX > edgeGap) {
      doc.moveTo(Math.max(0, marginX - markLength), y)
        .lineTo(Math.max(0, marginX - edgeGap), y)
        .stroke();
    }
    if (gridRight < pageW - edgeGap) {
      doc.moveTo(Math.min(pageW, gridRight + edgeGap), y)
        .lineTo(Math.min(pageW, gridRight + markLength), y)
        .stroke();
    }
  });
  doc.restore();

  // Cada encontro da grade recebe uma unica cruz laranja centralizada,
  // compartilhada pelas quatro etiquetas ao redor. Nao ha linhas longas
  // sobre a arte.
  const configuredInteriorMarks = template?.layoutConfig?.cutMarksInsideArtwork;
  const includeInteriorMarks = fixedSingleDuplexCutPlan
    ? true
    : configuredInteriorMarks == null
    ? !isSingleProductDuplexTemplate(template)
    : configuredInteriorMarks === true;
  if (!includeInteriorMarks) return;

  const centeredMarkArm = mm(1.8);
  doc.save().strokeColor(orange).lineWidth(mm(0.18)).lineCap('butt');
  uniqueVerticalCuts.forEach((cutX) => {
    uniqueHorizontalCuts.forEach((cutY) => {
      doc.moveTo(Math.max(0, cutX - centeredMarkArm), cutY)
        .lineTo(Math.min(pageW, cutX + centeredMarkArm), cutY)
        .stroke();
      doc.moveTo(cutX, Math.max(0, cutY - centeredMarkArm))
        .lineTo(cutX, Math.min(pageH, cutY + centeredMarkArm))
        .stroke();
    });
  });
  doc.restore();
}

function drawLabelCutContours(doc, template, geometry) {
  const {
    labelW,
    labelH,
    gapX,
    gapY,
    marginX,
    marginY,
    cols,
    rows,
  } = geometry;
  const gridRight = marginX + cols * labelW + Math.max(0, cols - 1) * gapX;
  const gridBottom = marginY + rows * labelH + Math.max(0, rows - 1) * gapY;
  const verticalCuts = [];
  const horizontalCuts = [];
  for (let col = 0; col < cols; col += 1) {
    verticalCuts.push(marginX + col * (labelW + gapX));
    verticalCuts.push(marginX + col * (labelW + gapX) + labelW);
  }
  for (let row = 0; row < rows; row += 1) {
    horizontalCuts.push(marginY + row * (labelH + gapY));
    horizontalCuts.push(marginY + row * (labelH + gapY) + labelH);
  }
  const uniqueVerticalCuts = [...new Set(verticalCuts.map((value) => Number(value.toFixed(3))))];
  const uniqueHorizontalCuts = [...new Set(horizontalCuts.map((value) => Number(value.toFixed(3))))];

  // Linhas finas laranja formam o contorno completo de cada etiqueta 5x7.
  // A grade aparece sobre a arte nos dois lados e indica exatamente onde cortar.
  const contourColor = template?.layoutConfig?.cutContourColor || '#FF8A3D';
  doc.save().strokeColor(contourColor).lineWidth(mm(0.18)).lineCap('butt');
  uniqueVerticalCuts.forEach((x) => {
    doc.moveTo(x, marginY).lineTo(x, gridBottom).stroke();
  });
  uniqueHorizontalCuts.forEach((y) => {
    doc.moveTo(marginX, y).lineTo(gridRight, y).stroke();
  });
  doc.restore();
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
  if (t.showBarcode !== false && item.internalBarcode) {
    const barW = t.showQRCode ? innerW * 0.7 : innerW;
    drawBarcode128(doc, item.internalBarcode, padX, footerY, barW, footerH, { caption: 'INTERNO', captionSize: 4.6 });
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
async function generateLabelsPDF({ template, items, storeName, storeLogoUrl, offsetX = 0, offsetY = 0 }) {
  const t = template;
  const paperSize = t.paperSize || 'A4';
  const layoutW = paperSize === 'A4' ? 'A4' : [mm(t.widthMm), mm(t.heightMm)];
  const duplex = isDuplexTemplate(t);
  const fourSide = isFourSideProductTemplate(t);
  const singleDuplex = isSingleProductDuplexTemplate(t);
  const productDuplex = isProductDuplexTemplate(t);
  const saldo = isSaldoTemplate(t);

  const doc = new PDFDocument({
    size: layoutW,
    margins: { top: 0, left: 0, right: 0, bottom: 0 },
    bufferPages: true, // permite switchToPage no segundo pass dos QRs
  });
  doc._tenisLabelFonts = (productDuplex || saldo) && registerLabelFonts(doc);
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

  if (productDuplex && storeLogoUrl) {
    const logoParts = await loadStoreLogoParts(storeLogoUrl);
    if (logoParts.icon) flat.forEach((item) => { item._storeLogoIconBuffer = logoParts.icon; });
    if (logoParts.wordmark) flat.forEach((item) => { item._storeLogoWordmarkBuffer = logoParts.wordmark; });
    if (logoParts.full) flat.forEach((item) => { item._storeLogoBuffer = logoParts.full; });
  }
  if (productDuplex) {
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
  // offsetX/offsetY (mm) = ajuste de alinhamento na impressora: desloca a GRADE toda
  // (conteúdo + QR + marcas de corte juntos, pois tudo deriva daqui). Limite ±15mm.
  const _ox = Math.max(-15, Math.min(15, Number(offsetX) || 0));
  const _oy = Math.max(-15, Math.min(15, Number(offsetY) || 0));
  const marginX = mm((t.marginLeftMm || 0) + _ox);
  const marginY = mm((t.marginTopMm || 0) + _oy);
  const cols = t.columns || 1;
  const rows = t.rows || 1;
  const perPage = cols * rows;

  const qrJobs = []; // {item, x, y, size, pageIndex}
  let currentPageIndex = 0;

  function drawPage(pageItems, pageIndex, pageSide) {
    const slotPosition = (slot) => {
      const rawCol = slot % cols;
      const rawRow = Math.floor(slot / cols);
      // No duplex pela borda longa, o verso precisa ser espelhado na
      // horizontal para cair atrás da mesma etiqueta ao virar a folha.
      // Para uma configuração pela borda curta, o espelho é vertical.
      const flipBack = pageSide === 'back' && duplex;
      const flipLongEdge = t.layoutConfig?.duplexBinding !== 'short-edge';
      const col = flipBack && flipLongEdge ? cols - 1 - rawCol : rawCol;
      const row = flipBack && !flipLongEdge ? rows - 1 - rawRow : rawRow;
      const configuredBackOffsetX = Number(t.layoutConfig?.backPrintOffsetXMm);
      const backPrintOffsetXMm = Number.isFinite(configuredBackOffsetX)
        ? configuredBackOffsetX
        : (singleDuplex ? -1.5 : 0);
      const x = marginX + col * (labelW + gapX)
        + (flipBack && singleDuplex ? mm(backPrintOffsetXMm) : 0);
      const y = marginY + row * (labelH + gapY);
      return { x, y };
    };

    if (productDuplex) {
      // Frente e verso recebem fundo até além da linha de corte. Assim, um
      // pequeno desvio humano não revela uma borda branca. Todos os retângulos
      // formam um único caminho para não sobrepor tinta nem criar faixas.
      const cmyk = t.layoutConfig?.backgroundCmyk || FOUR_SIDE_ORANGE_CMYK;
      const legacyBackgroundOrange = [Number(cmyk.c || 0), Number(cmyk.m || 80), Number(cmyk.y || 100), Number(cmyk.k || 0)];
      const productBackgroundOrange = String(t.layoutConfig?.backgroundHex || PRODUCT_ORANGE_RGB);
      const background = singleDuplex
        ? (pageSide === 'back' ? productBackgroundOrange : '#F6F0E5')
        : legacyBackgroundOrange;
      const bleedMm = pageSide === 'back'
        ? Number(t.layoutConfig?.backBleedMm || FOUR_SIDE_BACK_BLEED_MM)
        : FOUR_SIDE_FRONT_BLEED_MM;
      const bleed = mm(bleedMm);
      doc.save();
      const fullPageBack = singleDuplex
        && pageSide === 'back'
        && t.layoutConfig?.backFullPageBackground !== false;
      if (fullPageBack) {
        const configuredOverscanMm = Number(t.layoutConfig?.backBackgroundOverscanMm);
        const overscan = mm(Number.isFinite(configuredOverscanMm) ? configuredOverscanMm : 10);
        const stopInOuterBleed = t.layoutConfig?.backBackgroundStopsInOuterBleed !== false;
        const gridBottom = marginY + rows * labelH + Math.max(0, rows - 1) * gapY;
        const backgroundTop = stopInOuterBleed
          ? Math.max(0, marginY - bleed)
          : -overscan;
        const backgroundBottom = stopInOuterBleed
          ? Math.min(doc.page.height, gridBottom + bleed)
          : doc.page.height + overscan;
        const backgroundWidth = doc.page.width + overscan * 2;
        const backgroundHeight = backgroundBottom - backgroundTop;
        if (t.layoutConfig?.backBackgroundRenderMode !== 'vector-rgb') {
          doc.image(
            openImageCached(doc, PRODUCT_ORANGE_RGB_TILE),
            -overscan,
            backgroundTop,
            { width: backgroundWidth, height: backgroundHeight },
          );
        } else {
          doc.fillColor(background).rect(
            -overscan,
            backgroundTop,
            backgroundWidth,
            backgroundHeight,
          ).fill();
        }
      } else {
        doc.fillColor(background);
        pageItems.forEach((item, slot) => {
          const { x, y } = slotPosition(slot);
          doc.rect(x - bleed, y - bleed, labelW + bleed * 2, labelH + bleed * 2);
        });
        doc.fill();
      }
      doc.restore();
    }

    pageItems.forEach((item, slot) => {
      const { x, y } = slotPosition(slot);
      doc.save();
      // Layout S&T: fundo laranja sólido (145mm × 25mm; formatos anteriores suportados)
      const isST = isSTHorizontalTemplate(t);
      if (saldo) {
        drawSaldoLabel(doc, item, t, x, y, labelW, labelH);
      } else if (singleDuplex) {
        drawProductSingleDuplex(
          doc,
          item,
          t,
          x,
          y,
          labelW,
          labelH,
          pageSide === 'back' ? 'back' : 'front',
        );
      } else if (fourSide) {
        const side = pageSide === 'front'
          ? (item._pairSlot === 1 ? 'details' : 'brand')
          : (item._pairSlot === 1 ? 'qr' : 'store');
        drawProductFourSide(doc, item, t, x, y, labelW, labelH, side);
      } else if (isST) {
        doc.rect(x, y, labelW, labelH).fillColor('#E5571E').fill();
      } else {
        doc.rect(x, y, labelW, labelH).lineWidth(0.5).strokeColor('#ddd').stroke();
      }
      if (!productDuplex && storeName && t.showStore) {
        doc.fontSize(6).fillColor(isST ? '#FFFFFF' : '#aaa').text(storeName, x + mm(1), y + mm(1));
      }
      // Frente e verso usam a mesma grade e os mesmos itens para manter o alinhamento.
      if (!productDuplex && !saldo) drawLabelContent(doc, item, t, x, y, labelW, labelH);
      if (item._qrPos) {
        qrJobs.push({ item, pageIndex, ...item._qrPos });
        delete item._qrPos;
      }
      doc.restore();
    });
    // O modelo SALDO preserva as guias nos dois lados para que frente e costas
    // possam ser cortadas pela mesma grade depois da impressão duplex.
    const cutMarksOnThisSide = pageSide !== 'back'
      || t.layoutConfig?.cutMarksOnBothSides === true;
    if ((productDuplex || saldo) && cutMarksOnThisSide) {
      const cutGeometry = {
        labelW,
        labelH,
        gapX,
        gapY,
        marginX,
        marginY,
        cols,
        rows,
      };
      drawFourSideCutMarks(doc, t, cutGeometry);
      if (saldo && t.layoutConfig?.cutContourEachLabel === true) {
        drawLabelCutContours(doc, t, cutGeometry);
      }
    }
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
  isSingleProductDuplexTemplate,
  isProductDuplexTemplate,
  isSaldoTemplate,
};
