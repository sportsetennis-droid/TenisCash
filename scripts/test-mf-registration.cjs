'use strict';
const assert=require('node:assert/strict');
const express=require('express');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const create=require('../src/routes/mfRegistration');
(async()=>{
  const rows=[];
  const prisma={mfEmployee:{create:async({data})=>{
    if(rows.some(e=>e.username===data.username)){const err=new Error();err.code='P2002';throw err;}
    const emp={id:String(rows.length+1),...data};rows.push(emp);return emp;
  }}};
  const app=express();app.use(express.json());
  app.use('/api/mf',create({prisma,signToken:e=>jwt.sign({mf:true,id:e.id,role:e.role},'fixture-secret')}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const post=async body=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/mf/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  try{
    for(const body of [{},{name:'A',username:'a',pin:'1234'},{name:'A',username:'valid',pin:'abc1'},{name:'A',username:'valid',pin:'123'},{name:'A',username:'valid',pin:'1'.repeat(13)},{name:{x:1},username:'valid',pin:'1234'}])assert.equal((await post(body)).status,400);
    const r=await post({name:' Pessoa de teste ',username:' Pessoa.teste ',pin:'891234',role:'admin',canRecordProduction:true,active:false,baseSalary:99999});
    assert.equal(r.status,201);assert.equal(rows.length,1);assert.equal(rows[0].role,'funcionario');assert.equal(rows[0].active,true);assert.equal(rows[0].canRecordProduction,false);assert.equal(rows[0].baseSalary,undefined);
    assert.equal(rows[0].name,'Pessoa de teste');assert.equal(rows[0].username,'pessoa.teste');assert.ok(await bcrypt.compare('891234',rows[0].pinHash));assert.notEqual(rows[0].pinHash,'891234');
    assert.deepEqual(Object.keys(r.body),['token']);const claims=jwt.verify(r.body.token,'fixture-secret');assert.equal(claims.mf,true);assert.equal(claims.role,'funcionario');assert.equal(claims.id,rows[0].id);
    assert.equal((await post({name:'Outra',username:'PESSOA.TESTE',pin:'1234'})).status,409);assert.equal(rows.length,1);
    console.log('Cadastro Meta: validação, isolamento, PIN protegido, duplicação e perfil sem privilégios OK');
  }finally{server.close();server.closeAllConnections();}
})().catch(e=>{console.error(e);process.exitCode=1;});
