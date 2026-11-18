'use strict';

// Motor do contracheque: junta ponto, dias especiais, comissão, lançamentos e parâmetros
// legais vigentes. Função PURA — recebe tudo pronto e devolve o contracheque calculado,
// com memória de cálculo de cada linha. Reproduzível: mesmos dados → mesmo resultado.

const cal = require('./calendar');
const legal = require('./legal');
const { buildTime } = require('./time');
const { computeCommission } = require('./commission');
const { resolveParams, resolveCommissionRule } = require('./params');

const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hours = (m) => `${Math.floor(Math.abs(m) / 60)}h${String(Math.abs(m) % 60).padStart(2, '0')}`;
const CONTRACTS = ['MENSALISTA', 'HORISTA', 'ESCALA_12X36', 'APRENDIZ', 'PARCIAL', 'SEM_REGISTRO'];
const DEDUCT_ALWAYS = new Set(['ADIANTAMENTO', 'COMISSAO_ANTECIPADA']);
const DEDUCT_IF_AUTHORIZED = new Set(['COMPRA_LOJA', 'EMPRESTIMO', 'PENSAO', 'OUTRO_DESCONTO']);
const EARNING_KINDS = new Set(['BONUS', 'GRATIFICACAO', 'OUTRO_PROVENTO']);
const BENEFIT_KINDS = new Set(['VALE_TRANSPORTE', 'PASSAGEM', 'VALE_ALIMENTACAO']);
const PREPAID_SPECIAL = new Set(['DOMINGO_PAGO', 'FERIADO_PAGO']);

const ENTRY_LABEL = {
  ADIANTAMENTO: 'Adiantamento salarial (vale)', PASSAGEM: 'Passagem entregue', VALE_TRANSPORTE: 'Vale-transporte entregue',
  VALE_ALIMENTACAO: 'Vale-alimentação', DOMINGO_PAGO: 'Domingo pago antecipadamente', FERIADO_PAGO: 'Feriado pago antecipadamente',
  COMISSAO_ANTECIPADA: 'Comissão adiantada', COMPRA_LOJA: 'Compra na loja', EMPRESTIMO: 'Empréstimo autorizado',
  PENSAO: 'Pensão alimentícia', OUTRO_DESCONTO: 'Outro desconto', BONUS: 'Bônus salarial', GRATIFICACAO: 'Gratificação', OUTRO_PROVENTO: 'Outro provento',
};

function pend(list, code, text, severity = 'BLOQUEIA') { list.push({ code, severity, text }); }

function bondDays(competence, profile) {
  const days = cal.monthDays(competence);
  const inBond = days.filter((d) => (!profile.admissionDate || d >= profile.admissionDate) && (!profile.terminationDate || d <= profile.terminationDate));
  // Mês comercial: vínculo no mês inteiro = 30 dias; parcial = dias corridos do vínculo.
  return { calendar: days.length, bond: inBond.length, commercial: inBond.length === days.length ? 30 : Math.min(30, inBond.length) };
}

function computePayslip(input) {
  const { competence, profile } = input;
  if (!cal.isCompetence(competence)) throw new Error('competência inválida');
  const lastDay = cal.lastDay(competence);
  const asOfDay = input.asOfDay && input.asOfDay < lastDay ? input.asOfDay : lastDay;
  const provisional = !!input.provisional;
  const pendencies = [];
  const items = [];
  const add = (type, code, label, cents, memo, extra = {}) => { if (cents) items.push({ type, code, label, cents: Math.round(cents), memo, ...extra }); };

  if (!CONTRACTS.includes(profile.contractType)) pend(pendencies, 'CONTRATO', 'Tipo de contratação não informado ou inválido.');
  const { params, pending: pendingParams } = resolveParams(input.params, { onDay: lastDay, issuerId: profile.issuerId, storeId: profile.storeId });
  const holidays = new Map();
  for (const h of input.holidays || []) if (h.active !== false && h.date.startsWith(competence) && (!h.storeId || h.storeId === profile.storeId)) holidays.set(h.date, h.name);
  const registered = profile.contractType !== 'SEM_REGISTRO' && profile.registered !== false;
  const apprentice = profile.contractType === 'APRENDIZ';
  const is12x36 = profile.contractType === 'ESCALA_12X36';
  const hourly = profile.contractType === 'HORISTA';
  if (!registered) pend(pendencies, 'SEM_REGISTRO', 'Funcionário sem registro formal: não há desconto de INSS/IRRF nem FGTS como empregado. Regularizar o vínculo.', 'ALERTA');
  if (apprentice && !profile.apprenticeContractRef) pend(pendencies, 'APRENDIZ_CONTRATO', 'Aprendiz sem contrato de aprendizagem informado: validar antes de fechar.');
  if (!hourly && !profile.baseSalaryCents) pend(pendencies, 'SALARIO', 'Salário contratual não cadastrado.');
  if (hourly && !profile.hourlyRateCents) pend(pendencies, 'VALOR_HORA', 'Valor da hora não cadastrado (horista).');
  if (!profile.admissionDate) pend(pendencies, 'ADMISSAO', 'Data de admissão não cadastrada.');
  if (is12x36 && !(input.shifts && input.shifts.size)) pend(pendencies, 'ESCALA_12X36', 'Escala 12x36 sem plantões lançados na Agenda: não dá para apurar a jornada.');

  // ── Jornada ──────────────────────────────────────────────
  const time = buildTime({ competence, profile, punches: input.punches, holidays, marks: input.marks, shifts: input.shifts, final: !provisional,
    asOfDay, nowMs: input.nowMs, night: params.ADICIONAL_NOTURNO, corrections: input.corrections });
  const t = time.totals;
  for (const d of t.incompleteDays) pend(pendencies, 'PONTO_INCOMPLETO', `${d.date}: ${d.issues.join('; ')}`);
  for (const d of t.daysWithoutPunch) pend(pendencies, 'SEM_PONTO', `${d}: dia sem ponto — conferir (não é falta sem confirmação).`);

  const bond = bondDays(competence, profile);
  const monthDays = cal.monthDays(competence);
  const restDays = monthDays.filter((d) => cal.weekdayOf(d) === 0 || holidays.has(d)).length;
  const usefulDays = monthDays.length - restDays;
  const weeklyHours = (profile.weeklyMinutes || 2640) / 60;
  const divisor = Math.round(weeklyHours * 5); // 44h → 220
  const salaryCents = profile.baseSalaryCents || 0;
  const hourCents = hourly ? (profile.hourlyRateCents || 0) : (divisor ? Math.round(salaryCents / divisor) : 0);

  // ── Salário ─────────────────────────────────────────────
  let salaryDue = 0;
  if (hourly) {
    const paidMinutes = t.registeredMinutes - t.specialMinutes + t.creditedMinutes;
    salaryDue = Math.round(paidMinutes / 60 * hourCents);
    add('PROVENTO', 'HORAS_NORMAIS', 'Horas trabalhadas', salaryDue, `${hours(paidMinutes)} × ${brl(hourCents)}/h`, { refText: hours(paidMinutes) });
    const dsrH = legal.dsr(salaryDue, usefulDays, restDays);
    add('PROVENTO', 'DSR_HORISTA', 'DSR (repouso semanal remunerado)', dsrH, `${brl(salaryDue)} ÷ ${usefulDays} dias úteis × ${restDays} domingos/feriados`);
  } else if (salaryCents) {
    salaryDue = bond.commercial === 30 ? salaryCents : Math.round(salaryCents * bond.commercial / 30);
    add('PROVENTO', bond.commercial === 30 ? 'SALARIO' : 'SALARIO_PROPORCIONAL', bond.commercial === 30 ? 'Salário' : 'Salário proporcional',
      salaryDue, bond.commercial === 30 ? `Salário contratual ${brl(salaryCents)}` : `${brl(salaryCents)} ÷ 30 × ${bond.commercial} dias de vínculo`, { refText: `${bond.commercial} dias` });
  }
  if (params.SALARIO_MINIMO && salaryCents && !hourly && profile.contractType === 'MENSALISTA' && (profile.weeklyMinutes || 2640) >= 2640 && salaryCents < params.SALARIO_MINIMO.cents) {
    pend(pendencies, 'ABAIXO_MINIMO', `Salário contratual abaixo do mínimo vigente (${brl(params.SALARIO_MINIMO.cents)}).`);
  }

  // ── Horas extras / faltas / atrasos ─────────────────────
  const timeBank = !!profile.timeBankAgreementRef;
  let extraPay = 0;
  if (!timeBank && t.extraMinutes > 0) {
    if (!params.HORA_EXTRA) pend(pendencies, 'PARAM_HE', 'Sem percentual de hora extra vigente.');
    else {
      const minutes = provisional ? t.extraMinutes : t.extraConfirmedMinutes;
      extraPay = Math.round(minutes / 60 * hourCents * (1 + params.HORA_EXTRA.pct / 100));
      add('PROVENTO', 'HORA_EXTRA', `Horas extras ${params.HORA_EXTRA.pct}%`, extraPay,
        `${hours(minutes)} × ${brl(hourCents)}/h × ${1 + params.HORA_EXTRA.pct / 100}${is12x36 ? ' (só o que passou do plantão)' : ' (saldo semanal acima da carga)'}`,
        { refText: hours(minutes), provisional: provisional || undefined });
      if (!provisional && t.extraMinutes > t.extraConfirmedMinutes) pend(pendencies, 'HE_PENDENTE', `${hours(t.extraMinutes - t.extraConfirmedMinutes)} de hora extra em semana com ponto pendente — não pagas até a conferência.`);
    }
  }
  let nightPay = 0;
  if (t.nightMinutes > 0 && params.ADICIONAL_NOTURNO) {
    const reduced = t.nightMinutes * 60 / 52.5;
    nightPay = Math.round(reduced / 60 * hourCents * params.ADICIONAL_NOTURNO.pct / 100);
    add('PROVENTO', 'ADICIONAL_NOTURNO', `Adicional noturno ${params.ADICIONAL_NOTURNO.pct}%`, nightPay, `${hours(t.nightMinutes)} reais (hora noturna de 52min30s) × ${brl(hourCents)} × ${params.ADICIONAL_NOTURNO.pct}%`);
  }
  // Falta só com confirmação; perde também o DSR da semana (Lei 605/49, art. 6º).
  const dayCents = Math.round(salaryCents / 30);
  for (const date of t.confirmedAbsences) {
    if (hourly) continue;
    add('DESCONTO', 'FALTA', `Falta confirmada ${date.split('-').reverse().join('/')}`, dayCents, `${brl(salaryCents)} ÷ 30`);
    add('DESCONTO', 'FALTA_DSR', `DSR perdido pela falta de ${date.split('-').reverse().join('/')}`, dayCents, 'Lei 605/1949, art. 6º');
  }
  if (t.lateConfirmedMinutes) add('DESCONTO', 'ATRASO', 'Atrasos confirmados', Math.round(t.lateConfirmedMinutes / 60 * hourCents), `${hours(t.lateConfirmedMinutes)} × ${brl(hourCents)}/h`);
  if (t.missingMinutes > 0) pend(pendencies, 'HORAS_FALTANTES', `${hours(t.missingMinutes)} faltantes nas semanas — só descontam depois de confirmadas como falta/atraso.`, 'ALERTA');

  // ── Domingos e feriados ─────────────────────────────────
  const entries = (input.entries || []).filter((e) => e.status !== 'CANCELADO' && e.competence === competence);
  const specialDays = time.days.filter((d) => d.status === 'DOMINGO_TRABALHADO' || d.status === 'FERIADO_TRABALHADO').map((d) => {
    const isHoliday = d.status === 'FERIADO_TRABALHADO';
    const param = isHoliday ? params.FERIADO_TRABALHADO : params.DOMINGO_TRABALHADO;
    const due = param && param.mode === 'FIXED' && param.amountCents ? param.amountCents : null;
    const paid = entries.filter((e) => PREPAID_SPECIAL.has(e.kind) && e.referenceDate === d.date).reduce((s, e) => s + e.amountCents, 0);
    const paidAt = entries.filter((e) => PREPAID_SPECIAL.has(e.kind) && e.referenceDate === d.date).map((e) => e.date).sort()[0] || null;
    const compOff = (input.marks || []).find((m) => m.kind === 'FOLGA_COMPENSATORIA' && m.refDate === d.date && (!m.status || m.status === 'APROVADO'));
    const wantsCompOff = !param || param.compensatoryDayOff !== false;
    let status;
    if (due == null) status = 'PAGAMENTO_PENDENTE';
    else if (paid >= due && (!wantsCompOff || compOff)) status = 'CONCILIADO';
    else if (paid > due) status = 'DIVERGENTE';
    else if (paid >= due) status = 'TRABALHADO_E_PAGO';
    else status = 'TRABALHADO_E_NAO_PAGO';
    return {
      date: d.date, weekdayName: d.weekdayName, holiday: d.holiday, type: isHoliday ? 'FERIADO' : 'DOMINGO',
      entry: d.entry, exit: d.exit, workedMinutes: d.workedMinutes, stores: d.stores,
      dueCents: due, paidCents: paid, paidAt, balanceCents: due == null ? null : due - paid,
      compensatoryDayOff: compOff ? compOff.date : null, compOffStatus: wantsCompOff ? (compOff ? 'FOLGA_UTILIZADA' : 'FOLGA_PENDENTE') : 'SEM_FOLGA',
      status,
    };
  });
  for (const key of ['DOMINGO_TRABALHADO', 'FERIADO_TRABALHADO']) {
    const used = specialDays.some((s) => s.type === (key === 'DOMINGO_TRABALHADO' ? 'DOMINGO' : 'FERIADO'));
    if (used && !params[key]) pend(pendencies, 'PARAM_' + key, `${key === 'DOMINGO_TRABALHADO' ? 'Domingo' : 'Feriado'} trabalhado sem valor vigente cadastrado — Pendente de validação do departamento pessoal.`);
  }
  let specialPay = 0;
  for (const s of specialDays) {
    if (s.dueCents) {
      specialPay += s.dueCents;
      add('PROVENTO', s.type === 'DOMINGO' ? 'DOMINGO' : 'FERIADO', `${s.type === 'DOMINGO' ? 'Domingo' : 'Feriado'} trabalhado ${s.date.split('-').reverse().join('/')}`,
        s.dueCents, `Valor fixo por ${s.type === 'DOMINGO' ? 'domingo' : 'feriado'} trabalhado (${hours(s.workedMinutes)})`);
    }
    if (s.compOffStatus === 'FOLGA_PENDENTE') pend(pendencies, 'FOLGA_PENDENTE', `${s.type === 'DOMINGO' ? 'Domingo' : 'Feriado'} ${s.date} trabalhado sem folga compensatória identificada.`, 'ALERTA');
    if (s.status === 'DIVERGENTE') pend(pendencies, 'ESPECIAL_DIVERGENTE', `${s.date}: pago antecipadamente mais do que o devido.`);
  }

  // ── Comissão ────────────────────────────────────────────
  const rule = resolveCommissionRule(input.commissionRules, { onDay: lastDay, userId: profile.userId, storeId: profile.storeId, issuerId: profile.issuerId });
  const commission = computeCommission(input.sales || [], rule, { competence, asOfDay });
  let commissionPay = 0;
  if (commission.missingRule) {
    if ((input.sales || []).length) pend(pendencies, 'REGRA_COMISSAO', 'Há vendas no mês, mas nenhuma regra de comissão vigente.');
  } else {
    commissionPay = commission.confirmed.commissionCents;
    add('PROVENTO', 'COMISSAO', `Comissão ${commission.confirmed.generalPct}% sobre vendas`, commission.confirmed.generalCommissionCents,
      `${brl(commission.confirmed.generalBaseCents)} × ${commission.confirmed.generalPct}% (vendas confirmadas: ${brl(commission.confirmed.totalCents)})`);
    for (const sp of commission.confirmed.specials.filter((x) => x.reached)) {
      add('PROVENTO', 'COMISSAO_ESPECIAL', `Comissão ${sp.pct}% — ${sp.name}`, sp.commissionCents, `${brl(sp.totalCents)} × ${sp.pct}% (passou de ${brl(sp.aboveCents)})`);
    }
    if (commission.pending.count) pend(pendencies, 'VENDAS_PENDENTES', `${commission.pending.count} venda(s) pendente(s) de pagamento (${brl(commission.pending.salesCents)}): fora da comissão até confirmar.`, provisional ? 'ALERTA' : 'BLOQUEIA');
  }
  // DSR sobre comissão e horas extras (Súmula 27 e 172 do TST).
  const variable = commissionPay + extraPay;
  const dsrVar = hourly ? 0 : legal.dsr(variable, usefulDays, restDays);
  add('PROVENTO', 'DSR_VARIAVEIS', 'DSR sobre comissão e horas extras', dsrVar, `${brl(variable)} ÷ ${usefulDays} dias úteis × ${restDays} domingos/feriados`);

  // ── Lançamentos (bônus, adiantamentos, benefícios, descontos) ───
  for (const e of entries) {
    if (EARNING_KINDS.has(e.kind)) add('PROVENTO', e.kind, ENTRY_LABEL[e.kind], e.amountCents, e.description || 'Lançamento ' + e.date, { entryId: e.id });
  }
  const earningsTaxable = items.filter((i) => i.type === 'PROVENTO').reduce((s, i) => s + i.cents, 0);
  const absencesCents = items.filter((i) => i.type === 'DESCONTO').reduce((s, i) => s + i.cents, 0);
  const contributionBase = Math.max(0, earningsTaxable - absencesCents);

  // Salário-família (não é tributável; entra depois das bases).
  if (registered && profile.familyAllowanceChildren) {
    if (!params.SALARIO_FAMILIA) pend(pendencies, 'PARAM_SF', 'Sem parâmetro de salário-família vigente.');
    else {
      const sf = legal.salarioFamilia(contributionBase, profile.familyAllowanceChildren, params.SALARIO_FAMILIA);
      add('PROVENTO', 'SALARIO_FAMILIA', 'Salário-família', sf.valueCents, `${profile.familyAllowanceChildren} cota(s) × ${brl(params.SALARIO_FAMILIA.quotaCents)}`, { nonTaxable: true });
    }
  }

  // ── INSS / IRRF / FGTS ─────────────────────────────────
  let inssCalc = null, irrfCalc = null, fgtsCalc = null;
  if (registered) {
    if (!params.INSS_EMPREGADO) pend(pendencies, 'PARAM_INSS', 'Sem tabela do INSS vigente na competência.');
    else {
      inssCalc = legal.inss(contributionBase, params.INSS_EMPREGADO);
      add('DESCONTO', 'INSS', 'INSS', inssCalc.valueCents, inssCalc.parts.map((p) => `${p.rate}% de ${brl(p.toCents - p.fromCents)}`).join(' + '), { refText: `base ${brl(inssCalc.baseCents)}` });
    }
    if (!params.IRRF_MENSAL) pend(pendencies, 'PARAM_IRRF', 'Sem tabela do IRRF vigente na competência.');
    else if (inssCalc) {
      const alimony = entries.filter((e) => e.kind === 'PENSAO' && e.authorized).reduce((s, e) => s + e.amountCents, 0);
      irrfCalc = legal.irrf({ taxableIncomeCents: contributionBase, inssCents: inssCalc.valueCents, dependents: profile.irrfDependents || 0, alimonyCents: alimony },
        params.IRRF_MENSAL, params.IRRF_REDUTOR);
      add('DESCONTO', 'IRRF', 'IRRF', irrfCalc.valueCents,
        `base ${brl(irrfCalc.baseCents)} (${irrfCalc.useSimplified ? 'desconto simplificado' : 'INSS + dependentes'}) × ${irrfCalc.rate}%${irrfCalc.reductionCents ? ` − redução Lei 15.270 ${brl(irrfCalc.reductionCents)}` : ''}`);
    }
    if (!params.FGTS) pend(pendencies, 'PARAM_FGTS', 'Sem parâmetro de FGTS vigente.');
    else fgtsCalc = legal.fgts(contributionBase, params.FGTS, apprentice);
  }

  // Vale-transporte: desconto até 6% do salário-base, limitado ao custo entregue.
  // Vale-alimentação e passagem pelo ponto (CCT JP 2026/2027 + dono 18/11/2026). Se o dono lançou o que
  // entregou no mês, vale o lançamento; senão calcula pelos dias trabalhados até hoje.
  const workedDays = time.days.filter((d) => !d.future && d.inBond && d.workedMinutes > 0);
  const autoBenefits = [];
  if (params.VALE_ALIMENTACAO_DIA && params.VALE_ALIMENTACAO_DIA.amountCents && !entries.some((e) => e.kind === 'VALE_ALIMENTACAO')) {
    const minMin = params.VALE_ALIMENTACAO_DIA.minWorkedMinutes ?? 240;
    const n = workedDays.filter((d) => d.workedMinutes > minMin).length;
    if (n) autoBenefits.push({ kind: 'VALE_ALIMENTACAO', label: 'Vale-alimentação', date: asOfDay, cents: n * params.VALE_ALIMENTACAO_DIA.amountCents,
      description: `${n} dia(s) trabalhado(s) acima de ${minMin / 60}h × ${brl(params.VALE_ALIMENTACAO_DIA.amountCents)}`, auto: true });
  }
  if (profile.vtOptIn && params.PASSAGEM_DIA && params.PASSAGEM_DIA.amountCents && !entries.some((e) => e.kind === 'VALE_TRANSPORTE' || e.kind === 'PASSAGEM')) {
    const n = workedDays.length;
    if (n) autoBenefits.push({ kind: 'PASSAGEM', label: 'Passagem', date: asOfDay, cents: n * params.PASSAGEM_DIA.amountCents,
      description: `${n} dia(s) trabalhado(s) × ${brl(params.PASSAGEM_DIA.amountCents)}`, auto: true });
  }
  const transportCost = entries.filter((e) => e.kind === 'VALE_TRANSPORTE' || e.kind === 'PASSAGEM').reduce((s, e) => s + e.amountCents, 0)
    + autoBenefits.filter((b) => b.kind === 'PASSAGEM').reduce((s, b) => s + b.cents, 0);
  let vtCalc = null;
  if (profile.vtOptIn && transportCost) {
    if (!params.VALE_TRANSPORTE) pend(pendencies, 'PARAM_VT', 'Sem parâmetro de vale-transporte vigente.');
    else {
      vtCalc = legal.valeTransporte(salaryDue || salaryCents, transportCost, params.VALE_TRANSPORTE);
      add('DESCONTO', 'VALE_TRANSPORTE', 'Vale-transporte (até 6%)', vtCalc.valueCents, `menor entre 6% de ${brl(salaryDue || salaryCents)} (${brl(vtCalc.capCents)}) e o custo entregue ${brl(transportCost)}`);
    }
  }

  // Adiantamentos e descontos: cada lançamento entra UMA vez (id único).
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    if (DEDUCT_ALWAYS.has(e.kind)) add('DESCONTO', e.kind, ENTRY_LABEL[e.kind] + ` (${e.date.split('-').reverse().join('/')})`, e.amountCents, e.description || 'Pago antes do fechamento', { entryId: e.id });
    else if (DEDUCT_IF_AUTHORIZED.has(e.kind)) {
      if (e.authorized) add('DESCONTO', e.kind, ENTRY_LABEL[e.kind], e.amountCents, e.description || 'Desconto autorizado', { entryId: e.id });
      else pend(pendencies, 'DESCONTO_SEM_AUTORIZACAO', `${ENTRY_LABEL[e.kind]} de ${brl(e.amountCents)} (${e.date}) sem autorização registrada — não descontado.`);
    } else if (PREPAID_SPECIAL.has(e.kind)) {
      const special = specialDays.find((sd) => sd.date === e.referenceDate);
      if (!e.referenceDate) pend(pendencies, 'ANTECIPADO_SEM_DIA', `${ENTRY_LABEL[e.kind]} de ${brl(e.amountCents)} sem o dia a que se refere — classificar.`);
      else if (!special) pend(pendencies, 'ANTECIPADO_SEM_PONTO', `${ENTRY_LABEL[e.kind]} de ${e.referenceDate}: não há ponto nesse dia — conferir antes de descontar.`);
      else if (special.dueCents == null) pend(pendencies, 'ANTECIPADO_SEM_VALOR', `${ENTRY_LABEL[e.kind]} de ${e.referenceDate} (${brl(e.amountCents)}) aguardando o valor vigente do dia especial — não descontado.`);
      else add('DESCONTO', e.kind, `${ENTRY_LABEL[e.kind]} ${e.referenceDate.split('-').reverse().join('/')}`, e.amountCents, 'Já pago antes do fechamento; o devido está nos proventos', { entryId: e.id });
    } else if (!EARNING_KINDS.has(e.kind) && !BENEFIT_KINDS.has(e.kind)) {
      pend(pendencies, 'LANCAMENTO_SEM_CLASSIFICACAO', `Lançamento "${e.kind}" de ${brl(e.amountCents)} sem classificação conhecida.`);
    }
  }
  const benefits = entries.filter((e) => BENEFIT_KINDS.has(e.kind)).map((e) => ({ kind: e.kind, label: ENTRY_LABEL[e.kind], date: e.date, cents: e.amountCents, description: e.description || null }))
    .concat(autoBenefits);

  // ── Totais ──────────────────────────────────────────────
  const gross = items.filter((i) => i.type === 'PROVENTO').reduce((s, i) => s + i.cents, 0);
  const deductions = items.filter((i) => i.type === 'DESCONTO').reduce((s, i) => s + i.cents, 0);
  const net = gross - deductions;
  if (net < 0) pend(pendencies, 'LIQUIDO_NEGATIVO', `Descontos maiores que os proventos (${brl(net)}): revisar antes de fechar.`);
  for (const [key, info] of Object.entries(pendingParams)) {
    if (!['DOMINGO_TRABALHADO', 'FERIADO_TRABALHADO'].includes(key) || specialDays.length) pend(pendencies, 'PARAM_PENDENTE', `Parâmetro ${key} pendente de validação do departamento pessoal (${info.source || 'sem fonte'}).`, 'ALERTA');
  }

  // Projeção do líquido até o fim do mês (só na prévia).
  let projection = null;
  if (provisional && asOfDay < lastDay) {
    const extraCommission = commission.projection ? Math.max(0, commission.projection.commissionCents - commissionPay) : 0;
    const extraDsr = legal.dsr(extraCommission, usefulDays, restDays);
    const projectedGross = gross + extraCommission + extraDsr;
    const projectedInss = registered && params.INSS_EMPREGADO ? legal.inss(contributionBase + extraCommission + extraDsr, params.INSS_EMPREGADO).valueCents : 0;
    const projectedIrrf = registered && params.IRRF_MENSAL ? legal.irrf({ taxableIncomeCents: contributionBase + extraCommission + extraDsr, inssCents: projectedInss, dependents: profile.irrfDependents || 0 }, params.IRRF_MENSAL, params.IRRF_REDUTOR).valueCents : 0;
    const otherDeductions = deductions - (inssCalc?.valueCents || 0) - (irrfCalc?.valueCents || 0);
    projection = { grossCents: projectedGross, netCents: projectedGross - projectedInss - projectedIrrf - otherDeductions, basis: commission.projection?.basis || null };
  }

  return {
    competence, kind: input.kind || 'MENSAL', provisional, asOfDay,
    contract: {
      type: profile.contractType, registered, admissionDate: profile.admissionDate || null, terminationDate: profile.terminationDate || null,
      baseSalaryCents: profile.baseSalaryCents || null, hourlyRateCents: profile.hourlyRateCents || null, hourCents, divisor,
      weeklyMinutes: profile.weeklyMinutes || 2640, shiftMinutes: profile.shiftMinutes || null, jobTitle: profile.jobTitle || null,
      timeBank, bondDays: bond.commercial,
    },
    calendar: { usefulDays, restDays, holidays: [...holidays].map(([date, name]) => ({ date, name })) },
    time, specialDays, commission, benefits,
    entries: entries.map((e) => ({ id: e.id, kind: e.kind, label: ENTRY_LABEL[e.kind] || e.kind, date: e.date, cents: e.amountCents, authorized: e.authorized, referenceDate: e.referenceDate || null, description: e.description || null })),
    items,
    bases: {
      contributionBaseCents: contributionBase, inss: inssCalc, irrf: irrfCalc, fgts: fgtsCalc, vt: vtCalc,
      dependents: profile.irrfDependents || 0,
    },
    totals: { grossCents: gross, deductionsCents: deductions, netCents: net },
    projection,
    params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { source: v._source, validFrom: v._validFrom, id: v._id }])),
    pendencies,
    blocking: pendencies.filter((p) => p.severity === 'BLOQUEIA').length,
  };
}

// Férias e 13º: recibos próprios (kind FERIAS / DECIMO_TERCEIRO_1 / DECIMO_TERCEIRO_2).
function computeSpecialPayslip(input) {
  const { kind, profile, competence } = input;
  const { params } = resolveParams(input.params, { onDay: cal.lastDay(competence), issuerId: profile.issuerId, storeId: profile.storeId });
  const items = [];
  const add = (type, code, label, cents, memo) => { if (cents) items.push({ type, code, label, cents, memo }); };
  const pendencies = [];
  const registered = profile.contractType !== 'SEM_REGISTRO' && profile.registered !== false;
  let base = 0;
  if (kind === 'FERIAS') {
    const f = legal.ferias({ monthlyCents: profile.baseSalaryCents, days: input.days || 30, variableAverageCents: input.variableAverageCents || 0 });
    add('PROVENTO', 'FERIAS', `Férias (${input.days || 30} dias)`, f.salaryCents, `(${brl(profile.baseSalaryCents)} + média variáveis ${brl(input.variableAverageCents || 0)}) × ${input.days || 30}/30`);
    add('PROVENTO', 'FERIAS_TERCO', '1/3 constitucional de férias', f.thirdCents, `${brl(f.salaryCents)} ÷ 3`);
    base = f.totalCents;
  } else if (kind === 'DECIMO_TERCEIRO_1' || kind === 'DECIMO_TERCEIRO_2') {
    const d = legal.decimoTerceiro({ monthlyCents: profile.baseSalaryCents, avos: input.avos, variableAverageCents: input.variableAverageCents || 0 });
    if (kind === 'DECIMO_TERCEIRO_1') {
      add('PROVENTO', 'DECIMO_TERCEIRO_1', `13º salário — 1ª parcela (${input.avos}/12)`, Math.round(d.totalCents / 2), `metade de ${brl(d.totalCents)}; sem INSS/IRRF nesta parcela`);
    } else {
      add('PROVENTO', 'DECIMO_TERCEIRO', `13º salário (${input.avos}/12)`, d.totalCents, `(${brl(profile.baseSalaryCents)} + média ${brl(input.variableAverageCents || 0)}) × ${input.avos}/12`);
      add('DESCONTO', 'DECIMO_TERCEIRO_ADIANT', '13º — 1ª parcela já paga', input.firstInstallmentCents || 0, 'Pago até 30/11');
      base = d.totalCents;
    }
  } else throw new Error('tipo de recibo inválido: ' + kind);
  let inssCalc = null, irrfCalc = null;
  if (registered && base) {
    if (!params.INSS_EMPREGADO || !params.IRRF_MENSAL) pend(pendencies, 'PARAM', 'Sem tabela INSS/IRRF vigente.');
    else {
      inssCalc = legal.inss(base, params.INSS_EMPREGADO);
      add('DESCONTO', 'INSS', 'INSS', inssCalc.valueCents, 'tabela progressiva vigente');
      irrfCalc = legal.irrf({ taxableIncomeCents: base, inssCents: inssCalc.valueCents, dependents: profile.irrfDependents || 0 }, params.IRRF_MENSAL, kind === 'FERIAS' ? params.IRRF_REDUTOR : null);
      add('DESCONTO', 'IRRF', kind === 'FERIAS' ? 'IRRF' : 'IRRF sobre 13º (tributação exclusiva)', irrfCalc.valueCents, `base ${brl(irrfCalc.baseCents)}`);
    }
  }
  const gross = items.filter((i) => i.type === 'PROVENTO').reduce((s, i) => s + i.cents, 0);
  const deductions = items.filter((i) => i.type === 'DESCONTO').reduce((s, i) => s + i.cents, 0);
  return { competence, kind, provisional: false, items, bases: { contributionBaseCents: base, inss: inssCalc, irrf: irrfCalc,
    fgts: registered && params.FGTS ? legal.fgts(kind === 'DECIMO_TERCEIRO_1' ? Math.round((profile.baseSalaryCents * input.avos / 12) / 2) : base, params.FGTS, profile.contractType === 'APRENDIZ') : null },
  totals: { grossCents: gross, deductionsCents: deductions, netCents: gross - deductions }, pendencies, blocking: pendencies.length };
}

module.exports = { computePayslip, computeSpecialPayslip, CONTRACTS, ENTRY_LABEL, bondDays };
