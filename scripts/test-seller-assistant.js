const assert = require('assert');
const assistant = require('../src/services/sellerAssistant');

function makeProduct(id, brand) {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Produto ${id}`,
    brand,
    category: 'Calcados',
    subcategory: 'Corrida',
    shortDescription: 'Produto para corrida',
    longDescription: null,
    features: ['Amortecimento', 'Cabedal respiravel'],
    recommendedFor: ['Corrida'],
    notRecommendedFor: [],
    imageUrl: null,
    price: 499.9,
    promoPrice: 449.9,
    featured: true,
    sizes: [
      { size: '40', storeStocks: [{ storeId: 'LOJA-1', stock: 2 }, { storeId: 'LOJA-2', stock: 4 }] },
      { size: '41', storeStocks: [{ storeId: 'LOJA-1', stock: 0 }] },
    ],
  };
}

async function run() {
  assert.strictEqual(assistant.DEFAULT_CONTENT_SLOTS.length, 22, 'plano deve ter 22 produtos por dia');
  assert.strictEqual(assistant.DEFAULT_CONTENT_SLOTS.filter((slot) => slot.contentType === 'REEL').length, 12, 'reels devem usar 12 produtos');
  assert.strictEqual(assistant.DEFAULT_CONTENT_SLOTS.filter((slot) => slot.contentType === 'PHOTO').length, 10, 'stories devem usar 10 produtos');

  const products = Array.from({ length: 30 }, (_, index) => makeProduct(String(index + 1), ['Nike', 'Adidas', 'Mizuno'][index % 3]));
  const selected = assistant.selectProductsWithoutRepeating(products, 22);
  assert.strictEqual(selected.length, 22, 'deve selecionar a quantidade pedida quando ha catalogo');
  assert.strictEqual(new Set(selected.map((product) => product.id)).size, 22, 'nao deve repetir produto');

  const maxDiscountByBrand = new Map([['Nike', 15]]);
  const snapshot = assistant.makeProductSnapshot(products[0], 'LOJA-1', maxDiscountByBrand);
  assert.strictEqual(snapshot.currentPrice, 449.9, 'deve usar preco promocional real quando cadastrado');
  assert.strictEqual(snapshot.maxDiscount, 15, 'deve usar desconto maximo da regra da marca');
  assert.deepStrictEqual(snapshot.sizes, [{ size: '40', quantity: 2 }], 'deve mostrar apenas grade com estoque da loja');
  assert.strictEqual(snapshot.characteristicsComplete, true, 'produto com dados de catalogo deve estar completo');

  const incomplete = assistant.makeProductSnapshot({ ...products[0], shortDescription: '', features: [], recommendedFor: [] }, 'LOJA-1', maxDiscountByBrand);
  assert.strictEqual(incomplete.characteristicsComplete, false);
  assert(incomplete.warning.includes('Nao inventar'), 'dados ausentes devem gerar aviso para nao inventar');

  assert.strictEqual(assistant.normalizePhoneBR('(83) 99999-9999'), '5583999999999');
  assert.strictEqual(assistant.normalizePhoneBR('(55) 99999-9999'), '5555999999999', 'DDD 55 nao deve ser confundido com codigo do pais');
  assert.strictEqual(assistant.normalizePhoneBR('123'), null, 'telefone invalido deve ser rejeitado');
  const url = assistant.buildWhatsAppUrl('(83) 99999-9999', 'Ola, tudo bem?');
  assert(url.startsWith('https://wa.me/5583999999999?text='));
  assert(url.includes('Ola%2C%20tudo%20bem%3F'));

  const draft = assistant.parseWhatsappDraft('Prepare WhatsApp para (83) 99999-9999: Ola, seu pedido chegou');
  assert.deepStrictEqual(draft, { phone: '5583999999999', message: 'Ola, seu pedido chegou' });

  const assignments = [];
  const fakePrisma = {
    sellerMonthlyShift: { findFirst: async () => null },
    sellerAssistantProductAssignment: {
      findMany: async ({ where }) => {
        const rows = assignments.filter((row) => row.sellerId === where.sellerId);
        if (where.cycle != null) return rows.map((row) => ({ productId: row.productId }));
        return rows;
      },
      createMany: async ({ data }) => {
        data.forEach((row, index) => assignments.push({ id: `A-${assignments.length + index}`, status: 'ASSIGNED', note: null, completedAt: null, ...row }));
        return { count: data.length };
      },
    },
    product: { findMany: async () => products },
    brandRule: { findMany: async () => [{ brand: 'Nike', maxDiscount: 15 }] },
  };
  const seller = { id: 'VENDEDOR-1', name: 'Ana', storeId: 'LOJA-1', store: { id: 'LOJA-1', code: 'L1', name: 'Loja 1' } };
  const profile = { id: 'ASSISTENTE-1', sellerId: seller.id, contentCycle: 1 };
  const firstPlan = await assistant.ensureDailyContentPlan(fakePrisma, profile, seller, new Date('2026-07-20T12:00:00'));
  const secondPlan = await assistant.ensureDailyContentPlan(fakePrisma, profile, seller, new Date('2026-07-20T15:00:00'));
  assert.strictEqual(firstPlan.assignedCount, 22, 'primeiro acesso deve montar o plano completo');
  assert.strictEqual(secondPlan.assignedCount, 22, 'novo acesso deve recuperar o mesmo plano');
  assert.strictEqual(assignments.length, 22, 'reabrir o assistente nao pode duplicar atribuicoes');
  assert.strictEqual(new Set(assignments.map((row) => row.productId)).size, 22, 'persistencia deve manter produtos distintos');

  console.log('OK: assistente individual, plano sem repeticao e WhatsApp preparado');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
