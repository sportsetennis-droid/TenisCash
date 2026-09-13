// O registro de recuperação identifica o titular por ID, após validação e auditoria.
// Não deduzir o dono pelo papel superadmin: contas de automação também o utilizam.
const OWNER_RECORD_KEY = 'repair-owner-access-20260910';

async function getRankingOwner(prisma) {
  const record = await prisma.config.findUnique({ where: { key: OWNER_RECORD_KEY } });
  if (!record) return null;
  let identity;
  try { identity = JSON.parse(record.value); } catch { return null; }
  if (typeof identity?.userId !== 'string' || !identity.userId.trim()
    || typeof identity?.evidenceId !== 'string' || !identity.evidenceId.trim()) return null;

  const owner = await prisma.user.findUnique({
    where: { id: identity.userId },
    select: { id: true, role: true, active: true,
      store: { select: { id: true, name: true, code: true } } },
  });
  return owner?.active && owner.role === 'superadmin' ? owner : null;
}

module.exports = { OWNER_RECORD_KEY, getRankingOwner };
