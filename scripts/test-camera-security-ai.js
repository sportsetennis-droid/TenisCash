const assert = require('node:assert/strict');
const cameraSecurityAI = require('../src/services/cameraSecurityAI');

const parsed = cameraSecurityAI.parseModelJson('texto antes\n{"risk":"HIGH","confidence":0.91,"category":"AGGRESSION","summary":"Conflito visível","observations":["movimento brusco"]}\ndepois');
assert.equal(parsed.risk, 'HIGH');

const conservative = cameraSecurityAI.normalizeDecision({
  risk: 'UNKNOWN',
  confidence: 9,
  category: 'FACE_MATCH',
  summary: '  situação   ambígua  ',
});
assert.equal(conservative.risk, 'NONE');
assert.equal(conservative.confidence, 1);
assert.equal(conservative.category, 'OTHER');
assert.equal(conservative.summary, 'situação ambígua');
assert.equal(conservative.requiresHumanReview, true);

assert.equal(cameraSecurityAI.shouldStoreDecision({ risk: 'HIGH', confidence: 0.72 }), true);
assert.equal(cameraSecurityAI.shouldStoreDecision({ risk: 'HIGH', confidence: 0.71 }), false);
assert.equal(cameraSecurityAI.shouldStoreDecision({ risk: 'REVIEW', confidence: 0.82 }), true);
assert.equal(cameraSecurityAI.shouldStoreDecision({ risk: 'NONE', confidence: 1 }), false);

assert.equal(cameraSecurityAI.safeResourceName('abc123_video1_seg9.mp4?session=ok'), 'abc123_video1_seg9.mp4');
assert.equal(cameraSecurityAI.safeResourceName('../../secret.txt'), null);

assert.deepEqual(cameraSecurityAI.parseTargets('LOJA05:1-3,LOJA06:2'), [
  { store: 'LOJA05', camera: 'loja05_camera1' },
  { store: 'LOJA05', camera: 'loja05_camera2' },
  { store: 'LOJA05', camera: 'loja05_camera3' },
  { store: 'LOJA06', camera: 'loja06_camera2' },
]);

console.log('camera-security-ai: ok');
