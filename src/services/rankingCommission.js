// Projeções do ranking; não cria lançamentos nem altera comissões já pagas.
const money = value => Math.round((Number(value) || 0) * 100) / 100;
const cents = value => Math.round((Number(value) || 0) * 100);
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const monthKey = date => new Date(new Date(date).getTime() - 3 * 3600000).toISOString().slice(0, 7);

function isSportsClothing(item) {
  const brand = normalize(item.brand || item.product?.brand);
  const category = normalize(item.category || item.product?.category);
  return ['sportstennis', 'sportsandtennis', 'sportsetennis'].includes(brand)
    && ['roupa', 'roupas', 'vestuario', 'vestuarios', 'vestuarioesportivo'].includes(category);
}

function clothingCents(sale) {
  const items = sale.items || [];
  const gross = items.reduce((sum, item) => sum + Math.max(0, cents(item.totalPrice)), 0);
  const clothing = items.filter(isSportsClothing).reduce((sum, item) => sum + Math.max(0, cents(item.totalPrice)), 0);
  // Rateia descontos da venda proporcionalmente entre roupas e demais itens.
  return gross ? Math.round(Math.max(0, cents(sale.totalAmount)) * clothing / gross) : 0;
}

function commissionWindow(start, end) {
  const first = monthKey(start);
  const last = monthKey(new Date(new Date(end).getTime() - 1));
  const [year, month] = last.split('-').map(Number);
  return { start: new Date(`${first}-01T00:00:00-03:00`), end: new Date(Date.UTC(year, month, 1, 3)) };
}

function calculateRankingCommissions(sales, { start, end, storeId = null }) {
  const sellers = new Map();
  for (const sale of sales) {
    if (sale.status === 'canceled') continue;
    const key = monthKey(sale.createdAt);
    if (!sellers.has(sale.sellerId)) sellers.set(sale.sellerId, new Map());
    const months = sellers.get(sale.sellerId);
    if (!months.has(key)) months.set(key, { month: key, total: 0, clothing: 0, selected: 0, selectedClothing: 0 });
    const row = months.get(key);
    const total = Math.max(0, cents(sale.totalAmount));
    const clothing = clothingCents(sale);
    row.total += total;
    row.clothing += clothing;
    if (new Date(sale.createdAt) >= start && new Date(sale.createdAt) < end && (!storeId || sale.storeId === storeId)) {
      row.selected += total;
      row.selectedClothing += clothing;
    }
  }
  const result = new Map();
  for (const [sellerId, months] of sellers) {
    let total = 0, clothing = 0, earned = 0;
    const targets = [];
    for (const row of months.values()) {
      const generalReached = row.total >= 5000000;
      const clothingReached = row.clothing >= 2000000;
      const rate = generalReached ? 0.02 : 0.01;
      total += row.selected;
      clothing += row.selectedClothing;
      earned += Math.round((row.selected - row.selectedClothing) * rate
        + row.selectedClothing * (clothingReached ? 0.04 : rate));
      targets.push({ month: row.month, salesAmount: row.total / 100, clothingAmount: row.clothing / 100,
        generalReached, clothingReached, generalRate: generalReached ? 2 : 1,
        remainingGeneral: Math.max(0, 5000000 - row.total) / 100,
        remainingClothing: Math.max(0, 2000000 - row.clothing) / 100 });
    }
    result.set(sellerId, { baseAmount: money(total / 100 * 0.01), at50kAmount: money(total / 100 * 0.02),
      clothingSalesAmount: clothing / 100, clothingBaseAmount: money(clothing / 100 * 0.01), at20kClothingAmount: money(clothing / 100 * 0.04),
      earnedAmount: earned / 100, months: targets.sort((a, b) => a.month.localeCompare(b.month)) });
  }
  return result;
}

module.exports = { isSportsClothing, clothingCents, commissionWindow, calculateRankingCommissions };
