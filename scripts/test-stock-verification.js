const assert=require('assert/strict');const {summarizeVariant,attachVerification}=require('../src/services/stockVerification');
const size={id:'s',productId:'p',size:'40',product:{active:true,brand:'Umbro'}};
const b={id:'b',productId:'p',found:true,barcode:'7899865918093',bipedAt:'2026-09-16T10:00:00Z'};
const result=(bs=[b],cs=[],ss=size,ms=[])=>summarizeVariant(bs,cs,ss,ms);
assert.equal(result().status,'verified');
assert.equal(result([{...b,duplicate:true}]).status,'pending');
assert.equal(result([b],[{bipeId:'b',status:'pendente'}]).status,'pending');
assert.equal(result([{...b,barcode:''}]).counted,0);
assert.equal(result([b],[],{...size,product:{active:true,brand:'Adidas'},sizeConfirmedAt:'2026-08-01'}).status,'pending');
const sale={createdAt:'2026-09-16T11:00:00Z',type:'sale',quantity:-1};
assert.equal(result([b],[],size,[sale]).available,0);
assert.equal(result([b],[],size,[sale]).status,'verified');
assert.equal(result([b],[],size,[{...sale,quantity:-2}]).status,'pending');
assert.equal(result([b],[],size,[{...sale,type:'transfer_in',quantity:1}]).status,'pending');
assert.equal(result([b,{...b,id:'b2',bipedAt:'2026-09-16T12:00:00Z'}],[],size,[sale]).status,'pending');
const products=[{id:'p',sizes:[{id:'s',stock:20}]}];attachVerification(products,{rows:[{productId:'p',productSizeId:'s',available:1}]});assert.equal(products[0].sizes[0].stock,20);
const fs=require('fs'),vm=require('vm');for(const file of ['public/admin.html','public/index.html','public/loja.html']){const text=fs.readFileSync(file,'utf8');for(const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){if(m[1].trim())new vm.Script(m[1],{filename:file});}}
console.log('PASS verification: quantities, pending, Adidas, movements, unchanged stock and inline JS');
