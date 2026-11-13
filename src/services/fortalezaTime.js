// =====================================================================
// Horário de João Pessoa/PB (America/Fortaleza = UTC-3 fixo, sem horário
// de verão). O servidor no Railway roda em UTC; sem isto, "19:00" digitado
// no app vira 19:00 UTC = 16:00 em João Pessoa.
// =====================================================================

const TZ = 'America/Fortaleza';
const OFFSET_MS = 3 * 3600 * 1000; // UTC-3

// "2026-11-12T19:00" (datetime-local, sem fuso) → instante em Fortaleza.
// String com fuso explícito (Z, +hh:mm) ou Date → respeita como veio.
function parseLocal(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value) ? null : value;
  const s = String(value).trim();
  const naive = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const d = new Date(naive ? s + '-03:00' : s);
  return isNaN(d) ? null : d;
}

// Relógio de parede em Fortaleza → Date (instante UTC correto).
function wallClock(year, monthIndex, day, hh, mm) {
  return new Date(Date.UTC(year, monthIndex, day, hh, mm, 0, 0) + OFFSET_MS);
}

// Partes do relógio de parede em Fortaleza para um instante.
function partsOf(date) {
  const l = new Date(date.getTime() - OFFSET_MS);
  return { year: l.getUTCFullYear(), month: l.getUTCMonth(), day: l.getUTCDate(), weekday: l.getUTCDay(), hh: l.getUTCHours(), mm: l.getUTCMinutes() };
}

function fmtDayTime(date) {
  return new Date(date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TZ });
}
function fmtTime(date) {
  return new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

module.exports = { TZ, parseLocal, wallClock, partsOf, fmtDayTime, fmtTime };
