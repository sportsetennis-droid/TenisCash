'use strict';

// Cálculos legais da folha, sempre a partir dos PARÂMETROS vigentes (nada de alíquota
// fixa aqui). Todos os valores em centavos inteiros.

const round = (v) => Math.round(Number(v) || 0);
const pct = (base, rate) => round(base * Number(rate) / 100);

// INSS do empregado — tabela progressiva por faixas (cada faixa sobre a parte que cabe nela).
// param: { brackets: [{ upToCents, rate }], ceilingCents }
function inss(baseCents, param) {
  if (!param || !Array.isArray(param.brackets) || !param.brackets.length) return null;
  const base = Math.min(Math.max(0, round(baseCents)), round(param.ceilingCents ?? Infinity));
  let previous = 0;
  let total = 0;
  const parts = [];
  for (const bracket of param.brackets) {
    const top = bracket.upToCents == null ? base : Math.min(base, round(bracket.upToCents));
    if (top <= previous) break;
    const slice = top - previous;
    const value = slice * Number(bracket.rate) / 100;
    total += value;
    parts.push({ fromCents: previous, toCents: top, rate: Number(bracket.rate), valueCents: round(value) });
    previous = top;
    if (bracket.upToCents == null || base <= bracket.upToCents) break;
  }
  return { baseCents: base, valueCents: round(total), parts };
}

// IRRF mensal: base = tributável − maior entre (deduções legais) e (desconto simplificado);
// depois tabela; depois o redutor da Lei 15.270/2025 sobre o RENDIMENTO tributável.
// param: { brackets: [{ upToCents|null, rate, deductCents }], dependentDeductionCents, simplifiedDiscountCents }
// reducer: { fullExemptUpToCents, maxReductionCents, phaseOutUpToCents, constantCents, factor }
function irrf({ taxableIncomeCents, inssCents, dependents = 0, alimonyCents = 0 }, param, reducer) {
  if (!param || !Array.isArray(param.brackets) || !param.brackets.length) return null;
  const legal = round(inssCents) + round(dependents) * round(param.dependentDeductionCents) + round(alimonyCents);
  const simplified = round(param.simplifiedDiscountCents);
  const useSimplified = simplified > legal;
  const deduction = useSimplified ? simplified : legal;
  const base = Math.max(0, round(taxableIncomeCents) - deduction);
  const bracket = param.brackets.find((b) => b.upToCents == null || base <= b.upToCents) || param.brackets[param.brackets.length - 1];
  const tableTax = Math.max(0, round(base * Number(bracket.rate) / 100 - round(bracket.deductCents)));
  let reduction = 0;
  if (reducer && tableTax > 0) {
    const income = round(taxableIncomeCents);
    if (income <= round(reducer.fullExemptUpToCents)) reduction = Math.min(tableTax, round(reducer.maxReductionCents));
    else if (income <= round(reducer.phaseOutUpToCents)) reduction = Math.max(0, round(reducer.constantCents - reducer.factor * income));
    reduction = Math.min(reduction, tableTax);
  }
  return {
    baseCents: base, deductionCents: deduction, useSimplified, rate: Number(bracket.rate),
    tableTaxCents: tableTax, reductionCents: reduction, valueCents: tableTax - reduction,
  };
}

function fgts(baseCents, param, apprentice = false) {
  if (!param) return null;
  const rate = apprentice ? Number(param.apprenticeRate) : Number(param.rate);
  return { baseCents: round(baseCents), rate, valueCents: pct(baseCents, rate) };
}

// Vale-transporte: desconto até 6% do salário-base, nunca acima do custo entregue (Lei 7.418/85).
function valeTransporte(salaryBaseCents, benefitCostCents, param) {
  if (!param) return null;
  const cap = pct(salaryBaseCents, param.rate);
  return { capCents: cap, costCents: round(benefitCostCents), valueCents: Math.min(cap, Math.max(0, round(benefitCostCents))) };
}

function salarioFamilia(remunerationCents, children, param) {
  if (!param || !children) return { valueCents: 0 };
  if (round(remunerationCents) > round(param.incomeLimitCents)) return { valueCents: 0, overLimit: true };
  return { valueCents: round(children) * round(param.quotaCents), quotas: round(children) };
}

// DSR sobre variáveis (comissão, horas extras): (variável ÷ dias úteis) × domingos e feriados.
function dsr(variableCents, usefulDays, restDays) {
  if (!usefulDays || !restDays) return 0;
  return round(round(variableCents) / usefulDays * restDays);
}

// Férias: salário dos dias + 1/3 constitucional (CF art. 7º, XVII).
function ferias({ monthlyCents, days = 30, variableAverageCents = 0 }) {
  const salary = round((round(monthlyCents) + round(variableAverageCents)) * days / 30);
  const third = round(salary / 3);
  return { salaryCents: salary, thirdCents: third, totalCents: salary + third };
}

// 13º salário: 1/12 por mês com 15+ dias de trabalho (Lei 4.090/62); média de variáveis.
function decimoTerceiro({ monthlyCents, avos, variableAverageCents = 0 }) {
  return { avos, totalCents: round((round(monthlyCents) + round(variableAverageCents)) * avos / 12) };
}

module.exports = { inss, irrf, fgts, valeTransporte, salarioFamilia, dsr, ferias, decimoTerceiro, pct, round };
