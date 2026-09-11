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
  const usageByModel = {
    'CLIMBER RUN': ['CAMINHADA', 'E CORRIDA LEVE'],
    'CLIMBER PRO 3': ['TREINO DE FORÇA', 'CROSS E FUNCIONAL'],
    'CLIMBER PRO': ['TREINO DE FORÇA', 'CROSS E FUNCIONAL'],
    'CLIMBER ULTRA': ['TREINO DE FORÇA', 'CROSS E FUNCIONAL'],
    'STATION 3': ['ACADEMIA', 'E TREINO DE FORÇA'],
    'STATION': ['ACADEMIA', 'E TREINO DE FORÇA'],
    'FORCEKNIT LOW': ['ACADEMIA', 'E TREINO DE FORÇA'],
    'FORCEKNIT LW': ['ACADEMIA', 'E TREINO DE FORÇA'],
    'FORCEKNIT': ['ACADEMIA', 'E TREINO DE FORÇA'],
    'RING 4': ['ACADEMIA', 'E TREINO DE FORÇA'],
    'RING IV': ['ACADEMIA', 'E TREINO DE FORÇA'],
    'SOLO': ['CAMINHADA', 'E DIA A DIA'],
    'BLAZER': ['USO CASUAL', 'E DIA A DIA'],
    'NEW YORK': ['DIA A DIA', 'E LAZER'],
  };
  const usage = usageByModel[model];
  const assets = path.join(__dirname, '../../assets');
  doc.save();
  doc.translate(x, y).scale(w / 1060, h / 1484);
  const artwork = path.join(assets, 'logos/everlast-headline30-template.png');
  // Each section has a fixed physical allocation. The headline owns exactly 40%.
  const headlineHeight = 1484 * 0.40;
  function band(sourceTop, sourceHeight, top, height) {
    const scale = height / sourceHeight;
    doc.save().rect(0, top, 1060, height).clip();
    doc.image(artwork, 0, top - sourceTop * scale, { width: 1060, height: 1484 * scale });
    doc.restore();
  }
  band(0, 330, 0, headlineHeight);
  band(330, 350, headlineHeight, 820 - headlineHeight);
  band(640, 215, 820, 230);
  band(865, 370, 1050, 270);
  band(1245, 239, 1320, 164);
  doc.registerFont('EverlastAnton', path.join(assets, 'fonts/Anton-Regular.ttf'));
  const bold = doc._tenisLabelFonts ? 'TenisInterBold' : 'Helvetica-Bold';
  function line(text, left, top, width, size, font, color, align = 'left') {
    doc.font(font).fontSize(size);
    while (doc.widthOfString(text) > width && size > 12) doc.fontSize(--size);
    doc.fillColor(color).text(text, left, top, { width, height: 400, lineBreak: false, align });
  }
  line('BAIXOU', 45, -10, 970, 290, 'EverlastAnton', '#FFFFFF', 'center');
  line('30% OFF', 45, 320, 970, 185, 'EverlastAnton', '#FFFFFF', 'center');
  doc.fillColor('#FFFFF5').rect(0, 770, 1060, 70).fill();
  line(model, 55, 770, 950, 64, bold, '#EA3F0A', 'center');
  if (usage) {
    // A dedicated two-line band keeps the use case readable at actual 5 x 7 cm size.
    line(usage[0], 55, 815, 950, 104, 'EverlastAnton', '#EA3F0A', 'center');
    // Leave room for the cedilla above the price divider.
    line(usage[1], 55, usage[1].includes('FORÇA') ? 908 : 920, 950, 104, 'EverlastAnton', '#EA3F0A', 'center');
  }
  const money = value => Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  doc.strokeColor('#EA3F0A').lineWidth(4).moveTo(0, 1050).lineTo(1060, 1050).stroke();
  line('DE R$ ' + money(offer.basePrice), 68, 1060, 925, 60, bold, '#E93E09');
  const [whole, cents] = money(offer.finalPrice).split(',');
  line('POR', 65, 1110, 155, 60, 'EverlastAnton', '#E93E09');
  line('R$', 65, 1185, 155, 60, 'EverlastAnton', '#E93E09');
  doc.save().translate(232, 1090).scale(1.95, 1);
  line(whole, 0, 0, 276, 185, 'EverlastAnton', '#E93E09');
  doc.restore();
  line(',' + cents, 783, 1108, 220, 125, 'EverlastAnton', '#E93E09');
  line('PAGUE NO DINHEIRO, PIX OU CARTÃO', 45, 1315, 970, 64, 'EverlastAnton', '#FFFFFF', 'center');
  line('VEM PARA SPORTS & TENNIS', 45, 1400, 970, 64, 'EverlastAnton', '#FFFFFF', 'center');
  doc.restore();
  return true;
}

module.exports = { drawEverlastLabel };
