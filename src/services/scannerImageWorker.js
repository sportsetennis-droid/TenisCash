'use strict';
// IPC worker only: no database, HTTP listener or paid API.
if (typeof process.send !== 'function') throw Error('scanner image worker requires IPC');
const sharp = require('sharp');
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 16 });
const processor = require('./scannerImageProcessor').createProcessor();
let busy = false;
function send(message) {
  if (process.connected) process.send(message, error => { if (error) process.exit(1); });
}
const memory = () => send({ type: 'memory', rss: process.memoryUsage().rss });
setInterval(memory, 250).unref();
process.on('disconnect', () => process.exit(0));
process.on('message', async message => {
  if (!message || message.type !== 'run' || busy || !['label', 'barcode'].includes(message.kind) ||
      typeof message.id !== 'string' || !Buffer.isBuffer(message.image) || !message.image.length || message.image.length > 12 * 1024 * 1024) {
    process.exit(1); return;
  }
  busy = true;
  try {
    const result = await processor.run(message.kind, message.image, message.barcode);
    memory(); send({ type: 'result', id: message.id, result });
  } catch (_) {
    // Native/worker errors invalidate this process. Don't expose photo/vendor
    // error content to the parent; retry uses the same archived capture.
    send({ type: 'failure', id: message.id });
    setImmediate(() => process.exit(1));
  } finally { busy = false; }
});
send({ type: 'ready' });
