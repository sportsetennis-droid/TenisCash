'use strict';

// Regras puras dos cadastros do financeiro (plano de contas e contas financeiras).
// Sem banco: testável com assert. As rotas (src/routes/fin.js) só buscam e gravam.

const { toCents } = require('./money');

const NATURE_KINDS = ['RECEITA', 'DESPESA', 'TRANSFERENCIA'];
const DRE_GROUPS = [
  'RECEITA_BRUTA', 'DEDUCOES', 'CMV', 'TAXAS_MEIOS_PAGTO', 'PESSOAL', 'OCUPACAO', 'COMERCIAL',
  'ADMINISTRATIVA', 'MARKETING', 'FINANCEIRA', 'IMPOSTOS_LUCRO', 'FORA_DRE', 'A_CLASSIFICAR',
];
const ACCOUNT_TYPES = ['CAIXA_LOJA', 'COFRE', 'BANCO', 'ADQUIRENTE_STONE', 'PSP_PAGBANK', 'TRANSITORIA'];
const NATURE_CODE = /^\d{2}(\.\d{2}){0,3}$/;

class FinValidationError extends Error {
  constructor(message) { super(message); this.name = 'FinValidationError'; this.status = 400; }
}

function text(value, label, { required = true, max = 120 } = {}) {
  const v = value == null ? '' : String(value).trim();
  if (!v) { if (required) throw new FinValidationError(label + ' é obrigatório'); return null; }
  if (v.length > max) throw new FinValidationError(label + ' passa de ' + max + ' caracteres');
  return v;
}

function oneOf(value, list, label) {
  const v = String(value || '').trim().toUpperCase();
  if (!list.includes(v)) throw new FinValidationError(label + ' inválido: use ' + list.join(', '));
  return v;
}

// parent: natureza-mãe já carregada (ou null). Código do filho começa com o código da mãe.
function validateNatureCreate(input, parent) {
  const code = text(input.code, 'Código', { max: 11 });
  if (!NATURE_CODE.test(code)) throw new FinValidationError('Código no formato 06 ou 06.01 (pares de dígitos)');
  const levels = code.split('.').length;
  if (levels === 1 && parent) throw new FinValidationError('Grupo de 1º nível não tem conta-mãe');
  if (levels > 1) {
    if (!parent) throw new FinValidationError('Informe a conta-mãe (grupo) deste código');
    if (parent.analytic) throw new FinValidationError('A conta-mãe recebe lançamento; escolha um grupo');
    if (!parent.active) throw new FinValidationError('A conta-mãe está desativada');
    if (!code.startsWith(parent.code + '.') || code.split('.').length !== parent.code.split('.').length + 1) {
      throw new FinValidationError('O código ' + code + ' precisa ficar logo abaixo de ' + parent.code);
    }
  }
  return {
    code,
    name: text(input.name, 'Nome'),
    kind: oneOf(input.kind, NATURE_KINDS, 'Tipo'),
    dreGroup: oneOf(input.dreGroup, DRE_GROUPS, 'Grupo da DRE'),
    parentId: parent ? parent.id : null,
    analytic: input.analytic === undefined ? levels > 1 : !!input.analytic,
  };
}

// Código e conta-mãe não mudam (mudaria a classificação do que já foi lançado).
function validateNatureUpdate(input) {
  const data = {};
  if (input.name !== undefined) data.name = text(input.name, 'Nome');
  if (input.kind !== undefined) data.kind = oneOf(input.kind, NATURE_KINDS, 'Tipo');
  if (input.dreGroup !== undefined) data.dreGroup = oneOf(input.dreGroup, DRE_GROUPS, 'Grupo da DRE');
  if (input.code !== undefined || input.parentId !== undefined || input.analytic !== undefined) {
    throw new FinValidationError('Código, conta-mãe e tipo de conta não podem ser alterados; crie outra conta');
  }
  if (!Object.keys(data).length) throw new FinValidationError('Nada para alterar');
  return data;
}

function validateReason(reason) {
  const r = text(reason, 'Motivo', { max: 500 });
  if (r.length < 3) throw new FinValidationError('Explique o motivo');
  return r;
}

function parseDate(value, label) {
  if (value == null || value === '') return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new FinValidationError(label + ' no formato AAAA-MM-DD');
  // Meia-noite de Fortaleza (UTC-3, sem horário de verão) = 03:00 UTC.
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 3, 0, 0));
  if (d.getUTCDate() !== +m[3]) throw new FinValidationError(label + ' inválida');
  return d;
}

function validateAccount(input, { partial = false } = {}) {
  const data = {};
  const has = (k) => input[k] !== undefined;
  if (partial && has('type')) throw new FinValidationError('O tipo da conta não pode ser alterado; crie outra conta');
  if (!partial || has('name')) data.name = text(input.name, 'Nome');
  if (!partial) data.type = oneOf(input.type, ACCOUNT_TYPES, 'Tipo de conta');
  for (const [k, label, max] of [['storeId', 'Loja', 60], ['fiscalIssuerId', 'CNPJ emissor', 60], ['bankCode', 'Banco', 10],
    ['agency', 'Agência', 20], ['accountNumber', 'Conta', 30], ['pixKey', 'Chave PIX', 120], ['acquirerKey', 'Adquirente', 30]]) {
    if (!partial || has(k)) data[k] = text(input[k], label, { required: false, max });
  }
  if (!partial || has('openingBalance') || has('openingBalanceCents')) {
    data.openingBalanceCents = has('openingBalanceCents') ? Math.trunc(Number(input.openingBalanceCents) || 0) : toCents(input.openingBalance);
  }
  if (!partial || has('openingDate')) data.openingDate = parseDate(input.openingDate, 'Data do saldo inicial');
  if (!partial && ['CAIXA_LOJA', 'COFRE'].includes(data.type) && !data.storeId) {
    throw new FinValidationError('Caixa e cofre precisam de loja');
  }
  if (partial && !Object.keys(data).length) throw new FinValidationError('Nada para alterar');
  return data;
}

// Contas que toda loja ativa precisa ter. Não inventa dado bancário: só nome, tipo e vínculo.
// existing: contas já cadastradas (ativas ou não) — evita duplicar.
function planStoreAccounts(stores, existing) {
  const has = (storeId, type) => (existing || []).some((a) => a.storeId === storeId && a.type === type);
  const plan = [];
  for (const s of stores || []) {
    if (!s || s.active === false) continue;
    const label = s.code ? s.code + ' ' + (s.name || '') : (s.name || s.id);
    const base = { storeId: s.id, fiscalIssuerId: s.fiscalIssuerId || null };
    if (!has(s.id, 'CAIXA_LOJA')) plan.push({ ...base, type: 'CAIXA_LOJA', name: 'Caixa - ' + label.trim() });
    if (!has(s.id, 'ADQUIRENTE_STONE')) plan.push({ ...base, type: 'ADQUIRENTE_STONE', name: 'Stone - ' + label.trim(), acquirerKey: 'STONE' });
    if (s.pagbankEnabled && !has(s.id, 'PSP_PAGBANK')) plan.push({ ...base, type: 'PSP_PAGBANK', name: 'PagBank - ' + label.trim(), acquirerKey: 'PAGSEGURO' });
  }
  return plan;
}

module.exports = {
  NATURE_KINDS, DRE_GROUPS, ACCOUNT_TYPES, FinValidationError,
  validateNatureCreate, validateNatureUpdate, validateAccount, validateReason, parseDate, planStoreAccounts,
};
