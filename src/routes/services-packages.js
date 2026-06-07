// =====================================================================
// SERVIÇOS — PACOTES pré-pagos (session packages) — parity AppBarber
// ---------------------------------------------------------------------
// Cliente compra um pacote (ex: "5 cortes por R$120") e consome sessão a
// sessão. Tudo escopado pelo dono do estabelecimento (ownedVenue).
//
// REGRAS DO PROJETO honradas aqui:
//   - Schema ADITIVO: tabelas NOVAS, vínculos por String id (venueId,
//     clientUserId...) sem FK pra tabelas existentes. FK só entre as minhas.
//   - Timezone America/Fortaleza: reusa TZ_OFFSET_MIN e localToUtc de
//     src/routes/services.js (mesmo sinal, sem inventar matemática). O
//     "expiresAt" usa instante UTC; validade em dias é adicionada em ms.
//   - Money: round2 em todo resultado monetário.
//   - $transaction com múltiplas escritas => { timeout: 20000, maxWait: 10000 }.
//   - Dinheiro na boca do caixa => CashEntry (tabela EXISTENTE), category "package".
// =====================================================================

const express = require('express');
const { prisma, authMiddleware } = require('../middleware');

const router = express.Router();

// América/Fortaleza = UTC-3 fixo, sem horário de verão (regra CLAUDE.md).
// Mesmo valor/sinal usado em src/routes/services.js.
const TZ_OFFSET_MIN = -180;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Promise wrapper — captura erro e responde 500 (sem deixar handler estourar)
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[services-packages]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

// Helper de posse do estabelecimento (mesmo contrato de services.js)
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

// =====================================================================
// CATÁLOGO DE PACOTES (ServicePackage) — CRUD do dono
// =====================================================================

// Listar pacotes ativos do estabelecimento
router.get(
  '/venues/:id/packages',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const rows = await prisma.servicePackage.findMany({
      where: { venueId: v.id, active: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(rows);
  })
);

// Criar pacote
router.post(
  '/venues/:id/packages',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
    const sessions = Math.max(1, parseInt(b.sessions, 10) || 0);
    if (!sessions) return res.status(400).json({ error: 'sessions deve ser >= 1' });
    const price = round2(b.price);
    const validityDays = b.validityDays != null && b.validityDays !== '' ? Math.max(0, parseInt(b.validityDays, 10) || 0) : null;
    const pkg = await prisma.servicePackage.create({
      data: {
        venueId: v.id,
        name: String(b.name),
        sessions,
        price,
        validityDays: validityDays || null,
      },
    });
    res.status(201).json(pkg);
  })
);

// Remover (soft delete) pacote do catálogo
router.delete(
  '/venues/:id/packages/:pkgId',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const r = await prisma.servicePackage.updateMany({
      where: { id: req.params.pkgId, venueId: v.id },
      data: { active: false },
    });
    res.json({ ok: r.count > 0 });
  })
);

// =====================================================================
// VENDAS DE PACOTE (PackagePurchase) — saldo de sessões
// =====================================================================

// Listar vendas com saldo (X/Y sessões). Mais recentes primeiro.
router.get(
  '/venues/:id/package-purchases',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const rows = await prisma.packagePurchase.findMany({
      where: { venueId: v.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // anexa nome do pacote + saldo calculado pra UI
    const pkgIds = [...new Set(rows.map((r) => r.packageId).filter(Boolean))];
    const pkgs = pkgIds.length
      ? await prisma.servicePackage.findMany({ where: { id: { in: pkgIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = Object.fromEntries(pkgs.map((p) => [p.id, p.name]));
    const out = rows.map((r) => ({
      ...r,
      packageName: nameOf[r.packageId] || null,
      sessionsLeft: Math.max(0, r.sessionsTotal - r.sessionsUsed),
      expired: !!(r.expiresAt && r.expiresAt.getTime() < Date.now()),
    }));
    res.json(out);
  })
);

// Vender pacote — cria PackagePurchase + CashEntry "in" (category "package").
// pricePaid default = preço do catálogo (pode ser sobrescrito no body).
router.post(
  '/venues/:id/package-purchases',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    if (!b.packageId) return res.status(400).json({ error: 'packageId obrigatório' });

    const pkg = await prisma.servicePackage.findFirst({ where: { id: b.packageId, venueId: v.id } });
    if (!pkg) return res.status(404).json({ error: 'Pacote não encontrado' });

    const pricePaid = b.pricePaid != null && b.pricePaid !== '' ? round2(b.pricePaid) : round2(pkg.price);
    // expiresAt = agora + validityDays dias (instante UTC; validade em ms)
    const expiresAt = pkg.validityDays ? new Date(Date.now() + pkg.validityDays * 86400000) : null;

    const out = await prisma.$transaction(
      async (tx) => {
        const purchase = await tx.packagePurchase.create({
          data: {
            venueId: v.id,
            packageId: pkg.id,
            clientUserId: b.clientUserId || null,
            customerName: b.customerName || null,
            customerPhone: b.customerPhone || null,
            sessionsTotal: pkg.sessions,
            sessionsUsed: 0,
            pricePaid,
            expiresAt,
            status: 'active',
          },
        });
        // Dinheiro entrou no caixa => CashEntry (tabela existente)
        const entry = await tx.cashEntry.create({
          data: {
            venueId: v.id,
            type: 'in',
            category: 'package',
            amount: pricePaid,
            description: `Pacote: ${pkg.name}${b.customerName ? ' — ' + b.customerName : ''}`,
            method: b.paymentMethod || 'cash',
            createdById: req.userId,
          },
        });
        return { purchase, entry };
      },
      { timeout: 20000, maxWait: 10000 }
    );

    res.status(201).json({
      ...out.purchase,
      packageName: pkg.name,
      sessionsLeft: out.purchase.sessionsTotal - out.purchase.sessionsUsed,
      cashEntryId: out.entry.id,
    });
  })
);

// Consumir 1 sessão — incrementa sessionsUsed e registra PackageSessionUse.
// Bloqueia se esgotado. Marca status "used" ao consumir a última.
router.post(
  '/venues/:id/package-purchases/:pid/use',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;

    const purchase = await prisma.packagePurchase.findFirst({ where: { id: req.params.pid, venueId: v.id } });
    if (!purchase) return res.status(404).json({ error: 'Venda de pacote não encontrada' });
    if (purchase.sessionsUsed >= purchase.sessionsTotal) {
      return res.status(400).json({ error: 'Pacote sem sessões restantes' });
    }
    if (purchase.expiresAt && purchase.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Pacote expirado' });
    }

    const out = await prisma.$transaction(
      async (tx) => {
        const used = purchase.sessionsUsed + 1;
        const isLast = used >= purchase.sessionsTotal;
        const updated = await tx.packagePurchase.update({
          where: { id: purchase.id },
          data: { sessionsUsed: used, status: isLast ? 'used' : 'active' },
        });
        const useRow = await tx.packageSessionUse.create({
          data: {
            purchaseId: purchase.id,
            appointmentId: req.body?.appointmentId || null,
          },
        });
        return { updated, useRow };
      },
      { timeout: 20000, maxWait: 10000 }
    );

    res.json({
      ...out.updated,
      sessionsLeft: Math.max(0, out.updated.sessionsTotal - out.updated.sessionsUsed),
      useId: out.useRow.id,
    });
  })
);

module.exports = router;
