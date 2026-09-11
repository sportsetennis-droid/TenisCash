const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const {salesVisibility}=require('../src/services/salesVisibility');
const source=fs.readFileSync('src/routes/seller.js','utf8');
(async()=>{
for(const role of ['seller','store','admin']){
 const db={user:{findUnique:async()=>({role,active:true,storeId:'a',storeIds:['b']})}};
 const v=await salesVisibility(db,'u');
 assert.deepEqual(v.storeIds,role==='admin'?null:role==='store'?['a']:['a','b']);
}
for(const route of ['sales','store-sellers','rankings']) {
 let handler,status=200,body;
 const start=source.indexOf(`router.get('/${route}'`),end=source.indexOf('\n// =====================================================================',start);
 vm.runInNewContext(source.slice(start,end),{router:{get:(p,m,h)=>handler=h},sellerOnly(){},salesVisibility,prisma:{user:{findUnique:async()=>({role:'seller',active:true,storeId:'a',storeIds:[]})}},console});
 await handler({userId:'u',query:{storeId:'foreign'}},{status(c){status=c;return this},json(b){body=b}});
 assert.equal(status,403,route);assert.ok(body.error);
}
assert.equal(await salesVisibility({user:{findUnique:async()=>null}},'u'),null);
const html=fs.readFileSync('public/loja.html','utf8');
for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
assert.ok(!html.includes('As quatro colunas comparam'));
assert.ok(!html.includes('const targetText ='));
console.log('PASS: restricted store access on sales, sellers and rankings; assignments; inactive access; frontend syntax');
})().catch(e=>{console.error(e);process.exitCode=1});
