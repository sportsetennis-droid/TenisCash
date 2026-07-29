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

console.log('Identificação semântica das etiquetas validada.');
