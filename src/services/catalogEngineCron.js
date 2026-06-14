// =====================================================================
// Cron do Motor de Catálogo — de hora em hora analisa um lote de produtos.
// Regra CLAUDE.md: timezone explícito America/Fortaleza.
// =====================================================================
const cron = require('node-cron');
const TZ = 'America/Fortaleza';

function startCatalogEngineCron() {
  // Pendura junto o cron de SINCRONIZAÇÃO DE ESTOQUE Nuvemshop (sempre ligado, independente
  // do gate abaixo) — espelha físico → loja + sobe marcados. Hook aqui pra não tocar no index.js.
  try { require('./nuvemshopStockCron').startNuvemshopStockCron(); } catch (e) { console.error('[nsStockCron] falha ao iniciar:', e.message); }

  // Catálogo da Meta (FB/IG/WhatsApp) — reflete sozinho. Gated por META_CATALOG_ID+TOKEN.
  try { require('./metaCatalogCron').startMetaCatalogCron(); } catch (e) { console.error('[metaCatalogCron] falha ao iniciar:', e.message); }

  // DESLIGADO por padrão pra NÃO gastar API à toa. O dono liga só quando quiser,
  // setando CATALOG_ENGINE_CRON=on no Railway. Sem isso, não roda e não gasta nada.
  if (process.env.CATALOG_ENGINE_CRON !== 'on') {
    console.log('[catalogEngineCron] DESLIGADO (sem CATALOG_ENGINE_CRON=on) — nao gasta API');
    return;
  }
  const engine = require('./catalogEngine');
  let busy = false;
  // A cada 10 min: grinda o catálogo (server-side = sem limite de timeout do Cloudflare).
  // Prioriza quem tem imagem (mais perto de pronto); quando esgota, vai pros sem-imagem.
  cron.schedule('*/10 * * * *', async () => {
    if (busy) return; // não empilha se um lote ainda está rodando
    busy = true;
    try {
      let out = await engine.runBatch({ limit: 20, mode: 'quase' });
      if ((out.processed || 0) === 0) out = await engine.runBatch({ limit: 15, mode: 'sem-imagem' });
      console.log('[catalogEngineCron] +' + out.processed + ' analisados · ' + out.ready + ' prontos');
    } catch (e) { console.error('[catalogEngineCron] erro:', e.message); }
    finally { busy = false; }
  }, { timezone: TZ });
  console.log('[catalogEngineCron] agendado (a cada 10 min, ' + TZ + ') — grind autônomo do catálogo');
}

module.exports = { startCatalogEngineCron };
