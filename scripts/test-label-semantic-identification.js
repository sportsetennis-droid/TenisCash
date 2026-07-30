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
    description: 'MEIA DE USO COMUM CANO CURTO',
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
    description: 'BERMUDA',
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
    description: 'CAMISETA BIG LOG',
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
    description: 'DIADORA PLAYMAKER',
    style: 'CALÇADO ESPORTIVO',
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
    description: 'SANDALIA HURLEY ONE E ONLY DENIM',
    style: 'CALÇADO ESPORTIVO',
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
    description: 'ADIDAS TENIS TENSAUR SPORT 2.0',
    style: 'CALÇADO ESPORTIVO',
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
  assert.doesNotMatch(description, /\b(?:tam|tamanho)\b/i);
}

assert.deepEqual(
  [
    'Único-5208', 'T-4065426038514', '38', 'M', '43/44/2', '40.5',
    '4041', 'GG-1735', '?-6717', 'T-42', '39BRA',
  ].map(labels.normalizeLabelAvailableSize),
  ['ÚNICO', '', '38', 'M', '43/44/2', '40,5', '40/41', 'GG', '', '42', '39'],
);

console.log('Identificação semântica das etiquetas validada.');
