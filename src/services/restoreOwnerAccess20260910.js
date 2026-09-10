const REPAIR_KEY = 'repair-owner-access-20260910';

// Recuperação única solicitada pelo titular após a atribuição de loja remover
// seu papel de superadmin. Sem endpoint público ou alteração de credenciais.
async function restoreOwnerAccess(prisma) {
  return prisma.$transaction(async tx => {
    if (await tx.config.findUnique({ where: { key: REPAIR_KEY } })) return;
    const candidates = await tx.user.findMany({
      where: { name: { equals: 'Douglas bernardo azevedo', mode: 'insensitive' }, active: true },
      select: { id: true, role: true },
    });
    if (candidates.length !== 1) throw new Error('Recuperação do titular: identificação ambígua ou ausente');
    const user = candidates[0];
    if (!['seller', 'superadmin'].includes(user.role)) throw new Error('Recuperação do titular: papel inesperado');
    const evidence = await tx.adminAction.findFirst({
      where: {
        adminId: user.id, targetUserId: user.id, action: 'seller_assign_store',
        createdAt: { lt: new Date('2026-09-11T00:00:00Z') },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!evidence) throw new Error('Recuperação do titular: histórico de atribuição própria não encontrado');
    if (user.role === 'seller') {
      await tx.user.update({ where: { id: user.id }, data: { role: 'superadmin' } });
      await tx.adminAction.create({ data: {
        adminId: user.id, targetUserId: user.id, action: 'owner_access_restored',
        description: 'Acesso superadmin restaurado a pedido do titular após atribuição própria como vendedor.',
        metadata: JSON.stringify({ previousRole: user.role, role: 'superadmin', evidenceId: evidence.id, repair: REPAIR_KEY }),
      } });
    }
    await tx.config.create({ data: { id: REPAIR_KEY, key: REPAIR_KEY, value: JSON.stringify({ userId: user.id, evidenceId: evidence.id }) } });
    console.log('Recuperação do titular concluída: superadmin; credenciais e lojas preservadas.');
  });
}

module.exports = { restoreOwnerAccess };
