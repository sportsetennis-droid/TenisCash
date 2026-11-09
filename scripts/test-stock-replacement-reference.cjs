'use strict';
const assert=require('node:assert/strict');
const service=require('../src/services/stockReplacement');
const scope=require('../src/services/stocktakeScope');

function context(sku='GTM-220644-BKW',brand='SKECHERS',aiContext={supplierRef:sku}){
 const product={id:'test-product',active:true,name:'GO RUN 7.0',category:'Tênis',ncm:'64041100',brand,sku,aiContext};
 return {bipe:{barcode:'0196989405971',found:true,productId:product.id},round:{status:'counting'},
  capture:{photo:'data:image/png;base64,dGVzdA==',barcode:'0196989405971'},
  size:{id:'test-size',productId:product.id,size:'41',product}};
}
const evidence=(references,text='SKECHERS')=>({source:'archived-photo-local-ocr-v1',decodedBarcodes:['0196989405971'],size:'41',references,text});
const db={async $queryRaw(){return []}};

(async()=>{
 for(const [sku,printed] of [
  ['GTM-220644-BKW','220644BKW'],['GTW-129627-ORG','129627ORG'],
  ['GTM-894339BR-LIME','894339BRLIME'],['T-894294BR-NVY','894294BRNVY'],
  ['R-150510-BLMT','150510BLMT']]){
  assert.equal(await service.referenceMatches(db,context(sku),evidence([printed])),printed);
 }
 assert.equal(await service.referenceMatches(db,context(),evidence(['220644/BKW'])),'220644/BKW');
 assert.equal(await service.referenceMatches(db,context(),evidence(['220644'])) ,null,'Model alone cannot confirm its colour');
 assert.equal(await service.referenceMatches(db,context(),evidence(['220645BKW'])),null,'Neighbour model must not match');
 assert.equal(await service.referenceMatches(db,context(),evidence(['220644NVY'])),null,'Different colour must not match');
 assert.equal(await service.referenceMatches(db,context(),evidence(['220644BKW','220644NVY'])),null,'Conflicting references from multiple labels remain pending');
 assert.equal(await service.referenceMatches(db,context(),evidence(['220644BKW'],'SKECHERS NIKE')),null,'Conflicting brand remains pending');
 assert.equal(await service.referenceMatches(db,context('GTM-220644-BKW','NIKE'),evidence(['220644BKW'],'NIKE')),null,'Prefix normalization is not generalized to other brands');
 const legacy=context('GTM-894339BR-LIME','SKECHERS',{supplierRef:'GTM-894339BR-LIME',scannerReferences:['GTM-894339BR-BLK','894339BR']});
 assert.equal(await service.referenceMatches(db,legacy,evidence(['894339BRLIME'])),'894339BRLIME');
 assert.equal(await service.referenceMatches(db,legacy,evidence(['GTM-894339BR-BLK'])),null,'Old alias cannot override current model/colour');
 assert.equal(await service.referenceMatches(db,legacy,evidence(['894339BR'])),null,'Old model-only alias cannot bypass complete reference');
 const conflicting=context('GTM-220644-BKW','SKECHERS',{supplierRef:'GTM-220644-NVY'});
 assert.equal(await service.referenceMatches(db,conflicting,evidence(['220644BKW'])),null,'Catalog and supplier reference conflict stays pending');
 const fiscalDb={async $queryRaw(){return [{productId:'test-product',supplierCode:'GTM-220644-NVY'}]}};
 assert.equal(await service.referenceMatches(fiscalDb,context(),evidence(['220644BKW'])),null,'Exact-barcode fiscal colour conflict stays pending');
 const unrelatedDb={async $queryRaw(){return [{productId:'different-product',supplierCode:'GTM-220644-NVY'}]}};
 assert.equal(await service.referenceMatches(unrelatedDb,context(),evidence(['220644BKW'])),'220644BKW','Unrelated product fiscal reference is not borrowed');
 const reebok=context('100211606','REEBOK');
 assert.equal(await service.referenceMatches(db,reebok,evidence(['100211606'],'REEBOK')),'100211606','Existing exact reference behavior is preserved');
 const c=context(),read=evidence(['220644BKW']);
 assert.equal(service.validateRead(c,read),null);
 assert.equal(service.validateRead({...c,capture:{...c.capture,photo:null}},read),'foto_ou_codigo_pendente');
 assert.equal(service.validateRead(c,{...read,decodedBarcodes:['0196989405988']}),'codigo_da_foto_divergente');
 assert.equal(service.validateRead(c,{...read,size:'42'}),'tamanho_da_foto_divergente');
 assert.equal(service.validateRead(c,{...read,source:'client-ocr'}),'codigo_da_foto_divergente');
 assert.equal(scope.classification({name:'SAPATO CASUAL FEMININA DE USO COMUM COM SOLA SINTE',category:'tenis',ncm:'64041900'}),'outside','Existing footwear scope is not broadened from ambiguous imported category');
 console.log('PASS: Skechers catalog prefixes preserve full model/colour, reject model-only and conflicting aliases/fiscal/brand, and retain archived photo/code/BR requirements.');
})().catch(error=>{console.error(error);process.exitCode=1});
