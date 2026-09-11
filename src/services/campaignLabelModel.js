// Shared by the campaign review and PDF: group the actual printed model.
function campaignLabelModel(item) {
  const brand = String(item.brand || '').trim().toUpperCase();
  const streetRide = brand === 'REEBOK' && /STREET\s*RIDE/i.test(item.productName || item.name || '');
  const campaignBrand = true;
  let model = streetRide ? 'STREET RIDE' : String(item.productName || item.name || 'EVERLAST').toUpperCase().replace(/\bCHCUK\b/g, 'CHUCK')
    .replace(/^T[ÊE]NIS\s+/, '').replace(/^EVERLAST\s+/, '')
    .split(/\s+SE[FMU]A\d|\s+ADT\b|\s+EVERLAST\b|\s+REF\b/)[0].trim();
  if (campaignBrand && !streetRide) {
    const known = ['IMIGRANTE SERIE X','IMIGRANTE MEGA','CHUCK TAYLOR ALL STAR SIDE ZIP','CHUCK TAYLOR ALL STAR 1V','CHUCK TAYLOR ALL STAR HIGH STREET','CHUCK TAYLOR ALL STAR LIFT','CHUCK TAYLOR ALL STAR MOVE','CHUCK TAYLOR ALL STAR','CHUCK TAYLOR','ARQUITETONICO','FLUENTE GTX','NACCARATO V','PHIBO 1123','IMIGRANTE','EMERGENTE','HEVEA','UENO','2K'];
    const match = brand === 'OUS' || /CONVERSE|ALL ?STAR/.test(brand) ? known.find(k => model.includes(k)) : null;
    model = match || model.replace(new RegExp('^.*?'+brand+'\\s+'), '').replace(/^DF[A-Z]+\d+-\d+\s+/, '').split(/\s*\(|\s+-\s+/)[0]
      .split(/\s+(?:MASCULINO|FEMININO|UNISSEX|PRETO|BRANCO|MARINHO|AREIA|CHUMBO|CINZA|AZUL|ROXO|LILAS|VINHO|MRHO|GRAFIT|PTO|PTR|MRN|CASTOR|MARFIM)\b|\s+REF\b/)[0].trim();
  }
  const rawModelSource = String(item.originalProductName || item.name || '').toUpperCase();
  if (brand === 'DIADORA') {
    const match = rawModelSource.match(/STRATUS\s*II|VULCANO\s*II|GIOVE|LEGGENDA|ILLUSIONE|SAGA|MONZA|MODENA|MARINO|ESSENZIALE|SFORZA|CENTRALE|PLAYMAKER/);
    if (match) model = match[0];
  }
  if (brand === 'OLYMPIKUS') {
    const match = rawModelSource.match(/CORRE\s*TRILHA\s*2|CHALLENGER\s*5|REVERSO\s*2|FLIT\s*4|ZEX\s*2|JOGGING(?:\s+\d+)?(?:\s+SE)?|COSMO|VIRTUOSE|GIRO|MESCLA|ORBITA|PURPURA|RITMO|VENUM/);
    if (match) model = match[0].replace(/JOGGING\s+\d+/, 'JOGGING').replace(/TRILHA2/, 'TRILHA 2');
  }
  if (brand === 'KAPPA') {
    const match = rawModelSource.match(/MAESTRO|MILAN\s*II|NAPOLI|SORANO\s*II/);
    if (match) model = match[0];
  }
  if (brand === 'UMBRO') {
    const match = rawModelSource.match(/UMBRO\s+(.+?)(?:-(?=[A-Z ]+\/)|-TAM:|$)/);
    if (match) model = match[1].trim();
  }
  if (brand === 'FILA') {
    const raw = String(item.originalProductName || item.name || '').toUpperCase();
    const match = raw.match(/(?:TENIS|TÊNIS|CHINELO)\s+FILA\s+(.+?)\s+(?:MASCULINO|FEMININO|INFANTIL)(?:[-\s]|$)/);
    if (match) model = match[1];
  }
  if (brand === 'MUNICH') {
    const match = model.match(/GRESCA\s+2[.,]0|CONTINENTAL\s+V2/);
    if (match) model = match[0];
  }
  if (brand === 'SPEEDO') {
    const code = String(item.originalProductName || item.name || '').toUpperCase().match(/SPO[ -]?\d+[FM]?/);
    if (code) model = code[0].replace(/[ -]/g, '');
  }
  return model.replace(/\bCHCUK\b/g, 'CHUCK').replace(/\s+(?:(?:CZ|PRE|AV|BG|CBR|RSE|RSCL|EGUM|EVPR|MRFMLT|PTLLMO|TQS|VDE|AML|LIM|PETROLEO|ESCURO|MISTA|AMARELO|AZ|LRJ|PTO|BCO)(?:\s+|$))+$/g, '').trim();
}
module.exports = { campaignLabelModel };
