const assert = require('assert');
const {
  assessProductForNuvemshop,
  assessRemoteProductForNuvemshop,
  hasRemoteUsableImage,
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
      color: 'Preto/Branco',
      classification: { modality: 'Corrida', tier: 'Treino' },
    },
    sizes: [
      { size: '40', barcode: '7890000000040', stock: 5, sizeConfirmedAt: new Date('2026-06-10T12:00:00Z'), storeStocks: [{ stock: 2 }] },
      { size: '41', barcode: '7890000000041', stock: 5, sizeConfirmedAt: new Date('2026-06-10T12:00:00Z'), storeStocks: [{ stock: 0 }] },
    ],
    ...overrides,
  };
}

assert.equal(assessProductForNuvemshop(validProduct()).eligible, true);
assert.equal(assessRemoteProductForNuvemshop(validRemote()).eligible, true);
assert.equal(hasRemoteUsableImage(validRemote()), true);
assert.equal(hasRemoteUsableImage(validRemote({ images: [] })), false);
assert.equal(assessRemoteProductForNuvemshop(validRemote({ brand: 'A DEFINIR' })).eligible, false);
assert.equal(assessRemoteProductForNuvemshop(validRemote({ variants: [{ price: '0', values: [{ pt: 'T-6100' }] }] })).eligible, false);

const badBrand = assessProductForNuvemshop(validProduct({ brand: 'A DEFINIR' }));
assert.equal(badBrand.eligible, false);
assert(badBrand.reasons.some((reason) => reason.includes('marca')));

// Trava rigorosa (2026-11-12): tamanho técnico com estoque NÃO sobe.
const placeholder = assessProductForNuvemshop(validProduct({
  brand: 'MIZUNO',
  sizes: [{ size: 'T-6100', barcode: '7890000006100', storeStocks: [{ stock: 3 }] }],
}));
assert.equal(placeholder.eligible, false);
assert(placeholder.reasons.some((reason) => reason.includes('tamanho tecnico')));

const nikeUnconfirmed = assessProductForNuvemshop(validProduct({
  brand: 'NIKE',
  sizes: [{ size: '40', barcode: '7890000000040', sizeConfirmedAt: null, storeStocks: [{ stock: 2 }] }],
}));
assert.equal(nikeUnconfirmed.eligible, true);
assert(nikeUnconfirmed.warnings.some((warning) => warning.includes('sem confirmação')));

assert.equal(assessRemoteProductForNuvemshop(validRemote({
  variants: [{ price: '360', values: [{ pt: 'T-6100' }] }],
})).eligible, true);

const noConfirmation = validProduct();
noConfirmation.aiContext = {
  classification: noConfirmation.aiContext.classification,
};
assert.equal(assessProductForNuvemshop(noConfirmation).eligible, false);

assert.equal(assessProductForNuvemshop(validProduct({ price: 200 })).eligible, false);
assert.equal(assessProductForNuvemshop(validProduct({ imageUrl: null })).eligible, false);
assert.equal(assessProductForNuvemshop(validProduct({ longDescription: null })).eligible, false);

// Trava rigorosa: cada erro da auditoria de 2026-11-12 recusa sozinho.
const withCtx = (extra) => { const p = validProduct(); p.aiContext = { ...p.aiContext, ...extra }; return p; };
const reasonOf = (p) => assessProductForNuvemshop(p).reasons.join(' | ');
assert.match(reasonOf(withCtx({ color: '' })), /sem cor/);
assert.match(reasonOf(validProduct({ name: '350001 TENIS COURO 123 IMIGRANTE PRETO' })), /nome cru/);
assert.match(reasonOf(validProduct({ name: 'U23TW014-MEIAO UNISEX UMBRO CLASSIC-BCO-222-Tam:39-43' })), /nome cru/);
assert.match(reasonOf(validProduct({ name: 'Tenis 7891234567890 Corrida' })), /nome cru/);
assert.equal(assessProductForNuvemshop(validProduct({ name: 'Tênis Adidas Duramo RC2 Preto' })).eligible, true);
assert.equal(assessProductForNuvemshop(validProduct({ name: 'Tênis Asics Gel-Nimbus 26' })).eligible, true);
assert.match(reasonOf(validProduct({ costPrice: 0 })), /sem custo/);
// Endurecimento 2026-11-12: nome/cor crus que passavam na trava antiga
assert.match(reasonOf(validProduct({ name: 'TENIS CK00040003 CHUCK TAYLOR ALL STAR MARINHO/CRU/PRETO 27' })), /tamanho no nome/);
assert.match(reasonOf(validProduct({ name: 'TENIS STATION 3 SEFA217 ADT. SINTETICO EVERLAST BRANCO/DOURADO 37 REF SEFA217.217D.37' })), /REF no nome/);
assert.match(reasonOf(validProduct({ name: 'CALCADO GRESCA 2.0 02 BRANCO TAM 42' })), /tamanho no nome/);
assert.match(reasonOf(validProduct({ name: 'SAPATILHA TRAINING - FIBER 0896-V2 38/39' })), /tamanho no nome/);
assert.match(reasonOf(validProduct({ name: 'CHUTEIRA TP05090001 TOPPER DOMINATOR PRO V SCTY' })), /codigo de artigo/);
assert.match(reasonOf(validProduct({ name: 'TENIS FLYER LITE 3 WNS BDP  PUMA Black-PUMA Pink 39' })), /nome cru/);
assert.match(reasonOf(withCtx({ color: 'BKW' })), /cor abreviada/);
assert.match(reasonOf(withCtx({ color: 'Vm' })), /cor abreviada/);
assert.match(reasonOf(withCtx({ color: 'Branco Tam' })), /cor crua/);
assert.equal(assessProductForNuvemshop(validProduct({ name: 'Tênis Nike Pegasus 41' })).eligible, true);
assert.equal(assessProductForNuvemshop(validProduct({ name: 'Gel Kayano 31 Preto' })).eligible, true);
assert.equal(assessProductForNuvemshop(withCtx({ color: 'Sea Glass/Neon Flame' })).eligible, true);
assert.equal(assessProductForNuvemshop(withCtx({ color: 'Azul' })).eligible, true);
assert.match(reasonOf(withCtx({ color: 'JBBKHG' })), /cor abreviada/);
assert.match(reasonOf(withCtx({ color: 'Black/Asphal/Clr' })), /cor abreviada/);
assert.match(reasonOf(validProduct({ name: 'TENIS UA UA DIME' })), /abreviacao/);
assert.match(reasonOf(validProduct({ name: 'TENIS CALCADOS ESPORTIVO MIZ WAVE STRATOS 3' })), /texto fiscal/);
assert.match(reasonOf(validProduct({ name: 'CHUTEIRA FUTSAL JOMA DRIBLING (PTO VDE)' })), /abreviacao/);
assert.match(reasonOf(validProduct({ name: 'SPO01 CHINELO SLIDE' })), /codigo de artigo/);
assert.match(reasonOf(validProduct({ name: 'TENIS NK BIG LOW MASCULINO HO25' })), /temporada/);
assert.equal(assessProductForNuvemshop(withCtx({ color: 'ILLUSION BLUE/AMBER' })).eligible, true);
assert.equal(assessProductForNuvemshop(withCtx({ color: 'CAFÉ/PALHA' })).eligible, true);
assert.match(reasonOf(validProduct({ sizes: [
  { size: '40', barcode: '111', stock: 5, storeStocks: [{ stock: 1 }] },
  { size: '41', barcode: '111', stock: 5, storeStocks: [{ stock: 1 }] },
] })), /mesmo codigo/);
assert.match(reasonOf(validProduct({ sizes: [{ size: '40', barcode: null, stock: 5, storeStocks: [{ stock: 1 }] }] })), /sem codigo de barras/);
assert.match(reasonOf(validProduct({ sizes: [{ size: '40', barcode: '111', stock: 1, storeStocks: [{ stock: 3 }] }] })), /maior que comprado/);
// Estoque só das lojas 04/06/07: outra loja não conta.
assert.match(reasonOf(validProduct({ sizes: [{ size: '40', barcode: '111', stock: 5,
  storeStocks: [{ storeId: '5fb0bab8-57c3-4252-ae44-eb434ee14474', stock: 4 }] }] })), /sem tamanho valido/);
assert.equal(assessProductForNuvemshop(validProduct({ sizes: [{ size: '40', barcode: '111', stock: 5,
  storeStocks: [{ storeId: '9bcd3735-f5ed-41d7-a851-5896a83a6084', stock: 2 }, { storeId: '5fb0bab8-57c3-4252-ae44-eb434ee14474', stock: 9 }] }] })).eligible, true);

for (const label of ['34', '39/40', '09-11', 'P', 'GG', 'ÚNICO', 'XL']) {
  assert.equal(isPublicSizeLabel(label), true, label);
}
for (const label of ['T-6100', '7891234567890', '', 'SEM TAMANHO']) {
  assert.equal(isPublicSizeLabel(label), false, label);
}

console.log('nuvemshopEligibility: OK');
