'use strict';
const assert=require('node:assert/strict');
const scope=require('../src/services/stocktakeScope');

const cases=[
 ['legacy Actvitta shoe with concordant category/NCM',{name:'SAPATO CASUAL FEMININA DE USO COMUM COM SOLA SINTE',category:'tenis',ncm:'64041900'},'footwear'],
 ['legacy Fiber training shoe with concordant category/NCM',{name:'SAPATILHA TRAINING - FIBER 0998-V2 34/35',category:'Tênis',ncm:'64041900'},'footwear'],
 ['current variant size does not depend on a legacy name suffix',{name:'SAPATILHA TRAINING - FIBER 0896-V2 38/39',category:'Tênis',ncm:'64041900'},'footwear'],
 ['normalizes category accents and fiscal punctuation',{name:'SAPATILHA TRAINING',category:' Calçados ',ncm:'6404.19.00'},'footwear'],
 ['footwear category alone cannot resolve legacy shoe',{name:'SAPATO CASUAL',category:'Tênis',ncm:''},'outside'],
 ['footwear NCM alone cannot resolve legacy shoe',{name:'SAPATO CASUAL',category:'A CLASSIFICAR',ncm:'64041900'},'outside'],
 ['conflicting NCM cannot resolve legacy shoe',{name:'SAPATILHA TRAINING',category:'Tênis',ncm:'61091000'},'outside'],
 ['footwear parts NCM does not establish a complete shoe',{name:'SAPATILHA TRAINING',category:'Calçados',ncm:'64069090'},'outside'],
 ['generic imported product with only fiscal evidence stays pending',{name:'PRODUTO REF EAN-19495869043460',category:'A CLASSIFICAR',ncm:'64041100'},'review'],
 ['generic accessory category and footwear NCM stay pending',{name:'Modelo importado',category:'Acessórios',ncm:'64041900'},'review'],
 ['clothing name overrides incorrect footwear category and NCM',{name:'CAMISA DE TENIS',category:'Tênis',ncm:'64041900'},'outside'],
 ['sock name overrides incorrect footwear category and NCM',{name:'MEIA SAPATILHA',category:'Tênis',ncm:'64041900'},'outside'],
 ['accessory name overrides incorrect footwear category and NCM',{name:'PALMILHA CALCADO ESPORTIVO',category:'Calçados',ncm:'64041900'},'outside'],
 ['ball name overrides incorrect footwear category and NCM',{name:'BOLA DE TENIS',category:'Tênis',ncm:'64041900'},'outside'],
 ['generic clothing not admitted',{name:'Modelo importado',category:'Vestuário',ncm:'61091000'},'outside'],
 ['generic accessory not admitted',{name:'Modelo importado',category:'Acessórios',ncm:'42029200'},'outside'],
 ['existing sneaker name behavior retained',{name:'Tênis esportivo',category:'Tênis',ncm:'64041100'},'footwear'],
 ['existing cleat name behavior retained',{name:'Chuteira society',category:'Chuteiras',ncm:'64021900'},'footwear'],
 ['existing sandal name behavior retained',{name:'Sandália esportiva',category:'Sandálias',ncm:'64029990'},'footwear'],
 ['generic category and NCM disagreement stays pending',{name:'Modelo importado',category:'Tênis',ncm:'61091000'},'review'],
];

(async()=>{
 for(const [label,product,expected]of cases){const before=JSON.stringify(product);assert.equal(scope.classification(product),expected,label);assert.equal(JSON.stringify(product),before,'Classifier is read-only: '+label)}
 const products=cases.map(([label,product],index)=>({...product,id:String(index),label}));
 const built=await scope.build({product:{findMany:async()=>products}},'footwear');
 assert.deepEqual(built.productIds,products.filter((_,i)=>cases[i][2]==='footwear').map(p=>p.id));
 assert.deepEqual(built.reviewProductIds,products.filter((_,i)=>cases[i][2]==='review').map(p=>p.id));
 assert.equal(built.productIds.includes('10'),false,'A misleading footwear category/NCM cannot include a shirt');
 assert.equal(built.productIds.includes('8'),false,'Unclassified Nike placeholder remains a review item');
 assert.deepEqual(await scope.build({product:{findMany:()=>{throw Error('all must not query catalog')}}},'all'),{type:'all'});
 console.log('PASS: '+cases.length+' classification cases; concordant footwear category/NCM precedes legacy shoe names; clothing/accessories, generic fiscal-only records and conflicting NCM remain blocked; no catalog mutation.');
})().catch(error=>{console.error(error);process.exitCode=1});
