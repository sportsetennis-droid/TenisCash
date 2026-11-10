'use strict';
// Internal measurements only. This is never identity evidence or an HTTP field.
const SOURCE='scanner-runtime-diagnostic-v1';
const phases=new Set(['starting','decode','ocr-init','metadata','enhance','stretch','raster-metadata','ocr','done']);
const bounded=(value,max)=>Number.isFinite(value)&&value>=0&&value<=max;
function sanitize(value){
 if(!value||value.source!==SOURCE)return null;
 const out={source:SOURCE};
 if(phases.has(value.phase))out.phase=value.phase;
 if(['label','barcode'].includes(value.kind))out.kind=value.kind;
 if(['linux','win32','darwin'].includes(value.platform))out.platform=value.platform;
 if(['x64','arm64'].includes(value.arch))out.arch=value.arch;
 for(const key of ['node','sharp','vips','tesseract'])if(typeof value[key]==='string'&&/^\d{1,3}(?:\.\d{1,3}){1,3}$/.test(value[key]))out[key]=value[key];
 for(const key of ['rssBytes','peakRssObservedBytes','maxRssBytes'])if(bounded(value[key],16*1024**3))out[key]=Math.floor(value[key]);
 for(const key of ['elapsedMs','phaseElapsedMs','timeoutMs'])if(bounded(value[key],600000))out[key]=Math.floor(value[key]);
 for(const key of ['width','height'])if(Number.isInteger(value[key])&&value[key]>0&&value[key]<=24000)out[key]=value[key];
 if(out.width&&out.height)out.rasterPixels=out.width*out.height;
 if(Number.isInteger(value.pass)&&value.pass>=0&&value.pass<=128)out.pass=value.pass;
 if([0,90,180,270].includes(value.angle))out.angle=value.angle;
 if(['6','11'].includes(value.psm))out.psm=value.psm;
 if(typeof value.enhanced==='boolean')out.enhanced=value.enhanced;
 if(Number.isInteger(value.mallocArenaMax)&&value.mallocArenaMax>0&&value.mallocArenaMax<=128)out.mallocArenaMax=value.mallocArenaMax;
 if(typeof value.allocatorOverridePresent==='boolean')out.allocatorOverridePresent=value.allocatorOverridePresent;
 return out;
}
module.exports={SOURCE,sanitize};
