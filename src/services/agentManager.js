// Agente GERENTE dos agentes dos vendedores (dono 17/11/2026).
// "Cada vendedor tem um agente e tem um agente gerente de todos os agentes, que vai receber
//  alguma informação que o agente do vendedor não souber, passa pro gerente e daí passa pra mim."
//
// Fluxo: agente do vendedor não sabe / é decisão da empresa → escalate()
//   1) o gerente procura nas RESPOSTAS OFICIAIS do dono (AgentKnowledge); se uma responde, devolve.
//   2) senão abre a pergunta #N (AgentQuestion) e manda pro WhatsApp do dono:
//      "❓ Pergunta #12 — João (Bessa): ...  Responda: R12 sua resposta".
//   3) dono responde "R12 ..." → vai pro vendedor no WhatsApp e vira resposta oficial (todo agente passa a saber).
// Tabelas por SQL aditivo/idempotente (o deploy não roda prisma db push).

const TZ_NOTE = 'America/Fortaleza';
let ready = null;
function ensureSchema(prisma) {
  if (!ready) {
    ready = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentQuestion" (
        "id" SERIAL PRIMARY KEY,
        "sellerId" TEXT NOT NULL,
        "question" TEXT NOT NULL,
        "context" TEXT,
        "status" TEXT NOT NULL DEFAULT 'PENDENTE',
        "answer" TEXT,
        "answeredBy" TEXT,
        "knowledgeId" INTEGER,
        "notifiedAt" TIMESTAMP(3),
        "answeredAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
      )`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AgentQuestion_status_idx" ON "AgentQuestion" ("status", "createdAt")`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AgentKnowledge" (
        "id" SERIAL PRIMARY KEY,
        "question" TEXT NOT NULL,
        "answer" TEXT NOT NULL,
        "source" TEXT NOT NULL DEFAULT 'dono',
        "active" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
      )`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const firstName = (n) => { const w = String(n || '').trim().split(/\s+/)[0] || ''; return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); };

async function knowledge(prisma, limit = 80) {
  await ensureSchema(prisma);
  return prisma.$queryRaw`SELECT "id","question","answer","createdAt" FROM "AgentKnowledge" WHERE "active" = true ORDER BY "id" DESC LIMIT ${limit}`;
}

// Texto curto das respostas oficiais, pro prompt de todos os agentes.
async function knowledgePrompt(prisma) {
  try {
    const rows = await knowledge(prisma, 60);
    if (!rows.length) return '(nenhuma resposta oficial registrada ainda)';
    return rows.map((r) => `- P: ${String(r.question).slice(0, 220)}\n  R (dono): ${String(r.answer).slice(0, 400)}`).join('\n');
  } catch (e) { return '(respostas oficiais indisponíveis)'; }
}

// O gerente tenta responder com as respostas oficiais. Devolve texto ou null (não sabe).
async function managerTry(prisma, question, { client, model } = {}) {
  const rows = await knowledge(prisma, 80);
  if (!rows.length || !client) return null;
  const kb = rows.map((r) => `#${r.id} P: ${r.question}\nR: ${r.answer}`).join('\n\n');
  try {
    const resp = await client.messages.create({
      model: model || process.env.SELLER_AGENT_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: 'Você é o gerente dos agentes de vendas da Sports & Tennis. Responda a pergunta do vendedor SOMENTE se uma das respostas oficiais do dono abaixo responde exatamente o que foi perguntado. Não deduza, não generalize, não invente. Se nenhuma responde com certeza, devolva exatamente NAO_SEI. Se responde, devolva só a resposta, curta, em português, citando que é orientação do Douglas.',
      messages: [{ role: 'user', content: `Respostas oficiais do dono:\n${kb}\n\nPergunta do vendedor: ${question}` }],
    });
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text || /NAO_SEI/i.test(text)) return null;
    return text;
  } catch (e) {
    console.warn('[agent-manager] gerente indisponível:', e.message);
    return null;
  }
}

function defaultSend() {
  const wa = require('../whatsapp');
  return (phone, msg) => wa.sendCustomMessage(phone, msg);
}
function ownerPhone() { return require('../config/lojasContato').CEO.whatsapp; }

// Escala uma pergunta. Retorna { answered, answer } (gerente sabia) ou { escalated, id }.
async function escalate(prisma, { seller, question, context = '', client = null, model = null, send = defaultSend() }) {
  await ensureSchema(prisma);
  const q = String(question || '').trim().slice(0, 1200);
  if (!q) return { error: 'pergunta vazia' };
  const known = await managerTry(prisma, q, { client, model });
  if (known) {
    await prisma.$executeRaw`INSERT INTO "AgentQuestion" ("sellerId","question","context","status","answer","answeredBy","answeredAt")
      VALUES (${seller.id}, ${q}, ${String(context || '').slice(0, 1000)}, 'RESPONDIDA_GERENTE', ${known}, 'gerente', NOW())`;
    return { answered: true, answer: known };
  }
  // Mesma pergunta do mesmo vendedor ainda pendente: não manda de novo pro dono.
  const [dup] = await prisma.$queryRaw`SELECT "id" FROM "AgentQuestion" WHERE "sellerId" = ${seller.id} AND "status" = 'PENDENTE'
    AND lower("question") = lower(${q}) AND "createdAt" > NOW() - INTERVAL '3 days' LIMIT 1`;
  if (dup) return { escalated: true, id: dup.id, duplicate: true };
  const [row] = await prisma.$queryRaw`INSERT INTO "AgentQuestion" ("sellerId","question","context") VALUES (${seller.id}, ${q}, ${String(context || '').slice(0, 1000)}) RETURNING "id"`;
  const store = seller.store && seller.store.name ? ` (${seller.store.name})` : '';
  const msg = `❓ *Pergunta #${row.id}* — ${firstName(seller.name)}${store}:\n"${q}"${context ? `\n\nO agente já sabe: ${String(context).slice(0, 300)}` : ''}\n\nResponda aqui: *R${row.id}* e a resposta.`;
  const r = await send(ownerPhone(), msg).catch((e) => ({ ok: false, error: e.message }));
  if (r && r.ok) await prisma.$executeRaw`UPDATE "AgentQuestion" SET "notifiedAt" = NOW() WHERE "id" = ${row.id}`;
  else console.warn('[agent-manager] não avisou o dono da pergunta', row.id, r && r.error);
  return { escalated: true, id: row.id, ownerNotified: !!(r && r.ok) };
}

// "R12 resposta" vindo do dono.
function parseOwnerAnswer(text) {
  const m = String(text || '').trim().match(/^r\s*#?\s*(\d{1,7})\s*[:\-–]?\s+([\s\S]{1,2000})$/i);
  return m ? { id: Number(m[1]), answer: m[2].trim() } : null;
}

async function ownerAnswer(prisma, id, answer, { send = defaultSend() } = {}) {
  await ensureSchema(prisma);
  const [q] = await prisma.$queryRaw`SELECT * FROM "AgentQuestion" WHERE "id" = ${id} LIMIT 1`;
  if (!q) return { error: `Não achei a pergunta #${id}.` };
  if (q.knowledgeId) await prisma.$executeRaw`UPDATE "AgentKnowledge" SET "active" = false WHERE "id" = ${q.knowledgeId}`;
  const [kb] = await prisma.$queryRaw`INSERT INTO "AgentKnowledge" ("question","answer") VALUES (${q.question}, ${answer}) RETURNING "id"`;
  await prisma.$executeRaw`UPDATE "AgentQuestion" SET "status" = 'RESPONDIDA', "answer" = ${answer}, "answeredBy" = 'dono', "answeredAt" = NOW(), "knowledgeId" = ${kb.id} WHERE "id" = ${id}`;
  const seller = await prisma.user.findUnique({ where: { id: q.sellerId }, select: { name: true, phone: true } });
  let delivered = false;
  if (seller && seller.phone) {
    const r = await send(seller.phone, `📩 *Resposta do Douglas* (sua pergunta #${id}):\n"${q.question}"\n\n${answer}`).catch((e) => ({ ok: false, error: e.message }));
    delivered = !!(r && r.ok);
  }
  return { ok: true, seller: seller ? firstName(seller.name) : '?', delivered, alreadyAnswered: q.status !== 'PENDENTE' };
}

async function pending(prisma) {
  await ensureSchema(prisma);
  return prisma.$queryRaw`SELECT q."id", q."question", q."createdAt", u."name" AS "sellerName" FROM "AgentQuestion" q
    LEFT JOIN "User" u ON u."id" = q."sellerId" WHERE q."status" = 'PENDENTE' ORDER BY q."id" ASC LIMIT 30`;
}

module.exports = { ensureSchema, knowledgePrompt, managerTry, escalate, parseOwnerAnswer, ownerAnswer, pending, TZ_NOTE };
