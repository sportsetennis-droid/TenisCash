// =====================================================================
// Cron do Motor de Catálogo — de hora em hora analisa um lote de produtos.
// Regra CLAUDE.md: timezone explícito America/Fortaleza.
// =====================================================================
const cron = require('node-cron');
const TZ = 'America/Fortaleza';

function startCatalogEngineCron() {
  const engine = require('./catalogEngine');
  // :15 de cada hora — lote de produtos perto de prontos (tem imagem).
  cron.schedule('15 * * * *', async () => {
    try {
      const out = await engine.runBatch({ limit: 12, mode: 'quase' });
      console.log('[catalogEngineCron] lote:', out.processed, 'analisados ·', out.ready, 'prontos');
    } catch (e) { console.error('[catalogEngineCron] erro:', e.message); }
  }, { timezone: TZ });
  // :45 — lote dos sem imagem (pra ir buscando/flagando foto).
  cron.schedule('45 * * * *', async () => {
    try {
      const out = await engine.runBatch({ limit: 8, mode: 'sem-imagem' });
      console.log('[catalogEngineCron] lote sem-imagem:', out.processed, 'analisados');
    } catch (e) { console.error('[catalogEngineCron] erro:', e.message); }
  }, { timezone: TZ });
  console.log('[catalogEngineCron] agendado (de hora em hora — :15 e :45, ' + TZ + ')');
}

module.exports = { startCatalogEngineCron };
