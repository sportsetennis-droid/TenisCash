'use strict';

// Parâmetros da folha com VIGÊNCIA. A regra usada é sempre a vigente no último dia da
// competência; a mais específica vence (loja > estabelecimento > geral). Parâmetro com
// status PENDING_VALIDATION não é usado: vira pendência "validar com o departamento pessoal".

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

module.exports = { SOURCES, SEED_PARAMS, SEED_HOLIDAYS_2026, SEED_COMMISSION_RULE, resolveParams, resolveCommissionRule };
