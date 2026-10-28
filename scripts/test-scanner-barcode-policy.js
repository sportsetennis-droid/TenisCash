'use strict';
const assert = require('node:assert/strict');
const policy = require('../public/scanner-barcode-policy');

const internal = '0615640591012795';
assert.equal(policy.isScanCode(internal), true, 'the printed 16-digit code is accepted');
assert.equal(policy.isInternalCode(internal), true);
assert.equal(policy.identity(internal), internal, 'the leading zero remains part of the exact identifier');
assert.deepEqual(policy.variants(internal), [internal], 'internal codes never alias to another length');
assert.equal(policy.isScanCode('061564059101279'), false, 'a truncated 15-digit read is rejected');
assert.equal(policy.isScanCode('0000000000000000'), false, 'an empty internal identifier is rejected');
assert.deepEqual(policy.variants('7900373256192'), ['7900373256192', '07900373256192'],
  'legacy EAN identity and padded aliases remain unchanged');
console.log('PASS: exact 16-digit internal code and unchanged EAN aliases');
