'use strict';
// Servidor LOCAL para testar as telas do contracheque contra o banco descartável
// (depois de rodar scripts/test-payroll-http.cjs). Nunca usar com banco de produção.
const url = process.env.ROUND_TEST_DATABASE_URL;
if (!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/')) throw Error('Somente banco local isolado.');
process.env.DATABASE_URL = url;
process.env.PAYROLL_WHATSAPP = 'off';
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const mw = require('../src/middleware');
const db = mw.prisma;
const cal = require('../src/services/payroll/calendar');
const { createPayrollRouter } = require('../src/routes/payroll');

(async () => {
  const seller = await db.user.findFirst({ where: { name: 'Folha seller Silva' }, orderBy: { createdAt: 'desc' } });
  const owner = await db.user.findFirst({ where: { name: 'Folha owner Silva' }, orderBy: { createdAt: 'desc' } });
  const manager = await db.user.findFirst({ where: { name: 'Folha manager Silva' }, orderBy: { createdAt: 'desc' } });
  if (!seller || !owner) throw Error('Rode antes scripts/test-payroll-http.cjs');
  const comp = cal.competenceOf(Date.now());
  const today = cal.dayKeyOf(Date.now());
  const has = await db.clockIn.count({ where: { userId: seller.id, timestamp: { gte: cal.dayStartUtc(comp + '-01') } } });
  if (!has) {
    const at = (d, t) => cal.localTimeToDate(d, t);
    const days = cal.monthDays(comp).filter((d) => d < today && cal.weekdayOf(d) !== 0 && !['2026-11-02', '2026-11-15'].includes(d));
    const rows = [];
    for (const d of days) {
      if (d === '2026-11-05') { rows.push({ type: 'entry', timestamp: at(d, '09:02') }, { type: 'break_start', timestamp: at(d, '12:00') }); continue; }
      rows.push({ type: 'entry', timestamp: at(d, '09:00') }, { type: 'break_start', timestamp: at(d, '12:00') }, { type: 'break_end', timestamp: at(d, '13:00') }, { type: 'exit', timestamp: at(d, d === '2026-11-10' ? '18:40' : '17:20') });
    }
    rows.push({ type: 'entry', timestamp: at('2026-11-08', '10:00') }, { type: 'exit', timestamp: at('2026-11-08', '15:00') });
    await db.clockIn.createMany({ data: rows.map((r) => ({ ...r, userId: seller.id, storeId: seller.storeId })) });
    for (const [total, status, items] of [[8400, 'completed', [['Tênis Run', 'Asics', 'Tênis', 8400]]], [3200, 'completed', [['Camisa S&T Dry', 'Sports & Tennis', 'Roupa', 3200]]], [1500, 'canceled', [['Boné', 'Nike', 'Acessório', 1500]]], [900, 'pending_payment', [['Meia', 'Lupo', 'Meia', 900]]]]) {
      await db.sale.create({ data: { sellerId: seller.id, storeId: seller.storeId, totalAmount: total, status, createdAt: at('2026-11-09', '16:00'),
        items: { create: items.map(([n, b, c, v]) => ({ productName: n, brand: b, category: c, size: 'U', quantity: 1, unitPrice: v, totalPrice: v })) } } });
    }
    await db.payrollEntry.create({ data: { userId: seller.id, competence: comp, date: '2026-11-14', kind: 'ADIANTAMENTO', amountCents: 40000, description: 'Vale quinzena', createdById: owner.id } });
  }
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use('/api/payroll', createPayrollRouter({ prisma: db }));
  app.use(express.static(path.join(__dirname, '../public')));
  const port = Number(process.env.PORT || 5055);
  app.listen(port, '127.0.0.1', () => {
    const tok = (u) => jwt.sign({ userId: u.id, role: u.role }, mw.JWT_SECRET, { expiresIn: '7d' });
    console.log(`payroll dev em http://127.0.0.1:${port}`);
    console.log('SELLER_TOKEN=' + tok(seller));
    console.log('OWNER_TOKEN=' + tok(owner));
    if (manager) console.log('MANAGER_TOKEN=' + tok(manager));
  });
})().catch((e) => { console.error(e); process.exit(1); });
