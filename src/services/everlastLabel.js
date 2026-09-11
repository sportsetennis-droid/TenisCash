const path = require('path');

// Keep 16 labels per A4; reserve footer clearance within the 5 x 7 cm format.
function drawEverlastLabel(doc, item, x, y, w, h) {
  const brand = String(item.brand || '').trim().toUpperCase();
  const streetRide = brand === 'REEBOK' && /\bSTREET\s*RIDE\b/i.test(item.productName || item.name || '');
  const campaignBrand = streetRide || ['OUS','DIADORA','OLYMPIKUS','FILA','SPEEDO','CONVERSE','ALLSTAR','ALL STAR','JOMA'].includes(brand);
  const promoCents = Math.round(Number(item.promotionalPrice) * 100);
  const baseCents = Math.round(Number(item.price) * 100);
  // Only an explicitly selected, saved 30% promotion enables this label.
  const reebokOffer = campaignBrand && baseCents > 0 && promoCents === Math.round(baseCents * 0.70)
    ? { active: true, discountPercent: 30, basePrice: baseCents / 100, finalPrice: promoCents / 100 } : null;
  const offer = campaignBrand ? reebokOffer : item.paymentOffer;
  if ((!campaignBrand && brand !== 'EVERLAST')
      || !offer?.active || offer.discountPercent !== 30
      || !(offer.basePrice > 0) || !(offer.finalPrice > 0)) return false;
  let model = streetRide ? 'STREET RIDE' : String(item.productName || item.name || 'EVERLAST').toUpperCase()
    .replace(/^T[ÊE]NIS\s+/, '').replace(/^EVERLAST\s+/, '')
    .split(/\s+SE[FMU]A\d|\s+ADT\b|\s+EVERLAST\b|\s+REF\b/)[0].trim();
  if (campaignBrand && !streetRide) {
    const known = ['IMIGRANTE SERIE X','IMIGRANTE MEGA','CHUCK TAYLOR ALL STAR','CHUCK TAYLOR','ARQUITETONICO','FLUENTE GTX','NACCARATO V','PHIBO 1123','IMIGRANTE','EMERGENTE','HEVEA','UENO','2K'];
    const match = brand === 'OUS' || /CONVERSE|ALL ?STAR/.test(brand) ? known.find(k => model.includes(k)) : null;
    model = match || model.replace(new RegExp('^.*?'+brand+'\\s+'), '').replace(/^DF[A-Z]+\d+-\d+\s+/, '').split(/\s*\(|\s+-\s+/)[0]
      .split(/\s+(?:MASCULINO|FEMININO|UNISSEX|PRETO|BRANCO|MARINHO|AREIA|CHUMBO|CINZA|AZUL|ROXO|LILAS|VINHO|MRHO|GRAFIT|PTO|PTR|MRN|CASTOR|MARFIM)\b|\s+REF\b/)[0].trim();
  }
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
  const usage = usageByModel[model] || (/ESTILO DE VIDA|LIFESTYLE|CASUAL|STREET/.test(modality) ? ['USO CASUAL','E DIA A DIA']
    : /CORRIDA|RUNNING/.test(modality) ? ['PARA CORRIDA','']
    : /CAMINHADA/.test(modality) ? ['PARA CAMINHADA','']
    : /FUTSAL/.test(modality) ? ['PARA FUTSAL','']
    : /SOCIETY/.test(modality) ? ['PARA SOCIETY','']
    : /CAMPO/.test(modality) ? ['FUTEBOL DE CAMPO','']
    : /TREINO|MUSCULACAO|CROSS/.test(modality) ? ['PARA TREINO',''] : null);
  const assets = path.join(__dirname, '../../assets');
  doc.save();
  const canvasHeight = Math.round(1060 * h / w);
  const addedHeight = canvasHeight - 1484;
  const contentShift = addedHeight * 0.40 - 50;
  doc.translate(x, y).scale(w / 1060, h / canvasHeight);
  const artwork = path.join(assets, 'logos/everlast-headline30-template.png');
  // Each section has a fixed physical allocation. The headline owns exactly 40%.
  const headlineHeight = canvasHeight * 0.40;
  function band(sourceTop, sourceHeight, top, height) {
    const scale = height / sourceHeight;
    doc.save().rect(0, top, 1060, height).clip();
    doc.image(artwork, 0, top - sourceTop * scale, { width: 1060, height: 1484 * scale });
    doc.restore();
  }
  band(0, 330, 0, headlineHeight);
  if (campaignBrand) {
    band(0, 330, headlineHeight, 820 + contentShift - headlineHeight);
    if (streetRide) {
    doc.image(path.join(assets, 'logos/brands/reebok-white.png'), 80, headlineHeight + 40, { width: 200 });
    doc.font('Helvetica-BoldOblique').fontSize(138).fillColor('#FFFFFF')
      .text('Reebok', 300, headlineHeight + 12, { width: 690, height: 170, lineBreak: false });
    } else if (item._brandLogoBuffer) {
      doc.image(item._brandLogoBuffer, 150, headlineHeight + 6, { fit:[760,110], align:'center', valign:'center' });
    } else {
      doc.font('Helvetica-Bold').fontSize(110).fillColor('#FFFFFF').text(brand, 40, headlineHeight + 24,
        { width:980, height:150, align:'center', lineBreak:false });
    }
  } else {
    band(330, 350, headlineHeight, 820 + contentShift - headlineHeight);
  }
  band(640, 215, 820 + contentShift, 285);
  band(865, 370, 1105 + contentShift, 325);
  band(1245, 239, 1430 + contentShift, 54 + addedHeight - contentShift);
  doc.registerFont('EverlastAnton', path.join(assets, 'fonts/Anton-Regular.ttf'));
  const bold = doc._tenisLabelFonts ? 'TenisInterBold' : 'Helvetica-Bold';
  function line(text, left, top, width, size, font, color, align = 'left') {
    doc.font(font).fontSize(size);
    while (doc.widthOfString(text) > width && size > 12) doc.fontSize(--size);
    doc.fillColor(color).text(text, left, top, { width, height: 400, lineBreak: false, align });
  }
  line('BAIXOU', 45, -10, 970, 290, 'EverlastAnton', '#FFFFFF', 'center');
  line('30% OFF', 45, 320, 970, 185, 'EverlastAnton', '#FFFFFF', 'center');
  doc.translate(0, contentShift);
  doc.fillColor('#FFFFF5').rect(0, 770, 1060, 70).fill();
  line(model, 55, 770, 950, 64, bold, '#EA3F0A', 'center');
  if (usage) {
    // A dedicated two-line band keeps the use case readable at actual 5 x 7 cm size.
    line(usage[0], 55, 835, 950, 104, 'EverlastAnton', '#EA3F0A', 'center');
    // Keep clear space between the use case, model name and price.
    line(usage[1], 55, 940, 950, 104, 'EverlastAnton', '#EA3F0A', 'center');
  }
  const money = value => Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  doc.strokeColor('#EA3F0A').lineWidth(4).moveTo(0, 1105).lineTo(1060, 1105).stroke();
  line('DE R$ ' + money(offer.basePrice), 68, 1120, 925, 84, bold, '#E93E09');
  const [whole, cents] = money(offer.finalPrice).split(',');
  line('POR', 65, 1255, 155, 60, 'EverlastAnton', '#E93E09');
  line('R$', 65, 1330, 155, 60, 'EverlastAnton', '#E93E09');
  doc.save().translate(232, 1205).scale(1.95, 1);
  line(whole, 0, 0, 276, 185, 'EverlastAnton', '#E93E09');
  doc.restore();
  line(',' + cents, 783, 1223, 220, 125, 'EverlastAnton', '#E93E09');
  // Restore the original size; the extended footer provides bottom clearance.
  const invitationTop = 1430 + (54 + addedHeight - contentShift - 60) / 2 - 15;
  line('VEM PARA SPORTS & TENNIS', 45, invitationTop, 970, 64, 'EverlastAnton', '#FFFFFF', 'center');
  doc.restore();
  return true;
}

module.exports = { drawEverlastLabel };
