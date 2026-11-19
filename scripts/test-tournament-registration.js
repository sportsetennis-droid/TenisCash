'use strict';
// =====================================================================
// Testes da INSCRIÇÃO PAGA / LISTA DE ESPERA / CHECK-IN (Club F3).
//   TREG_TEST_DATABASE_URL=postgresql://postgres@localhost:55432/club_f3 \
//     node scripts/test-tournament-registration.js
// ⚠ Escreve no banco informado: use SÓ banco DESCARTÁVEL (nunca produção).
// PSP SIMULADO: nenhuma chamada a PagBank/banco — tournamentPix.setProvider().
// =====================================================================
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const url = process.env.TREG_TEST_DATABASE_URL || '';
if (!/^postgresql:\/\/[^@]+@(localhost|127\.0\.0\.1):\d+\//.test(url)) throw Error('Somente banco local descartável (TREG_TEST_DATABASE_URL).');
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste-treg';
process.env.TREG_SWEEPER = 'off';

const express = require('express');
const jwt = require('jsonwebtoken');
const mw = require('../src/middleware');
const db = mw.prisma;
const { ensureApexSchema } = require('../src/services/ensureApexSchema');
const pix = require('../src/services/tournamentPix');
const R = require('../src/services/tournamentRegistration');
const router = require('../src/routes/tournamentRegistration');

// ---- PSP simulado -------------------------------------------------------
const SIM = { orders: {}, n: 0, created: 0 };
const RUN = randomUUID().slice(0, 8);
pix.setProvider({
  available: () => true,
  async createCharge({ chargeId, amountCents, expiresAt }) {
    SIM.created += 1;
    const id = 'SIM-' + RUN + '-' + (++SIM.n);
    SIM.orders[id] = { chargeId, amountCents, paid: false };
    return { providerOrderId: id, qrText: '00020126SIMULADO' + id + '5204000053039865406' + (amountCents / 100).toFixed(2), qrPngUrl: null, expiresAt };
  },
  async fetchStatus({ providerOrderId }) {
    const o = SIM.orders[providerOrderId];
    if (!o) throw new Error('order desconhecida');
    return { paid: o.paid, paidCents: o.paid ? o.amountCents : null, e2e: o.paid ? 'E2E' + providerOrderId : null, status: o.paid ? 'PAID' : 'WAITING' };
  },
});
const simPay = (orderId) => { SIM.orders[orderId].paid = true; };

const app = express();
app.use(express.json());
app.use(router);

let pass = 0;
const log = [];
async function t(name, fn) {
  try { await fn(); pass += 1; log.push('  ✓ ' + name); } catch (e) { log.push('  ✗ ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')); process.exitCode = 1; throw e; }
}

(async () => {
  assert.ok((await ensureApexSchema(db)) > 0);
  await ensureApexSchema(db); // idempotente

  const u = randomUUID().slice(0, 8);
  const mk = (name, role, phone, balance = 0) => db.user.create({ data: { name, role, phone, pin: 'x', balance } });
  const owner = await mk('Org ' + u, 'user', '8390000' + u.replace(/\D/g, '0').slice(0, 4) + '1');
  const admin = await mk('Admin ' + u, 'admin', '8391' + Date.now().toString().slice(-7));
  const ath1 = await mk('Ana Atleta', 'user', '8392' + Date.now().toString().slice(-7), 0);
  const ath2 = await mk('Bia Atleta', 'user', '8393' + Date.now().toString().slice(-7), 100);
  const ath4 = await mk('Duda Atleta', 'user', '8394' + Date.now().toString().slice(-7), 50);
  const ath5 = await mk('Eva Atleta', 'user', '8395' + Date.now().toString().slice(-7), 0);
  const referee = await mk('Juiz', 'user', '8396' + Date.now().toString().slice(-7));
  const capt = await mk('Capitão', 'user', '8397' + Date.now().toString().slice(-7));
  const phoneC = '8398' + Date.now().toString().slice(-7); // atleta 3 sem conta (por enquanto)

  const tour = await db.tournament.create({ data: { slug: 'bt-' + u, name: 'Open Beach ' + u, sport: 'BEACH_TENNIS', status: 'OPEN', ownerId: owner.id, startDate: new Date(Date.now() + 7 * 86400000) } });
  const catA = await db.tournamentCategory.create({ data: { tournamentId: tour.id, name: 'Feminino A' } });
  const catB = await db.tournamentCategory.create({ data: { tournamentId: tour.id, name: 'Feminino B' } });
  const catC = await db.tournamentCategory.create({ data: { tournamentId: tour.id, name: 'Misto C' } });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const tok = (user) => jwt.sign({ userId: user.id }, mw.JWT_SECRET, { expiresIn: '10m' });
  const call = async (path, { method, body, as } = {}) => {
    const r = await fetch(base + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: 'Bearer ' + tok(as) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
  const API = '/api/tournament-registration';
  const M = API + '/manage/' + tour.id;
  const athlete = (name, birthDate, extra = {}) => ({ name, birthDate, ...extra });
  const regBody = (cat, a, extra = {}) => ({ categoryId: cat.id, athletes: [a], contactPhone: extra.contactPhone, acceptTerms: true, answers: { camisa: 'M', idade_minima: true }, ...extra });
  const balance = async (user) => (await db.user.findUnique({ where: { id: user.id } })).balance;
  const settle = () => new Promise((r) => setTimeout(r, 150));

  try {
    // ---------------- configuração ----------------
    await t('página /t/:slug/inscricao é servida', async () => {
      const r = await call('/t/' + tour.slug + '/inscricao');
      assert.equal(r.status, 200);
      assert.match(String(r.data), /<title>/);
    });
    await t('config: só organizador; inscrição fechada até ligar', async () => {
      assert.equal((await call(M + '/config', { as: ath1 })).status, 403);
      assert.equal((await call(M + '/config')).status, 401);
      const reg0 = await call(API + '/public/' + tour.slug + '/register', { body: regBody(catA, athlete('X', '1990-01-01'), { contactPhone: '83999990000' }) });
      assert.equal(reg0.status, 409);
    });
    await t('config: organizador define taxa/vagas/campos/termo; cashback só admin', async () => {
      const body = {
        enabled: true,
        categories: { [catA.id]: { feeCents: 5000, maxEntries: 2 }, [catB.id]: { feeCents: 4000, maxEntries: 1 }, [catC.id]: { feeCents: 3000, maxEntries: 1 } },
        customFields: [{ label: 'Camisa', key: 'camisa', type: 'shirt', required: true }, { label: 'Declaro ter idade mínima', key: 'idade_minima', type: 'boolean', required: true }, { label: 'Clube', type: 'text' }],
        termsText: 'Declaro estar apto à prática esportiva e aceito o regulamento.',
        allowOnsite: true,
      };
      const r = await call(M + '/config', { method: 'PUT', body, as: owner });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.config.enabled, true);
      assert.equal(r.data.config.customFields[0].options.includes('GG'), true);
      assert.equal((await call(M + '/config', { method: 'PUT', body: { cashbackPct: 10 }, as: owner })).status, 403);
      const a = await call(M + '/config', { method: 'PUT', body: { cashbackPct: 10 }, as: admin });
      assert.equal(a.status, 200);
      assert.equal(a.data.config.cashbackPct, 10);
      const p = await call(API + '/public/' + tour.slug);
      assert.equal(p.status, 200);
      assert.equal(p.data.open, true);
      assert.equal(p.data.kind, 'ATHLETE');
      assert.equal(p.data.categories.find((c) => c.id === catA.id).feeCents, 5000);
      assert.equal(p.data.payment.pix, true);
    });

    // ---------------- inscrição + PIX + webhook + cashback ----------------
    let tk1;
    await t('validações: termo obrigatório, campo obrigatório, menor exige responsável', async () => {
      let r = await call(API + '/public/' + tour.slug + '/register', { body: { ...regBody(catA, athlete('Ana Atleta', '1995-03-10'), { contactPhone: ath1.phone }), acceptTerms: false } });
      assert.equal(r.status, 400); assert.match(r.data.error, /termo/);
      r = await call(API + '/public/' + tour.slug + '/register', { body: { ...regBody(catA, athlete('Ana Atleta', '1995-03-10'), { contactPhone: ath1.phone }), answers: {} } });
      assert.equal(r.status, 400); assert.match(r.data.error, /Camisa/);
      r = await call(API + '/public/' + tour.slug + '/register', { body: regBody(catA, athlete('Kid', '2015-05-05'), { contactPhone: ath1.phone }) });
      assert.equal(r.status, 400); assert.match(r.data.error, /menor/);
    });
    await t('inscrição pública (sem login) → aguardando pagamento, termo registrado', async () => {
      const r = await call(API + '/public/' + tour.slug + '/register', { body: regBody(catA, athlete('Ana Atleta', '1995-03-10'), { contactPhone: ath1.phone }) });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.status, 'PENDING_PAYMENT');
      assert.equal(r.data.dueCents, 5000);
      tk1 = r.data.token;
      const row = await db.tournamentRegistration.findUnique({ where: { publicToken: tk1 } });
      assert.equal(row.termsVersion, 1);
      assert.ok(row.termsHash && row.termsAcceptedAt && row.termsIp);
      assert.equal(row.entryId, null, 'sem pagar não entra na chave');
    });
    let order1;
    await t('PIX: gera cobrança (QR + copia-e-cola) e reaproveita a mesma', async () => {
      const r = await call(API + '/r/' + tk1 + '/pay', { body: { method: 'PIX' } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.ok(r.data.pix && r.data.pix.qrText.startsWith('000201'));
      assert.match(r.data.pix.qrImage, /^data:image\/png;base64,/);
      const again = await call(API + '/r/' + tk1 + '/pay', { body: { method: 'PIX' } });
      assert.equal(again.data.pix.qrText, r.data.pix.qrText);
      assert.equal(SIM.created, 1);
      order1 = Object.keys(SIM.orders)[0];
    });
    await t('webhook com PIX ainda não pago não confirma (re-consulta o PSP)', async () => {
      const charge = await db.tournamentPaymentCharge.findFirst({ where: { providerOrderId: order1 } });
      await call(API + '/pagbank/webhook', { body: { id: order1, reference_id: 'treg_' + charge.id, charges: [{ status: 'PAID' }] } });
      await settle();
      const row = await db.tournamentRegistration.findUnique({ where: { publicToken: tk1 } });
      assert.equal(row.status, 'PENDING_PAYMENT', 'payload dizendo PAID não basta');
    });
    await t('webhook pago → CONFIRMADA, entra na chave, cashback 10% 1x', async () => {
      simPay(order1);
      const charge = await db.tournamentPaymentCharge.findFirst({ where: { providerOrderId: order1 } });
      const before = await balance(ath1);
      await call(API + '/pagbank/webhook', { body: { reference_id: 'treg_' + charge.id } });
      await settle();
      const row = await db.tournamentRegistration.findUnique({ where: { publicToken: tk1 } });
      assert.equal(row.status, 'CONFIRMED');
      assert.equal(row.paidCents, 5000);
      assert.ok(row.entryId);
      const entry = await db.tournamentEntry.findUnique({ where: { id: row.entryId } });
      assert.equal(entry.status, 'CONFIRMED');
      assert.equal(row.cashbackStatus, 'CREDITED');
      assert.equal(row.cashbackCents, 500);
      assert.equal(row.cashbackUserId, ath1.id, 'cashback vai pra conta do telefone de contato');
      assert.equal(Math.round((await balance(ath1)) * 100), Math.round(before * 100) + 500);
    });
    await t('webhook repetido (inclusive em paralelo) NÃO duplica pagamento nem cashback', async () => {
      const charge = await db.tournamentPaymentCharge.findFirst({ where: { providerOrderId: order1 } });
      const b0 = await balance(ath1);
      await Promise.all([1, 2, 3].map(() => call(API + '/pagbank/webhook', { body: { reference_id: 'treg_' + charge.id } })));
      await Promise.all([R.settleCharge(charge.id), R.markChargePaid(charge.id, { paidCents: 5000 }), R.creditCashback((await db.tournamentRegistration.findUnique({ where: { publicToken: tk1 } })).id)]);
      await settle();
      const row = await db.tournamentRegistration.findUnique({ where: { publicToken: tk1 } });
      assert.equal(row.paidCents, 5000);
      assert.equal(await balance(ath1), b0);
      const txs = await db.transaction.count({ where: { type: 'tournament_registration_cashback', receiverId: ath1.id } });
      assert.equal(txs, 1);
      assert.equal(await db.tournamentEntry.count({ where: { categoryId: catA.id } }), 1);
    });
    await t('status público confirmado mostra QR de check-in', async () => {
      const r = await call(API + '/r/' + tk1);
      assert.equal(r.data.status, 'CONFIRMED');
      assert.match(r.data.checkin.qrImage, /^data:image\/png/);
      assert.equal(r.data.cashbackCents, 500);
    });

    // ---------------- cupom + TenisCash ----------------
    let tk2;
    await t('cupom: % com limite de usos (reserva atômica)', async () => {
      assert.equal((await call(M + '/coupons', { body: { code: 'promo50', kind: 'PERCENT', value: 50, maxUses: 1 }, as: ath1 })).status, 403);
      const c = await call(M + '/coupons', { body: { code: 'promo50', kind: 'PERCENT', value: 50, maxUses: 1 }, as: owner });
      assert.equal(c.status, 200, JSON.stringify(c.data));
      assert.equal(c.data.code, 'PROMO50');
      const chk = await call(API + '/public/' + tour.slug + '/coupon', { body: { code: 'promo50', categoryId: catA.id } });
      assert.equal(chk.data.discountCents, 2500);
      const r = await call(API + '/public/' + tour.slug + '/register', { as: ath2, body: regBody(catA, athlete('Bia Atleta', '1992-07-01'), { contactPhone: ath2.phone, couponCode: 'PROMO50' }) });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.dueCents, 2500);
      tk2 = r.data.token;
      const again = await call(API + '/public/' + tour.slug + '/register', { body: regBody(catA, athlete('Outra', '1990-01-01'), { contactPhone: '83911112222', couponCode: 'PROMO50' }) });
      assert.equal(again.status, 409); assert.match(again.data.error, /esgotado/);
    });
    await t('TenisCash: exige login; debita o saldo e confirma (sem cashback sobre TenisCash)', async () => {
      assert.equal((await call(API + '/r/' + tk2 + '/pay', { body: { method: 'TENISCASH' } })).status, 401);
      const r = await call(API + '/r/' + tk2 + '/pay', { as: ath2, body: { method: 'TENISCASH' } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.status, 'CONFIRMED');
      assert.equal(r.data.tcCents, 2500);
      assert.equal(await balance(ath2), 75);
      const row = await db.tournamentRegistration.findUnique({ where: { publicToken: tk2 } });
      assert.equal(row.paymentMethod, 'TENISCASH');
      assert.equal(row.cashbackStatus, null, 'cashback só sobre dinheiro');
      assert.equal(await db.transaction.count({ where: { type: 'tournament_registration_fee', senderId: ath2.id } }), 1);
    });

    // ---------------- lista de espera ----------------
    let tk3;
    await t('vagas esgotadas → lista de espera', async () => {
      const r = await call(API + '/public/' + tour.slug + '/register', { body: regBody(catA, athlete('Carla Sem Conta', '1993-02-02'), { contactPhone: phoneC }) });
      assert.equal(r.status, 201);
      assert.equal(r.data.status, 'WAITLIST');
      tk3 = r.data.token;
      const st = await call(API + '/r/' + tk3);
      assert.equal(st.data.waitlistPosition, 1);
      assert.equal((await call(API + '/r/' + tk3 + '/pay', { body: { method: 'PIX' } })).status, 409, 'fila não paga');
    });
    await t('última vaga disputada em paralelo: 1 garante, outro vai pra fila', async () => {
      const rs = await Promise.all(['Gabi', 'Hel'].map((n, i) => call(API + '/public/' + tour.slug + '/register', { body: regBody(catC, athlete(n, '1991-0' + (i + 1) + '-01'), { contactPhone: '8390009000' + i }) })));
      const st = rs.map((r) => r.data.status).sort();
      assert.deepEqual(st, ['PENDING_PAYMENT', 'WAITLIST']);
    });

    // ---------------- expiração libera vaga + misto + pagamento atrasado ----------------
    let tk4; let tk5; let order4;
    await t('misto: parte TenisCash + resto no PIX', async () => {
      const r4 = await call(API + '/public/' + tour.slug + '/register', { as: ath4, body: regBody(catB, athlete('Duda Atleta', '1990-09-09'), { contactPhone: ath4.phone }) });
      assert.equal(r4.data.status, 'PENDING_PAYMENT');
      tk4 = r4.data.token;
      const r5 = await call(API + '/public/' + tour.slug + '/register', { as: ath5, body: regBody(catB, athlete('Eva Atleta', '1994-04-04'), { contactPhone: ath5.phone }) });
      assert.equal(r5.data.status, 'WAITLIST');
      tk5 = r5.data.token;
      const p = await call(API + '/r/' + tk4 + '/pay', { as: ath4, body: { method: 'MIXED', tcCents: 1000 } });
      assert.equal(p.status, 200, JSON.stringify(p.data));
      assert.equal(p.data.tcCents, 1000);
      assert.equal(p.data.pix.amountCents, 3000);
      assert.equal(await balance(ath4), 40);
      order4 = Object.keys(SIM.orders).find((k) => SIM.orders[k].amountCents === 3000);
    });
    await t('expiração: libera a vaga, devolve o TenisCash e promove o 1º da fila (com aviso e prazo)', async () => {
      await db.tournamentRegistration.update({ where: { publicToken: tk4 }, data: { paymentExpiresAt: new Date(Date.now() - 1000) } });
      const r = await R.expireStale({ tournamentId: tour.id });
      assert.equal(r.expired, 1);
      const r4 = await db.tournamentRegistration.findUnique({ where: { publicToken: tk4 } });
      assert.equal(r4.status, 'EXPIRED');
      assert.ok(r4.tcRefundTxId && r4.tcRefundTxId !== 'pending');
      assert.equal(await balance(ath4), 50, 'TenisCash devolvido');
      const r5 = await db.tournamentRegistration.findUnique({ where: { publicToken: tk5 } });
      assert.equal(r5.status, 'PENDING_PAYMENT');
      assert.ok(r5.promotedAt);
      const hrs = (new Date(r5.paymentExpiresAt) - Date.now()) / 3600000;
      assert.ok(hrs > 23 && hrs <= 24.01, 'prazo de 24h');
      const n = await db.appNotification.findFirst({ where: { userId: ath5.id }, orderBy: { createdAt: 'desc' } });
      assert.ok(n && /vaga/i.test(n.title + n.body));
      const ch = await db.tournamentPaymentCharge.findFirst({ where: { providerOrderId: order4 } });
      assert.equal(ch.status, 'EXPIRED');
    });
    await t('PIX que cai DEPOIS de expirar e sem vaga → não confirma, vai pra estorno manual', async () => {
      simPay(order4);
      const ch = await db.tournamentPaymentCharge.findFirst({ where: { providerOrderId: order4 } });
      await call(API + '/pagbank/webhook', { body: { id: order4, reference_id: 'treg_' + ch.id } });
      await settle();
      const r4 = await db.tournamentRegistration.findUnique({ where: { publicToken: tk4 } });
      assert.equal(r4.status, 'EXPIRED');
      assert.equal(r4.refundStatus, 'REQUESTED');
      assert.equal(r4.paidCents, 3000);
      const a = await db.tournamentRegistrationAudit.findFirst({ where: { registrationId: r4.id, action: 'PAID_LATE_NO_SLOT' } });
      assert.ok(a);
    });
    await t('atleta cancela inscrição não paga', async () => {
      const r = await call(API + '/r/' + tk5 + '/cancel', { body: {} });
      assert.equal(r.status, 200);
      assert.equal((await db.tournamentRegistration.findUnique({ where: { publicToken: tk5 } })).status, 'CANCELED');
    });

    // ---------------- reembolso manual + promoção + pagamento no local ----------------
    await t('reembolso: atleta pede; organizador registra estorno manual (auditado), cashback volta, vaga promove a fila', async () => {
      const rq = await call(API + '/r/' + tk1 + '/refund-request', { body: { reason: 'lesão' } });
      assert.equal(rq.status, 200);
      const row = await db.tournamentRegistration.findUnique({ where: { publicToken: tk1 } });
      assert.equal(row.refundStatus, 'REQUESTED');
      assert.equal((await call(M + '/registrations/' + row.id + '/refund', { body: {}, as: owner })).status, 400, 'exige descrição do estorno');
      const b0 = await balance(ath1);
      const rf = await call(M + '/registrations/' + row.id + '/refund', { body: { note: 'PIX devolvido manualmente pelo banco', refundCents: 5000 }, as: owner });
      assert.equal(rf.status, 200, JSON.stringify(rf.data));
      assert.equal(rf.data.cashback, 'REVERSED');
      const after = await db.tournamentRegistration.findUnique({ where: { id: row.id } });
      assert.equal(after.status, 'REFUNDED');
      assert.equal(after.refundedBy, owner.id);
      assert.equal(after.entryId, null, 'sem jogo → sai da chave');
      assert.equal(Math.round((await balance(ath1)) * 100), Math.round(b0 * 100) - 500);
      assert.ok(await db.tournamentRegistrationAudit.findFirst({ where: { registrationId: row.id, action: 'REFUNDED_MANUAL', actorUserId: owner.id } }));
      const r3 = await db.tournamentRegistration.findUnique({ where: { publicToken: tk3 } });
      assert.equal(r3.status, 'PENDING_PAYMENT', 'fila promovida');
      const again = await call(M + '/registrations/' + row.id + '/refund', { body: { note: 'de novo' }, as: owner });
      assert.equal(again.data.already, true);
    });
    await t('pagamento no local marcado pelo organizador (auditado) + cashback sem conta fica pendente', async () => {
      const r3 = await db.tournamentRegistration.findUnique({ where: { publicToken: tk3 } });
      assert.equal((await call(M + '/registrations/' + r3.id + '/mark-paid', { body: { amountCents: 100 }, as: owner })).status, 400, 'menos que o devido');
      const r = await call(M + '/registrations/' + r3.id + '/mark-paid', { body: { note: 'dinheiro na mesa' }, as: owner });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const row = await db.tournamentRegistration.findUnique({ where: { id: r3.id } });
      assert.equal(row.status, 'CONFIRMED');
      assert.equal(row.paymentMethod, 'ONSITE');
      assert.equal(row.cashbackStatus, 'NO_ACCOUNT');
      assert.ok(await db.tournamentRegistrationAudit.findFirst({ where: { registrationId: r3.id, action: 'MARK_PAID_ONSITE', actorUserId: owner.id } }));
    });
    await t('cashback pendente é creditado quando o dono do telefone entra logado', async () => {
      const carla = await mk('Carla', 'user', phoneC);
      const st = await call(API + '/r/' + tk3, { as: carla });
      assert.equal(st.data.cashbackCents, 500);
      assert.equal(await balance(carla), 5);
      await call(API + '/r/' + tk3, { as: carla });
      assert.equal(await balance(carla), 5, 'não credita 2x');
    });

    // ---------------- painel + CSV ----------------
    await t('painel: totais (arrecadado, TenisCash, estornado, pendentes)', async () => {
      const r = await call(M + '/registrations', { as: owner });
      assert.equal(r.status, 200);
      const s = r.data.summary;
      assert.equal(s.byStatus.CONFIRMED, 2);
      assert.equal(s.byStatus.REFUNDED, 1);
      assert.equal(s.collectedCents, 5000 + 5000, 'PIX + local (inclui o estornado)');
      assert.equal(s.refundedCents, 5000);
      assert.equal(s.netCents, 5000);
      assert.equal(s.tenisCashCents, 2500);
      assert.ok(r.data.registrations.length >= 7);
      assert.equal((await call(M + '/registrations', { as: referee })).status, 403);
    });
    await t('CSV: cabeçalho, campos customizados, anti-injeção, só organizador', async () => {
      await call(API + '/public/' + tour.slug + '/register', { body: regBody(catA, athlete('=HYPERLINK("x")', '1990-01-01'), { contactPhone: '83977776666' }) });
      const r = await fetch(base + M + '/registrations.csv', { headers: { Authorization: 'Bearer ' + tok(owner) } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/csv/);
      const buf = Buffer.from(await r.arrayBuffer());
      assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM pro Excel');
      const csv = buf.toString('utf8');
      const lines = csv.trim().split('\r\n');
      assert.match(lines[0], /Situação;Categoria/);
      assert.match(lines[0], /Camisa/);
      assert.ok(lines.some((l) => l.includes(ath1.phone)));
      assert.ok(lines.some((l) => l.includes("'=HYPERLINK")), 'fórmula neutralizada');
      assert.equal((await fetch(base + M + '/registrations.csv', { headers: { Authorization: 'Bearer ' + tok(ath1) } })).status, 403);
    });

    // ---------------- time (futsal), grátis, check-in, W.O. sugerido ----------------
    const fut = await db.tournament.create({ data: { slug: 'fs-' + u, name: 'Copa Futsal ' + u, sport: 'FUTSAL', status: 'OPEN', ownerId: owner.id } });
    const fcat = await db.tournamentCategory.create({ data: { tournamentId: fut.id, name: 'Livre' } });
    const FM = API + '/manage/' + fut.id;
    let teamA; let teamB; let match;
    await t('time: inscrição grátis confirma direto, cria elenco e admin do time', async () => {
      assert.equal((await call(FM + '/config', { method: 'PUT', body: { enabled: true, categories: { [fcat.id]: { feeCents: 0 } } }, as: owner })).status, 200);
      const pub = await call(API + '/public/' + fut.slug);
      assert.equal(pub.data.kind, 'TEAM');
      let r = await call(API + '/public/' + fut.slug + '/register', { body: { categoryId: fcat.id, teamName: 'Bessa FC', contactName: 'Capitão', contactPhone: capt.phone } });
      assert.equal(r.status, 400, 'responsável precisa declarar maioridade');
      r = await call(API + '/public/' + fut.slug + '/register', { as: capt, body: { categoryId: fcat.id, teamName: 'Bessa FC', contactName: 'Capitão', contactPhone: capt.phone, responsibleAdult: true, roster: [{ name: 'Goleiro Um', number: 1, isGoalkeeper: true }, { name: 'Ala Dois', number: 7 }] } });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.equal(r.data.status, 'CONFIRMED');
      teamA = await db.tournamentRegistration.findUnique({ where: { publicToken: r.data.token } });
      assert.equal(await db.rosterPlayer.count({ where: { entryId: teamA.entryId } }), 2);
      assert.ok(await db.tournamentRole.findFirst({ where: { tournamentId: fut.id, userId: capt.id, role: 'TEAM_ADMIN', entryId: teamA.entryId } }));
      const dup = await call(API + '/public/' + fut.slug + '/register', { body: { categoryId: fcat.id, teamName: 'bessa fc', contactName: 'Outro', contactPhone: '83955554444', responsibleAdult: true } });
      assert.equal(dup.status, 409);
      const r2 = await call(API + '/public/' + fut.slug + '/register', { body: { categoryId: fcat.id, teamName: 'Tambaú FC', contactName: 'Resp B', contactPhone: '83955553333', responsibleAdult: true } });
      teamB = await db.tournamentRegistration.findUnique({ where: { publicToken: r2.data.token } });
      match = await db.tournamentMatch.create({ data: { tournamentId: fut.id, categoryId: fcat.id, stage: 'GROUP', groupName: 'A', homeEntryId: teamA.entryId, awayEntryId: teamB.entryId, scheduledAt: new Date(Date.now() - 30 * 60000) } });
    });
    await t('check-in por QR: mesa/árbitro marca presença por jogo; repetido não duplica', async () => {
      assert.equal((await call(FM + '/checkin', { body: { code: 'TREG:' + teamA.checkinToken, matchId: match.id }, as: referee })).status, 403);
      await db.tournamentRole.create({ data: { tournamentId: fut.id, userId: referee.id, role: 'REFEREE' } });
      const r = await call(FM + '/checkin', { body: { code: 'TREG:' + teamA.checkinToken, matchId: match.id }, as: referee });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.already, false);
      assert.equal(r.data.registration.displayName, 'Bessa FC');
      const again = await call(FM + '/checkin', { body: { code: 'TREG:' + teamA.checkinToken, matchId: match.id }, as: referee });
      assert.equal(again.data.already, true);
      assert.equal(await db.tournamentCheckin.count({ where: { registrationId: teamA.id } }), 1);
      const other = await call(M + '/checkin', { body: { code: 'TREG:' + teamA.checkinToken }, as: owner });
      assert.equal(other.status, 409, 'QR de outro torneio');
      assert.equal((await call(FM + '/checkin', { body: { code: 'lixo' }, as: referee })).status, 400);
      const round = await call(FM + '/checkin', { body: { code: teamB.checkinToken, round: 1 }, as: referee });
      assert.equal(round.data.scopeKey, 'round:1');
    });
    await t('ausente após a tolerância → W.O. só SUGERIDO; coordenador confirma', async () => {
      const a = await call(FM + '/attendance?matchId=' + match.id, { as: referee });
      assert.equal(a.status, 200, JSON.stringify(a.data));
      assert.equal(a.data.home.present, true);
      assert.equal(a.data.away.present, false);
      assert.equal(a.data.suggestion.type, 'WO');
      assert.equal(a.data.suggestion.winnerEntryId, teamA.entryId);
      const board = await call(FM + '/board', { as: referee });
      assert.equal(board.data.suggestions.length, 1);
      const m0 = await db.tournamentMatch.findUnique({ where: { id: match.id } });
      assert.equal(m0.status, 'SCHEDULED', 'nada aplicado sozinho');
      assert.equal((await call(FM + '/walkover', { body: { matchId: match.id, absentEntryId: teamB.entryId, homeScore: 1, awayScore: 0 }, as: referee })).status, 403);
      assert.equal((await call(FM + '/walkover', { body: { matchId: match.id, absentEntryId: teamB.entryId, homeScore: 0, awayScore: 1 }, as: owner })).status, 400);
      const w = await call(FM + '/walkover', { body: { matchId: match.id, absentEntryId: teamB.entryId, homeScore: 1, awayScore: 0, note: 'não compareceu' }, as: owner });
      assert.equal(w.status, 200, JSON.stringify(w.data));
      const m1 = await db.tournamentMatch.findUnique({ where: { id: match.id } });
      assert.equal(m1.status, 'FINISHED');
      assert.equal(m1.winnerEntryId, teamA.entryId);
      assert.ok(await db.tournamentRegistrationAudit.findFirst({ where: { tournamentId: fut.id, action: 'WO_CONFIRMED' } }));
    });
    await t('presença da rodada lista presentes/ausentes', async () => {
      const r = await call(FM + '/attendance?round=1', { as: owner });
      assert.equal(r.data.present, 1);
      assert.equal(r.data.absent, 1);
    });
  } catch (_) {
    // falha já registrada
  } finally {
    server.close();
    console.log(log.join('\n'));
    console.log(`\n${pass} testes ok${process.exitCode ? ' — COM FALHA' : ''}`);
    await db.$disconnect();
    process.exit(process.exitCode || 0);
  }
})();
