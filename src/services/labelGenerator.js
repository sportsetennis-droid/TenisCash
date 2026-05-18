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

const MM_TO_PT = 2.83464567; // 1mm = 2.83464567pt

function mm(x) { return x * MM_TO_PT; }

function defaultTemplates() {
  return {
    st_13x20: {
      type: 'PRODUCT',
      name: 'S&T Etiqueta 13x2cm (13 por A4)',
      paperSize: 'A4',
      widthMm: 130,
      heightMm: 20,
      columns: 1,
      rows: 13,
      marginTopMm: 13,
      marginLeftMm: 40,
      gapHorizontalMm: 0,
      gapVerticalMm: 0,
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
function drawFakeBarcode(doc, value, x, y, w, h) {
  const code = String(value || '').slice(0, 32);
  if (!code) return;
  const usable = w;
  const barCount = Math.min(60, Math.max(20, code.length * 4));
  const barWidth = usable / barCount;
  doc.save();
  doc.fillColor('#000');
  for (let i = 0; i < barCount; i++) {
    // Pseudo-aleatório determinístico do código
    const c = code.charCodeAt(i % code.length);
    const isBar = ((c + i * 7) % 3) !== 0;
    if (isBar) {
      doc.rect(x + i * barWidth, y, barWidth * 0.75, h * 0.75).fill();
    }
  }
  doc.restore();
  doc.fontSize(6).fillColor('#000').text(code, x, y + h * 0.78, { width: usable, align: 'center' });
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

// ===== Layout HORIZONTAL S&T (130mm × 15-27mm) — FUNDO LARANJA =====
// Fundo: laranja (#FF6D00) pintado em generateLabelsPDF antes desta função
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

  // Zona do preço — destaque grande, branco bold
  const priceW = mm(36);
  const priceX = qrCardX - priceW - mm(1.5);
  const textW = priceX - x - padX - mm(1.5);

  const isTall = h >= mm(18);
  const yOffset = isTall ? mm(1.8) : mm(1);
  const lineGap = isTall ? mm(9) : mm(6);

  // Helper: trunca string respeitando limite de chars (com … no fim)
  const truncate = (s, max) => {
    const t = String(s || '');
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };

  // ===== NOME (linha 1) — branco bold, truncado pra caber numa linha só
  // Em 11pt bold sobre ~70mm de largura → ~36-40 chars cabem
  const rawName = String(item.name || '').toUpperCase();
  const nameFs = isTall ? 11 : 8;
  const nameMaxChars = isTall ? 38 : 50;
  const name = truncate(rawName, nameMaxChars);
  doc.fontSize(nameFs).fillColor(WHITE).font('Helvetica-Bold')
    .text(name, x + padX, y + yOffset, { width: textW, height: nameFs * 1.3, ellipsis: true, lineBreak: false });

  // ===== TAGS (linha 2): REF • Gen • Cat • Mod • Esp — branco regular, truncada
  const ref = String(item.supplierRef || item.sku || '').toUpperCase();
  const rawTags = [
    ref ? 'REF ' + ref : null,
    item.gender || null,
    item.category || null,
    item.modality || null,
    item.tier || null,
  ].filter(Boolean).join(' • ');
  const tagFs = isTall ? 8 : 6.5;
  const tagMaxChars = isTall ? 60 : 75;
  const tags = truncate(rawTags, tagMaxChars);
  doc.fontSize(tagFs).fillColor(WHITE).font('Helvetica')
    .text(tags, x + padX, y + yOffset + lineGap, { width: textW, height: tagFs * 1.3, ellipsis: true, lineBreak: false });

  // ===== PREÇO (centro) — branco, MUITO grande, destaque máximo
  const usePromo = item.promotionalPrice != null && item.promotionalPrice < (item.price || Infinity);
  const showPrice = usePromo ? item.promotionalPrice : item.price;
  if (showPrice != null) {
    const priceFs = isTall ? 20 : 14;
    if (usePromo && item.price) {
      doc.fontSize(7).fillColor(WHITE).font('Helvetica')
        .text(fmtBRL(item.price), priceX, y + yOffset, { width: priceW, align: 'center', strike: true });
      doc.fontSize(priceFs).fillColor(WHITE).font('Helvetica-Bold')
        .text(fmtBRL(showPrice), priceX, y + yOffset + mm(4.5), { width: priceW, align: 'center', lineBreak: false });
    } else {
      // Centraliza verticalmente o preço
      const priceY = y + (h - priceFs * 0.7) / 2 - mm(0.5);
      doc.fontSize(priceFs).fillColor(WHITE).font('Helvetica-Bold')
        .text(fmtBRL(showPrice), priceX, priceY, { width: priceW, align: 'center', lineBreak: false });
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

function drawLabelContent(doc, item, template, x, y, w, h) {
  const t = template;
  // Detecta layout S&T (largura 130mm + altura 15-27mm) → usa horizontal com QR
  if (Math.round(t.widthMm) === 130 && t.heightMm >= 14 && t.heightMm <= 27) {
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
      doc.fontSize(34).fillColor('#FF6D00')
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
        doc.fontSize(12).fillColor('#FF6D00')
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
async function generateLabelsPDF({ template, items, storeName }) {
  const t = template;
  const paperSize = t.paperSize || 'A4';
  const layoutW = paperSize === 'A4' ? 'A4' : [mm(t.widthMm), mm(t.heightMm)];

  const doc = new PDFDocument({
    size: layoutW,
    margins: { top: 0, left: 0, right: 0, bottom: 0 },
    bufferPages: true, // permite switchToPage no segundo pass dos QRs
  });
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
    for (let i = 0; i < q; i++) flat.push({ ...it });
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

  for (let i = 0; i < flat.length; i++) {
    if (i > 0 && i % perPage === 0) {
      doc.addPage({ size: layoutW, margins: { top: 0, left: 0, right: 0, bottom: 0 } });
      currentPageIndex++;
    }
    const slot = i % perPage;
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const x = marginX + col * (labelW + gapX);
    const y = marginY + row * (labelH + gapY);

    doc.save();
    // Layout S&T: fundo laranja sólido (130mm × 14-27mm)
    const isST = Math.round(t.widthMm) === 130 && t.heightMm >= 14 && t.heightMm <= 27;
    if (isST) {
      doc.rect(x, y, labelW, labelH).fillColor('#FF6D00').fill();
    } else {
      doc.rect(x, y, labelW, labelH).lineWidth(0.5).strokeColor('#ddd').stroke();
    }
    if (storeName && t.showStore) {
      doc.fontSize(6).fillColor(isST ? '#FFFFFF' : '#aaa').text(storeName, x + mm(1), y + mm(1));
    }
    drawLabelContent(doc, flat[i], t, x, y, labelW, labelH);
    if (flat[i]._qrPos) {
      qrJobs.push({ item: flat[i], pageIndex: currentPageIndex, ...flat[i]._qrPos });
      delete flat[i]._qrPos;
    }
    doc.restore();
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
};
