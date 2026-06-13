// =====================================================================
// Agente MAPEADOR — lê e MEMORIZA TODOS os slots de imagem do site
// (tamanhos, locais, destinos), agrupados por bloco. Não toca no site.
// =====================================================================
const { SLOTS, blockSummary } = require('../slots');

const CFG_KEY = 'imagens_site_slots_v1';

async function run({ prisma, emit }) {
  emit({ phase: 'mapear', agent: 'mapeador', level: 'info', msg: 'Lendo o mapa de TODAS as imagens do site (tema Morelia)…' });

  const blocks = blockSummary();
  for (const b of blocks) {
    const dim = b.dims ? `${b.dims[0]}×${b.dims[1]}` : 'tam. a confirmar';
    const tag = b.engine ? 'motor' : 'à parte';
    emit({
      phase: 'mapear', agent: 'mapeador', level: 'info',
      msg: `${b.label}: ${b.count} img · ${dim} · ${tag}${b.planned ? ' (planejado)' : ''}`,
      data: { block: b.block, count: b.count, engine: b.engine },
    });
  }

  const total = SLOTS.length;
  const eng = SLOTS.filter((s) => s.engine !== false).length;

  const payload = JSON.stringify({ slots: SLOTS, blocks, updatedAt: new Date().toISOString() });
  try {
    await prisma.config.upsert({
      where: { key: CFG_KEY },
      update: { value: payload },
      create: { id: CFG_KEY, key: CFG_KEY, value: payload },
    });
    emit({
      phase: 'mapear', agent: 'mapeador', level: 'ok',
      msg: `Mapa memorizado: ${total} imagens em ${blocks.length} blocos (${eng} pelo motor · ${total - eng} à parte).`,
    });
  } catch (e) {
    emit({ phase: 'mapear', agent: 'mapeador', level: 'warn', msg: `Não persistiu no Config (${e.message}); seguindo em memória.` });
  }

  return SLOTS;
}

module.exports = { run, CFG_KEY };
