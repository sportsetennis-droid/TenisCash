'use strict';
// Offline mocks only: no Prisma client, server, network or database writes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/routes/stocktake.js'), 'utf8');
const route = source.slice(source.indexOf("router.get('/etiqueta-status'"), source.indexOf('// ============== ADMIN'));
const authorize = source.slice(source.indexOf('async function authorizeReplacement('), source.indexOf("const replacementQueue=require("));
const normalize = value => JSON.parse(JSON.stringify(value));

async function probe(size, live = true) {
  const calls = { captures:0, rounds:0, authorization:0, bipes:0, sizes:0, checks:0, sizeOptions:0, outcomes:0 };
  const captures = Array.from({length:size}, (_,i)=>({id:'capture-'+i,roundId:'round',bipeId:'bipe-'+i,status:'pendente',barcode:'barcode-'+i,note:'',excludedAt:i%7===6?'excluded':null}));
  const bipes = captures.map((c,i)=>({id:c.bipeId,productSizeId:'size-'+i,barcode:c.barcode,applied:i%4===0,excludedAt:null}));
  const checks = bipes.flatMap((b,i)=>i%4===3?[]:[{bipeId:b.id,appliedAt:i%4<2?'applied':null,reversedAt:i%4===1?'reversed':null,reason:'reason-'+i}]);
  let handler, result;
  const prisma = {
    productCapture:{findMany:async()=>{calls.captures++;return captures;}},
    stocktakeRound:{
      findMany:async()=>{calls.rounds++;return live?[{id:'round'}]:[];},
      findUnique:async args=>{
        calls.authorization++;
        assert.deepEqual(normalize(args.select),{id:true,storeId:true,operationType:true});
        return {id:'round',storeId:'store',operationType:'replacement'};
      }
    },
    stocktakeBipe:{findMany:async()=>{calls.bipes++;return bipes;}},
    productSize:{findMany:async()=>{calls.sizes++;return bipes.map(b=>({id:b.productSizeId,size:'43',product:{name:'TEST',brand:'TEST',active:true}}));}},
    stockReplacementCheck:{
      findUnique:async()=>{throw Error('Status must batch replacement checks');},
      findMany:async args=>{
        calls.checks++;
        assert.deepEqual(normalize(args.select),{bipeId:true,appliedAt:true,reversedAt:true,reason:true});
        assert.deepEqual(normalize(args.where.bipeId.in),bipes.map(b=>b.id));
        return checks;
      }
    }
  };
  const context = {
    router:{get:(_,fn)=>{handler=fn;}},prisma,
    authMiddleware:async(req,res,next)=>{req.userId='actor';next();},
    require:name=>{assert.equal(name,'../services/scanTransfers');return {operator:async()=>({id:'actor',name:'Actor'}),canSend:()=>true};},
    replacementQueue:{outcomes:async()=>{calls.outcomes++;return [];},pendingReason:()=>null},
    capturePhotos:{revisionOf:()=>'',visibleNote:x=>x},
    needsManualSize:()=>true,
    sizeOptionsForBipe:async()=>{calls.sizeOptions++;return ['42','43'];},
    captureComplete:()=>false,
    replacement:{reasonText:reason=>reason||'default-pending'}
  };
  vm.createContext(context);
  vm.runInContext(authorize+'\n'+route,context);
  const res={status(code){throw Error('Unexpected status '+code);},json(value){result=value;}};
  await handler({query:{ids:captures.map(c=>c.id).join(',')},body:{}},res);
  assert.equal(result.rows.length,size);
  assert.equal(calls.checks,size&&live?1:0);
  assert.equal(calls.sizeOptions,size);
  if (!size) assert.equal(Object.values(calls).reduce((a,b)=>a+b,0),0);
  for(let i=0;i<size;i++) {
    const row=result.rows[i],applied=live&&i%4===0,reason=live&&i%4!==3?'reason-'+i:null;
    assert.equal(row.complete,applied);
    assert.equal(row.appliedToStock,i%4===0);
    assert.equal(row.reasonCode,reason);
    assert.equal(row.status,captures[i].excludedAt?'descartado':applied?'vinculado':'pendente');
    assert.equal(row.mensagem,live?(applied?'Uma peça incluída no novo estoque oficial.':reason||'default-pending'):'');
    assert.equal(row.excludedAt,captures[i].excludedAt);
    assert.deepEqual(normalize(row.sizeOptions),['42','43']);
  }
  return {captures:size,replacement:live,calls};
}

(async()=>{
  const applicationContext = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('async function applyBipeIfReady('),source.indexOf('// Normaliza/valida')),applicationContext);
  let roundReads=0,bi={id:'bipe',roundId:'round',applied:false},operationType='replacement';
  const applicationDb={stocktakeBipe:{findUnique:async()=>bi},stocktakeRound:{findUnique:async args=>{
    roundReads++;assert.deepEqual(normalize(args.select),{operationType:true});return {operationType};
  }}};
  assert.deepEqual(normalize(await applicationContext.applyBipeIfReady(applicationDb,'bipe')),{applied:false,reason:'replacement_validation_pending'});
  operationType='inventory';
  assert.deepEqual(normalize(await applicationContext.applyBipeIfReady(applicationDb,'bipe')),{applied:false,reason:'round_count_only'});
  bi={id:'bipe',roundId:null,applied:false};
  assert.deepEqual(normalize(await applicationContext.applyBipeIfReady(applicationDb,'bipe')),{applied:false,reason:'historical_read_only'});
  bi={id:'bipe',roundId:'round',applied:true};
  assert.deepEqual(normalize(await applicationContext.applyBipeIfReady(applicationDb,'bipe')),{applied:true,idempotent:true,reason:'already_applied'});
  bi=null;
  assert.deepEqual(normalize(await applicationContext.applyBipeIfReady(applicationDb,'bipe')),{applied:false,reason:'bipe_not_found'});
  assert.equal(roundReads,2);
  const rounds=require(path.join(root,'src/services/stocktakeRounds'));
  let locks=0,status='counting';
  const db={
    $queryRaw:async()=>{locks++;return [];},
    stocktakeRound:{findUnique:async args=>{
      assert.deepEqual(args.select,{id:true,storeId:true,status:true,operationType:true});
      return {id:'round',storeId:'store',status,operationType:'replacement'};
    }}
  };
  assert.equal((await rounds.roundForScan(db,'store','round',true)).operationType,'replacement');
  assert.equal(locks,1);
  await assert.rejects(rounds.roundForScan(db,'other','round'),/não pertence/);
  status='closed';
  await assert.rejects(rounds.roundForScan(db,'store','round'),/encerrada/);
  const evidence=[await probe(0),await probe(20),await probe(40),await probe(20,false)];
  console.log(JSON.stringify({kind:'offline query-shape mocks, no latency measurement',evidence},null,2));
  console.log('PASS minimal round selects; 0/20/40 capture batches; applied/reversed/missing/excluded and ordinary-inventory statuses preserved.');
})().catch(error=>{console.error(error);process.exitCode=1;});
