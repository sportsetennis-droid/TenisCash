'use strict';

// Jornada do mês a partir do Ponto Digital. Regras (dono, 16/11/2026):
// - nunca inventa entrada/retorno/saída: marcação incompleta vira PENDÊNCIA;
// - dia sem ponto não é falta: só FALTA_CONFIRMADA (marcação aprovada) desconta;
// - domingo e feriado trabalhados ficam FORA da carga semanal (dia especial à parte);
// - feriado reduz a carga da semana — nunca reduz e abona ao mesmo tempo;
// - folga compensatória só conta quando marcada e ligada ao domingo/feriado que compensa;
// - atestado/abono completam o dia até a carga prevista (nunca geram saldo negativo).

const cal = require('./calendar');

const CREDIT_KINDS = new Set(['ATESTADO', 'ABONO', 'FOLGA_COMPENSATORIA', 'FOLGA']);
const OFF_KINDS = new Set(['FERIAS', 'AFASTAMENTO']);

function groupPunches(punches) {
  const byDay = new Map();
  for (const p of [...(punches || [])].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))) {
    const key = cal.dayKeyOf(p.timestamp);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(p);
  }
  return byDay;
}

function nightMinutes(startMs, endMs, night) {
  if (!night || endMs <= startMs) return 0;
  let total = 0;
  for (let t = startMs; t < endMs; t += 60000) {
    const m = cal.minutesOfDay(t);
    if (night.startMinute > night.endMinute ? (m >= night.startMinute || m < night.endMinute) : (m >= night.startMinute && m < night.endMinute)) total++;
  }
  return total;
}

// Lê as batidas de um dia sem completar nada. open = ainda trabalhando (hoje).
function readDay(points, { isToday, nowMs, night }) {
  const issues = [];
  let entry = null, exit = null, breakStart = null, breakMinutes = 0, worked = 0, night_ = 0;
  let segStart = null;
  const breaks = [];
  for (const p of points) {
    const t = new Date(p.timestamp).getTime();
    if (p.type === 'entry') {
      if (segStart != null) issues.push('Duas entradas sem saída entre elas');
      if (entry == null) entry = p;
      segStart = t;
    } else if (p.type === 'break_start') {
      if (segStart == null) { issues.push('Início de intervalo sem entrada'); continue; }
      worked += (t - segStart) / 60000; night_ += nightMinutes(segStart, t, night);
      segStart = null; breakStart = p;
    } else if (p.type === 'break_end') {
      if (!breakStart) { issues.push('Retorno de intervalo sem início'); continue; }
      const b = (t - new Date(breakStart.timestamp).getTime()) / 60000;
      breakMinutes += b; breaks.push({ start: cal.hhmm(breakStart.timestamp), end: cal.hhmm(p.timestamp), minutes: Math.round(b) });
      breakStart = null; segStart = t;
    } else if (p.type === 'exit') {
      if (segStart == null && !breakStart) { issues.push('Saída sem entrada'); continue; }
      if (breakStart) { issues.push('Saída com intervalo sem retorno'); breakStart = null; }
      else { worked += (t - segStart) / 60000; night_ += nightMinutes(segStart, t, night); }
      segStart = null; exit = p;
    }
  }
  let open = false;
  if (segStart != null || breakStart) {
    if (isToday) {
      open = true;
      if (segStart != null) { worked += (nowMs - segStart) / 60000; night_ += nightMinutes(segStart, nowMs, night); }
    } else {
      issues.push(breakStart ? 'Intervalo sem retorno' : 'Entrada sem saída');
    }
  }
  if (!entry && points.length) issues.push('Sem registro de entrada');
  const gross = entry && (exit || open) ? Math.round(((exit ? new Date(exit.timestamp).getTime() : nowMs) - new Date(entry.timestamp).getTime()) / 60000) : 0;
  return {
    entry: entry ? cal.hhmm(entry.timestamp) : null,
    breakStart: breaks[0]?.start || (breakStart ? cal.hhmm(breakStart.timestamp) : null),
    breakEnd: breaks[0]?.end || null,
    exit: exit ? cal.hhmm(exit.timestamp) : null,
    breaks, grossMinutes: gross, breakMinutes: Math.round(breakMinutes),
    // Incompleto não soma horas inventadas: só os trechos fechados entram.
    workedMinutes: Math.round(worked),
    nightMinutes: Math.round(night_),
    complete: !issues.length && !open && !!entry && !!exit,
    open, issues,
    origins: [...new Set(points.map((p) => p.source || (p.note && /corre[cç][aã]o/i.test(p.note) ? 'correcao' : 'app')))],
    stores: [...new Set(points.map((p) => p.storeId).filter(Boolean))],
  };
}

function inBond(dayKey, profile) {
  if (profile.admissionDate && dayKey < profile.admissionDate) return false;
  if (profile.terminationDate && dayKey > profile.terminationDate) return false;
  return true;
}

// input: { competence, profile, punches, holidays: Map(day→name), marks: PayrollDayMark[],
//          shifts: Map(day→{start,end}) (escala), asOfDay, nowMs, night, corrections }
function buildTime(input) {
  const { competence, profile } = input;
  const asOfDay = input.asOfDay || cal.lastDay(competence);
  const nowMs = input.nowMs ?? Date.now();
  const holidays = input.holidays || new Map();
  const shifts = input.shifts || new Map();
  const byDay = groupPunches(input.punches);
  const marksByDay = new Map();
  for (const m of input.marks || []) {
    if (m.status && m.status !== 'APROVADO') continue;
    if (!marksByDay.has(m.date)) marksByDay.set(m.date, []);
    marksByDay.get(m.date).push(m);
  }
  const pendingCorrections = new Map();
  for (const c of input.corrections || []) if (c.status === 'PENDENTE') pendingCorrections.set(c.date, (pendingCorrections.get(c.date) || 0) + 1);
  const is12x36 = profile.contractType === 'ESCALA_12X36';
  const dailyExpected = Math.round((profile.weeklyMinutes || 2640) / (profile.workDaysPerWeek || 6));
  const days = [];
  for (const day of cal.monthDays(competence)) {
    const weekday = cal.weekdayOf(day);
    const marks = marksByDay.get(day) || [];
    const kinds = new Set(marks.map((m) => m.kind));
    const future = day > asOfDay;
    const bond = inBond(day, profile);
    const holiday = holidays.get(day) || null;
    const read = readDay(byDay.get(day) || [], { isToday: day === asOfDay, nowMs, night: input.night });
    const worked = read.workedMinutes;
    let expected = 0;
    if (bond && !OFF_KINDS.has([...kinds][0])) {
      if (is12x36) expected = shifts.has(day) ? (profile.shiftMinutes || 720) : 0;
      else if (weekday !== 0 && !holiday) expected = dailyExpected;
    }
    if ([...kinds].some((k) => OFF_KINDS.has(k))) expected = 0;
    let status;
    if (!bond) status = 'FORA_DO_VINCULO';
    else if (kinds.has('FERIAS')) status = 'FERIAS';
    else if (kinds.has('AFASTAMENTO')) status = 'AFASTAMENTO';
    else if (kinds.has('FALTA_CONFIRMADA')) status = 'FALTA_CONFIRMADA';
    else if (kinds.has('ATESTADO')) status = worked ? 'ATESTADO_PARCIAL' : 'ATESTADO';
    else if (read.issues.length) status = 'INCOMPLETO';
    else if (read.open) status = 'EM_ANDAMENTO';
    else if (worked > 0 && !is12x36 && weekday === 0) status = 'DOMINGO_TRABALHADO';
    else if (worked > 0 && !is12x36 && holiday) status = 'FERIADO_TRABALHADO';
    else if (worked > 0) status = 'COMPLETO';
    else if (kinds.has('FOLGA_COMPENSATORIA')) status = 'FOLGA_COMPENSATORIA';
    else if (kinds.has('FOLGA')) status = 'FOLGA';
    else if (kinds.has('ABONO')) status = 'ABONO';
    else if (future) status = 'FUTURO';
    else if (holiday) status = 'FERIADO';
    else if (!is12x36 && weekday === 0) status = 'DESCANSO';
    else if (is12x36 && !shifts.has(day)) status = 'DESCANSO';
    else status = 'SEM_PONTO';
    // Crédito: completa até a carga prevista do dia, sem passar dela.
    let credit = 0;
    if ([...kinds].some((k) => CREDIT_KINDS.has(k)) && expected) {
      const fixed = marks.find((m) => CREDIT_KINDS.has(m.kind) && m.minutes);
      credit = Math.max(0, Math.min(expected - worked, fixed ? fixed.minutes : expected));
    }
    const lateMinutes = marks.filter((m) => m.kind === 'ATRASO_CONFIRMADO').reduce((s, m) => s + (m.minutes || 0), 0);
    const pending = !future && bond && (status === 'INCOMPLETO' || status === 'SEM_PONTO');
    days.push({
      date: day, weekday, weekdayName: cal.WEEKDAYS[weekday], holiday, future, inBond: bond,
      ...read, expectedMinutes: future ? expected : expected, creditMinutes: credit, lateMinutes,
      marks: marks.map((m) => ({ id: m.id, kind: m.kind, refDate: m.refDate || null, note: m.note || null, minutes: m.minutes || null })),
      status, pending, pendingCorrections: pendingCorrections.get(day) || 0,
      scheduled: shifts.has(day) ? shifts.get(day) : null,
    });
  }
  const weeks = is12x36 ? [] : buildWeeks(days, asOfDay, !!input.final);
  const shiftsSummary = is12x36 ? build12x36(days, profile) : null;
  return { days, weeks, shifts12x36: shiftsSummary, dailyExpectedMinutes: dailyExpected, totals: totals(days, weeks, shiftsSummary, asOfDay) };
}

// Semana de segunda a sábado; domingo e feriado trabalhados não entram na soma.
// final = fechamento: o dia de corte (último do mês) já terminou, então a semana que
// acaba nele está encerrada. Na prévia, a semana do dia de hoje ainda está em curso.
function buildWeeks(days, asOfDay, final) {
  const ended = (day) => day < asOfDay || (final && day === asOfDay);
  const weeks = [];
  let current = null;
  for (const d of days) {
    if (d.weekday === 0) continue;
    if (!current || d.weekday === 1) { current = { days: [] }; weeks.push(current); }
    current.days.push(d);
  }
  return weeks.map((w) => {
    const upTo = w.days.filter((d) => d.date <= asOfDay && d.inBond);
    const sum = (list, f) => list.reduce((s, d) => s + f(d), 0);
    const regular = (d) => (d.status === 'FERIADO_TRABALHADO' ? 0 : d.workedMinutes);
    const expected = sum(upTo, (d) => d.expectedMinutes);
    const registered = sum(upTo, regular);
    const credited = sum(upTo, (d) => d.creditMinutes);
    const specialRemoved = sum(upTo, (d) => (d.status === 'FERIADO_TRABALHADO' ? d.workedMinutes : 0));
    const sunday = days.find((d) => d.weekday === 0 && d.date > w.days[w.days.length - 1].date && d.date <= cal.addDays(w.days[w.days.length - 1].date, 1));
    const pendingDays = upTo.filter((d) => d.pending).map((d) => d.date);
    const balance = registered + credited - expected;
    return {
      from: w.days[0].date, to: w.days[w.days.length - 1].date,
      fullWeek: w.days.length === 6, closed: ended(w.days[w.days.length - 1].date),
      expectedMinutes: expected, expectedFullMinutes: sum(w.days.filter((d) => d.inBond), (d) => d.expectedMinutes),
      registeredMinutes: registered, creditedMinutes: credited, specialRemovedMinutes: specialRemoved,
      sundayWorkedMinutes: sunday && sunday.status === 'DOMINGO_TRABALHADO' ? sunday.workedMinutes : 0,
      daysOffUsed: upTo.filter((d) => d.status === 'FOLGA_COMPENSATORIA' || d.status === 'FOLGA').map((d) => d.date),
      balanceMinutes: balance, pendingDays,
      extraMinutes: balance > 0 ? balance : 0,
      missingMinutes: balance < 0 ? -balance : 0,
      // Falta só vira desconto com FALTA_CONFIRMADA; saldo negativo com dia pendente é provisório.
      provisional: pendingDays.length > 0 || !ended(w.days[w.days.length - 1].date),
      lateMinutes: sum(upTo, (d) => d.lateMinutes),
      nightMinutes: sum(upTo, (d) => d.nightMinutes),
    };
  });
}

function build12x36(days, profile) {
  const shift = profile.shiftMinutes || 720;
  const worked = days.filter((d) => d.workedMinutes > 0);
  return {
    shiftMinutes: shift,
    scheduledShifts: days.filter((d) => d.scheduled).length,
    workedShifts: worked.length,
    // 12x36: extra só o que passar do plantão contratado — nunca "acima de 8h".
    extraMinutes: worked.reduce((s, d) => s + Math.max(0, d.workedMinutes - shift), 0),
    missingShifts: days.filter((d) => d.scheduled && d.pending).map((d) => d.date),
  };
}

function totals(days, weeks, s12, asOfDay) {
  const past = days.filter((d) => d.date <= asOfDay && d.inBond);
  const sum = (list, f) => list.reduce((s, d) => s + f(d), 0);
  const specialDays = past.filter((d) => d.status === 'DOMINGO_TRABALHADO' || d.status === 'FERIADO_TRABALHADO');
  return {
    expectedMinutes: s12 ? sum(past, (d) => d.expectedMinutes) : sum(weeks, (w) => w.expectedMinutes),
    registeredMinutes: sum(past, (d) => d.workedMinutes),
    regularMinutes: s12 ? sum(past, (d) => Math.min(d.workedMinutes, d.expectedMinutes || d.workedMinutes)) : sum(weeks, (w) => w.registeredMinutes) - sum(weeks, (w) => w.extraMinutes > 0 ? w.extraMinutes : 0),
    breakMinutes: sum(past, (d) => d.breakMinutes),
    creditedMinutes: sum(past, (d) => d.creditMinutes),
    extraMinutes: s12 ? s12.extraMinutes : sum(weeks, (w) => w.extraMinutes),
    extraConfirmedMinutes: s12 ? s12.extraMinutes : sum(weeks.filter((w) => !w.provisional), (w) => w.extraMinutes),
    missingMinutes: s12 ? 0 : sum(weeks, (w) => w.missingMinutes),
    specialMinutes: sum(specialDays, (d) => d.workedMinutes),
    nightMinutes: sum(past, (d) => d.nightMinutes),
    lateConfirmedMinutes: sum(past, (d) => d.lateMinutes),
    sundaysWorked: past.filter((d) => d.status === 'DOMINGO_TRABALHADO').length,
    holidaysWorked: past.filter((d) => d.status === 'FERIADO_TRABALHADO').length,
    daysWithoutPunch: past.filter((d) => d.status === 'SEM_PONTO').map((d) => d.date),
    incompleteDays: past.filter((d) => d.status === 'INCOMPLETO').map((d) => ({ date: d.date, issues: d.issues })),
    sickDays: past.filter((d) => d.status.startsWith('ATESTADO')).map((d) => d.date),
    allowances: past.filter((d) => d.status === 'ABONO').map((d) => d.date),
    confirmedAbsences: past.filter((d) => d.status === 'FALTA_CONFIRMADA').map((d) => d.date),
  };
}

module.exports = { buildTime, readDay, groupPunches };
