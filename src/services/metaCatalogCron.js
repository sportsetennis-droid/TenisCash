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

function startMetaCatalogCron() {
  if (!metaSync.isEnabled()) {
    console.log('[metaCatalogCron] inativo (falta META_CATALOG_ID/META_CATALOG_TOKEN) — nao roda');
    return;
  }
  let busy = false;
  // A cada 15 min: upsert (items_batch) de todos os vendáveis no catálogo da Meta.
  cron.schedule('*/15 * * * *', async () => {
    if (busy) return; // não empilha
    busy = true;
    try {
      const r = await metaSync.syncAll();
      if (r.ok) console.log('[metaCatalogCron] sync ok: ' + r.sent + '/' + r.items + ' itens enviados');
      else console.log('[metaCatalogCron] skip/erro: ' + (r.skip || JSON.stringify(r.errors || []).slice(0, 200)));
    } catch (e) { console.error('[metaCatalogCron] erro:', e.message); }
    finally { busy = false; }
  }, { timezone: TZ });
  console.log('[metaCatalogCron] agendado (a cada 15 min, ' + TZ + ') — catalogo Meta reflete sozinho');
}

module.exports = { startMetaCatalogCron };
