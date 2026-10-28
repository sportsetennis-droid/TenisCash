'use strict';
const barcodePolicy=require('../../public/scanner-barcode-policy');
function captureComplete(capture,bipe,size,needsSize){
 return Boolean(capture?.status==='vinculado' && !capture.excludedAt && barcodePolicy.isScanCode(capture.barcode) &&
 bipe?.found && !bipe.duplicate && !bipe.excludedAt && size?.product?.active && size.productId===bipe.productId &&
 size.id===bipe.productSizeId && size.size && !/^(?:\?|T-|REF:)/i.test(size.size) && !needsSize && bipe.barcode===capture.barcode);
}
module.exports={captureComplete};
