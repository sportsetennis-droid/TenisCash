// Vincular uma loja não deve remover as permissões administrativas existentes.
function roleAfterStoreAssignment(role) {
  return ['superadmin', 'admin', 'manager'].includes(role) ? role : 'seller';
}

module.exports = { roleAfterStoreAssignment };
