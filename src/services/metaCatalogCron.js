// =====================================================================
// Cron do Catálogo da Meta — espelha o catálogo vendável no Commerce Manager
// (alimenta Facebook, Instagram e WhatsApp). Reflete sozinho, igual Nuvemshop.
// =====================================================================
// GATED: só agenda se META_CATALOG_ID + META_CATALOG_TOKEN estiverem setados
// (isEnabled). Sem isso, fica inerte — não roda, não gasta, não polui log.
// Regra CLAUDE.md: timezone explícito America/Fortaleza.
// =====================================================================
const cron = require('node-cron');
const TZ = 'America/Fortaleza';
const metaSync = require('./metaCatalogSync');

let busy = false;
function startMetaCatalogCron() {
  // Agenda SEMPRE. A cada tick recarrega a config (env ou banco/botão) e só roda se
  // estiver conectado (token+catalogId). Assim, quando o dono conecta pelo botão do
  // admin, liga no próximo ciclo SEM redeploy.
  cron.schedule('*/15 * * * *', async () => {
    if (busy) return; // não empilha
    busy = true;
    try {
      await metaSync.loadConfig();
      if (!metaSync.isEnabled()) return; // ainda não conectado — não erra à toa
      const r = await metaSync.syncAll();
      if (r.ok) console.log('[metaCatalogCron] sync ok: ' + r.sent + ' enviados, ' + (r.deleted || 0) + ' removidos');
      else console.log('[metaCatalogCron] skip/erro: ' + (r.skip || JSON.stringify(r.errors || []).slice(0, 200)));
    } catch (e) { console.error('[metaCatalogCron] erro:', e.message); }
    finally { busy = false; }
  }, { timezone: TZ });
  console.log('[metaCatalogCron] agendado (a cada 15 min, ' + TZ + ') — reflete a loja quando conectado');
}

module.exports = { startMetaCatalogCron };
