'use strict';

const TIME_ZONE = 'America/Fortaleza';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function localDay(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(value));
}
function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(day + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
const transitions = {
  absent: { in: 'working' }, working: { break_in: 'break', out: 'finished' },
  break: { break_out: 'working' }, finished: { in: 'working' },
};
function attendance(entries, day, now = new Date()) {
  let state = 'absent', since = null, milliseconds = 0, previous = -Infinity;
  const issues = [];
  for (const entry of [...entries].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const at = new Date(entry.at).getTime();
    const next = transitions[state]?.[entry.kind];
    if (!Number.isFinite(at) || at < previous || localDay(at) !== day || !next) {
      issues.push('Batidas fora de sequência. Conferir os horários registrados.');
      continue;
    }
    if (state === 'working') milliseconds += at - since;
    state = next;
    since = state === 'working' ? at : null;
    previous = at;
  }
  const open = state === 'working' || state === 'break';
  if (open && day < localDay(now)) issues.push('Falta registrar o encerramento do dia.');
  const ongoing = state === 'working' && day === localDay(now) && !issues.length
    ? Math.max(0, new Date(now).getTime() - since) : 0;
  return {
    state, workedMinutes: issues.length ? null : Math.floor(milliseconds / 60000),
    ongoingMinutes: issues.length ? null : Math.floor(ongoing / 60000),
    complete: state === 'finished' && !issues.length, issues: [...new Set(issues)],
    allowedKinds: issues.length ? [] : Object.keys(transitions[state] || {}),
  };
}
function canRecord(employee) {
  return !!employee && (['admin', 'gerente'].includes(employee.role) || employee.canRecordProduction === true);
}
function validateEntry(body, today = localDay()) {
  const day = body.day;
  const product = typeof body.product === 'string' ? body.product.trim() : '';
  const activity = typeof body.activity === 'string' ? body.activity.trim() : '';
  const quantity = typeof body.quantity === 'number' ? body.quantity
    : typeof body.quantity === 'string' && /^\d+$/.test(body.quantity) ? Number(body.quantity) : NaN;
  if (!validDay(day) || day > today) throw new Error('Informe uma data válida até hoje.');
  if (typeof body.employeeId !== 'string' || !body.employeeId.trim()) throw new Error('Selecione quem produziu.');
  if (!product || product.length > 160) throw new Error('Informe o produto ou pedido (até 160 caracteres).');
  if (!activity || activity.length > 100) throw new Error('Informe a atividade (até 100 caracteres).');
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('A quantidade deve ser um número inteiro maior que zero.');
  if (!UUID.test(body.requestId || '')) throw new Error('Identificador do lançamento inválido. Atualize a tela.');
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  if (notes.length > 1000) throw new Error('A observação deve ter até 1000 caracteres.');
  return { day, employeeId: body.employeeId, product, activity, quantity, notes: notes || null, requestId: body.requestId };
}
function sameEntry(a, b) {
  return ['day', 'employeeId', 'product', 'activity', 'quantity', 'notes', 'recorderId'].every(k => (a[k] ?? null) === (b[k] ?? null));
}
function groupProduction(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (e.voidedAt) continue;
    const key = JSON.stringify([e.product.toLocaleLowerCase('pt-BR'), e.activity.toLocaleLowerCase('pt-BR')]);
    if (!groups.has(key)) groups.set(key, { product: e.product, activity: e.activity, quantity: 0 });
    groups.get(key).quantity += e.quantity;
  }
  return [...groups.values()];
}
module.exports = { TIME_ZONE, UUID, localDay, validDay, attendance, canRecord, validateEntry, sameEntry, groupProduction };
