const path = require('path');

// Keep 16 labels per A4; reserve footer clearance within the 5 x 7 cm format.
function drawEverlastLabel(doc, item, x, y, w, h) {
  const brand = String(item.brand || '').trim().toUpperCase();
  const streetRide = brand === 'REEBOK' && /\bSTREET\s*RIDE\b/i.test(item.productName || item.name || '');
  const campaignBrand = streetRide || ['OUS','DIADORA','OLYMPIKUS','FILA','SPEEDO','CONVERSE','ALLSTAR','ALL STAR','JOMA','TOPPER','MUNICH','MIZUNO','KAPPA'].includes(brand);
  const promoCents = Math.round(Number(item.promotionalPrice) * 100);
  const baseCents = Math.round(Number(item.price) * 100);
  // Only the saved campaign promotion enables this label.
  const discount = brand === 'MIZUNO' ? 40 : ['TOPPER','MUNICH','JOMA'].includes(brand) ? 20 : 30;
  const reebokOffer = campaignBrand && baseCents > 0 && promoCents === Math.round(baseCents * (100 - discount) / 100)
    ? { active: true, discountPercent: discount, basePrice: baseCents / 100, finalPrice: promoCents / 100 } : null;
  const streetFixedOffer = streetRide && baseCents === 19999 && promoCents === 14999
    ? { active:true, fixedPrice:true, basePrice:199.99, finalPrice:149.99 } : null;
  const mizunoName = String(item.productName || item.name || '').toUpperCase();
  const mizunoFixed = brand === 'MIZUNO' && (
    (/MORELIA\s+II\s+PRO/.test(mizunoName) && baseCents === 80000 && promoCents === 54900) ||
    (/MORELIA\s+SALA\s+PRO/.test(mizunoName) && baseCents === 60000 && promoCents === 49900));
  const mizunoFixedOffer = mizunoFixed ? {active:true, fixedPrice:true, basePrice:baseCents/100, finalPrice:promoCents/100} : null;
  const diadoraPrice = require('./diadoraFixedOffer').diadoraFixedPrice(item);
  const diadoraFixed = diadoraPrice != null && promoCents === diadoraPrice * 100 && baseCents > promoCents;
  const diadoraOffer = diadoraFixed ? {active:true, fixedPrice:true, basePrice:baseCents/100, finalPrice:diadoraPrice} : null;
  const offer = diadoraOffer || mizunoFixedOffer || streetFixedOffer || (campaignBrand ? reebokOffer : item.paymentOffer);
  if ((!campaignBrand && brand !== 'EVERLAST')
      || !offer?.active || (!((brand === 'EVERLAST' || streetRide || mizunoFixed || diadoraFixed) && offer.fixedPrice) && ![20,30,40].includes(offer.discountPercent))
      || !(offer.basePrice > 0) || !(offer.finalPrice > 0)) return false;
  const model = require('./campaignLabelModel').campaignLabelModel(item);
  const usageByModel = {
    'STREET RIDE': ['USO CASUAL', 'E DIA A DIA'],
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
  const modality = String(item.modality || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const usage = item.labelUsage || usageByModel[model] || (/ESTILO DE VIDA|LIFESTYLE|CASUAL|STREET/.test(modality) ? ['USO CASUAL','E DIA A DIA']
    : /CORRIDA|RUNNING/.test(modality) ? ['PARA CORRIDA','']
    : /CAMINHADA/.test(modality) ? ['PARA CAMINHADA','']
    : /FUTSAL/.test(modality) ? ['PARA FUTSAL','']
    : /SOCIETY/.test(modality) ? ['PARA SOCIETY','']
    : /CAMPO/.test(modality) ? ['FUTEBOL DE CAMPO','']
    : /TREINO|MUSCULACAO|CROSS/.test(modality) ? ['PARA TREINO',''] : null);
  const assets = path.join(__dirname, '../../assets');
  return drawEverlastBaixou(doc, item, offer, model, usage, assets, x, y, w, h);
}

module.exports = { drawEverlastLabel };

// Owner-approved Everlast revision: no percentage headline; larger old/new prices.
function drawEverlastBaixou(doc, item, offer, model, usage, assets, x, y, w, h) {
  doc.save().translate(x, y).scale(w / 1060, h / 1484);
  const artwork = path.join(assets, 'logos/everlast-headline30-template.png');
  function band(sourceTop, sourceHeight, top, height) {
    const scale = height / sourceHeight;
    doc.save().rect(0, top, 1060, height).clip();
    doc.image(artwork, 0, top - sourceTop * scale, { width: 1060, height: 1484 * scale });
    doc.restore();
  }
  band(0, 330, 0, 330);
  if (String(item.brand).toUpperCase() === 'REEBOK') {
    band(0, 330, 730, 230);
    doc.image(path.join(assets, 'logos/brands/reebok-official-white.png'), 330, 745, { width:400 });
  } else if (String(item.brand).toUpperCase() === 'EVERLAST') {
    band(330, 350, 730, 230);
  } else {
    band(0, 330, 730, 230);
    if (item._brandLogoBuffer) {
      doc.image(item._brandLogoBuffer, 150, 775, {fit:[760,150], align:'center', valign:'center'});
    } else {
      doc.font('Helvetica-Bold').fontSize(110).fillColor('#FFFFFF')
        .text(String(item.brand).toUpperCase(), 40, 785, {width:980,height:160,align:'center',lineBreak:false});
    }
  }
  doc.fillColor('#FFFFF5').rect(0, 330, 1060, 400).fill();
  doc.fillColor('#FFFFF5').rect(0, 960, 1060, 340).fill();
  band(1245, 239, 1300, 184);
  doc.registerFont('EverlastAnton', path.join(assets, 'fonts/Anton-Regular.ttf'));
  const bold = doc._tenisLabelFonts ? 'TenisInterBold' : 'Helvetica-Bold';
  function text(value, left, top, width, size, font, color, align = 'left') {
    doc.font(font).fontSize(size);
    while (doc.widthOfString(value) > width && size > 12) doc.fontSize(--size);
    doc.fillColor(color).text(value, left, top, {width, height:400, lineBreak:false, align});
  }
  // Preserve the large headline width while reserving clear space above the logo.
  doc.save().translate(0,20).scale(1,0.82);
  text('BAIXOU', 45, -55, 970, 340, 'EverlastAnton', '#FFFFFF', 'center');
  doc.restore();
  text(model, 55, 975, 950, 64, bold, '#EA3F0A', 'center');
  if (usage) {
    text(usage[0], 55, 1055, 950, 104, 'EverlastAnton', '#EA3F0A', 'center');
    text(usage[1], 55, 1165, 950, 104, 'EverlastAnton', '#EA3F0A', 'center');
  }
  doc.strokeColor('#EA3F0A').lineWidth(4).moveTo(0,730).lineTo(1060,730).stroke();
  const money = value => Number(value).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
  text('DE R$ ' + money(offer.basePrice), 60, 340, 940, 100, bold, '#E93E09', 'center');
  const [whole, cents] = money(offer.finalPrice).split(',');
  doc.font('EverlastAnton').fontSize(260);
  let wholeSize = 260;
  while (doc.widthOfString(whole) > 470 && wholeSize > 12) doc.fontSize(--wholeSize);
  const wholeWidth = doc.widthOfString(whole) * 1.5;
  doc.fontSize(150);
  let centsSize = 150;
  while (doc.widthOfString(',' + cents) > 215 && centsSize > 12) doc.fontSize(--centsSize);
  const centsWidth = doc.widthOfString(',' + cents);
  doc.fontSize(60);
  const prefixWidth = Math.max(doc.widthOfString('POR'), doc.widthOfString('R$'));
  const gap = 30;
  const priceLeft = (1060 - prefixWidth - gap - wholeWidth - centsWidth) / 2;
  const numberLeft = priceLeft + prefixWidth + gap;
  text('POR', priceLeft, 520, prefixWidth + 1, 60, 'EverlastAnton', '#E93E09');
  text('R$', priceLeft, 600, prefixWidth + 1, 60, 'EverlastAnton', '#E93E09');
  doc.save().translate(numberLeft,400).scale(1.5,1);
  text(whole, 0, 0, 470, wholeSize, 'EverlastAnton', '#E93E09');
  doc.restore();
  text(',' + cents, numberLeft + wholeWidth, 440, 215, centsSize, 'EverlastAnton', '#E93E09');
  // Keep the full footer text at least 2 mm above the physical cut boundary.
  doc.font('EverlastAnton').fontSize(64);
  const footerTop = 1300 + (184 - doc.currentLineHeight()) / 2;
  text('VEM PARA SPORTS & TENNIS', 45, footerTop, 970, 64, 'EverlastAnton', '#FFFFFF', 'center');
  doc.restore();
  return true;
}
