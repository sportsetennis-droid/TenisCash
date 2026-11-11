'use strict';

// Auditoria do financeiro: quem, quando, o quê, antes e depois. Sempre chamada com o
// `tx` da MESMA transação da escrita — se a auditoria falhar, a escrita é desfeita.

function plain(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function buildAuditData({ entity, entityId, action, before, after, reason, req }) {
  if (!entity || !entityId || !action) throw new Error('auditoria exige entity, entityId e action');
  return {
    entity: String(entity),
    entityId: String(entityId),
    action: String(action),
    actorId: (req && req.userId) || null,
    actorRole: (req && req.userRole) || null,
    before: plain(before),
    after: plain(after),
    reason: reason ? String(reason).slice(0, 1000) : null,
    requestId: (req && (req.get?.('x-request-id') || req.headers?.['x-request-id'])) || null,
  };
}

async function audit(tx, input) {
  return tx.finAuditLog.create({ data: buildAuditData(input) });
}

module.exports = { audit, buildAuditData };
