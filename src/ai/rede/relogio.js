// =====================================================================
// RNA — sensor de tempo (America/Fortaleza). Só pulsa a rede; quem
// decide o que fazer são os neurônios que escutam relogio.*.
// =====================================================================
const cron = require('node-cron');
const { sensor } = require('./sensores');
const objetivos = require('./objetivos');

const TZ = { timezone: 'America/Fortaleza' };
let agendado = false;

function agendar() {
  if (agendado || process.env.RNA_RELOGIO === '0') return;
  agendado = true;
  cron.schedule('17 * * * *', () => sensor('relogio.hora', { quando: new Date().toISOString() }), TZ);
  cron.schedule('41 6 * * *', () => {
    sensor('relogio.diario', { quando: new Date().toISOString() });
    objetivos.pulsar().catch((e) => console.error('[RNA] pulso objetivos:', e.message));
  }, TZ);
  cron.schedule('23 6 * * 1', () => sensor('relogio.semanal', { quando: new Date().toISOString() }), TZ);
  cron.schedule('9 6 1 * *', () => sensor('relogio.mensal', { quando: new Date().toISOString() }), TZ);
  console.log('[RNA] relógio agendado (hora :17 · diário 06:41 · semanal seg 06:23 · mensal dia 1 06:09, Fortaleza)');
}

module.exports = { agendar };
