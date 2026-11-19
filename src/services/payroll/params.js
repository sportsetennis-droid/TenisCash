'use strict';

// Parâmetros da folha com VIGÊNCIA. A regra usada é sempre a vigente no último dia da
// competência; a mais específica vence (loja > estabelecimento > geral). Parâmetro com
// status PENDING_VALIDATION não é usado: vira pendência "validar com o departamento pessoal".

const VA_SRC_DONO = 'Dono (18/11/2026): vale-alimentação de R$ 12,00 por dia trabalhado acima de 4h, para todas as lojas (a CCT JP 2026/2027 cita R$ 14,00)';
const HE_CG_SRC = 'Dono (18/11/2026): Campina Grande não terá hora extra — se o ponto mostrar, conferir';

// Ajustes do dono em parâmetros que já foram semeados no banco (a semente só cria o que falta).
// Idempotente: só troca a linha da semente que ainda tem a fonte antiga.
const SEED_UPDATES = [
  { key: 'VALE_ALIMENTACAO_DIA', validFrom: '2026-07-01', storeCode: null,
    oldSource: 'CCT comerciários Grande João Pessoa 2026/2027, registro MTE MR063315/2026 (vigência 01/07/2026 a 30/06/2027) — comerciario.com.br/seus-direitos; gravado por ordem do dono em 18/11/2026 — R$ 14,00 por dia efetivamente trabalhado acima de 4h',
    set: { value: { amountCents: 1200, minWorkedMinutes: 240 }, status: 'ACTIVE', source: VA_SRC_DONO } },
  { key: 'HORA_EXTRA', validFrom: '2026-07-01', storeCode: 'LOJA03',
    oldSource: 'Campina Grande: convenção própria — percentual de hora extra a informar pelo dono',
    set: { value: { pct: null, semHoraExtra: true }, status: 'ACTIVE', source: HE_CG_SRC } },
  { key: 'VALE_ALIMENTACAO_DIA', validFrom: '2026-07-01', storeCode: 'LOJA03',
    oldSource: 'Campina Grande: convenção própria — vale-alimentação a informar pelo dono',
    set: { status: 'REVOKED', source: 'Dono (18/11/2026): vale-alimentação geral (R$ 12,00) vale também para Campina Grande' } },
];

const SOURCES = {
  INSS_2026: 'Portaria Interministerial MPS/MF nº 13, de 09/01/2026 (efeitos desde 01/01/2026)',
  IRRF_TABLE: 'Tabela progressiva mensal do IRRF vigente desde 05/2025 (Lei 15.191/2025), mantida em 2026',
  IRRF_15270: 'Lei 15.270/2025 — redução do IRRF para rendimentos até R$ 7.350,00 (desde 01/01/2026)',
  MIN_2026: 'Decreto 12.797/2025 — salário mínimo de R$ 1.621,00 desde 01/01/2026',
  FGTS: 'Lei 8.036/1990, art. 15 (8%; aprendiz 2% — §7º)',
  VT: 'Lei 7.418/1985 e Decreto 10.854/2021 — desconto de até 6% do salário-base',
  HE: 'CF art. 7º, XVI — mínimo de 50%; percentual maior da convenção coletiva substitui',
  NOTURNO: 'CLT art. 73 — 20% entre 22h e 5h, hora noturna de 52min30s',
  SAL_FAM_2026: 'Portaria Interministerial MPS/MF nº 13/2026 — salário-família',
  FERIADOS: 'Lei 662/1949, Lei 6.802/1980, Lei 14.759/2023 (feriados nacionais)',
  CCT_JP_2026: 'CCT comerciários Grande João Pessoa 2026/2027, registro MTE MR063315/2026 (vigência 01/07/2026 a 30/06/2027) — comerciario.com.br/seus-direitos; gravado por ordem do dono em 18/11/2026',
};

// Sementes: valores legais conferidos nas fontes acima. Domingo/feriado = valor fixo
// definido pelo dono; enquanto o valor não for cadastrado, fica pendente de validação.
const SEED_PARAMS = [
  { key: 'INSS_EMPREGADO', validFrom: '2026-01-01', source: SOURCES.INSS_2026, value: {
    ceilingCents: 847555,
    brackets: [{ upToCents: 162100, rate: 7.5 }, { upToCents: 290284, rate: 9 }, { upToCents: 435427, rate: 12 }, { upToCents: 847555, rate: 14 }],
  } },
  { key: 'IRRF_MENSAL', validFrom: '2026-01-01', source: SOURCES.IRRF_TABLE, value: {
    dependentDeductionCents: 18959, simplifiedDiscountCents: 60720,
    brackets: [
      { upToCents: 242880, rate: 0, deductCents: 0 },
      { upToCents: 282665, rate: 7.5, deductCents: 18216 },
      { upToCents: 375105, rate: 15, deductCents: 39416 },
      { upToCents: 466468, rate: 22.5, deductCents: 67549 },
      { upToCents: null, rate: 27.5, deductCents: 90873 },
    ],
  } },
  { key: 'IRRF_REDUTOR', validFrom: '2026-01-01', source: SOURCES.IRRF_15270, value: {
    fullExemptUpToCents: 500000, maxReductionCents: 31289, phaseOutUpToCents: 735000, constantCents: 97862, factor: 0.133145,
  } },
  { key: 'SALARIO_MINIMO', validFrom: '2026-01-01', source: SOURCES.MIN_2026, value: { cents: 162100 } },
  { key: 'FGTS', validFrom: '1990-05-11', source: SOURCES.FGTS, value: { rate: 8, apprenticeRate: 2 } },
  { key: 'VALE_TRANSPORTE', validFrom: '1985-12-16', source: SOURCES.VT, value: { rate: 6 } },
  { key: 'HORA_EXTRA', validFrom: '1988-10-05', source: SOURCES.HE, value: { pct: 50 } },
  { key: 'ADICIONAL_NOTURNO', validFrom: '1943-05-01', source: SOURCES.NOTURNO, value: { pct: 20, startMinute: 1320, endMinute: 300 } },
  { key: 'SALARIO_FAMILIA', validFrom: '2026-01-01', source: SOURCES.SAL_FAM_2026, value: { quotaCents: 6754, incomeLimitCents: 198038 } },
  { key: 'DOMINGO_TRABALHADO', validFrom: '2026-01-01', status: 'PENDING_VALIDATION',
    source: 'Dono (16/11/2026): valor fixo por domingo trabalhado + folga compensatória — valor a cadastrar',
    value: { mode: 'FIXED', amountCents: null, compensatoryDayOff: true } },
  { key: 'FERIADO_TRABALHADO', validFrom: '2026-01-01', status: 'PENDING_VALIDATION',
    source: 'Dono (16/11/2026): valor fixo por feriado trabalhado + folga compensatória — valor a cadastrar',
    value: { mode: 'FIXED', amountCents: null, compensatoryDayOff: true } },
  // CCT João Pessoa 2026/2027 — vale para todas as lojas, menos as de outra base sindical (abaixo).
  // O adicional de 100% de hora extra em domingo/feriado NÃO foi gravado (ordem do dono).
  { key: 'HORA_EXTRA', validFrom: '2026-07-01', source: SOURCES.CCT_JP_2026 + ' — hora extra 60%', value: { pct: 60 } },
  { key: 'DOMINGO_TRABALHADO', validFrom: '2026-07-01', source: SOURCES.CCT_JP_2026 + ' — R$ 72,00 + vale-transporte + um dia de folga',
    value: { mode: 'FIXED', amountCents: 7200, compensatoryDayOff: true } },
  { key: 'FERIADO_TRABALHADO', validFrom: '2026-07-01', source: SOURCES.CCT_JP_2026 + ' — R$ 72,00 + vale-transporte + um dia de folga',
    value: { mode: 'FIXED', amountCents: 7200, compensatoryDayOff: true } },
  { key: 'VALE_ALIMENTACAO_DIA', validFrom: '2026-07-01', source: VA_SRC_DONO,
    value: { amountCents: 1200, minWorkedMinutes: 240 } },
  { key: 'PASSAGEM_DIA', validFrom: '2026-07-01', source: 'Dono (18/11/2026): passagem de R$ 11,00 por dia trabalhado (quem usa vale-transporte), para todas as lojas',
    value: { amountCents: 1100 } },
  // Campina Grande (LOJA03): domingo é troca pedida pelo colaborador (sem adicional) — tratado no ponto (DOMINGO_TROCA).
  // Dono (18/11/2026): "Campina não terá hora extra". Se aparecer hora extra no ponto, vira pendência para conferir
  // (não paga sozinho nem some: a lei manda pagar hora extra que de fato existiu, mínimo 50%).
  // Vale-alimentação e passagem: os gerais (R$ 12 e R$ 11), "para todos".
  { key: 'HORA_EXTRA', storeCode: 'LOJA03', validFrom: '2026-07-01', source: HE_CG_SRC, value: { pct: null, semHoraExtra: true } },
  { key: 'FERIADO_TRABALHADO', storeCode: 'LOJA03', validFrom: '2026-07-01', status: 'PENDING_VALIDATION', source: 'Campina Grande: convenção própria — feriado trabalhado a informar pelo dono', value: { mode: 'FIXED', amountCents: null, compensatoryDayOff: true } },
];

const SEED_HOLIDAYS_2026 = [
  ['2026-01-01', 'Confraternização Universal'], ['2026-04-21', 'Tiradentes'], ['2026-05-01', 'Dia do Trabalho'],
  ['2026-09-07', 'Independência do Brasil'], ['2026-10-12', 'Nossa Senhora Aparecida'], ['2026-11-02', 'Finados'],
  ['2026-11-15', 'Proclamação da República'], ['2026-11-20', 'Dia Nacional de Zumbi e da Consciência Negra'],
  ['2026-12-25', 'Natal'],
].map(([date, name]) => ({ date, name, scope: 'NACIONAL', locality: 'BR', source: SOURCES.FERIADOS }));

// Regra de comissão vigente informada pelo dono em 16/11/2026.
const SEED_COMMISSION_RULE = {
  name: 'Comissão vendedor — 1% / 2% acima de R$ 20 mil; camisas S&T 4% acima de R$ 5 mil',
  validFrom: '2026-11-01',
  notes: 'Dono (16/11/2026): até R$ 20.000,00 em vendas 1%; acima de R$ 20.000,00, 2%. Se as vendas de camisas Sports & Tennis ultrapassarem R$ 5.000,00, só esses itens recebem 4%; os demais seguem a alíquota geral.',
  config: {
    tierMode: 'ALL',
    tiers: [{ aboveCents: 0, pct: 1 }, { aboveCents: 2000000, pct: 2 }],
    special: [{
      name: 'Camisas Sports & Tennis', aboveCents: 500000, pct: 4,
      match: { brands: ['sportstennis', 'sportsandtennis', 'sportsetennis'], categories: ['roupa', 'roupas', 'vestuario', 'vestuarios', 'vestuarioesportivo'] },
    }],
    confirmedStatuses: ['completed'],
    pendingStatuses: ['pending', 'pending_payment'],
    canceledStatuses: ['canceled', 'cancelled'],
    returns: 'EXCLUI_DEVOLVIDO',
    closingDay: 'ULTIMO_DIA',
  },
};

function specificity(row) { return (row.storeId ? 2 : 0) + (row.issuerId ? 1 : 0); }

// rows: PayrollParam[]; scope: { issuerId, storeId }; onDay: AAAA-MM-DD
function resolveParams(rows, { onDay, issuerId = null, storeId = null }) {
  const out = {};
  const pending = {};
  const candidates = (rows || []).filter((r) => r.validFrom <= onDay && (!r.validTo || r.validTo >= onDay)
    && (!r.storeId || r.storeId === storeId) && (!r.issuerId || r.issuerId === issuerId) && r.status !== 'REVOKED');
  const byKey = new Map();
  for (const row of candidates) {
    const cur = byKey.get(row.key);
    if (!cur || specificity(row) > specificity(cur) || (specificity(row) === specificity(cur) && row.validFrom > cur.validFrom)) byKey.set(row.key, row);
  }
  for (const [key, row] of byKey) {
    if (row.status === 'PENDING_VALIDATION') pending[key] = { source: row.source, id: row.id || null };
    else out[key] = { ...row.value, _source: row.source, _id: row.id || null, _validFrom: row.validFrom };
  }
  return { params: out, pending };
}

function resolveCommissionRule(rules, { onDay, userId, storeId, issuerId }) {
  const ok = (rules || []).filter((r) => r.active !== false && r.validFrom <= onDay && (!r.validTo || r.validTo >= onDay)
    && (!r.userId || r.userId === userId) && (!r.storeId || r.storeId === storeId) && (!r.issuerId || r.issuerId === issuerId));
  ok.sort((a, b) => ((b.userId ? 4 : 0) + (b.storeId ? 2 : 0) + (b.issuerId ? 1 : 0)) - ((a.userId ? 4 : 0) + (a.storeId ? 2 : 0) + (a.issuerId ? 1 : 0))
    || (b.priority || 0) - (a.priority || 0) || String(b.validFrom).localeCompare(String(a.validFrom)));
  return ok[0] || null;
}

module.exports = {
  SEED_UPDATES, SOURCES, SEED_PARAMS, SEED_HOLIDAYS_2026, SEED_COMMISSION_RULE, resolveParams, resolveCommissionRule };
