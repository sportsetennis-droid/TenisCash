// =====================================================================
// Fuso em calendário .ics — o ical-generator escreve DTSTART;TZID=... usando
// o RELÓGIO DA MÁQUINA (getHours), não o fuso informado. No Railway a
// máquina é UTC: um jogo às 19:00 de Fortaleza sairia "22:00" no calendário.
// paraParede(d) devolve um Date cujo horário LOCAL da máquina é igual ao
// horário de parede em America/Fortaleza (UTC-3 fixo, sem horário de verão),
// funcione o servidor em UTC ou em -03.
// =====================================================================
const FORTALEZA_OFFSET_MIN = -180; // UTC-3 fixo (CLAUDE.md: usar America/Fortaleza, não São Paulo)

function paraParede(d) {
  if (!d) return d;
  const dt = d instanceof Date ? d : new Date(d);
  // local(x) = x - tzo  e  fortaleza(dt) = dt + offset  →  x = dt + offset + tzo
  return new Date(dt.getTime() + (FORTALEZA_OFFSET_MIN + dt.getTimezoneOffset()) * 60000);
}

module.exports = { paraParede, FORTALEZA_OFFSET_MIN };
