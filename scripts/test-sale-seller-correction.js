const assert = require('node:assert/strict');
const { correctSaleSeller } = require('../src/services/saleSellerCorrection');
const relationship = require('../src/services/relationshipCommission');

const copy = value => structuredClone(value);
const saleDate = new Date('2026-09-11T14:00:00Z');
function fixture() {
  return {
    config: { value: JSON.stringify({ userId: 'owner', evidenceId: 'audited-identity' }) },
    users: [
      { id: 'owner', role: 'superadmin', active: true, storeId: null, storeIds: [] },
      { id: 'printbot', role: 'superadmin', active: true, storeId: null, storeIds: [] },
      { id: 'old', role: 'seller', active: true, storeId: 'a', storeIds: [] },
      { id: 'new', role: 'seller', active: true, storeId: 'b', storeIds: ['a'] },
      { id: 'foreign', role: 'seller', active: true, storeId: 'c', storeIds: [] },
      { id: 'unassigned', role: 'seller', active: true, storeId: null, storeIds: [] },
      { id: 'admin', role: 'admin', active: true, storeId: 'a', storeIds: [] },
      { id: 'customer', role: 'user', active: true, storeId: 'a', storeIds: [] },
    ],
    sales: [{ id: 'sale', sellerId: 'old', storeId: 'a', customerUserId: 'customer', clientId: 'original-client',
      status: 'completed', totalAmount: 1000, discount: 50, tcUsed: 100, tcEarned: 900,
      paymentMethod: 'pix', pagbankOrderId: 'existing-order', createdAt: saleDate, note: 'Original',
      items: [{ id: 'item', productId: 'product', quantity: 1, unitPrice: 1000 }], referralCode: null,
      sellerReferralAttribution: null, referralCommissionStage: null }],
    commissions: [{ id: 'commission', saleId: 'sale', sellerId: 'old', brand: 'Marca', saleAmount: 1000,
      pct: 1, amount: 10, status: 'pending', paidAt: null }],
    journeys: [], stages: [], audits: [],
    // These records must remain untouched by a seller attribution correction.
    stock: [{ id: 'stock', quantity: 12 }], fiscal: [{ id: 'fiscal', saleId: 'sale', status: 'authorized', totalValue: 1000 }],
    wallets: [{ id: 'wallet', userId: 'old', type: 'commission', amount: 70, reference: '2026-09', paidAt: null }],
    transactions: [{ id: 'cashback', receiverId: 'customer', amount: 900 }],
    clients: [{ id: 'original-client', sellerId: 'old', totalSpent: 1000 }],
  };
}

function addJourney(state, changes = {}) {
  const position = changes.purchasePosition || 1;
  const rules = relationship.rulesForPosition(position);
  const baseAmount = 900;
  const basePct = rules[0].targetPct;
  const journey = { id: 'journey', saleId: 'sale', sellerId: 'old', customerUserId: 'customer',
    storeId: 'a', customerName: 'Cliente original', customerPhone: '11900000000',
    cycleNumber: 1, purchasePosition: position, baseAmount, basePct, currentPct: basePct,
    earnedAmount: relationship.amountAtPct(baseAmount, basePct), reversedAmount: 0,
    status: 'ACTIVE', startedAt: new Date('2026-09-11T14:00:01Z'), createdAt: new Date('2026-09-11T14:00:02Z'),
    referralCode: null, ...changes };
  state.journeys.push(journey);
  state.stages.push(...rules.map((rule, index) => ({ id: journey.id + '-stage-' + index, journeyId: journey.id,
    key: rule.key, position: index, title: rule.title, targetPct: rule.targetPct,
    deltaPct: index ? relationship.round2(rule.targetPct - rules[index - 1].targetPct) : rule.targetPct,
    amount: index ? 0 : relationship.amountAtPct(baseAmount, basePct), status: index ? 'PENDING' : 'COMPLETED',
    completedById: index ? null : journey.sellerId, completedAt: index ? null : saleDate,
    note: index ? null : 'Venda paga registrada no TenisCash', evidence: [],
  })));
  return journey;
}

function matches(row, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected !== null && typeof expected === 'object') {
      if ('not' in expected) return row[key] !== expected.not;
      if ('in' in expected) return expected.in.includes(row[key]);
      if ('gte' in expected) return new Date(row[key]) >= expected.gte;
      throw new Error('Unsupported test query: ' + key);
    }
    return (row[key] ?? null) === expected;
  });
}

function database(initial = fixture(), behavior = {}) {
  let state = copy(initial), transactionOptions, transactionCount = 0;
  return {
    get state() { return state; }, get options() { return transactionOptions; }, get transactions() { return transactionCount; },
    async $transaction(callback, options) {
      transactionCount++;
      transactionOptions = options;
      if (behavior.serializationFailure) throw Object.assign(new Error('Retry transaction'), { code: 'P2034' });
      const next = copy(state);
      let nextId = 1;
      const readJourney = journey => journey ? copy({ ...journey,
        stages: next.stages.filter(stage => stage.journeyId === journey.id) }) : null;
      const tx = {
        config: { findUnique: async ({ where }) => { assert.equal(where.key, 'repair-owner-access-20260910'); return copy(next.config); } },
        user: { findUnique: async ({ where }) => copy(next.users.find(user => user.id === where.id) || null) },
        sale: {
          findUnique: async ({ where }) => {
            const sale = next.sales.find(item => item.id === where.id);
            return sale ? copy({ ...sale, commissions: next.commissions.filter(item => item.saleId === sale.id),
              relationshipJourney: readJourney(next.journeys.find(item => item.saleId === sale.id)) }) : null;
          },
          updateMany: async ({ where, data }) => {
            assert.deepEqual(Object.keys(data), ['sellerId']);
            if (behavior.saleConflict) return { count: 0 };
            if (behavior.paymentCompletes) {
              // Model a real payment confirmation committed after the service
              // read the pending sale. Its status must not be overwritten.
              state.sales.find(row => row.id === where.id).status = 'completed';
              next.sales.find(row => row.id === where.id).status = 'completed';
            }
            const rows = next.sales.filter(row => matches(row, where));
            for (const row of rows) Object.assign(row, copy(data));
            return { count: rows.length };
          },
        },
        saleCommission: { updateMany: async ({ where, data }) => {
          assert.deepEqual(Object.keys(data), ['sellerId']);
          if (behavior.commissionConflict) return { count: 0 };
          const rows = next.commissions.filter(row => matches(row, where));
          for (const row of rows) Object.assign(row, copy(data));
          return { count: rows.length };
        } },
        sellerCommissionJourney: {
          findUnique: async ({ where }) => readJourney(next.journeys.find(row => matches(row, where))),
          findFirst: async ({ where }) => readJourney(next.journeys.find(row => matches(row, where))),
          count: async ({ where }) => next.journeys.filter(row => matches(row, where)).length,
          delete: async ({ where }) => {
            const found = next.journeys.find(row => row.id === where.id);
            assert.ok(found);
            next.journeys = next.journeys.filter(row => row.id !== where.id);
            next.stages = next.stages.filter(row => row.journeyId !== where.id);
            return copy(found);
          },
          create: async ({ data }) => {
            const { stages, ...fields } = copy(data);
            const record = { id: 'replacement-' + nextId++, status: 'ACTIVE', reversedAmount: 0,
              startedAt: new Date('2026-09-13T12:00:00Z'), createdAt: new Date('2026-09-13T12:00:00Z'), ...fields };
            next.journeys.push(record);
            next.stages.push(...stages.create.map((stage, index) => ({ ...stage, id: record.id + '-stage-' + index,
              journeyId: record.id, evidence: [] })));
            return readJourney(record);
          },
          update: async ({ where, data }) => {
            const record = next.journeys.find(row => row.id === where.id);
            assert.ok(record);
            Object.assign(record, copy(data));
            return readJourney(record);
          },
        },
        adminAction: { create: async ({ data }) => {
          if (behavior.auditFailure) throw new Error('Audit failed');
          const record = { id: 'audit-' + nextId++, ...copy(data) };
          next.audits.push(record);
          return record;
        } },
      };
      const result = await callback(tx);
      state = next;
      return result;
    },
  };
}

const input = { ownerId: 'owner', saleId: 'sale', sellerId: 'new', expectedSellerId: 'old', reason: 'Atendimento atribuído ao vendedor errado' };
async function rejected(statusCode, change = () => {}, overrides = {}, behavior = {}) {
  const initial = fixture();
  change(initial);
  const db = database(initial, behavior);
  await assert.rejects(correctSaleSeller(db, { ...input, ...overrides }), error => error.statusCode === statusCode);
  assert.deepEqual(db.state, initial, 'Rejected corrections must leave every record unchanged');
}

(async () => {
  const initial = fixture(), db = database(initial);
  const result = await correctSaleSeller(db, input);
  assert.equal(result.changed, true);
  assert.equal(result.sale.sellerId, 'new');
  assert.equal(result.previousSellerId, 'old');
  assert.equal(result.commissionsUpdated, 1);
  assert.equal(result.relationshipRecalculated, false);
  assert.equal(db.options.isolationLevel, 'Serializable');
  assert.deepEqual(db.state.sales, initial.sales.map(sale => ({ ...sale, sellerId: 'new' })));
  assert.deepEqual(db.state.commissions, initial.commissions.map(item => ({ ...item, sellerId: 'new' })));
  for (const key of ['stock', 'fiscal', 'wallets', 'transactions', 'clients', 'users']) assert.deepEqual(db.state[key], initial[key]);
  assert.equal(db.state.audits.length, 1);
  const audit = db.state.audits[0], metadata = JSON.parse(audit.metadata);
  assert.equal(audit.adminId, 'owner');
  assert.equal(audit.targetUserId, 'new');
  assert.equal(metadata.saleId, 'sale');
  assert.equal(metadata.before.sellerId, 'old');
  assert.equal(metadata.after.sellerId, 'new');
  assert.equal(metadata.reason, input.reason);
  for (const key of ['status', 'totalAmount', 'discount', 'paymentMethod', 'pagbankOrderId', 'tcUsed', 'tcEarned']) {
    assert.equal(metadata.before[key], initial.sales[0][key]);
    assert.equal(metadata.after[key], initial.sales[0][key]);
  }
  assert.equal(result.sale.status, 'completed');

  // A pending PIX sale can be reassigned without creating an order, charging,
  // confirming payment, changing amounts or issuing a fiscal document.
  for (const pagbankOrderId of [null, 'existing-order']) {
    const pending = fixture();
    pending.sales[0].status = 'pending_payment';
    pending.sales[0].pagbankOrderId = pagbankOrderId;
    pending.fiscal = [];
    const pendingDb = database(pending);
    const pendingResult = await correctSaleSeller(pendingDb, { ...input, sellerId: 'owner' });
    assert.equal(pendingResult.sale.status, 'pending_payment');
    assert.deepEqual(pendingDb.state.sales, pending.sales.map(sale => ({ ...sale, sellerId: 'owner' })));
    assert.deepEqual(pendingDb.state.commissions, pending.commissions.map(item => ({ ...item, sellerId: 'owner' })));
    for (const key of ['stock', 'fiscal', 'wallets', 'transactions', 'clients', 'users']) assert.deepEqual(pendingDb.state[key], pending[key]);
    const pendingAudit = JSON.parse(pendingDb.state.audits[0].metadata);
    for (const key of ['status', 'totalAmount', 'discount', 'paymentMethod', 'pagbankOrderId', 'tcUsed', 'tcEarned']) {
      assert.equal(pendingAudit.before[key], pending.sales[0][key]);
      assert.equal(pendingAudit.after[key], pending.sales[0][key]);
    }
  }

  const ownerTarget = database();
  await correctSaleSeller(ownerTarget, { ...input, sellerId: 'owner' });
  assert.equal(ownerTarget.state.sales[0].sellerId, 'owner');
  const noCommissions = fixture(); noCommissions.commissions = [];
  const noCommissionsDb = database(noCommissions);
  assert.equal((await correctSaleSeller(noCommissionsDb, input)).commissionsUpdated, 0);
  assert.equal(noCommissionsDb.state.commissions.length, 0);
  const unchanged = database();
  assert.equal((await correctSaleSeller(unchanged, { ...input, sellerId: 'old' })).changed, false);
  assert.deepEqual(unchanged.state, fixture());

  for (const ownerId of ['printbot', 'admin', 'old']) await rejected(403, undefined, { ownerId });
  await rejected(403, state => { state.config = null; });
  await rejected(403, state => { state.users[0].active = false; });
  for (const sellerId of ['printbot', 'admin', 'customer', 'foreign', 'unassigned']) await rejected(403, undefined, { sellerId });
  await rejected(400, state => { state.users.find(user => user.id === 'new').active = false; });
  await rejected(400, undefined, { sellerId: 'missing' });
  await rejected(404, undefined, { saleId: 'missing' });
  await rejected(409, undefined, { expectedSellerId: 'someone-else' });
  for (const status of ['canceled', 'refunded', 'draft']) await rejected(409, state => { state.sales[0].status = status; });
  await rejected(409, state => { state.sales[0].storeId = null; }, { sellerId: 'owner' });
  await rejected(409, state => { state.sales[0].createdAt = 'invalid date'; });
  for (const status of ['paid', 'approved', 'canceled']) await rejected(409, state => { state.commissions[0].status = status; });
  await rejected(409, state => { state.commissions[0].paidAt = saleDate; });
  await rejected(409, state => { state.commissions[0].sellerId = 'foreign'; });
  await rejected(409, undefined, {}, { saleConflict: true });
  await rejected(409, undefined, {}, { commissionConflict: true });
  await rejected(409, undefined, {}, { serializationFailure: true });
  const pendingRace = fixture(); pendingRace.sales[0].status = 'pending_payment';
  const pendingRaceDb = database(pendingRace, { paymentCompletes: true });
  await assert.rejects(correctSaleSeller(pendingRaceDb, input), error => error.statusCode === 409);
  const paymentConfirmed = copy(pendingRace); paymentConfirmed.sales[0].status = 'completed';
  assert.deepEqual(pendingRaceDb.state, paymentConfirmed, 'Keep concurrent payment confirmation, with attribution/commissions/audit rolled back');
  for (const overrides of [{ reason: ' ' }, { reason: 'a'.repeat(501) }, { expectedSellerId: '' }, { saleId: [] }]) {
    await rejected(400, undefined, overrides);
  }
  const rollback = database(fixture(), { auditFailure: true });
  await assert.rejects(correctSaleSeller(rollback, input), /Audit failed/);
  assert.deepEqual(rollback.state, fixture());

  // A pristine first purchase can become the destination seller's second one.
  const cycling = fixture();
  const oldJourney = copy(addJourney(cycling));
  addJourney(cycling, { id: 'prior-target', saleId: 'prior-sale', sellerId: 'new', createdAt: new Date('2026-09-10T12:00:00Z') });
  const cyclingDb = database(cycling);
  const cycleResult = await correctSaleSeller(cyclingDb, input);
  assert.equal(cycleResult.relationshipRecalculated, true);
  const rebuilt = cyclingDb.state.journeys.find(journey => journey.saleId === 'sale');
  assert.equal(rebuilt.sellerId, 'new');
  assert.equal(rebuilt.purchasePosition, 2);
  assert.equal(rebuilt.cycleNumber, 1);
  assert.equal(rebuilt.basePct, 1.5);
  assert.equal(rebuilt.baseAmount, 900);
  assert.equal(rebuilt.earnedAmount, 13.5);
  assert.deepEqual(rebuilt.createdAt, oldJourney.createdAt);
  assert.deepEqual(rebuilt.startedAt, oldJourney.startedAt);
  const stages = cyclingDb.state.stages.filter(stage => stage.journeyId === rebuilt.id);
  assert.equal(stages[0].key, 'REPEAT_SALE');
  assert.equal(stages[0].completedById, 'new');
  assert.deepEqual(stages[0].completedAt, saleDate);
  assert.ok(stages.slice(1).every(stage => stage.status === 'PENDING' && stage.amount === 0));
  assert.equal(cyclingDb.state.journeys.some(journey => journey.id === oldJourney.id), false);
  const cycleAudit = JSON.parse(cyclingDb.state.audits[0].metadata);
  assert.equal(cycleAudit.relationshipBefore.id, oldJourney.id);
  assert.equal(cycleAudit.relationshipBefore.stages.length, oldJourney.purchasePosition === 1 ? relationship.RULES[1].length : 0);
  assert.equal(cycleAudit.relationshipAfter.id, rebuilt.id);
  assert.equal(cycleAudit.relationshipBefore.status, 'ACTIVE');
  assert.equal(cycleAudit.relationshipAfter.status, 'ACTIVE');
  // Rebuilding a pristine pending journey preserves its payment gate and dates.
  const pendingCycle = fixture();
  pendingCycle.sales[0].status = 'pending_payment';
  pendingCycle.sales[0].pagbankOrderId = null;
  const oldPendingJourney = copy(addJourney(pendingCycle, { status: 'PENDING_PAYMENT' }));
  addJourney(pendingCycle, { id: 'prior-pending-target', saleId: 'older-sale', sellerId: 'new', createdAt: new Date('2026-09-10T12:00:00Z') });
  const pendingCycleDb = database(pendingCycle);
  const pendingCycleResult = await correctSaleSeller(pendingCycleDb, input);
  const rebuiltPending = pendingCycleDb.state.journeys.find(journey => journey.saleId === 'sale');
  assert.equal(pendingCycleResult.sale.status, 'pending_payment');
  assert.equal(rebuiltPending.status, 'PENDING_PAYMENT');
  assert.equal(rebuiltPending.sellerId, 'new');
  assert.equal(rebuiltPending.purchasePosition, 2);
  assert.equal(rebuiltPending.earnedAmount, 13.5);
  assert.deepEqual(rebuiltPending.createdAt, oldPendingJourney.createdAt);
  assert.deepEqual(rebuiltPending.startedAt, oldPendingJourney.startedAt);
  assert.deepEqual(pendingCycleDb.state.sales, pendingCycle.sales.map(sale => ({ ...sale, sellerId: 'new' })));
  const pendingCycleAudit = JSON.parse(pendingCycleDb.state.audits[0].metadata);
  assert.equal(pendingCycleAudit.relationshipBefore.status, 'PENDING_PAYMENT');
  assert.equal(pendingCycleAudit.relationshipAfter.status, 'PENDING_PAYMENT');
  // The existing webhook helper still finds the replacement by the unchanged
  // sale ID; only a subsequent, separately verified payment may activate it.
  const webhookCopy = copy(pendingCycleDb.state);
  await relationship.activateJourneyAfterPayment({ sellerCommissionJourney: { updateMany: async ({ where, data }) => {
    const rows = webhookCopy.journeys.filter(row => matches(row, where));
    rows.forEach(row => Object.assign(row, data));
    return { count: rows.length };
  } } }, 'sale');
  assert.equal(webhookCopy.journeys.find(journey => journey.saleId === 'sale').status, 'ACTIVE');
  assert.equal(webhookCopy.journeys.find(journey => journey.saleId === 'sale').sellerId, 'new');
  assert.equal(pendingCycleDb.state.journeys.find(journey => journey.saleId === 'sale').status, 'PENDING_PAYMENT');
  const firstAgain = fixture(); addJourney(firstAgain, { purchasePosition: 2 });
  const firstAgainDb = database(firstAgain);
  await correctSaleSeller(firstAgainDb, input);
  assert.equal(firstAgainDb.state.journeys[0].purchasePosition, 1);
  assert.equal(firstAgainDb.state.journeys[0].earnedAmount, 9);

  for (const change of [
    state => { state.sales[0].referralCode = 'ABC'; },
    state => { state.sales[0].sellerReferralAttribution = { id: 'incoming-code' }; },
    state => { state.sales[0].referralCommissionStage = { id: 'incoming-stage' }; },
    state => { addJourney(state).referralCode = { id: 'origin-code' }; },
    state => { addJourney(state).status = 'COMPLETED'; },
    state => { addJourney(state).status = 'PENDING_PAYMENT'; },
    state => { state.sales[0].status = 'pending_payment'; addJourney(state); },
    state => { addJourney(state).reversedAmount = 1; },
    state => { addJourney(state).earnedAmount = 11; },
    state => { addJourney(state).baseAmount = 1000; },
    state => { addJourney(state).currentPct = 1.1; },
    state => { addJourney(state).completedAt = saleDate; },
    state => { addJourney(state).createdAt = 'invalid date'; },
    state => { addJourney(state).startedAt = 'invalid date'; },
    state => { addJourney(state); state.stages[0].amount = 11; },
    state => { addJourney(state); state.stages[0].completedById = 'another-person'; },
    state => { addJourney(state); state.stages[0].note = 'Nota manual diferente'; },
    state => { addJourney(state); state.stages[0].completedAt = 'invalid date'; },
    state => { addJourney(state); state.stages[1].targetPct = 1.7; },
    state => { addJourney(state).sellerId = 'foreign'; },
    state => { addJourney(state).customerUserId = 'different-customer'; },
    state => { addJourney(state); state.stages.pop(); },
    ...['SUBMITTED', 'COMPLETED', 'REJECTED'].map(status => state => { addJourney(state); state.stages[1].status = status; }),
    ...[{ evidence: [{ id: 'proof' }] }, { note: 'Atividade iniciada' }, { publicationUrl: 'https://example.com/proof' },
      { reviewedAt: saleDate }, { submittedAt: saleDate }, { completedById: 'old' }, { customerInteracted: true }]
      .map(fields => state => { addJourney(state); Object.assign(state.stages[1], fields); }),
  ]) await rejected(409, change);
  for (const change of [
    state => { state.commissions[0].status = 'paid'; },
    state => { state.commissions[0].paidAt = saleDate; },
    state => { state.sales[0].referralCode = 'PENDING-REFERRAL'; },
    state => { addJourney(state, { status: 'PENDING_PAYMENT' }).referralCode = { id: 'pending-origin' }; },
    state => { addJourney(state, { status: 'PENDING_PAYMENT' }); state.stages[1].evidence = [{ id: 'proof' }]; },
    state => { addJourney(state, { status: 'PENDING_PAYMENT' }); state.stages[1].status = 'SUBMITTED'; },
  ]) await rejected(409, state => { state.sales[0].status = 'pending_payment'; change(state); });
  for (const sellerId of ['old', 'new']) {
    for (const status of ['ACTIVE', 'COMPLETED', 'PENDING_PAYMENT']) {
      await rejected(409, state => {
        addJourney(state);
        addJourney(state, { id: 'later', saleId: 'later-sale', sellerId, status, createdAt: new Date('2026-09-12T12:00:00Z') });
      });
    }
    await rejected(409, state => {
      state.sales[0].status = 'pending_payment';
      addJourney(state, { status: 'PENDING_PAYMENT' });
      addJourney(state, { id: 'later-pending', saleId: 'later-sale', sellerId, status: 'PENDING_PAYMENT',
        createdAt: new Date('2026-09-12T12:00:00Z') });
    });
  }
  const journeyRollback = fixture(); addJourney(journeyRollback);
  const journeyRollbackDb = database(journeyRollback, { auditFailure: true });
  await assert.rejects(correctSaleSeller(journeyRollbackDb, input), /Audit failed/);
  assert.deepEqual(journeyRollbackDb.state, journeyRollback);
  journeyRollback.sales[0].status = 'pending_payment';
  journeyRollback.journeys[0].status = 'PENDING_PAYMENT';
  const pendingRollbackDb = database(journeyRollback, { auditFailure: true });
  await assert.rejects(correctSaleSeller(pendingRollbackDb, input), /Audit failed/);
  assert.deepEqual(pendingRollbackDb.state, journeyRollback);
  console.log('PASS: owner-only correction of completed/pending sales, unchanged payment/fiscal/stock, status-aware concurrency, pending cycle preservation, audit/rollback and blocked paid/manual/referral dependencies');
})().catch(error => { console.error(error); process.exitCode = 1; });
