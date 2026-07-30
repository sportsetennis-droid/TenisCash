// =====================================================================
// Cron de AUTO-HEALING da conexão WhatsApp (Evolution).
// A cada 5 min verifica as instâncias críticas (que enviam relatórios do
// sistema e códigos de login). Se a conexão cair e persistir, dá restart
// automático. Expõe o estado no /api/health (campo waHealth). NÃO envia
// mensagem (só reconecta) — então não depende do canal que caiu.
//
// Config por env:
//   WA_HEALTH_INSTANCES  (default 'teniscash')  — lista separada por vírgula
//   DISABLE_WA_HEALTH_CRON=1                     — desliga o monitor
// Regra de timezone dos crons: ver CLAUDE.md.
// =====================================================================
const cron = require('node-cron');

const API = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const KEY = process.env.EVOLUTION_API_KEY || '';
const INSTANCES = (process.env.WA_HEALTH_INSTANCES || 'teniscash')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_RESTARTS = 3;      // após isso, espera repareamento (QR) e só sinaliza
const DOWN_BEFORE_RESTART = 2; // ciclos caído (≈10 min) antes de forçar restart — dá chance à reconexão automática

const state = {}; // inst -> { lastState, lastCheck, consecutiveDown, restarts, needsQR, lastRestartAt }

async function connState(inst) {
  try {
    const r = await fetch(`${API}/instance/connectionState/${encodeURIComponent(inst)}`, { headers: { apikey: KEY } });
    const j = await r.json();
    return j && j.instance && j.instance.state ? j.instance.state : 'unknown';
  } catch (e) { return 'error'; }
}
async function restart(inst) {
  try {
    const r = await fetch(`${API}/instance/restart/${encodeURIComponent(inst)}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' } });
    return r.status;
  } catch (e) { return 0; }
}

async function checkOnce() {
  if (!API || !KEY) return;
  for (const inst of INSTANCES) {
    const st = await connState(inst);
    const s = state[inst] || { consecutiveDown: 0, restarts: 0, needsQR: false };
    s.lastState = st;
    s.lastCheck = new Date().toISOString();

    if (st === 'open') {
      if (s.restarts > 0 || s.needsQR) console.log(`[waHealth] ${inst} RECONECTADO (open) após ${s.restarts} tentativa(s)`);
      s.consecutiveDown = 0; s.restarts = 0; s.needsQR = false;
    } else if (st === 'connecting' || st === 'close' || st === 'error') {
      s.consecutiveDown = (s.consecutiveDown || 0) + 1;
      if (s.consecutiveDown >= DOWN_BEFORE_RESTART && s.restarts < MAX_RESTARTS) {
        const code = await restart(inst);
        s.restarts++; s.lastRestartAt = new Date().toISOString();
        console.log(`[waHealth] ${inst} '${st}' há ${s.consecutiveDown} ciclos -> restart #${s.restarts} (HTTP ${code})`);
      } else if (s.restarts >= MAX_RESTARTS && !s.needsQR) {
        s.needsQR = true;
        console.error(`[waHealth] ${inst} CAÍDO após ${MAX_RESTARTS} restarts — precisa reparear (QR). Sinalizado em /api/health.`);
      }
    }
    state[inst] = s;
  }
}

// Consumido pelo /api/health — dá pra ver o estado a qualquer momento sem depender do WhatsApp.
function getWhatsappHealthState() {
  const out = {};
  for (const i of INSTANCES) {
    const s = state[i] || {};
    out[i] = { state: s.lastState || 'unchecked', lastCheck: s.lastCheck || null, restarts: s.restarts || 0, needsQR: !!s.needsQR };
  }
  return out;
}

function startWhatsappHealthCron() {
  if (!API || !KEY) { console.log('[waHealth] Evolution não configurado — monitor não iniciado'); return; }
  if (process.env.DISABLE_WA_HEALTH_CRON === '1') { console.log('[waHealth] desativado por env'); return; }
  cron.schedule('*/5 * * * *', () => { checkOnce().catch((e) => console.error('[waHealth] erro:', e.message)); });
  setTimeout(() => { checkOnce().catch(() => {}); }, 15000); // 1ª verificação 15s após boot
  console.log(`[waHealth] monitor iniciado (a cada 5 min | instâncias: ${INSTANCES.join(', ')})`);
}

module.exports = { startWhatsappHealthCron, getWhatsappHealthState, checkWhatsappOnce: checkOnce };
