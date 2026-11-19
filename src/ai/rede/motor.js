// =====================================================================
// RNA — MOTOR DE ATIVAÇÃO (docs/REDE-NEURAL-DE-AGENTES.md §5)
// Um sinal entra → acha quem escuta → calcula ativação (força × peso +
// atenção do objetivo + impacto R$) → acende quem passa do limiar, em
// ONDAS POR CUSTO (regra → IA barata → IA forte). Saídas viram novos
// sinais; `proposta.*` vira aprovação do dono e para ali.
// Travas: orçamento (dia e objetivo), profundidade 8, anti-ciclo,
// idempotência (neurônio+sinal), tempo máximo, política de segurança.
// =====================================================================
const { prisma } = require('../../middleware');
const registro = require('./registro');
const seg = require('./seguranca');
const ferramentas = require('./ferramentas');
const ia = require('./ia');

const PROF_MAX = 8;
const ORDEM = { regra: 0, 'ia-barata': 1, 'ia-forte': 2 };
const LIMITE_CONCORRENCIA = { regra: 20, 'ia-barata': 4, 'ia-forte': 1 };

const estado = {
  db: prisma,
  neuronios: new Map(),
  indice: new Map(),
  errosRegistro: [],
  cacheNeuronio: new Map(), // id → { ativo, limiar, t }
  cachePeso: new Map(),     // 'a->b' → { peso, t }
  cacheObjetivo: new Map(), // id → { obj, t }
  vistos: new Map(),        // traceId → Set('neuronio|tipo')
  emCurso: { regra: 0, 'ia-barata': 0, 'ia-forte': 0 },
  filas: { regra: [], 'ia-barata': [], 'ia-forte': [] },
  pendentes: 0,
  ouvintes: new Set(),      // para testes/painel ao vivo
};
const TTL = 60 * 1000;
const agoraMs = () => Date.now();
const novoId = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const ativa = () => process.env.RNA_ATIVA !== '0';

function iniciar({ db, neuronios } = {}) {
  if (db) estado.db = db;
  if (neuronios) {
    estado.neuronios = neuronios;
    estado.indice = registro.indexar(neuronios);
    estado.errosRegistro = [];
  } else {
    const r = registro.carregar();
    estado.neuronios = r.neuronios; estado.indice = r.indice; estado.errosRegistro = r.erros;
    if (r.erros.length) console.error('[RNA] neurônios com erro de contrato:', r.erros);
  }
  estado.cacheNeuronio.clear(); estado.cachePeso.clear(); estado.cacheObjetivo.clear();
  return { neuronios: estado.neuronios.size, erros: estado.errosRegistro };
}

// Garante uma linha por neurônio no banco (limiar inicial do código).
async function sincronizar() {
  for (const n of estado.neuronios.values()) {
    await estado.db.rnaNeuronio.upsert({ where: { id: n.id }, update: { camada: n.camada }, create: { id: n.id, camada: n.camada, limiar: n.limiar || 0 } });
  }
}

async function estadoNeuronio(id) {
  const c = estado.cacheNeuronio.get(id);
  if (c && agoraMs() - c.t < TTL) return c;
  const row = await estado.db.rnaNeuronio.findUnique({ where: { id } }).catch(() => null);
  const n = estado.neuronios.get(id);
  const v = { ativo: row ? row.ativo : true, limiar: row ? row.limiar : (n && n.limiar) || 0, t: agoraMs() };
  estado.cacheNeuronio.set(id, v);
  return v;
}
async function peso(origem, destino) {
  const k = origem + '->' + destino;
  const c = estado.cachePeso.get(k);
  if (c && agoraMs() - c.t < TTL) return c.peso;
  const row = await estado.db.rnaSinapse.findUnique({ where: { origem_destino: { origem, destino } } }).catch(() => null);
  const p = row ? row.peso : 0.5;
  estado.cachePeso.set(k, { peso: p, t: agoraMs() });
  return p;
}
async function objetivo(id) {
  if (!id) return null;
  const c = estado.cacheObjetivo.get(id);
  if (c && agoraMs() - c.t < TTL) return c.obj;
  const obj = await estado.db.rnaObjetivo.findUnique({ where: { id } }).catch(() => null);
  estado.cacheObjetivo.set(id, { obj, t: agoraMs() });
  return obj;
}
function casaRegiao(regiao, id) {
  return (regiao || []).some((r) => r === id || (r.endsWith('*') && id.startsWith(r.slice(0, -1))));
}

// ---------------- orçamento ----------------
function inicioDiaFortaleza() {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // UTC-3 fixo
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 0, 0));
}
async function gastoHoje() {
  const r = await estado.db.rnaAtivacao.aggregate({ _sum: { custoRS: true }, where: { criadoEm: { gte: inicioDiaFortaleza() } } }).catch(() => null);
  return (r && r._sum && r._sum.custoRS) || 0;
}
async function cabeNoOrcamento(n, obj) {
  if (n.custo.tipo === 'regra') return { ok: true };
  const tetoDia = Number(process.env.RNA_ORCAMENTO_DIA_RS || 5);
  if ((await gastoHoje()) >= tetoDia) return { ok: false, motivo: 'teto diário de IA atingido (R$ ' + tetoDia + ')' };
  if (obj && obj.orcamento) {
    const o = obj.orcamento;
    if (o.rs != null && obj.gastoRS >= Number(o.rs)) return { ok: false, motivo: 'orçamento do objetivo esgotado' };
    if (o.ativacoesIA != null && obj.ativacoes >= Number(o.ativacoesIA)) return { ok: false, motivo: 'limite de ativações do objetivo' };
  }
  return { ok: true };
}

// ---------------- sinais ----------------
function normalizar(s, pai) {
  const forca = Math.max(0, Math.min(1, Number(s.forca == null ? 1 : s.forca)));
  return {
    id: novoId('sig'),
    tipo: String(s.tipo),
    origem: String(s.origem || (pai ? pai.neuronio : 'externo')),
    forca,
    impactoRS: s.impactoRS != null ? Number(s.impactoRS) : (pai && pai.sinal.impactoRS) || null,
    loja: s.loja || (pai && pai.sinal.loja) || null,
    objetivoId: s.objetivoId || (pai && pai.sinal.objetivoId) || null,
    traceId: (pai && pai.sinal.traceId) || s.traceId || novoId('tr'),
    profundidade: pai ? pai.sinal.profundidade + 1 : 0,
    externo: !!(s.externo || (pai && pai.sinal.externo)),
    incerto: !!s.incerto,
    resolve: !!s.resolve,
    dados: s.dados || {},
    caminho: pai ? pai.sinal.caminho.concat(pai.neuronio) : [String(s.origem || 'externo')],
  };
}

// Ponto de entrada: sensores e neurônios emitem aqui. Nunca lança erro pra quem chamou.
async function emitir(s, pai = null) {
  if (!ativa()) return null;
  let sinal;
  try {
    sinal = normalizar(s, pai);
    if (sinal.profundidade > PROF_MAX) return null;
    if (sinal.externo) {
      const inj = seg.injecao(JSON.stringify(sinal.dados));
      if (inj.suspeito) sinal.dados = Object.assign({}, sinal.dados, { _alertaInjecao: inj.padroes });
    }
    await estado.db.rnaSinal.create({ data: {
      id: sinal.id, tipo: sinal.tipo, origem: sinal.origem, forca: sinal.forca, impactoRS: sinal.impactoRS, loja: sinal.loja,
      objetivoId: sinal.objetivoId, traceId: sinal.traceId, profundidade: sinal.profundidade, externo: sinal.externo,
      dados: Object.assign({}, seg.mascararPII(sinal.dados), { _caminho: sinal.caminho }),
    } });
    notificar({ evento: 'sinal', sinal });
    estado.pendentes++;
    processar(sinal).catch((e) => console.error('[RNA] processar', sinal.tipo, e.message)).finally(() => { estado.pendentes--; notificar({ evento: 'ocioso?' }); });
    return sinal;
  } catch (e) {
    console.error('[RNA] emitir falhou:', e.message);
    return null;
  }
}

function visto(traceId, chave) {
  let set = estado.vistos.get(traceId);
  if (!set) {
    set = new Set(); estado.vistos.set(traceId, set);
    if (estado.vistos.size > 5000) estado.vistos.delete(estado.vistos.keys().next().value);
  }
  if (set.has(chave)) return true;
  set.add(chave); return false;
}

async function processar(sinal) {
  const ids = registro.quemEscuta(estado.indice, sinal.tipo);
  if (!ids.length) return;
  const obj = await objetivo(sinal.objetivoId);
  const candidatos = [];
  for (const id of ids) {
    const n = estado.neuronios.get(id);
    if (!n) continue;
    if (sinal.externo && n.permissao === 'agir') continue;      // conteúdo externo nunca aciona quem age
    if (sinal.caminho.includes(id)) continue;                    // não volta pra quem já passou (anti-ciclo)
    const st = await estadoNeuronio(id);
    if (!st.ativo) continue;
    const p = await peso(sinal.origem, id);
    const atencao = obj && obj.status === 'ativo' && casaRegiao(obj.regiao, id) ? 0.25 : 0;
    const impacto = sinal.impactoRS ? Math.min(0.3, Math.log10(1 + Math.max(0, sinal.impactoRS)) / 10) : 0;
    const ativacao = sinal.forca * (0.5 + p) + atencao + impacto;
    if (ativacao < st.limiar) continue;
    candidatos.push({ n, ativacao });
  }
  // ONDAS por custo: regra → ia-barata → ia-forte
  candidatos.sort((a, b) => ORDEM[a.n.custo.tipo] - ORDEM[b.n.custo.tipo]);
  const ondas = [0, 1, 2].map((o) => candidatos.filter((c) => ORDEM[c.n.custo.tipo] === o));
  // "resolve" só cala a IA do MESMO domínio de quem resolveu (outro domínio segue o seu caminho)
  const resolvidos = new Set();
  const dominio = (id) => id.split('.')[0];
  for (const [o, onda] of ondas.entries()) {
    let elegiveis = o >= 1 ? onda.filter((c) => !resolvidos.has(dominio(c.n.id))) : onda;
    if (o === 2) elegiveis = elegiveis.filter((c) => precisaForte(sinal, c.n, obj));
    if (!elegiveis.length) continue;
    const saidas = await Promise.all(elegiveis.map((c) => executar(c.n, sinal, c.ativacao, obj)));
    saidas.forEach((r, i) => { if (r && r.resolve) resolvidos.add(dominio(elegiveis[i].n.id)); });
  }
}

// IA forte só quando vale: impacto alto, caso incerto, pedido do dono, ou objetivo ATIVO
// do dono cuja região inclui este neurônio (o objetivo tem orçamento próprio que limita o gasto).
function precisaForte(sinal, n, obj) {
  const min = Number(process.env.RNA_IMPACTO_FORTE_RS || 500);
  if ((sinal.impactoRS || 0) >= min || sinal.incerto || /^s\.dono|^dono\./.test(sinal.origem) || (sinal.dados && sinal.dados.pedidoDono)) return true;
  return !!(n && obj && obj.status === 'ativo' && obj.orcamento && casaRegiao(obj.regiao, n.id));
}

function slot(tipo) {
  return new Promise((resolve) => {
    const tentar = () => {
      if (estado.emCurso[tipo] < LIMITE_CONCORRENCIA[tipo]) { estado.emCurso[tipo]++; resolve(() => { estado.emCurso[tipo]--; const prox = estado.filas[tipo].shift(); if (prox) prox(); }); }
      else estado.filas[tipo].push(tentar);
    };
    tentar();
  });
}

async function executar(n, sinal, ativacao, obj) {
  const tipoCusto = n.custo.tipo;
  // idempotência: o mesmo neurônio nunca processa o mesmo sinal duas vezes
  const ja = await estado.db.rnaAtivacao.findUnique({ where: { neuronio_sinalId: { neuronio: n.id, sinalId: sinal.id } } }).catch(() => null);
  if (ja) return null;
  // ia-forte é barrada antes; ia-barata só quando de fato chamar a IA (resolver por regra é de graça)
  const orc = tipoCusto === 'ia-forte' ? await cabeNoOrcamento(n, obj) : { ok: true };
  if (!orc.ok) {
    await registrar(n, sinal, { status: 'sem-orcamento', ativacao, erro: orc.motivo });
    return null;
  }
  const liberar = await slot(tipoCusto);
  const t0 = agoraMs();
  let custoRS = 0;
  let semOrcamento = null;
  try {
    const ctx = {
      sinal: Object.freeze({ ...sinal, dados: sinal.dados }),
      ler: ferramentas.soLeitura(estado.db),
      quadro: ferramentas.quadro(sinal.objetivoId, n.id, estado.db),
      objetivo: obj,
      agora: new Date(),
      pensar: tipoCusto === 'regra' ? null : async (args) => {
        const cabe = await cabeNoOrcamento(n, obj);
        if (!cabe.ok) { semOrcamento = cabe.motivo; return { ok: false, semOrcamento: true, motivo: cabe.motivo, custoRS: 0 }; }
        const r = await ia.pensar(Object.assign({ nivel: tipoCusto === 'ia-forte' ? 'forte' : 'barata', missao: n.missao }, args));
        custoRS += r.custoRS || 0;
        return r;
      },
    };
    const saida = await Promise.race([
      Promise.resolve(n.disparar(ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado (' + n.tempoMax + 'ms)')), n.tempoMax)),
    ]);
    const lista = Array.isArray(saida) ? saida.filter(Boolean) : saida ? [saida] : [];
    const pol = seg.politica(n, lista);
    const resultado = { status: lista.length ? (pol.bloqueios.length && !pol.sinais.length ? 'bloqueado' : 'ok') : (semOrcamento ? 'sem-orcamento' : 'sem-saida'), erro: semOrcamento || undefined, ativacao, custoRS, ms: agoraMs() - t0, saida: { sinais: pol.sinais.map((s) => ({ tipo: s.tipo, forca: s.forca })), bloqueios: pol.bloqueios } };
    await registrar(n, sinal, resultado);
    let resolve = false;
    for (const s of pol.sinais) {
      if (s.resolve) resolve = true;
      if (visto(sinal.traceId, n.id + '|' + s.tipo + '|' + JSON.stringify(s.dados && s.dados.chave || ''))) continue;
      if (s.tipo.startsWith('proposta.')) {
        const prop = await ferramentas.criarProposta({ neuronio: n, sinal, proposta: s, caminho: sinal.caminho.concat(n.id), db: estado.db });
        notificar({ evento: 'proposta', neuronio: n.id, proposta: prop, sinal });
      } else {
        await emitir(Object.assign({}, s, { origem: n.id }), { sinal, neuronio: n.id });
      }
    }
    return { resolve };
  } catch (e) {
    await registrar(n, sinal, { status: 'erro', ativacao, custoRS, ms: agoraMs() - t0, erro: e.message });
    return null;
  } finally {
    liberar();
  }
}

async function registrar(n, sinal, r) {
  try {
    await estado.db.rnaAtivacao.create({ data: {
      neuronio: n.id, sinalId: sinal.id, traceId: sinal.traceId, status: r.status, custoRS: r.custoRS || 0, ms: r.ms || 0,
      ativacao: r.ativacao != null ? Number(r.ativacao.toFixed(4)) : null, saida: r.saida || null, erro: r.erro ? String(r.erro).slice(0, 500) : null,
    } });
    if (r.status !== 'sem-orcamento') {
      await estado.db.rnaNeuronio.update({ where: { id: n.id }, data: { disparos: { increment: 1 }, custoRS: { increment: r.custoRS || 0 }, ultimoUso: new Date() } }).catch(() => {});
    }
    if (sinal.objetivoId && r.custoRS > 0) {
      await estado.db.rnaObjetivo.update({ where: { id: sinal.objetivoId }, data: { gastoRS: { increment: r.custoRS || 0 }, ativacoes: { increment: 1 } } }).catch(() => {});
      estado.cacheObjetivo.delete(sinal.objetivoId);
    }
    notificar({ evento: 'ativacao', neuronio: n.id, sinal, status: r.status });
  } catch (e) {
    if (!/Unique constraint/i.test(e.message)) console.error('[RNA] registrar', e.message);
  }
}

// ---------------- utilidades ----------------
function notificar(ev) { for (const f of estado.ouvintes) { try { f(ev); } catch (_) { /* */ } } }
function ouvir(f) { estado.ouvintes.add(f); return () => estado.ouvintes.delete(f); }
// Espera a rede ficar ociosa (testes / scripts).
function ocioso(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = agoraMs();
    const tick = () => {
      const ocupado = estado.pendentes > 0 || Object.values(estado.emCurso).some((v) => v > 0);
      if (!ocupado) return setTimeout(() => (estado.pendentes > 0 ? tick() : resolve()), 30);
      if (agoraMs() - t0 > timeoutMs) return reject(new Error('rede não ficou ociosa'));
      setTimeout(tick, 20);
    };
    tick();
  });
}
function invalidarCaches() { estado.cacheNeuronio.clear(); estado.cachePeso.clear(); estado.cacheObjetivo.clear(); }

module.exports = { iniciar, sincronizar, emitir, ocioso, ouvir, invalidarCaches, estado, gastoHoje, precisaForte, PROF_MAX };
