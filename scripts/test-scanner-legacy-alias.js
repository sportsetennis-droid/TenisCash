'use strict';
const assert=require('assert/strict');
const {resolveBarcodeRows}=require('../src/services/scannerCatalog');
(async()=>{
  const target={id:'active',active:true,aiContext:{scannerBarcodeAliases:{'7900245100394':{size:'38'}}},sizes:[{id:'correct',productId:'active',size:'38'},{id:'unrelated',productId:'active',size:'Único'}]};
  const legacy={id:'old',active:false,aiContext:{consolidatedInto:'active'}};
  const db={product:{findUnique:async()=>target},$queryRaw:async()=>[]};
  const rows=await resolveBarcodeRows(db,[{id:'legacy-size',productId:'old',size:'Único',barcode:'07900245100394',product:legacy},{...target.sizes[0],product:target}]);
  assert.deepEqual(rows.map(r=>r.id),['correct']);
  assert.equal(target.sizes[1].size,'Único');
  console.log('PASS: reviewed GTIN alias resolves legacy placeholder to the confirmed size, without selecting another placeholder');
})().catch(e=>{console.error(e);process.exitCode=1;});
