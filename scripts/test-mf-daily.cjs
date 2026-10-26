'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { attendance, localDay, validDay, groupProduction, validateEntry } = require('../src/services/mfDailyProduction');
const createRoutes = require('../src/routes/mfDaily');

function fixture() {
  const people = [
    { id: 'recorder', name: 'Responsável de teste', role: 'funcionario', canRecordProduction: true, active: true },
    { id: 'alice', name: 'Funcionária de teste A', role: 'funcionario', active: true },
    { id: 'bob', name: 'Funcionário de teste B', role: 'funcionario', active: true },
    { id: 'inactive', name: 'Funcionário de teste inativo', role: 'funcionario', active: false },
  ];
  const entries = [], punches = [];
  const match = (x, w = {}) => Object.entries(w).every(([k, v]) => {
    if (k === 'OR') return v.some(branch => match(x, branch));
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(x[k]);
    return (x[k] ?? null) === (v ?? null);
  });
  const db = {
    mfEmployee: {
      findMany: async ({ where = {} } = {}) => people.filter(x => match(x, where)).map(({ id, name, active }) => ({ id, name, active })),
      findUnique: async ({ where }) => people.find(x => match(x, where)) || null,
    },
    mfTimeEntry: {
      findMany: async ({ where }) => punches.filter(x => match(x, where)),
      findUnique: async ({ where }) => punches.find(x => match(x, where)) || null,
      create: async ({ data }) => { const x = { id: randomUUID(), ...data }; punches.push(x); return x; },
    },
    mfProductionEntry: {
      findMany: async ({ where }) => entries.filter(x => match(x, where)).map(x => ({ ...x, employee: { name: people.find(e => e.id === x.employeeId).name }, recorder: { name: people.find(e => e.id === x.recorderId).name } })),
      findUnique: async ({ where }) => entries.find(x => match(x, where)) || null,
      create: async ({ data }) => {
        if (entries.some(x => x.requestId === data.requestId)) { const e = Error('unique'); e.code = 'P2002'; throw e; }
        const entry = { id: randomUUID(), ...data, createdAt: new Date(), voidedAt: null, voidedById: null }; entries.push(entry); return entry;
      },
      updateMany: async ({ where, data }) => { const rows = entries.filter(x => match(x, where)); rows.forEach(x => Object.assign(x, data)); return { count: rows.length }; },
    },
    $queryRaw: async () => [],
  };
  let serial = Promise.resolve();
  db.$transaction = fn => { const result = serial.then(() => fn(db)); serial = result.catch(() => {}); return result; };
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => {
    req.emp = people.find(x => x.id === req.headers['x-test-user']);
    return req.emp?.active ? next() : res.status(401).json({ error: 'Não autenticado' });
  };
  app.use('/api/mf', createRoutes({ prisma: db, mfAuth: auth }));
  return { app, db, people, entries, punches, auth };
}
async function run() {
  const { createSchemaReadiness } = require('../src/services/mfDailySchema');
  let migrations=0;const ddl=[];
  const ready=createSchemaReadiness({$transaction:async fn=>{migrations++;return fn({$queryRaw:async()=>[], $executeRawUnsafe:async s=>ddl.push(s)});}});
  await Promise.all([ready(),ready()]);await ready();assert.equal(migrations,1,'migração roda uma vez por processo');
  assert.equal(ddl.every(s=>!/\b(DROP|TRUNCATE|DELETE|UPDATE)\s+(TABLE|FROM|"Mf)/i.test(s)),true,'migração não remove ou reescreve dados');
  assert.equal(ddl.some(s=>s.includes('"MfProductionEntry"')),true);
  const day = '2026-10-26';
  const p = (kind, time) => ({ kind, at: new Date(day + 'T' + time + ':00-03:00') });
  const full = [p('in','08:00'),p('break_in','12:00'),p('break_out','13:00'),p('out','17:00')];
  assert.equal(attendance(full,day).workedMinutes,480,'intervalo não integra horas trabalhadas');
  assert.equal(attendance(full,day).complete,true);
  assert.equal(attendance(full.slice(0,1),day,new Date(day+'T10:30:00-03:00')).ongoingMinutes,150);
  assert.equal(attendance(full.slice(0,2),day,new Date(day+'T12:30:00-03:00')).workedMinutes,240);
  assert.equal(attendance(full.slice(0,2),day,new Date(day+'T12:30:00-03:00')).ongoingMinutes,0);
  assert.equal(attendance(full.slice(0,1),day,new Date('2026-10-27T12:00:00Z')).workedMinutes,null,'dia anterior em aberto exige conferência');
  assert.equal(attendance([p('in','08:00'),p('in','09:00'),p('out','17:00')],day).workedMinutes,null,'duplicação legada não inventa horas');
  assert.equal(attendance([],day).state,'absent');
  assert.equal(attendance([...full,p('in','18:00'),p('out','19:00')],day).workedMinutes,540);
  assert.equal(localDay('2026-10-27T01:00:00Z'),'2026-10-26','agrupamento pelo fuso de João Pessoa');
  assert.equal(validDay('2026-02-30'),false); assert.equal(validDay('2024-02-29'),true);
  for(const quantity of [0,-1,1.5,Infinity,'',null,true,[],{}])assert.throws(()=>validateEntry({day,employeeId:'alice',product:'Polo',activity:'Costura',quantity,requestId:randomUUID()},day));
  assert.equal(validateEntry({day,employeeId:'alice',product:'Polo',activity:'Costura',quantity:1,requestId:randomUUID()},day).quantity,1);
  assert.deepEqual(groupProduction([{product:'Polo',activity:'Corte',quantity:10},{product:'Polo',activity:'Costura',quantity:10}]).map(g=>g.quantity),[10,10]);
  const html=fs.readFileSync(path.join(__dirname,'../public/metafardamentos.html'),'utf8');
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
  new vm.Script(fs.readFileSync(path.join(__dirname,'../public/mf-daily.js'),'utf8'));

  const f=fixture(), server=f.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/api/mf';
  async function call(route,user='recorder',method='GET',body){
    const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(user?{'x-test-user':user}:{})},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json()};
  }
  try {
    assert.equal((await call('/production-daily',null)).status,401);
    assert.equal((await call('/ponto','alice','POST',{kind:'out'})).status,409);
    assert.equal((await call('/ponto','alice','POST',{kind:'in',employeeId:'bob'})).status,403);
    const clock={kind:'in',requestId:randomUUID()};
    const clocks=await Promise.all([call('/ponto','alice','POST',clock),call('/ponto','alice','POST',clock)]);
    assert.deepEqual(clocks.map(x=>x.status),[200,200]);assert.equal(f.punches.length,1);
    assert.equal((await call('/ponto','alice','POST',{kind:'in',requestId:randomUUID()})).status,409);
    assert.equal((await call('/ponto','bob','POST',clock)).status,409);
    assert.deepEqual((await call('/ponto/today','alice')).data.attendance.allowedKinds,['break_in','out']);
    assert.equal((await call('/ponto','alice','POST',{kind:'break_in',requestId:randomUUID()})).status,200);
    assert.equal((await call('/ponto','alice','POST',{kind:'out',requestId:randomUUID()})).status,409);
    assert.equal((await call('/ponto','alice','POST',{kind:'break_out',requestId:randomUUID()})).status,200);
    assert.equal((await call('/ponto','alice','POST',{kind:'out',requestId:randomUUID()})).status,200);
    assert.equal((await call('/ponto/today','alice')).data.attendance.complete,true);
    assert.equal((await call('/ponto/board','alice')).status,403);
    assert.equal((await call('/ponto/board')).data.employees.length,3,'pessoas sem batida também aparecem');
    const entry={day:localDay(),employeeId:'bob',product:'Polo pedido 35',activity:'Costura',quantity:20,notes:'Lote azul',requestId:randomUUID()};
    assert.equal((await call('/production-daily','alice','POST',entry)).status,403);
    assert.equal((await call('/production-daily','recorder','POST',{...entry,employeeId:'inactive'})).status,400);
    assert.equal((await call('/production-daily','recorder','POST',{...entry,quantity:0})).status,400);
    assert.equal((await call('/production-daily','recorder','POST',{...entry,day:'2026-02-30'})).status,400);
    const first=await call('/production-daily','recorder','POST',entry);assert.equal(first.status,201);
    assert.equal((await call('/production-daily','recorder','POST',entry)).status,200);assert.equal(f.entries.length,1);
    assert.equal((await call('/production-daily','recorder','POST',{...entry,quantity:30})).status,409);
    const race={...entry,requestId:randomUUID()};
    const raced=await Promise.all([call('/production-daily','recorder','POST',race),call('/production-daily','recorder','POST',race)]);
    assert.deepEqual(raced.map(x=>x.status).sort(),[200,201]);assert.equal(f.entries.length,2);
    const summary=(await call('/production-daily')).data;
    assert.equal(summary.byActivity[0].quantity,40);
    assert.equal(summary.employees.find(e=>e.id==='bob').production[0].quantity,40,'produção sem ponto é preservada');
    assert.equal(summary.employees.find(e=>e.id==='bob').attendance.state,'absent');
    assert.equal((await call('/production-daily?employeeId=bob','alice')).data.entries.length,0,'funcionário só consulta a própria produção');
    assert.equal((await call('/production-daily','bob')).data.entries.length,2);
    assert.equal((await call('/production-daily?day=invalid')).status,400);
    assert.equal((await call('/production-daily/'+first.data.entry.id,'alice','DELETE')).status,403);
    assert.equal((await call('/production-daily/'+first.data.entry.id,'recorder','DELETE')).status,200);
    assert.equal((await call('/production-daily/'+first.data.entry.id,'recorder','DELETE')).status,200);
    assert.equal((await call('/production-daily')).data.byActivity[0].quantity,20);
    assert.equal(f.entries.length,2,'cancelamento preserva registro');
    f.people.find(p=>p.id==='bob').active=false;
    assert.equal((await call('/production-daily')).data.employees.some(e=>e.id==='bob'),true,'histórico de funcionário inativado permanece');
    console.log('OK: horas, intervalos, fuso, sequência, permissões, produção por atividade, reenvio concorrente, cancelamento e histórico.');
  } finally { await new Promise(resolve=>server.close(resolve)); }
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture};
