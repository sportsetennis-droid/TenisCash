const assert = require('node:assert/strict');
const { PRICES, diadoraFixedPrice } = require('../src/services/diadoraFixedOffer');
const { applyBrandThirtyOffer } = require('../src/services/brandThirtyOffer');
const { generateLabelsPDF, defaultTemplates } = require('../src/services/labelGenerator');
async function main() {
  const products = Object.entries(PRICES).flatMap(([name, price],i) => ['PRETO','BRANCO'].map((color,j) => ({id:`${i}-${j}`,brand:'DIADORA',name:`TENIS DIADORA ${name} ${color} 38`,price:price+100,promoPrice:1})));
  products.push({id:'other',brand:'DIADORA',name:'TENIS DIADORA FUTURO',price:300,promoPrice:200}, {id:'shirt',brand:'DIADORA',name:'CAMISETA DIADORA SAGA',price:300,promoPrice:200});
  const updates=[];
  const tx={product:{findMany:async()=>products,updateMany:async args=>{updates.push(args);return {count:1};}}};
  const result=await applyBrandThirtyOffer({$transaction:async fn=>fn(tx)},'diadora');
  assert.equal(result.updated,26);assert.equal(result.excluded,2);assert.equal(result.fixedPrices,true);
  updates.forEach(u=>{const p=products.find(p=>p.id===u.where.id);assert.deepEqual(u.data,{promoPrice:diadoraFixedPrice(p)});assert.equal(u.where.price,p.price);});
  assert.equal(diadoraFixedPrice({brand:'NIKE',name:'SAGA'}),null);
  const pdf=await generateLabelsPDF({template:defaultTemplates().a4_16_5x7_duplex,storeName:'Sports & Tennis',items:products.slice(0,26).map(p=>({...p,productName:p.name,promotionalPrice:diadoraFixedPrice(p),quantity:1}))});
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,4);
  console.log('13 modelos, 26 variantes verificadas; originais preservados e 4 páginas.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
