// =====================================================================
// RH completo da Sports & Tennis (dono 18/11/2026: "Quero completo até com recrutamento").
// Construído dentro do TenisCash (inspirado em Horilla/Frappe HR, sem copiar código GPL):
//   1. Recrutamento — vagas, página pública /vagas, candidatura com currículo,
//      funil (Novo → Triagem → Entrevista → Proposta → Contratado/Reprovado), contratação
//      que já cria o funcionário (vendedor, loja, salário, admissão) e o checklist de admissão.
//   2. Férias pela CLT — períodos aquisitivo/concessivo, saldo, fracionamento (até 3,
//      um ≥14 dias e os outros ≥5), início não pode cair nos 2 dias antes de domingo/feriado,
//      aviso de 30 dias, abono (vender até 10 dias). Aprovada = entra na agenda como férias
//      (sai da escala, do aviso de expediente e do grupo).
//   3. Documentos do funcionário — com vencimento (ASO anual) e alerta.
//   4. Admissão e desligamento — checklist por pessoa.
//   5. Avaliação de desempenho — ciclos, notas por critério, autoavaliação, vendas do período.
//   6. Ficha do funcionário — tudo junto.
// A folha legal (INSS/IRRF/eSocial) segue com o contador; o recibo de férias usa a folha que já existe.
// Tabelas novas por SQL aditivo (o deploy não roda db push).
// =====================================================================
const crypto = require('crypto');

const STAGES = ['NOVO', 'TRIAGEM', 'ENTREVISTA', 'PROPOSTA', 'CONTRATADO', 'REPROVADO'];
const DOC_TYPES = {
  RG: { label: 'RG / CNH', months: null }, CPF: { label: 'CPF', months: null }, CTPS: { label: 'Carteira de Trabalho (digital)', months: null },
  PIS: { label: 'PIS / NIS', months: null }, COMPROVANTE: { label: 'Comprovante de residência', months: null },
  TITULO: { label: 'Título de eleitor', months: null }, RESERVISTA: { label: 'Reservista', months: null },
  ASO: { label: 'Exame médico (ASO)', months: 12 }, CONTRATO: { label: 'Contrato de trabalho', months: null },
  FILHOS: { label: 'Certidão / vacina dos filhos', months: null }, BANCO: { label: 'Dados bancários', months: null },
  ATESTADO: { label: 'Atestado médico', months: null }, OUTRO: { label: 'Outro', months: null },
};
const REQUIRED_DOCS = ['RG', 'CPF', 'CTPS', 'PIS', 'COMPROVANTE', 'ASO', 'CONTRATO', 'BANCO'];
const CHECKLISTS = {
  ADMISSAO: [
    'Documentos pessoais recebidos (RG, CPF, CTPS, PIS, comprovante)', 'Exame admissional (ASO) feito',
    'Dados enviados ao contador para registro e eSocial', 'Contrato de trabalho assinado', 'Cadastro no TenisCash (loja, cargo, salário)',
    'Acesso ao app e ao ponto liberado', 'Uniforme entregue', 'Apresentação da loja e da equipe',
    'Treinamento: produtos e marcas', 'Treinamento: caixa, bipagem e troca', 'Regras de comissão e metas explicadas', 'Link da escala do mês enviado',
  ],
  DESLIGAMENTO: [
    'Comunicado de desligamento / pedido de demissão registrado', 'Aviso prévio definido (trabalhado ou indenizado)',
    'Exame demissional (ASO) feito', 'Dados enviados ao contador para rescisão', 'Uniforme e materiais devolvidos',
    'Acesso ao app, ponto e sistemas desativado', 'Comissões e pendências do mês conferidas', 'Termo de rescisão assinado e pago',
  ],
};
const REVIEW_CRITERIA = [
  ['ATENDIMENTO', 'Atendimento ao cliente'], ['PRODUTO', 'Conhecimento de produto'], ['VENDAS', 'Resultado de vendas'],
  ['PONTUALIDADE', 'Pontualidade e assiduidade'], ['EQUIPE', 'Trabalho em equipe'], ['LOJA', 'Organização da loja e estoque'],
];
const TZ = 3 * 3600 * 1000;
const todayYmd = () => new Date(Date.now() - TZ).toISOString().slice(0, 10);
const ymd = (d) => (d ? new Date(new Date(d).getTime()).toISOString().slice(0, 10) : null);
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (s, n) => { const d = new Date(s + 'T12:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const normPhone = (v) => { let p = String(v || '').replace(/\D/g, ''); if (p.length >= 12 && p.startsWith('55')) p = p.slice(2); return p.slice(0, 11); };
const CONSENT_V = 'v1-2026-11-18: uso dos dados só para o processo seletivo e contato por WhatsApp; pedido de exclusão a qualquer momento; reprovados apagados em 12 meses';
const clean = (v, n = 200) => (v == null ? null : String(v).trim().slice(0, n) || null);
const id = () => crypto.randomUUID();

let ready = null;
function ensureSchema(prisma) {
  if (!ready) {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS "HrJob" ("id" TEXT PRIMARY KEY, "slug" TEXT UNIQUE NOT NULL, "title" TEXT NOT NULL, "storeId" TEXT, "jobTitle" TEXT NOT NULL DEFAULT 'VENDEDOR',
        "description" TEXT, "requirements" TEXT, "salaryText" TEXT, "schedule" TEXT, "openings" INT NOT NULL DEFAULT 1, "status" TEXT NOT NULL DEFAULT 'ABERTA',
        "questions" JSONB NOT NULL DEFAULT '[]', "createdById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS "HrCandidate" ("id" TEXT PRIMARY KEY, "jobId" TEXT NOT NULL, "name" TEXT NOT NULL, "phone" TEXT NOT NULL, "email" TEXT, "city" TEXT,
        "birthDate" TEXT, "linkedin" TEXT, "experience" TEXT, "answers" JSONB NOT NULL DEFAULT '{}', "resumeFile" TEXT, "resumeName" TEXT, "resumeMime" TEXT,
        "stage" TEXT NOT NULL DEFAULT 'NOVO', "rating" INT, "source" TEXT, "consentAt" TIMESTAMP(3) NOT NULL, "hiredUserId" TEXT, "rejectReason" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS "HrCandidate_job_idx" ON "HrCandidate" ("jobId", "stage")`,
      `ALTER TABLE "HrCandidate" ADD COLUMN IF NOT EXISTS "interviewUrl" TEXT`,
      `ALTER TABLE "HrCandidate" ADD COLUMN IF NOT EXISTS "interviewAt" TIMESTAMP(3)`,
      `ALTER TABLE "HrCandidate" ADD COLUMN IF NOT EXISTS "consentText" TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "HrCandidate_job_phone_uq" ON "HrCandidate" ("jobId", "phone")`,
      `CREATE TABLE IF NOT EXISTS "HrCandidateEvent" ("id" SERIAL PRIMARY KEY, "candidateId" TEXT NOT NULL, "kind" TEXT NOT NULL, "fromStage" TEXT, "toStage" TEXT,
        "note" TEXT, "scheduledAt" TIMESTAMP(3), "actorId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS "HrCandidateEvent_c_idx" ON "HrCandidateEvent" ("candidateId", "createdAt")`,
      `CREATE TABLE IF NOT EXISTS "HrDocument" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "type" TEXT NOT NULL, "title" TEXT, "storedName" TEXT NOT NULL,
        "originalName" TEXT, "mimeType" TEXT, "bytes" INT, "issuedAt" TEXT, "expiresAt" TEXT, "uploadedById" TEXT, "uploadedBySelf" BOOLEAN NOT NULL DEFAULT false,
        "status" TEXT NOT NULL DEFAULT 'ATIVO', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS "HrDocument_user_idx" ON "HrDocument" ("userId", "type")`,
      `CREATE TABLE IF NOT EXISTS "HrChecklist" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "kind" TEXT NOT NULL, "items" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'ABERTO',
        "dueDate" TEXT, "note" TEXT, "createdById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS "HrVacation" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "periodStart" TEXT NOT NULL, "startDate" TEXT NOT NULL, "endDate" TEXT NOT NULL,
        "days" INT NOT NULL, "soldDays" INT NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'PENDENTE', "note" TEXT, "warnings" JSONB NOT NULL DEFAULT '[]',
        "decidedById" TEXT, "decidedAt" TIMESTAMP(3), "decisionNote" TEXT, "agendaActivityId" TEXT, "requestedBySelf" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
      `CREATE INDEX IF NOT EXISTS "HrVacation_user_idx" ON "HrVacation" ("userId", "status")`,
      `CREATE TABLE IF NOT EXISTS "HrVacationAdjust" ("id" SERIAL PRIMARY KEY, "userId" TEXT NOT NULL, "periodStart" TEXT NOT NULL, "rightDays" INT NOT NULL, "reason" TEXT NOT NULL,
        "actorId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), UNIQUE ("userId", "periodStart"))`,
      `CREATE TABLE IF NOT EXISTS "HrReviewCycle" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "periodFrom" TEXT NOT NULL, "periodTo" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'ABERTO',
        "createdById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
      `CREATE TABLE IF NOT EXISTS "HrReview" ("id" TEXT PRIMARY KEY, "cycleId" TEXT NOT NULL, "userId" TEXT NOT NULL, "scores" JSONB NOT NULL DEFAULT '{}', "selfScores" JSONB NOT NULL DEFAULT '{}',
        "strengths" TEXT, "improve" TEXT, "goals" TEXT, "selfComment" TEXT, "managerDoneAt" TIMESTAMP(3), "selfDoneAt" TIMESTAMP(3), "reviewerId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), UNIQUE ("cycleId", "userId"))`,
      `CREATE TABLE IF NOT EXISTS "HrAudit" ("id" SERIAL PRIMARY KEY, "entity" TEXT NOT NULL, "entityId" TEXT, "action" TEXT NOT NULL, "actorId" TEXT, "detail" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`,
    ];
    ready = (async () => { for (const s of stmts) await prisma.$executeRawUnsafe(s); })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function audit(prisma, entity, entityId, action, actorId, detail) {
  await prisma.$executeRaw`INSERT INTO "HrAudit" ("entity","entityId","action","actorId","detail") VALUES (${entity}, ${entityId}, ${action}, ${actorId || null}, ${JSON.stringify(detail || {})}::jsonb)`.catch(() => {});
}

// ───────────────────────── 1. RECRUTAMENTO ─────────────────────────
function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'vaga';
}

async function storeName(prisma, storeId) {
  if (!storeId) return null;
  const s = await prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }).catch(() => null);
  return s ? s.name : null;
}

async function saveJob(prisma, data, actorId, jobId = null) {
  await ensureSchema(prisma);
  const title = clean(data.title, 120);
  if (!title) throw httpErr(400, 'Informe o título da vaga.');
  const status = ['ABERTA', 'PAUSADA', 'FECHADA'].includes(data.status) ? data.status : 'ABERTA';
  const questions = Array.isArray(data.questions) ? data.questions.map((q) => clean(q, 200)).filter(Boolean).slice(0, 8) : [];
  const openings = Math.max(1, Math.min(50, parseInt(data.openings, 10) || 1));
  const vals = [title, clean(data.storeId, 60), clean(data.jobTitle, 30) || 'VENDEDOR', clean(data.description, 4000), clean(data.requirements, 3000),
    clean(data.salaryText, 200), clean(data.schedule, 200), openings, status, JSON.stringify(questions)];
  if (jobId) {
    const n = await prisma.$executeRaw`UPDATE "HrJob" SET "title"=${vals[0]}, "storeId"=${vals[1]}, "jobTitle"=${vals[2]}, "description"=${vals[3]}, "requirements"=${vals[4]},
      "salaryText"=${vals[5]}, "schedule"=${vals[6]}, "openings"=${vals[7]}, "status"=${vals[8]}, "questions"=${vals[9]}::jsonb, "updatedAt"=NOW() WHERE "id"=${jobId}`;
    if (!n) throw httpErr(404, 'Vaga não encontrada.');
    await audit(prisma, 'HrJob', jobId, 'UPDATE', actorId, { title, status });
    return getJob(prisma, jobId);
  }
  const newId = id();
  let slug = slugify(title) + '-' + newId.slice(0, 5);
  await prisma.$executeRaw`INSERT INTO "HrJob" ("id","slug","title","storeId","jobTitle","description","requirements","salaryText","schedule","openings","status","questions","createdById")
    VALUES (${newId}, ${slug}, ${vals[0]}, ${vals[1]}, ${vals[2]}, ${vals[3]}, ${vals[4]}, ${vals[5]}, ${vals[6]}, ${vals[7]}, ${vals[8]}, ${vals[9]}::jsonb, ${actorId || null})`;
  await audit(prisma, 'HrJob', newId, 'CREATE', actorId, { title });
  return getJob(prisma, newId);
}

async function getJob(prisma, jobIdOrSlug) {
  await ensureSchema(prisma);
  const [j] = await prisma.$queryRaw`SELECT * FROM "HrJob" WHERE "id"=${jobIdOrSlug} OR "slug"=${jobIdOrSlug} LIMIT 1`;
  if (!j) return null;
  j.storeName = await storeName(prisma, j.storeId);
  return j;
}

async function listJobs(prisma, { publicOnly = false } = {}) {
  await ensureSchema(prisma);
  const rows = publicOnly
    ? await prisma.$queryRaw`SELECT * FROM "HrJob" WHERE "status"='ABERTA' ORDER BY "createdAt" DESC`
    : await prisma.$queryRaw`SELECT j.*, (SELECT count(*)::int FROM "HrCandidate" c WHERE c."jobId"=j."id") AS "candidates",
        (SELECT count(*)::int FROM "HrCandidate" c WHERE c."jobId"=j."id" AND c."stage"='NOVO') AS "newCandidates" FROM "HrJob" j ORDER BY j."status"='ABERTA' DESC, j."createdAt" DESC`;
  const stores = await prisma.store.findMany({ select: { id: true, name: true } });
  const sn = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  return rows.map((j) => ({ ...j, storeName: sn[j.storeId] || null }));
}

function publicJob(j) {
  return { slug: j.slug, title: j.title, storeName: j.storeName, description: j.description, requirements: j.requirements, salaryText: j.salaryText,
    schedule: j.schedule, questions: j.questions || [], createdAt: j.createdAt };
}

async function apply(prisma, slug, body, file) {
  await ensureSchema(prisma);
  const job = await getJob(prisma, slug);
  if (!job || job.status !== 'ABERTA') throw httpErr(404, 'Esta vaga não está mais aberta.');
  if (body.website) throw httpErr(400, 'Envio inválido.'); // armadilha anti-robô
  const name = clean(body.name, 120); const phone = normPhone(body.phone);
  if (!name || name.length < 3) throw httpErr(400, 'Informe seu nome completo.');
  if (phone.length < 10) throw httpErr(400, 'Informe um WhatsApp com DDD.');
  if (!(body.consent === true || body.consent === 'true' || body.consent === 'on')) throw httpErr(400, 'É preciso autorizar o uso dos seus dados para o processo seletivo.');
  const email = clean(body.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpErr(400, 'E-mail inválido.');
  const [dup] = await prisma.$queryRaw`SELECT "id" FROM "HrCandidate" WHERE "jobId"=${job.id} AND "phone"=${phone} LIMIT 1`;
  if (dup) throw httpErr(409, 'Você já se candidatou a esta vaga. Boa sorte! 🧡');
  let answers = {};
  try { answers = typeof body.answers === 'string' ? JSON.parse(body.answers) : (body.answers || {}); } catch (_) { answers = {}; }
  const qs = Array.isArray(job.questions) ? job.questions : [];
  const cleanAnswers = Object.fromEntries(qs.map((q, i) => [q, clean(answers[i] ?? answers[q], 1000) || '']));
  let saved = null;
  if (file) saved = require('./store').save(file);
  const cid = id();
  try {
    await prisma.$executeRaw`INSERT INTO "HrCandidate" ("id","jobId","name","phone","email","city","linkedin","experience","answers","resumeFile","resumeName","resumeMime","source","consentAt","consentText")
      VALUES (${cid}, ${job.id}, ${name}, ${phone}, ${email}, ${clean(body.city, 80)}, ${clean(body.linkedin, 200)},
        ${clean(body.experience, 3000)}, ${JSON.stringify(cleanAnswers)}::jsonb, ${saved && saved.storedName}, ${saved && saved.originalName}, ${saved && saved.mimeType}, ${clean(body.source, 40) || 'site'}, NOW(), ${CONSENT_V})`;
  } catch (e) {
    if (saved) require('./store').remove(saved.storedName);
    if (/unique|duplicate/i.test(e.message)) throw httpErr(409, 'Você já se candidatou a esta vaga. Boa sorte! 🧡');
    throw e;
  }
  await prisma.$executeRaw`INSERT INTO "HrCandidateEvent" ("candidateId","kind","toStage","note") VALUES (${cid}, 'CANDIDATURA', 'NOVO', ${'Candidatura pelo site: ' + job.title})`;
  return { ok: true, candidateId: cid, job: job.title };
}

async function listCandidates(prisma, { jobId = null, stage = null, q = null } = {}) {
  await ensureSchema(prisma);
  let rows = jobId
    ? await prisma.$queryRaw`SELECT c.*, j."title" AS "jobTitleText", j."storeId" FROM "HrCandidate" c JOIN "HrJob" j ON j."id"=c."jobId" WHERE c."jobId"=${jobId} ORDER BY c."createdAt" DESC`
    : await prisma.$queryRaw`SELECT c.*, j."title" AS "jobTitleText", j."storeId" FROM "HrCandidate" c JOIN "HrJob" j ON j."id"=c."jobId" ORDER BY c."createdAt" DESC LIMIT 1000`;
  if (stage) rows = rows.filter((r) => r.stage === stage);
  if (q) { const t = String(q).toLowerCase(); rows = rows.filter((r) => (r.name + ' ' + r.phone + ' ' + (r.city || '')).toLowerCase().includes(t)); }
  return rows.map((r) => ({ ...r, resumeFile: r.resumeFile ? true : false }));
}

async function getCandidate(prisma, cid) {
  await ensureSchema(prisma);
  const [c] = await prisma.$queryRaw`SELECT c.*, j."title" AS "jobTitleText", j."storeId", j."jobTitle" AS "jobRole" FROM "HrCandidate" c JOIN "HrJob" j ON j."id"=c."jobId" WHERE c."id"=${cid}`;
  if (!c) return null;
  c.events = await prisma.$queryRaw`SELECT * FROM "HrCandidateEvent" WHERE "candidateId"=${cid} ORDER BY "createdAt" DESC`;
  return c;
}

async function moveCandidate(prisma, cid, { stage, note, rating, rejectReason, scheduledAt }, actorId) {
  await ensureSchema(prisma);
  const c = await getCandidate(prisma, cid);
  if (!c) throw httpErr(404, 'Candidato não encontrado.');
  if (c.stage === 'CONTRATADO' && stage && stage !== 'CONTRATADO') throw httpErr(409, 'Candidato já contratado.');
  if (stage === 'CONTRATADO') throw httpErr(400, 'Para contratar use o botão Contratar (cria o funcionário).');
  if (stage && !STAGES.includes(stage)) throw httpErr(400, 'Etapa inválida.');
  const r = rating != null && rating !== '' ? Math.max(1, Math.min(5, parseInt(rating, 10) || 0)) || null : c.rating;
  const sched = scheduledAt && !isNaN(Date.parse(scheduledAt)) ? new Date(scheduledAt) : null;
  const url = sched ? (c.interviewUrl || 'https://meet.jit.si/SportsTennis-Entrevista-' + crypto.randomBytes(6).toString('hex')) : c.interviewUrl;
  await prisma.$executeRaw`UPDATE "HrCandidate" SET "stage"=${stage || c.stage}, "rating"=${r}, "rejectReason"=${stage === 'REPROVADO' ? clean(rejectReason, 300) : c.rejectReason},
    "interviewUrl"=${url}, "interviewAt"=${sched || c.interviewAt}, "updatedAt"=NOW() WHERE "id"=${cid}`;
  if ((stage && stage !== c.stage) || note || sched) {
    await prisma.$executeRaw`INSERT INTO "HrCandidateEvent" ("candidateId","kind","fromStage","toStage","note","scheduledAt","actorId")
      VALUES (${cid}, ${sched ? 'ENTREVISTA_MARCADA' : (stage && stage !== c.stage ? 'ETAPA' : 'NOTA')}, ${c.stage}, ${stage || c.stage}, ${clean(note, 2000)}, ${sched}, ${actorId || null})`;
  }
  return getCandidate(prisma, cid);
}

async function deleteCandidate(prisma, cid, actorId) {
  await ensureSchema(prisma);
  const [c] = await prisma.$queryRaw`SELECT "id","resumeFile","stage" FROM "HrCandidate" WHERE "id"=${cid}`;
  if (!c) throw httpErr(404, 'Candidato não encontrado.');
  if (c.resumeFile) require('./store').remove(c.resumeFile);
  await prisma.$executeRaw`DELETE FROM "HrCandidateEvent" WHERE "candidateId"=${cid}`;
  await prisma.$executeRaw`DELETE FROM "HrCandidate" WHERE "id"=${cid}`;
  await audit(prisma, 'HrCandidate', cid, 'DELETE_LGPD', actorId, { stage: c.stage });
  return { ok: true };
}

async function purgeOldCandidates(prisma) {
  await ensureSchema(prisma);
  const old = await prisma.$queryRaw`SELECT "id" FROM "HrCandidate" WHERE "stage"='REPROVADO' AND "updatedAt" < NOW() - INTERVAL '12 months'`;
  for (const o of old) await deleteCandidate(prisma, o.id, 'expurgo-12-meses').catch(() => {});
  return { apagados: old.length };
}

// Contratar: cria (ou promove) o usuário vendedor, loja, cargo, admissão, salário e checklist de admissão.
async function hire(prisma, cid, { storeId, admissionDate, salaryCents, jobTitle, confirmExisting }, actorId) {
  await ensureSchema(prisma);
  const c = await getCandidate(prisma, cid);
  if (!c) throw httpErr(404, 'Candidato não encontrado.');
  if (c.stage === 'CONTRATADO' && c.hiredUserId) return { ok: true, userId: c.hiredUserId, already: true };
  const sid = clean(storeId, 60) || c.storeId;
  if (!sid) throw httpErr(400, 'Escolha a loja do novo funcionário.');
  const store = await prisma.store.findUnique({ where: { id: sid }, select: { id: true, name: true } });
  if (!store) throw httpErr(400, 'Loja inválida.');
  const adm = YMD.test(String(admissionDate || '')) ? admissionDate : todayYmd();
  const cents = salaryCents != null && salaryCents !== '' ? Math.round(Number(salaryCents)) : 179000; // salário único do dono (18/11/2026)
  if (!(cents > 0) || cents > 5000000) throw httpErr(400, 'Salário inválido (confira o valor: ex. 1790,00).');
  const role = ['VENDEDOR', 'LOGISTICA', 'SUPERVISOR'].includes(jobTitle) ? jobTitle : (['VENDEDOR', 'LOGISTICA', 'SUPERVISOR'].includes(c.jobRole) ? c.jobRole : 'VENDEDOR');
  const phone = normPhone(c.phone);
  let user = await prisma.user.findFirst({ where: { phone: { in: [phone, '55' + phone] } }, select: { id: true, role: true, active: true, name: true } });
  if (user && !['user', 'seller'].includes(user.role)) throw httpErr(409, 'Esse telefone já é de uma conta da empresa (' + user.role + '). Confira o número do candidato.');
  if (user && user.role === 'seller' && user.active) throw httpErr(409, 'Esse telefone já é de um vendedor ativo (' + user.name + ').');
  if (user && !confirmExisting) throw Object.assign(httpErr(409, 'Já existe uma conta de cliente com esse telefone (' + user.name + '). Confirme para transformá-la em funcionário.'), { needsConfirm: true });
  const hireDate = new Date(adm + 'T12:00:00Z');
  if (user) {
    await prisma.user.update({ where: { id: user.id }, data: { role: 'seller', active: true, storeId: store.id, storeIds: [store.id], hireDate, baseSalary: cents / 100 } });
  } else {
    const bcrypt = require('bcryptjs');
    const pin = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10); // sem senha conhecida: entra pelo "esqueci a senha" com código no WhatsApp
    user = await prisma.user.create({ data: { name: c.name, phone, email: c.email || null, pin, role: 'seller', active: true, storeId: store.id, storeIds: [store.id], hireDate, baseSalary: cents / 100 }, select: { id: true } });
  }
  // contrato da folha (salário + admissão)
  const prof = await prisma.payrollEmployeeProfile.findUnique({ where: { userId: user.id } });
  if (prof) await prisma.payrollEmployeeProfile.update({ where: { userId: user.id }, data: { baseSalaryCents: cents, admissionDate: adm, storeId: store.id, active: true, terminationDate: null } });
  else await prisma.payrollEmployeeProfile.create({ data: { userId: user.id, baseSalaryCents: cents, admissionDate: adm, storeId: store.id, createdById: actorId || 'rh' } });
  try { await require('../jobTitle').set(prisma, user.id, role, actorId); } catch (_) {}
  await prisma.$executeRaw`UPDATE "HrCandidate" SET "stage"='CONTRATADO', "hiredUserId"=${user.id}, "updatedAt"=NOW() WHERE "id"=${cid}`;
  await prisma.$executeRaw`INSERT INTO "HrCandidateEvent" ("candidateId","kind","fromStage","toStage","note","actorId") VALUES (${cid}, 'CONTRATADO', ${c.stage}, 'CONTRATADO', ${'Contratado para ' + store.name + ' em ' + adm}, ${actorId || null})`;
  const cl = await startChecklist(prisma, user.id, 'ADMISSAO', actorId, addDays(adm, 7));
  await audit(prisma, 'HrCandidate', cid, 'HIRE', actorId, { userId: user.id, storeId: store.id, admissionDate: adm, salaryCents: cents, role });
  return { ok: true, userId: user.id, checklistId: cl.id, store: store.name, admissionDate: adm };
}

// ───────────────────────── 2. FÉRIAS (CLT) ─────────────────────────
async function admissionOf(prisma, userId) {
  const prof = await prisma.payrollEmployeeProfile.findUnique({ where: { userId }, select: { admissionDate: true } }).catch(() => null);
  if (prof && prof.admissionDate) return prof.admissionDate;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { hireDate: true } });
  return u && u.hireDate ? ymd(u.hireDate) : null;
}

async function holidaysSet(prisma) {
  try { const rows = await prisma.payrollHoliday.findMany({ select: { date: true } }); return new Set(rows.map((r) => r.date)); } catch (_) { return new Set(); }
}

// Períodos aquisitivos e saldo.
async function vacationBalance(prisma, userId, today = todayYmd()) {
  await ensureSchema(prisma);
  const adm = await admissionOf(prisma, userId);
  if (!adm) return { admissionDate: null, periods: [], missing: 'Sem data de admissão no cadastro (Contrato e salário).' };
  const vacs = await prisma.$queryRaw`SELECT * FROM "HrVacation" WHERE "userId"=${userId} AND "status" IN ('PENDENTE','APROVADA') ORDER BY "startDate"`;
  const adjust = await prisma.$queryRaw`SELECT * FROM "HrVacationAdjust" WHERE "userId"=${userId}`;
  const adjMap = Object.fromEntries(adjust.map((a) => [a.periodStart, a]));
  const periods = [];
  for (let i = 0; i < 40; i++) {
    const start = addMonths(adm, 12 * i);
    if (start > today) break;
    const end = addDays(addMonths(adm, 12 * (i + 1)), -1);
    const complete = end < today;
    const concessiveEnd = addDays(addMonths(adm, 12 * (i + 2)), -1);
    const right = adjMap[start] ? adjMap[start].rightDays : 30;
    const mine = vacs.filter((v) => v.periodStart === start);
    const approved = mine.filter((v) => v.status === 'APROVADA');
    const used = approved.reduce((s, v) => s + v.days + v.soldDays, 0);
    const pending = mine.filter((v) => v.status === 'PENDENTE').reduce((s, v) => s + v.days + v.soldDays, 0);
    const available = Math.max(0, right - used);
    periods.push({
      periodStart: start, periodEnd: end, complete, concessiveEnd, rightDays: right, usedDays: used, pendingDays: pending, availableDays: available,
      fractions: approved.length, soldDays: approved.reduce((s, v) => s + v.soldDays, 0),
      overdue: complete && available > 0 && concessiveEnd < today, // vencida → pagar em dobro (CLT art. 137)
      dueSoon: complete && available > 0 && !(concessiveEnd < today) && diffDays(today, concessiveEnd) <= 60,
      adjustReason: adjMap[start] ? adjMap[start].reason : null,
    });
  }
  return { admissionDate: adm, periods, vacations: vacs };
}

// Regras da CLT para um pedido (erros bloqueiam; avisos o dono decide).
async function validateVacation(prisma, userId, { periodStart, startDate, days, soldDays = 0 }, { ignoreId = null } = {}) {
  const errors = []; const warnings = [];
  const bal = await vacationBalance(prisma, userId);
  if (!bal.admissionDate) return { errors: [bal.missing], warnings };
  const p = bal.periods.find((x) => x.periodStart === periodStart) || bal.periods.find((x) => x.complete && x.availableDays > 0);
  if (!p) return { errors: ['Ainda não há período de férias completo (o direito vem a cada 12 meses de casa).'], warnings };
  if (!p.complete) errors.push('O período aquisitivo ainda não terminou (termina em ' + p.periodEnd.split('-').reverse().join('/') + ').');
  const d = parseInt(days, 10) || 0; const sold = parseInt(soldDays, 10) || 0;
  if (!YMD.test(String(startDate || ''))) errors.push('Informe a data de início.');
  if (d < 5) errors.push('Cada período de férias tem no mínimo 5 dias (CLT art. 134).');
  const others = (bal.vacations || []).filter((v) => v.periodStart === p.periodStart && v.id !== ignoreId);
  const usedOthers = others.reduce((s, v) => s + v.days + v.soldDays, 0);
  // Abono (art. 143): até 1/3 do direito do período, somando todas as partes.
  const soldTotal = others.reduce((s, v) => s + v.soldDays, 0) + sold;
  const maxSold = Math.floor(p.rightDays / 3);
  if (sold < 0) errors.push('Dias vendidos inválidos.');
  else if (soldTotal > maxSold) errors.push('Só é possível vender até 1/3 do direito: ' + maxSold + ' dias neste período (abono, CLT art. 143).');
  if (d + sold > p.rightDays - usedOthers) errors.push('Passa do saldo: restam ' + Math.max(0, p.rightDays - usedOthers) + ' dias neste período.');
  if (others.length >= 3) errors.push('As férias podem ser divididas em no máximo 3 períodos (CLT art. 134).');
  // Fracionamento (art. 134 §1º): até 3 partes, uma com 14+ dias e as outras com 5+.
  // Com direito reduzido (faltas, art. 130) o mínimo da parte maior é o próprio saldo de gozo.
  const parts = others.length + 1;
  const remaining = p.rightDays - usedOthers - d - sold;
  const minBig = Math.min(14, p.rightDays - soldTotal);
  const hasBig = [...others.map((v) => v.days), d].some((x) => x >= minBig);
  if (remaining > 0 && remaining < 5) errors.push('Sobrariam ' + remaining + ' dia(s), que não formam outra parte (mínimo 5): ajuste a divisão.');
  else if (parts >= 3 && remaining > 0) errors.push('Esta é a 3ª parte: ela precisa usar todo o saldo (restariam ' + remaining + ' dias).');
  if (!hasBig && (parts >= 3 || remaining < minBig)) errors.push('Um dos períodos precisa ter pelo menos ' + minBig + ' dias corridos (CLT art. 134).');
  if (YMD.test(String(startDate || ''))) {
    const hol = await holidaysSet(prisma);
    const dow = new Date(startDate + 'T12:00:00Z').getUTCDay();
    const bad = [1, 2].some((k) => { const x = addDays(startDate, k); return new Date(x + 'T12:00:00Z').getUTCDay() === 0 || hol.has(x); });
    if (bad || dow === 0 || hol.has(startDate)) errors.push('As férias não podem começar nos 2 dias antes de domingo ou feriado (CLT art. 134 §3º). Escolha outro dia de início.');
    const ahead = diffDays(todayYmd(), startDate);
    if (ahead < 0) errors.push('A data de início já passou.');
    else if (ahead < 30) warnings.push('Aviso com menos de 30 dias de antecedência (CLT art. 135): combine com o funcionário.');
    const end = addDays(startDate, d - 1);
    if (end > p.concessiveEnd) warnings.push('Termina depois do prazo do período (' + p.concessiveEnd.split('-').reverse().join('/') + '): os dias fora do prazo são pagos em dobro (CLT art. 137).');
    // conflito com QUALQUER férias da pessoa (de qualquer período), pendente ou aprovada
    if ((bal.vacations || []).some((v) => v.id !== ignoreId && !(v.endDate < startDate || v.startDate > end))) errors.push('Já existe férias nesse intervalo.');
  }
  return { errors, warnings, period: p, endDate: YMD.test(String(startDate || '')) ? addDays(startDate, d - 1) : null };
}

async function requestVacation(prisma, userId, body, { bySelf = true, actorId = null } = {}) {
  await ensureSchema(prisma);
  const v = await validateVacation(prisma, userId, body);
  if (v.errors.length) throw httpErr(400, v.errors.join(' '));
  const vid = id();
  const days = parseInt(body.days, 10); const sold = parseInt(body.soldDays, 10) || 0;
  await prisma.$executeRaw`INSERT INTO "HrVacation" ("id","userId","periodStart","startDate","endDate","days","soldDays","note","warnings","requestedBySelf")
    VALUES (${vid}, ${userId}, ${v.period.periodStart}, ${body.startDate}, ${v.endDate}, ${days}, ${sold}, ${clean(body.note, 300)}, ${JSON.stringify(v.warnings)}::jsonb, ${bySelf})`;
  await audit(prisma, 'HrVacation', vid, 'REQUEST', actorId || userId, { startDate: body.startDate, days, sold });
  return { ok: true, id: vid, warnings: v.warnings, endDate: v.endDate };
}

async function decideVacation(prisma, vid, approve, actorId, note = null) {
  await ensureSchema(prisma);
  const [v] = await prisma.$queryRaw`SELECT * FROM "HrVacation" WHERE "id"=${vid}`;
  if (!v) throw httpErr(404, 'Pedido não encontrado.');
  if (v.status !== 'PENDENTE') throw httpErr(409, 'Esse pedido já foi decidido.');
  if (!approve) {
    await prisma.$executeRaw`UPDATE "HrVacation" SET "status"='RECUSADA', "decidedById"=${actorId}, "decidedAt"=NOW(), "decisionNote"=${clean(note, 300)} WHERE "id"=${vid} AND "status"='PENDENTE'`;
    await audit(prisma, 'HrVacation', vid, 'REJECT', actorId, { note });
    return { ok: true, status: 'RECUSADA' };
  }
  const chk = await validateVacation(prisma, v.userId, v, { ignoreId: v.id });
  if (chk.errors.length) throw httpErr(400, 'Não dá para aprovar: ' + chk.errors.join(' '));
  const act = await prisma.agendaActivity.create({ data: {
    title: 'Férias', type: 'ferias', date: new Date(v.startDate + 'T12:00:00Z'), endDate: new Date(v.endDate + 'T12:00:00Z'), allDay: true,
    sellerId: v.userId, note: 'Férias aprovadas no RH' + (v.soldDays ? ` · vendeu ${v.soldDays} dia(s)` : ''),
  } });
  const n = await prisma.$executeRaw`UPDATE "HrVacation" SET "status"='APROVADA', "decidedById"=${actorId}, "decidedAt"=NOW(), "decisionNote"=${clean(note, 300)}, "agendaActivityId"=${act.id} WHERE "id"=${vid} AND "status"='PENDENTE'`;
  if (!n) { await prisma.agendaActivity.delete({ where: { id: act.id } }).catch(() => {}); throw httpErr(409, 'Esse pedido já foi decidido.'); }
  await audit(prisma, 'HrVacation', vid, 'APPROVE', actorId, { agendaActivityId: act.id });
  // CLT art. 145: pagar até 2 dias antes do início.
  return { ok: true, status: 'APROVADA', payUntil: addDays(v.startDate, -2), agendaActivityId: act.id };
}

async function cancelVacation(prisma, vid, actorId, { bySelfUserId = null } = {}) {
  await ensureSchema(prisma);
  const [v] = await prisma.$queryRaw`SELECT * FROM "HrVacation" WHERE "id"=${vid}`;
  if (!v) throw httpErr(404, 'Pedido não encontrado.');
  if (bySelfUserId && (v.userId !== bySelfUserId || v.status !== 'PENDENTE')) throw httpErr(403, 'Só dá para cancelar o seu pedido ainda pendente.');
  if (!['PENDENTE', 'APROVADA'].includes(v.status)) throw httpErr(409, 'Esse pedido não pode ser cancelado.');
  if (v.agendaActivityId) await prisma.agendaActivity.delete({ where: { id: v.agendaActivityId } }).catch(() => {});
  await prisma.$executeRaw`UPDATE "HrVacation" SET "status"='CANCELADA', "decidedById"=${actorId}, "decidedAt"=NOW() WHERE "id"=${vid}`;
  await audit(prisma, 'HrVacation', vid, 'CANCEL', actorId, {});
  return { ok: true };
}

async function adjustVacationRight(prisma, userId, periodStart, rightDays, reason, actorId) {
  await ensureSchema(prisma);
  const d = parseInt(rightDays, 10);
  if (!YMD.test(String(periodStart || '')) || !(d >= 0 && d <= 30)) throw httpErr(400, 'Período ou dias inválidos (0 a 30).');
  if (!clean(reason)) throw httpErr(400, 'Informe o motivo (ex.: faltas injustificadas — CLT art. 130).');
  await prisma.$executeRaw`INSERT INTO "HrVacationAdjust" ("userId","periodStart","rightDays","reason","actorId") VALUES (${userId}, ${periodStart}, ${d}, ${clean(reason, 300)}, ${actorId})
    ON CONFLICT ("userId","periodStart") DO UPDATE SET "rightDays"=EXCLUDED."rightDays", "reason"=EXCLUDED."reason", "actorId"=EXCLUDED."actorId", "createdAt"=NOW()`;
  await audit(prisma, 'HrVacationAdjust', userId, 'SET', actorId, { periodStart, rightDays: d, reason });
  return vacationBalance(prisma, userId);
}

async function listVacations(prisma, { status = null } = {}) {
  await ensureSchema(prisma);
  const rows = status
    ? await prisma.$queryRaw`SELECT v.*, u."name" AS "userName" FROM "HrVacation" v JOIN "User" u ON u."id"=v."userId" WHERE v."status"=${status} ORDER BY v."startDate"`
    : await prisma.$queryRaw`SELECT v.*, u."name" AS "userName" FROM "HrVacation" v JOIN "User" u ON u."id"=v."userId" ORDER BY v."createdAt" DESC LIMIT 300`;
  return rows;
}

// ───────────────────────── 3. DOCUMENTOS ─────────────────────────
function docStatus(d, today = todayYmd()) {
  if (!d.expiresAt) return 'OK';
  if (d.expiresAt < today) return 'VENCIDO';
  if (diffDays(today, d.expiresAt) <= 30) return 'VENCENDO';
  return 'OK';
}

async function addDocument(prisma, userId, { type, title, issuedAt, expiresAt }, file, { actorId = null, bySelf = false } = {}) {
  await ensureSchema(prisma);
  if (!DOC_TYPES[type]) throw httpErr(400, 'Tipo de documento inválido.');
  if (!file) throw httpErr(400, 'Anexe o arquivo (PDF ou foto).');
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!u) throw httpErr(404, 'Funcionário não encontrado.');
  const iss = YMD.test(String(issuedAt || '')) ? issuedAt : null;
  if (iss && iss > todayYmd()) throw httpErr(400, 'A data do documento não pode ser no futuro.');
  const saved = require('./store').save(file);
  let exp = !bySelf && YMD.test(String(expiresAt || '')) ? expiresAt : null;
  if (!exp && DOC_TYPES[type].months) exp = addMonths(iss || todayYmd(), DOC_TYPES[type].months);
  const did = id();
  await prisma.$executeRaw`INSERT INTO "HrDocument" ("id","userId","type","title","storedName","originalName","mimeType","bytes","issuedAt","expiresAt","uploadedById","uploadedBySelf")
    VALUES (${did}, ${userId}, ${type}, ${clean(title, 120)}, ${saved.storedName}, ${saved.originalName}, ${saved.mimeType}, ${saved.bytes}, ${iss}, ${exp}, ${actorId}, ${bySelf})`;
  await audit(prisma, 'HrDocument', did, 'UPLOAD', actorId || userId, { userId, type, bySelf });
  return { ok: true, id: did, expiresAt: exp };
}

async function listDocuments(prisma, userId) {
  await ensureSchema(prisma);
  const rows = await prisma.$queryRaw`SELECT "id","userId","type","title","originalName","mimeType","bytes","issuedAt","expiresAt","uploadedBySelf","createdAt" FROM "HrDocument"
    WHERE "userId"=${userId} AND "status"='ATIVO' ORDER BY "createdAt" DESC`;
  const seen = new Set();
  const docs = rows.map((d) => { const latest = !seen.has(d.type); seen.add(d.type); return { ...d, latest, typeLabel: DOC_TYPES[d.type] ? DOC_TYPES[d.type].label : d.type, situation: latest ? docStatus(d) : 'SUBSTITUIDO' }; });
  const have = new Set(docs.map((d) => d.type));
  return { documents: docs, missing: REQUIRED_DOCS.filter((t) => !have.has(t)).map((t) => ({ type: t, label: DOC_TYPES[t].label })) };
}

async function getDocumentFile(prisma, docId) {
  await ensureSchema(prisma);
  const [d] = await prisma.$queryRaw`SELECT * FROM "HrDocument" WHERE "id"=${docId} AND "status"='ATIVO'`;
  if (!d) return null;
  return { ...d, path: require('./store').resolve(d.storedName) };
}

async function removeDocument(prisma, docId, actorId) {
  await ensureSchema(prisma);
  const n = await prisma.$executeRaw`UPDATE "HrDocument" SET "status"='REMOVIDO' WHERE "id"=${docId} AND "status"='ATIVO'`;
  if (!n) throw httpErr(404, 'Documento não encontrado.');
  await audit(prisma, 'HrDocument', docId, 'REMOVE', actorId, {});
  return { ok: true };
}

async function expiringDocuments(prisma) {
  await ensureSchema(prisma);
  const today = todayYmd();
  const rows = await prisma.$queryRaw`SELECT DISTINCT ON (d."userId", d."type") d."id",d."userId",d."type",d."expiresAt",u."name" AS "userName" FROM "HrDocument" d JOIN "User" u ON u."id"=d."userId"
    WHERE d."status"='ATIVO' AND u."active"=true AND u."role"='seller' ORDER BY d."userId", d."type", d."createdAt" DESC`;
  return rows.filter((d) => d.expiresAt).map((d) => ({ ...d, typeLabel: DOC_TYPES[d.type] ? DOC_TYPES[d.type].label : d.type, situation: docStatus(d, today) })).filter((d) => d.situation !== 'OK').sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

// ───────────────────────── 4. ADMISSÃO / DESLIGAMENTO ─────────────────────────
async function startChecklist(prisma, userId, kind, actorId, dueDate = null) {
  await ensureSchema(prisma);
  if (!CHECKLISTS[kind]) throw httpErr(400, 'Tipo de checklist inválido.');
  const [open] = await prisma.$queryRaw`SELECT "id" FROM "HrChecklist" WHERE "userId"=${userId} AND "kind"=${kind} AND "status"='ABERTO' LIMIT 1`;
  if (open) return { id: open.id, already: true };
  const items = CHECKLISTS[kind].map((label, i) => ({ i, label, done: false, doneAt: null, doneBy: null }));
  const cid = id();
  await prisma.$executeRaw`INSERT INTO "HrChecklist" ("id","userId","kind","items","dueDate","createdById") VALUES (${cid}, ${userId}, ${kind}, ${JSON.stringify(items)}::jsonb, ${YMD.test(String(dueDate || '')) ? dueDate : null}, ${actorId || null})`;
  await audit(prisma, 'HrChecklist', cid, 'START', actorId, { userId, kind });
  return { id: cid };
}

async function toggleChecklistItem(prisma, checklistId, index, done, actorId) {
  await ensureSchema(prisma);
  const [c] = await prisma.$queryRaw`SELECT * FROM "HrChecklist" WHERE "id"=${checklistId}`;
  if (!c) throw httpErr(404, 'Checklist não encontrado.');
  const items = Array.isArray(c.items) ? c.items : [];
  const it = items.find((x) => x.i === Number(index));
  if (!it) throw httpErr(400, 'Item inválido.');
  it.done = !!done; it.doneAt = it.done ? new Date().toISOString() : null; it.doneBy = it.done ? actorId : null;
  const status = items.every((x) => x.done) ? 'CONCLUIDO' : 'ABERTO';
  await prisma.$executeRaw`UPDATE "HrChecklist" SET "items"=${JSON.stringify(items)}::jsonb, "status"=${status}, "updatedAt"=NOW() WHERE "id"=${checklistId}`;
  let desligado = false;
  if (status === 'CONCLUIDO' && c.status !== 'CONCLUIDO' && c.kind === 'DESLIGAMENTO') {
    const last = c.dueDate || todayYmd();
    await prisma.user.update({ where: { id: c.userId }, data: { role: 'user', storeId: null, storeIds: [] } });
    await prisma.payrollEmployeeProfile.update({ where: { userId: c.userId }, data: { terminationDate: last, active: false } }).catch(() => {});
    await audit(prisma, 'HrChecklist', checklistId, 'OFFBOARD_DONE', actorId, { userId: c.userId, lastDay: last });
    desligado = true;
  }
  return { ok: true, status, items, desligado };
}

async function listChecklists(prisma, { userId = null, status = null } = {}) {
  await ensureSchema(prisma);
  let rows = await prisma.$queryRaw`SELECT c.*, u."name" AS "userName" FROM "HrChecklist" c JOIN "User" u ON u."id"=c."userId" ORDER BY c."status"='ABERTO' DESC, c."createdAt" DESC LIMIT 200`;
  if (userId) rows = rows.filter((r) => r.userId === userId);
  if (status) rows = rows.filter((r) => r.status === status);
  return rows.map((r) => ({ ...r, done: (r.items || []).filter((x) => x.done).length, total: (r.items || []).length }));
}

// Desligamento: abre o checklist (o acesso só é desativado quando o dono marcar o item e confirmar).
async function startOffboarding(prisma, userId, { lastDay, note }, actorId) {
  const cl = await startChecklist(prisma, userId, 'DESLIGAMENTO', actorId, YMD.test(String(lastDay || '')) ? lastDay : null);
  if (note) await prisma.$executeRaw`UPDATE "HrChecklist" SET "note"=${clean(note, 500)} WHERE "id"=${cl.id}`;
  return cl;
}

// ───────────────────────── 5. AVALIAÇÃO ─────────────────────────
async function createCycle(prisma, { name, periodFrom, periodTo }, actorId) {
  await ensureSchema(prisma);
  if (!clean(name) || !YMD.test(String(periodFrom || '')) || !YMD.test(String(periodTo || '')) || periodTo < periodFrom) throw httpErr(400, 'Informe nome e período (de/até).');
  const cid = id();
  await prisma.$executeRaw`INSERT INTO "HrReviewCycle" ("id","name","periodFrom","periodTo","createdById") VALUES (${cid}, ${clean(name, 80)}, ${periodFrom}, ${periodTo}, ${actorId})`;
  const team = await prisma.user.findMany({ where: { role: 'seller', active: true }, select: { id: true } });
  for (const u of team) await prisma.$executeRaw`INSERT INTO "HrReview" ("id","cycleId","userId") VALUES (${id()}, ${cid}, ${u.id}) ON CONFLICT DO NOTHING`;
  await audit(prisma, 'HrReviewCycle', cid, 'CREATE', actorId, { name, people: team.length });
  return { ok: true, id: cid, people: team.length };
}

async function salesOf(prisma, userId, from, to) {
  const agg = await prisma.sale.aggregate({ where: { sellerId: userId, status: 'completed', createdAt: { gte: new Date(from + 'T03:00:00Z'), lt: new Date(addDays(to, 1) + 'T03:00:00Z') } }, _sum: { totalAmount: true }, _count: { _all: true } }).catch(() => null);
  return agg ? { total: Number(agg._sum.totalAmount || 0), count: agg._count._all } : { total: 0, count: 0 };
}

function avg(scores) {
  const vals = REVIEW_CRITERIA.map(([k]) => Number(scores && scores[k])).filter((x) => x >= 1 && x <= 5);
  return vals.length ? Math.round((vals.reduce((s, x) => s + x, 0) / vals.length) * 10) / 10 : null;
}

async function listCycles(prisma) {
  await ensureSchema(prisma);
  return prisma.$queryRaw`SELECT y.*, (SELECT count(*)::int FROM "HrReview" r WHERE r."cycleId"=y."id") AS "people",
    (SELECT count(*)::int FROM "HrReview" r WHERE r."cycleId"=y."id" AND r."managerDoneAt" IS NOT NULL) AS "done" FROM "HrReviewCycle" y ORDER BY y."createdAt" DESC`;
}

async function cycleDetail(prisma, cycleId) {
  await ensureSchema(prisma);
  const [y] = await prisma.$queryRaw`SELECT * FROM "HrReviewCycle" WHERE "id"=${cycleId}`;
  if (!y) throw httpErr(404, 'Ciclo não encontrado.');
  const rows = await prisma.$queryRaw`SELECT r.*, u."name" AS "userName", u."storeId" FROM "HrReview" r JOIN "User" u ON u."id"=r."userId" WHERE r."cycleId"=${cycleId} ORDER BY u."name"`;
  const out = [];
  for (const r of rows) out.push({ ...r, score: avg(r.scores), selfScore: avg(r.selfScores), sales: await salesOf(prisma, r.userId, y.periodFrom, y.periodTo) });
  return { cycle: y, criteria: REVIEW_CRITERIA, reviews: out };
}

async function saveReview(prisma, reviewId, body, actorId, { self = false, selfUserId = null } = {}) {
  await ensureSchema(prisma);
  const [r] = await prisma.$queryRaw`SELECT r.*, y."status" AS "cycleStatus" FROM "HrReview" r JOIN "HrReviewCycle" y ON y."id"=r."cycleId" WHERE r."id"=${reviewId}`;
  if (!r) throw httpErr(404, 'Avaliação não encontrada.');
  if (r.cycleStatus !== 'ABERTO') throw httpErr(409, 'Ciclo encerrado.');
  const scores = {};
  for (const [k] of REVIEW_CRITERIA) { const v = parseInt(body.scores && body.scores[k], 10); if (v >= 1 && v <= 5) scores[k] = v; }
  if (self) {
    if (r.userId !== selfUserId) throw httpErr(403, 'Essa avaliação não é sua.');
    await prisma.$executeRaw`UPDATE "HrReview" SET "selfScores"=${JSON.stringify(scores)}::jsonb, "selfComment"=${clean(body.comment, 2000)}, "selfDoneAt"=NOW(), "updatedAt"=NOW() WHERE "id"=${reviewId}`;
  } else {
    await prisma.$executeRaw`UPDATE "HrReview" SET "scores"=${JSON.stringify(scores)}::jsonb, "strengths"=${clean(body.strengths, 2000)}, "improve"=${clean(body.improve, 2000)},
      "goals"=${clean(body.goals, 2000)}, "managerDoneAt"=${Object.keys(scores).length === REVIEW_CRITERIA.length ? new Date() : null}, "reviewerId"=${actorId}, "updatedAt"=NOW() WHERE "id"=${reviewId}`;
  }
  await audit(prisma, 'HrReview', reviewId, self ? 'SELF' : 'MANAGER', actorId, { scores });
  return { ok: true };
}

async function closeCycle(prisma, cycleId, actorId) {
  await ensureSchema(prisma);
  await prisma.$executeRaw`UPDATE "HrReviewCycle" SET "status"='ENCERRADO' WHERE "id"=${cycleId}`;
  await audit(prisma, 'HrReviewCycle', cycleId, 'CLOSE', actorId, {});
  return { ok: true };
}

// ───────────────────────── 6. EQUIPE / FICHA ─────────────────────────
async function team(prisma) {
  await ensureSchema(prisma);
  const users = await prisma.user.findMany({ where: { role: 'seller', active: true }, select: { id: true, name: true, phone: true, storeId: true, hireDate: true }, orderBy: { name: 'asc' } });
  const stores = Object.fromEntries((await prisma.store.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const docsRows = await prisma.$queryRaw`SELECT DISTINCT ON ("userId","type") "userId","type","expiresAt" FROM "HrDocument" WHERE "status"='ATIVO' ORDER BY "userId","type","createdAt" DESC`;
  const out = [];
  for (const u of users) {
    const bal = await vacationBalance(prisma, u.id).catch(() => ({ periods: [] }));
    const available = (bal.periods || []).filter((p) => p.complete).reduce((s, p) => s + p.availableDays, 0);
    const overdue = (bal.periods || []).some((p) => p.overdue);
    const mine = docsRows.filter((d) => d.userId === u.id);
    const have = new Set(mine.map((d) => d.type));
    out.push({ id: u.id, name: u.name, phone: u.phone, store: stores[u.storeId] || null, admissionDate: bal.admissionDate || ymd(u.hireDate),
      vacationAvailable: available, vacationOverdue: overdue, docsMissing: REQUIRED_DOCS.filter((t) => !have.has(t)).length,
      docsExpired: mine.filter((d) => docStatus(d) === 'VENCIDO').length });
  }
  return out;
}

async function employeeFile(prisma, userId) {
  await ensureSchema(prisma);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, phone: true, email: true, role: true, active: true, storeId: true, hireDate: true, employeeCode: true } });
  if (!u) throw httpErr(404, 'Funcionário não encontrado.');
  const profile = await prisma.payrollEmployeeProfile.findUnique({ where: { userId }, select: { contractType: true, baseSalaryCents: true, admissionDate: true, weeklyMinutes: true, vtOptIn: true } }).catch(() => null);
  let jobTitle = null; try { jobTitle = (await require('../jobTitle').all(prisma))[userId] || 'VENDEDOR'; } catch (_) {}
  const [vac, docs, checklists] = await Promise.all([vacationBalance(prisma, userId), listDocuments(prisma, userId), listChecklists(prisma, { userId })]);
  const reviews = await prisma.$queryRaw`SELECT r.*, y."name" AS "cycleName", y."periodFrom", y."periodTo" FROM "HrReview" r JOIN "HrReviewCycle" y ON y."id"=r."cycleId" WHERE r."userId"=${userId} ORDER BY y."createdAt" DESC`;
  const incidents = await prisma.sellerComplianceIncident.findMany({ where: { sellerId: userId }, orderBy: { createdAt: 'desc' }, take: 20 }).catch(() => []);
  const trainings = await prisma.sellerTraining.findMany({ where: { userId }, orderBy: { completedAt: 'desc' }, take: 20, select: { topic: true, type: true, completedAt: true, score: true, certified: true } }).catch(() => []);
  const store = u.storeId ? await storeName(prisma, u.storeId) : null;
  return { user: { ...u, store, jobTitle }, profile, vacation: vac, documents: docs, checklists,
    reviews: reviews.map((r) => ({ ...r, score: avg(r.scores), selfScore: avg(r.selfScores) })), incidents, trainings };
}

async function dashboard(prisma) {
  await ensureSchema(prisma);
  const [jobs] = await prisma.$queryRaw`SELECT count(*) FILTER (WHERE "status"='ABERTA')::int AS "open" FROM "HrJob"`;
  const [cand] = await prisma.$queryRaw`SELECT count(*) FILTER (WHERE "stage"='NOVO')::int AS "novos", count(*) FILTER (WHERE "stage" IN ('TRIAGEM','ENTREVISTA','PROPOSTA'))::int AS "emAndamento" FROM "HrCandidate"`;
  const [vac] = await prisma.$queryRaw`SELECT count(*) FILTER (WHERE "status"='PENDENTE')::int AS "pendentes" FROM "HrVacation"`;
  const [cl] = await prisma.$queryRaw`SELECT count(*) FILTER (WHERE "status"='ABERTO')::int AS "abertos" FROM "HrChecklist"`;
  const tm = await team(prisma);
  return { vagasAbertas: jobs.open, candidatosNovos: cand.novos, candidatosEmAndamento: cand.emAndamento, feriasPendentes: vac.pendentes, checklistsAbertos: cl.abertos,
    feriasVencidas: tm.filter((t) => t.vacationOverdue).map((t) => t.name), documentosVencendo: (await expiringDocuments(prisma)).length,
    funcionarios: tm.length, semDocumentos: tm.filter((t) => t.docsMissing > 0).length };
}

// Link pessoal assinado para o "Meu RH" do vendedor (sem login).
function signedLink(userId, baseUrl, days = 45) {
  const k = require('../payroll/crypto').signLink('rh-' + userId, Date.now() + days * 86400000);
  return `${String(baseUrl || '').replace(/\/$/, '')}/meu-rh.html?k=${encodeURIComponent(k)}`;
}
function userFromLink(k) {
  const v = require('../payroll/crypto').verifyLink(k);
  return v && v.startsWith('rh-') ? v.slice(3) : null;
}

module.exports = {
  STAGES, DOC_TYPES, REQUIRED_DOCS, CHECKLISTS, REVIEW_CRITERIA, ensureSchema,
  saveJob, getJob, listJobs, publicJob, apply, listCandidates, getCandidate, moveCandidate, hire, deleteCandidate, purgeOldCandidates,
  vacationBalance, validateVacation, requestVacation, decideVacation, cancelVacation, adjustVacationRight, listVacations,
  addDocument, listDocuments, getDocumentFile, removeDocument, expiringDocuments,
  startChecklist, toggleChecklistItem, listChecklists, startOffboarding,
  createCycle, listCycles, cycleDetail, saveReview, closeCycle,
  team, employeeFile, dashboard, signedLink, userFromLink,
  _util: { addDays, addMonths, diffDays, todayYmd },
};
