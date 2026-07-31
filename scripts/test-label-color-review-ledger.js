const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const labels = require('../src/routes/labels');
const ledger = require('../src/data/label-color-review-ledger.json');

assert.equal(ledger.version, 1);
assert.equal(ledger.method, 'strict-evidence-product-by-product-v1');
assert.ok(ledger.reviewedAt);

const entries = Object.entries(ledger.products || {});
assert.equal(entries.length, 2662, 'A revisão publicada deve cobrir os 2.662 produtos do escopo auditado.');

for (const [productId, review] of entries) {
  assert.equal(review.fingerprintInput[0], productId);
  assert.equal(review.fingerprintInput[1], review.sku);
  assert.equal(review.fingerprintInput[2], review.brand);
  assert.equal(review.fingerprintInput[3], review.name);
  assert.equal(
    crypto.createHash('sha256').update(JSON.stringify(review.fingerprintInput)).digest('hex'),
    review.fingerprint,
    `Fingerprint inválida para ${productId}`,
  );
  if (review.status === 'confirmed') {
    assert.ok(review.color, `Produto confirmado sem cor: ${productId}`);
    assert.equal(review.issue, null);
  } else {
    assert.equal(review.status, 'doubt');
    assert.equal(review.color, '');
    assert.ok(review.issue?.type, `Dúvida sem tipo: ${productId}`);
    assert.ok(review.issue?.short?.startsWith('DÚVIDA:'), `Dúvida sem aviso curto: ${productId}`);
    assert.ok(review.issue?.detail?.startsWith('DÚVIDA:'), `Dúvida sem detalhe: ${productId}`);
  }
  assert.ok(review.reason, `Produto sem justificativa de revisão: ${productId}`);
}

assert.equal(
  ledger.products['6531a1ac-3331-4525-9411-35d299808a74'].color,
  'BLACK/PEACOAT/PEACH',
  'Brooks deve usar a combinação integral do nome.',
);
assert.equal(
  ledger.products['ac810705-e942-4224-87f5-7fca5b77daab'].issue.type,
  'partial-color',
  'Converse incompleto deve permanecer como dúvida explícita.',
);
assert.equal(
  ledger.products['127fef37-61d1-4aa0-a969-5c1c14048b66'].color,
  'PRETO/BRANCO/BRANCO',
  'Combinação Mormaii completa deve ser normalizada sem perder componentes.',
);
assert.equal(
  ledger.products['93669142-0fd0-46a0-922a-2f5f2710a0dc']?.status,
  undefined,
  'O teste não pode depender de um produto inexistente como se estivesse revisado.',
);

const brooks = ledger.products['6531a1ac-3331-4525-9411-35d299808a74'];
const brooksProduct = {
  id: brooks.fingerprintInput[0],
  sku: brooks.fingerprintInput[1],
  brand: brooks.fingerprintInput[2],
  name: brooks.fingerprintInput[3],
};
const brooksContext = { color: brooks.fingerprintInput[4] };
assert.equal(labels.labelProductColor(brooksProduct, brooksContext), 'BLACK/PEACOAT/PEACH');
assert.equal(
  labels.labelProductColorIssue({ ...brooksProduct, name: `${brooksProduct.name} ALTERADO` }, brooksContext).type,
  'review-stale',
);
assert.equal(
  labels.labelProductColorIssue({ id: 'produto-novo', sku: 'novo', brand: 'TESTE', name: 'PRODUTO AZUL' }, {}).type,
  'not-reviewed',
);

console.log('Livro de revisão individual das cores validado.');
