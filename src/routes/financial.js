// =====================================================================
// Routes: /api/admin/financial — Contas a Pagar e Receber
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  calculateProductProfit,
} = require('../services/productProfit');
const {
  sanitizeQuarterAdjustment,
  quarterIdForYmd,
  quarterBounds,
  calculateQuarterlyRealProfit,
} = require('../services/realProfitTax');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

const PROFIT_SETTINGS_KEY = 'financial_profit_settings';
const TAX_QUARTER_PREFIX = 'financial_tax_quarter:';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const digits = (s) => String(s || '').replace(/\D/g, '');

function taxQuarterKey(issuerId, quarter) {
  return TAX_QUARTER_PREFIX + issuerId + ':' + quarter;
}

async function loadQuarterAdjustments(issuerIds, quarter) {
  const ids = [...new Set((issuerIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const keys = ids.map((id) => taxQuarterKey(id, quarter));
  const rows = await prisma.config.findMany({ where: { key: { in: keys } } });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return Object.fromEntries(ids.map((id) => {
    try { return [id, sanitizeQuarterAdjustment(JSON.parse(byKey[taxQuarterKey(id, quarter)] || '{}'))]; }
    catch (_) { return [id, sanitizeQuarterAdjustment({})]; }
  }));
}

function xmlBlock(xml, name) {
  const re = new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?' + name + '>', 'i');
  return String(xml || '').match(re)?.[1] || '';
}

function xmlNumber(block, name) {
  const re = new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([^<]+)<\\/(?:\\w+:)?' + name + '>', 'i');
  const n = Number(String(block || '').match(re)?.[1]);
  return Number.isFinite(n) ? n : 0;
}

function extractFiscalTaxTotals(xml) {
  const icms = xmlBlock(xml, 'ICMSTot');
  const ibsCbs = xmlBlock(xml, 'IBSCBSTot');
  if (!icms && !ibsCbs) return null;
  return {
    icms: xmlNumber(icms, 'vICMS'),
    pis: xmlNumber(icms, 'vPIS'),
    cofins: xmlNumber(icms, 'vCOFINS'),
    cbs: xmlNumber(ibsCbs, 'vCBS'),
    ibs: xmlNumber(ibsCbs, 'vIBS'),
    icmsSt: xmlNumber(icms, 'vST'),
    fcp: xmlNumber(icms, 'vFCP') + xmlNumber(icms, 'vFCPST'),
    difal: xmlNumber(icms, 'vICMSUFDest'),
    hasIbsCbs: Boolean(ibsCbs),
  };
}

function scaleAdjustment(adjustment, factor) {
  const clean = sanitizeQuarterAdjustment(adjustment);
  if (factor >= 0.999999) return clean;
  const out = { ...clean };
  for (const key of Object.keys(out)) if (typeof out[key] === 'number') out[key] = out[key] * Math.max(0, factor);
  out.closed = false;
  return out;
}

function fortalezaYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function parseProfitPeriod(query = {}) {
  const today = fortalezaYmd();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || '')) ? String(query.from) : today.slice(0, 7) + '-01';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || '')) ? String(query.to) : today;
  const start = new Date(from + 'T03:00:00.000Z');
  const last = new Date(to + 'T03:00:00.000Z');
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(last.getTime()) || last < start) throw new Error('Periodo invalido');
  if ((last - start) / 86400000 > 366) throw new Error('O periodo maximo e de 367 dias');
  return { from, to, start, end: new Date(last.getTime() + 86400000) };
}

async function loadProfitSettings() {
  const row = await prisma.config.findUnique({ where: { key: PROFIT_SETTINGS_KEY } }).catch(() => null);
  if (!row?.value) return sanitizeSettings(DEFAULT_SETTINGS);
  try { return sanitizeSettings(JSON.parse(row.value)); }
  catch (_) { return sanitizeSettings(DEFAULT_SETTINGS); }
}

// =====================================================================
// CONTAS A PAGAR
// =====================================================================

router.get('/payable', async (req, res) => {
  try {
    const { status, supplierId } = req.query;
    const where = {
      ...(status ? { status } : {}),
      ...(supplierId ? { supplierId } : {}),
    };
    const list = await prisma.accountPayable.findMany({
      where,
      orderBy: { dueDate: 'asc' },
      take: 200,
    });
    res.json({ accounts: list });
  } catch (err) {
    console.error('[financial/payable] erro:', err);
    res.status(500).json({ error: 'Erro ao listar contas a pagar' });
  }
});

router.post('/payable', async (req, res) => {
  try {
    const { supplierId, description, amount, dueDate, category, notes } = req.body || {};
    if (!description || !amount || !dueDate) {
      return res.status(400).json({ error: 'description, amount e dueDate são obrigatórios' });
    }
    const account = await prisma.accountPayable.create({
      data: {
        supplierId: supplierId || null,
        description,
        amount: parseFloat(amount),
        dueDate: new Date(dueDate),
        category: category || null,
        notes: notes || null,
        status: 'PENDING',
      },
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar conta', detail: err.message });
  }
});

router.put('/payable/:id', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    if (data.amount != null) data.amount = parseFloat(data.amount);
    const account = await prisma.accountPayable.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar conta', detail: err.message });
  }
});

router.post('/payable/:id/pay', async (req, res) => {
  try {
    const account = await prisma.accountPayable.update({
      where: { id: req.params.id },
      data: { status: 'PAID', paidDate: new Date() },
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao marcar como paga' });
  }
});

router.delete('/payable/:id', async (req, res) => {
  try {
    await prisma.accountPayable.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover' });
  }
});

// =====================================================================
// CONTAS A RECEBER
// =====================================================================

router.get('/receivable', async (req, res) => {
  try {
    const { status, customerId } = req.query;
    const where = {
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
    };
    const list = await prisma.accountReceivable.findMany({
      where,
      orderBy: { dueDate: 'asc' },
      take: 200,
    });
    res.json({ accounts: list });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar contas a receber' });
  }
});

router.post('/receivable', async (req, res) => {
  try {
    const { customerId, saleId, description, amount, dueDate, category, notes } = req.body || {};
    if (!description || !amount || !dueDate) {
      return res.status(400).json({ error: 'description, amount e dueDate são obrigatórios' });
    }
    const account = await prisma.accountReceivable.create({
      data: {
        customerId: customerId || null,
        saleId: saleId || null,
        description,
        amount: parseFloat(amount),
        dueDate: new Date(dueDate),
        category: category || null,
        notes: notes || null,
        status: 'PENDING',
      },
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar conta', detail: err.message });
  }
});

router.put('/receivable/:id', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    if (data.amount != null) data.amount = parseFloat(data.amount);
    const account = await prisma.accountReceivable.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar conta', detail: err.message });
  }
});

router.post('/receivable/:id/receive', async (req, res) => {
  try {
    const account = await prisma.accountReceivable.update({
      where: { id: req.params.id },
      data: { status: 'PAID', receivedDate: new Date() },
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao marcar como recebida' });
  }
});

router.delete('/receivable/:id', async (req, res) => {
  try {
    await prisma.accountReceivable.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover' });
  }
});

// =====================================================================
// DASHBOARD FINANCEIRO
// =====================================================================

router.get('/dashboard', async (_req, res) => {
  try {
    const today = new Date();
    const in7 = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const in30 = new Date(Date.now() + 30 * 24 * 3600 * 1000);

    const [payablePending, payableOverdue, payableDueSoon, payableNext30, receivablePending, receivableOverdue] = await Promise.all([
      prisma.accountPayable.aggregate({ where: { status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      prisma.accountPayable.findMany({ where: { status: 'PENDING', dueDate: { lt: today } } }),
      prisma.accountPayable.findMany({ where: { status: 'PENDING', dueDate: { gte: today, lte: in7 } } }),
      prisma.accountPayable.aggregate({ where: { status: 'PENDING', dueDate: { lte: in30 } }, _sum: { amount: true } }),
      prisma.accountReceivable.aggregate({ where: { status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      prisma.accountReceivable.findMany({ where: { status: 'PENDING', dueDate: { lt: today } } }),
    ]);

    res.json({
      payable: {
        totalPending: payablePending._sum.amount || 0,
        countPending: payablePending._count || 0,
        overdueCount: payableOverdue.length,
        overdueTotal: payableOverdue.reduce((s, x) => s + x.amount, 0),
        dueSoonCount: payableDueSoon.length,
        next30: payableNext30._sum.amount || 0,
      },
      receivable: {
        totalPending: receivablePending._sum.amount || 0,
        countPending: receivablePending._count || 0,
        overdueCount: receivableOverdue.length,
        overdueTotal: receivableOverdue.reduce((s, x) => s + x.amount, 0),
      },
    });
  } catch (err) {
    console.error('[financial/dashboard] erro:', err);
    res.status(500).json({ error: 'Erro ao gerar dashboard' });
  }
});

// =====================================================================
// LUCRO POR PRODUTO
// Receita liquida - CMV - comissao - taxas - impostos - TenisCash
// - despesas operacionais rateadas. Somente Sale.status=completed.
// =====================================================================

router.get('/profit-settings', async (_req, res) => {
  try {
    res.json({ settings: await loadProfitSettings() });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar configuracoes de lucro', detail: err.message });
  }
});

router.put('/profit-settings', async (req, res) => {
  try {
    const settings = sanitizeSettings(req.body || {});
    await prisma.config.upsert({
      where: { key: PROFIT_SETTINGS_KEY },
      update: { value: JSON.stringify(settings) },
      create: { id: PROFIT_SETTINGS_KEY, key: PROFIT_SETTINGS_KEY, value: JSON.stringify(settings) },
    });
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configuracoes de lucro', detail: err.message });
  }
});

// Ajustes trimestrais de LALUR/LACS e creditos confirmados pela contabilidade.
// Sao separados por CNPJ emissor para nunca consolidar empresas diferentes.
router.get('/tax-quarter', async (req, res) => {
  try {
    const issuerId = String(req.query.issuerId || '').trim();
    const quarter = String(req.query.quarter || '').trim();
    quarterBounds(quarter);
    if (!issuerId) return res.status(400).json({ error: 'issuerId obrigatorio' });
    const issuer = await prisma.fiscalIssuer.findUnique({ where: { id: issuerId }, select: { id: true, companyName: true, fantasyName: true, cnpj: true, crt: true } });
    if (!issuer) return res.status(404).json({ error: 'CNPJ emissor nao encontrado' });
    const map = await loadQuarterAdjustments([issuerId], quarter);
    res.json({ issuer, quarter, adjustment: map[issuerId] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/tax-quarter', async (req, res) => {
  try {
    const issuerId = String(req.body?.issuerId || '').trim();
    const quarter = String(req.body?.quarter || '').trim();
    quarterBounds(quarter);
    if (!issuerId) return res.status(400).json({ error: 'issuerId obrigatorio' });
    const issuer = await prisma.fiscalIssuer.findUnique({ where: { id: issuerId }, select: { id: true } });
    if (!issuer) return res.status(404).json({ error: 'CNPJ emissor nao encontrado' });
    const adjustment = sanitizeQuarterAdjustment(req.body?.adjustment || {});
    const key = taxQuarterKey(issuerId, quarter);
    await prisma.config.upsert({ where: { key }, update: { value: JSON.stringify(adjustment) }, create: { id: key, key, value: JSON.stringify(adjustment) } });
    res.json({ ok: true, issuerId, quarter, adjustment });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/product-profit', async (req, res) => {
  try {
    const period = parseProfitPeriod(req.query);
    const quarter = quarterIdForYmd(period.from);
    if (quarter !== quarterIdForYmd(period.to)) throw new Error('Lucro Real trimestral exige datas dentro do mesmo trimestre');
    const storeId = String(req.query.storeId || '').trim() || null;
    const query = String(req.query.q || '').trim().toLowerCase();
    const sort = String(req.query.sort || 'profit_asc');

    const [sales, expenses, settings, stores, issuers] = await Promise.all([
      prisma.sale.findMany({
        where: { createdAt: { gte: period.start, lt: period.end }, status: 'completed' },
        select: {
          id: true, storeId: true, totalAmount: true, discount: true, tcUsed: true, tcEarned: true,
          paymentMethod: true,
          commissions: { select: { brand: true, amount: true } },
          items: {
            select: {
              productId: true, productName: true, brand: true, quantity: true, totalPrice: true, unitCost: true,
              product: { select: { id: true, sku: true, name: true, brand: true, costPrice: true } },
            },
          },
        },
      }),
      prisma.operatingExpense.findMany({ where: { active: true, category: { not: 'imposto' } }, select: { amount: true, storeId: true } }),
      loadProfitSettings(),
      prisma.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true, fiscalIssuerId: true }, orderBy: { code: 'asc' } }),
      prisma.fiscalIssuer.findMany({ where: { active: true }, select: { id: true, companyName: true, fantasyName: true, cnpj: true, crt: true }, orderBy: { companyName: 'asc' } }),
    ]);

    const storeById = Object.fromEntries(stores.map((s) => [s.id, s]));
    const issuerById = Object.fromEntries(issuers.map((i) => [i.id, i]));
    const issuerByCnpj = Object.fromEntries(issuers.map((i) => [digits(i.cnpj), i]));
    for (const sale of sales) sale.issuerId = storeById[sale.storeId]?.fiscalIssuerId || '__unassigned__';

    // A taxa manual antiga e ignorada no Lucro Real para evitar imposto em duplicidade.
    const baseSettings = { ...settings, taxPct: 0 };
    const result = calculateProductProfit({ sales, expenses, settings: baseSettings, from: period.from, to: period.to, storeId });
    const selectedSales = storeId ? sales.filter((s) => s.storeId === storeId) : sales;
    const selectedSaleIds = selectedSales.map((s) => s.id);

    const fiscalDocs = selectedSaleIds.length ? await prisma.fiscalDocument.findMany({
      where: { saleId: { in: selectedSaleIds }, status: 'authorized', docType: { in: ['NFCE', 'NFE'] } },
      select: { saleId: true, issuerId: true, totalValue: true, xmlContent: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }) : [];
    const fiscalBySale = {};
    for (const doc of fiscalDocs) {
      if (!doc.saleId || fiscalBySale[doc.saleId]) continue;
      const totals = extractFiscalTaxTotals(doc.xmlContent);
      if (totals) fiscalBySale[doc.saleId] = { ...totals, issuerId: doc.issuerId, totalValue: Number(doc.totalValue) || 0 };
    }

    const entities = {};
    const ensureEntity = (issuerId) => (entities[issuerId] ||= {
      issuerId, revenue: 0, actualSalesRevenue: 0, profitBeforeTaxes: 0,
      debits: { icms: 0, pis: 0, cofins: 0, cbs: 0, ibs: 0 },
      credits: { icms: 0, pis: 0, cofins: 0, cbs: 0, ibs: 0 },
      purchaseDocuments: 0, embeddedInputTaxes: { icmsSt: 0, fcp: 0, difal: 0, ipi: 0 },
      missingFiscalRevenue: 0, missingCbsIbsRevenue: 0, fiscalCrtMismatchRevenue: 0,
      calculationWarnings: [],
    });
    const itemRevenue = (sale) => (sale.items || []).reduce((sum, item) => sum + (Number(item.totalPrice) || 0), 0);
    for (const sale of selectedSales) {
      const revenue = itemRevenue(sale);
      if (revenue <= 0) continue;
      const issuerId = sale.issuerId || '__unassigned__';
      const entity = ensureEntity(issuerId);
      entity.revenue += revenue;
      const actual = fiscalBySale[sale.id];
      // Sem XML autorizado ou com CRT incompatível, a apuração fica bloqueada.
      // A Constituição proíbe preencher a lacuna com alíquota presumida.
      if (actual && issuerById[issuerId]?.crt === 3) {
        entity.actualSalesRevenue += revenue;
        entity.debits.icms += actual.icms;
        entity.debits.pis += actual.pis;
        entity.debits.cofins += actual.cofins;
        if (actual.hasIbsCbs) {
          entity.debits.cbs += actual.cbs;
          entity.debits.ibs += actual.ibs;
        } else if (Number(quarter.slice(0, 4)) >= 2026 && !settings.realProfit.cbsIbs2026ComplianceConfirmed) {
          entity.missingCbsIbsRevenue += revenue;
        }
      } else {
        entity.missingFiscalRevenue += revenue;
        if (actual && issuerById[issuerId]?.crt !== 3) entity.fiscalCrtMismatchRevenue += revenue;
      }
    }

    const activeCnpjs = issuers.map((i) => digits(i.cnpj)).filter(Boolean);
    const purchaseDocs = activeCnpjs.length ? await prisma.xmlFiscalDocument.findMany({
      where: { docType: 'entrada', issueDate: { gte: period.start, lt: period.end }, recipientCnpj: { in: activeCnpjs } },
      select: {
        recipientCnpj: true, icmsValue: true, pisValue: true, cofinsValue: true, cbsValue: true, ibsValue: true,
        icmsStValue: true, fcpValue: true, fcpStValue: true, difalDestValue: true, ipiValue: true,
      },
    }) : [];
    for (const doc of purchaseDocs) {
      const issuer = issuerByCnpj[digits(doc.recipientCnpj)];
      if (!issuer || !entities[issuer.id]) continue;
      const entity = entities[issuer.id];
      entity.purchaseDocuments += 1;
      entity.credits.icms += Number(doc.icmsValue) || 0;
      entity.credits.pis += Number(doc.pisValue) || 0;
      entity.credits.cofins += Number(doc.cofinsValue) || 0;
      entity.credits.cbs += Number(doc.cbsValue) || 0;
      entity.credits.ibs += Number(doc.ibsValue) || 0;
      entity.embeddedInputTaxes.icmsSt += Number(doc.icmsStValue) || 0;
      entity.embeddedInputTaxes.fcp += (Number(doc.fcpValue) || 0) + (Number(doc.fcpStValue) || 0);
      entity.embeddedInputTaxes.difal += Number(doc.difalDestValue) || 0;
      entity.embeddedInputTaxes.ipi += Number(doc.ipiValue) || 0;
    }

    // Resultado antes dos tributos separado por CNPJ. O rateio somente pode virar
    // apuração quando o contador confirmar o fechamento integral do trimestre.
    for (const product of result.products) {
      for (const [issuerId, revenue] of Object.entries(product.issuerRevenue || {})) {
        if (!entities[issuerId] || product.revenue <= 0 || product.profit == null) continue;
        entities[issuerId].profitBeforeTaxes += product.profit * revenue / product.revenue;
      }
    }

    const adjustments = await loadQuarterAdjustments(Object.keys(entities).filter((id) => id !== '__unassigned__'), quarter);
    const allRevenueByIssuer = {};
    for (const sale of sales) {
      const issuerId = sale.issuerId || '__unassigned__';
      allRevenueByIssuer[issuerId] = (allRevenueByIssuer[issuerId] || 0) + itemRevenue(sale);
    }
    const taxEntities = {};
    const taxWarnings = ['Creditos de PIS/Cofins exibidos vem dos valores destacados nas NF-e de entrada e somente ficam definitivos apos o fechamento do contador'];
    for (const entity of Object.values(entities)) {
      const issuer = issuerById[entity.issuerId] || null;
      const scopeFactor = storeId && allRevenueByIssuer[entity.issuerId] > 0 ? entity.revenue / allRevenueByIssuer[entity.issuerId] : 1;
      const adjustment = scaleAdjustment(adjustments[entity.issuerId] || {}, scopeFactor);
      const scopedCredits = Object.fromEntries(Object.entries(entity.credits).map(([key, value]) => [key, value * scopeFactor]));
      const blockingIssues = [];
      if (!issuer) blockingIssues.push('A loja da venda nao possui CNPJ emissor vinculado');
      if (issuer && issuer.crt !== 3) blockingIssues.push(`CRT cadastrado = ${issuer.crt}; o Lucro Real exige CRT 3 na emissao fiscal`);
      if (entity.missingFiscalRevenue > 0) blockingIssues.push(`Faltam XMLs autorizados para R$ ${r2(entity.missingFiscalRevenue).toFixed(2)} em vendas`);
      if (entity.fiscalCrtMismatchRevenue > 0) blockingIssues.push(`Ha R$ ${r2(entity.fiscalCrtMismatchRevenue).toFixed(2)} em vendas com documento emitido por CRT incompatível`);
      if (entity.missingCbsIbsRevenue > 0) blockingIssues.push(`CBS/IBS nao constam nos XMLs de R$ ${r2(entity.missingCbsIbsRevenue).toFixed(2)} em vendas e a dispensa de 2026 nao foi confirmada`);
      if (result.summary.profit == null) blockingIssues.push('O resultado antes dos tributos esta incompleto por falta de custo ou detalhamento de venda');
      if (!expenses.length && !adjustment.closed) blockingIssues.push('As despesas operacionais e a folha ainda nao foram confirmadas no cadastro');
      if (storeId) blockingIssues.push('O filtro por loja nao constitui apuracao fiscal completa do CNPJ');
      const tax = calculateQuarterlyRealProfit({
        revenue: entity.revenue,
        profitBeforeTaxes: entity.profitBeforeTaxes,
        salesTaxDebits: entity.debits,
        automaticCredits: scopedCredits,
        adjustment,
        settings: settings.realProfit,
        from: period.from,
        to: period.to,
        actualSalesRevenue: entity.actualSalesRevenue,
        purchaseDocuments: entity.purchaseDocuments,
        blockingIssues,
      });
      tax.issuer = issuer ? { id: issuer.id, name: issuer.fantasyName || issuer.companyName, cnpj: issuer.cnpj, crt: issuer.crt } : { id: entity.issuerId, name: 'Sem CNPJ vinculado', cnpj: null, crt: null };
      tax.embeddedInputTaxes = Object.fromEntries(Object.entries(entity.embeddedInputTaxes).map(([k, v]) => [k, r2(v * scopeFactor)]));
      tax.scopeFactor = r2(scopeFactor);
      taxWarnings.push(...entity.calculationWarnings.map((w) => `${tax.issuer.name}: ${w}`));
      taxWarnings.push(...tax.warnings.map((w) => `${tax.issuer.name}: ${w}`));
      taxEntities[entity.issuerId] = tax;
    }

    // O rateio por produto só é exibido depois que a apuração do CNPJ estiver fechada.
    for (const product of result.products) {
      let consumption = 0, income = 0, irpj = 0, irpjAdditional = 0, csll = 0;
      let complete = product.profit != null;
      for (const [issuerId, revenue] of Object.entries(product.issuerRevenue || {})) {
        const entity = entities[issuerId], tax = taxEntities[issuerId];
        if (!entity || !tax || entity.revenue <= 0 || tax.status !== 'closed') { complete = false; continue; }
        const share = revenue / entity.revenue;
        consumption += tax.consumption.expense * share;
        income += tax.income.expense * share;
        irpj += tax.income.irpj * share;
        irpjAdditional += tax.income.irpjAdditional * share;
        csll += tax.income.csll * share;
      }
      const before = product.profit;
      product.profitBeforeTaxes = complete && before != null ? r2(before) : null;
      product.calculationStatus = complete ? 'closed' : 'not_assessed';
      if (complete) {
        product.consumptionTaxes = r2(consumption);
        product.profitBeforeIncomeTax = r2(before - consumption);
        product.irpj = r2(irpj);
        product.irpjAdditional = r2(irpjAdditional);
        product.csll = r2(csll);
        product.incomeTaxes = r2(income);
        product.taxes = r2(consumption + income);
        product.variableCosts = r2(product.variableCosts + consumption);
        product.contribution = r2(product.contribution - consumption);
        product.profit = r2(before - consumption - income);
        product.marginPct = product.revenue > 0 ? r2(product.profit / product.revenue * 100) : null;
      } else {
        product.consumptionTaxes = null;
        product.profitBeforeIncomeTax = null;
        product.irpj = null;
        product.irpjAdditional = null;
        product.csll = null;
        product.incomeTaxes = null;
        product.taxes = null;
        product.profit = null;
        product.marginPct = null;
      }
    }

    const taxComplete = Object.values(taxEntities).every((tax) => tax.status === 'closed') && Object.keys(taxEntities).length > 0;
    const taxTotals = taxComplete ? Object.values(taxEntities).reduce((a, tax) => {
      a.consumption += tax.consumption.expense;
      a.irpj += tax.income.irpj;
      a.irpjAdditional += tax.income.irpjAdditional;
      a.csll += tax.income.csll;
      a.income += tax.income.expense;
      a.total += tax.totalTaxExpense;
      return a;
    }, { consumption: 0, irpj: 0, irpjAdditional: 0, csll: 0, income: 0, total: 0 }) : { consumption: null, irpj: null, irpjAdditional: null, csll: null, income: null, total: null };
    if (taxComplete) for (const key of Object.keys(taxTotals)) taxTotals[key] = r2(taxTotals[key]);
    const beforeTax = result.summary.profit;
    result.summary.profitBeforeTaxes = taxComplete && beforeTax != null ? r2(beforeTax) : null;
    result.summary.consumptionTaxes = taxTotals.consumption;
    result.summary.irpj = taxTotals.irpj;
    result.summary.irpjAdditional = taxTotals.irpjAdditional;
    result.summary.csll = taxTotals.csll;
    result.summary.incomeTaxes = taxTotals.income;
    result.summary.taxes = taxTotals.total;
    result.summary.calculationStatus = taxComplete && beforeTax != null ? 'closed' : 'not_assessed';
    if (taxComplete && beforeTax != null) {
      result.summary.variableCosts = r2(result.summary.variableCosts + taxTotals.consumption);
      result.summary.contribution = r2(result.summary.contribution - taxTotals.consumption);
      result.summary.profit = r2(beforeTax - taxTotals.total);
      result.summary.marginPct = result.summary.revenue > 0 ? r2(result.summary.profit / result.summary.revenue * 100) : null;
    } else {
      if (!expenses.length) result.summary.fixedAllocated = null;
      result.summary.profit = null;
      result.summary.marginPct = null;
      if (!expenses.length) for (const product of result.products) product.fixedAllocated = null;
    }

    let products = result.products;
    if (query) products = products.filter((p) => `${p.name} ${p.brand} ${p.sku || ''}`.toLowerCase().includes(query));

    const sorters = {
      profit_asc: (a, b) => (a.profit == null) - (b.profit == null) || (a.profit ?? 0) - (b.profit ?? 0),
      profit_desc: (a, b) => (a.profit == null) - (b.profit == null) || (b.profit ?? 0) - (a.profit ?? 0),
      margin_asc: (a, b) => (a.marginPct ?? 999999) - (b.marginPct ?? 999999),
      margin_desc: (a, b) => (b.marginPct ?? -999999) - (a.marginPct ?? -999999),
      revenue_desc: (a, b) => b.revenue - a.revenue,
      units_desc: (a, b) => b.units - a.units,
    };
    products.sort(sorters[sort] || sorters.profit_asc);

    res.json({
      from: period.from,
      to: period.to,
      storeId,
      settings: result.settings,
      summary: result.summary,
      products,
      stores: stores.map(({ fiscalIssuerId, ...store }) => store),
      issuers,
      tax: {
        regime: 'lucro_real_trimestral', quarter,
        status: taxComplete ? 'closed' : 'not_assessed',
        scope: storeId ? 'rateio_gerencial_da_loja' : 'apuracao_por_cnpj',
        totals: taxTotals,
        entities: Object.values(taxEntities),
        warnings: [...new Set(taxWarnings)],
        blockingIssues: [...new Set(Object.values(taxEntities).flatMap((t) => (t.blockingIssues || []).map((issue) => `${t.issuer?.name || 'CNPJ'}: ${issue}`)))],
      },
      methodology: {
        revenue: 'SaleItem.totalPrice (ja liquido do desconto)',
        cogs: 'SaleItem.unitCost gravado na data da venda; sem snapshot o resultado fica NAO APURADO',
        fixedCosts: 'Despesas mensais ativas rateadas por dia e pela participacao do produto na receita',
        taxExpenseCategory: 'Despesas cadastradas na categoria imposto ficam fora do rateio para evitar duplicidade com a apuracao tributaria',
        taxes: 'Lucro Real trimestral por CNPJ somente com XMLs autorizados, creditos e fechamento contabil confirmados; sem fonte o resultado fica NAO APURADO',
        incomeTaxAllocation: 'IRPJ e CSLL sao apurados por CNPJ e rateados aos produtos apenas para analise gerencial',
        excludedStatuses: ['cancelled', 'canceled', 'pending', 'pending_payment', 'exchange_coupon'],
        exchangeCoupons: 'Cupons simbolicos de troca (status=exchange_coupon) nao sao venda economica e ficam fora do lucro',
      },
    });
  } catch (err) {
    console.error('[financial/product-profit]', err);
    const badRequest = /Periodo|periodo|Data invalida|Lucro Real trimestral/.test(err.message);
    res.status(badRequest ? 400 : 500).json({ error: err.message || 'Erro ao calcular lucro por produto' });
  }
});

// =====================================================================
// DESPESAS OPERACIONAIS (folha + fixas) + RAIO-X DO DIA (lucro/prejuízo)
// Valores são SEMPRE cadastrados pelo dono — nunca inventados.
// =====================================================================

// Lista despesas (ativas; ?all=1 inclui inativas) + lojas pra o select
router.get('/expenses', async (req, res) => {
  try {
    const where = req.query.all === '1' ? {} : { active: true };
    const [expenses, stores] = await Promise.all([
      prisma.operatingExpense.findMany({ where, orderBy: [{ category: 'asc' }, { description: 'asc' }] }),
      prisma.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
    ]);
    const sm = Object.fromEntries(stores.map((s) => [s.id, s]));
    res.json({
      expenses: expenses.map((e) => ({ ...e, storeName: e.storeId ? (sm[e.storeId] && sm[e.storeId].name) || null : null })),
      stores,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/expenses', async (req, res) => {
  try {
    const { category, description, amount, storeId, collaborator } = req.body || {};
    if (!category || !description || amount == null) return res.status(400).json({ error: 'Informe categoria, descrição e valor mensal' });
    const amt = Number(amount);
    if (!(amt >= 0)) return res.status(400).json({ error: 'Valor mensal inválido' });
    const expense = await prisma.operatingExpense.create({
      data: {
        category: String(category), description: String(description).trim(), amount: amt,
        storeId: storeId || null, collaborator: collaborator ? String(collaborator).trim() : null,
      },
    });
    res.json({ ok: true, expense });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/expenses/:id', async (req, res) => {
  try {
    const { category, description, amount, storeId, collaborator, active } = req.body || {};
    const data = {};
    if (category != null) data.category = String(category);
    if (description != null) data.description = String(description).trim();
    if (amount != null) data.amount = Number(amount);
    if (storeId !== undefined) data.storeId = storeId || null;
    if (collaborator !== undefined) data.collaborator = collaborator ? String(collaborator).trim() : null;
    if (active != null) data.active = !!active;
    const expense = await prisma.operatingExpense.update({ where: { id: req.params.id }, data });
    res.json({ ok: true, expense });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/expenses/:id', async (req, res) => {
  try {
    await prisma.operatingExpense.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// RAIO-X DO DIA: receita − CMV − folha/dia − despesas fixas/dia = lucro/prejuízo (por loja + total)
router.get('/daily-xray', async (req, res) => {
  try {
    const q = String(req.query.date || '').trim();
    const base = /^\d{4}-\d{2}-\d{2}$/.test(q) ? new Date(q + 'T12:00:00Z') : new Date();
    const fort = new Date(base.getTime() - 3 * 3600 * 1000); // João Pessoa = UTC-3
    const y = fort.getUTCFullYear(), m = fort.getUTCMonth(), d = fort.getUTCDate();
    const dayStart = new Date(Date.UTC(y, m, d, 3, 0, 0));       // 00:00 Fortaleza em UTC
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

    const stores = await prisma.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });

    const sales = await prisma.sale.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd }, status: 'completed' },
      select: { id: true, storeId: true, totalAmount: true },
    });
    const saleStore = {}; sales.forEach((s) => { saleStore[s.id] = s.storeId || '__none__'; });

    let items = [];
    if (sales.length) {
      items = await prisma.saleItem.findMany({
        where: { saleId: { in: sales.map((s) => s.id) } },
        select: { saleId: true, quantity: true, totalPrice: true, unitCost: true },
      });
    }

    const per = {};
    const bucket = (sid) => (per[sid] = per[sid] || { revenue: 0, cogs: 0, cogsKnownValue: 0, itemsValue: 0, missingCostUnits: 0 });
    sales.forEach((s) => { bucket(s.storeId || '__none__').revenue += s.totalAmount || 0; });
    items.forEach((it) => {
      const b = bucket(saleStore[it.saleId] || '__none__');
      b.itemsValue += it.totalPrice || 0;
      const cost = it.unitCost == null ? null : Number(it.unitCost);
      if (Number.isFinite(cost) && cost >= 0) { b.cogs += cost * (it.quantity || 1); b.cogsKnownValue += it.totalPrice || 0; }
      else b.missingCostUnits += it.quantity || 1;
    });

    const expenses = await prisma.operatingExpense.findMany({ where: { active: true, category: { not: 'imposto' } } });
    const expStore = {}; let cwFolha = 0, cwFixas = 0;
    const perDay = (a) => (a || 0) / daysInMonth;
    expenses.forEach((e) => {
      const dc = perDay(e.amount); const folha = ['folha', 'encargos_folha'].includes(e.category);
      if (e.storeId) { const b = (expStore[e.storeId] = expStore[e.storeId] || { folha: 0, fixas: 0 }); if (folha) b.folha += dc; else b.fixas += dc; }
      else { if (folha) cwFolha += dc; else cwFixas += dc; }
    });

    const storesOut = stores.map((s) => {
      const b = per[s.id] || { revenue: 0, cogs: 0, cogsKnownValue: 0, itemsValue: 0, missingCostUnits: 0 };
      const ex = expStore[s.id] || { folha: 0, fixas: 0 };
      const cogsCoverage = b.itemsValue > 0 ? b.cogsKnownValue / b.itemsValue : null;
      const complete = (b.revenue === 0 || cogsCoverage === 1) && expenses.length > 0 && cwFolha === 0 && cwFixas === 0;
      return {
        storeId: s.id, code: s.code, name: s.name,
        revenue: b.revenue, cogs: b.cogs,
        cogsCoverage, missingCostUnits: b.missingCostUnits,
        laborDay: ex.folha, fixedDay: ex.fixas,
        result: complete ? b.revenue - b.cogs - ex.folha - ex.fixas : null,
        calculationStatus: complete ? 'calculated_before_taxes' : 'not_assessed',
      };
    });
    const none = per['__none__'];
    if (none && none.revenue > 0) {
      storesOut.push({ storeId: null, code: '—', name: 'Sem loja definida', revenue: none.revenue, cogs: none.cogs, cogsCoverage: none.itemsValue > 0 ? none.cogsKnownValue / none.itemsValue : null, missingCostUnits: none.missingCostUnits, laborDay: 0, fixedDay: 0, result: null, calculationStatus: 'not_assessed' });
    }

    const sum = (f) => Object.values(per).reduce((a, b) => a + f(b), 0);
    const tRevenue = sum((b) => b.revenue), tCogs = sum((b) => b.cogs), tItems = sum((b) => b.itemsValue), tKnown = sum((b) => b.cogsKnownValue);
    const tLabor = Object.values(expStore).reduce((a, b) => a + b.folha, 0) + cwFolha;
    const tFixed = Object.values(expStore).reduce((a, b) => a + b.fixas, 0) + cwFixas;
    const cogsCoverage = tItems > 0 ? tKnown / tItems : null;
    const missingData = [];
    if (sales.length && cogsCoverage !== 1) missingData.push('Existem vendas sem custo historico gravado no item');
    if (!expenses.length) missingData.push('As despesas operacionais e a folha ainda nao foram confirmadas no cadastro');
    const complete = missingData.length === 0;

    res.json({
      date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      daysInMonth, salesCount: sales.length,
      company: {
        revenue: tRevenue, cogs: tCogs, cogsCoverage,
        laborDay: tLabor, fixedDay: tFixed, companyWideLaborDay: cwFolha, companyWideFixedDay: cwFixas,
        result: complete ? tRevenue - tCogs - tLabor - tFixed : null,
        calculationStatus: complete ? 'calculated_before_taxes' : 'not_assessed',
      },
      stores: storesOut,
      hasExpenses: expenses.length > 0,
      missingData,
      methodology: { status: 'Resultado operacional antes dos tributos', expenses: 'Despesas mensais confirmadas divididas pelos dias do mes' },
    });
  } catch (err) { console.error('[financial/daily-xray]', err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
