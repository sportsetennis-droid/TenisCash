const cron = require('node-cron');
const { reconcileQROffers } = require('../routes/qrOffers');

let running = false;
const state = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastResult: null,
  lastError: null,
};

async function tick() {
  if (running) return;
  running = true;
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  state.lastError = null;
  try {
    const result = await reconcileQROffers();
    state.lastResult = result;
    if (result.activated || result.scheduled || result.expired
      || result.staleCategoriesDeleted || result.staleCouponsDisabled
      || result.errors.length) {
      console.log('[qrOffersCron]', JSON.stringify(result));
    }
  } catch (err) {
    state.lastError = err.message;
    console.error('[qrOffersCron] falha:', err.message);
  } finally {
    running = false;
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
  }
}

function getQROffersCronState() {
  return JSON.parse(JSON.stringify(state));
}

function startQROffersCron() {
  // Repara ofertas antigas logo após o deploy e mantém a janela de validade
  // alinhada a cada minuto. O cupom também carrega start_date/end_date como
  // proteção independente caso o processo fique temporariamente indisponível.
  setTimeout(() => tick(), 5000);
  cron.schedule('* * * * *', tick, { timezone: 'America/Fortaleza' });
}

module.exports = { startQROffersCron, tick, getQROffersCronState };
