'use strict';
// Default: hermetic CI fixtures in memory, with production definitions checked
// unchanged. Optional two file arguments also verify the real reviewed manifests.
// Neither mode accesses a database, signing key or deployed worker.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const args=process.argv.slice(2);assert.ok(args.length===0||args.length===2,'Use no arguments for hermetic CI, or pass both reviewed manifests (3 and original 48)');
const sha=x=>createHash('sha256').update(String(x||'')).digest('hex'),service=require('../src/services/finiteOwnerConfirmation');
const productionBefore=JSON.stringify(service.definitions);
const source=fs.readFileSync(path.join(__dirname,'../src/services/finiteOwnerConfirmation.js'),'utf8').replace(/\r\n/g,'\n');
const fn=source.match(/function validateRequest\(request,allowed\)\{[\s\S]*?\n\}\nasync function metadata/)[0].replace(/\nasync function metadata$/,'');
const reject=code=>{const e=Error(code);e.maintenanceReason=code;throw e;};
const validate=vm.runInNewContext('('+fn+')',{sha,reject,SOURCE:'explicit-owner-chat-confirmation-v1',EXECUTOR:'system-maintenance',policy:require('../public/scanner-barcode-policy')});
const oldOperation='douglas-explicit-48-physical-pairs-20261109',operation='douglas-explicit-3-additional-physical-pairs-20261109';
const newSha='45395afa770811f741cd79a16058671cf98ca5e5a24d511a882cbe1e76f13b02',oldSha='5c08214c1f48d1d6d57725cb519828f9facb037d6483de7d035596d6630d1c50';
const realIds=['cmw9wzhiw00453ni1rtdm3kzx','cmw9wzn44004h3ni13v5gk98l','cmw9wzqgz004m3ni1wlc4xpzd'];
assert.deepEqual(service.definitions[oldOperation],{manifestSha256:oldSha,roundId:'ca042063-2801-4613-a82c-a47f1e07f140',storeId:'01b5a498-4dce-49b9-b359-5b031936aae9',count:48,canaryId:'cmw9rvc5c017f35kgtkqwixvd'});
assert.deepEqual(service.definitions[operation],{manifestSha256:newSha,roundId:'ca042063-2801-4613-a82c-a47f1e07f140',storeId:'01b5a498-4dce-49b9-b359-5b031936aae9',count:3,canaryId:realIds[0]});
let text,manifest,ids,allowed;
if(args.length===2){
 text=fs.readFileSync(args[0],'utf8');const oldText=fs.readFileSync(args[1],'utf8'),old=JSON.parse(oldText);manifest=JSON.parse(text);ids=realIds;allowed=service.definitions;
 assert.equal(sha(text),newSha);assert.equal(sha(oldText),oldSha);assert.equal(manifest.operationId,operation);
 assert.equal(manifest.userStatement,'Sim, eram outros 3 pares físicos');assert.equal(manifest.statementExactTime,null);assert.equal(manifest.confirmedBy,'Douglas');
 assert.equal(manifest.executor,'system-maintenance');assert.equal(manifest.quantity,3);assert.deepEqual(manifest.targets.map(t=>t.captureId),ids);
 assert.deepEqual(manifest.targets.map(t=>t.barcode),['4067979323215','4067979749091','4067979749114']);assert.equal(old.targets.length,48);
 assert.ok(manifest.targets.every(t=>!old.targets.some(x=>x.captureId===t.captureId||x.scanKey===t.scanKey)));
}else{
 ids=['synthetic-capture-a','synthetic-capture-b','synthetic-capture-c'];
 manifest={operationId:operation,source:'explicit-owner-chat-confirmation-v1',executor:'system-maintenance',confirmedBy:'Synthetic test owner',
  userStatement:'Synthetic explicit confirmation for three test units',statementExactTime:null,quantity:3,
  targets:ids.map((id,i)=>({captureId:id,roundId:'synthetic-round',storeId:'synthetic-store',scanKey:'synthetic-round:unit-'+i,
   sellerId:'synthetic-operator',sellerName:'Synthetic operator',createdAt:'2026-01-01T00:00:00.000Z',barcode:['5901234123457','4006381333931','9780201379624'][i],
   photoRevision:'1',photoDataUrlSha256:sha('synthetic-photo-'+i)}))};
 text=JSON.stringify(manifest);
 // The synthetic hash is accepted only by a separate injected test registry.
 // The actual production allowlist must keep rejecting this test document.
 allowed={...service.definitions,[operation]:{manifestSha256:sha(text),roundId:'synthetic-round',storeId:'synthetic-store',count:3,canaryId:ids[0]}};
}
const request={operation_id:operation,manifest_sha256:sha(text),manifest_text:text,requested_by:'system-maintenance',source:'explicit-owner-chat-confirmation-v1',stage:'canary'};
let rejected=0;const bad=(r,defs=allowed)=>{assert.throws(()=>validate(r,defs),e=>!!e.maintenanceReason);rejected++;};
if(args.length===0)bad(request,service.definitions);
assert.deepEqual(Array.from(validate(request,allowed).targets,t=>t.captureId),ids.slice(0,1));
assert.deepEqual(Array.from(validate({...request,stage:'rest'},allowed).targets,t=>t.captureId),ids.slice(1));
for(const mutation of [{manifest_text:text+' '},{manifest_sha256:oldSha},{operation_id:oldOperation},{operation_id:'unapproved-operation'},
 {requested_by:'client'},{source:'client-confirmed'},{stage:'all'}])bad({...request,...mutation});
for(const field of ['roundId','storeId','captureId','scanKey','sellerId','barcode','photoRevision','photoDataUrlSha256']){
 const altered=JSON.parse(text);altered.targets[0][field]='changed';bad({...request,manifest_text:JSON.stringify(altered)});
}
for(const altered of [{...manifest,targets:manifest.targets.slice(1)},{...manifest,targets:[manifest.targets[0],manifest.targets[0],manifest.targets[2]]},
 {...manifest,userStatement:'Invented statement'}])bad({...request,manifest_text:JSON.stringify(altered)});
for(const mutation of [{count:4},{canaryId:'foreign-capture'},{roundId:'foreign-round'},{storeId:'foreign-store'}])bad(request,{...allowed,[operation]:{...allowed[operation],...mutation}});
assert.equal(JSON.stringify(service.definitions),productionBefore,'Injected test definitions must never mutate the production allowlist');
console.log(JSON.stringify({pass:true,mode:args.length?'reviewed-manifest-files':'hermetic-synthetic-ci',databaseAccess:false,jwtLoaded:false,
 productionDefinitionsVerified:true,original48DefinitionUnchanged:true,operationalManifestFilesVerified:args.length===2,
 testedManifestSha256:sha(text),productionManifestSha256:newSha,targetCount:3,stageCounts:[1,2],rejectedCases:rejected,
 checks:'Real runtime validator, exact production registry, isolated 1+2 test scope and rejection of tampered provenance/context/photos/count. Synthetic data is rejected by the production registry.'}));
