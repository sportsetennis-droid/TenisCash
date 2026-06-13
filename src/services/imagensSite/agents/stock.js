// =====================================================================
// Agente ESTOQUE + SELEÇÃO — escolhe o melhor produto BIPADO por slot.
// Regra dura do dono: SÓ produto BIPADO com estoque (Σ StoreStock > 0).
// NÃO usa o "comprado" (ProductSize.stock) como elegibilidade.
// Ranqueia por unidades bipadas; nenhum produto se repete entre os 22.
// =====================================================================
const GENDER_SYNONYMS = {
  feminino: ['Feminino', 'Mulher', 'Menina', 'Inf. F', 'Infantil Feminino', 'Fem', 'feminino'],
  masculino: ['Masculino', 'Homem', 'Menino', 'Inf. M', 'Infantil Masculino', 'Masc', 'masculino'],
};

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function parseCtx(aiContext) {
  try { return typeof aiContext === 'string' ? JSON.parse(aiContext) : (aiContext || {}); } catch { return {}; }
}

// Σ StoreStock (LOCALIZADO/bipado = verdade). Estrito: sem fallback ao comprado.
function bipado(sizes) {
  let total = 0; const arr = [];
  for (const s of (sizes || [])) {
    const q = (s.storeStocks || []).reduce((a, x) => a + (x.stock || 0), 0);
    if (q > 0) { total += q; arr.push({ size: s.size, stock: q }); }
  }
  return { total, sizes: arr };
}

async function poolForGender(prisma, gender) {
  const syn = GENDER_SYNONYMS[gender] || [];
  const ors = syn.map((v) => ({ aiContext: { path: ['classification', 'gender'], equals: v } }));
  ors.push({ subcategory: { contains: gender === 'feminino' ? 'emin' : 'asculin', mode: 'insensitive' } });

  const products = await prisma.product.findMany({
    where: {
      active: true,
      OR: ors,
      // SÓ BIPADO: pelo menos um tamanho com StoreStock > 0
      sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } },
    },
    take: 1200,
    select: {
      id: true, sku: true, name: true, brand: true, category: true, subcategory: true,
      imageUrl: true, price: true, promoPrice: true, aiContext: true,
      sizes: { select: { size: true, storeStocks: { select: { stock: true } } } },
    },
  });

  return products.map((p) => {
    const b = bipado(p.sizes);
    const ctx = parseCtx(p.aiContext);
    const cls = ctx.classification || {};
    return {
      id: p.id, sku: p.sku, name: p.name, brand: p.brand,
      category: p.category, subcategory: p.subcategory, color: ctx.color || null,
      imageUrl: p.imageUrl, price: p.price, promoPrice: p.promoPrice,
      type: cls.type || null, modality: cls.modality || null,
      bipado: b.total, sizes: b.sizes,
    };
  }).filter((p) => p.bipado > 0).sort((a, b) => b.bipado - a.bipado);
}

function isTenis(p) {
  return norm(p.type) === 'tenis' || norm(p.category).includes('tenis') || norm(p.category).includes('calc');
}
function matchesFilter(p, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (filter.type === 'Tênis' && !isTenis(p)) return false;
  if (filter.modality) {
    const pm = norm(p.modality);
    if (!pm || !filter.modality.map(norm).some((m) => pm.includes(m) || m.includes(pm))) return false;
  }
  if (filter.category) {
    const c = norm(filter.category);
    if (!(norm(p.category).includes(c) || norm(p.subcategory).includes(c))) return false;
  }
  return true;
}

function slotBrief(s) {
  return { gender: s.gender, section: s.section, label: s.label, dims: s.dims, file: s.file, category: s.category };
}

async function run({ prisma, emit, slots }) {
  emit({ phase: 'estoque', agent: 'estoque', level: 'info', msg: 'Lendo estoque BIPADO (StoreStock>0) por gênero…' });

  const pools = {};
  for (const g of ['feminino', 'masculino']) {
    if (!slots.some((s) => s.gender === g)) continue;
    pools[g] = await poolForGender(prisma, g);
    emit({ phase: 'estoque', agent: 'estoque', level: 'info', msg: `${g}: ${pools[g].length} produtos bipados elegíveis.` });
  }

  const used = new Set();
  const plan = [];
  for (const s of slots) {
    const pool = pools[s.gender] || [];
    let how = 'match';
    let pick = pool.find((p) => !used.has(p.id) && matchesFilter(p, s.filter));
    if (!pick) { pick = pool.find((p) => !used.has(p.id)); how = 'fallback'; }

    if (!pick) {
      emit({ phase: 'estoque', agent: 'estoque', level: 'warn', slot: s.id, msg: `slot ${s.id} ${s.label} (${s.gender}): sem produto bipado disponível.` });
      plan.push({ slot: s.id, ...slotBrief(s), how: 'vazio', product: null });
      continue;
    }
    used.add(pick.id);
    plan.push({ slot: s.id, ...slotBrief(s), how, product: pick });
    emit({
      phase: 'estoque', agent: 'estoque', level: how === 'match' ? 'ok' : 'warn', slot: s.id,
      msg: `slot ${s.id} ${s.label} (${s.gender}) ${how === 'match' ? '→' : '≈ fallback'} ${(pick.brand || '').trim()} ${pick.name} · ${pick.bipado} un bipadas`,
      data: { productId: pick.id, sku: pick.sku, img: pick.imageUrl, bipado: pick.bipado },
    });
  }

  const filled = plan.filter((x) => x.product).length;
  emit({
    phase: 'estoque', agent: 'estoque', level: filled === slots.length ? 'ok' : 'warn',
    msg: `Plano montado: ${filled}/${slots.length} slots preenchidos.`,
  });
  return plan;
}

module.exports = { run, poolForGender, matchesFilter };
