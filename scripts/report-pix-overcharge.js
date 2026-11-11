'use strict';

// SÓ LEITURA. Lista vendas pagas por PIX-QR (PagBank) em que o cliente usou TenisCash.
// Antes da correção, o QR era gerado pelo total cheio (sem abater o TenisCash), então
// o cliente pagou a mais o valor do TenisCash usado.
//
// Uso:
//   node scripts/report-pix-overcharge.js            → pelo banco (valor do QR = total da venda)
//   node scripts/report-pix-overcharge.js --pagbank  → confere o valor PAGO de verdade na API PagBank
//   node scripts/report-pix-overcharge.js --csv      → saída em CSV (;)
//
// Não altera nada no banco nem no PagBank.

const { PrismaClient } = require('@prisma/client');
const pagbank = require('../src/services/pagbank');
const { toCents, amountDueCents } = require('../src/services/salePaymentPlan');

const prisma = new PrismaClient();
const CHECK_PAGBANK = process.argv.includes('--pagbank');
const CSV = process.argv.includes('--csv');

function brl(cents) { return (cents / 100).toFixed(2).replace('.', ','); }
function fortaleza(d) {
  return new Date(new Date(d).getTime() - 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}

(async () => {
  const sales = await prisma.sale.findMany({
    where: { pagbankOrderId: { not: null }, tcUsed: { gt: 0 }, status: { not: 'canceled' } },
    select: { id: true, createdAt: true, storeId: true, customerUserId: true, totalAmount: true, tcUsed: true, status: true, pagbankOrderId: true },
    orderBy: { createdAt: 'asc' },
  });
  const storeIds = [...new Set(sales.map((s) => s.storeId).filter(Boolean))];
  const userIds = [...new Set(sales.map((s) => s.customerUserId).filter(Boolean))];
  const stores = await prisma.store.findMany({ where: { id: { in: storeIds } } });
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true } });
  const storeById = Object.fromEntries(stores.map((s) => [s.id, s]));
  const userById = Object.fromEntries(users.map((u) => [u.id, u]));

  const rows = [];
  for (const s of sales) {
    const store = storeById[s.storeId];
    const dueC = amountDueCents({ totalAmount: s.totalAmount, tcUsed: s.tcUsed });
    let chargedC = toCents(s.totalAmount); // valor do QR antes da correção
    let source = 'banco';
    let paid = s.status === 'completed';
    if (CHECK_PAGBANK && store && pagbank.isConfigured(store)) {
      try {
        const pay = pagbank.readPixPayment(await pagbank.getOrder(store, s.pagbankOrderId));
        paid = pay.paid;
        if (pay.paidCents != null) { chargedC = pay.paidCents; source = 'pagbank'; }
      } catch (e) { source = 'banco (pagbank erro: ' + e.message.slice(0, 40) + ')'; }
    }
    const overC = chargedC - dueC;
    if (overC <= 0) continue;
    const u = userById[s.customerUserId] || {};
    rows.push({
      data: fortaleza(s.createdAt), loja: store?.code || store?.name || s.storeId || '-',
      venda: s.id, cliente: u.name || '-', telefone: u.phone || '-',
      totalC: toCents(s.totalAmount), tcC: toCents(s.tcUsed), dueC, chargedC, overC, pago: paid ? 'sim' : 'não', fonte: source,
    });
  }

  if (CSV) {
    console.log('data;loja;venda;cliente;telefone;total;tenisCash;devido;cobrado;a_mais;pago;fonte');
    for (const r of rows) console.log([r.data, r.loja, r.venda, r.cliente, r.telefone, brl(r.totalC), brl(r.tcC), brl(r.dueC), brl(r.chargedC), brl(r.overC), r.pago, r.fonte].join(';'));
  } else {
    for (const r of rows) {
      console.log(`${r.data} | ${r.loja} | ${r.cliente} (${r.telefone}) | total R$ ${brl(r.totalC)} | TenisCash R$ ${brl(r.tcC)} | devido R$ ${brl(r.dueC)} | cobrado R$ ${brl(r.chargedC)} | A MAIS R$ ${brl(r.overC)} | pago: ${r.pago} | ${r.fonte} | venda ${r.venda}`);
    }
  }
  const paidRows = rows.filter((r) => r.pago === 'sim');
  const totalOver = paidRows.reduce((s, r) => s + r.overC, 0);
  console.error(`\nVendas PIX-QR com TenisCash analisadas: ${sales.length}`);
  console.error(`Com cobrança a mais: ${rows.length} (pagas: ${paidRows.length})`);
  console.error(`Total cobrado a mais em vendas pagas: R$ ${brl(totalOver)}`);
  if (!CHECK_PAGBANK) console.error('Fonte: banco (QR = total da venda). Rode com --pagbank para conferir o valor pago na API.');
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
