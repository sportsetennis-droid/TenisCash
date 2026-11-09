'use strict';

// These are server records, not a claim to see unuploaded photographs on a phone.
// A bipe and its capture are one event; jobs are separate processing attempts.
function build(report, queue = { available: false, items: [] }, now = new Date()) {
  const checks = new Map((report.checks || []).map(c => [c.bipeId, c]));
  const events = new Map((report.bipes || []).map(b => [b.id, { bipe: b, captures: [] }]));
  for (const c of report.captures || []) {
    const key = c.bipeId && events.has(c.bipeId) ? c.bipeId : 'capture:' + c.id;
    if (!events.has(key)) events.set(key, { bipe: null, captures: [] });
    events.get(key).captures.push(c);
  }
  const counts = { processing: 0, review: 0, applied: 0, excluded: 0 };
  const rows = [...events].map(([id, event]) => {
    const b = event.bipe, c = checks.get(b?.id);
    const captures = event.captures;
    const captureIds = new Set(captures.map(p => p.id));
    const jobs = (queue.items || []).filter(j => (b && j.bipeId === b.id) || captureIds.has(j.captureId));
    const terminalJob=[...jobs].filter(j=>j.reason&&['completed','failed','cancelled'].includes(j.state)).sort((a,b)=>new Date(b.createdAt||b.completedAt||0)-new Date(a.createdAt||a.completedAt||0))[0];
    const movements = (report.movements || []).filter(m => m.metadata?.bipeId === b?.id && !!b);
    const excluded = !!b?.excludedAt || !!c?.reversedAt || (!b && captures.every(p => p.excludedAt || p.status === 'descartado'));
    const applied = !!b?.applied && !!c?.appliedAt && !c.reversedAt;
    const active = jobs.some(j => ['active', 'running'].includes(j.state));
    const waiting = jobs.some(j => ['created', 'retry', 'queued', 'pending'].includes(j.state));
    const failed = jobs.some(j => ['failed', 'cancelled'].includes(j.state));
    const transient = !c?.reason || ['ocr_busy', 'ocr_timeout', 'ocr_unavailable', 'ocr_memory_limit',
      'photo_decode_busy', 'photo_decode_timeout', 'photo_decode_unavailable', 'photo_decode_memory_limit',
      'aguardando_conferencia_da_etiqueta'].includes(c.reason);
    const state = excluded ? 'excluded' : applied ? 'applied' : active || (waiting && transient) ? 'processing' : 'review';
    counts[state]++;
    const reason = state === 'applied' ? null : state === 'excluded' ? (b?.exclusionReason || c?.reason || 'Leitura excluída ou estornada.')
      : c?.reasonText || (terminalJob?.reason?require('./stockReplacement').reasonText(terminalJob.reason):null) || (failed ? 'Processamento interrompido; aguardando revisão ou nova tentativa.'
        : state === 'processing' ? 'Arquivo no servidor; conferência em andamento.' : 'Arquivo/identificação aguardando conferência.');
    return { id, bipeId: b?.id || null, captureIds: [...captureIds], barcode: b?.barcode || captures.find(p => p.barcode)?.barcode || null,
      state, reason, capturedAt: b?.bipedAt || captures[0]?.createdAt || null, checkedAt: c?.checkedAt || null,
      appliedAt: applied ? c.appliedAt : null, movementIds: movements.map(m => m.id),
      attempts: jobs.reduce((n, j) => n + (Number(j.attempts) || 0), 0),
      processingJobs: jobs.map(j => ({ id: j.jobId, state: j.state, attempts: j.attempts, nextAttemptAt: j.nextAttemptAt || null })) };
  });
  const pendingTimes = rows.filter(r => ['review', 'processing'].includes(r.state))
    .map(r => new Date(r.capturedAt).getTime()).filter(Number.isFinite);
  return { generatedAt: now.toISOString(), scope: 'server', totalRecords: rows.length, counts,
    oldestPendingSeconds: pendingTimes.length ? Math.max(0, Math.floor((now.getTime() - Math.min(...pendingTimes)) / 1000)) : null,
    queue: { available: !!queue.available, states: queue.states || {}, totalJobs: queue.totalJobs || 0,
      oldestPendingSeconds: queue.oldestPendingSeconds ?? null, worker: queue.worker || null }, rows };
}
module.exports = { build };
