const assert = require('assert');
const {
  assessProductForNuvemshop,
  assessRemoteProductForNuvemshop,
  isPublicSizeLabel,
} = require('../src/services/nuvemshopEligibility');

function validRemote(overrides = {}) {
  return {
    id: 10,
    published: true,
    name: { pt: 'Tenis Teste' },
    brand: 'ADIDAS',
    description: { pt: 'Descricao tecnica real.' },
    images: [{ src: 'https://cdn.example.com/produto.jpg' }],
    variants: [{ price: '360.00', values: [{ pt: '40' }] }],
    ...overrides,
  };
}

function validProduct(overrides = {}) {
  return {
    id: 'p1',
    active: true,
    name: 'Tenis Teste',
    brand: 'ADIDAS',
    category: 'Calcados',
    subcategory: 'Tenis',
    longDescription: 'Descricao tecnica real.',
    shortDescription: null,
    imageUrl: 'https://cdn.example.com/produto.jpg',
    imageUrls: [],
    price: 360,
    costPrice: 200,
    aiContext: {
      confirmedForNuvemshop: true,
      classification: { modality: 'Corrida', tier: 'Treino' },
    },
    sizes: [
      { size: '40', storeStocks: [{ stock: 2 }] },
      { size: '41', storeStocks: [{ stock: 0 }] },
    ],
    ...overrides,
  };
}

assert.equal(assessProductForNuvemshop(validProduct()).eligible, true);
assert.equal(assessRemoteProductForNuvemshop(validRemote()).eligible, true);
assert.equal(assessRemoteProductForNuvemshop(validRemote({ brand: 'A DEFINIR' })).eligible, false);
assert.equal(assessRemoteProductForNuvemshop(validRemote({ variants: [{ price: '0', values: [{ pt: 'T-6100' }] }] })).eligible, false);

const badBrand = assessProductForNuvemshop(validProduct({ brand: 'A DEFINIR' }));
assert.equal(badBrand.eligible, false);
assert(badBrand.reasons.some((reason) => reason.includes('marca')));

const placeholder = assessProductForNuvemshop(validProduct({
  sizes: [{ size: 'T-6100', storeStocks: [{ stock: 3 }] }],
}));
assert.equal(placeholder.eligible, false);
assert(placeholder.reasons.includes('estoque em tamanho placeholder'));

const noConfirmation = validProduct();
noConfirmation.aiContext = {
  classification: noConfirmation.aiContext.classification,
};
assert.equal(assessProductForNuvemshop(noConfirmation).eligible, false);

assert.equal(assessProductForNuvemshop(validProduct({ price: 200 })).eligible, false);
assert.equal(assessProductForNuvemshop(validProduct({ imageUrl: null })).eligible, false);
assert.equal(assessProductForNuvemshop(validProduct({ longDescription: null })).eligible, false);

for (const label of ['34', '39/40', '09-11', 'P', 'GG', 'ÚNICO', 'XL']) {
  assert.equal(isPublicSizeLabel(label), true, label);
}
for (const label of ['T-6100', '7891234567890', '', 'SEM TAMANHO']) {
  assert.equal(isPublicSizeLabel(label), false, label);
}

console.log('nuvemshopEligibility: OK');
