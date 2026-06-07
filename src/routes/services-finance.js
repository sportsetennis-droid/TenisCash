// =====================================================================
// SERVIÇOS — Financeiro avançado (barbearia/salão) — KEY=finance
// ---------------------------------------------------------------------
// Adiciona à plataforma de serviços (estilo AppBarber) o que faltava no
// financeiro do estabelecimento, para paridade total:
//   - VALES / ADIANTAMENTOS por profissional (StaffAdvance)
//   - CONTAS A PAGAR (Payable)
//   - CONTAS A RECEBER (Receivable)
//
// Toda movimentação que toca o caixa cria uma linha em CashEntry (tabela
// EXISTENTE) dentro de uma $transaction com timeout/maxWait (DB remoto):
//   - criar vale          -> CashEntry { type:"out", category:"advance",   professionalId }
//   - pagar conta         -> CashEntry { type:"out", category:"payable" }
//   - receber conta       -> CashEntry { type:"in",  category:"receivable" }
//
// SCHEMA 100% ADITIVO: modelos NOVOS, vínculos a registros existentes por
// String id puro (venueId, professionalId) — sem relation/FK pro schema
// legado. Posse sempre validada pelo dono do ServiceVenue.
// =====================================================================

const express = require('express');
const { prisma, authMiddleware } = require('../middleware');

const router = express.Router();

// América/Fortaleza = UTC-3 fixo, sem horário de verão (regra do projeto).
// Mesmo valor/sinal usado em src/routes/services.js.
const TZ_OFFSET_MIN = -180;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Promise wrapper — captura erro e responde 500 (sem deixar handler estourar)
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[services-finance]', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

// Posse do estabelecimento (idêntico ao padrão de services.js)
async function ownedVenue(req, res) {
  const v = await prisma.serviceVenue.findUnique({ where: { id: req.params.id } });
  if (!v) {
    res.status(404).json({ error: 'Estabelecimento não encontrado' });
    return null;
  }
  if (v.ownerUserId !== req.userId) {
    res.status(403).json({ error: 'Sem permissão' });
    return null;
  }
  return v;
}

// Aceita "YYYY-MM-DD" (data local) ou ISO; retorna Date ou null.
function parseDueDate(raw) {
  if (!raw) return null;
  const s = String(raw);
  // data pura YYYY-MM-DD -> meia-noite local de Fortaleza convertida pra UTC
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0) - TZ_OFFSET_MIN * 60000);
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

// =====================================================================
// VALES / ADIANTAMENTOS (StaffAdvance) — por profissional
// =====================================================================

// Lista vales do estabelecimento (+ total em aberto)
router.get(
  '/venues/:id/advances',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const rows = await prisma.staffAdvance.findMany({
      where: { venueId: v.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const openTotal = round2(
      rows.filter((r) => r.status === 'open').reduce((a, r) => a + r.amount, 0)
    );
    res.json({ openTotal, count: rows.length, advances: rows });
  })
);

// Cria vale/adiantamento -> sai do caixa (CashEntry out category "advance")
router.post(
  '/venues/:id/advances',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    if (!b.professionalId) return res.status(400).json({ error: 'professionalId obrigatório' });
    const amount = round2(b.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount inválido' });

    const out = await prisma.$transaction(
      async (tx) => {
        const advance = await tx.staffAdvance.create({
          data: {
            venueId: v.id,
            professionalId: String(b.professionalId),
            amount,
            note: b.note || null,
            status: 'open',
          },
        });
        await tx.cashEntry.create({
          data: {
            venueId: v.id,
            type: 'out',
            category: 'advance',
            amount,
            description: b.note ? `Vale: ${b.note}` : 'Vale/adiantamento',
            method: b.method || 'cash',
            professionalId: String(b.professionalId),
            createdById: req.userId,
          },
        });
        return advance;
      },
      { timeout: 20000, maxWait: 10000 }
    );
    res.status(201).json(out);
  })
);

// Quita o vale (status -> paid). Não mexe no caixa: o dinheiro já saiu na criação;
// "settle" aqui = desconto feito no acerto do profissional (controle, não caixa).
router.post(
  '/venues/:id/advances/:aid/settle',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const adv = await prisma.staffAdvance.findUnique({ where: { id: req.params.aid } });
    if (!adv || adv.venueId !== v.id) return res.status(404).json({ error: 'Vale não encontrado' });
    if (adv.status === 'paid') return res.json(adv);
    const row = await prisma.staffAdvance.update({
      where: { id: adv.id },
      data: { status: 'paid', paidAt: new Date() },
    });
    res.json(row);
  })
);

// =====================================================================
// CONTAS A PAGAR (Payable)
// =====================================================================

router.get(
  '/venues/:id/payables',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const rows = await prisma.payable.findMany({
      where: { venueId: v.id },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    const openTotal = round2(
      rows.filter((r) => r.status === 'open').reduce((a, r) => a + r.amount, 0)
    );
    res.json({ openTotal, count: rows.length, payables: rows });
  })
);

router.post(
  '/venues/:id/payables',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    if (!b.description) return res.status(400).json({ error: 'description obrigatória' });
    const amount = round2(b.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount inválido' });
    const row = await prisma.payable.create({
      data: {
        venueId: v.id,
        description: String(b.description),
        amount,
        dueDate: parseDueDate(b.dueDate),
        category: b.category || null,
        supplier: b.supplier || null,
        status: 'open',
      },
    });
    res.status(201).json(row);
  })
);

// Paga a conta -> sai do caixa (CashEntry out category "payable")
router.post(
  '/venues/:id/payables/:pid/pay',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const pay = await prisma.payable.findUnique({ where: { id: req.params.pid } });
    if (!pay || pay.venueId !== v.id) return res.status(404).json({ error: 'Conta não encontrada' });
    if (pay.status === 'paid') return res.json(pay);

    const out = await prisma.$transaction(
      async (tx) => {
        const row = await tx.payable.update({
          where: { id: pay.id },
          data: { status: 'paid', paidAt: new Date() },
        });
        await tx.cashEntry.create({
          data: {
            venueId: v.id,
            type: 'out',
            category: 'payable',
            amount: pay.amount,
            description: `Conta paga: ${pay.description}`,
            method: req.body?.method || 'cash',
            createdById: req.userId,
          },
        });
        return row;
      },
      { timeout: 20000, maxWait: 10000 }
    );
    res.json(out);
  })
);

// =====================================================================
// CONTAS A RECEBER (Receivable)
// =====================================================================

router.get(
  '/venues/:id/receivables',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const rows = await prisma.receivable.findMany({
      where: { venueId: v.id },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    const openTotal = round2(
      rows.filter((r) => r.status === 'open').reduce((a, r) => a + r.amount, 0)
    );
    res.json({ openTotal, count: rows.length, receivables: rows });
  })
);

router.post(
  '/venues/:id/receivables',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    if (!b.description) return res.status(400).json({ error: 'description obrigatória' });
    const amount = round2(b.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount inválido' });
    const row = await prisma.receivable.create({
      data: {
        venueId: v.id,
        description: String(b.description),
        amount,
        dueDate: parseDueDate(b.dueDate),
        clientName: b.clientName || null,
        status: 'open',
      },
    });
    res.status(201).json(row);
  })
);

// Recebe a conta -> entra no caixa (CashEntry in category "receivable")
router.post(
  '/venues/:id/receivables/:rid/receive',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const rec = await prisma.receivable.findUnique({ where: { id: req.params.rid } });
    if (!rec || rec.venueId !== v.id) return res.status(404).json({ error: 'Conta não encontrada' });
    if (rec.status === 'paid') return res.json(rec);

    const out = await prisma.$transaction(
      async (tx) => {
        const row = await tx.receivable.update({
          where: { id: rec.id },
          data: { status: 'paid', paidAt: new Date() },
        });
        await tx.cashEntry.create({
          data: {
            venueId: v.id,
            type: 'in',
            category: 'receivable',
            amount: rec.amount,
            description: `Recebido: ${rec.description}`,
            method: req.body?.method || 'cash',
            createdById: req.userId,
          },
        });
        return row;
      },
      { timeout: 20000, maxWait: 10000 }
    );
    res.json(out);
  })
);

module.exports = router;
