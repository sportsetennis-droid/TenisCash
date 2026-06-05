// =====================================================================
// Memory Service — Memória da Empresa (o "cérebro" persistente da IA)
// =====================================================================
// Grava DUAS coisas na tabela CompanyMemory:
//   - fato  (kind="fact")  → o que a empresa É. pinned=true → a IA SEMPRE lê.
//   - evento(kind="event") → o que ACONTECE. linha do tempo, pra sempre.
//
// recordEvent NUNCA lança: gravar memória jamais pode derrubar a venda,
// a orquestração ou a aprovação que a originou. Falhou? loga e segue.
// =====================================================================

const { prisma } = require('../../middleware');

const VALID_KINDS = ['fact', 'event'];

function clampImportance(n) {
  const v = parseInt(n, 10);
  if (isNaN(v)) return 1;
  return Math.max(0, Math.min(3, v));
}

// ---------------------------------------------------------------------
// GRAVAR
// ---------------------------------------------------------------------
async function recordEvent({
  kind = 'event',
  category = 'geral',
  title,
  detail = null,
  data = null,
  company = 'Sports & Tennis',
  source = 'system',
  refType = null,
  refId = null,
  importance = 1,
  pinned = false,
  createdById = null,
} = {}) {
  try {
    if (!title || !String(title).trim()) return null;
    return await prisma.companyMemory.create({
      data: {
        kind: VALID_KINDS.includes(kind) ? kind : 'event',
        category: String(category || 'geral').slice(0, 60),
        title: String(title).slice(0, 300),
        detail: detail != null ? String(detail).slice(0, 4000) : null,
        data: data || undefined,
        company: company || null,
        source: source || 'system',
        refType: refType || null,
        refId: refId || null,
        importance: clampImportance(importance),
        pinned: !!pinned,
        createdById: createdById || null,
      },
    });
  } catch (err) {
    // Best-effort: memória nunca quebra o fluxo de quem chamou.
    console.error('[memory.recordEvent] falhou (ignorado):', err.message);
    return null;
  }
}

// Atalho: registrar um FATO da empresa (o que ela É). Por padrão fixado.
function addFact({
  category = 'empresa',
  title,
  detail = null,
  data = null,
  company,
  source = 'manual',
  refType = null,
  refId = null,
  importance = 2,
  pinned = true,
  createdById = null,
} = {}) {
  return recordEvent({
    kind: 'fact',
    category,
    title,
    detail,
    data,
    company,
    source,
    refType,
    refId,
    importance,
    pinned,
    createdById,
  });
}

// Atalho: anotação manual do dono na linha do tempo.
function recordNote({ category = 'nota', title, detail = null, company, importance = 1, createdById = null } = {}) {
  return recordEvent({ kind: 'event', category, title, detail, company, source: 'manual', importance, createdById });
}

// ---------------------------------------------------------------------
// LER
// ---------------------------------------------------------------------
async function getTimeline({ days = 30, category = null, kind = null, source = null, limit = 100 } = {}) {
  const where = {};
  if (days && days > 0) where.createdAt = { gte: new Date(Date.now() - days * 86400000) };
  if (category) where.category = category;
  if (kind) where.kind = kind;
  if (source) where.source = source;
  const items = await prisma.companyMemory.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500),
  });
  return items;
}

async function getStats() {
  const [total, byKind, byCategory, facts, oldest, newest] = await Promise.all([
    prisma.companyMemory.count(),
    prisma.companyMemory.groupBy({ by: ['kind'], _count: { _all: true } }),
    prisma.companyMemory.groupBy({ by: ['category'], _count: { _all: true } }),
    prisma.companyMemory.count({ where: { kind: 'fact' } }),
    prisma.companyMemory.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.companyMemory.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  const kindMap = byKind.reduce((m, r) => { m[r.kind] = r._count._all; return m; }, {});
  const catList = byCategory.map((r) => ({ category: r.category, count: r._count._all })).sort((a, b) => b.count - a.count);
  return {
    total,
    facts,
    events: kindMap.event || 0,
    byCategory: catList,
    since: oldest ? oldest.createdAt : null,
    last: newest ? newest.createdAt : null,
  };
}

// O CÉREBRO: o que a IA carrega antes de pensar.
// = todos os fatos fixados (o que a empresa É) + eventos recentes mais
// importantes (o que aconteceu). Devolve texto pronto pra prompt + estruturado.
async function getBrain({ maxEvents = 40, eventDays = 14 } = {}) {
  const [facts, events] = await Promise.all([
    prisma.companyMemory.findMany({
      where: { kind: 'fact' },
      orderBy: [{ pinned: 'desc' }, { importance: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    }),
    prisma.companyMemory.findMany({
      where: { kind: 'event', createdAt: { gte: new Date(Date.now() - eventDays * 86400000) } },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(parseInt(maxEvents, 10) || 40, 1), 200),
    }),
  ]);

  const fmt = (r) => {
    const when = new Date(r.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
    const base = `- [${r.category}] ${r.title}${r.detail ? ': ' + r.detail : ''}`;
    return r.kind === 'event' ? `${base} (${when})` : base;
  };

  const factsText = facts.length ? facts.map(fmt).join('\n') : '(nenhum fato cadastrado ainda)';
  const eventsText = events.length ? events.map(fmt).join('\n') : '(nenhum evento recente)';

  const promptText = [
    '### MEMÓRIA DA EMPRESA — O QUE A EMPRESA É',
    factsText,
    '',
    `### LINHA DO TEMPO — O QUE ACONTECEU (últimos ${eventDays} dias)`,
    eventsText,
  ].join('\n');

  return { promptText, facts, events, factCount: facts.length, eventCount: events.length };
}

async function deleteMemory(id) {
  try {
    await prisma.companyMemory.delete({ where: { id } });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  recordEvent,
  addFact,
  recordNote,
  getTimeline,
  getStats,
  getBrain,
  deleteMemory,
};
