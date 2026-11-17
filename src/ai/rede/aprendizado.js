// =====================================================================
// RNA — APRENDIZADO (docs §7). Toda mudança de peso/limiar é auditada.
//  - aoDecidir: decisão do dono numa proposta ajusta as sinapses do caminho
//    (sensor → … → neurônio que propôs) e o limiar de quem propôs.
//  - aoResultado: KPI medido do objetivo reforça/enfraquece o que contribuiu.
//  - candidatosPoda: neurônios que só erram ou não servem (dono confirma).
// =====================================================================
const { prisma } = require('../../middleware');
const motor = require('./motor');

const PISO = 0.05, TETO = 0.95;
const RECOMPENSA = { approved: 0.05, executed: 0.05, correction_requested: 0.01, rejected: -0.08 };
const clamp = (x, a = PISO, b = TETO) => Math.max(a, Math.min(b, x));

async function ajustarSinapse(origem, destino, delta, ctx, db) {
  const atual = await db.rnaSinapse.findUnique({ where: { origem_destino: { origem, destino } } });
  const de = atual ? atual.peso : 0.5;
  const para = Number(clamp(de + delta).toFixed(4));
  if (para === de) return null;
  await db.rnaSinapse.upsert({ where: { origem_destino: { origem, destino } }, update: { peso: para }, create: { origem, destino, peso: para } });
  await db.rnaAjustePeso.create({ data: { alvo: `sinapse:${origem}->${destino}`, de, para, motivo: ctx.motivo, traceId: ctx.traceId || null, aprovacaoId: ctx.aprovacaoId || null } });
  return { origem, destino, de, para };
}

async function ajustarLimiar(id, delta, ctx, db) {
  const n = await db.rnaNeuronio.findUnique({ where: { id } });
  if (!n) return null;
  const para = Number(clamp(n.limiar + delta, 0, 0.95).toFixed(4));
  if (para === n.limiar) return null;
  await db.rnaNeuronio.update({ where: { id }, data: { limiar: para } });
  await db.rnaAjustePeso.create({ data: { alvo: `limiar:${id}`, de: n.limiar, para, motivo: ctx.motivo, traceId: ctx.traceId || null, aprovacaoId: ctx.aprovacaoId || null } });
  return { id, de: n.limiar, para };
}

// Chamado quando o dono decide uma aprovação vinda da rede (payload.rna).
async function aoDecidir(aprovacao, db = prisma) {
  const rna = aprovacao && aprovacao.payload && aprovacao.payload.rna;
  if (!rna || !Array.isArray(rna.caminho) || rna.caminho.length < 2) return { ajustes: [] };
  const motivo = { approved: 'aprovado', executed: 'aprovado', rejected: 'rejeitado', correction_requested: 'editado' }[aprovacao.status];
  const r = RECOMPENSA[aprovacao.status];
  if (r == null) return { ajustes: [] };
  const ctx = { motivo, traceId: rna.traceId, aprovacaoId: aprovacao.id };
  const ajustes = [];
  for (let i = 0; i < rna.caminho.length - 1; i++) {
    const a = await ajustarSinapse(rna.caminho[i], rna.caminho[i + 1], r, ctx, db);
    if (a) ajustes.push(a);
  }
  const quem = rna.neuronio;
  if (motivo === 'rejeitado') { const l = await ajustarLimiar(quem, +0.03, ctx, db); if (l) ajustes.push(l); }
  if (motivo === 'aprovado') { const l = await ajustarLimiar(quem, -0.01, ctx, db); if (l) ajustes.push(l); }
  const campo = motivo === 'rejeitado' ? 'erros' : motivo === 'aprovado' ? 'acertos' : null;
  if (campo) await db.rnaNeuronio.update({ where: { id: quem }, data: { [campo]: { increment: 1 } } }).catch(() => {});
  motor.invalidarCaches();
  return { ajustes };
}

// recompensa ∈ [-1, 1] calculada por resultado.medir (KPI × meta).
async function aoResultado(objetivoId, recompensa, db = prisma) {
  const r = Math.max(-1, Math.min(1, Number(recompensa) || 0));
  if (!r) return { ajustes: [] };
  const aprovadas = await db.aIApproval.findMany({ where: { status: { in: ['approved', 'executed'] }, type: { not: 'rna_aprendizado_kpi' }, payload: { path: ['rna', 'objetivoId'], equals: objetivoId } }, take: 500 });
  const ajustes = [];
  for (const ap of aprovadas) {
    const c = ap.payload.rna.caminho || [];
    for (let i = 0; i < c.length - 1; i++) {
      const a = await ajustarSinapse(c[i], c[i + 1], 0.1 * r, { motivo: 'kpi', traceId: ap.payload.rna.traceId, aprovacaoId: ap.id }, db);
      if (a) ajustes.push(a);
    }
  }
  motor.invalidarCaches();
  return { ajustes };
}

// Neurônios que não servem: muito disparo e nenhum acerto, ou parados há 60 dias.
async function candidatosPoda(db = prisma) {
  const lista = await db.rnaNeuronio.findMany({ where: { ativo: true } });
  const limite = Date.now() - 60 * 24 * 3600 * 1000;
  return lista.filter((n) => (n.erros >= 5 && n.acertos === 0) || (n.ultimoUso && n.ultimoUso.getTime() < limite) || (n.disparos >= 200 && n.acertos === 0 && n.camada !== 'detector'))
    .map((n) => ({ id: n.id, motivo: n.erros >= 5 && n.acertos === 0 ? `${n.erros} propostas rejeitadas e nenhuma aprovada` : n.ultimoUso && n.ultimoUso.getTime() < limite ? 'sem uso há 60 dias' : 'muito disparo de IA sem resultado aprovado' }));
}

module.exports = { aoDecidir, aoResultado, candidatosPoda, RECOMPENSA };
