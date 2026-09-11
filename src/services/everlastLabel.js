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
  if (climberRun && offer.basePrice === 299.99 && offer.finalPrice === 209.99) {
    doc.image(path.join(assets, 'logos/everlast-approved-label.png'), x, y, { width: w, height: h });
    return true;
  }
  doc.save();
  doc.translate(x, y).scale(w / 1060, h / 1484);
  doc.image(path.join(assets, 'logos/everlast-approved-label-template.png'), 0, 0, { width: 1060, height: 1484 });
  doc.registerFont('EverlastAnton', path.join(assets, 'fonts/Anton-Regular.ttf'));
  const bold = doc._tenisLabelFonts ? 'TenisInterBold' : 'Helvetica-Bold';
  function line(text, left, top, width, size, font, color, align = 'left') {
    doc.font(font).fontSize(size);
    while (doc.widthOfString(text) > width && size > 12) doc.fontSize(--size);
    doc.fillColor(color).text(text, left, top, { width, height: 400, lineBreak: false, align });
  }
  line(model, 65, 575, 930, 43, bold, '#FFFFFF', 'center');
  const detail = climberRun ? 'CAMINHADA E CORRIDA LEVE' : String(item.color || '').toUpperCase();
  line(detail, 65, 742, 930, 42, bold, '#EA3F0A', 'center');
  const money = value => Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  line('DE R$ ' + money(offer.basePrice), 68, 898, 925, 53, bold, '#594B3D');
  const [whole, cents] = money(offer.finalPrice).split(',');
  line('POR', 65, 1007, 155, 65, 'EverlastAnton', '#E93E09');
  line('R$', 65, 1090, 155, 65, 'EverlastAnton', '#E93E09');
  doc.save().translate(232, 890).scale(1.25, 1);
  line(whole, 0, 0, 432, 300, 'EverlastAnton', '#E93E09');
  doc.restore();
  line(',' + cents, 783, 923, 220, 146, 'EverlastAnton', '#E93E09');
  doc.restore();
  return true;
}

module.exports = { drawEverlastLabel };



