'use strict';

// =====================================================================
// /api/payroll — Contracheque digital.
//   /me/*     funcionário: SÓ os próprios dados (prévia, histórico, PDF, ciência, correção)
//   /admin/*  conferência: admin/gerente veem (gerente só a própria loja);
//             fechar, reabrir, cancelar, pagar e mudar regra/parâmetro: SÓ o dono.
// Toda escrita grava PayrollAuditLog; visualização e exportação também.
// =====================================================================

const express = require('express');
const { authMiddleware, prisma: defaultPrisma } = require('../middleware');
const { isFinOwner } = require('../services/finOwner');
const { createPayrollSchemaReadiness } = require('../services/payroll/schema');
const svc = require('../services/payroll/service');
const notify = require('../services/payroll/notify');
const cal = require('../services/payroll/calendar');
const pcrypto = require('../services/payroll/crypto');
const { CONTRACTS, ENTRY_LABEL } = require('../services/payroll/engine');

const ENTRY_KINDS = Object.keys(ENTRY_LABEL);
const MARK_KINDS = ['FOLGA', 'FOLGA_COMPENSATORIA', 'ATESTADO', 'ABONO', 'FALTA_CONFIRMADA', 'ATRASO_CONFIRMADO', 'FERIAS', 'AFASTAMENTO'];
const PUNCH_TYPES = ['entry', 'break_start', 'break_end', 'exit'];
const ADMIN_ROLES = ['admin', 'superadmin', 'manager'];

function selfServiceEnabled() { return ['1', 'on', 'true'].includes(String(process.env.MEU_PAGAMENTO || '').toLowerCase()); }

function createPayrollRouter({ prisma = defaultPrisma, isOwner = (req) => isFinOwner(prisma, req), sender, now = () => Date.now() } = {}) {
  const router = express.Router();
  const ensure = createPayrollSchemaReadiness(prisma);
  router.ensureSchema = ensure;

  // Link assinado do PDF (vai no WhatsApp): sem login, mas só com assinatura válida e no prazo.
  router.get('/file/:token', ensure.middleware, async (req, res) => {
    try {
      const id = pcrypto.verifyLink(req.params.token, now());
      if (!id) return res.status(404).send('Link inválido ou vencido. Abra o contracheque no app TenisCash.');
      const p = await prisma.payslip.findUnique({ where: { id }, select: { id: true, userId: true, status: true } });
      const file = p && await prisma.payslipFile.findUnique({ where: { payslipId: id } });
      if (!file) return res.status(404).send('Documento não encontrado');
      await svc.audit(prisma, { entity: 'Payslip', entityId: id, action: 'DOWNLOAD_SIGNED_LINK', subjectUserId: p.userId, req });
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${file.fileName}"`, 'Cache-Control': 'private, no-store' });
      return res.send(Buffer.from(file.content));
    } catch (err) { return fail(res, err, 'file'); }
  });

  // "Meu pagamento" do vendedor: DESATIVADO por ordem do dono (19/11/2026).
  // Religar só com ordem dele: MEU_PAGAMENTO=1 no Railway (sem deploy).
  router.get('/self-service', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ enabled: selfServiceEnabled() }); });

  router.use(authMiddleware, ensure.middleware);
  router.use('/me', (_req, res, next) => (selfServiceEnabled() ? next()
    : res.status(403).json({ error: 'Meu pagamento está desativado.', disabled: true })));

  const ownerOnly = async (req, res, next) => {
    try { if (await isOwner(req)) return next(); return res.status(403).json({ error: 'Somente o dono pode fazer esta operação' }); }
    catch (_) { return res.status(503).json({ error: 'Não foi possível validar o dono' }); }
  };
  const adminOnly = (req, res, next) => (ADMIN_ROLES.includes(req.userRole) ? next() : res.status(403).json({ error: 'Acesso restrito à administração' }));

  // Gerente só vê funcionário da(s) própria(s) loja(s).
  async function canSee(req, userId) {
    if (req.userRole === 'admin' || req.userRole === 'superadmin') return true;
    if (req.userRole !== 'manager') return false;
    const mine = new Set([req.authUser?.storeId, ...(req.authUser?.storeIds || [])].filter(Boolean));
    const [u, prof] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { storeId: true, storeIds: true } }),
      prisma.payrollEmployeeProfile.findUnique({ where: { userId }, select: { storeId: true } }),
    ]);
    return [prof?.storeId, u?.storeId, ...(u?.storeIds || [])].filter(Boolean).some((s) => mine.has(s));
  }
  const guardEmployee = (field) => async (req, res, next) => {
    const userId = field === 'payslip'
      ? (await prisma.payslip.findUnique({ where: { id: req.params.id }, select: { userId: true } }))?.userId
      : (req.params.userId || req.body?.userId || req.query.userId);
    if (!userId) return res.status(404).json({ error: 'Não encontrado' });
    if (!(await canSee(req, userId))) return res.status(403).json({ error: 'Funcionário fora da sua loja' });
    req.subjectUserId = userId;
    return next();
  };

  const competenceOr = (v) => (cal.isCompetence(v) ? v : cal.competenceOf(now()));

  // ───────────────────────────── FUNCIONÁRIO ─────────────────────────────
  router.get('/me/preview', async (req, res) => {
    try {
      const competence = competenceOr(req.query.competence);
      const { user, result } = await svc.preview(prisma, req.userId, competence, { nowMs: now() });
      await svc.audit(prisma, { entity: 'PayrollPreview', entityId: `${req.userId}:${competence}`, action: 'VIEW', subjectUserId: req.userId, req });
      const storeIds = [...new Set((result.time?.days || []).flatMap((d) => d.stores || []))];
      const stores = storeIds.length ? await prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, code: true, name: true } }) : [];
      return res.json({ employee: { name: user.name }, result, stores: Object.fromEntries(stores.map((s) => [s.id, s.name])),
        notice: result.provisional
          ? 'Prévia do mês atual. Este valor ainda não é o contracheque oficial e pode mudar até o fechamento da folha.'
          : 'Cálculo do mês encerrado, ainda não fechado pela folha. O contracheque oficial aparece em Histórico depois do fechamento.' });
    } catch (err) { return fail(res, err, 'me/preview'); }
  });

  router.get('/me/payslips', async (req, res) => {
    try {
      const rows = await prisma.payslip.findMany({ where: { userId: req.userId, status: { in: ['FECHADO', 'PAGO', 'REABERTO', 'CORRIGIDO'] } },
        orderBy: [{ competence: 'desc' }, { version: 'desc' }],
        select: { id: true, competence: true, kind: true, version: true, status: true, netCents: true, grossCents: true, deductionsCents: true, closedAt: true, paidAt: true, issuerId: true, verifyCode: true } });
      const acks = await prisma.payslipAcknowledgment.findMany({ where: { userId: req.userId, payslipId: { in: rows.map((r) => r.id) } }, select: { payslipId: true, createdAt: true } });
      const ackMap = new Map(acks.map((a) => [a.payslipId, a.createdAt]));
      return res.json({ payslips: rows.map((r) => ({ ...r, acknowledgedAt: ackMap.get(r.id) || null })) });
    } catch (err) { return fail(res, err, 'me/payslips'); }
  });

  async function ownPayslip(req, res) {
    const p = await prisma.payslip.findUnique({ where: { id: req.params.id } });
    if (!p || p.userId !== req.userId || !['FECHADO', 'PAGO', 'REABERTO', 'CORRIGIDO'].includes(p.status)) { res.status(404).json({ error: 'Contracheque não encontrado' }); return null; }
    return p;
  }

  router.get('/me/payslips/:id', async (req, res) => {
    try {
      const p = await ownPayslip(req, res); if (!p) return;
      await svc.audit(prisma, { entity: 'Payslip', entityId: p.id, action: 'VIEW', subjectUserId: p.userId, req });
      return res.json({ payslip: publicPayslip(p) });
    } catch (err) { return fail(res, err, 'me/payslip'); }
  });

  router.get('/me/payslips/:id/pdf', async (req, res) => {
    try {
      const p = await ownPayslip(req, res); if (!p) return;
      return sendPdf(req, res, p);
    } catch (err) { return fail(res, err, 'me/pdf'); }
  });

  router.get('/me/payslips/:id/export', async (req, res) => {
    try {
      const p = await ownPayslip(req, res); if (!p) return;
      return sendExport(req, res, p);
    } catch (err) { return fail(res, err, 'me/export'); }
  });

  // Ciência: registra que o funcionário viu o documento. NÃO prova pagamento.
  router.post('/me/payslips/:id/ack', async (req, res) => {
    try {
      const p = await ownPayslip(req, res); if (!p) return;
      const ack = await prisma.$transaction(async (tx) => {
        const row = await tx.payslipAcknowledgment.upsert({ where: { payslipId_userId: { payslipId: p.id, userId: req.userId } }, update: {},
          create: { payslipId: p.id, userId: req.userId, ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].slice(0, 64), userAgent: String(req.headers['user-agent'] || '').slice(0, 300) } });
        await svc.audit(tx, { entity: 'Payslip', entityId: p.id, action: 'ACKNOWLEDGE', subjectUserId: p.userId, req });
        return row;
      });
      return res.json({ ok: true, acknowledgedAt: ack.createdAt, note: 'Ciência registrada. Isto não substitui o comprovante de pagamento.' });
    } catch (err) { return fail(res, err, 'me/ack'); }
  });

  router.get('/me/disputes', async (req, res) => {
    try { return res.json({ disputes: await prisma.payrollDispute.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' } }) }); }
    catch (err) { return fail(res, err, 'me/disputes'); }
  });
  router.post('/me/disputes', async (req, res) => {
    try {
      const message = String(req.body?.message || '').trim();
      const competence = req.body?.competence;
      if (!cal.isCompetence(competence) || message.length < 5) return res.status(400).json({ error: 'Informe a competência e descreva o que está errado.' });
      if (req.body.payslipId) {
        const p = await prisma.payslip.findUnique({ where: { id: req.body.payslipId }, select: { userId: true } });
        if (!p || p.userId !== req.userId) return res.status(404).json({ error: 'Contracheque não encontrado' });
      }
      const row = await prisma.$transaction(async (tx) => {
        const d = await tx.payrollDispute.create({ data: { userId: req.userId, competence, payslipId: req.body.payslipId || null, message: message.slice(0, 2000) } });
        await svc.audit(tx, { entity: 'PayrollDispute', entityId: d.id, action: 'CREATE', subjectUserId: req.userId, after: { competence }, req });
        return d;
      });
      return res.status(201).json({ dispute: row });
    } catch (err) { return fail(res, err, 'me/dispute'); }
  });

  router.get('/me/clock-corrections', async (req, res) => {
    try {
      return res.json({ corrections: await prisma.payrollClockCorrection.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, date: true, type: true, claimedTime: true, justification: true, status: true, reviewNote: true, reviewedAt: true, createdAt: true, attachmentMime: true } }) });
    } catch (err) { return fail(res, err, 'me/corrections'); }
  });
  router.post('/me/clock-corrections', async (req, res) => {
    try {
      const { date, type, claimedTime, justification, attachment } = req.body || {};
      if (!cal.isDayKey(date) || date > cal.dayKeyOf(now())) return res.status(400).json({ error: 'Data inválida' });
      if (!PUNCH_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de marcação inválido' });
      try { cal.localTimeToDate(date, claimedTime); } catch (_) { return res.status(400).json({ error: 'Horário inválido (HH:MM)' }); }
      if (String(justification || '').trim().length < 5) return res.status(400).json({ error: 'Escreva a justificativa' });
      let file = null, mime = null;
      if (attachment) {
        const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(attachment));
        if (!m || !/^(image\/(png|jpe?g|webp)|application\/pdf)$/.test(m[1])) return res.status(400).json({ error: 'Anexo deve ser imagem ou PDF' });
        file = Buffer.from(m[2], 'base64'); mime = m[1];
        if (file.length > 1024 * 1024) return res.status(400).json({ error: 'Anexo acima de 1 MB' });
      }
      const me = await prisma.user.findUnique({ where: { id: req.userId }, select: { storeId: true } });
      const row = await prisma.$transaction(async (tx) => {
        const c = await tx.payrollClockCorrection.create({ data: { userId: req.userId, storeId: me?.storeId || null, date, type, claimedTime,
          justification: String(justification).slice(0, 1000), attachment: file, attachmentMime: mime } });
        await svc.audit(tx, { entity: 'PayrollClockCorrection', entityId: c.id, action: 'REQUEST', subjectUserId: req.userId, after: { date, type, claimedTime }, req });
        return c;
      });
      return res.status(201).json({ correction: { id: row.id, status: row.status } });
    } catch (err) { return fail(res, err, 'me/correction'); }
  });

  // ───────────────────────────── ADMINISTRAÇÃO ─────────────────────────────
  router.get('/admin/me', adminOnly, async (req, res) => res.json({ userId: req.userId, role: req.userRole, isOwner: await isOwner(req) }));

  // Painel do mês: cada funcionário com prévia calculada ou contracheque gravado.
  router.get('/admin/overview', adminOnly, async (req, res) => {
    try {
      const competence = competenceOr(req.query.competence);
      // O dono aparece na lista para poder testar a folha com a própria conta.
      const selfIds = (await isOwner(req)) ? [req.userId] : [];
      const users = await prisma.user.findMany({ where: { active: true, OR: [{ role: { in: ['seller', 'manager'] } }, { id: { in: [...selfIds, ...(await prisma.payrollEmployeeProfile.findMany({ select: { userId: true } })).map((p) => p.userId)] } }] },
        select: { id: true, name: true, role: true, storeId: true, storeIds: true }, orderBy: { name: 'asc' } });
      const visible = [];
      for (const u of users) if (await canSee(req, u.id)) visible.push(u);
      const [profiles, payslips, stores] = await Promise.all([
        prisma.payrollEmployeeProfile.findMany({ where: { userId: { in: visible.map((u) => u.id) } } }),
        prisma.payslip.findMany({ where: { competence, kind: 'MENSAL', userId: { in: visible.map((u) => u.id) } }, orderBy: { version: 'desc' } }),
        prisma.store.findMany({ select: { id: true, code: true, name: true, fiscalIssuerId: true } }),
      ]);
      const issuers = await prisma.fiscalIssuer.findMany({ select: { id: true, companyName: true, fantasyName: true, cnpj: true } });
      const issuerMap = new Map(issuers.map((i) => [i.id, i]));
      const profMap = new Map(profiles.map((p) => [p.userId, p]));
      const storeMap = new Map(stores.map((s) => [s.id, s]));
      const rows = [];
      for (const u of visible) {
        const prof = profMap.get(u.id);
        const storeId = prof?.storeId || u.storeId;
        const store = storeMap.get(storeId);
        const issuerId = prof?.issuerId || store?.fiscalIssuerId || null;
        if (req.query.storeId && storeId !== req.query.storeId) continue;
        if (req.query.issuerId && issuerId !== req.query.issuerId) continue;
        if (req.query.contractType && prof?.contractType !== req.query.contractType) continue;
        if (req.query.userId && u.id !== req.query.userId) continue;
        const slip = payslips.find((p) => p.userId === u.id);
        let summary;
        if (slip && slip.result && slip.status !== 'CANCELADO') {
          summary = summarize(slip.result); summary.status = slip.status; summary.payslipId = slip.id; summary.version = slip.version;
        } else {
          const { result } = await svc.preview(prisma, u.id, competence, { nowMs: now() });
          summary = summarize(result); summary.status = result.provisional ? 'EM_ANDAMENTO' : (result.blocking ? 'COM_PENDENCIAS' : 'EM_ANDAMENTO');
          summary.payslipId = null;
          // Versão reaberta ainda sem revisão: mostra que ela existe (prévia ao vivo até revisar).
          if (slip && slip.status !== 'CANCELADO') { summary.status = slip.status; summary.payslipId = slip.id; summary.version = slip.version; summary.needsReview = true; }
        }
        if (req.query.status && summary.status !== req.query.status) continue;
        if (req.query.pendency === '1' && !summary.pendencies.length) continue;
        const iss = issuerId ? issuerMap.get(issuerId) : null;
        rows.push({ userId: u.id, name: u.name, role: u.role, store: store ? { id: store.id, code: store.code, name: store.name } : null, issuerId,
          issuerName: iss ? (iss.fantasyName || iss.companyName) : null, issuerCnpj: iss?.cnpj || null,
          contractType: prof?.contractType || null, hasProfile: !!prof, ...summary });
      }
      return res.json({ competence, rows });
    } catch (err) { return fail(res, err, 'admin/overview'); }
  });

  router.get('/admin/employees/:userId/preview', adminOnly, guardEmployee('user'), async (req, res) => {
    try {
      const competence = competenceOr(req.query.competence);
      const { user, result, profile } = await svc.preview(prisma, req.params.userId, competence, { nowMs: now() });
      await svc.audit(prisma, { entity: 'PayrollPreview', entityId: `${user.id}:${competence}`, action: 'VIEW_ADMIN', subjectUserId: user.id, req });
      return res.json({ employee: { id: user.id, name: user.name }, profile: safeProfile(profile), result });
    } catch (err) { return fail(res, err, 'admin/preview'); }
  });

  // Cadastro de contrato (só o dono altera; gerente lê).
  router.get('/admin/profiles/:userId', adminOnly, guardEmployee('user'), async (req, res) => {
    try {
      const p = await prisma.payrollEmployeeProfile.findUnique({ where: { userId: req.params.userId } });
      const u = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true, name: true, hireDate: true, baseSalary: true, employeeCode: true, storeId: true } });
      return res.json({ user: u, profile: p ? safeProfile(p) : null });
    } catch (err) { return fail(res, err, 'admin/profile'); }
  });
  router.put('/admin/profiles/:userId', adminOnly, ownerOnly, async (req, res) => {
    try {
      const data = profileInput(req.body || {});
      const before = await prisma.payrollEmployeeProfile.findUnique({ where: { userId: req.params.userId } });
      const saved = await prisma.$transaction(async (tx) => {
        const row = before
          ? await tx.payrollEmployeeProfile.update({ where: { userId: req.params.userId }, data })
          : await tx.payrollEmployeeProfile.create({ data: { ...data, userId: req.params.userId, createdById: req.userId } });
        await svc.audit(tx, { entity: 'PayrollEmployeeProfile', entityId: row.id, action: before ? 'UPDATE' : 'CREATE', subjectUserId: req.params.userId,
          before: before ? safeProfile(before) : null, after: safeProfile(row), reason: req.body?.reason, req });
        return row;
      });
      return res.json({ profile: safeProfile(saved) });
    } catch (err) { return fail(res, err, 'admin/profile-save'); }
  });

  // Parâmetros legais: nunca edita no lugar — nova vigência ou revogação, com fonte.
  router.get('/admin/params', adminOnly, async (_req, res) => {
    try { return res.json({ params: await prisma.payrollParam.findMany({ orderBy: [{ key: 'asc' }, { validFrom: 'desc' }] }) }); }
    catch (err) { return fail(res, err, 'admin/params'); }
  });
  router.post('/admin/params', adminOnly, ownerOnly, async (req, res) => {
    try {
      const { key, value, validFrom, validTo, issuerId, storeId, locality, unionName, category, source, documentRef, notes, status } = req.body || {};
      if (!key || !value || !cal.isDayKey(validFrom) || (validTo && !cal.isDayKey(validTo))) return res.status(400).json({ error: 'Informe chave, valor e vigência (AAAA-MM-DD).' });
      if (!source) return res.status(400).json({ error: 'Informe a origem da regra (lei, portaria, convenção, decisão do dono).' });
      const row = await prisma.$transaction(async (tx) => {
        const r = await tx.payrollParam.create({ data: { key: String(key), value, validFrom, validTo: validTo || null, issuerId: issuerId || null, storeId: storeId || null,
          locality: locality || null, unionName: unionName || null, category: category || null, source: String(source), documentRef: documentRef || null, notes: notes || null,
          status: status === 'PENDING_VALIDATION' ? 'PENDING_VALIDATION' : 'ACTIVE', createdById: req.userId } });
        await svc.audit(tx, { entity: 'PayrollParam', entityId: r.id, action: 'CREATE', after: r, req });
        return r;
      });
      return res.status(201).json({ param: row });
    } catch (err) { return fail(res, err, 'admin/param-create'); }
  });
  router.post('/admin/params/:id/revoke', adminOnly, ownerOnly, async (req, res) => {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const before = await tx.payrollParam.findUnique({ where: { id: req.params.id } });
        if (!before) throw svc.httpError(404, 'Parâmetro não encontrado');
        const r = await tx.payrollParam.update({ where: { id: before.id }, data: { status: 'REVOKED' } });
        await svc.audit(tx, { entity: 'PayrollParam', entityId: r.id, action: 'REVOKE', before, after: r, reason: req.body?.reason, req });
        return r;
      });
      return res.json({ param: row });
    } catch (err) { return fail(res, err, 'admin/param-revoke'); }
  });

  router.get('/admin/holidays', adminOnly, async (req, res) => {
    try { return res.json({ holidays: await prisma.payrollHoliday.findMany({ where: req.query.year ? { date: { startsWith: String(req.query.year) } } : {}, orderBy: { date: 'asc' } }) }); }
    catch (err) { return fail(res, err, 'admin/holidays'); }
  });
  router.post('/admin/holidays', adminOnly, ownerOnly, async (req, res) => {
    try {
      const { date, name, scope = 'MUNICIPAL', locality = null, storeId = null, source } = req.body || {};
      if (!cal.isDayKey(date) || !name || !source) return res.status(400).json({ error: 'Informe data, nome e a fonte (lei/decreto/convenção).' });
      const row = await prisma.$transaction(async (tx) => {
        const r = await tx.payrollHoliday.create({ data: { date, name, scope, locality, storeId, source, createdById: req.userId } });
        await svc.audit(tx, { entity: 'PayrollHoliday', entityId: r.id, action: 'CREATE', after: r, req });
        return r;
      });
      return res.status(201).json({ holiday: row });
    } catch (err) { return fail(res, err, 'admin/holiday'); }
  });
  router.post('/admin/holidays/:id/deactivate', adminOnly, ownerOnly, async (req, res) => {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const r = await tx.payrollHoliday.update({ where: { id: req.params.id }, data: { active: false } });
        await svc.audit(tx, { entity: 'PayrollHoliday', entityId: r.id, action: 'DEACTIVATE', after: r, reason: req.body?.reason, req });
        return r;
      });
      return res.json({ holiday: row });
    } catch (err) { return fail(res, err, 'admin/holiday-off'); }
  });

  // Regras de comissão: nova versão encerra a anterior (vigência), nunca reescreve.
  router.get('/admin/commission-rules', adminOnly, async (_req, res) => {
    try { return res.json({ rules: await prisma.payrollCommissionRule.findMany({ orderBy: [{ validFrom: 'desc' }, { version: 'desc' }] }) }); }
    catch (err) { return fail(res, err, 'admin/rules'); }
  });
  router.post('/admin/commission-rules', adminOnly, ownerOnly, async (req, res) => {
    try {
      const { name, validFrom, validTo, issuerId, storeId, userId, config, previousId, notes } = req.body || {};
      if (!name || !cal.isDayKey(validFrom) || !config || !Array.isArray(config.tiers) || !config.tiers.length) return res.status(400).json({ error: 'Informe nome, vigência e as faixas da regra.' });
      const row = await prisma.$transaction(async (tx) => {
        let version = 1;
        if (previousId) {
          const prev = await tx.payrollCommissionRule.findUnique({ where: { id: previousId } });
          if (!prev) throw svc.httpError(404, 'Regra anterior não encontrada');
          version = prev.version + 1;
          if (!prev.validTo || prev.validTo >= validFrom) await tx.payrollCommissionRule.update({ where: { id: prev.id }, data: { validTo: cal.addDays(validFrom, -1) } });
        }
        const r = await tx.payrollCommissionRule.create({ data: { name, validFrom, validTo: validTo || null, issuerId: issuerId || null, storeId: storeId || null, userId: userId || null,
          config, version, previousId: previousId || null, notes: notes || null, createdById: req.userId } });
        await svc.audit(tx, { entity: 'PayrollCommissionRule', entityId: r.id, action: 'CREATE', after: r, req });
        return r;
      });
      return res.status(201).json({ rule: row });
    } catch (err) { return fail(res, err, 'admin/rule'); }
  });

  // Lançamentos: adiantamento, vale, passagem, domingo pago, desconto autorizado...
  router.get('/admin/entries', adminOnly, guardEmployee('user'), async (req, res) => {
    try { return res.json({ entries: await prisma.payrollEntry.findMany({ where: { userId: req.subjectUserId, ...(cal.isCompetence(req.query.competence) ? { competence: req.query.competence } : {}) }, orderBy: { date: 'desc' } }) }); }
    catch (err) { return fail(res, err, 'admin/entries'); }
  });
  router.post('/admin/entries', adminOnly, guardEmployee('user'), async (req, res) => {
    try {
      const b = req.body || {};
      const amountCents = Math.round(Number(b.amountCents));
      if (!ENTRY_KINDS.includes(b.kind)) return res.status(400).json({ error: 'Tipo de lançamento inválido' });
      if (!cal.isDayKey(b.date) || !Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Informe data e valor' });
      if (['DOMINGO_PAGO', 'FERIADO_PAGO'].includes(b.kind) && !cal.isDayKey(b.referenceDate)) return res.status(400).json({ error: 'Informe o domingo/feriado a que o pagamento se refere' });
      const competence = cal.isCompetence(b.competence) ? b.competence : b.date.slice(0, 7);
      const closed = await prisma.payslip.findFirst({ where: { userId: req.subjectUserId, competence, status: { in: ['FECHADO', 'PAGO'] } }, select: { id: true } });
      if (closed) return res.status(409).json({ error: 'Competência já fechada: reabra o contracheque para lançar.' });
      const row = await prisma.$transaction(async (tx) => {
        const e = await tx.payrollEntry.create({ data: { userId: req.subjectUserId, competence, date: b.date, kind: b.kind, amountCents, description: b.description || null,
          referenceDate: b.referenceDate || null, receiptRef: b.receiptRef || null, origin: b.origin || null, pixRef: b.pixRef || null,
          authorized: !!b.authorized, authorizationRef: b.authorizationRef || null, issuerId: b.issuerId || null, storeId: b.storeId || null, createdById: req.userId } });
        await svc.audit(tx, { entity: 'PayrollEntry', entityId: e.id, action: 'CREATE', subjectUserId: e.userId, after: e, req });
        return e;
      });
      return res.status(201).json({ entry: row });
    } catch (err) { return fail(res, err, 'admin/entry'); }
  });
  router.post('/admin/entries/:id/cancel', adminOnly, ownerOnly, async (req, res) => {
    try {
      if (!req.body?.reason) return res.status(400).json({ error: 'Motivo obrigatório' });
      const row = await prisma.$transaction(async (tx) => {
        const before = await tx.payrollEntry.findUnique({ where: { id: req.params.id } });
        if (!before) throw svc.httpError(404, 'Lançamento não encontrado');
        const closed = await tx.payslip.findFirst({ where: { userId: before.userId, competence: before.competence, status: { in: ['FECHADO', 'PAGO'] } }, select: { id: true } });
        if (closed) throw svc.httpError(409, 'Competência fechada: reabra para cancelar.');
        const e = await tx.payrollEntry.update({ where: { id: before.id }, data: { status: 'CANCELADO', canceledReason: String(req.body.reason).slice(0, 500) } });
        await svc.audit(tx, { entity: 'PayrollEntry', entityId: e.id, action: 'CANCEL', subjectUserId: e.userId, before, after: e, reason: req.body.reason, req });
        return e;
      });
      return res.json({ entry: row });
    } catch (err) { return fail(res, err, 'admin/entry-cancel'); }
  });

  // Marcações de dia (folga, compensatória, atestado, abono, falta confirmada...).
  router.get('/admin/day-marks', adminOnly, guardEmployee('user'), async (req, res) => {
    try {
      const c = competenceOr(req.query.competence);
      return res.json({ marks: await prisma.payrollDayMark.findMany({ where: { userId: req.subjectUserId, date: { gte: cal.firstDay(c), lte: cal.lastDay(c) } }, orderBy: { date: 'asc' } }) });
    } catch (err) { return fail(res, err, 'admin/marks'); }
  });
  router.post('/admin/day-marks', adminOnly, guardEmployee('user'), async (req, res) => {
    try {
      const b = req.body || {};
      if (!MARK_KINDS.includes(b.kind) || !cal.isDayKey(b.date)) return res.status(400).json({ error: 'Tipo ou data inválidos' });
      if (b.kind === 'FOLGA_COMPENSATORIA' && !cal.isDayKey(b.refDate)) return res.status(400).json({ error: 'Folga compensatória precisa do domingo/feriado que ela compensa' });
      const closed = await prisma.payslip.findFirst({ where: { userId: req.subjectUserId, competence: b.date.slice(0, 7), status: { in: ['FECHADO', 'PAGO'] } }, select: { id: true } });
      if (closed) return res.status(409).json({ error: 'Competência já fechada: reabra o contracheque para alterar.' });
      const row = await prisma.$transaction(async (tx) => {
        const m = await tx.payrollDayMark.create({ data: { userId: req.subjectUserId, date: b.date, kind: b.kind, minutes: b.minutes ? Math.round(b.minutes) : null,
          refDate: b.refDate || null, note: b.note || null, attachmentRef: b.attachmentRef || null, status: 'APROVADO', createdById: req.userId, reviewedById: req.userId, reviewedAt: new Date() } });
        await svc.audit(tx, { entity: 'PayrollDayMark', entityId: m.id, action: 'CREATE', subjectUserId: m.userId, after: m, req });
        return m;
      });
      return res.status(201).json({ mark: row });
    } catch (err) { return fail(res, err, 'admin/mark'); }
  });
  router.post('/admin/day-marks/:id/revoke', adminOnly, async (req, res) => {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const before = await tx.payrollDayMark.findUnique({ where: { id: req.params.id } });
        if (!before) throw svc.httpError(404, 'Marcação não encontrada');
        if (!(await canSee(req, before.userId))) throw svc.httpError(403, 'Funcionário fora da sua loja');
        const m = await tx.payrollDayMark.update({ where: { id: before.id }, data: { status: 'RECUSADO', reviewedById: req.userId, reviewedAt: new Date() } });
        await svc.audit(tx, { entity: 'PayrollDayMark', entityId: m.id, action: 'REVOKE', subjectUserId: m.userId, before, after: m, reason: req.body?.reason, req });
        return m;
      });
      return res.json({ mark: row });
    } catch (err) { return fail(res, err, 'admin/mark-revoke'); }
  });

  // Correções de ponto: aprovar cria uma batida NOVA (origem "correcao"); a original fica.
  router.get('/admin/clock-corrections', adminOnly, async (req, res) => {
    try {
      const rows = await prisma.payrollClockCorrection.findMany({ where: { status: req.query.status || 'PENDENTE' }, orderBy: { createdAt: 'asc' }, take: 200,
        select: { id: true, userId: true, storeId: true, date: true, type: true, claimedTime: true, justification: true, status: true, reviewNote: true, createdAt: true, attachmentMime: true } });
      const visible = [];
      for (const r of rows) if (await canSee(req, r.userId)) visible.push(r);
      const users = await prisma.user.findMany({ where: { id: { in: visible.map((r) => r.userId) } }, select: { id: true, name: true } });
      const names = new Map(users.map((u) => [u.id, u.name]));
      return res.json({ corrections: visible.map((r) => ({ ...r, name: names.get(r.userId) || null })) });
    } catch (err) { return fail(res, err, 'admin/corrections'); }
  });
  router.get('/admin/clock-corrections/:id/attachment', adminOnly, async (req, res) => {
    try {
      const c = await prisma.payrollClockCorrection.findUnique({ where: { id: req.params.id }, select: { userId: true, attachment: true, attachmentMime: true } });
      if (!c?.attachment || !(await canSee(req, c.userId))) return res.status(404).json({ error: 'Sem anexo' });
      res.set({ 'Content-Type': c.attachmentMime, 'Cache-Control': 'private, no-store' });
      return res.send(Buffer.from(c.attachment));
    } catch (err) { return fail(res, err, 'admin/correction-file'); }
  });
  router.post('/admin/clock-corrections/:id/:decision(approve|reject)', adminOnly, async (req, res) => {
    try {
      const approve = req.params.decision === 'approve';
      const row = await prisma.$transaction(async (tx) => {
        const c = await tx.payrollClockCorrection.findUnique({ where: { id: req.params.id } });
        if (!c) throw svc.httpError(404, 'Pedido não encontrado');
        if (!(await canSee(req, c.userId))) throw svc.httpError(403, 'Funcionário fora da sua loja');
        if (c.status !== 'PENDENTE') throw svc.httpError(409, 'Pedido já analisado');
        if (c.userId === req.userId) throw svc.httpError(403, 'Ninguém aprova a própria correção de ponto');
        const closed = await tx.payslip.findFirst({ where: { userId: c.userId, competence: c.date.slice(0, 7), status: { in: ['FECHADO', 'PAGO'] } }, select: { id: true } });
        if (closed && approve) throw svc.httpError(409, 'Competência já fechada: reabra o contracheque antes de aprovar.');
        let clockInId = null;
        if (approve) {
          const user = await tx.user.findUnique({ where: { id: c.userId }, select: { storeId: true } });
          const storeId = c.storeId || user?.storeId;
          if (!storeId) throw svc.httpError(409, 'Funcionário sem loja: não dá para registrar a batida.');
          const punch = await tx.clockIn.create({ data: { userId: c.userId, storeId, type: c.type, timestamp: cal.localTimeToDate(c.date, c.claimedTime),
            note: `Correção aprovada (pedido ${c.id})`, source: 'correcao', correctionId: c.id } });
          clockInId = punch.id;
        }
        const saved = await tx.payrollClockCorrection.update({ where: { id: c.id }, data: { status: approve ? 'APROVADA' : 'RECUSADA', reviewNote: req.body?.note || null,
          reviewedById: req.userId, reviewedAt: new Date(), clockInId } });
        await svc.audit(tx, { entity: 'PayrollClockCorrection', entityId: c.id, action: approve ? 'APPROVE' : 'REJECT', subjectUserId: c.userId,
          before: { status: c.status }, after: { status: saved.status, clockInId }, reason: req.body?.note, req });
        return saved;
      });
      return res.json({ correction: { id: row.id, status: row.status, clockInId: row.clockInId } });
    } catch (err) { return fail(res, err, 'admin/correction-review'); }
  });

  // Fluxo do contracheque: revisar → aprovar → fechar → pagar; reabrir gera nova versão.
  router.post('/admin/payslips/review', adminOnly, guardEmployee('user'), async (req, res) => {
    try {
      if (!cal.isCompetence(req.body?.competence)) return res.status(400).json({ error: 'Competência inválida' });
      const p = await svc.review(prisma, { userId: req.subjectUserId, competence: req.body.competence, req });
      return res.json({ payslip: publicPayslip(p) });
    } catch (err) { return fail(res, err, 'admin/review'); }
  });
  router.get('/admin/payslips/:id', adminOnly, guardEmployee('payslip'), async (req, res) => {
    try {
      const p = await prisma.payslip.findUnique({ where: { id: req.params.id } });
      const versions = await prisma.payslip.findMany({ where: { userId: p.userId, competence: p.competence, kind: p.kind }, orderBy: { version: 'asc' },
        select: { id: true, version: true, status: true, netCents: true, closedAt: true, reason: true } });
      await svc.audit(prisma, { entity: 'Payslip', entityId: p.id, action: 'VIEW_ADMIN', subjectUserId: p.userId, req });
      return res.json({ payslip: publicPayslip(p), versions });
    } catch (err) { return fail(res, err, 'admin/payslip'); }
  });
  router.post('/admin/payslips/:id/approve', adminOnly, ownerOnly, async (req, res) => {
    try { return res.json({ payslip: publicPayslip(await svc.approve(prisma, { id: req.params.id, req })) }); }
    catch (err) { return fail(res, err, 'admin/approve'); }
  });
  router.post('/admin/payslips/:id/close', adminOnly, ownerOnly, async (req, res) => {
    try {
      const paymentDate = cal.isDayKey(req.body?.paymentDate) ? req.body.paymentDate : null;
      const p = await svc.close(prisma, { id: req.params.id, req, paymentDate, reason: req.body?.note || null, nowMs: now() });
      // Aviso automático pelo WhatsApp (dono, 16/11/2026). Falha no envio não desfaz o fechamento.
      notify.notifyClosed(prisma, p.id, { sender: sender || undefined, nowMs: now() }).catch((e) => console.error('[payroll] whatsapp', e.message));
      return res.json({ payslip: publicPayslip(p) });
    } catch (err) { return fail(res, err, 'admin/close'); }
  });
  router.post('/admin/payslips/:id/pay', adminOnly, ownerOnly, async (req, res) => {
    try { return res.json({ payslip: publicPayslip(await svc.markPaid(prisma, { id: req.params.id, req, paymentRef: req.body?.paymentRef, paidAt: req.body?.paidAt })) }); }
    catch (err) { return fail(res, err, 'admin/pay'); }
  });
  router.post('/admin/payslips/:id/reopen', adminOnly, ownerOnly, async (req, res) => {
    try { return res.json({ payslip: publicPayslip(await svc.reopen(prisma, { id: req.params.id, req, reason: req.body?.reason })) }); }
    catch (err) { return fail(res, err, 'admin/reopen'); }
  });
  router.post('/admin/payslips/:id/cancel', adminOnly, ownerOnly, async (req, res) => {
    try { return res.json({ payslip: publicPayslip(await svc.cancel(prisma, { id: req.params.id, req, reason: req.body?.reason })) }); }
    catch (err) { return fail(res, err, 'admin/cancel'); }
  });
  router.post('/admin/payslips/:id/notify', adminOnly, ownerOnly, async (req, res) => {
    try { return res.json(await notify.notifyClosed(prisma, req.params.id, { sender: sender || undefined, nowMs: now() })); }
    catch (err) { return fail(res, err, 'admin/notify'); }
  });
  router.get('/admin/payslips/:id/pdf', adminOnly, guardEmployee('payslip'), async (req, res) => {
    try { return sendPdf(req, res, await prisma.payslip.findUnique({ where: { id: req.params.id } })); }
    catch (err) { return fail(res, err, 'admin/pdf'); }
  });
  router.get('/admin/payslips/:id/export', adminOnly, guardEmployee('payslip'), async (req, res) => {
    try { return sendExport(req, res, await prisma.payslip.findUnique({ where: { id: req.params.id } })); }
    catch (err) { return fail(res, err, 'admin/export'); }
  });
  router.get('/admin/payslips/:id/recompute', adminOnly, guardEmployee('payslip'), async (req, res) => {
    try {
      const p = await prisma.payslip.findUnique({ where: { id: req.params.id } });
      if (!svc.FROZEN_STATUSES.concat(['REABERTO', 'CORRIGIDO']).includes(p.status)) return res.status(409).json({ error: 'Só contracheque fechado tem dados congelados' });
      return res.json({ reproducible: svc.recompute(p).equal });
    } catch (err) { return fail(res, err, 'admin/recompute'); }
  });

  router.get('/admin/disputes', adminOnly, async (req, res) => {
    try {
      const rows = await prisma.payrollDispute.findMany({ where: req.query.status ? { status: req.query.status } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
      const visible = []; for (const r of rows) if (await canSee(req, r.userId)) visible.push(r);
      return res.json({ disputes: visible });
    } catch (err) { return fail(res, err, 'admin/disputes'); }
  });
  router.post('/admin/disputes/:id/respond', adminOnly, async (req, res) => {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const d = await tx.payrollDispute.findUnique({ where: { id: req.params.id } });
        if (!d) throw svc.httpError(404, 'Solicitação não encontrada');
        if (!(await canSee(req, d.userId))) throw svc.httpError(403, 'Funcionário fora da sua loja');
        const saved = await tx.payrollDispute.update({ where: { id: d.id }, data: { status: req.body?.close ? 'ENCERRADA' : 'RESPONDIDA', response: String(req.body?.response || '').slice(0, 2000), respondedById: req.userId, respondedAt: new Date() } });
        await svc.audit(tx, { entity: 'PayrollDispute', entityId: d.id, action: 'RESPOND', subjectUserId: d.userId, after: { status: saved.status }, req });
        return saved;
      });
      return res.json({ dispute: row });
    } catch (err) { return fail(res, err, 'admin/dispute-respond'); }
  });

  router.get('/admin/audit', adminOnly, ownerOnly, async (req, res) => {
    try {
      const where = {};
      if (req.query.userId) where.subjectUserId = String(req.query.userId);
      if (req.query.entityId) where.entityId = String(req.query.entityId);
      return res.json({ logs: await prisma.payrollAuditLog.findMany({ where, orderBy: { at: 'desc' }, take: 300 }) });
    } catch (err) { return fail(res, err, 'admin/audit'); }
  });

  // ───────────────────────────── helpers ─────────────────────────────
  async function sendPdf(req, res, p) {
    const file = p && await prisma.payslipFile.findUnique({ where: { payslipId: p.id } });
    if (!file) return res.status(404).json({ error: 'PDF disponível só depois do fechamento' });
    await svc.audit(prisma, { entity: 'Payslip', entityId: p.id, action: 'EXPORT_PDF', subjectUserId: p.userId, req });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${file.fileName}"`, 'Cache-Control': 'private, no-store', 'X-Content-SHA256': file.sha256 });
    return res.send(Buffer.from(file.content));
  }
  async function sendExport(req, res, p) {
    if (!p?.result) return res.status(404).json({ error: 'Sem dados' });
    const format = req.query.format === 'json' ? 'json' : 'csv';
    await svc.audit(prisma, { entity: 'Payslip', entityId: p.id, action: 'EXPORT_' + format.toUpperCase(), subjectUserId: p.userId, req });
    const name = `contracheque-${p.competence}-v${p.version}`;
    res.set({ 'Cache-Control': 'private, no-store' });
    if (format === 'json') {
      res.set({ 'Content-Disposition': `attachment; filename="${name}.json"` });
      return res.json({ id: p.id, competence: p.competence, version: p.version, status: p.status, verifyCode: p.verifyCode, result: p.result });
    }
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const money = (c) => (Number(c || 0) / 100).toFixed(2).replace('.', ',');
    const lines = [['Tipo', 'Código', 'Descrição', 'Referência', 'Valor (R$)', 'Memória de cálculo'].map(esc).join(';')];
    for (const it of p.result.items || []) lines.push([it.type, it.code, it.label, it.refText || '', money(it.cents), it.memo || ''].map(esc).join(';'));
    lines.push(['TOTAL', 'PROVENTOS', '', '', money(p.result.totals.grossCents), ''].map(esc).join(';'));
    lines.push(['TOTAL', 'DESCONTOS', '', '', money(p.result.totals.deductionsCents), ''].map(esc).join(';'));
    lines.push(['TOTAL', 'LIQUIDO', '', '', money(p.result.totals.netCents), ''].map(esc).join(';'));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` });
    return res.send('﻿' + lines.join('\r\n'));
  }
  return router;
}

function summarize(result) {
  const t = result.time?.totals || {};
  return {
    salaryCents: (result.items || []).filter((i) => ['SALARIO', 'SALARIO_PROPORCIONAL', 'HORAS_NORMAIS'].includes(i.code)).reduce((s, i) => s + i.cents, 0),
    commissionCents: (result.items || []).filter((i) => i.code.startsWith('COMISSAO')).reduce((s, i) => s + i.cents, 0),
    salesCents: result.commission?.confirmed?.totalCents || 0,
    registeredMinutes: t.registeredMinutes || 0, extraMinutes: t.extraMinutes || 0,
    sundaysWorked: t.sundaysWorked || 0, holidaysWorked: t.holidaysWorked || 0,
    pendingDaysOff: (result.specialDays || []).filter((s) => s.compOffStatus === 'FOLGA_PENDENTE').length,
    grossCents: result.totals?.grossCents || 0, deductionsCents: result.totals?.deductionsCents || 0, netCents: result.totals?.netCents || 0,
    pendencies: result.pendencies || [], blocking: result.blocking || 0,
  };
}
function publicPayslip(p) {
  const { snapshot, ...rest } = p;
  return { ...rest, hasSnapshot: !!snapshot };
}
function safeProfile(p) {
  if (!p) return null;
  const { cpfEnc, bankEnc, ...rest } = p;
  return { ...rest, cpfMasked: p.cpfLast4 ? pcrypto.maskCpf(p.cpfLast4) : null, hasBankData: !!bankEnc };
}
function profileInput(b) {
  const out = {};
  const str = (k) => { if (b[k] !== undefined) out[k] = b[k] === '' || b[k] == null ? null : String(b[k]).slice(0, 200); };
  const int = (k) => { if (b[k] !== undefined) out[k] = b[k] === '' || b[k] == null ? null : Math.round(Number(b[k])); };
  ['issuerId', 'storeId', 'registration', 'jobTitle', 'cbo', 'apprenticeContractRef', 'timeBankAgreementRef', 'unionName', 'cctRef', 'notes'].forEach(str);
  ['baseSalaryCents', 'hourlyRateCents', 'weeklyMinutes', 'workDaysPerWeek', 'shiftMinutes', 'irrfDependents', 'familyAllowanceChildren'].forEach(int);
  for (const k of ['admissionDate', 'terminationDate']) if (b[k] !== undefined) {
    if (b[k] && !cal.isDayKey(b[k])) throw svc.httpError(400, 'Data inválida em ' + k);
    out[k] = b[k] || null;
  }
  if (b.contractType !== undefined) {
    if (!CONTRACTS.includes(b.contractType)) throw svc.httpError(400, 'Tipo de contratação inválido');
    out.contractType = b.contractType; out.registered = b.contractType !== 'SEM_REGISTRO';
  }
  for (const k of ['vtOptIn', 'active']) if (b[k] !== undefined) out[k] = !!b[k];
  if (b.cpf) {
    const digits = String(b.cpf).replace(/\D/g, '');
    if (digits.length !== 11) throw svc.httpError(400, 'CPF inválido');
    out.cpfEnc = pcrypto.encrypt(digits); out.cpfLast4 = digits.slice(-4);
  }
  if (b.bank) out.bankEnc = pcrypto.encrypt(JSON.stringify(b.bank));
  for (const k of ['weeklyMinutes', 'workDaysPerWeek']) if (out[k] === null) delete out[k];
  return out;
}
function fail(res, err, tag) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  if (err && err.code === 'P2025') return res.status(404).json({ error: 'Não encontrado' });
  console.error('[payroll ' + tag + ']', err);
  return res.status(500).json({ error: 'Erro interno no contracheque' });
}

const router = createPayrollRouter();
module.exports = router;
module.exports.createPayrollRouter = createPayrollRouter;
module.exports.summarize = summarize;
