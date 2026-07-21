const assert = require('assert');
const {
  amountAtPct,
  rulesForPosition,
  ruleForStage,
  stageAvailability,
  createJourneyForSale,
  submitReservedReferralAfterPayment,
  cancelJourneyForSale,
} = require('../src/services/relationshipCommission');

assert.strictEqual(amountAtPct(1000, 1), 10);
assert.strictEqual(amountAtPct(1000, 0.1), 1);
assert.strictEqual(rulesForPosition(1)[0].targetPct, 1);
assert.strictEqual(rulesForPosition(1).at(-1).targetPct, 1.5);
assert.strictEqual(rulesForPosition(2)[0].targetPct, 1.5);
assert.strictEqual(rulesForPosition(2).at(-1).targetPct, 2);
assert.strictEqual(ruleForStage(2, 'REFERRAL_CONVERTED').referral, true);

const saleDate = new Date('2026-07-01T12:00:00.000Z');
const journey = {
  purchasePosition: 1,
  status: 'ACTIVE',
  sale: { createdAt: saleDate },
};
const rules = rulesForPosition(1);
const stages = rules.map((rule, index) => ({
  key: rule.key,
  status: index === 0 ? 'COMPLETED' : 'PENDING',
}));
let available = stageAvailability(journey, stages, new Date('2026-07-02T12:00:00.000Z'));
assert.strictEqual(available.find((x) => x.key === 'CUSTOMER_REGISTERED').available, true);
assert.strictEqual(available.find((x) => x.key === 'FEED_PHOTO').available, false);

for (const key of ['CUSTOMER_REGISTERED', 'FEED_PHOTO', 'TESTIMONIAL_REEL']) {
  stages.find((stage) => stage.key === key).status = 'COMPLETED';
}
available = stageAvailability(journey, stages, new Date('2026-07-07T11:59:59.000Z'));
assert.strictEqual(available.find((x) => x.key === 'POST_SALE').available, false);
available = stageAvailability(journey, stages, new Date('2026-07-08T12:00:00.000Z'));
assert.strictEqual(available.find((x) => x.key === 'POST_SALE').available, true);
stages.find((stage) => stage.key === 'POST_SALE').status = 'SUBMITTED';
available = stageAvailability(journey, stages, new Date('2026-07-08T12:00:00.000Z'));
assert.strictEqual(available.find((x) => x.key === 'POST_SALE').available, false);
assert.strictEqual(available.find((x) => x.key === 'POST_SALE').waitingReason, 'Aguardando fiscalizacao');
stages.find((stage) => stage.key === 'POST_SALE').status = 'REJECTED';
available = stageAvailability(journey, stages, new Date('2026-07-08T12:00:00.000Z'));
assert.strictEqual(available.find((x) => x.key === 'POST_SALE').available, true, 'etapa devolvida pode ser corrigida e reenviada');

async function testJourneyCreation() {
  let created;
  const tx = {
    sellerCommissionJourney: {
      findUnique: async () => null,
      count: async () => 2,
      create: async ({ data }) => { created = data; return data; },
    },
  };
  await createJourneyForSale(tx, {
    sale: { id: 'sale-3', totalAmount: 480, tcUsed: 30, createdAt: saleDate },
    sellerId: 'seller-1',
    customer: { id: 'customer-1', name: 'Cliente Teste', phone: '83999999999' },
    storeId: 'store-1',
  });
  assert.strictEqual(created.purchasePosition, 1, 'a terceira compra reinicia na primeira posicao');
  assert.strictEqual(created.cycleNumber, 2, 'a terceira compra abre o segundo ciclo');
  assert.strictEqual(created.baseAmount, 450, 'a base usa somente o valor efetivamente pago');
  assert.strictEqual(created.earnedAmount, 4.5);
}

async function testReferralCancellation() {
  const calls = { stage: [], journey: [] };
  const tx = {
    sellerCommissionJourney: {
      findUnique: async () => null,
      update: async (args) => { calls.journey.push(args); },
    },
    sellerCommissionStage: {
      findMany: async () => [{
        id: 'referral-stage', journeyId: 'origin-journey', status: 'COMPLETED', targetPct: 2, deltaPct: 0.1, amount: 1,
        journey: { earnedAmount: 20 },
      }],
      update: async (args) => { calls.stage.push(args); },
    },
  };
  const result = await cancelJourneyForSale(tx, 'referred-sale', 'Compra indicada cancelada');
  assert.strictEqual(result.referralBonusesReversed, 1);
  assert.strictEqual(calls.stage[0].data.status, 'REJECTED', 'a etapa volta para correcao e pode receber nova indicacao valida');
  assert.strictEqual(calls.stage[0].data.referredSaleId, null);
  assert.strictEqual(calls.journey[0].data.currentPct, 1.9);
  assert.strictEqual(calls.journey[0].data.earnedAmount, 19, 'o bonus e retirado uma unica vez');
  assert.deepStrictEqual(calls.journey[0].data.reversedAmount, { increment: 1 });
}

async function testReservedReferralAfterPayment() {
  const stages = rulesForPosition(2).map((rule, index) => ({
    id: `stage-${index}`,
    key: rule.key,
    position: index,
    title: rule.title,
    status: index === 5 ? 'PENDING' : 'COMPLETED',
    referredSaleId: null,
  }));
  const calls = { stage: [], code: [] };
  const tx = {
    sale: { findUnique: async () => ({ id: 'sale-paid', status: 'completed', referralCode: 'STIABC', sellerId: 'seller-1', storeId: 'store-1', customerUserId: 'customer-new' }) },
    sellerReferralCode: {
      findUnique: async () => ({
        id: 'ref-1', code: 'STIABC', status: 'RESERVED', referredSaleId: 'sale-paid', sellerId: 'seller-1',
        originCustomerUserId: 'customer-origin', originStoreId: 'store-1',
        originJourney: { id: 'journey-origin', purchasePosition: 2, status: 'ACTIVE', sale: { createdAt: new Date('2026-07-01T12:00:00.000Z'), status: 'completed' }, stages },
      }),
      updateMany: async (args) => { calls.code.push(args); return { count: 1 }; },
    },
    sellerCommissionStage: { updateMany: async (args) => { calls.stage.push(args); return { count: 1 }; } },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const result = await submitReservedReferralAfterPayment(prisma, 'sale-paid');
  assert.strictEqual(result.submitted, true);
  assert.strictEqual(calls.stage[0].data.status, 'SUBMITTED', 'pagamento confirmado deve enviar a etapa para fiscalizacao');
  assert.strictEqual(calls.code[0].data.status, 'CONVERTED', 'codigo reservado deve ser convertido somente apos pagamento');
}

(async () => {
  await testJourneyCreation();
  await testReferralCancellation();
  await testReservedReferralAfterPayment();
  console.log('relationshipCommission: OK');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
