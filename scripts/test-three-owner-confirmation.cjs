'use strict';
// Offline review of the exact two immutable operational manifests. No database,
// request producer, runtime signing key or deployed worker is accessed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const newFile=process.argv[2],oldFile=process.argv[3];assert.ok(newFile&&oldFile,'Pass the reviewed 3-target manifest and the unchanged original 48-target manifest');
const sha=x=>createHash('sha256').update(String(x||'')).digest('hex'),text=fs.readFileSync(newFile,'utf8'),oldText=fs.readFileSync(oldFile,'utf8');
const manifest=JSON.parse(text),old=JSON.parse(oldText),service=require('../src/services/finiteOwnerConfirmation');
const source=fs.readFileSync(path.join(__dirname,'../src/services/finiteOwnerConfirmation.js'),'utf8').replace(/\r\n/g,'\n');
const fn=source.match(/function validateRequest\(request,allowed\)\{[\s\S]*?\n\}\nasync function metadata/)[0].replace(/\nasync function metadata$/,'');
const reject=code=>{const e=Error(code);e.maintenanceReason=code;throw e;};
const validate=vm.runInNewContext('('+fn+')',{sha,reject,SOURCE:'explicit-owner-chat-confirmation-v1',EXECUTOR:'system-maintenance',policy:require('../public/scanner-barcode-policy')});
const oldOperation='douglas-explicit-48-physical-pairs-20261109',operation='douglas-explicit-3-additional-physical-pairs-20261109';
const newSha='45395afa770811f741cd79a16058671cf98ca5e5a24d511a882cbe1e76f13b02',oldSha='5c08214c1f48d1d6d57725cb519828f9facb037d6483de7d035596d6630d1c50';
const ids=['cmw9wzhiw00453ni1rtdm3kzx','cmw9wzn44004h3ni13v5gk98l','cmw9wzqgz004m3ni1wlc4xpzd'];
assert.equal(sha(text),newSha);assert.equal(sha(oldText),oldSha);assert.equal(manifest.operationId,operation);
assert.equal(manifest.userStatement,'Sim, eram outros 3 pares físicos');assert.equal(manifest.statementExactTime,null);assert.equal(manifest.confirmedBy,'Douglas');
assert.equal(manifest.executor,'system-maintenance');assert.equal(manifest.quantity,3);
assert.deepEqual(manifest.targets.map(t=>t.captureId),ids);assert.deepEqual(manifest.targets.map(t=>t.barcode),['4067979323215','4067979749091','4067979749114']);
assert.equal(old.targets.length,48);assert.ok(manifest.targets.every(t=>!old.targets.some(x=>x.captureId===t.captureId||x.scanKey===t.scanKey)));
assert.deepEqual(service.definitions[oldOperation],{manifestSha256:oldSha,roundId:'ca042063-2801-4613-a82c-a47f1e07f140',storeId:'01b5a498-4dce-49b9-b359-5b031936aae9',count:48,canaryId:'cmw9rvc5c017f35kgtkqwixvd'});
assert.deepEqual(service.definitions[operation],{manifestSha256:newSha,roundId:'ca042063-2801-4613-a82c-a47f1e07f140',storeId:'01b5a498-4dce-49b9-b359-5b031936aae9',count:3,canaryId:ids[0]});
const request={operation_id:operation,manifest_sha256:newSha,manifest_text:text,requested_by:'system-maintenance',source:'explicit-owner-chat-confirmation-v1',stage:'canary'};
assert.deepEqual(Array.from(validate(request,service.definitions).targets,t=>t.captureId),ids.slice(0,1));
assert.deepEqual(Array.from(validate({...request,stage:'rest'},service.definitions).targets,t=>t.captureId),ids.slice(1));
let rejected=0;const bad=(r,defs=service.definitions)=>{assert.throws(()=>validate(r,defs),e=>!!e.maintenanceReason);rejected++;};
for(const mutation of [{manifest_text:text+' '},{manifest_sha256:oldSha},{operation_id:oldOperation},{operation_id:'unapproved-operation'},
 {requested_by:'client'},{source:'client-confirmed'},{stage:'all'}])bad({...request,...mutation});
for(const field of ['roundId','storeId','captureId','scanKey','sellerId','barcode','photoRevision','photoDataUrlSha256']){
 const altered=JSON.parse(text);altered.targets[0][field]='changed';bad({...request,manifest_text:JSON.stringify(altered)});
}
for(const altered of [{...manifest,targets:manifest.targets.slice(1)},{...manifest,targets:[manifest.targets[0],manifest.targets[0],manifest.targets[2]]},
 {...manifest,userStatement:'Invented statement'}])bad({...request,manifest_text:JSON.stringify(altered)});
for(const mutation of [{count:4},{canaryId:'foreign-capture'},{roundId:'foreign-round'},{storeId:'foreign-store'}])bad(request,{...service.definitions,[operation]:{...service.definitions[operation],...mutation}});
console.log(JSON.stringify({pass:true,databaseAccess:false,jwtLoaded:false,manifestSha256:newSha,original48Unchanged:true,
 exactNewTargets:3,stageCounts:[1,2],rejectedCases:rejected,checks:'Actual runtime validator accepts only the separately approved 3-ID manifest and its 1+2 stages; original 48 definition unchanged; tampered provenance, IDs, context, photos and count rejected.'}));
