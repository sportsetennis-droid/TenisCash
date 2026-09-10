const assert = require('node:assert/strict');
const { roleAfterStoreAssignment } = require('../src/services/sellerRole');
const { restoreOwnerAccess } = require('../src/services/restoreOwnerAccess20260910');

async function main() {
  for (const role of ['superadmin', 'admin', 'manager']) assert.equal(roleAfterStoreAssignment(role), role);
  for (const role of ['user', 'seller']) assert.equal(roleAfterStoreAssignment(role), 'seller');
  const user = { id: 'owner', role: 'seller', pin: 'unchanged', storeId: 'store', storeIds: ['store'] };
  let marker = null, audits = 0, writes = 0, candidates = [user], evidence = { id: 'audit-self-assignment' };
  const tx = {
    user: { findMany: async () => candidates, update: async ({ data }) => {
      assert.deepEqual(data, { role: 'superadmin' }); writes++; Object.assign(user, data);
    } },
    config: { findUnique: async () => marker, create: async ({ data }) => { marker = data; } },
    adminAction: { findFirst: async ({ where }) => {
      assert.equal(where.adminId, user.id); assert.equal(where.targetUserId, user.id);
      assert.equal(where.action, 'seller_assign_store'); return evidence;
    }, create: async () => { audits++; } },
  };
  const prisma = { $transaction: async fn => fn(tx) };
  await restoreOwnerAccess(prisma);
  assert.equal(user.role, 'superadmin'); assert.equal(writes, 1); assert.equal(audits, 1);
  assert.equal(user.pin, 'unchanged'); assert.deepEqual(user.storeIds, ['store']);
  await restoreOwnerAccess(prisma); assert.equal(writes, 1);
  marker = null; evidence = null;
  await assert.rejects(restoreOwnerAccess(prisma), /histórico/);
  candidates = [user, { id: 'other' }];
  await assert.rejects(restoreOwnerAccess(prisma), /ambígua/);
  assert.equal(writes, 1);
  console.log('Preservação de acesso, recuperação auditada e execução única validadas.');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
