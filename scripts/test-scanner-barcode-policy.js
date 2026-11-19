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

// Código alfanumérico de fornecedor (Atama, NF-e SEM GTIN): aceito como lido, sem alias.
assert.equal(policy.isScanCode('KIM10U0001011'), true, 'código Code 128 da Atama é aceito');
assert.equal(policy.isSupplierCode('KIM10U0001011'), true);
assert.deepEqual(policy.variants('KIM10U0001011'), ['KIM10U0001011']);
assert.equal(policy.identity('KIM10U0001011'), 'KIM10U0001011');
for (const atama of ['UKMJJACLAAZ02', 'IKMJJAULSBC03', 'FX0001001003', 'KI0014001003', 'FX000101008']) assert.equal(policy.isScanCode(atama), true, 'código Atama (Classic/Ultra) aceito: ' + atama);
for (const ref of ['IG9319', '1011B958', 'DV1234-100', 'JH7925', 'K100.05.37', 'SEM GTIN', 'kim10u0001011', 'KIM10U', 'ABC12345', '687979 018PEQ', 'F11L01791', 'ABCDEFGHIJ1', '0164-UKMJJACLAAZ02'])
  assert.equal(policy.isScanCode(ref), false, 'referência/sujeira não vira código: ' + ref);
console.log('PASS: código alfanumérico do fornecedor aceito; referência de modelo continua recusada');
