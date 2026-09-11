const assert = require('node:assert/strict');
const { campaignLabelReview } = require('../src/services/campaignLabelReview');
const { labelUsage } = require('../src/services/labelUsage');
const describe = p => p.name;
const sample = (id, name, price=200, usage=['O TÊNIS MAIS DESEJADO','DO MUNDO.']) => ({id, name, brand:'CONVERSE',price,promoPrice:price*.7,labelUsage:usage});
const data=campaignLabelReview([
 sample('a','CHUCK TAYLOR ALL STAR PRETO 38'),sample('b','CHUCK TAYLOR ALL STAR BRANCO 40'),
 sample('c','CHUCK TAYLOR ALL STAR PRETO 41',220),
 sample('d','CHCUK TAYLOR ALL STAR HIGH STREET MISTA'),
 sample('e','CHCUK TAYLOR ALL STAR HIGH STREET ESCURO')
],describe);
assert.equal(data.products.length,3);assert.equal(data.labelCount,6);assert.equal(data.products[0].variantCount,2);
assert.match(data.products[2].labelModel,/HIGH STREET$/);
for(const name of ['ORBITA PRETO','ORBITA PTLLMO','GIRO PRETO','CHALLENGER 5']) {
 assert.deepEqual(labelUsage({name,brand:'OLYMPIKUS'},{modality:'Casual'}),['CORRIDA','E TREINO LEVE']);
}
for(const name of ['RING 4','FORCEKNIT','STATION 3','CLIMBER ULTRA','CLIMBER PRO 3']) {
 assert.deepEqual(labelUsage({name,brand:'EVERLAST'}),['TREINO DE FORÇA E ACADEMIA','CROSS E FUNCIONAL']);
}
assert.deepEqual(labelUsage({name:'CHUTEIRA CAMPO JOMA AGUILA',brand:'JOMA'}),['FUTEBOL DE CAMPO','PARA TREINO']);
assert.deepEqual(labelUsage({name:'CHUTEIRA FUTSAL UMBRO CLASS',brand:'UMBRO'},{tier:'Treino'}),['FUTSAL','PARA TREINO']);
const pending=campaignLabelReview([{brand:'KAPPA',name:'SORANO',price:200,promoPrice:140,labelUsage:['CHUTEIRA','PARA TREINO']}],describe);
assert.equal(pending.pending.length,1);
const modalities=campaignLabelReview(['FUTSAL','SOCIETY'].map(m=>({brand:'JOMA',name:'MAXIMA',price:200,labelUsage:[m,'PARA TREINO']})),describe);
assert.equal(modalities.products.length,2);assert.equal(modalities.pending.length,0);
console.log('Campanha: duplicatas removidas, preços/modalidades distintos preservados, aprovações e pendências verificadas.');
