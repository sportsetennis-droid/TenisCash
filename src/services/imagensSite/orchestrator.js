// =====================================================================
// Orquestrador "IMAGENS DE SITE" — roda a esteira dos 5 agentes e
// transmite cada passo via `emit` (SSE no servidor, console no CLI).
//   1) Mapeador   — memoriza os 22 slots (tamanhos/locais/destinos)
//   2) Estoque    — escolhe o melhor produto BIPADO por slot (sem repetir)
//   3) Criador    — gera os 22 nos tamanhos exatos [em construção]
//   4) Auditoria  — confere dimensão/produto/legibilidade [em construção]
//   5) Publicador — FTPS + verificação ao vivo (gated) [em construção]
// =====================================================================
const mapper = require('./agents/mapper');
const stock = require('./agents/stock');

const PLAN_KEY = 'imagens_site_plan_v1';

async function run({ prisma, emit, genders = null, options = {} }) {
  const t0 = Date.now();
  emit({ phase: 'start', agent: 'orquestrador', level: 'info', msg: 'IMAGENS DE SITE — iniciando esteira.' });

  // 1) MAPEADOR
  const slotsAll = await mapper.run({ prisma, emit });
  const slots = (genders && genders.length) ? slotsAll.filter((s) => genders.includes(s.gender)) : slotsAll;

  // 2) ESTOQUE + SELEÇÃO
  const plan = await stock.run({ prisma, emit, slots });
  const payload = JSON.stringify({ plan, genders: genders || ['feminino', 'masculino'], updatedAt: new Date().toISOString() });
  try {
    await prisma.config.upsert({
      where: { key: PLAN_KEY },
      update: { value: payload },
      create: { id: PLAN_KEY, key: PLAN_KEY, value: payload },
    });
    emit({ phase: 'estoque', agent: 'estoque', level: 'ok', msg: 'Plano salvo (imagens_site_plan_v1).' });
  } catch (e) {
    emit({ phase: 'estoque', agent: 'estoque', level: 'warn', msg: `Plano não persistido: ${e.message}` });
  }

  // 3) CRIADOR — em construção
  emit({ phase: 'criar', agent: 'criador', level: 'info', msg: 'Criador: gerar os 22 nos tamanhos exatos (foto real + fundo). [em construção]' });

  // 4) AUDITORIA — em construção
  emit({ phase: 'auditar', agent: 'auditoria', level: 'info', msg: 'Auditoria: dimensão/produto/legibilidade via visionValidator. [em construção]' });

  // 5) PUBLICADOR — em construção
  emit({ phase: 'publicar', agent: 'publicador', level: 'info', msg: 'Publicador: FTPS + verificação ao vivo, gated por "autorizado". [em construção]' });

  const filled = plan.filter((p) => p.product).length;
  emit({
    phase: 'done', agent: 'orquestrador', level: 'ok',
    msg: `Esteira concluída em ${((Date.now() - t0) / 1000).toFixed(1)}s — ${filled}/${plan.length} slots com produto.`,
    data: { filled, total: plan.length },
  });

  return { slots, plan };
}

module.exports = { run, PLAN_KEY };
