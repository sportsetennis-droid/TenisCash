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

function scheduleDeadlineState(day, checkpointHour) {
  const start = parseScheduleMinutes(day?.scheduleStart);
  let end = parseScheduleMinutes(day?.scheduleEnd);
  if (start === null || end === null) {
    return { scheduleKnown: false, duePhases: new Set() };
  }
  if (end <= start) end += 1440;

  let checkpoint = Number(checkpointHour) * 60;
  if (checkpoint < start && end > 1440) checkpoint += 1440;
  const midpoint = start + Math.floor((end - start) / 2);
  const duePhases = new Set();
  if (checkpoint >= start) duePhases.add('ARRIVAL');
  if (checkpoint >= midpoint) duePhases.add('FIRST_TURN');
  if (checkpoint >= end) {
    duePhases.add('SECOND_TURN');
    duePhases.add('EXIT');
  }
  return { scheduleKnown: true, start, midpoint, end, checkpoint, duePhases };
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
  scheduleDeadlineState,
  classifyProductionDay,
  splitWhatsAppText,
};
