const cron = require('node-cron');
const { reconcileQROffers } = require('../routes/qrOffers');

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await reconcileQROffers();
    if (result.activated || result.scheduled || result.expired || result.errors.length) {
      console.log('[qrOffersCron]', JSON.stringify(result));
    }
  } catch (err) {
    console.error('[qrOffersCron] falha:', err.message);
  } finally {
    running = false;
  }
}

function startQROffersCron() {
  // Repara ofertas antigas logo após o deploy e mantém a janela de validade
  // alinhada a cada minuto. O cupom também carrega start_date/end_date como
  // proteção independente caso o processo fique temporariamente indisponível.
  setTimeout(() => tick(), 5000);
  cron.schedule('* * * * *', tick, { timezone: 'America/Fortaleza' });
}

module.exports = { startQROffersCron, tick };
