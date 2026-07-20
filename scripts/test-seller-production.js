const assert = require('assert');
const production = require('../src/services/sellerProduction');

function run() {
  assert.strictEqual(production.RULES.length, 18, 'deve haver 18 atividades por dia');
  assert.strictEqual(production.RULES.filter((r) => r.mediaType === 'video').length, 6, 'deve haver 6 reels');
  assert.strictEqual(production.RULES.filter((r) => r.mediaType === 'photo').length, 12, 'deve haver 12 stories');
  assert(production.RULES.filter((r) => r.mediaType === 'video').every((r) => r.whatsappRequired), 'todo reels deve ir para o status do WhatsApp');

  const productRule = production.ruleForKey('FIRST_TURN_REEL_1');
  const completeProductPayload = {
    publicationUrl: 'https://instagram.com/reel/teste',
    durationSeconds: 45,
    productRefs: ['Tenis A 40', 'Tenis B 41', 'Tenis C 42'],
    confirmations: {
      priceInformed: true,
      maxDiscountInformed: true,
      technologiesExplained: true,
      differentialsExplained: true,
      whatsappReposted: true,
    },
    noInstagramStoryConfirmed: true,
  };
  assert.deepStrictEqual(production.validateSubmission(productRule, completeProductPayload, { evidenceKinds: ['WHATSAPP_PROOF'] }), [], 'reels completo deve ser valido');

  const wrongDuration = production.validateSubmission(productRule, { ...completeProductPayload, durationSeconds: 44 }, { evidenceKinds: ['WHATSAPP_PROOF'] });
  assert(wrongDuration.some((message) => message.includes('45 segundos')), 'duracao deve ser exata');

  const noFeedLink = production.validateSubmission(productRule, { ...completeProductPayload, publicationUrl: '' }, { evidenceKinds: ['WHATSAPP_PROOF'], evidenceMediaTypes: ['video'] });
  assert(noFeedLink.some((message) => message.includes('link do Reels')), 'reels precisa do link publicado no feed');

  const repeated = production.validateSubmission(productRule, completeProductPayload, { usedProductRefs: ['tênis a 40'], evidenceKinds: ['WHATSAPP_PROOF'] });
  assert(repeated.some((message) => message.includes('repetido')), 'produto nao pode repetir no dia');

  const arrival = production.ruleForKey('ARRIVAL_REEL_1');
  const missingWhatsapp = production.validateSubmission(arrival, {
    publicationUrl: 'https://instagram.com/reel/chegada',
    durationSeconds: 20,
    confirmations: { sellerName: true, shiftHours: true, availableForSales: true, whatsappReposted: true },
    noInstagramStoryConfirmed: true,
  });
  assert(missingWhatsapp.some((message) => message.includes('WhatsApp')), 'chegada precisa de prova do WhatsApp');

  const eligible = production.monthlyEligibility([{ status: 'APPROVED' }, { status: 'APPROVED' }, { status: 'EXCUSED' }], 2000, { periodClosed: true });
  assert.strictEqual(eligible.status, 'ELIGIBLE');
  assert.strictEqual(eligible.expectedDays, 2);
  assert.strictEqual(eligible.eligibleAmount, 200);

  const allOrNothing = production.monthlyEligibility([{ status: 'APPROVED' }, { status: 'NONCOMPLIANT' }], 2000, { periodClosed: true });
  assert.strictEqual(allOrNothing.status, 'INELIGIBLE');
  assert.strictEqual(allOrNothing.eligibleAmount, null);

  const open = production.monthlyEligibility([{ status: 'APPROVED' }, { status: 'OPEN' }], 2000, { periodClosed: false });
  assert.strictEqual(open.status, 'OPEN');
  assert.strictEqual(open.openDays, 1);

  console.log('OK: producao diaria, validacoes e elegibilidade mensal');
}

run();
