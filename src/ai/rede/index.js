// =====================================================================
// REDE NEURAL DE AGENTES — ponto de entrada (docs/REDE-NEURAL-DE-AGENTES.md)
//   uso (de src/): importe a pasta ai/rede e chame
//   rede.sensor('nfe.importada', { documentId })   // borda da rede
// Liga/desliga: RNA_ATIVA=0 desliga tudo. Teto de IA: RNA_ORCAMENTO_DIA_RS.
// =====================================================================
const motor = require('./motor');
const { sensor, SENSORES } = require('./sensores');
const aprendizado = require('./aprendizado');
const objetivos = require('./objetivos');

let iniciado = false;
async function iniciar() {
  if (iniciado) return;
  iniciado = true;
  const r = motor.iniciar();
  try { await motor.sincronizar(); } catch (e) { console.error('[RNA] sincronizar neurônios:', e.message); }
  console.log(`[RNA] rede iniciada: ${r.neuronios} neurônios${r.erros.length ? ' (' + r.erros.length + ' com erro)' : ''}${process.env.RNA_ATIVA === '0' ? ' — DESLIGADA (RNA_ATIVA=0)' : ''}`);
  try { require('./relogio').agendar(); } catch (e) { console.error('[RNA] relógio:', e.message); }
}

module.exports = { iniciar, estaIniciada: () => iniciado, sensor, SENSORES, emitir: motor.emitir, motor, aprendizado, objetivos };
