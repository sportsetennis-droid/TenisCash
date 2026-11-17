// =====================================================================
// RNA — EXECUTOR de propostas APROVADAS pelo dono.
// Só roda o que está registrado aqui E foi aprovado. Cada ação valida
// de novo as regras duras antes de mexer (nunca confia no neurônio).
// Domínios registram suas ações com `registrar(nome, { descricao, executar })`.
// =====================================================================
const { prisma } = require('../../middleware');

const ACOES = new Map();
function registrar(nome, def) {
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(nome)) throw new Error('nome de ação inválido: ' + nome);
  if (typeof def.executar !== 'function') throw new Error('ação sem executar(): ' + nome);
  ACOES.set(nome, def);
}
const listar = () => [...ACOES.entries()].map(([nome, d]) => ({ nome, descricao: d.descricao || '' }));

// Ação neutra: o dono aprovou, fica registrado (a correção é manual).
registrar('rna.registrar', { descricao: 'Só registra a decisão (correção feita por pessoa).', executar: async () => ({ ok: true, nota: 'registrado' }) });

// Ações de cada domínio vivem em src/ai/rede/acoes/<dominio>.js e chamam registrar().
(function carregarDominios() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, 'acoes');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    try { require(path.join(dir, f))(registrar); } catch (e) { console.error('[RNA] ações ' + f + ':', e.message); }
  }
})();

async function executar(aprovacaoId, { executadoPor } = {}, db = prisma) {
  const ap = await db.aIApproval.findUnique({ where: { id: aprovacaoId } });
  if (!ap) throw Object.assign(new Error('Proposta não encontrada'), { status: 404 });
  if (!ap.type.startsWith('rna_')) throw Object.assign(new Error('Não é proposta da rede'), { status: 400 });
  if (ap.status !== 'approved') throw Object.assign(new Error('Só executa proposta APROVADA (status atual: ' + ap.status + ')'), { status: 409 });
  const acao = ap.payload && ap.payload.acao;
  const nome = (acao && acao.nome) || 'rna.registrar';
  const def = ACOES.get(nome);
  if (!def) throw Object.assign(new Error('Ação não registrada: ' + nome), { status: 400 });
  let resultado;
  try {
    resultado = await def.executar(acao && acao.args ? acao.args : {}, { aprovacao: ap, db });
  } catch (e) {
    await db.aIApproval.update({ where: { id: ap.id }, data: { decisionNote: ((ap.decisionNote || '') + ' | falha ao executar: ' + e.message).slice(0, 1000) } });
    throw Object.assign(new Error('Falha ao executar: ' + e.message), { status: 500 });
  }
  await db.aIApproval.update({ where: { id: ap.id }, data: { status: 'executed', payload: Object.assign({}, ap.payload, { execucao: { em: new Date().toISOString(), por: executadoPor || null, resultado } }) } });
  return { ok: true, acao: nome, resultado };
}

module.exports = { registrar, listar, executar, ACOES };
