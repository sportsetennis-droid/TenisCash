'use strict';
// Roupa/acessório na substituição: código decodificado da própria foto + tamanho literal
// da NF-e de ENTRADA do mesmo código. Calçado nunca usa este caminho; qualquer conflito fica pendente.
const assert=require('node:assert/strict');
const ledger=require('../src/services/storeStockLedger');
const movements=[];
ledger.applyStoreStockDelta=async(tx,data)=>{movements.push(data);return {stockAfter:movements.length};};
const label=require('../src/services/scannerArchivedLabel');
const service=require('../src/services/stockReplacement');
const scope=require('../src/services/stocktakeScope');
require('../src/services/stockReplacementImages').check=async()=>{};

const CODE='7909342581495',SIZE='ps-bermuda-m',PRODUCT='p-bermuda';
function world(){
 const product={id:PRODUCT,active:true,name:'BERMUDA BODY FOR SURE PRETO',category:'Roupas',ncm:'62034200',brand:'Body for Sure',sku:'03404',aiContext:{}};
 const size={id:SIZE,productId:PRODUCT,size:'M',barcode:CODE,product};
 const round={id:'r27',number:27,operationType:'replacement',storeId:'s4',status:'counting'};
 const bipe={id:'b-new',roundId:'r27',storeId:'s4',barcode:CODE,found:true,duplicate:false,productId:PRODUCT,productSizeId:SIZE};
 const capture={id:'c-new',bipeId:'b-new',roundId:'r27',storeId:'s4',scanKey:'k',sellerId:'u',barcode:CODE,note:'',photo:'data:image/jpeg;base64,dGVzdA=='};
 const w={product,size,round,bipe,capture,variants:4,owners:[{id:SIZE,productId:PRODUCT,product:{active:true}}],others:[],checks:[],
  fiscal:[{id:'nf-1',productId:PRODUCT,description:'BERMUDA COR: 077 (PRETO) TAM: M',ean:CODE,supplierCode:'03404'}],saved:null};
 const db={
  $queryRaw:async()=>[],
  $transaction:async fn=>fn(db),
  productSize:{findMany:async()=>w.owners,findUnique:async()=>w.size,count:async()=>w.variants},
  stocktakeBipe:{findMany:async()=>w.others,findUnique:async()=>w.bipe,update:async()=>({})},
  stocktakeRound:{findUnique:async()=>w.round},
  productCapture:{findFirst:async()=>w.capture,update:async()=>({})},
  stockReplacementCheck:{findMany:async()=>w.checks,findUnique:async()=>null,upsert:async a=>{w.saved=a.create;return a.create;},
   createMany:async()=>{},updateMany:async()=>{}},
 };
 label.fiscalRows=async()=>w.fiscal;
 w.db=db;return w;
}
const c=w=>({bipe:w.bipe,round:w.round,capture:w.capture,size:w.size});
const view=(extra={})=>({decodedBarcodes:[CODE],observedSizes:[],printedBrands:[],ocrConflict:false,...extra});
const pendingRead=(extra={})=>({pending:true,reason:'photo_size_or_reference_pending',decodedBarcodes:[CODE],ocrConflict:false,observedSizes:[],printedBrands:[],...extra});

(async()=>{
 // 0. Tamanho literal da nota.
 assert.deepEqual(service.fiscalLiteralSizes('BERMUDA COR: 077 (PRETO) TAM: M'),['M']);
 assert.deepEqual(service.fiscalLiteralSizes('CALCA PENALTY FUTEBOL JUV 446 PT T 10'),['10']);
 assert.deepEqual(service.fiscalLiteralSizes('CAMISETA NIKE DRI-FIT PRETO'),[]);
 assert.deepEqual(service.fiscalLiteralSizes('PORTA CHUTEIRA PENALTY VM T -U'),['UNICO']);
 assert.deepEqual(service.fiscalLiteralSizes('REGATA TAM: GG').sort(),['GG']);
 assert.deepEqual(service.fiscalLiteralSizes('REF: JW6036 - BONE BBALL 3S NL M/G 6'),[],'Número no fim sem marcador não é tamanho');
 assert.deepEqual(service.fiscalLiteralSizes('KIT MEIAO CORTADO E MEIA MULTI ESPORTES  - MARINHO - 33/38'),['33/38']);
 assert.deepEqual(service.fiscalLiteralSizes('SHORTS TEAMWEAR TEAMRISE SHORT  PUMA BLACK-PUMA WHIT GG'),['GG']);
 // Grafias equivalentes do cadastro: Puma EGR = GG, faixa 33-38 = 33/38.
 let wp=world();wp.size.size='EGR';wp.fiscal[0].description='SHORTS TEAMRISE PUMA BLACK GG';
 assert.ok(await service.fiscalSize(wp.db,c(wp),view()),'Puma EGR = GG da nota');
 wp=world();wp.size.size='33-38';wp.fiscal[0].description='KIT MEIAO - MARINHO - 33/38';
 assert.ok(await service.fiscalSize(wp.db,c(wp),view()),'Faixa 33-38 = 33/38');
 wp=world();wp.size.size='L';wp.fiscal[0].description='CAMISETA SS TEE GREEN MOON G';
 assert.ok(await service.fiscalSize(wp.db,c(wp),view()),'L = G da nota');
 wp=world();wp.size.size='L';wp.fiscal[0].description='CAMISETA SS TEE GREEN MOON M';
 assert.equal(await service.fiscalSize(wp.db,c(wp),view()),null,'L nunca vira M');

 // 1. Tipo: só roupa/acessório sem sinal de calçado usa o caminho fiscal.
 assert.equal(scope.kind({name:'BERMUDA X',category:'Roupas',ncm:'62034200'}),'other');
 assert.equal(scope.kind({name:'TENIS X',category:'Tênis',ncm:'64041100'}),'footwear');
 assert.equal(scope.kind({name:'SAPATO CASUAL',category:'Tênis',ncm:''}),'review');
 assert.equal(scope.kind({name:'PALMILHA X',category:'Calçados',ncm:'64069090'}),'review');
 assert.equal(scope.kind({name:'TOTEM PDV',category:'A CLASSIFICAR',ncm:''}),'blocked');

 // 2. Caso feliz.
 let w=world();
 const ok=await service.fiscalSize(w.db,c(w),view());
 assert.ok(ok);assert.equal(ok.literalSize,'M');assert.deepEqual(ok.fiscalItemIds,['nf-1']);assert.equal(ok.reference,'03404');
 assert.ok(await service.fiscalSize(w.db,c(w),view({printedBrands:['Body for Sure']})),'Sua própria marca impressa');

 // 3. Conflitos ficam pendentes.
 w=world();w.fiscal[0].description='BERMUDA COR: 077 (PRETO) TAM: G';assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Nota diz outro tamanho');
 w=world();w.fiscal.push({id:'nf-2',productId:PRODUCT,description:'BERMUDA TAM: G',ean:CODE});assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Notas discordam');
 w=world();w.fiscal[0].description='BERMUDA PRETO';assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Nota sem tamanho e variante não é única');
 w=world();assert.equal(await service.fiscalSize(w.db,c(w),view({observedSizes:['G']})),null,'Foto leu outro tamanho');
 w=world();assert.equal(await service.fiscalSize(w.db,c(w),view({printedBrands:['NIKE']})),null,'Outra marca impressa');
 w=world();assert.equal(await service.fiscalSize(w.db,c(w),view({decodedBarcodes:[]})),null,'Foto sem código');
 w=world();assert.equal(await service.fiscalSize(w.db,c(w),view({decodedBarcodes:[CODE,'7891234567895']})),null,'Dois códigos na foto');
 w=world();assert.equal(await service.fiscalSize(w.db,c(w),view({decodedBarcodes:['7891234567895']})),null,'Outro código na foto');
 w=world();assert.equal(await service.fiscalSize(w.db,c(w),view({ocrConflict:true})),null,'Conflito de leitura');
 w=world();w.owners.push({id:'ps-twin',productId:'p-twin',product:{active:true}});assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Dois donos ativos');
 w=world();w.owners.push({id:'ps-old',productId:'p-old',product:{active:false}});assert.ok(await service.fiscalSize(w.db,c(w),view()),'Dono antigo inativo não bloqueia');
 w=world();w.fiscal=[];assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Sem nota de entrada');
 w=world();w.fiscal[0].productId='p-outro';assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Nota ligada a outro produto');
 w=world();w.size.size='T-7909342581495';assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Tamanho provisório');
 w=world();w.product.category='Tênis';w.product.ncm='64041100';w.product.name='TENIS X';assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Calçado nunca usa a nota');
 w=world();w.others=[{id:'b-x',barcode:CODE}];w.checks=[{bipeId:'b-x',appliedAt:new Date(),reversedAt:null,appliedProductSizeId:'ps-outro'}];
 assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Mesmo código já entrou em outra variante');

 // 4. Acessório de tamanho único.
 w=world();w.size.size='Único';w.variants=1;w.fiscal[0].description='BONE NIKE CLUB PRETO';
 assert.ok(await service.fiscalSize(w.db,c(w),view()),'Variante única sem tamanho na nota');
 w=world();w.size.size='Único';w.variants=2;w.fiscal[0].description='BONE NIKE CLUB PRETO';
 assert.equal(await service.fiscalSize(w.db,c(w),view()),null,'Duas variantes: tamanho precisa estar escrito');

 // 5. De ponta a ponta: entra uma vez, com a evidência fiscal registrada.
 w=world();movements.length=0;
 let r=await service.check(w.db,'b-new',{read:pendingRead()});
 assert.equal(r.applied,true);assert.equal(movements.length,1);assert.equal(movements[0].quantity,1);assert.equal(movements[0].productSizeId,SIZE);
 assert.equal(w.saved.evidence.source,service.FISCAL_SIZE);assert.deepEqual(w.saved.evidence.fiscalSize.itemIds,['nf-1']);assert.equal(w.saved.evidence.reference,'03404');

 // 6. Conflito de ponta a ponta: não mexe no estoque.
 w=world();movements.length=0;w.fiscal[0].description='BERMUDA TAM: G';
 r=await service.check(w.db,'b-new',{read:pendingRead()});
 assert.equal(r.applied,false);assert.equal(movements.length,0);
 w=world();movements.length=0;
 r=await service.check(w.db,'b-new',{read:pendingRead({ocrConflict:true})});
 assert.equal(r.applied,false);assert.equal(movements.length,0);

 // 7. Calçado continua exigindo a etiqueta: a nota não substitui a foto.
 w=world();movements.length=0;Object.assign(w.product,{name:'TENIS PUMA SMASH',category:'Tênis',ncm:'64041100'});w.size.size='40';w.fiscal[0].description='TENIS PUMA SMASH 40';
 r=await service.check(w.db,'b-new',{read:pendingRead()});
 assert.equal(r.applied,false);assert.equal(movements.length,0);
 assert.equal(service.validateRead(c(w),{source:service.FISCAL_SIZE,size:'40',decodedBarcodes:[CODE]}),'tipo_de_produto_pendente');

 // 8. Evidência fiscal forjada é refeita dentro da transação.
 w=world();movements.length=0;w.fiscal[0].description='BERMUDA TAM: G';
 r=await service.applyVerified(w.db,c(w),{source:service.FISCAL_SIZE,size:'M',decodedBarcodes:[CODE],references:[],photoRead:view()},null);
 assert.equal(r.applied,false);assert.equal(movements.length,0);

 // 9. Não é mercadoria / sinais de calçado em conflito: tipo pendente.
 w=world();Object.assign(w.product,{name:'TOTEM PDV',category:'A CLASSIFICAR',ncm:''});
 assert.equal(service.validateRead(c(w),pendingRead()),'tipo_de_produto_pendente');
 w=world();Object.assign(w.product,{name:'SAPATO CASUAL',category:'Tênis',ncm:''});
 assert.equal(service.validateRead(c(w),pendingRead()),'tipo_de_produto_pendente');
 console.log('PASS: roupa/acessório entra pelo código da foto + tamanho literal da NF-e de entrada; nota divergente, outro tamanho/marca/código, dois donos, placeholder, calçado e evidência forjada ficam pendentes.');
})().catch(error=>{console.error(error);process.exitCode=1});
