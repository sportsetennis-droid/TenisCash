// =====================================================================
// Glicko-2 — implementação fiel ao paper de Mark E. Glickman
// "Example of the Glicko-2 system" (2012, domínio público).
// ---------------------------------------------------------------------
// Função pura, sem banco. Escala original: rating 1500, RD 350, σ 0.06.
// Passos do paper:
//   1) converte pra escala Glicko-2 (μ, φ)
//   2) v  = [Σ g(φj)² E (1−E)]⁻¹
//   3) Δ  = v Σ g(φj)(sj − E)
//   4) nova volatilidade σ' (algoritmo de Illinois, ε = 0.000001)
//   5) φ* = √(φ² + σ'²)
//   6) φ' = 1/√(1/φ*² + 1/v) ;  μ' = μ + φ'² Σ g(φj)(sj − E)
//   7) volta pra escala original
// Jogador sem jogo no período: só φ' = √(φ² + σ²) (RD cresce).
// =====================================================================

const SCALE = 173.7178;
const DEFAULT_RATING = 1500;
const DEFAULT_RD = 350;
const DEFAULT_VOL = 0.06;
const DEFAULT_TAU = 0.5; // restringe a variação da volatilidade (paper: 0.3–1.2)
const EPSILON = 0.000001;

function toMu(rating) { return (rating - DEFAULT_RATING) / SCALE; }
function toPhi(rd) { return rd / SCALE; }
function fromMu(mu) { return mu * SCALE + DEFAULT_RATING; }
function fromPhi(phi) { return phi * SCALE; }

function g(phi) { return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI)); }
function E(mu, muj, phij) { return 1 / (1 + Math.exp(-g(phij) * (mu - muj))); }

// Passo 4: volatilidade nova pelo método de Illinois (paper, seção 5.1)
function newVolatility(phi, sigma, v, delta, tau) {
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (tau * tau);
  };
  let A = a;
  let B;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k += 1;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > EPSILON && guard < 200) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA = fA / 2; }
    B = C;
    fB = fC;
    guard += 1;
  }
  return Math.exp(A / 2);
}

/**
 * Atualiza um jogador após um período.
 * @param {{rating:number, rd:number, vol:number}} player
 * @param {Array<{rating:number, rd:number, score:number}>} results  score 1 | 0.5 | 0
 * @param {{tau?:number, maxRd?:number}} [opts]
 * @returns {{rating:number, rd:number, vol:number}}
 */
function updatePlayer(player, results, opts = {}) {
  const tau = opts.tau || DEFAULT_TAU;
  const maxRd = opts.maxRd || DEFAULT_RD;
  const mu = toMu(player.rating);
  const phi = toPhi(player.rd);
  const sigma = player.vol;

  if (!results || !results.length) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { rating: player.rating, rd: Math.min(fromPhi(phiStar), maxRd), vol: sigma };
  }

  let vInv = 0;
  let sum = 0;
  for (const r of results) {
    const muj = toMu(r.rating);
    const phij = toPhi(r.rd);
    const gj = g(phij);
    const e = E(mu, muj, phij);
    vInv += gj * gj * e * (1 - e);
    sum += gj * (r.score - e);
  }
  const v = 1 / vInv;
  const delta = v * sum;
  const sigmaP = newVolatility(phi, sigma, v, delta, tau);
  const phiStar = Math.sqrt(phi * phi + sigmaP * sigmaP);
  const phiP = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muP = mu + phiP * phiP * sum;
  return { rating: fromMu(muP), rd: Math.min(fromPhi(phiP), maxRd), vol: sigmaP };
}

// RD após `periods` períodos sem jogar (σ constante enquanto parado).
function inflateRd(rd, vol, periods, maxRd = DEFAULT_RD) {
  if (!periods || periods <= 0) return rd;
  const phi = toPhi(rd);
  const phiP = Math.sqrt(phi * phi + periods * vol * vol);
  return Math.min(fromPhi(phiP), maxRd);
}

// Adversário "composto" (dupla): média dos ratings e RD quadrático médio.
function composite(players) {
  const n = players.length || 1;
  const rating = players.reduce((s, p) => s + p.rating, 0) / n;
  const rd = Math.sqrt(players.reduce((s, p) => s + p.rd * p.rd, 0) / n);
  return { rating, rd };
}

module.exports = {
  SCALE, DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL, DEFAULT_TAU,
  updatePlayer, inflateRd, composite, newVolatility, g, E,
};
