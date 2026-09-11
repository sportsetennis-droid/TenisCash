const assert = require('node:assert/strict');
const { calculateRankingCommissions, commissionWindow, isSportsClothing, clothingCents } = require('../src/services/rankingCommission');
const start = new Date('2026-09-01T03:00:00Z');
const end = new Date('2026-10-01T03:00:00Z');
function sale(total, clothes, extra = {}) {
  return { sellerId: 'seller', storeId: 'a', createdAt: '2026-09-11T15:00:00Z', totalAmount: total,
    items: [{ totalPrice: clothes, brand: 'Sports & Tennis', category: 'Vestuário' },
      { totalPrice: total - clothes, brand: 'Nike', category: 'roupa' }], ...extra };
}
const calc = (sales, options = {}) => calculateRankingCommissions(sales, { start, end, ...options }).get('seller');
let row = calc([sale(50000, 20000)]);
assert.equal(row.baseAmount, 500);
assert.equal(row.at50kAmount, 1000);
assert.equal(row.clothingBaseAmount, 200);
assert.equal(row.at20kClothingAmount, 800);
assert.equal(row.earnedAmount, 1400);
assert.equal(row.months[0].generalReached, true);
assert.equal(row.months[0].clothingReached, true);
assert.equal(calc([sale(49999, 19999)]).earnedAmount, 499.99);
assert.equal(calc([sale(50000, 19999)]).earnedAmount, 1000);
assert.equal(calc([sale(30000, 20000)]).earnedAmount, 900);
assert.equal(calc([sale(0, 0)]).earnedAmount, 0);
assert.equal(calc([sale(30000, 10000), sale(30000, 10000, {status:'canceled'})]).earnedAmount, 300);
assert.equal(calc([sale(50000, 20000), sale(90000, 50000, {sellerId:'other'})]).earnedAmount, 1400);

// A meta é mensal e acompanha o vendedor entre lojas; o recorte diário só muda a base exibida.
row = calc([sale(40000, 15000, {storeId:'b', createdAt:'2026-09-02T15:00:00Z'}), sale(10000, 5000)],
  {start: new Date('2026-09-11T03:00:00Z'), end: new Date('2026-09-12T03:00:00Z'), storeId:'a'});
assert.equal(row.earnedAmount, 300);
assert.equal(row.baseAmount, 100);
assert.equal(row.months[0].salesAmount, 50000);
// Dois meses abaixo da meta não atingem a faixa somando seus valores.
row = calc([sale(30000, 10000), sale(30000, 10000, {createdAt:'2026-08-15T15:00:00Z'})],
  {start:new Date('2026-08-01T03:00:00Z')});
assert.equal(row.earnedAmount, 600);
assert.equal(row.months.every(m => !m.generalReached && !m.clothingReached), true);
const discounted = sale(1000, 400); discounted.totalAmount = 800;
assert.equal(clothingCents(discounted), 32000);
assert.equal(calc([discounted]).clothingBaseAmount, 3.2);
assert.equal(calc([discounted]).clothingItems[0].amount, 320);
const multipleItems = sale(10, 10, {items:[1,1,1].map((n,i)=>({id:String(i),productName:'Camiseta '+i,quantity:1,totalPrice:n,brand:'Sports & Tennis',category:'roupa'}))});
row = calc([multipleItems]);
assert.equal(row.clothingItems.reduce((sum,i)=>sum+Math.round(i.amount*100),0), 1000);
assert.equal(row.clothingItems.length, 3);
assert.equal(calc([sale(10,10),sale(30,30,{status:'canceled'})]).clothingItems.length,1);
assert.equal(isSportsClothing({brand:'Sports & Tennis', category:'tênis'}), false);
assert.equal(isSportsClothing({brand:'Nike', category:'roupa'}), false);
assert.equal(isSportsClothing({brand:'Sports e Tennis', category:'Roupas'}), true);
assert.equal(isSportsClothing({brand:'Sports & Tennis', category:null, product:{category:'Vestuário'}}), true);
assert.equal(isSportsClothing({brand:'Nike', category:'roupa', product:{brand:'Sports & Tennis'}}), false);
const window = commissionWindow(new Date('2026-09-01T02:59:59Z'), new Date('2026-10-01T03:00:00Z'));
assert.equal(window.start.toISOString(), '2026-08-01T03:00:00.000Z');
assert.equal(window.end.toISOString(), '2026-10-01T03:00:00.000Z');
console.log('PASS: 1%, 2%, 4%, exact thresholds, no double counting, monthly goals, stores, discounts and clothing classification');
