'use strict';

// Calendário da folha: dia local de João Pessoa (UTC-3 fixo, America/Fortaleza, sem
// horário de verão). Datas da folha são strings AAAA-MM-DD; competência é AAAA-MM.

const OFFSET_MS = 3 * 3600 * 1000;
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function isCompetence(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}
function isDayKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(value + 'T12:00:00Z'));
}
function dayKeyOf(date) {
  return new Date(new Date(date).getTime() - OFFSET_MS).toISOString().slice(0, 10);
}
function competenceOf(date) {
  return dayKeyOf(date).slice(0, 7);
}
function weekdayOf(dayKey) {
  return new Date(dayKey + 'T12:00:00Z').getUTCDay();
}
function addDays(dayKey, n) {
  const d = new Date(dayKey + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function monthDays(competence) {
  if (!isCompetence(competence)) throw new Error('competência inválida: ' + competence);
  const [y, m] = competence.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${competence}-${String(i + 1).padStart(2, '0')}`);
}
function firstDay(competence) { return competence + '-01'; }
function lastDay(competence) { const d = monthDays(competence); return d[d.length - 1]; }
// Início/fim do dia local em UTC (para consultar ClockIn/Sale por timestamp).
function dayStartUtc(dayKey) { return new Date(Date.parse(dayKey + 'T00:00:00Z') + OFFSET_MS); }
function dayEndUtc(dayKey) { return new Date(dayStartUtc(dayKey).getTime() + 86400000); }
function minutesOfDay(date) {
  const local = new Date(new Date(date).getTime() - OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}
function hhmm(date) {
  if (!date) return null;
  const m = minutesOfDay(date);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
// "HH:MM" de um dia local → Date UTC.
function localTimeToDate(dayKey, time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!match || +match[1] > 23 || +match[2] > 59) throw new Error('horário inválido: ' + time);
  return new Date(dayStartUtc(dayKey).getTime() + (+match[1] * 60 + +match[2]) * 60000);
}
function previousCompetence(competence) {
  const [y, m] = competence.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

module.exports = {
  WEEKDAYS, isCompetence, isDayKey, dayKeyOf, competenceOf, weekdayOf, addDays, monthDays,
  firstDay, lastDay, dayStartUtc, dayEndUtc, minutesOfDay, hhmm, localTimeToDate, previousCompetence,
};
