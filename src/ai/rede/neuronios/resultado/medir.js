// resultado.medir — detector (regra, custo zero)
// Mede os KPIs de um objetivo contra a base e emite `resultado.kpi`
// { objetivoId, recompensa ∈ [-1,1], final, detalhe } — é o sinal que treina a rede.
//   - objetivo.prazo-final → medição FINAL do objetivo (final=true)
//   - relogio.semanal      → medição PARCIAL de cada objetivo ativo no prazo
// KPIs mensuráveis automaticamente (dado real do banco, mesma fórmula nas
// duas janelas):
//   venda  = Σ SaleItem.totalPrice (vendas válidas)
//   margem = (Σ totalPrice − Σ unitCost×qtd) / Σ totalPrice (só itens com custo gravado)
//   giro   = unidades vendidas / estoque físico atual (Σ StoreStock>0) — o
//            mesmo denominador nas duas janelas
// Janela ATUAL = criação do objetivo → agora (ou prazo); BASE = janela de
// mesmo tamanho imediatamente antes. Escopo: loja (Store.code) e marca do KPI.
// O que não dá pra medir assim vira `dado-faltante` (nunca chuta).

const DIA = 24 * 3600 * 1000;
const OFFSET_MS = 3 * 3600 * 1000;
const VENDA_INVALIDA = ['canceled', 'cancelled', 'cancelada', 'refunded', 'estornada', 'pending', 'pendente'];
const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
const ymd = (d) => new Date(d.getTime() - OFFSET_MS).toISOString().slice(0, 10);
const clamp = (x) => Math.max(-1, Math.min(1, x));

function tipoKpi(nome) {
  const n = sem(nome);
  if (/giro|sell.?through/.test(n)) return 'giro';
  if (/margem/.test(n)) return 'margem';
  if (/venda|faturamento|receita/.test(n)) return 'venda';
  return null;
}

// '+20%' → 0.2 ; '-10%' → -0.1 ; '20' → 0.2 ; sem meta → null
function alvoRelativo(meta) {
  if (meta == null) return null;
  if (typeof meta === 'number') return Math.abs(meta) > 1 ? meta / 100 : meta;
  const m = String(meta).replace(',', '.').match(/([+-]?\d+(?:\.\d+)?)\s*(%)?/);
  if (!m) return null;
  const v = Number(m[1]);
  return m[2] || Math.abs(v) > 1 ? v / 100 : v;
}

function escopo(kpi, obj) {
  const filtro = String(kpi.filtro || '');
  const loja = kpi.loja || (filtro.match(/\bLOJA\d{2}\b/i) || [])[0] || obj.loja || null;
  const marcaF = filtro.match(/marca\s*[:=]\s*([^,;]+)/i);
  const marca = kpi.marca || (marcaF ? marcaF[1].trim() : null);
  return { loja: loja ? String(loja).toUpperCase() : null, marca: marca ? String(marca) : null };
}

async function itensVendidos(ler, de, ate, storeId, marca) {
  return ler.saleItem.findMany({
    where: {
      sale: { createdAt: { gte: de, lt: ate }, status: { notIn: VENDA_INVALIDA }, ...(storeId ? { storeId } : {}) },
      ...(marca ? { brand: { equals: marca, mode: 'insensitive' } } : {}),
    },
    select: { quantity: true, totalPrice: true, unitCost: true },
  });
}

function metrica(tipo, itens, estoque) {
  if (tipo === 'venda') return { valor: itens.reduce((a, i) => a + i.totalPrice, 0), n: itens.length };
  if (tipo === 'giro') {
    if (!(estoque > 0)) return { valor: null, n: itens.length };
    return { valor: itens.reduce((a, i) => a + i.quantity, 0) / estoque, n: itens.length };
  }
  const comCusto = itens.filter((i) => i.unitCost != null);
  const receita = comCusto.reduce((a, i) => a + i.totalPrice, 0);
  if (!(receita > 0)) return { valor: null, n: comCusto.length, cobertura: itens.length ? comCusto.length / itens.length : 0 };
  const custo = comCusto.reduce((a, i) => a + i.unitCost * i.quantity, 0);
  return { valor: (receita - custo) / receita, n: comCusto.length, cobertura: comCusto.length / itens.length };
}

async function medirObjetivo(ler, obj, agora, final) {
  const kpis = Array.isArray(obj.kpis) ? obj.kpis : [];
  const ini = new Date(obj.criadoEm);
  const fim = new Date(Math.min(agora.getTime(), obj.prazo ? new Date(obj.prazo).getTime() : agora.getTime()));
  const dur = fim.getTime() - ini.getTime();
  const baseIni = new Date(ini.getTime() - dur);
  const medidos = [], faltam = [];
  if (dur < DIA) {
    for (const k of kpis) faltam.push({ kpi: k.nome || null, motivo: 'objetivo com menos de 1 dia: janela curta demais para medir' });
    return { medidos, faltam };
  }
  const lojas = await ler.store.findMany({ select: { id: true, code: true } });
  const idLoja = new Map(lojas.map((l) => [l.code.toUpperCase(), l.id]));
  for (const k of kpis) {
    const tipo = tipoKpi(k && k.nome);
    if (!tipo) { faltam.push({ kpi: (k && k.nome) || null, motivo: 'tipo de KPI sem medição automática (só venda, margem e giro)' }); continue; }
    const esc = escopo(k, obj);
    const storeId = esc.loja ? idLoja.get(esc.loja) : null;
    if (esc.loja && !storeId) { faltam.push({ kpi: k.nome, motivo: `loja ${esc.loja} não existe na tabela Store` }); continue; }
    let estoque = null;
    if (tipo === 'giro') {
      const e = await ler.storeStock.aggregate({ _sum: { stock: true }, where: { stock: { gt: 0 }, ...(storeId ? { storeId } : {}), ...(esc.marca ? { productSize: { product: { brand: { equals: esc.marca, mode: 'insensitive' } } } } : {}) } });
      estoque = (e._sum && e._sum.stock) || 0;
    }
    const atual = metrica(tipo, await itensVendidos(ler, ini, fim, storeId, esc.marca), estoque);
    const base = metrica(tipo, await itensVendidos(ler, baseIni, ini, storeId, esc.marca), estoque);
    if (atual.valor == null || base.valor == null) {
      faltam.push({ kpi: k.nome, motivo: tipo === 'giro' ? 'sem estoque físico no escopo (StoreStock) para calcular giro' : tipo === 'margem' ? 'sem venda com custo gravado (SaleItem.unitCost) em uma das janelas' : 'sem dado' });
      continue;
    }
    const minimo = k.min != null ? (Number(k.min) > 1 ? Number(k.min) / 100 : Number(k.min)) : null;
    const alvo = alvoRelativo(k.meta);
    let melhoria;
    if (base.valor === 0) melhoria = atual.valor > 0 ? 1 : 0;
    else melhoria = (atual.valor - base.valor) / Math.abs(base.valor);
    let r = null;
    if (alvo) r = clamp(melhoria / alvo);
    else if (minimo == null) r = clamp(melhoria);
    const violouMinimo = minimo != null && atual.valor < minimo;
    medidos.push({
      kpi: k.nome, tipo, escopo: esc,
      janela: { atual: [ymd(ini), ymd(fim)], base: [ymd(baseIni), ymd(ini)] },
      atual: r4(atual.valor), base: r4(base.valor), itens: { atual: atual.n, base: base.n },
      ...(tipo === 'margem' ? { coberturaCusto: { atual: r4(atual.cobertura), base: r4(base.cobertura) } } : {}),
      ...(tipo === 'giro' ? { estoqueFisicoAtual: estoque } : {}),
      melhoria: r4(melhoria), meta: k.meta != null ? k.meta : null, minimo, violouMinimo, recompensa: r == null ? null : r4(r),
      baseDeclarada: k.base != null ? k.base : null,
      fonte: `SaleItem/Sale (status válido)${tipo === 'giro' ? ' + StoreStock' : ''}${esc.loja ? ' loja ' + esc.loja : ''}${esc.marca ? ' marca ' + esc.marca : ''}`,
    });
  }
  return { medidos, faltam };
}

function recompensaFinal(medidos) {
  const rs = medidos.map((m) => m.recompensa).filter((x) => x != null);
  let r = rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : 0;
  if (medidos.some((m) => m.violouMinimo)) r = Math.min(r, -0.5); // restrição furada pesa contra
  return r4(clamp(r));
}

function semanaKey(d) {
  const l = new Date(d.getTime() - OFFSET_MS);
  const t = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const ano = t.getUTCFullYear();
  const sem1 = Math.ceil(((t - Date.UTC(ano, 0, 1)) / DIA + 1) / 7);
  return `${ano}-S${String(sem1).padStart(2, '0')}`;
}

module.exports = {
  id: 'resultado.medir',
  camada: 'detector',
  missao: 'Medir o KPI de cada objetivo contra a base e emitir o resultado que treina a rede.',
  escuta: ['objetivo.prazo-final', 'relogio.semanal'],
  emite: ['resultado.kpi'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['dados-reais', 'nunca-inventar', 'timezone-fortaleza'],
  tempoMax: 60000,
  async disparar({ sinal, ler, agora, objetivo }) {
    const final = sinal.tipo === 'objetivo.prazo-final';
    let objs;
    if (final) {
      const id = (sinal.dados && sinal.dados.objetivoId) || sinal.objetivoId;
      const o = objetivo && objetivo.id === id ? objetivo : (id ? await ler.rnaObjetivo.findUnique({ where: { id } }) : null);
      objs = o && o.status === 'ativo' ? [o] : [];
    } else {
      objs = (await ler.rnaObjetivo.findMany({ where: { status: 'ativo' }, take: 50 }))
        .filter((o) => !o.prazo || new Date(o.prazo).getTime() >= agora.getTime()); // vencido: medido no prazo-final
    }
    const quando = final ? 'final' : semanaKey(agora);
    const saidas = [];
    for (const o of objs) {
      const { medidos, faltam } = await medirObjetivo(ler, o, agora, final);
      if (medidos.length) {
        saidas.push({
          tipo: 'resultado.kpi', forca: 1, objetivoId: o.id,
          dados: { objetivoId: o.id, objetivo: o.texto, recompensa: recompensaFinal(medidos), final, quando, detalhe: { kpis: medidos, naoMensuraveis: faltam }, chave: `kpi:${o.id}:${quando}` },
        });
      }
      if (faltam.length) {
        saidas.push({
          tipo: 'dado-faltante', forca: 0.6, objetivoId: o.id,
          dados: { objetivoId: o.id, objetivo: o.texto, motivo: 'KPI não mensurável automaticamente', kpis: faltam, final, chave: `kpi-faltante:${o.id}:${quando}` },
        });
      }
    }
    return saidas;
  },
};
