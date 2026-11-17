// =====================================================================
// RNA — OBJETIVOS (a "função objetivo" da rede, docs §6)
// O dono escreve o objetivo; a IA forte compila em KPI, região da rede,
// restrições, orçamento e prazo (o dono revisa antes de ativar).
// =====================================================================
const { prisma } = require('../../middleware');
const ia = require('./ia');
const motor = require('./motor');

const REGIOES = ['nfe.*', 'estoque.*', 'bipe.*', 'nuvem.*', 'conteudo.*', 'preco.*', 'venda.*', 'crm.*', 'mkt.*', 'fin.*', 'compra.*', 'club.*'];
const LOJAS = ['LOJA01', 'LOJA02', 'LOJA03', 'LOJA04', 'LOJA05', 'LOJA06', 'LOJA07'];

const SCHEMA = {
  type: 'object',
  properties: {
    kpis: { type: 'array', items: { type: 'object', properties: { nome: { type: 'string' }, meta: { type: 'string' }, filtro: { type: 'string' } }, required: ['nome', 'meta'] } },
    regiao: { type: 'array', items: { type: 'string', enum: REGIOES } },
    restricoes: { type: 'array', items: { type: 'string' } },
    loja: { type: ['string', 'null'] },
    prazoDias: { type: 'integer' },
    orcamentoRS: { type: 'number' },
    duvidas: { type: 'array', items: { type: 'string' } },
  },
  required: ['kpis', 'regiao', 'restricoes', 'prazoDias', 'orcamentoRS'],
};

// Compila texto → rascunho de objetivo (não ativa). Sem IA disponível, devolve rascunho mínimo.
async function compilar(texto) {
  const r = await ia.pensar({
    nivel: 'forte',
    missao: 'Transformar o objetivo de negócio escrito pelo dono em metas mensuráveis para a rede de agentes.',
    instrucao: `Regiões possíveis: ${REGIOES.join(', ')}. Lojas: ${LOJAS.join(', ')} (LOJA02 Bessa, LOJA03 Rainha da Borborema, LOJA04 E-commerce, LOJA05 Tambaú, LOJA06 Tambiá). Restrições sempre incluem: "nada ao cliente sem aprovação", "desconto > 15% só com pricing", "nunca inventar dado". Orçamento de IA sugerido em R$ (padrão 30). Se algo for ambíguo, liste em duvidas.`,
    entrada: { objetivo: texto },
    schema: SCHEMA,
  });
  if (!r.ok || !r.json) {
    return { kpis: [{ nome: 'definir', meta: texto }], regiao: [], restricoes: ['nada ao cliente sem aprovação', 'desconto > 15% só com pricing', 'nunca inventar dado'], loja: null, prazoDias: 30, orcamentoRS: 30, duvidas: ['IA indisponível: revise metas e região manualmente'], custoRS: r.custoRS || 0 };
  }
  return Object.assign({}, r.json, { custoRS: r.custoRS || 0 });
}

async function criar({ texto, kpis, regiao, restricoes, loja, prazoDias, orcamentoRS, criadoPor }, db = prisma) {
  if (!texto || texto.trim().length < 8) throw new Error('Descreva o objetivo.');
  const reg = (regiao || []).filter((r) => REGIOES.includes(r));
  return db.rnaObjetivo.create({ data: {
    texto: texto.trim().slice(0, 500),
    kpis: kpis || [],
    regiao: reg,
    restricoes: (restricoes || []).slice(0, 20),
    loja: LOJAS.includes(loja) ? loja : null,
    orcamento: { rs: Math.min(Number(orcamentoRS) || 30, Number(process.env.RNA_OBJETIVO_MAX_RS || 200)), ativacoesIA: 400 },
    prazo: new Date(Date.now() + (Number(prazoDias) || 30) * 24 * 3600 * 1000),
    criadoPor: String(criadoPor || 'dono'),
  } });
}

async function definirStatus(id, status, db = prisma) {
  if (!['ativo', 'pausado', 'concluido', 'cancelado'].includes(status)) throw new Error('status inválido');
  const o = await db.rnaObjetivo.update({ where: { id }, data: { status } });
  motor.invalidarCaches();
  return o;
}

// Pulso diário dos objetivos ativos (o relógio chama): acorda a região.
async function pulsar(db = prisma) {
  const ativos = await db.rnaObjetivo.findMany({ where: { status: 'ativo' } });
  for (const o of ativos) {
    if (o.prazo && o.prazo.getTime() < Date.now()) {
      const recente = await db.rnaSinal.count({ where: { tipo: 'objetivo.prazo-final', objetivoId: o.id, criadoEm: { gte: new Date(Date.now() - 7 * 86400000) } } }).catch(() => 0);
      if (recente) continue;
      await motor.emitir({ tipo: 'objetivo.prazo-final', origem: 's.relogio', forca: 1, objetivoId: o.id, loja: o.loja, dados: { objetivoId: o.id, kpis: o.kpis } });
      continue;
    }
    await motor.emitir({ tipo: 'relogio.objetivo', origem: 's.relogio', forca: 0.8, objetivoId: o.id, loja: o.loja, dados: { objetivoId: o.id, texto: o.texto, kpis: o.kpis, regiao: o.regiao } });
  }
  return ativos.length;
}

module.exports = { compilar, criar, definirStatus, pulsar, REGIOES, LOJAS };
