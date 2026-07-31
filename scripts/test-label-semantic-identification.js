const assert = require('node:assert/strict');
const labels = require('../src/routes/labels');

const cases = [
  {
    product: {
      name: '1013017-JOELHEIRA UNISEX UMBRO NEOPRENE-PTO/AZUL-351-Tam:G',
      brand: 'Umbro',
      category: 'tenis',
      subcategory: 'Unissex',
    },
    context: {
      color: 'PTO/AZUL',
      supplierRef: '6295',
      classification: { type: 'Outro', modality: 'Outro', tier: 'Básica' },
    },
    reference: '6295',
    description: 'JOELHEIRA UMBRO NEOPRENE',
    style: 'PROTEÇÃO ESPORTIVA',
  },
  {
    product: {
      name: '901234-CHUTEIRA UMBRO ADAMANT MASTER CLASS PRO DLM-PTO/BCO-Tam:41',
      brand: 'Umbro',
      category: 'Chuteiras',
      subcategory: 'Campo',
    },
    context: {
      color: 'PTO/BCO',
      classification: { type: 'Chuteira', modality: 'Campo', tier: 'Premium' },
    },
    reference: '901234',
    description: 'CHUTEIRA UMBRO ADAMANT MASTER CLASS PRO DLM',
    style: 'CAMPO',
  },
  {
    product: {
      name: 'CAMISETA UMBRO TREINO AZUL Tam:M',
      brand: 'Umbro',
      category: 'Roupas',
      subcategory: 'Camisetas',
    },
    context: {
      color: 'AZUL',
      classification: { type: 'Camiseta', modality: 'Outro', tier: 'Básica' },
    },
    reference: '',
    description: 'CAMISETA UMBRO TREINO',
    style: 'ROUPA ESPORTIVA',
  },
  {
    product: {
      name: 'MEIA UNISSEX DE USO COMUM CANO CURTO BRANCO/BRANCO',
      brand: 'ACTVITTA',
      category: 'tenis',
      subcategory: 'Unissex',
    },
    context: {
      color: 'BRANCO/BRANCO',
      supplierRef: '5650',
      classification: { type: 'Outro', modality: 'Meia', tier: 'Básica' },
    },
    reference: '5650',
    description: 'MEIA ACTVITTA DE USO COMUM CANO CURTO',
    style: 'ACESSÓRIO ESPORTIVO',
  },
  {
    product: {
      name: 'BERMUDA COR: 077 (PRETO) TAM:',
      brand: 'Body for Sure',
      category: 'Roupas',
      subcategory: 'Mulher',
    },
    context: {
      color: 'Preto',
      supplierRef: '04843',
      classification: { modality: 'Bermuda', tier: 'Texturizada Leopard' },
    },
    reference: '04843',
    description: 'BERMUDA BODY FOR SURE',
    style: 'ROUPA ESPORTIVA',
  },
  {
    product: {
      name: 'CAMISETA MASC BIG LOG P/GG 2442',
      brand: 'ADIDAS',
      category: 'Vestuário',
      subcategory: 'Homem',
    },
    context: {
      supplierRef: '2442',
      classification: { modality: 'Camiseta', tier: 'Básica' },
    },
    reference: '2442',
    description: 'CAMISETA ADIDAS BIG LOG',
    style: 'ROUPA ESPORTIVA',
  },
  {
    product: {
      name: 'DIADORA DFSC082-06 PLAYMAKER BRANCO/LILAS',
      brand: 'DIADORA',
      category: 'Tênis',
      subcategory: 'Unissex',
    },
    context: {
      classification: { modality: 'Estilo de Vida', tier: 'Casual' },
    },
    reference: '',
    description: 'TÊNIS DIADORA PLAYMAKER',
    style: 'TÊNIS',
  },
  {
    product: {
      name: 'SANDALIA MASC HURLEY ONE E ONLY DENIM 43/44/2',
      brand: 'HURLEY',
      category: 'Calçados',
      subcategory: 'Homem',
    },
    context: {
      supplierRef: 'HU0001C0009',
      classification: { type: 'Outro', modality: 'Sandália', tier: 'Básica' },
    },
    reference: 'HU0001C0009',
    description: 'SANDÁLIA HURLEY ONE E ONLY DENIM',
    style: 'SANDÁLIA',
  },
  {
    product: {
      name: 'REF: GW1988 - ADIDAS TENIS TENSAUR SPORT 2 0 18/24 1122222',
      brand: 'ADIDAS',
      category: 'Calçados',
    },
    context: {
      supplierRef: 'GW1988',
      classification: {},
    },
    reference: 'GW1988',
    description: 'TÊNIS ADIDAS TENSAUR SPORT 2.0',
    style: 'TÊNIS',
  },
  {
    product: {
      name: 'CHUTEIRA FUTSAL JOMA TOP FLEX JR VELCRO- AZL',
      brand: 'JOMA',
      category: 'Chuteiras',
      subcategory: 'Menino',
    },
    context: {
      supplierRef: 'TPJS2444INV.26',
      classification: { type: 'Chuteira', modality: 'Futsal', tier: 'Treino' },
    },
    reference: '',
    description: 'CHUTEIRA JOMA TOP FLEX JR VELCRO',
    style: 'FUTSAL',
  },
];

for (const testCase of cases) {
  const description = labels.labelProductDescription(
    testCase.product,
    testCase.product.name,
    testCase.reference,
    '',
    testCase.context,
  );
  const style = labels.labelStyle(testCase.product, testCase.context.classification);

  assert.equal(description, testCase.description);
  assert.equal(style, testCase.style);
  const requiredPrefix = `${labels.labelProductType(testCase.product, testCase.product.name)} ${testCase.product.brand}`
    .toLocaleUpperCase('pt-BR');
  assert.ok(description.startsWith(requiredPrefix), `${description} deve começar com ${requiredPrefix}`);
  assert.ok(
    labels.labelProductName(testCase.product, testCase.product.name).startsWith(requiredPrefix),
    `labelProductName também deve começar com ${requiredPrefix}`,
  );
  assert.doesNotMatch(description, /\b(?:tam|tamanho)\b/i);
  assert.doesNotMatch(description, /\bcal[cç]ados?\s+esportiv[oa]s?\b/i);
  assert.doesNotMatch(style, /\bcal[cç]ados?\s+esportiv[oa]s?\b/i);
}

assert.equal(
  labels.labelProductColor({ name: 'CAMISETA TESTE' }, { color: 'Azul Marinho' }),
  'AZUL/MARINHO',
);
assert.equal(
  labels.labelProductColor({ name: 'CAMISETA COR GELO TAM M' }, {}),
  'GELO',
);
assert.equal(
  labels.labelProductColor({ name: 'BERMUDA COR: 077 (PRETO) TAM:' }, {}),
  'PRETO',
);
assert.equal(
  labels.labelProductColor({ name: 'SHORT CORTADO A LASER' }, {}),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'SHORT PROGNE SPORTS - PRETO/ROSA - M', brand: 'PROGNE' }, {}),
  'PRETO/ROSA',
);
assert.equal(
  labels.labelProductColor({ name: 'KING STRAP PUMA BLACK-PUMA WHIT G', brand: 'PUMA' }, {}),
  'PRETO/BRANCO',
);
assert.equal(
  labels.labelProductColor(
    { name: 'CAMISETA M/C PUMA CLASS GRAPHIC TEE NEW NAVY GG', brand: 'PUMA' },
    { color: 'M/C' },
  ),
  'MARINHO',
);
assert.equal(
  labels.labelProductColor(
    { name: 'SHORT PROGNE SPORTS - PRETO/AMARELO - G', brand: 'PROGNE' },
    { color: 'G/GG' },
  ),
  'PRETO/AMARELO',
);
assert.equal(
  labels.labelProductColor({ name: 'BOLA TESTE', brand: 'EVERLAST' }, { color: 'EVA/BORRACHA' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'BOLA STREETBALL', brand: 'SPALDING' }, { color: 'Varsity Tf' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'REEBOK' }, { color: 'CLARO/TAMANHO' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'VOLLO' }, { color: 'Cinza C/ Bomba' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'N1' }, { color: 'Cinza | Tam. G | Training' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'MUNICH' }, { color: 'Azul Tam' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'PENALTY' }, { color: 'Pt T' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'SKECHERS' }, { color: 'WPK' }),
  'BRANCO/ROSA',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'CAJU BRASIL' }, { color: 'Azul Blue Jeans' }),
  'Azul Blue Jeans',
);
assert.equal(
  labels.labelProductColor({ name: 'ROYAL ULTRA FLASH', brand: 'REEBOK' }, {}),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'Gel-Cumulus 27 Blue Fade/White', brand: 'ASICS' }, {}),
  '',
);
assert.equal(
  labels.labelProductColor(
    { name: 'TENIS CK12510001 CHUCK TAYLOR LILAS VIOLETA/MENTA EXTRA/BRANCO 27', brand: 'CONVERSE' },
    {},
  ),
  '',
);
assert.equal(
  labels.labelProductColor(
    { name: 'TENIS CT30140002 CHUCK TAYLOR ALL STAR LAVANDA 02/LILAS VIOLETA/BRANCO 35', brand: 'CONVERSE' },
    {},
  ),
  '',
);
assert.equal(
  labels.labelProductColor(
    { name: 'CHUTEIRA OXN TRACK 4 FIT SOCIETY - GELO/VERDE MENTA/MARINHO', brand: 'OXN' },
    {},
  ),
  'GELO/VERDE MENTA/MARINHO',
);
assert.equal(
  labels.labelProductColor({ name: 'DIADORA PLAYMAKER AREIA/PRETO', brand: 'DIADORA' }, {}),
  'AREIA/PRETO',
);
assert.equal(
  labels.labelProductColor({ name: 'SPO01 CHINELO SLIDE BRANCO/PRETO', brand: 'SPEEDO' }, {}),
  'BRANCO/PRETO',
);
assert.equal(
  labels.labelProductColor(
    { name: 'U01FB00168-CHUTEIRA SOCIETY UMBRO TECHNO-PRE/LIMA/CNZ-168', brand: 'UMBRO' },
    {},
  ),
  'PRETO/LIMA/CINZA',
);
assert.equal(
  labels.labelProductColor({ name: 'TOP BASIC COLORS LATTE', brand: "LET'S GYM" }, { color: 'Latte' }),
  'Latte',
);
assert.equal(
  labels.labelProductColor({ name: 'BLUSA MANGA CURTA', brand: "LET'S GYM" }, { color: 'M/C' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'HOPE RESORT' }, { color: 'Bicolor Preto E' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'KAPPA' }, { color: 'Marinho M.' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'VISTHO' }, { color: 'Pvc' }),
  '',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO TESTE', brand: 'MORMAII' }, { color: 'NAVY/LIGHT' }),
  '',
);
assert.equal(
  labels.labelProductColor(
    { name: 'LUVAS KICK PRETO FUCCIA AZUL CLARO/TAMANHO', brand: 'REEBOK' },
    { color: 'CLARO/TAMANHO' },
  ),
  'PRETO/FUCSIA/AZUL CLARO',
);
assert.equal(
  labels.labelProductColor({ name: 'POCHETE TRIATHLON PRETO G/GG', brand: 'HIDROLIGHT' }, { color: 'G/GG' }),
  'PRETO',
);
assert.equal(
  labels.labelProductColor(
    { name: 'CAMISETA PENALTY X PRETO T', brand: 'PENALTY' },
    { color: 'Pt T' },
  ),
  'PRETO',
);
assert.equal(
  labels.labelProductColor(
    { name: 'CAMISETA EVERLAST BASIC PRETO/VERMELHO 38 REF 991', brand: 'EVERLAST' },
    {},
  ),
  'PRETO/VERMELHO',
);
assert.equal(
  labels.labelProductColor({ name: 'BOLA REACT TF-250 FIBA - LRJ PTO', brand: 'SPALDING' }, { color: '250 Fiba' }),
  'LARANJA/PRETO',
);
assert.equal(
  labels.labelProductColor({ name: 'MOCHILA AEROTREK 30', brand: 'SALOMON' }, { color: 'ANTHRACITE/IRON/ALLOY' }),
  'ANTHRACITE/IRON/ALLOY',
);
assert.equal(
  labels.labelProductColor({ name: 'TENIS TESTE', brand: 'SALOMON' }, { color: 'BR/PT/VM' }),
  'BRANCO/PRETO/VERMELHO',
);
assert.equal(
  labels.labelProductColor({ name: 'PRODUTO CORAL', brand: 'BROOKS' }, { color: 'Coral' }),
  'Coral',
);
assert.equal(
  labels.labelProductColor(
    { name: 'CAMISETA TESTE', brand: 'PUMA' },
    { color: 'Azul', cor: 'Preto' },
  ),
  '',
);

assert.deepEqual(
  labels.labelProductColorIssue({ name: 'BLUSA MANGA CURTA', brand: "LET'S GYM" }, { color: 'M/C' }),
  {
    type: 'not-color',
    raw: 'M/C',
    short: 'DÚVIDA: M/C NÃO É COR',
    detail: 'DÚVIDA: M/C NÃO É COR',
  },
);
assert.deepEqual(
  labels.labelProductColorIssue({ name: 'TENIS ADIDAS TESTE', brand: 'ADIDAS' }, { color: 'GUM5' }),
  {
    type: 'unmapped',
    raw: 'GUM5',
    short: 'DÚVIDA: CÓD. GUM5',
    detail: 'DÚVIDA: CÓDIGO GUM5 NÃO MAPEADO',
  },
);
assert.deepEqual(
  labels.labelProductColorIssue({ name: 'TENIS ADIDAS TESTE', brand: 'ADIDAS' }, {}),
  {
    type: 'missing',
    short: 'DÚVIDA: SEM CADASTRO',
    detail: 'DÚVIDA: SEM COR NO CADASTRO',
  },
);
assert.deepEqual(
  labels.labelProductColorIssue(
    { name: 'CAMISETA TESTE', brand: 'PUMA' },
    { color: 'Azul', cor: 'Preto' },
  ),
  {
    type: 'conflict',
    colors: ['AZUL', 'PRETO'],
    short: 'DÚVIDA: CORES DIVERGEM',
    detail: 'DÚVIDA: CORES DIVERGENTES: AZUL / PRETO',
  },
);
assert.deepEqual(
  labels.labelProductColorIssue(
    { name: 'PRODUTO TESTE', brand: 'HOPE RESORT' },
    { color: 'Bicolor Preto E' },
  ),
  {
    type: 'incomplete',
    raw: 'Bicolor Preto E',
    short: 'DÚVIDA: COR INCOMPLETA',
    detail: 'DÚVIDA: COR INCOMPLETA: BICOLOR PRETO E',
  },
);
assert.deepEqual(
  labels.labelProductColorIssue(
    { name: 'PRODUTO TESTE', brand: 'KAPPA' },
    { color: 'Marinho M.' },
  ),
  {
    type: 'mixed-size',
    raw: 'Marinho M.',
    short: 'DÚVIDA: COR COM TAMANHO',
    detail: 'DÚVIDA: COR MISTURADA COM TAMANHO: MARINHO M.',
  },
);
assert.equal(
  labels.labelProductColorIssue(
    { name: 'CAMISETA M/C PUMA CLASS GRAPHIC TEE NEW NAVY GG', brand: 'PUMA' },
    { color: 'M/C' },
  ),
  null,
);

const legacyFootwear = {
  name: ['TENIS', 'CALCADO', 'ESPORTIVO', 'MIZ.WAVE ENDEAVOR 3 ROSA46'].join(' '),
  brand: 'MIZUNO',
  category: 'Tênis',
};
const legacyDescription = labels.labelProductDescription(legacyFootwear, legacyFootwear.name);
assert.match(legacyDescription, /^TÊNIS MIZUNO\b/);
assert.doesNotMatch(legacyDescription, /\bcal[cç]ados?\s+esportiv[oa]s?\b/i);

assert.deepEqual(
  [
    'Único-5208', 'T-4065426038514', '38', 'M', '43/44/2', '40.5',
    '4041', 'GG-1735', '?-6717', 'T-42', '39BRA',
  ].map(labels.normalizeLabelAvailableSize),
  ['ÚNICO', '', '38', 'M', '43/44/2', '40,5', '40/41', 'GG', '', '42', '39'],
);

console.log('Identificação semântica das etiquetas validada.');
