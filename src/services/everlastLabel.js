const path = require('path');

// Artwork approved for 5 x 7 cm labels. Product data remains specific to each item.
function drawEverlastLabel(doc, item, x, y, w, h) {
  const offer = item.paymentOffer;
  if (String(item.brand || '').trim().toUpperCase() !== 'EVERLAST'
      || !offer?.active || offer.discountPercent !== 30
      || !(offer.basePrice > 0) || !(offer.finalPrice > 0)) return false;
  const model = String(item.productName || item.name || 'EVERLAST').toUpperCase()
    .replace(/^T[ÊE]NIS\s+/, '').replace(/^EVERLAST\s+/, '')
    .split(/\s+SE[FMU]A\d|\s+ADT\b|\s+EVERLAST\b|\s+REF\b/)[0].trim();
  const climberRun = /^CLIMBER RUN$/.test(model);
  const assets = path.join(__dirname, '../../assets');
  doc.save();
  doc.translate(x, y).scale(w / 1060, h / 1484);
  doc.image(path.join(assets, 'logos/everlast-readable-template.png'), 0, 0, { width: 1060, height: 1484 });
  doc.registerFont('EverlastAnton', path.join(assets, 'fonts/Anton-Regular.ttf'));
  const bold = doc._tenisLabelFonts ? 'TenisInterBold' : 'Helvetica-Bold';
  function line(text, left, top, width, size, font, color, align = 'left') {
    doc.font(font).fontSize(size);
    while (doc.widthOfString(text) > width && size > 12) doc.fontSize(--size);
    doc.fillColor(color).text(text, left, top, { width, height: 400, lineBreak: false, align });
  }
  line(model, 55, 568, 950, 68, bold, '#FFFFFF', 'center');
  let color = String(item.color || '').toUpperCase();
  if (/D[ÚU]VIDA|N[ÃA]O [ÉE] COR|REVIS/.test(color)) {
    const source = String(item.productName || item.name || '').toUpperCase();
    color = source.match(/EVERLAST\s+((?:BRANCO|PRETO|VERDE|AZUL|ROSA|BEGE|CINZA|AMARELO|VERMELHO|LILAS|LILÁS|ROXO|DOURADO|MARROM)[A-ZÀ-Ú/ -]*?)(?:\s+\d{2}\b|\s+REF\b|$)/)?.[1]?.trim() || '';
  }
  if (climberRun) {
    // A dedicated two-line band keeps the use case readable at actual 5 x 7 cm size.
    doc.fillColor('#FFFFF5').rect(0, 687, 1060, 215).fill();
    doc.strokeColor('#EA3F0A').lineWidth(5)
      .moveTo(0, 687).lineTo(1060, 687)
      .moveTo(0, 902).lineTo(1060, 902).stroke();
    line('CAMINHADA', 55, 660, 950, 104, 'EverlastAnton', '#EA3F0A', 'center');
    line('E CORRIDA LEVE', 55, 765, 950, 104, 'EverlastAnton', '#EA3F0A', 'center');
  } else {
    line(color, 55, 718, 950, 66, 'EverlastAnton', '#EA3F0A', 'center');
  }
  const money = value => Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  line('DE R$ ' + money(offer.basePrice), 68, climberRun ? 908 : 866, 925, 68, bold, '#E93E09');
  const [whole, cents] = money(offer.finalPrice).split(',');
  line('POR', 65, 1007, 155, 65, 'EverlastAnton', '#E93E09');
  line('R$', 65, 1090, 155, 65, 'EverlastAnton', '#E93E09');
  doc.save().translate(232, 890).scale(1.25, 1);
  line(whole, 0, 0, 432, 300, 'EverlastAnton', '#E93E09');
  doc.restore();
  line(',' + cents, 783, 923, 220, 146, 'EverlastAnton', '#E93E09');
  line('PAGUE NO DINHEIRO, PIX OU CARTÃO', 45, 1260, 970, 70, 'EverlastAnton', '#E93E09', 'center');
  line('VEM PARA SPORTS & TENNIS', 45, 1380, 970, 78, 'EverlastAnton', '#E93E09', 'center');
  doc.restore();
  return true;
}

module.exports = { drawEverlastLabel };




