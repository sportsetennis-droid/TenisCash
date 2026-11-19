// =====================================================================
// RNA — ferramentas dos neurônios (sentidos e mãos)
//  - ler: acesso SÓ LEITURA ao banco (proxy que bloqueia qualquer escrita).
//  - propor: cria AIApproval com prévia + evidência + trace (o dono decide).
//  - quadro: memória compartilhada do objetivo.
// Neurônio nunca escreve no banco direto. Escrita = proposta aprovada.
// =====================================================================
const { prisma } = require('../../middleware');

const LEITURA = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']);

function soLeitura(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === '$queryRaw' || prop === '$queryRawUnsafe') {
        return (sql, ...args) => {
          // string, Prisma.sql (tem .strings) ou template literal (TemplateStringsArray = array)
          const texto = typeof sql === 'string' ? sql : Array.isArray(sql) ? sql.join('?') : (sql && sql.strings ? sql.strings.join('?') : String(sql));
          if (!/^\s*(select|with)\b/i.test(texto) || /;\s*\S/.test(texto) || /\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i.test(texto.replace(/'[^']*'/g, ''))) {
            throw new Error('RNA: só consulta SELECT é permitida aos neurônios');
          }
          return target[prop](sql, ...args);
        };
      }
      if (typeof prop === 'string' && prop.startsWith('$')) {
        return () => { throw new Error('RNA: ' + prop + ' bloqueado (neurônio só lê)'); };
      }
      const model = target[prop];
      if (!model || typeof model !== 'object') return model;
      return new Proxy(model, {
        get(m, op) {
          if (typeof op === 'string' && !LEITURA.has(op) && typeof m[op] === 'function') {
            return () => { throw new Error(`RNA: ${String(prop)}.${op} bloqueado (neurônio só lê; para mudar, faça uma proposta)`); };
          }
          return m[op];
        },
      });
    },
  });
}

const RISCO = { baixo: 'low', medio: 'medium', alto: 'high' };

// Cria a proposta (aprovação do dono). `caminho` = sinapses percorridas no trace (para o aprendizado).
async function criarProposta({ neuronio, sinal, proposta, caminho, db = prisma }) {
  const d = proposta.dados || {};
  const tipo = 'rna_' + proposta.tipo.slice('proposta.'.length).replace(/[^a-z0-9_]/gi, '_');
  // dedupe: mesma proposta (chave) pendente não duplica
  const chave = d.chave ? String(d.chave) : null;
  if (chave) {
    const ja = await db.aIApproval.findFirst({ where: { type: tipo, status: 'pending', payload: { path: ['rna', 'chave'], equals: chave } } }).catch(() => null);
    if (ja) return { duplicada: true, id: ja.id };
    // o dono já recusou essa mesma proposta há pouco: não insiste
    const dias = Number(process.env.RNA_ESPERA_REJEITADA_DIAS || 14);
    const recusada = await db.aIApproval.findFirst({ where: { type: tipo, status: 'rejected', decidedAt: { gte: new Date(Date.now() - dias * 86400000) }, payload: { path: ['rna', 'chave'], equals: chave } } }).catch(() => null);
    if (recusada) return { duplicada: true, recusada: true, id: recusada.id };
  }
  // COTA: a fila do dono não pode ser enterrada (1º dia acha centenas de casos).
  // O que passar volta no próximo pulso, quando a cota renovar.
  const inicioDia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  inicioDia.setHours(0, 0, 0, 0);
  const desdeHoje = new Date(Date.now() - (new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' })) - inicioDia));
  const cotaNeuronio = Number(process.env.RNA_PROPOSTAS_DIA_NEURONIO || 20);
  const cotaTotal = Number(process.env.RNA_PROPOSTAS_DIA || 100);
  const [doNeuronio, total] = await Promise.all([
    db.aIApproval.count({ where: { type: { startsWith: 'rna_' }, createdAt: { gte: desdeHoje }, payload: { path: ['rna', 'neuronio'], equals: neuronio.id } } }).catch(() => 0),
    db.aIApproval.count({ where: { type: { startsWith: 'rna_' }, createdAt: { gte: desdeHoje } } }).catch(() => 0),
  ]);
  if (doNeuronio >= cotaNeuronio || total >= cotaTotal) return { duplicada: false, limitado: true, motivo: doNeuronio >= cotaNeuronio ? 'cota do mini agente' : 'cota diária da rede' };
  const ap = await db.aIApproval.create({
    data: {
      type: tipo,
      title: String(d.titulo).slice(0, 200),
      description: d.descricao ? String(d.descricao).slice(0, 4000) : null,
      riskLevel: RISCO[d.risco] || 'medium',
      payload: {
        rna: { neuronio: neuronio.id, sinalId: sinal.id, traceId: sinal.traceId, objetivoId: sinal.objetivoId || null, caminho, chave, impactoRS: proposta.impactoRS || null },
        acao: d.acao || null,           // o que executar se aprovado (executor da RNA)
        previa: d.previa || null,       // o que vai mudar, pro dono ver
        evidencia: d.evidencia,         // de onde veio cada dado (anti-chute)
      },
    },
  });
  return { duplicada: false, id: ap.id };
}

function quadro(objetivoId, autor, db = prisma) {
  return {
    async ler(chave) {
      if (!objetivoId) return [];
      return db.rnaQuadro.findMany({ where: { objetivoId, ...(chave ? { chave } : {}) }, orderBy: { criadoEm: 'desc' }, take: 50 });
    },
    async escrever(chave, valor) {
      if (!objetivoId) return null;
      return db.rnaQuadro.create({ data: { objetivoId, chave: String(chave).slice(0, 120), valor, autor } });
    },
  };
}

module.exports = { soLeitura, criarProposta, quadro };
