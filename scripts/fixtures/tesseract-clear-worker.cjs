'use strict';
// DIAGNOSTIC ONLY: explicit workerPath, not enabled by the application.
// Original integration glue following Tesseract.js v7.0.0's Node adapter.
// Upstream Node adapter authors: Kevin Kwok <antimatter15@gmail.com>,
// Guillermo Webster <gui@mit.edu>, Jerome Wu <jeromewus@gmail.com>.
// Upstream is Apache-2.0 (not MIT):
// https://github.com/naptha/tesseract.js/blob/v7.0.0/LICENSE.md
// https://github.com/naptha/tesseract.js/blob/v7.0.0/src/worker-script/node/index.js
// The exact core source confirms Clear frees page images, preserving the model,
// dictionaries and parameters; see TESSERACT-CLEAR-AUDIT.md beside this file.
const path = require('node:path');
const { createRequire } = require('node:module');
const wrapped = new WeakSet();

function wrapCoreFactory(Core) {
  if (typeof Core !== 'function') throw new Error('Unsupported Tesseract core factory');
  return async function createSameCore(options) {
    const core = await Core(options);
    const prototype = core?.TessBaseAPI?.prototype;
    if (!prototype || typeof prototype.Clear !== 'function' || typeof prototype.SetImageFile !== 'function') {
      throw new Error('Unsupported Tesseract core: Clear and SetImageFile are required');
    }
    if (!wrapped.has(prototype)) {
      const setImageFile = prototype.SetImageFile;
      prototype.SetImageFile = function clearBeforeImage(...args) {
        this.Clear();
        return Reflect.apply(setImageFile, this, args);
      };
      wrapped.add(prototype);
    }
    return core;
  };
}

function boot() {
  // Workers inherit cwd. The optional root only selects the installed package;
  // it never changes the core path, OEM, language or recognition parameters.
  const appRoot = process.env.SCANNER_TESSERACT_APP_ROOT || process.cwd();
  const requireApp = createRequire(path.join(appRoot, 'package.json'));
  const packageFile = requireApp.resolve('tesseract.js/package.json');
  const requireTesseract = createRequire(packageFile);
  const version = requireApp(packageFile).version;
  const coreVersion = requireTesseract('tesseract.js-core/package.json').version;
  if (version !== '7.0.0' || coreVersion !== '7.0.0') {
    throw new Error(`Unsupported Tesseract versions: js=${version}, core=${coreVersion}; audited 7.0.0 only`);
  }
  const source = (...parts) => path.join(path.dirname(packageFile), 'src', ...parts);
  const dispatcher = requireTesseract(source('worker-script', 'index.js'));
  const getCore = requireTesseract(source('worker-script', 'node', 'getCore.js'));
  const adapter = {
    // Preserve the original core selection and forward every original argument.
    // Do not correct or alter OEM/core selection in this isolated experiment.
    getCore: async (...args) => wrapCoreFactory(await getCore(...args)),
    gunzip: requireTesseract(source('worker-script', 'node', 'gunzip.js')),
    fetch: global.fetch || requireTesseract('node-fetch'),
    ...requireTesseract(source('worker-script', 'node', 'cache.js')),
  };
  dispatcher.setAdapter(adapter);
  const { parentPort } = require('node:worker_threads');
  if (!parentPort) throw new Error('This diagnostic worker must run in a worker thread');
  parentPort.on('message', packet => {
    dispatcher.dispatchHandlers(packet, response => parentPort.postMessage(response));
  });
}

module.exports = { wrapCoreFactory, boot };
if (require.main === module) boot();
