'use strict';
// Scope belongs to a count, never to the catalog or to the scanner globally.
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
const excludedName = /\b(?:VESTUARIO|CAM|CAMISA|CAMISETAS?|BERMUDAS?|SHORTS?|CALCAO|CALCAS?|LEGGINGS?|REGATAS?|CASACOS?|JAQUETAS?|COLETES?|TOP|BRA|TANK|T[ -]SHIRT|SOCKS?|MEIAS?|MEIAO|TRIPACK|TRIPK|JOELHEIRAS?|COTOVELEIRAS?|TORNOZELEIRAS?|CANELEIRAS?|MUNHEQUEIRAS?|PROTETORES?|LUVAS?|BOLAS?|BOLINHAS?|REDES?|RAQUETES?|MOCHILAS?|BOLSAS?|MALAS?|BONE|BONES|VISEIRAS?|OCULOS|TOUCAS?|NECESSAIRES?|CARTEIRAS?|GARRAFAS?|SQUEEZE|GYM BAG|GYM SACK|ACESSORIOS?|CHAVEIROS?|PALMILHAS?|CADARCOS?|PDVS|TOTEM|DEPOSITO)\b/;
const footwearName = /\b(?:TENIS|SAPATENIS|SAPATOS?|CHUTEIRAS?|SANDALIAS?|CHINELOS?|SLIDES?|BOTAS?|SAPATILHAS?|TAMANCOS?|MULES?|CALCADOS?)\b/;
const footwearCategory = /^(?:TENIS|CALCADOS?|CHUTEIRAS?|SANDALIAS?|CHINELOS?|FOOTWEAR|SHOES?)$/;
const otherCategory = /^(?:ROUPAS?|VESTUARIO|ACESSORIOS?|BOLA|INSUMO)$/;
function classification(product) {
  const name=normalize(product?.name), category=normalize(product?.category), ncm=String(product?.ncm||'').replace(/\D/g,'');
  if (excludedName.test(name)) return 'outside';
  if (/\b(?:BOTAS?|SAPATOS?|SAPATILHAS?|TAMANCOS?|MULES?)\b/.test(name) && !/\bCHUTEIRAS?\b/.test(name)) return 'outside';
  if (footwearName.test(name)) return 'footwear';
  const categoryMatches=footwearCategory.test(category), fiscalMatches=/^640[1-5]\d{4}$/.test(ncm);
  if (categoryMatches && (!ncm || fiscalMatches)) return 'footwear';
  // Imported NCM/category conflicts are not permission to zero other merchandise.
  if (categoryMatches || fiscalMatches) return 'review';
  if (otherCategory.test(category) || ncm) return 'outside';
  return 'outside';
}
function type(scope) { return scope?.type || 'all'; }
function validateType(value) {
  const selected=value == null ? 'all' : value;
  if (!['all','footwear'].includes(selected)) { const e=Error('Selecione todos os produtos ou somente calçados para esta contagem.');e.status=400;throw e; }
  return selected;
}
async function build(db, selected) {
  const scopeType=validateType(selected);
  if (scopeType==='all') return {type:'all'};
  const products=await db.product.findMany({select:{id:true,name:true,category:true,ncm:true},orderBy:{id:'asc'}});
  return {type:'footwear',version:1,productIds:products.filter(p=>classification(p)==='footwear').map(p=>p.id),reviewProductIds:products.filter(p=>classification(p)==='review').map(p=>p.id)};
}
function includes(scope, product) { return type(scope)==='all'||!!product&&Array.isArray(scope.productIds)&&scope.productIds.includes(product.id); }
function description(scope) { return type(scope)==='footwear'?'Contagem de tênis, chuteiras e sandálias':'Todos os produtos da loja'; }
module.exports={classification,type,validateType,build,includes,description};
