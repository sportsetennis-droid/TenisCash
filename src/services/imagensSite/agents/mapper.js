// =====================================================================
// Agente MAPEADOR — lê e MEMORIZA os 22 slots (tamanhos, locais, destinos).
// Não toca no site; só registra o mapa no Config pra os outros agentes.
// =====================================================================
const { SLOTS } = require('../slots');

const CFG_KEY = 'imagens_site_slots_v1';

async function run({ prisma, emit }) {
  emit({ phase: 'mapear', agent: 'mapeador', level: 'info', msg: 'Lendo o mapa de imagens da home (tema Morelia)…' });

  const byGender = { feminino: 0, masculino: 0 };
  for (const s of SLOTS) {
    byGender[s.gender] = (byGender[s.gender] || 0) + 1;
    emit({
      phase: 'mapear', agent: 'mapeador', level: 'info', slot: s.id,
      msg: `slot ${s.id} · ${s.gender}/${s.section} · ${s.label} · ${s.width}×${s.height} → ${s.file}`,
      data: { gender: s.gender, section: s.section, dims: s.dims, file: s.file, category: s.category },
    });
  }

  // memoriza no Config (idempotente)
  const payload = JSON.stringify({ slots: SLOTS, updatedAt: new Date().toISOString() });
  try {
    await prisma.config.upsert({
      where: { key: CFG_KEY },
      update: { value: payload },
      create: { id: CFG_KEY, key: CFG_KEY, value: payload },
    });
    emit({
      phase: 'mapear', agent: 'mapeador', level: 'ok',
      msg: `Mapa memorizado: ${SLOTS.length} slots (fem ${byGender.feminino} · masc ${byGender.masculino}).`,
    });
  } catch (e) {
    emit({ phase: 'mapear', agent: 'mapeador', level: 'warn', msg: `Não persistiu no Config (${e.message}); seguindo em memória.` });
  }

  return SLOTS;
}

module.exports = { run, CFG_KEY };
