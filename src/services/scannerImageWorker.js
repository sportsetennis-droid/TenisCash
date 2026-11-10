'use strict';
// IPC worker only: no database, HTTP listener or paid API.
if (typeof process.send !== 'function') throw Error('scanner image worker requires IPC');
const sharp = require('sharp');
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 16 });
const diagnostic=require('./scannerRuntimeDiagnostic');
let busy = false,activeId=null;
function send(message) {
  if (process.connected) process.send(message, error => { if (error) process.exit(1); });
}
const runtime={platform:process.platform,arch:process.arch,node:process.versions.node,sharp:sharp.versions.sharp,vips:sharp.versions.vips,
 tesseract:require('tesseract.js/package.json').version,mallocArenaMax:Number(process.env.MALLOC_ARENA_MAX),allocatorOverridePresent:!!process.env.LD_PRELOAD};
const memory = () => {if(activeId)send({type:'memory',id:activeId,rss:process.memoryUsage().rss});};
const processor = require('./scannerImageProcessor').createProcessor();
setInterval(memory, 250).unref();
process.on('disconnect', () => process.exit(0));
process.on('message', async message => {
  if (!message || message.type !== 'run' || busy || !['label', 'barcode'].includes(message.kind) ||
      typeof message.id !== 'string' || !Buffer.isBuffer(message.image) || !message.image.length || message.image.length > 12 * 1024 * 1024) {
    process.exit(1); return;
  }
  busy = true;activeId=message.id;
  const jobId=message.id,startedAt=Date.now();
  const report=fields=>send({type:'diagnostic',id:jobId,diagnostic:diagnostic.sanitize({source:diagnostic.SOURCE,...runtime,...fields,
   phaseElapsedMs:Date.now()-startedAt,rssBytes:process.memoryUsage().rss})});
  try {
    report({phase:'starting'});
    const result = await processor.run(message.kind, message.image, message.barcode,report,typeof message.hint==='string'?message.hint:null);
    memory(); send({ type: 'result', id: message.id, result });
  } catch (_) {
    // Native/worker errors invalidate this process. Don't expose photo/vendor
    // error content to the parent; retry uses the same archived capture.
    send({ type: 'failure', id: message.id });
    setImmediate(() => process.exit(1));
  } finally { busy = false;activeId=null; }
});
send({ type: 'ready' });
