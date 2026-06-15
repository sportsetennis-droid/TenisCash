// =====================================================================
// ROBÔ DO GRUPO DA EMPRESA — Sports & Tennis
// =====================================================================
// 1) PONTO em TEMPO REAL: assim que alguém bate o ponto (entrada, saída
//    pro almoço, retorno, saída do trabalho), avisa o grupo da empresa.
// 2) RELATÓRIO DE VENDAS: 13h, 18h e 21h — por LOJA e por VENDEDOR.
//    Mostra TODOS os vendedores ativos, inclusive os que zeraram.
//
// Envio: Evolution API (instância padrão = teniscash, o nº 9671 da S&T).
// Timezone: America/Fortaleza (UTC-3 fixo, sem horário de verão) — regra do projeto.
//
// GATE DE SEGURANÇA: só envia se WHATSAPP_GROUP_JID (ou os JIDs específicos)
// estiverem configurados. Sem grupo configurado = no-op silencioso (loga e segue).
// Assim o código pode subir em produção sem disparar nada no grupo real até
// o dono configurar o JID e autorizar.
// =====================================================================

const cron = require('node-cron');
const { prisma } = require('../middleware');
const { sendEvolutionRaw, isEvolutionConfigured } = require('../whatsapp');

const TZ_OFFSET_MIN = -180; // America/Fortaleza (UTC-3)

// ---------------------------------------------------------------------
// Grupo(s) de destino
// ---------------------------------------------------------------------
function pontoGroupJid() {
  return (process.env.WHATSAPP_PONTO_GROUP_JID || process.env.WHATSAPP_GROUP_JID || '').trim();
}
function vendasGroupJid() {
  return (process.env.WHATSAPP_VENDAS_GROUP_JID || process.env.WHATSAPP_GROUP_JID || '').trim();
}

// ---------------------------------------------------------------------
// Helpers de tempo (horário de João Pessoa/PB)
// ---------------------------------------------------------------------
function localParts(now = new Date()) {
  const local = new Date(now.getTime() + TZ_OFFSET_MIN * 60000);
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth(),
    d: local.getUTCDate(),
    H: local.getUTCHours(),
    Min: local.getUTCMinutes(),
    dow: local.getUTCDay(),
  };
}
function localDayStartUtc(now = new Date()) {
  const { y, m, d } = localParts(now);
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - TZ_OFFSET_MIN * 60000);
}
function localHourUtc(now, hour) {
  const { y, m, d } = localParts(now);
  return new Date(Date.UTC(y, m, d, hour, 0, 0, 0) - TZ_OFFSET_MIN * 60000);
}
function fmtTime(date) {
  const local = new Date(new Date(date).getTime() + TZ_OFFSET_MIN * 60000);
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
}
function fmtDateBR(now = new Date()) {
  const { y, m, d, dow } = localParts(now);
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  return `${String(d).padStart(2, '0')}/${String(m + 1).padStart(2, '0')}/${y} (${dias[dow]})`;
}
function brl(v) {
  const n = Math.round(Number(v || 0) * 100) / 100;
  const [int, dec] = n.toFixed(2).split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${intFmt},${dec}`;
}

// ---------------------------------------------------------------------
// 1) PONTO EM TEMPO REAL
// ---------------------------------------------------------------------
const TYPE_META = {
  entry: { emoji: '🟢', label: 'ENTRADA', verb: 'iniciou o expediente' },
  break_start: { emoji: '🍴', label: 'ALMOÇO (saída)', verb: 'saiu para o almoço' },
  break_end: { emoji: '🔵', label: 'ALMOÇO (retorno)', verb: 'voltou do almoço' },
  exit: { emoji: '🔴', label: 'SAÍDA', verb: 'encerrou o expediente' },
};

const _storeNameCache = new Map(); // storeId -> name
async function resolveStoreName(storeId, fallback) {
  if (fallback) return fallback;
  if (!storeId) return 'Loja não informada';
  if (_storeNameCache.has(storeId)) return _storeNameCache.get(storeId);
  try {
    const s = await prisma.store.findUnique({ where: { id: storeId }, select: { name: true } });
    const name = s?.name || 'Loja';
    _storeNameCache.set(storeId, name);
    return name;
  } catch (_) {
    return 'Loja';
  }
}

/**
 * Avisa o grupo que alguém bateu o ponto. Fire-and-forget (nunca derruba a rota).
 * @param {{userId?:string, userName?:string, storeId?:string, storeName?:string, type:string, at?:Date}} p
 */
async function notifyClockEvent(p = {}) {
  try {
    const jid = pontoGroupJid();
    if (!jid || !isEvolutionConfigured()) return; // gate: nada configurado = silêncio
    const meta = TYPE_META[p.type];
    if (!meta) return;

    let name = p.userName;
    if (!name && p.userId) {
      const u = await prisma.user.findUnique({ where: { id: p.userId }, select: { name: true } }).catch(() => null);
      name = u?.name || 'Vendedor';
    }
    const loja = await resolveStoreName(p.storeId, p.storeName);
    const hora = fmtTime(p.at || new Date());

    const msg = `${meta.emoji} *${name} ${meta.verb}*\n🏬 ${loja} · 🕒 ${hora}`;
    await sendEvolutionRaw(jid, msg);
  } catch (e) {
    console.error('[equipeReports] notifyClockEvent falhou:', e.message);
  }
}

// ---------------------------------------------------------------------
// 2) RELATÓRIO DE VENDAS (13h / 18h / 21h) — por loja e por vendedor
// ---------------------------------------------------------------------
const SELLER_ROLES = ['seller', 'manager'];
const CHECKPOINT_LABEL = {
  13: 'PARCIAL ATÉ 13h',
  18: 'PARCIAL ATÉ 18h',
  21: 'FECHAMENTO DO DIA (21h)',
};
const PREV_CHECKPOINT = { 13: null, 18: 13, 21: 18 };

/**
 * Monta o texto do relatório de vendas do dia até o checkpoint.
 * @param {number} checkpointHour 13 | 18 | 21
 * @param {Date} now
 * @returns {Promise<string>}
 */
async function buildSalesReport(checkpointHour, now = new Date()) {
  const hour = [13, 18, 21].includes(Number(checkpointHour)) ? Number(checkpointHour) : 13;
  const dayStart = localDayStartUtc(now);

  // Filtro opcional de lojas por código (ex: "LOJA02,LOJA03,LOJA05,LOJA06" pra excluir o Baratão)
  const codeFilter = (process.env.RELATORIO_STORE_CODES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const stores = await prisma.store.findMany({
    where: { active: true, ...(codeFilter.length ? { code: { in: codeFilter } } : {}) },
    select: { id: true, name: true, code: true },
    orderBy: { code: 'asc' },
  });
  const storeIdSet = new Set(stores.map((s) => s.id));

  const sellers = await prisma.user.findMany({
    where: { active: true, role: { in: SELLER_ROLES } },
    select: { id: true, name: true, storeId: true, storeIds: true },
  });

  // Vendas confirmadas do dia até agora
  const sales = await prisma.sale.findMany({
    where: { createdAt: { gte: dayStart, lte: now }, status: 'completed' },
    select: { sellerId: true, storeId: true, totalAmount: true, createdAt: true },
  });

  const nameById = new Map(sellers.map((s) => [s.id, s.name]));
  const missing = [...new Set(sales.map((s) => s.sellerId).filter((id) => id && !nameById.has(id)))];
  if (missing.length) {
    const extra = await prisma.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } });
    extra.forEach((u) => nameById.set(u.id, u.name));
  }

  const blockStart = PREV_CHECKPOINT[hour] ? localHourUtc(now, PREV_CHECKPOINT[hour]) : dayStart;

  // Agrega por loja → vendedor
  function emptyAgg() { return { total: 0, count: 0, blockTotal: 0, blockCount: 0 }; }
  const byStore = new Map(); // storeId -> { agg, sellers: Map(sellerId->agg) }
  for (const st of stores) byStore.set(st.id, { agg: emptyAgg(), sellers: new Map() });
  const orphan = { agg: emptyAgg(), sellers: new Map() }; // vendas sem loja / loja fora do filtro

  // pré-popula vendedores ativos na loja-base (pra mostrar zerado)
  for (const sv of sellers) {
    const home = sv.storeId && storeIdSet.has(sv.storeId) ? sv.storeId : null;
    if (home && !byStore.get(home).sellers.has(sv.id)) byStore.get(home).sellers.set(sv.id, emptyAgg());
  }

  let grand = emptyAgg();
  for (const s of sales) {
    const inBlock = new Date(s.createdAt).getTime() >= blockStart.getTime();
    const bucket = s.storeId && byStore.has(s.storeId) ? byStore.get(s.storeId) : (storeIdSet.size && s.storeId ? orphan : orphan);
    // por loja
    bucket.agg.total += s.totalAmount; bucket.agg.count += 1;
    if (inBlock) { bucket.agg.blockTotal += s.totalAmount; bucket.agg.blockCount += 1; }
    // por vendedor dentro da loja
    if (!bucket.sellers.has(s.sellerId)) bucket.sellers.set(s.sellerId, emptyAgg());
    const sa = bucket.sellers.get(s.sellerId);
    sa.total += s.totalAmount; sa.count += 1;
    if (inBlock) { sa.blockTotal += s.totalAmount; sa.blockCount += 1; }
    // total geral (só conta loja exibida + órfã)
    grand.total += s.totalAmount; grand.count += 1;
    if (inBlock) { grand.blockTotal += s.totalAmount; grand.blockCount += 1; }
  }

  // --- monta texto ---
  const L = [];
  L.push(`📊 *VENDAS — ${CHECKPOINT_LABEL[hour]}*`);
  L.push(`${fmtDateBR(now)} · 🕒 ${fmtTime(now)}`);
  L.push('━━━━━━━━━━━━━━');

  const renderSellers = (sellersMap) => {
    const rows = [...sellersMap.entries()].map(([id, a]) => ({
      name: nameById.get(id) || 'Vendedor',
      ...a,
    }));
    rows.sort((x, y) => (y.total - x.total) || x.name.localeCompare(y.name));
    if (!rows.length) return ['  _(sem vendedor cadastrado)_'];
    return rows.map((r) => `  • ${r.name}: ${brl(r.total)} (${r.count})`);
  };

  for (const st of stores) {
    const b = byStore.get(st.id);
    // Pula loja "fantasma": sem nenhum vendedor cadastrado E sem nenhuma venda (ex: loja placeholder/ecommerce vazia).
    // Loja com vendedores aparece mesmo zerada (regra do dono: zerado também é relatado).
    if (b.agg.count === 0 && b.sellers.size === 0) continue;
    L.push(`🏬 *${st.name}* — ${brl(b.agg.total)} · ${b.agg.count} venda${b.agg.count === 1 ? '' : 's'}`);
    L.push(...renderSellers(b.sellers));
    L.push('');
  }

  if (orphan.agg.count > 0) {
    L.push(`🏷️ *Outras / sem loja* — ${brl(orphan.agg.total)} · ${orphan.agg.count} venda${orphan.agg.count === 1 ? '' : 's'}`);
    L.push(...renderSellers(orphan.sellers));
    L.push('');
  }

  L.push('━━━━━━━━━━━━━━');
  L.push(`💰 *TOTAL: ${brl(grand.total)} · ${grand.count} venda${grand.count === 1 ? '' : 's'}*`);
  if (PREV_CHECKPOINT[hour]) {
    L.push(`📈 No bloco (desde ${PREV_CHECKPOINT[hour]}h): +${brl(grand.blockTotal)} · +${grand.blockCount} venda${grand.blockCount === 1 ? '' : 's'}`);
  }

  return L.join('\n');
}

/**
 * Monta e ENVIA o relatório de vendas pro grupo. Se não houver grupo configurado,
 * não envia (retorna o texto pra inspeção).
 */
async function sendSalesReport(checkpointHour, now = new Date()) {
  let text;
  try {
    text = await buildSalesReport(checkpointHour, now);
  } catch (e) {
    console.error('[equipeReports] buildSalesReport falhou:', e.message);
    return { sent: false, error: e.message };
  }
  const jid = vendasGroupJid();
  if (!jid || !isEvolutionConfigured()) {
    console.log(`[equipeReports] relatório ${checkpointHour}h NÃO enviado (grupo não configurado).`);
    return { sent: false, text, reason: 'no_group' };
  }
  const r = await sendEvolutionRaw(jid, text);
  console.log(`[equipeReports] relatório ${checkpointHour}h → ${r.ok ? 'ENVIADO' : 'FALHOU: ' + r.error}`);
  return { sent: !!r.ok, text, error: r.ok ? undefined : r.error };
}

// ---------------------------------------------------------------------
// 3) PRESENÇA — lê o ponto do dia e diz QUEM ESTÁ na loja e quem não está
// ---------------------------------------------------------------------
const PRESENCE_META = {
  working: { emoji: '🟢', label: 'na loja' },
  onbreak: { emoji: '🍴', label: 'em almoço' },
  left: { emoji: '🔴', label: 'saiu' },
  absent: { emoji: '⚪', label: 'não bateu ponto' },
};

// Deriva o estado atual de uma pessoa a partir das batidas do dia.
function presenceStatus(list) {
  if (!list || !list.length) return { key: 'absent' };
  const sorted = list.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const entry = sorted.find((x) => x.type === 'entry');
  const last = sorted[sorted.length - 1];
  if (last.type === 'exit') return { key: 'left', at: last.timestamp, entryAt: entry && entry.timestamp };
  if (last.type === 'break_start') return { key: 'onbreak', at: last.timestamp, entryAt: entry && entry.timestamp };
  return { key: 'working', entryAt: (entry && entry.timestamp) || last.timestamp };
}

async function buildPresenceReport(now = new Date()) {
  const dayStart = localDayStartUtc(now);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

  const codeFilter = (process.env.RELATORIO_STORE_CODES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const stores = await prisma.store.findMany({
    where: { active: true, ...(codeFilter.length ? { code: { in: codeFilter } } : {}) },
    select: { id: true, name: true, code: true },
    orderBy: { code: 'asc' },
  });

  const sellers = await prisma.user.findMany({
    where: { active: true, role: { in: SELLER_ROLES } },
    select: { id: true, name: true, storeId: true },
  });
  const nameById = new Map(sellers.map((s) => [s.id, s.name]));

  const clocks = await prisma.clockIn.findMany({
    where: { timestamp: { gte: dayStart, lt: dayEnd } },
    select: { userId: true, storeId: true, type: true, timestamp: true },
    orderBy: { timestamp: 'asc' },
  });
  const byUser = new Map();
  for (const c of clocks) {
    if (!byUser.has(c.userId)) byUser.set(c.userId, []);
    byUser.get(c.userId).push(c);
  }
  const extraIds = [...byUser.keys()].filter((id) => !nameById.has(id));
  if (extraIds.length) {
    const ex = await prisma.user.findMany({ where: { id: { in: extraIds } }, select: { id: true, name: true } });
    ex.forEach((u) => nameById.set(u.id, u.name));
  }

  const perStore = new Map();
  for (const s of stores) perStore.set(s.id, []);
  const counts = { working: 0, onbreak: 0, left: 0, absent: 0 };
  const handled = new Set();

  // quem bateu ponto → fica na LOJA da batida de entrada (onde está fisicamente)
  for (const [userId, list] of byUser.entries()) {
    const st = presenceStatus(list);
    const entry = list.find((x) => x.type === 'entry') || list[0];
    const storeId = entry && entry.storeId;
    handled.add(userId);
    counts[st.key] = (counts[st.key] || 0) + 1;
    const row = { name: nameById.get(userId) || 'Vendedor', st };
    if (storeId && perStore.has(storeId)) perStore.get(storeId).push(row);
    else {
      if (!perStore.has('__outras__')) perStore.set('__outras__', []);
      perStore.get('__outras__').push(row);
    }
  }
  // vendedores ativos que NÃO bateram ponto → loja-base, como ausentes
  for (const sv of sellers) {
    if (handled.has(sv.id)) continue;
    counts.absent += 1;
    const row = { name: sv.name, st: { key: 'absent' } };
    if (sv.storeId && perStore.has(sv.storeId)) perStore.get(sv.storeId).push(row);
    else {
      if (!perStore.has('__semloja__')) perStore.set('__semloja__', []);
      perStore.get('__semloja__').push(row);
    }
  }

  const order = { working: 0, onbreak: 1, left: 2, absent: 3 };
  const renderRow = (r) => {
    const m = PRESENCE_META[r.st.key];
    if (r.st.key === 'working') return `  ${m.emoji} ${r.name} — na loja desde ${fmtTime(r.st.entryAt)}`;
    if (r.st.key === 'onbreak') return `  ${m.emoji} ${r.name} — em almoço desde ${fmtTime(r.st.at)}`;
    if (r.st.key === 'left') return `  ${m.emoji} ${r.name} — saiu ${fmtTime(r.st.at)}${r.st.entryAt ? ` (entrou ${fmtTime(r.st.entryAt)})` : ''}`;
    return `  ${m.emoji} ${r.name} — não bateu ponto`;
  };

  const L = [];
  L.push('👥 *PONTO — quem está na loja*');
  L.push(`${fmtDateBR(now)} · 🕒 ${fmtTime(now)}`);
  L.push('━━━━━━━━━━━━━━');

  for (const s of stores) {
    const rows = (perStore.get(s.id) || []).slice()
      .sort((a, b) => (order[a.st.key] - order[b.st.key]) || a.name.localeCompare(b.name));
    if (!rows.length) continue;
    L.push(`🏬 *${s.name}*`);
    rows.forEach((r) => L.push(renderRow(r)));
    L.push('');
  }
  for (const key of ['__outras__', '__semloja__']) {
    const rows = perStore.get(key);
    if (rows && rows.length) {
      rows.sort((a, b) => (order[a.st.key] - order[b.st.key]) || a.name.localeCompare(b.name));
      L.push(`🏷️ *${key === '__outras__' ? 'Bateu em outra loja' : 'Sem loja vinculada'}*`);
      rows.forEach((r) => L.push(renderRow(r)));
      L.push('');
    }
  }

  L.push('━━━━━━━━━━━━━━');
  L.push(`🟢 Na loja: ${counts.working} · 🍴 Almoço: ${counts.onbreak} · 🔴 Saíram: ${counts.left} · ⚪ Não vieram: ${counts.absent}`);
  return L.join('\n');
}

async function sendPresenceReport(now = new Date()) {
  let text;
  try { text = await buildPresenceReport(now); }
  catch (e) { console.error('[equipeReports] buildPresenceReport falhou:', e.message); return { sent: false, error: e.message }; }
  const jid = pontoGroupJid();
  if (!jid || !isEvolutionConfigured()) {
    console.log('[equipeReports] presença NÃO enviada (grupo não configurado).');
    return { sent: false, text, reason: 'no_group' };
  }
  const r = await sendEvolutionRaw(jid, text);
  console.log(`[equipeReports] presença → ${r.ok ? 'ENVIADA' : 'FALHOU: ' + r.error}`);
  return { sent: !!r.ok, text, error: r.ok ? undefined : r.error };
}

// ---------------------------------------------------------------------
// CRON — 13h, 18h, 21h (America/Fortaleza)
// ---------------------------------------------------------------------
function startEquipeReportsCron() {
  if (process.env.DISABLE_EQUIPE_REPORTS === '1') {
    console.log('[equipeReports] desativado (DISABLE_EQUIPE_REPORTS=1)');
    return;
  }
  // cada checkpoint: relatório de vendas + foto da presença (quem está na loja)
  const checkpoint = (h) => async () => {
    try { await sendSalesReport(h); } catch (e) { console.error('[equipeReports] sendSalesReport', h, e.message); }
    try { await sendPresenceReport(); } catch (e) { console.error('[equipeReports] sendPresenceReport', e.message); }
  };
  cron.schedule('0 13 * * *', checkpoint(13), { timezone: 'America/Fortaleza' });
  cron.schedule('0 18 * * *', checkpoint(18), { timezone: 'America/Fortaleza' });
  cron.schedule('0 21 * * *', checkpoint(21), { timezone: 'America/Fortaleza' });
  const jid = vendasGroupJid();
  console.log(
    `[equipeReports] cron iniciado (vendas+presença 13h/18h/21h America/Fortaleza)` +
    (jid ? '' : ' — ⚠️ WHATSAPP_GROUP_JID vazio: nada será enviado até configurar o grupo')
  );
}

module.exports = {
  startEquipeReportsCron,
  sendSalesReport,
  buildSalesReport,
  notifyClockEvent,
  buildPresenceReport,
  sendPresenceReport,
  pontoGroupJid,
  vendasGroupJid,
};
