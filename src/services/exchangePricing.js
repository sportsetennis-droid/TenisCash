'use strict';

class ExchangeValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function cents(value, label = 'Valor') {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 100))) {
    throw new ExchangeValidationError(label + ' inválido');
  }
  return Math.round((value + Number.EPSILON) * 100);
}

function quantity(value, label = 'Quantidade') {
  if (!Number.isSafeInteger(value) || value < 1) throw new ExchangeValidationError(label + ' inválida');
  return value;
}

function normalizeAuthCode(value) {
  const code = value == null ? '' : String(value).trim();
  return code && code !== '000000' ? code : null;
}

// PostgreSQL JSONB canonicaliza a ordem das propriedades ao persistir. O acordo
// compara valores, nunca a ordem de chaves que veio do banco ou do cliente.
function sameSnapshot(left, right) {
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function exchangeRequest({ returned, newItems, diffAmount }) {
  const seen = new Set();
  const normalizedReturned = returned.map(item => {
    if (!item?.saleItemId || seen.has(item.saleItemId)) throw new ExchangeValidationError('Item devolvido inválido ou repetido');
    seen.add(item.saleItemId);
    return { saleItemId: item.saleItemId, qty: quantity(item.qty, 'Quantidade devolvida') };
  }).sort((a, b) => a.saleItemId.localeCompare(b.saleItemId));
  const normalizedNew = newItems.map(item => ({
    barcode: String(item?.barcode || '').trim(),
    size: item?.size == null ? '' : String(item.size).trim().toLowerCase(),
    qty: quantity(item?.qty == null ? 1 : item.qty, 'Quantidade nova'),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { returned: normalizedReturned, newItems: normalizedNew, diffAmount: diffAmount == null ? null : cents(diffAmount, 'Diferença') / 100 };
}

// O agente fiscal não aceita desconto por item. Rateamos o valor negociado
// em centavos e, quando necessário, dividimos a quantidade em duas linhas.
// Assim cada preço unitário tem duas casas e venda, XML e pagamentos coincidem.
function priceExchange(items, returnedTotal, diffAmount) {
  const returnedCents = cents(returnedTotal, 'Valor devolvido');
  if (returnedCents <= 0) throw new ExchangeValidationError('O valor dos produtos devolvidos deve ser maior que zero');
  const lines = items.map((item, index) => {
    const qty = quantity(item.qty);
    const unitCents = cents(item.price, 'Preço do produto');
    if (unitCents <= 0 || !Number.isSafeInteger(unitCents * qty)) throw new ExchangeValidationError('Preço do produto inválido');
    return { index, qty, unitCents, weight: unitCents * qty };
  });
  const catalogCents = lines.reduce((sum, item) => sum + item.weight, 0);
  if (!lines.length || !Number.isSafeInteger(catalogCents)) throw new ExchangeValidationError('Produtos novos inválidos');
  const explicit = diffAmount != null;
  const diffCents = explicit ? cents(diffAmount, 'Diferença') : catalogCents - returnedCents;
  const targetCents = returnedCents + diffCents;
  if (!Number.isSafeInteger(targetCents) || targetCents <= 0) throw new ExchangeValidationError('A diferença informada deve deixar o total dos produtos novos maior que zero');

  let allocated = 0;
  for (const line of lines) {
    const numerator = BigInt(targetCents) * BigInt(line.weight);
    line.totalCents = Number(numerator / BigInt(catalogCents));
    line.remainder = numerator % BigInt(catalogCents);
    allocated += line.totalCents;
  }
  const ranked = [...lines].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : (a.remainder > b.remainder ? -1 : 1));
  for (let i = 0; i < targetCents - allocated; i++) ranked[i].totalCents++;
  const pricedItems = [];
  for (const line of lines) {
    const base = Math.floor(line.totalCents / line.qty);
    const higherQty = line.totalCents % line.qty;
    if (base < 1) throw new ExchangeValidationError('A diferença informada deixa um produto com preço inferior a R$ 0,01');
    const source = items[line.index];
    if (line.qty > higherQty) pricedItems.push({ ...source, qty: line.qty - higherQty, price: base / 100 });
    if (higherQty) pricedItems.push({ ...source, qty: higherQty, price: (base + 1) / 100 });
  }
  return {
    items: pricedItems,
    returnedTotal: returnedCents / 100,
    catalogTotal: catalogCents / 100,
    newTotal: targetCents / 100,
    diff: diffCents / 100,
    credit: Math.min(returnedCents, targetCents) / 100,
    vale: Math.max(0, -diffCents) / 100,
    adjustment: (targetCents - catalogCents) / 100,
    overridden: explicit,
  };
}

module.exports = { ExchangeValidationError, cents, quantity, normalizeAuthCode, sameSnapshot, exchangeRequest, priceExchange };
