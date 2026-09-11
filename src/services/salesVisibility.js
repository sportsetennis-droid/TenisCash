// Read current assignments for each request; never trust client filters or stale JWT roles.
async function salesVisibility(prisma, userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true, storeId: true, storeIds: true } });
  if (!user || !user.active) return null;
  if (['admin', 'superadmin', 'manager'].includes(user.role)) return { role: user.role, storeIds: null };
  if (!['seller', 'store'].includes(user.role)) return null;
  return { role: user.role, storeIds: [...new Set([user.storeId, ...(user.role === 'seller' ? user.storeIds || [] : [])].filter(Boolean))] };
}
module.exports = { salesVisibility };
