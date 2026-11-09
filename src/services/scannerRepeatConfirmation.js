'use strict';
const {createHash,createHmac,timingSafeEqual}=require('node:crypto');
const policy=require('../../public/scanner-barcode-policy');
const staff=require('./scanTransfers');
const markerPattern=/\n\[scanner-repeat-confirmed-v1:(\d{1,16}):(\d{13}):([a-f0-9]{64})\]/g;
const ownerPattern=/\n\[scanner-repeat-owner-v1:(\d{1,16}):(\d{13}):([a-f0-9]{64}):([a-f0-9]{64})\]/g;
const revisionPattern=/\n\[scanner-photo-revision:(\d{1,30})\]$/;
const source='authenticated-repeat-confirmation-v1';
const digest=value=>createHash('sha256').update(String(value||'')).digest('hex');
function secret(){const value=process.env.JWT_SECRET;return typeof value==='string'&&value.length>=16&&value!=='teniscash-secret-change-in-production'?value:null;}
function revision(note){return String(note||'').match(revisionPattern)?.[1]||'';}
function strip(note){return String(note||'').replace(/\n?\[scanner-repeat-(?:confirmed|owner)-v1:[^\]]*\]/g,'');}
function marker(note){const text=String(note||''),matches=[...text.matchAll(markerPattern),...text.matchAll(ownerPattern)];return matches.length===1&&(text.match(/scanner-repeat-(?:confirmed|owner)-v1:/g)||[]).length===1?matches[0][0]:'';}
function signedData(capture,count,at){return JSON.stringify(['teniscash/scanner-repeat/v1',capture.id,capture.roundId,capture.storeId,capture.scanKey,
 capture.sellerId,capture.sellerName||null,new Date(capture.createdAt).getTime(),revision(capture.note),digest(capture.photo),policy.identity(capture.barcode),count,at]);}
function signature(capture,count,at,key){return createHmac('sha256',key).update(signedData(capture,count,at)).digest('hex');}
function ownerSignature(capture,count,at,manifestSha256,key){return createHmac('sha256',key).update(JSON.stringify(['teniscash/scanner-repeat/owner-review/v1',manifestSha256,signedData(capture,count,at)])).digest('hex');}
function confirmed(capture,currentCount){
 const key=secret(),proof=marker(capture?.note),owner=[...proof.matchAll(ownerPattern)][0],parts=owner||[...proof.matchAll(markerPattern)][0];
 if(!key||!parts||!capture?.sellerId||!capture.photo||!revision(capture.note)||capture.excludedAt||capture.status==='descartado')return null;
 const count=Number(parts[1]),at=Number(parts[2]);
 if(!Number.isSafeInteger(count)||count<0||(!owner&&(count<1||count!==currentCount))||!Number.isSafeInteger(at)||at>Date.now()+60000)return null;
 if(owner){
  if(!timingSafeEqual(Buffer.from(parts[4],'hex'),Buffer.from(ownerSignature(capture,count,at,parts[3],key),'hex')))return null;
  return {source:'explicit-owner-chat-confirmation-v1',observedPriorCount:count,confirmedAt:new Date(at).toISOString(),
   manifestSha256:parts[3],executor:'system-maintenance',originalSellerId:capture.sellerId};
 }
 if(!timingSafeEqual(Buffer.from(parts[3],'hex'),Buffer.from(signature(capture,count,at,key),'hex')))return null;
 return {source,count,confirmedAt:new Date(at).toISOString(),actorId:capture.sellerId};
}
function withMarker(capture,proof){const suffix='\n[scanner-photo-revision:'+revision(capture.note)+']';
 return strip(capture.note).replace(revisionPattern,'').slice(0,480-proof.length-suffix.length)+proof+suffix;}
function fail(message,status=409){const error=Error(message);error.status=status;throw error;}
// Called only inside the authenticated photo-save transaction. It records an
// explicit current-count decision; it never manufactures historical approval.
async function record(tx,capture,input={}){
 const count=typeof input.confirmedCount==='number'?input.confirmedCount:
  typeof input.confirmedCount==='string'&&/^\d+$/.test(input.confirmedCount)?Number(input.confirmedCount):NaN;
 if(!Number.isSafeInteger(count)||count<1||capture.bipeId)return capture;
 if(input.actorId!==capture.sellerId)fail('A confirmação deve vir do operador original desta leitura.',403);
 if(capture.excludedAt||capture.status==='descartado'||capture.photo!==input.photo||
    revision(capture.note)!==String(input.photoRevision||'')||policy.identity(capture.barcode)!==policy.identity(input.barcode))
  fail('A foto ou o código mudou. Confirme a leitura atual antes de registrar outro par.');
 const round=await tx.stocktakeRound.findUnique({where:{id:capture.roundId},select:{storeId:true,status:true,operationType:true}});
 if(round?.operationType!=='replacement'||round.status!=='counting'||round.storeId!==capture.storeId)fail('Esta confirmação não pertence a uma rodada ativa.');
 const store=await tx.store.findUnique({where:{id:capture.storeId},select:{active:true}});
 if(!store?.active||!staff.canSend(await staff.operator(tx,input.actorId),capture.storeId))fail('Operador sem autorização para confirmar nesta loja.',403);
 await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${capture.roundId+':barcode:'+policy.identity(capture.barcode)}))::text`;
 const current=await tx.stocktakeBipe.count({where:{roundId:capture.roundId,storeId:capture.storeId,excludedAt:null,barcode:{in:policy.variants(capture.barcode)}}});
 if(current!==count)return capture;
 const key=secret();if(!key)fail('Não foi possível arquivar a confirmação de outro par. Tente novamente; nenhuma nova unidade foi autorizada.',503);
 const at=Date.now(),proof='\n[scanner-repeat-confirmed-v1:'+count+':'+at+':'+signature(capture,count,at,key)+']';
 const note=withMarker(capture,proof);
 const saved=await tx.productCapture.update({where:{id:capture.id},data:{note}});
 if(!confirmed(saved,count))fail('A confirmação de outro par não foi preservada. Tente novamente.',503);
 return saved;
}
// Maintenance-only entry point. No HTTP route imports this function or accepts
// owner-review provenance. A finite, immutable manifest records the explicit
// owner's statement separately from each capture's original operator.
async function recordOwnerReview(tx,capture,{manifestText}={}){
 let review;try{review=JSON.parse(manifestText)}catch(_){fail('Manifesto de confirmação inválido.');}
 if(review?.source!=='explicit-owner-chat-confirmation-v1'||review.executor!=='system-maintenance'||
    !review.operationId||!review.confirmedBy||!review.userStatement||!Array.isArray(review.targets))fail('Origem da confirmação do proprietário ausente.');
 const entries=review.targets.filter(x=>x.captureId===capture.id);if(entries.length!==1)fail('Captura fora do manifesto confirmado.');
 const entry=entries[0];
 await tx.$queryRaw`SELECT id FROM "StocktakeRound" WHERE id=${capture.roundId} FOR UPDATE`;
 await tx.$queryRaw`SELECT id FROM "ProductCapture" WHERE id=${capture.id} FOR UPDATE`;
 const current=await tx.productCapture.findUnique({where:{id:capture.id}});
 if(!current||['id','roundId','storeId','scanKey','sellerId','sellerName','barcode','photo'].some(field=>capture[field]!==current[field])||
    revision(capture.note)!==revision(current.note)||new Date(capture.createdAt).getTime()!==new Date(current.createdAt).getTime())fail('A captura mudou antes de registrar a confirmação.');
 capture=current;
 if(capture.excludedAt||capture.status==='descartado'||capture.bipeId)fail('Captura já vinculada ou retirada; conferir antes de confirmar.');
 for(const field of ['roundId','storeId','scanKey','sellerId','sellerName','barcode'])if(entry[field]!==capture[field])fail('O contexto da captura mudou desde a confirmação.');
 if(entry.photoDataUrlSha256!==digest(capture.photo)||entry.photoRevision!==revision(capture.note)||
    new Date(entry.createdAt).getTime()!==new Date(capture.createdAt).getTime())fail('A foto ou revisão mudou desde a confirmação.');
 const round=await tx.stocktakeRound.findUnique({where:{id:capture.roundId},select:{storeId:true,status:true,operationType:true}});
 if(round?.operationType!=='replacement'||round.status!=='counting'||round.storeId!==capture.storeId)fail('Rodada inativa para a confirmação.');
 const key=secret();if(!key)fail('Chave vigente ausente; confirmação não registrada.',503);
 await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${capture.roundId+':barcode:'+policy.identity(capture.barcode)}))::text`;
 const count=await tx.stocktakeBipe.count({where:{roundId:capture.roundId,storeId:capture.storeId,excludedAt:null,barcode:{in:policy.variants(capture.barcode)}}});
 const at=Date.now(),hash=digest(manifestText),proof='\n[scanner-repeat-owner-v1:'+count+':'+at+':'+hash+':'+ownerSignature(capture,count,at,hash,key)+']';
 const saved=await tx.productCapture.update({where:{id:capture.id},data:{note:withMarker(capture,proof)}});
 if(confirmed(saved,count)?.manifestSha256!==hash)fail('Confirmação do manifesto não foi preservada.',503);
 return saved;
}
module.exports={record,recordOwnerReview,confirmed,marker,strip,source};
