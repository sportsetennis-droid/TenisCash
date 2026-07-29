/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUTPUT_DIR = path.join(__dirname, '../assets/logos/brands');
const SOURCES = {
  actvitta: {
    brand: 'ACTVITTA',
    url: 'https://www.actvitta.com.br/wp-content/uploads/2025/03/LOGO_SITE_actvitta_25-03-1.png',
    owner: 'Actvitta',
  },
  adidas: {
    brand: 'ADIDAS',
    url: 'https://cdn.simpleicons.org/adidas',
    owner: 'Simple Icons',
  },
  'alto-giro': {
    brand: 'Alto Giro',
    url: 'https://altogiro.com.br/cdn/shop/files/AltoGiro_FooterLogo_Black.png?v=1710339614&width=1200',
    owner: 'Alto Giro',
  },
  army: {
    brand: 'ARMY',
    url: 'https://www.armybr.com.br/cdn/shop/files/logo-armybr-white_420x.svg?v=1754578805',
    owner: 'ArmyBR',
  },
  asics: {
    brand: 'ASICS',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Asics%20Logo.svg',
    owner: 'Wikimedia Commons',
  },
  atama: {
    brand: 'Atama',
    url: 'https://atamausa.com/cdn/shop/files/LOGO_ATAMA_HORIZONTAL_POSITIVO_600x.png?v=1727480735',
    owner: 'Atama USA',
  },
  bagun: {
    brand: 'BAGUN',
    url: 'https://dcdn-us.mitiendanube.com/stores/005/472/331/themes/common/logo-2144578665-1739973869-cfaecd428fd15494e514c0807c7848e41739973869-640-0.webp',
    owner: 'Pangué Materiais Esportivos',
    extract: {
      leftFraction: 0.055,
      topFraction: 0.25,
      widthFraction: 0.89,
      heightFraction: 0.4,
    },
    keepDarkForeground: true,
    recolor: [255, 255, 255],
    catalogCorrection: 'BAGUN é o material das faixas; os produtos cadastrados são redes da Pangué.',
  },
  bel: {
    brand: 'BEL',
    url: 'https://www.bel.ind.br/wp-content/uploads/2022/07/01_LogoBel-Azul-1.png',
    owner: 'Bel',
    keepLightForeground: true,
  },
  'body-for-sure': {
    brand: 'Body for Sure',
    url: 'https://bodyforsuresite.vtexassets.com/assets/vtex.file-manager-graphql/images/4311698c-5ade-4292-ad71-b63f316a6aee___9ee6ef437e0f2ead3a664e3cef4be2fd.svg',
    owner: 'Body For Sure',
  },
  botafogo: {
    brand: 'BOTAFOGO',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Botafogo%20de%20Futebol%20e%20Regatas%20logo.svg',
    owner: 'Wikimedia Commons',
    forceRaster: true,
    keepLightForeground: true,
  },
  brooks: {
    brand: 'BROOKS',
    url: 'https://brooks.fbitsstatic.net/sf/img/brooks-logo-white.svg?theme=main&v=202607231202',
    owner: 'Brooks Running Brasil',
  },
  champion: {
    brand: 'CHAMPION',
    url: 'https://www.champion.com/cdn/shop/files/champion-logo-blue.png?v=1740169510&width=1200',
    owner: 'Champion',
  },
  converse: {
    brand: 'Converse',
    url: 'https://converse.com.br/static/version1785322932/frontend/Converse/NewTheme/pt_BR/images/logo.svg',
    owner: 'Converse Brasil',
  },
  diadora: {
    brand: 'DIADORA',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Diadora%20logo.svg',
    owner: 'Wikimedia Commons',
  },
  dilly: {
    brand: 'DILLY',
    url: 'https://dillysports.com.br/assets/images/img-dilly.jpg',
    owner: 'Dilly Sports',
    extract: {
      leftFraction: 0.528,
      topFraction: 0.385,
      widthFraction: 0.148,
      heightFraction: 0.095,
    },
    keepNeutralLightForeground: true,
    recolor: [255, 255, 255],
    catalogCorrection: 'O item cadastrado é material de PDV da Öus, empresa do grupo Dilly Sports.',
  },
  drb: {
    brand: 'DRB',
    url: 'https://acdn-us.mitiendanube.com/stores/001/219/670/themes/common/logo-294894686-1619202681-696ca79a7e76996e58ced912e46469aa1619202682.png?0',
    owner: 'Dribbling',
  },
  elgin: {
    brand: 'ELGIN',
    url: 'https://elgin.vtexassets.com/assets/vtex/assets-builder/elgin.store/1.0.140/images/logos/logo___8c0ef161d2fcb8c5f07910f575842820.svg',
    owner: 'Elgin',
  },
  everlast: {
    brand: 'EVERLAST',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Everlast-logo-2011.svg',
    owner: 'Wikimedia Commons',
  },
  evoke: {
    brand: 'EVOKE',
    url: 'https://www.evoke.com.br/cdn/shop/files/logo_evoke_black_header.png?v=1725556817&width=1200',
    owner: 'Evoke',
  },
  fiber: {
    brand: 'FIBER',
    url: 'https://www.fiberoficial.com.br/cdn/shop/files/Fiber-Logo_2023.jpg?v=1673889492&width=1600',
    owner: 'Fiber Oficial',
  },
  fila: {
    brand: 'FILA',
    url: 'https://cdn.simpleicons.org/fila',
    owner: 'Simple Icons',
  },
  hidrolight: {
    brand: 'HIDROLIGHT',
    url: 'https://hidrolight.com.br/wp-content/uploads/2026/05/hidrolight-logo-horizontal-positivo.svg',
    owner: 'Hidrolight',
  },
  hoka: {
    brand: 'HOKA',
    url: 'https://upload.wikimedia.org/wikipedia/en/7/72/Hoka_%28brand%29_logo.svg?raw=4',
    owner: 'Wikipedia',
  },
  'hope-resort': {
    brand: 'Hope Resort',
    url: 'https://www.hoperesort.com.br/',
    owner: 'HOPE Resort',
    inlineSvgId: 'hope-resort-black',
  },
  hurley: {
    brand: 'HURLEY',
    url: 'https://hurley.com.br/cdn/shop/files/logo-Hurley_Google.png?v=1694613282&width=1200',
    owner: 'Hurley Brasil',
  },
  impacto: {
    brand: 'IMPACTO',
    url: 'https://impactobjj.com/catalogo/logo.png',
    owner: 'Impacto BJJ',
  },
  impulse: {
    brand: 'IMPULSE',
    url: 'https://www.alquimiadasaude.com.br/tema/alquimiadasaude-vue/dist/assets/logo-alquimiadasaude-Cq8VgmG9.svg',
    owner: 'Alquimia da Saúde',
    catalogCorrection: 'IMPULSE é uma linha de produtos da Alquimia da Saúde.',
  },
  joma: {
    brand: 'JOMA',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Joma%20Sport.svg',
    owner: 'Wikimedia Commons',
  },
  kagiva: {
    brand: 'KAGIVA',
    url: 'https://web.archive.org/web/20211002044608id_/http://www.kagiva.com.br/img/logo-header.png',
    owner: 'Kagiva (site oficial arquivado)',
  },
  kappa: {
    brand: 'KAPPA',
    url: 'https://upload.wikimedia.org/wikipedia/commons/3/32/Kappa_logo.svg',
    owner: 'Wikimedia Commons',
  },
  kempa: {
    brand: 'KEMPA',
    url: 'https://cdn.uhlsport.com/media/a7/15/47/1726133315/Kempa_Logo.svg?ts=1726133315',
    owner: 'Kempa',
  },
  kenner: {
    brand: 'KENNER',
    url: 'https://www.kenner.com.br/arquivos/nova-logo-footer-92-22.png?v=637342509322600000',
    owner: 'Kenner',
  },
  kolosh: {
    brand: 'KOLOSH',
    url: 'https://kolosh.vtexassets.com/assets/vtex/assets-builder/kolosh.kolosh-theme/1.0.155/svg/logo-kolosh___9571bc92300da38791f9996cde25b7c5.svg',
    owner: 'Kolosh',
  },
  leader: {
    brand: 'LEADER',
    url: 'https://acdn-us.mitiendanube.com/stores/001/607/074/themes/common/logo-2106027076-1632934571-79de66f8c887aefa3a15af998ad8142c1632934571.png?0',
    owner: 'Leader do Brasil',
  },
  lupo: {
    brand: 'LUPO',
    url: 'https://upload.wikimedia.org/wikipedia/commons/2/25/Lupo_logo.svg',
    owner: 'Wikimedia Commons',
  },
  'lets-gym': {
    brand: "Let's Gym",
    url: 'https://popstore.com.br/popstorage/stores/169/lets-gym-logo-2026.png',
    owner: "Let's Gym",
  },
  mikasa: {
    brand: 'MIKASA',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Mikasa%20Sports%20logo.svg',
    owner: 'Wikimedia Commons',
  },
  mizuno: {
    brand: 'MIZUNO',
    url: 'https://mizunobrio.vtexassets.com/assets/vtex/assets-builder/mizunobrio.store-theme/7.0.51/icons/header/logo-desktop___66e511f88ba1ef2414817acaf56bd08a.svg',
    owner: 'Mizuno Brasil',
  },
  mormaii: {
    brand: 'MORMAII',
    url: 'https://www.mormaiishop.com.br/_nuxt/img/logo-mormaii.f4bd802.png',
    owner: 'Mormaii',
    cropLeftFraction: 0.55,
  },
  munich: {
    brand: 'MUNICH',
    url: 'https://www.munichsports.com/cdnassets/redesign_23/logo.svg',
    owner: 'Munich Sports',
  },
  n1: {
    brand: 'N1',
    url: 'https://cdn.dooca.store/79759/files/n1-logos-novas-fundo-transparente-ji0bk.png?v=1781292925&webp=0',
    owner: 'N1 Oficial',
  },
  'new-balance': {
    brand: 'NEW BALANCE',
    url: 'https://cdn.simpleicons.org/newbalance',
    owner: 'Simple Icons',
  },
  nike: {
    brand: 'NIKE',
    url: 'https://cdn.simpleicons.org/nike',
    owner: 'Simple Icons',
  },
  oakley: {
    brand: 'OAKLEY',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Oakley%20logo.svg',
    owner: 'Wikimedia Commons',
  },
  olympikus: {
    brand: 'OLYMPIKUS',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Olympikus%20Logo%20Lockup%20vertical-PRETO%20%281%29.png',
    owner: 'Wikimedia Commons',
  },
  otaku: {
    brand: 'OTAKU',
    url: 'https://fpfootwear.com/wp-content/uploads/2024/03/FP-logo.png',
    owner: 'Footprint Insoles',
    catalogCorrection: 'OTAKU é o gráfico do produto; a marca é Footprint Insoles.',
  },
  ous: {
    brand: 'OUS',
    url: 'https://dillysports.vtexassets.com/assets/vtex.file-manager-graphql/images/68576a37-5e84-4f5f-b2c5-0b6b2005c002___18805ee61b168f79c5070dd8c7f0a19f.svg',
    owner: 'Öus',
  },
  oxn: {
    brand: 'OXN',
    url: 'https://www.oxnfutebol.com.br/img/oxn-logo-branca.png?v=2',
    owner: 'OXN Futebol',
  },
  paterson: {
    brand: 'PATERSON',
    url: 'https://patersonleague.com/cdn/shop/files/PATERSON-LOGO-PNG.png?v=1710350791&width=1200',
    owner: 'Paterson League',
  },
  penalty: {
    brand: 'PENALTY',
    url: 'https://cambuci.vtexassets.com/assets/vtex.file-manager-graphql/images/c6522b9c-0301-4c99-9bbf-f2af184f0e2f___550918e21e86cb3cedfa36c2fcf59c32.svg',
    owner: 'Penalty',
  },
  pituka: {
    brand: 'PITUKA',
    url: 'https://static.netshoes.com.br/vue-components/16.2.1/topper/images/160f1834130c41a47cc16356b6805d93.svg',
    owner: 'Topper',
    catalogCorrection: 'Os produtos cadastrados como PITUKA são produtos Topper.',
  },
  poker: {
    brand: 'POKER',
    url: 'https://poker.esp.br/wp-content/uploads/2024/03/Logo.svg',
    owner: 'Poker',
  },
  'powell-peralta': {
    brand: 'POWELL PERALTA',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Powell%20Peralta%20logo%20wide%20red.svg',
    owner: 'Wikimedia Commons',
    svgColor: '#FFFFFF',
  },
  progne: {
    brand: 'PROGNE',
    url: 'https://cdn.dooca.store/161310/files/logo-progne-sports-alterado.png?v=1729866597&webp=0',
    owner: 'Progne Sports',
  },
  puma: {
    brand: 'PUMA',
    url: 'https://cdn.simpleicons.org/puma',
    owner: 'Simple Icons',
  },
  rainha: {
    brand: 'RAINHA',
    url: 'https://upload.wikimedia.org/wikipedia/commons/9/9d/Rainha_brand_logo.png',
    owner: 'Wikimedia Commons',
  },
  realtex: {
    brand: 'REALTEX',
    url: 'https://realtex.com.br/wp-content/uploads/2021/11/horizontal-preto-sport-1024x243-1.png',
    owner: 'Realtex',
  },
  reebok: {
    brand: 'REEBOK',
    url: 'https://cdn.simpleicons.org/reebok',
    owner: 'Simple Icons',
  },
  rhumell: {
    brand: 'RHUMELL',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Logo%20Rhumell.png',
    owner: 'Wikimedia Commons',
  },
  salomon: {
    brand: 'SALOMON',
    url: 'https://upload.wikimedia.org/wikipedia/commons/9/9b/Salomon_logo_2022.svg',
    owner: 'Wikimedia Commons',
  },
  siker: {
    brand: 'SIKER',
    url: 'https://upload.wikimedia.org/wikipedia/commons/3/3e/Logo_Siker.svg',
    owner: 'Wikimedia Commons',
  },
  skechers: {
    brand: 'SKECHERS',
    url: 'https://upload.wikimedia.org/wikipedia/commons/d/d5/SKECHERS_logo.png',
    owner: 'Wikimedia Commons',
  },
  spalding: {
    brand: 'SPALDING',
    url: 'https://assets.fotlinc.com/transform/d79adebf-0154-436a-b4a6-2bc63c6a92de/logo.png',
    owner: 'Spalding',
  },
  speedo: {
    brand: 'SPEEDO',
    url: 'https://lojaspeedo.vtexassets.com/assets/vtex/assets-builder/lojaspeedo.lojaspeedo/6.6.0/images/header/logo-header___34b2bc1e506e7fd94453ce2f719b7a32.svg',
    owner: 'Speedo Brasil',
  },
  stance: {
    brand: 'STANCE',
    url: 'https://cdn.shopify.com/s/files/1/1024/0878/2162/files/Stance_Logo_Black.svg?v=1769086757&width=500',
    owner: 'Stance',
  },
  stanley: {
    brand: 'STANLEY',
    url: 'https://www.stanley1913.com.br/cdn/shop/files/Medium_PNG-Stanley_Brandmark_Primary.png?v=1714662426&width=1200',
    owner: 'Stanley 1913 Brasil',
  },
  thigoline: {
    brand: 'THIGOLINE',
    url: 'https://cdn.awsli.com.br/1252/1252766/logo/logo-estendida-thigoline-uu5qgnr3n2.png',
    owner: 'Thigoline',
  },
  thunder: {
    brand: 'THUNDER',
    url: 'https://www.thundertrucks.com/wp-content/themes/thunder-2018/img/th-script-2023.png',
    owner: 'Thunder Trucks',
  },
  topper: {
    brand: 'TOPPER',
    url: 'https://static.netshoes.com.br/vue-components/16.2.1/topper/images/160f1834130c41a47cc16356b6805d93.svg',
    owner: 'Topper',
  },
  uhlsport: {
    brand: 'UHLSPORT',
    url: 'https://cdn.uhlsport.com/media/0a/56/de/1726229807/uhlsport_logo.svg?ts=1726229807',
    owner: 'Uhlsport',
  },
  umbro: {
    brand: 'UMBRO',
    url: 'https://upload.wikimedia.org/wikipedia/commons/2/22/Umbro_logo_%28current%29.svg?raw=4',
    owner: 'Wikimedia Commons',
  },
  'under-armour': {
    brand: 'UNDER ARMOUR',
    url: 'https://cdn.simpleicons.org/underarmour',
    owner: 'Simple Icons',
  },
  vistho: {
    brand: 'Vistho',
    url: 'https://images.tcdn.com.br/img/img_prod/1305879/1711456782_logo_vistho_aline.png',
    owner: 'Vistho Meias',
  },
  vollo: {
    brand: 'VOLLO',
    url: 'https://vollo.vtexassets.com/assets/vtex/assets-builder/vollo.store-theme/5.0.104/imgs/new-logo-desktop___52f9e1c490240fc40717472b5b7da120.png',
    owner: 'Vollo',
  },
  'wu-tang': {
    brand: 'WU-TANG',
    url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/WuTangClanLogo.png',
    owner: 'Wikimedia Commons',
  },
  'zero-american': {
    brand: 'ZERO AMERICAN',
    url: 'https://zeroskateboards.com/cdn/shop/files/zeroLogo.png?v=1614764579&width=500',
    owner: 'Zero Skateboards',
    catalogCorrection: 'ZERO AMERICAN é uma linha da Zero Skateboards.',
    recolor: [255, 255, 255],
  },
};

function isSvg(bytes, contentType, url) {
  return /svg/i.test(contentType || '')
    || /\.svg(?:[?#]|$)/i.test(url)
    || /^\s*<svg[\s>]/i.test(bytes.toString('utf8', 0, Math.min(bytes.length, 500)));
}

async function normalizeRaster(bytes, options = {}) {
  let image = sharp(bytes, { density: 300 }).ensureAlpha();
  let metadata = await image.metadata();
  if (options.extract && Number(metadata.width) > 1 && Number(metadata.height) > 1) {
    const left = Math.max(0, Math.round(Number(metadata.width) * Number(options.extract.leftFraction || 0)));
    const top = Math.max(0, Math.round(Number(metadata.height) * Number(options.extract.topFraction || 0)));
    const width = Math.min(
      Number(metadata.width) - left,
      Math.max(1, Math.round(Number(metadata.width) * Number(options.extract.widthFraction || 1))),
    );
    const height = Math.min(
      Number(metadata.height) - top,
      Math.max(1, Math.round(Number(metadata.height) * Number(options.extract.heightFraction || 1))),
    );
    image = image.extract({ left, top, width, height }).ensureAlpha();
    metadata = await image.metadata();
  }
  if (options.rotate) {
    image = image.rotate(Number(options.rotate)).ensureAlpha();
    metadata = await image.metadata();
  }
  if (options.cropLeftFraction && Number(metadata.width) > 1 && Number(metadata.height) > 1) {
    image = image.extract({
      left: 0,
      top: 0,
      width: Math.max(1, Math.round(Number(metadata.width) * options.cropLeftFraction)),
      height: Number(metadata.height),
    }).ensureAlpha();
    metadata = await image.metadata();
  }
  const resized = image.resize({
    width: 1800,
    height: 1800,
    fit: 'inside',
    withoutEnlargement: false,
  });
  const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const cornerPixels = [
    0,
    (info.width - 1) * channels,
    (info.height - 1) * info.width * channels,
    ((info.height * info.width) - 1) * channels,
  ];
  const corners = cornerPixels.map((offset) => [
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  ]);
  const hasTransparentCorner = corners.some((corner) => corner[3] < 240);
  if (options.keepDarkForeground) {
    for (let offset = 0; offset < data.length; offset += channels) {
      const maximum = Math.max(data[offset], data[offset + 1], data[offset + 2]);
      const darkAlpha = Math.max(0, Math.min(255, Math.round(((150 - maximum) / 100) * 255)));
      data[offset + 3] = Math.min(data[offset + 3], darkAlpha);
    }
  } else if (options.keepNeutralLightForeground) {
    for (let offset = 0; offset < data.length; offset += channels) {
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const minimum = Math.min(red, green, blue);
      const chroma = Math.max(red, green, blue) - minimum;
      const lightAlpha = Math.max(0, Math.min(255, Math.round(((minimum - 145) / 75) * 255)));
      const neutralAlpha = Math.max(0, Math.min(255, Math.round(((55 - chroma) / 45) * 255)));
      data[offset + 3] = Math.min(data[offset + 3], lightAlpha, neutralAlpha);
    }
  } else if (options.keepLightForeground) {
    for (let offset = 0; offset < data.length; offset += channels) {
      const distanceFromWhite = Math.sqrt(
        ((255 - data[offset]) ** 2)
        + ((255 - data[offset + 1]) ** 2)
        + ((255 - data[offset + 2]) ** 2),
      );
      const lightAlpha = Math.max(0, Math.min(255, Math.round(((105 - distanceFromWhite) / 80) * 255)));
      data[offset + 3] = Math.min(data[offset + 3], lightAlpha);
    }
  } else if (!metadata.hasAlpha || !hasTransparentCorner) {
    const background = [0, 1, 2].map((channel) => Math.round(
      corners.reduce((sum, corner) => sum + corner[channel], 0) / corners.length,
    ));
    for (let offset = 0; offset < data.length; offset += channels) {
      const distance = Math.sqrt(
        ((data[offset] - background[0]) ** 2)
        + ((data[offset + 1] - background[1]) ** 2)
        + ((data[offset + 2] - background[2]) ** 2),
      );
      const alpha = Math.max(0, Math.min(255, Math.round(((distance - 8) / 55) * 255)));
      data[offset + 3] = Math.min(data[offset + 3], alpha);
    }
  }
  if (Array.isArray(options.recolor) && options.recolor.length >= 3) {
    for (let offset = 0; offset < data.length; offset += channels) {
      data[offset] = Number(options.recolor[0]);
      data[offset + 1] = Number(options.recolor[1]);
      data[offset + 2] = Number(options.recolor[2]);
    }
  }
  return sharp(data, { raw: info }).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

async function fetchSource(source) {
  const response = await fetch(source.url, {
    headers: {
      accept: 'image/svg+xml,image/*;q=0.9,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0 Safari/537.36',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let bytes = Buffer.from(await response.arrayBuffer());
  let contentType = response.headers.get('content-type') || '';
  if (source.inlineSvgId) {
    const html = bytes.toString('utf8');
    const id = source.inlineSvgId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const group = new RegExp(`<g\\s+id=["']${id}["'][^>]*>([\\s\\S]*?<svg[\\s\\S]*?<\\/svg>)[\\s\\S]*?<\\/g>`, 'i')
      .exec(html)?.[1];
    const svg = /<svg[\s\S]*?<\/svg>/i.exec(group || '')?.[0];
    if (!svg) throw new Error(`SVG inline ${source.inlineSvgId} não encontrado`);
    bytes = Buffer.from(svg.replace(/currentColor/gi, '#000000'));
    contentType = 'image/svg+xml';
  }
  if (source.svgColor) {
    const svg = bytes.toString('utf8')
      .replace(/fill="(?!none\b)[^"]+"/gi, `fill="${source.svgColor}"`)
      .replace(/fill:\s*(?!none\b)[^;"'}]+/gi, `fill:${source.svgColor}`);
    bytes = Buffer.from(svg);
    contentType = 'image/svg+xml';
  }
  return {
    bytes,
    contentType,
    finalUrl: response.url,
  };
}

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const manifestFile = path.join(OUTPUT_DIR, 'sources.json');
  const requestedSlugs = new Set(process.argv.slice(2).map((slug) => String(slug).trim()).filter(Boolean));
  const provenance = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    : {};
  for (const [slug, source] of Object.entries(SOURCES)) {
    if (requestedSlugs.size > 0 && !requestedSlugs.has(slug)) continue;
    try {
      const fetched = await fetchSource(source);
      const svg = isSvg(fetched.bytes, fetched.contentType, fetched.finalUrl);
      const preserveSvg = svg && !source.forceRaster;
      const extension = preserveSvg ? 'svg' : 'png';
      const output = path.join(OUTPUT_DIR, `${slug}.${extension}`);
      const bytes = preserveSvg ? fetched.bytes : await normalizeRaster(fetched.bytes, source);
      fs.writeFileSync(output, bytes);
      const metadata = await sharp(bytes, svg ? { density: 300 } : {}).metadata();
      provenance[slug] = {
        ...source,
        finalUrl: fetched.finalUrl,
        file: path.basename(output),
        width: metadata.width || null,
        height: metadata.height || null,
        format: metadata.format || extension,
        bytes: bytes.length,
      };
      console.log(`OK ${source.brand}: ${path.basename(output)} ${metadata.width}x${metadata.height}`);
    } catch (error) {
      const previous = provenance[slug];
      if (!previous?.file || !fs.existsSync(path.join(OUTPUT_DIR, previous.file))) {
        provenance[slug] = { ...source, error: error.message };
      }
      console.error(`ERRO ${source.brand}: ${error.message}`);
    }
  }
  fs.writeFileSync(
    manifestFile,
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
})();
