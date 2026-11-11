'use strict';

// Dinheiro em CENTAVOS INTEIROS. Todo módulo financeiro novo (tabelas Fin*) guarda
// valores assim. As tabelas antigas continuam em Float e só são convertidas na borda.

function toCents(value) {
  if (value == null || value === '') return 0;
  const n = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(/^R\$/i, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) : Number(value);
  if (!Number.isFinite(n)) return 0;
  // toPrecision(15) remove o ruído do Float (1.005*100 = 100.49999…) antes de arredondar.
  const abs = Math.round(Number((Math.abs(n) * 100).toPrecision(15)));
  return n < 0 ? -abs : abs;
}

function fromCents(cents) {
  return Number(cents || 0) / 100;
}

function assertCents(cents, label = 'valor') {
  if (!Number.isSafeInteger(cents)) throw new TypeError(label + ' precisa ser centavos inteiros');
  return cents;
}

function sumCents(list) {
  let total = 0;
  for (const c of list || []) total += assertCents(Number(c) || 0);
  return total;
}

// Reparte `totalCents` por pesos sem perder centavo (método do maior resto).
// Ex.: allocateCents(10000, [1,1,1]) → [3334, 3333, 3333].
function allocateCents(totalCents, weights) {
  assertCents(totalCents, 'total');
  const w = (weights || []).map((x) => Math.max(0, Number(x) || 0));
  if (!w.length) return [];
  const sumW = w.reduce((s, x) => s + x, 0);
  if (sumW === 0) {
    const even = w.map(() => 1);
    return allocateCents(totalCents, even);
  }
  const sign = totalCents < 0 ? -1 : 1;
  const abs = Math.abs(totalCents);
  const raw = w.map((x) => (abs * x) / sumW);
  const base = raw.map(Math.floor);
  let rest = abs - base.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest -= 1) base[order[k].i] += 1;
  return base.map((x) => x * sign);
}

function fmtBRL(cents) {
  const n = Number(cents || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const int = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const dec = String(abs % 100).padStart(2, '0');
  return (neg ? '-' : '') + 'R$ ' + int + ',' + dec;
}

module.exports = { toCents, fromCents, assertCents, sumCents, allocateCents, fmtBRL };
