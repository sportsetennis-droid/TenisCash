// =====================================================================
// Guarda dos cupons de atleta/Creation na Nuvemshop (dono 27/11/2026).
// Origem: o JOCA10 estava ativo no sistema, mas o cupom tinha sido apagado na
// Nuvemshop ("Cupom inválido ou indisponível" no checkout) e ninguém percebeu.
// De hora em hora: todo cupom ATIVO no sistema tem que existir e estar válido na loja.
//   - sumiu  → procura pelo código; se não achar, recria (mesmo código e mesmo %);
//   - existe mas desligado → religa;
//   - cupom PAUSADO no sistema não é mexido.
// Nunca derruba o servidor: erro vira registro no estado (/api/health → cupomNuvemshop).
// Desligar: CUPOM_NS_GUARDA=0.
// =====================================================================
const HORA = 60 * 60 * 1000;
const state = { enabled: true, running: false, lastStartedAt: null, lastFinishedAt: null, lastError: null, lastResult: null };

async function verificarCupons({ prisma, ns } = {}) {
  prisma = prisma || require('../middleware').prisma;
  ns = ns || require('./nuvemshop');
  const out = { checked: 0, ok: 0, recriados: [], religados: [], erros: [] };
  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
  if (!conn) return { ...out, semConexao: true };
  const partners = await prisma.partner.findMany({ where: { status: 'active' }, select: { id: true, couponCode: true, discountPct: true, nsCouponId: true } });
  for (const p of partners) {
    out.checked++;
    try {
      let cupom = null;
      if (p.nsCouponId) {
        try { cupom = await ns.nuvemshopApi(conn, 'GET', '/coupons/' + p.nsCouponId); }
        catch (e) { if (!/\b404\b/.test(String(e.message))) throw e; }
      }
      if (!cupom) {
        const lista = await ns.nuvemshopApi(conn, 'GET', '/coupons?q=' + encodeURIComponent(p.couponCode) + '&per_page=50'); // erro de rede sobe: não recria às cegas
        cupom = (Array.isArray(lista) ? lista : []).find((c) => String(c.code).toUpperCase() === p.couponCode.toUpperCase()) || null;
      }
      let nsId = cupom ? String(cupom.id) : null;
      if (!cupom) {
        const criado = await ns.createCoupon(conn, { code: p.couponCode, discountPct: p.discountPct, valid: true });
        nsId = criado && criado.id != null ? String(criado.id) : null;
        out.recriados.push(p.couponCode);
      } else if (!cupom.valid) {
        await ns.setCouponValid(conn, cupom.id, true);
        out.religados.push(p.couponCode);
      } else out.ok++;
      if (nsId && nsId !== p.nsCouponId) await prisma.partner.update({ where: { id: p.id }, data: { nsCouponId: nsId } });
    } catch (e) {
      out.erros.push(p.couponCode + ': ' + String(e.message).slice(0, 200));
    }
  }
  return out;
}

async function rodar() {
  if (state.running) return;
  state.running = true; state.lastStartedAt = new Date().toISOString();
  try {
    state.lastResult = await verificarCupons();
    state.lastError = null;
    const r = state.lastResult;
    if (r.recriados.length || r.religados.length) console.log('[cupom-ns] recriados:', r.recriados.join(',') || '-', '| religados:', r.religados.join(',') || '-');
  } catch (e) {
    state.lastError = e.message;
    console.error('[cupom-ns] falhou:', e.message);
  } finally {
    state.running = false; state.lastFinishedAt = new Date().toISOString();
  }
}

function startCupomNuvemshopGuarda() {
  if (process.env.CUPOM_NS_GUARDA === '0') { state.enabled = false; return; }
  setTimeout(rodar, 3 * 60 * 1000).unref();
  setInterval(rodar, HORA).unref();
}
function getCupomNuvemshopGuardaState() { return JSON.parse(JSON.stringify(state)); }

module.exports = { verificarCupons, startCupomNuvemshopGuarda, getCupomNuvemshopGuardaState };
