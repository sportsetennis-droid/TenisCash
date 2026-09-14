'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {normalizeReference, referencesFrom, validGtin, learnScannerBarcode}=require('../src/services/scannerReference');
const p1={id:'nike',sku:'0174-192974',name:'BLUSAO W NSW CLUB FLC FZ HOODIE ST SU23',brand:'NIKE',active:true,aiContext:{supplierRef:'192974',keep:'preserved'}};
function database({products=[p1],sizes=[],nfe=[]}={}) {
  const state={products:structuredClone(products),sizes:structuredClone(sizes),nfe,counts:[],captures:[],bipes:[],stocks:[],movements:[]};
  const match=(s,w)=> !w || (!w.id||s.id===w.id)&&(!w.productId||s.productId===w.productId)&&(!w.barcode||w.barcode.in.includes(s.barcode));
  const db={
    $queryRaw: async (strings,...values)=>{
      const sql=strings.join('?');
      if(!sql.includes('WITH codes')) return [];
      assert.ok(sql.includes('d."docType" = \'entrada\''));
      assert.ok(sql.includes('regexp_replace')); assert.ok(sql.includes('LIMIT 12'));
      const codes=JSON.parse(values[0]);
      return state.products.filter(p=>p.active && [p.sku,p.aiContext?.supplierRef,...(p.aiContext?.scannerReferences||[]),
        ...state.sizes.filter(s=>s.productId===p.id).map(s=>s.barcode),
        ...nfe.filter(i=>i.productId===p.id&&i.docType==='entrada').map(i=>i.supplierCode)]
        .some(ref=>codes.includes(normalizeReference(ref)))).slice(0,3).map(p=>({id:p.id}));
    },
    product:{
      findUnique:async ({where})=>{const p=state.products.find(p=>p.id===where.id);return p?{...p,sizes:state.sizes.filter(s=>s.productId===p.id)}:null},
      findFirst:async ({where})=>state.products.find(p=>where.internalBarcode.in.includes(p.internalBarcode))||null,
      update:async ({where,data})=>Object.assign(state.products.find(p=>p.id===where.id),data),
    },
    productSize:{
      findMany:async ({where})=>state.sizes.filter(s=>match(s,where)).map(s=>({...s,product:state.products.find(p=>p.id===s.productId)})),
      findUnique:async ({where})=>{const s=state.sizes.find(s=>s.id===where.id);return s?{...s,product:state.products.find(p=>p.id===s.productId)}:null},
      create:async ({data})=>{assert.ok(!state.sizes.some(s=>s.productId===data.productId&&s.size===data.size));const s={id:'s'+state.sizes.length,...data};state.sizes.push(s);return s},
      update:async ({where,data})=>Object.assign(state.sizes.find(s=>s.id===where.id),data),
      count:async ({where})=>state.sizes.filter(s=>match(s,where)).length,
    },
    productCapture:{findUnique:async({where})=>state.captures.find(c=>c.id===where.id),update:async({where,data})=>Object.assign(state.captures.find(c=>c.id===where.id),data)},
    stocktakeBipe:{findUnique:async({where})=>state.bipes.find(c=>c.id===where.id),update:async({where,data})=>Object.assign(state.bipes.find(c=>c.id===where.id),data),
      create:async({data})=>{const b={id:'b'+state.bipes.length,...data};state.bipes.push(b);return b},
      updateMany:async({where,data})=>{const b=state.bipes.find(b=>b.id===where.id&&b.applied===where.applied);if(!b)return{count:0};Object.assign(b,data);return{count:1}},
    },
    storeStock:{upsert:async({where,update,create})=>{const key=where.storeId_productSizeId;let s=state.stocks.find(s=>s.storeId===key.storeId&&s.productSizeId===key.productSizeId);if(s)s.stock+=update.stock.increment;else{ s={...create};state.stocks.push(s)}return s}},
    storeStockMovement:{create:async({data})=>state.movements.push(data)},
  };
  let queue=Promise.resolve();
  db.$transaction=(fn)=>{const run=queue.then(()=>fn(db));queue=run.catch(()=>{});return run};
  return {db,state};
}
function routeFunctions(db){
 const routes=[];const router={use:(...handlers)=>routes.push({use:handlers})};
 for(const method of ['get','post','delete','put'])router[method]=(path,...handlers)=>routes.push({method,path,handlers});
 const upload=()=>({single:()=>()=>{},array:()=>()=>{}});upload.memoryStorage=()=>({});
 const ctx={require:name=>{
  if(name==='express')return{Router:()=>router}; if(name==='multer')return upload;if(name==='sharp')return()=>{};
  if(name==='../middleware')return{prisma:db,authMiddleware:'AUTH',adminMiddleware:'ADMIN'};
  if(name==='../services/stocktakeRounds')return require('../src/services/stocktakeRounds'); if(name==='./stocktakeRounds')return {};
  if(name==='../services/scannerCatalog')return require('../src/services/scannerCatalog');
  if(name==='../services/scannerReference')return require('../src/services/scannerReference');
  if(name==='../services/scannerText')return require('../src/services/scannerText');
  throw Error('Unexpected require '+name);
 },module:{exports:{}},console,setInterval:()=>0,setTimeout:()=>0,Buffer};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../src/routes/stocktake'),'utf8')+'\nmodule.exports.test={garantirBipeDaCaptura,normalizeScannedSize,parseJsonSeguro,processarEtiqueta};',ctx);
 return {...ctx.module.exports.test,routes};
}
(async()=>{
 assert.equal(normalizeReference('dq5471-113'),'DQ5471113');
 assert.deepEqual(referencesFrom({sku:'DQ5471-113',codigos:['DQ5471 113','IM#722460']}),['DQ5471113','IM722460']);
 assert.equal(validGtin('196153346321'),true);assert.equal(validGtin('0196153346321'),true);assert.equal(validGtin('196153346322'),false);
 let {db,state}=database();
 assert.equal((await learnScannerBarcode(db,{barcode:'196153346321',read:{sku:'DQ5471-113'},size:'L'})).reason,'reference_not_found');
 let r=await learnScannerBarcode(db,{barcode:'196153346321',read:{sku:'DQ5471-113',marca:'NIKE'},size:'L',confirmedProductId:'nike'});
 assert.equal(r.reason,'matched');assert.equal(state.sizes[0].size,'L');assert.equal(state.sizes[0].stock,0);assert.equal(state.products[0].aiContext.keep,'preserved');
 assert.ok(state.products[0].aiContext.scannerReferences.includes('DQ5471113'));
 r=await learnScannerBarcode(db,{barcode:'0196153346321',read:null});assert.equal(r.reason,'matched');assert.equal(state.sizes.length,1);
 r=await learnScannerBarcode(db,{barcode:'196153346321',read:{sku:'DQ5471-113'},size:'M'});assert.equal(r.reason,'size_conflict');
 // Exact reference learns a new size barcode without changing the existing one.
 r=await learnScannerBarcode(db,{barcode:'7909538652084',read:{sku:'DQ5471 113',marca:'NIKE'},size:'M'});
 assert.equal(r.reason,'matched');assert.equal(state.sizes.length,2);assert.equal(state.sizes[0].barcode,'196153346321');
 const funcs=routeFunctions(db);
 assert.equal(funcs.normalizeScannedSize('L'),'L');assert.equal(funcs.normalizeScannedSize('BR 40'),'40');assert.equal(funcs.normalizeScannedSize('US 10'),null);
 assert.equal(funcs.parseJsonSeguro('abc {"sku":"A}B","nome":"x"} extra').sku,'A}B');
 assert.ok(funcs.routes.findIndex(r=>r.use?.includes('AUTH'))>0);
 assert.ok(funcs.routes.findIndex(r=>r.path==='/captures/:id/learn-barcode')>funcs.routes.findIndex(r=>r.use?.includes('AUTH')));
 state.captures.push({id:'cap',barcode:'196153346321',storeId:'LOJA04',sellerId:'douglas',createdAt:new Date(),bipeId:'original'});
 state.bipes.push({id:'original',storeId:'LOJA04',barcode:'196153346321',found:false,applied:false});
 await Promise.all(Array.from({length:5},()=>funcs.garantirBipeDaCaptura('cap','nike','s0','196153346321')));
 assert.equal(state.bipes.length,1);assert.equal(state.stocks.length,0);assert.equal(state.movements.length,0); state.bipes[0].applied=true;
 assert.equal(await funcs.garantirBipeDaCaptura('cap','nike','s1','7909538652084'),null);assert.equal(state.bipes[0].productSizeId,'s0');
 // Missing synchronous bipe is created only once despite concurrent retries.
 state.captures.push({id:'cap2',barcode:'196153346321',storeId:'LOJA05',createdAt:new Date(),bipeId:null});
 await Promise.all(Array.from({length:4},()=>funcs.garantirBipeDaCaptura('cap2','nike','s0','196153346321')));
 assert.equal(state.bipes.length,2);assert.equal(state.stocks.length,0);assert.equal(state.movements.length,0);
 ({db,state}=database({products:[p1,{...p1,id:'other'}]}));
 r=await learnScannerBarcode(db,{barcode:'196153346321',read:{sku:'192974'},size:'L'});assert.equal(r.reason,'reference_conflict');assert.equal(state.sizes.length,0);
 ({db,state}=database({sizes:[{id:'legacy',productId:'nike',size:'L',barcode:'REFABC',stock:6}]}));
 r=await learnScannerBarcode(db,{barcode:'196153346321',read:{sku:'REFABC'},size:'L'});assert.equal(r.reason,'matched');assert.equal(state.sizes[0].stock,6);assert.ok(state.products[0].aiContext.scannerReferences.includes('REFABC'));
 ({db,state}=database({products:[p1,{...p1,id:'other',sku:'other',aiContext:{supplierRef:'other'}}],sizes:[{id:'other-size',productId:'other',size:'L',barcode:'196153346321'}]}));
 r=await learnScannerBarcode(db,{barcode:'196153346321',read:{sku:'192974'},size:'L'});assert.equal(r.reason,'barcode_conflict');
 ({db,state}=database({nfe:[{productId:'nike',supplierCode:'NF-ABC12',docType:'entrada'}]}));
 r=await learnScannerBarcode(db,{barcode:'196153346321',read:{codigos:['NF ABC12']},size:'L'});assert.equal(r.reason,'matched');
 ({db,state}=database({nfe:[{productId:'nike',supplierCode:'NF-ABC12',docType:'transferencia'}]}));
 r=await learnScannerBarcode(db,{barcode:'196153346321',read:{codigos:['NF ABC12']},size:'L'});assert.equal(r.reason,'reference_not_found');
 for(const [read,size,expected] of [[{sku:'192974',marca:'ADIDAS'},'L','brand_conflict'],[{sku:'192974'},null,'size_required']]) {
  ({db,state}=database());r=await learnScannerBarcode(db,{barcode:'196153346321',read,size});assert.equal(r.reason,expected);assert.equal(state.sizes.length,0);
 }
 // Browser OCR text goes through the real scanner route and exact-reference
 // learner, with no paid-provider require permitted by this VM.
 ({db,state}=database({products:[{...p1,aiContext:{scannerReferences:['DQ5471113']}}]}));
 state.captures.push({id:'free-cap',barcode:'196153346321',storeId:'LOJA04',createdAt:new Date(),bipeId:null});
 const freeRoute=routeFunctions(db);
 await freeRoute.processarEtiqueta('free-cap','unused-image','196153346321',{ocrText:'NIKE\nDQ5471-113\nL\n196153346321'});
 assert.equal(state.captures[0].status,'vinculado');assert.equal(state.sizes[0].barcode,'196153346321');
 assert.equal(state.stocks.length,0);assert.equal(state.movements.length,0);
 await freeRoute.processarEtiqueta('free-cap','unused-image','196153346321',{ocrText:''});
 assert.equal(state.stocks.length,0);assert.equal(state.movements.length,0);
 ({db,state}=database());state.captures.push({id:'unreadable',barcode:'196153346321',storeId:'LOJA04',createdAt:new Date(),bipeId:null});
 await routeFunctions(db).processarEtiqueta('unreadable','unused-image','196153346321',{ocrText:''});
 assert.equal(state.captures[0].status,'pendente');assert.equal(state.sizes.length,0);
 const html=fs.readFileSync(require.resolve('../public/identificar.html'),'utf8');
 for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
 ({db,state}=database({sizes:[{id:'s-existing',productId:'nike',size:'L',barcode:'196153346321',stock:6}]}));
 r=await learnScannerBarcode(db,{barcode:'7909538652084',read:{sku:'192974'},size:'L'});assert.equal(r.reason,'matched');assert.equal(state.sizes[0].barcode,'196153346321');assert.equal(state.products[0].aiContext.scannerBarcodeAliases['7909538652084'].size,'L');
 const byRef=await require('../src/services/scannerReference').matchScannerReference(db,{sku:'192974'},'L');assert.equal(byRef.productSizeId,'s-existing');assert.equal((await require('../src/services/scannerReference').matchScannerReference(db,{sku:'192974'},null)).reason,'size_required');
 console.log('PASS: exact reference and NF-e lookup; confirmed Nike alias; GTIN checksum and leading zero; size/brand/owner ambiguity; preserving existing barcode and purchased stock; repeated and concurrent capture linking preserves historical stock; authenticated review route; HTML syntax.');
})().catch(e=>{console.error(e);process.exitCode=1});
