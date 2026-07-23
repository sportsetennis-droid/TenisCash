// Regras puras do relatório de cumprimento das atividades do vendedor.
// O relatório só aponta uma tarefa pendente/devolvida como não cumprida
// quando o prazo calculado a partir da escala já foi alcançado.

const PHASES = Object.freeze(['ARRIVAL', 'FIRST_TURN', 'SECOND_TURN', 'EXIT']);

function parseScheduleMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return (hour * 60) + minute;
}

function checkpointToMinutes(value) {
  if (typeof value === 'string' && value.includes(':')) return parseScheduleMinutes(value);
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  // Compatibilidade: 13 continua significando 13h; 780 significa minuto do dia.
  if (numeric <= 24) return Math.round(numeric * 60);
  if (numeric < 2880) return Math.round(numeric);
  return null;
}

function formatMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return '';
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

/**
 * Horários do relatório global:
 * primeira escala do dia + 1h; depois, a cada 3h, até alcançar o fechamento
 * da última escala. Horários inválidos são ignorados, nunca estimados.
 */
function buildTaskReportSchedule(shifts, options = {}) {
  const valid = [];
  for (const shift of Array.isArray(shifts) ? shifts : []) {
    const start = parseScheduleMinutes(shift?.scheduleStart ?? shift?.startTime);
    let end = parseScheduleMinutes(shift?.scheduleEnd ?? shift?.endTime);
    if (start === null || end === null) continue;
    if (end <= start) end += 1440;
    valid.push({ start, end });
  }
  const observedOpening = checkpointToMinutes(options.openingMinutes);
  if (!valid.length && observedOpening === null) {
    return { scheduleKnown: false, openingMinutes: null, closingMinutes: null, slots: [] };
  }

  const openingMinutes = observedOpening === null
    ? Math.min(...valid.map((row) => row.start))
    : observedOpening;
  // Sem fechamento cadastrado, mantém o ciclo somente dentro do dia corrente.
  const closingMinutes = valid.length ? Math.max(...valid.map((row) => row.end)) : 1439;
  const firstReportMinutes = openingMinutes + 60;
  const slots = firstReportMinutes < 1440 ? [firstReportMinutes] : [];
  while (slots[slots.length - 1] < closingMinutes && slots.length < 12) {
    const next = slots[slots.length - 1] + 180;
    if (next >= 1440) break;
    slots.push(next);
  }
  return {
    scheduleKnown: true,
    openingMinutes,
    closingMinutes,
    firstReportMinutes,
    slots,
  };
}

function scheduleDeadlineState(day, checkpointValue) {
  const start = parseScheduleMinutes(day?.scheduleStart);
  let end = parseScheduleMinutes(day?.scheduleEnd);
  let checkpoint = checkpointToMinutes(checkpointValue);
  if (start === null || checkpoint === null) {
    return { scheduleKnown: false, endKnown: false, duePhases: new Set() };
  }
  const endKnown = end !== null;
  if (endKnown && end <= start) end += 1440;

  if (endKnown && checkpoint < start && end > 1440) checkpoint += 1440;
  const cap = (value) => (endKnown ? Math.min(value, end) : value);
  const deadlines = {
    ARRIVAL: cap(start + 60),
    FIRST_TURN: cap(start + 240),
    SECOND_TURN: cap(start + 420),
    EXIT: endKnown ? end : null,
  };
  const duePhases = new Set();
  for (const phase of PHASES) {
    if (deadlines[phase] !== null && checkpoint >= deadlines[phase]) duePhases.add(phase);
  }
  return { scheduleKnown: true, endKnown, start, end, checkpoint, deadlines, duePhases };
}

function classifyProductionDay(day, checkpointHour) {
  const deadline = scheduleDeadlineState(day, checkpointHour);
  const result = {
    approved: [],
    awaitingReview: [],
    noncompliant: [],
    correctionInTime: [],
    notDue: [],
    excused: [],
    scheduleKnown: deadline.scheduleKnown,
    endKnown: deadline.endKnown,
    duePhases: deadline.duePhases,
    dayExcused: day?.status === 'EXCUSED',
  };

  const items = Array.isArray(day?.items)
    ? day.items.slice().sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    : [];

  if (result.dayExcused) {
    result.excused.push(...items);
    return result;
  }

  for (const item of items) {
    if (item.status === 'APPROVED') {
      result.approved.push(item);
      continue;
    }
    if (item.status === 'EXCUSED') {
      result.excused.push(item);
      continue;
    }
    if (day?.status === 'NONCOMPLIANT') {
      result.noncompliant.push(item);
      continue;
    }
    if (item.status === 'SUBMITTED') {
      result.awaitingReview.push(item);
      continue;
    }

    const deadlineReached = deadline.scheduleKnown && deadline.duePhases.has(item.phase);
    if (deadlineReached) {
      result.noncompliant.push(item);
    } else if (item.status === 'REJECTED') {
      result.correctionInTime.push(item);
    } else {
      result.notDue.push(item);
    }
  }
  return result;
}

function splitWhatsAppText(text, maxChars = 3500) {
  const max = Math.max(500, Number(maxChars) || 3500);
  const lines = String(text || '').split('\n');
  const chunks = [];
  let current = '';

  for (const originalLine of lines) {
    let line = originalLine;
    while (line.length > max) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(line.slice(0, max));
      line = line.slice(max);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

module.exports = {
  PHASES,
  parseScheduleMinutes,
  checkpointToMinutes,
  formatMinutes,
  buildTaskReportSchedule,
  scheduleDeadlineState,
  classifyProductionDay,
  splitWhatsAppText,
};
