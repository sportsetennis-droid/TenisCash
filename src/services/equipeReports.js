// =====================================================================
// ROBÔ DO GRUPO DA EMPRESA — Sports & Tennis
// =====================================================================
// 1) PONTO em TEMPO REAL: assim que alguém bate o ponto (entrada, saída
//    pro almoço, retorno, saída do trabalho), avisa o grupo da empresa.
// 2) RELATÓRIO DE VENDAS: 13h, 18h e 21h — por LOJA e por VENDEDOR.
//    Mostra TODOS os vendedores ativos, inclusive os que zeraram.
// 3) RELATÓRIO DE TAREFAS: 1h após a primeira escala abrir e depois a cada 3h.
//    Mostra o percentual de tarefas aprovadas, pendentes e em fiscalização.
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
const {
  classifyProductionDay,
  checkpointToMinutes,
  formatMinutes,
  buildTaskReportSchedule,
  splitWhatsAppText,
} = require('./taskComplianceReport');
const production = require('./sellerProduction');

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
function tarefasGroupJid() {
  return (process.env.WHATSAPP_TAREFAS_GROUP_JID || process.env.WHATSAPP_GROUP_JID || '').trim();
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
function personalStatusForItem(item) {
  const status = String(item?.status || 'PENDING').toUpperCase();
  if (status === 'APPROVED') return { kind: 'done', label: 'aprovada pela fiscalizacao' };
  if (status === 'EXCUSED') return { kind: 'excused', label: 'dispensada pela empresa' };
  if (status === 'SUBMITTED') return { kind: 'not_done', label: 'enviada, aguardando fiscalizacao' };
  if (status === 'REJECTED') return { kind: 'not_done', label: 'devolvida para correcao' };
  return { kind: 'not_done', label: 'sem registro aprovado' };
}

function formatPersonalPercent(value) {
  if (Number.isInteger(value)) return `${value}%`;
  return `${value.toFixed(1).replace('.', ',')}%`;
}

/** Texto do resumo pessoal emitido no encerramento do ponto. */
function buildPersonalTaskReportText({ name = 'Vendedor', now = new Date(), items = [], dayStatus = null } = {}) {
  const rows = Array.isArray(items) ? [...items].sort((a, b) => Number(a.position || 0) - Number(b.position || 0)) : [];
  const lines = [
    `📋 *SEU RESUMO DE TAREFAS — ${fmtDateBR(now)}*`,
    `Olá, ${name}. Este é o registro pessoal do seu checklist no encerramento do ponto.`,
  ];
  if (!rows.length) {
    lines.push('⚠️ Checklist diário não encontrado ou sem itens registrados.');
    lines.push('Percentual: não calculável, porque não existe base de tarefas registrada para este dia.');
    lines.push('Se isso estiver incorreto, fale conosco pelo canal de dúvidas.');
    return lines.join('\n');
  }
  const classified = rows.map((item) => ({ item, ...personalStatusForItem(item) }));
  const done = classified.filter((row) => row.kind === 'done');
  const excused = classified.filter((row) => row.kind === 'excused');
  const notDone = classified.filter((row) => row.kind === 'not_done');
  const recognized = done.length + excused.length;
  const pct = (recognized / rows.length) * 100;
  lines.push(`✅ Realizadas e aprovadas: ${done.length}/${rows.length}`);
  lines.push(`🟦 Dispensadas pela empresa: ${excused.length}/${rows.length}`);
  lines.push(`📈 Cumprimento reconhecido: ${formatPersonalPercent(pct)}`);
  if (dayStatus) lines.push(`Status do checklist: ${String(dayStatus).toUpperCase()}`);
  if (notDone.length) {
    lines.push(`❌ Não consideradas realizadas: ${notDone.length}`);
    notDone.forEach(({ item, label }) => {
      const title = String(item.title || item.ruleKey || 'Tarefa sem título').replace(/\s+/g, ' ').trim();
      const detail = item.reviewNote ? ` — ${String(item.reviewNote).replace(/\s+/g, ' ').trim()}` : '';
      lines.push(`• ${title}: ${label}${detail}`);
    });
  } else {
    lines.push('✅ Nenhuma tarefa ficou sem aprovação ou registro de dispensa.');
  }
  lines.push('Em caso de dúvida sobre qualquer item, estamos disponíveis para ajudar.');
  return lines.join('\n');
}

async function findPersonalMessageSender(excludeUserId) {
  return prisma.user.findFirst({
    where: {
      active: true,
      role: { in: ['superadmin', 'admin', 'manager'] },
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
    orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
}

async function createPersonalAnnouncement({ userId, title, content, at }) {
  if (!userId || !title || !content) return { sent: false, reason: 'missing_fields' };
  const timestamp = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  const dayStart = localDayStartUtc(timestamp);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const existing = await prisma.message.findFirst({
    where: { toId: userId, title, createdAt: { gte: dayStart, lt: dayEnd } },
    select: { id: true },
  });
  if (existing) return { sent: false, duplicate: true, messageId: existing.id };
  const sender = await findPersonalMessageSender(userId);
  if (!sender) {
    console.warn(`[equipeReports] mensagem pessoal nao enviada para ${userId}: nenhum administrador ativo.`);
    return { sent: false, reason: 'no_sender' };
  }
  const message = await prisma.message.create({
    data: {
      fromId: sender.id,
      toId: userId,
      type: 'announcement',
      title,
      content,
      priority: 'normal',
      status: 'sent',
    },
    select: { id: true },
  });
  return { sent: true, messageId: message.id };
}

async function notifyPersonalClockMessage(p = {}) {
  if (!p.userId || !['entry', 'exit'].includes(p.type)) return { sent: false, reason: 'event_not_supported' };
  const at = p.at instanceof Date ? p.at : new Date(p.at || Date.now());
  const user = await prisma.user.findUnique({ where: { id: p.userId }, select: { id: true, name: true } });
  if (!user) return { sent: false, reason: 'user_not_found' };
  const name = p.userName || user.name || 'Vendedor';
  if (p.type === 'entry') {
    const content = [
      `🌤️ Bom dia, ${name}!`,
      'Seu ponto de entrada foi registrado.',
      'As tarefas e obrigações do dia devem ser realizadas e registradas no TenisCash com as evidências solicitadas. Esse acompanhamento é importante para manter a transparência e o reconhecimento do seu trabalho.',
      'Tudo que for enviado, aprovado, rejeitado ou ficar pendente será registrado. Atividade obrigatória sem registro aprovado não é considerada executada.',
      'Se tiver qualquer dúvida, estamos disponíveis para ajudar pelo canal da empresa.',
      'Bom trabalho!',
    ].join('\n');
    return createPersonalAnnouncement({ userId: user.id, title: 'Bom dia — obrigações do dia', content, at });
  }
  const workDate = localDayStartUtc(at);
  const day = await prisma.sellerProductionDay.findUnique({
    where: { sellerId_workDate: { sellerId: user.id, workDate } },
    select: { status: true, items: { orderBy: { position: 'asc' }, select: { position: true, title: true, ruleKey: true, status: true, reviewNote: true } } },
  });
  // Se o cron ainda nao tiver criado o checklist, a politica vigente fornece
  // a base das tarefas. Assim o encerramento registra 0% sem inventar execucao.
  const items = day?.items?.length
    ? day.items
    : production.RULES.map((rule) => ({
      position: rule.position,
      title: rule.title,
      ruleKey: rule.key,
      status: 'PENDING',
    }));
  const content = buildPersonalTaskReportText({ name, now: at, items, dayStatus: day?.status || 'CHECKLIST_NAO_CRIADO' });
  return createPersonalAnnouncement({ userId: user.id, title: `Resumo pessoal de tarefas — ${fmtDateBR(at)}`, content, at });
}

function liveTaskStatus(item) {
  const status = String(item?.status || 'PENDING').toUpperCase();
  if (status === 'APPROVED') return { emoji: '✅', label: 'REALIZADA/APROVADA', kind: 'approved' };
  if (status === 'EXCUSED') return { emoji: '🟦', label: 'DISPENSADA PELA EMPRESA', kind: 'excused' };
  if (status === 'SUBMITTED') return { emoji: '🔎', label: 'ENVIADA — AGUARDANDO FISCALIZAÇÃO', kind: 'pending_review' };
  if (status === 'REJECTED') return { emoji: '❌', label: 'NÃO REALIZADA — DEVOLVIDA PARA CORREÇÃO', kind: 'not_done' };
  return { emoji: '❌', label: 'NÃO REALIZADA — SEM REGISTRO APROVADO', kind: 'not_done' };
}

function buildLiveTaskUpdateText({ sellerName = 'Vendedor', items = [], dayStatus = null, event = 'atualização', now = new Date() } = {}) {
  const rows = Array.isArray(items) ? [...items].sort((a, b) => Number(a.position || 0) - Number(b.position || 0)) : [];
  const states = rows.map((item) => ({ item, ...liveTaskStatus(item) }));
  const approved = states.filter((row) => row.kind === 'approved').length;
  const excused = states.filter((row) => row.kind === 'excused').length;
  const pendingReview = states.filter((row) => row.kind === 'pending_review').length;
  const notDone = states.filter((row) => row.kind === 'not_done').length;
  const percentage = rows.length ? Math.round((approved / rows.length) * 100) : 0;
  const lines = [
    `⚡ *ATUALIZAÇÃO REAL DE TAREFAS — ${fmtDateBR(now)} · ${fmtTime(now)}*`,
    '🔒 Tudo que é enviado, aprovado, rejeitado ou fica pendente está sendo registrado no histórico do TenisCash.',
    '⚠️ Atividade obrigatória sem registro aprovado NÃO é considerada executada.',
    `👤 *${sellerName}* · evento: ${event}`,
    `📊 ${percentage}% aprovadas (${approved}/${rows.length}) · dispensadas: ${excused} · aguardando fiscalização: ${pendingReview} · não realizadas: ${notDone}`,
  ];
  if (!rows.length) {
    lines.push('⚠️ Nenhuma tarefa foi encontrada para este vendedor e este dia.');
    return lines.join('\n');
  }
  lines.push('', '*Tarefas do vendedor:*');
  states.forEach(({ item, emoji, label }) => {
    const title = String(item.title || item.ruleKey || 'Tarefa sem título').replace(/\s+/g, ' ').trim();
    const note = item.reviewNote ? ` — ${String(item.reviewNote).replace(/\s+/g, ' ').trim()}` : '';
    lines.push(`${emoji} ${title} — ${label}${note}`);
  });
  return lines.join('\n');
}

async function notifyTaskStatusChange({ sellerId, dayId, event = 'atualização', at = new Date() } = {}) {
  if (!sellerId && !dayId) return { sent: false, reason: 'missing_target' };
  const timestamp = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date();
  let day;
  if (dayId) {
    day = await prisma.sellerProductionDay.findUnique({
      where: { id: dayId },
      select: {
        status: true,
        seller: { select: { id: true, name: true } },
        items: { orderBy: { position: 'asc' }, select: { position: true, title: true, ruleKey: true, status: true, reviewNote: true } },
      },
    });
  } else {
    const workDate = localDayStartUtc(timestamp);
    day = await prisma.sellerProductionDay.findUnique({
      where: { sellerId_workDate: { sellerId, workDate } },
      select: {
        status: true,
        seller: { select: { id: true, name: true } },
        items: { orderBy: { position: 'asc' }, select: { position: true, title: true, ruleKey: true, status: true, reviewNote: true } },
      },
    });
  }
  if (!day) return { sent: false, reason: 'day_not_found' };
  const text = buildLiveTaskUpdateText({ sellerName: day.seller?.name, items: day.items, dayStatus: day.status, event, now: timestamp });
  const jid = tarefasGroupJid();
  if (!jid || !isEvolutionConfigured()) return { sent: false, text, reason: 'no_group' };
  const chunks = splitWhatsAppText(text);
  const results = [];
  for (const chunk of chunks) {
    const result = await sendEvolutionRaw(jid, chunk);
    results.push(result);
    if (!result.ok) break;
  }
  const sent = results.length === chunks.length && results.every((result) => result.ok);
  return { sent, text, chunks: chunks.length, error: results.find((result) => !result.ok)?.error };
}

async function notifyClockEvent(p = {}) {
  try {
    await notifyPersonalClockMessage(p).catch((e) => {
      console.error('[equipeReports] mensagem pessoal do ponto falhou:', e.message);
    });

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
// 4) CUMPRIMENTO DAS TAREFAS — aprovado, em fiscalização e não cumprido
// ---------------------------------------------------------------------
function taskLineList(lines, label, emoji, items) {
  if (!items.length) return;
  lines.push(`  ${emoji} *${label} (${items.length})*`);
  items.forEach((item) => lines.push(`    • ${item.title}`));
}

/**
 * Monta o relatório das atividades de produção do dia.
 * O sistema não transforma envio em cumprimento: somente APPROVED é "cumpriu".
 * O horário do checkpoint só define quando o relatório é emitido; não decide
 * sozinho se a tarefa foi cumprida. Cumprimento exige registro e aprovação.
 */
function taskCheckpoint(checkpointValue, now = new Date()) {
  const parsed = checkpointToMinutes(checkpointValue);
  const local = localParts(now);
  const minutes = parsed === null ? (local.H * 60) + local.Min : parsed;
  return { minutes, label: formatMinutes(minutes) };
}

/* async function buildLegacyTaskComplianceReport(checkpointValue, now = new Date()) {
  const checkpoint = taskCheckpoint(checkpointValue, now);
  const dayStart = localDayStartUtc(now);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  const codeFilter = (process.env.RELATORIO_STORE_CODES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);

  const [productionDays, clockIns] = await Promise.all([
    prisma.sellerProductionDay.findMany({
      where: {
        workDate: { gte: dayStart, lt: dayEnd },
        ...(codeFilter.length ? { store: { code: { in: codeFilter } } } : {}),
      },
      select: {
        id: true,
        sellerId: true,
        status: true,
        scheduleStart: true,
        scheduleEnd: true,
        seller: {
          select: {
            id: true,
            name: true,
            active: true,
          },
        },
        store: { select: { id: true, name: true, code: true } },
        items: {
          select: { ruleKey: true, phase: true, position: true, title: true, status: true },
          orderBy: { position: 'asc' },
        },
      },
    }),
    prisma.clockIn.findMany({
      where: {
        type: { in: ['entry', 'exit'] },
        timestamp: { gte: dayStart, lt: dayEnd },
        user: { role: 'seller', active: true },
        ...(codeFilter.length ? { store: { code: { in: codeFilter } } } : {}),
      },
      select: {
        userId: true,
        type: true,
        timestamp: true,
        user: { select: { id: true, name: true, active: true } },
        store: { select: { id: true, name: true, code: true } },
      },
      orderBy: { timestamp: 'asc' },
    }),
  ]);
  // Regra do grupo: só aparece quem tem ponto registrado hoje.
  const days = mergeTaskReportRows(productionDays, clockIns, production.RULES)
    .filter((day) => Array.isArray(day.reportClockIns) && day.reportClockIns.length > 0);

  days.sort((a, b) => {
    const storeOrder = String(a.reportStore?.name || a.store?.name || '').localeCompare(
      String(b.reportStore?.name || b.store?.name || ''),
      'pt-BR',
    );
    return storeOrder || String(a.seller?.name || '').localeCompare(String(b.seller?.name || ''), 'pt-BR');
  });

  const lines = [];
  lines.push(`📊 *PERCENTUAL DE TAREFAS — ${checkpoint.label}*`);
  lines.push(`${fmtDateBR(now)} · 🕒 ${fmtTime(now)}`);

  if (!days.length) {
    lines.push('⚪ Nenhum vendedor com ponto registrado hoje.');
    return lines.join('\n');
  }

  const compact = true;
  const totals = {
    sellers: days.length,
    approved: 0,
    awaitingReview: 0,
    noncompliant: 0,
    correctionInTime: 0,
    notDue: 0,
    excused: 0,
    unknownSchedule: 0,
    missingEnd: 0,
  };
  let currentStoreId = null;
  const summaryRows = [];
  const summaryInsertIndex = lines.length;
  let pointRegistered = 0;

  for (const day of days) {
    const reportStore = day.reportStore || day.store;
    if (reportStore?.id !== currentStoreId) {
      if (currentStoreId !== null) lines.push('');
      currentStoreId = reportStore?.id;
      lines.push(`🏬 *${reportStore?.name || 'Loja não informada'}*`);
    }

    const sellerClockIns = day.reportClockIns || [];
    const observedEntry = sellerClockIns.find((row) => row.type === 'entry')?.timestamp;
    const observedExit = sellerClockIns.slice().reverse().find((row) => row.type === 'exit')?.timestamp;
    const effectiveStart = day.scheduleStart || (observedEntry ? fmtTime(observedEntry) : null);
    const effectiveEnd = day.scheduleEnd || (observedExit ? fmtTime(observedExit) : null);
    const effectiveDay = effectiveStart === day.scheduleStart && effectiveEnd === day.scheduleEnd
      ? day
      : { ...day, scheduleStart: effectiveStart, scheduleEnd: effectiveEnd };
    const result = classifyProductionDay(effectiveDay, checkpoint.minutes);
    const hasPoint = Boolean(observedEntry || observedExit);
    if (hasPoint) pointRegistered += 1;
    const totalTasks = day.items.length;
    const approvedTasks = result.approved.length;
    const percentage = totalTasks ? Math.round((approvedTasks / totalTasks) * 100) : null;
    const submittedTasks = day.items.filter((item) => item.status === 'SUBMITTED').length;
    const rejectedTasks = day.items.filter((item) => item.status === 'REJECTED').length;
    const pointSummary = observedEntry
      ? `ponto ${fmtTime(observedEntry)}${observedExit ? `–${fmtTime(observedExit)}` : ' (saída pendente)'}`
      : observedExit
        ? `ponto saída ${fmtTime(observedExit)} (entrada pendente)`
        : 'sem ponto';
    const state = !hasPoint
      ? 'SEM PONTO'
      : rejectedTasks
        ? 'DEVOLVIDA PARA CORREÇÃO'
        : submittedTasks
        ? 'AGUARDANDO FISCALIZAÇÃO'
        : approvedTasks === totalTasks
          ? 'CONCLUÍDO'
          : approvedTasks
            ? 'PARCIALMENTE CUMPRIDO'
            : 'PENDENTE DE REGISTRO';
    summaryRows.push(
      `${hasPoint ? '🟢' : '🔴'} *${day.seller?.name || 'Vendedor'}*`,
      `   ${percentage === null ? 'Percentual não calculado' : `${percentage}% (${approvedTasks}/${totalTasks})`} · ${pointSummary} · ${state}`,
    );
    totals.approved += result.approved.length;
    totals.awaitingReview += result.awaitingReview.length;
    totals.noncompliant += result.noncompliant.length;
    totals.correctionInTime += result.correctionInTime.length;
    totals.notDue += result.notDue.length;
    totals.excused += result.excused.length;
    if (!result.scheduleKnown && !result.dayExcused) totals.unknownSchedule += 1;
    if (result.scheduleKnown && !result.endKnown && !result.dayExcused) totals.missingEnd += 1;

    if (!compact) {
    const schedule = day.scheduleStart && day.scheduleEnd
      ? ` · escala ${day.scheduleStart}–${day.scheduleEnd}`
      : effectiveStart && effectiveEnd
        ? ` · ponto diário ${effectiveStart}–${effectiveEnd}`
        : effectiveStart
          ? ` · entrada registrada ${effectiveStart}`
      : '';
    lines.push(`👤 *${day.seller?.name || 'Vendedor'}*${schedule}`);
    if (observedEntry) {
      lines.push(
        `  🟢 Ponto na ${reportStore?.name || 'loja'}: entrada ${fmtTime(observedEntry)}`
        + (observedExit ? ` · saída ${fmtTime(observedExit)}` : ' · saída ainda não registrada'),
      );
    } else if (observedExit) {
      lines.push(`  ⚠️ Ponto: saída ${fmtTime(observedExit)} sem entrada registrada`);
    } else {
      lines.push('  🔴 Ponto: não registrado hoje');
    }
    if (day.reportSynthetic) {
      lines.push('  ℹ️ Sem checklist aberto: as tarefas foram conferidas pelas regras vigentes e pelos registros existentes.');
    }

    if (result.dayExcused) {
      lines.push('  ⚪ *Dia justificado pela fiscalização*');
      continue;
    }
    taskLineList(lines, 'CUMPRIU', '✅', result.approved);
    taskLineList(lines, 'ENVIOU — AGUARDANDO FISCALIZAÇÃO', '🔎', result.awaitingReview);
    taskLineList(lines, 'NÃO CUMPRIU NO PRAZO', '❌', result.noncompliant);
    taskLineList(lines, 'DEVOLVIDA PARA CORREÇÃO — AINDA NO PRAZO', '↩️', result.correctionInTime);
    taskLineList(lines, 'JUSTIFICADA', '⚪', result.excused);
    if (result.notDue.length) {
      lines.push(`  ⏳ Ainda no prazo: ${result.notDue.length} tarefa(s)`);
    }
    if (!result.scheduleKnown) {
      lines.push('  ⚠️ Sem horário de escala: pendências não foram chamadas de descumprimento.');
    } else if (!result.endKnown) {
      lines.push('  ⚠️ Sem horário de saída: a tarefa de saída não foi chamada de descumprimento.');
    }
    if (!day.items.length) {
      lines.push('  ⚠️ Checklist sem tarefas cadastradas.');
    }
    }
  }

  lines.splice(summaryInsertIndex, 0,
    '',
    `📍 *PERCENTUAL DE TAREFAS — ${pointRegistered}/${days.length} com ponto registrado*`,
    'Cálculo: tarefas aprovadas pela fiscalização ÷ tarefas previstas do dia.',
    ...summaryRows,
    '',
  );

  lines.push('Somente APPROVED entra no percentual; SUBMITTED permanece aguardando fiscalização.');
  return lines.join('\n');
}
*/

/**
 * Monta o relatório direto de produção das tarefas.
 *
 * O relatório de ponto é separado: nenhum registro de ponto é consultado,
 * usado para filtrar vendedores ou exibido aqui. A produção é medida apenas
 * pelas tarefas do checklist e somente APPROVED entra no percentual.
 */
async function buildTaskComplianceReport(checkpointValue, now = new Date()) {
  const checkpoint = taskCheckpoint(checkpointValue, now);
  const dayStart = localDayStartUtc(now);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  const codeFilter = (process.env.RELATORIO_STORE_CODES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);

  const days = await prisma.sellerProductionDay.findMany({
    where: {
      workDate: { gte: dayStart, lt: dayEnd },
      ...(codeFilter.length ? { store: { code: { in: codeFilter } } } : {}),
    },
    select: {
      id: true,
      sellerId: true,
      status: true,
      scheduleStart: true,
      scheduleEnd: true,
      seller: {
        select: {
          id: true,
          name: true,
          active: true,
        },
      },
      store: { select: { id: true, name: true, code: true } },
      items: {
        select: { ruleKey: true, phase: true, position: true, title: true, status: true, reviewNote: true },
        orderBy: { position: 'asc' },
      },
    },
  });

  days.sort((a, b) => String(a.seller?.name || '').localeCompare(
    String(b.seller?.name || ''),
    'pt-BR',
  ));

  const lines = [
    `📊 *PERCENTUAL DE TAREFAS — ${checkpoint.label}*`,
    `${fmtDateBR(now)} · 🕒 ${fmtTime(now)}`,
  ];

  if (!days.length) {
    lines.push('⚪ Nenhuma tarefa registrada hoje.');
    return lines.join('\n');
  }

  lines.push(
    '',
    'Produção aprovada pela fiscalização:',
    '🔒 Tudo que é enviado, aprovado, rejeitado ou fica pendente está sendo registrado no histórico do TenisCash.',
    '⚠️ Atividade obrigatória sem registro aprovado NÃO é considerada executada.',
  );
  for (const day of days) {
    const result = classifyProductionDay(day, checkpoint.minutes);
    const items = Array.isArray(day.items) ? day.items : [];
    const totalTasks = items.length;
    const approvedTasks = result.approved.length;
    const percentage = totalTasks > 0 ? Math.round((approvedTasks / totalTasks) * 100) : 0;
    const submittedTasks = items.filter((item) => item.status === 'SUBMITTED').length;
    const rejectedTasks = items.filter((item) => item.status === 'REJECTED').length;
    const state = day.status === 'EXCUSED'
      ? 'DIA JUSTIFICADO'
      : rejectedTasks
        ? 'DEVOLVIDA PARA CORREÇÃO'
        : submittedTasks
          ? 'AGUARDANDO FISCALIZAÇÃO'
          : totalTasks > 0 && approvedTasks === totalTasks
            ? 'CONCLUÍDO'
            : approvedTasks
              ? 'PARCIALMENTE CUMPRIDO'
              : 'SEM PRODUÇÃO APROVADA';
    const marker = percentage === 100 ? '✅' : percentage > 0 ? '⚠️' : '❌';
    lines.push(
      `${marker} *${day.seller?.name || 'Vendedor'}* — ${percentage}% (${approvedTasks}/${totalTasks} tarefas aprovadas) · ${state}`,
    );
    for (const item of items) {
      const status = liveTaskStatus(item);
      const title = String(item.title || item.ruleKey || 'Tarefa sem título').replace(/\s+/g, ' ').trim();
      const note = item.reviewNote ? ` — ${String(item.reviewNote).replace(/\s+/g, ' ').trim()}` : '';
      lines.push(`  ${status.emoji} ${title} — ${status.label}${note}`);
    }
  }

  lines.push(
    '',
    'Cálculo: tarefas aprovadas pela fiscalização ÷ tarefas previstas do dia.',
    '0% = nenhuma tarefa aprovada até este relatório.',
  );
  return lines.join('\n');
}

async function sendTaskComplianceReport(checkpointValue, now = new Date()) {
  const checkpoint = taskCheckpoint(checkpointValue, now);
  let text;
  try {
    text = await buildTaskComplianceReport(checkpoint.minutes, now);
  } catch (e) {
    console.error('[equipeReports] buildTaskComplianceReport falhou:', e.message);
    return { sent: false, error: e.message };
  }

  const jid = tarefasGroupJid();
  if (!jid || !isEvolutionConfigured()) {
    console.log(`[equipeReports] tarefas ${checkpoint.label} NÃO enviadas (grupo não configurado).`);
    return { sent: false, text, reason: 'no_group' };
  }

  const rawChunks = splitWhatsAppText(text);
  const chunks = rawChunks.map((chunk, index) => (
    rawChunks.length > 1 ? `*TAREFAS — parte ${index + 1}/${rawChunks.length}*\n${chunk}` : chunk
  ));
  const results = [];
  for (const chunk of chunks) {
    const result = await sendEvolutionRaw(jid, chunk);
    results.push(result);
    if (!result.ok) break;
  }
  const sent = results.length === chunks.length && results.every((result) => result.ok);
  const error = results.find((result) => !result.ok)?.error;
  console.log(`[equipeReports] tarefas ${checkpoint.label} → ${sent ? 'ENVIADAS' : 'FALHARAM: ' + (error || 'envio incompleto')}`);
  return { sent, text, chunks: chunks.length, error };
}

async function loadTaskReportSchedule(now = new Date()) {
  const dayStart = localDayStartUtc(now);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  const codeFilter = (process.env.RELATORIO_STORE_CODES || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const where = {
    workDate: { gte: dayStart, lt: dayEnd },
    ...(codeFilter.length ? { store: { code: { in: codeFilter } } } : {}),
  };
  const [shifts, firstEntry] = await Promise.all([
    prisma.sellerProductionDay.findMany({
      where,
      select: { scheduleStart: true, scheduleEnd: true },
    }),
    prisma.clockIn.findFirst({
      where: {
        type: 'entry',
        timestamp: { gte: dayStart, lt: dayEnd },
        ...(codeFilter.length ? { store: { code: { in: codeFilter } } } : {}),
      },
      select: { timestamp: true },
      orderBy: { timestamp: 'asc' },
    }),
  ]);
  const entryParts = firstEntry ? localParts(firstEntry.timestamp) : null;
  const observedOpening = entryParts ? (entryParts.H * 60) + entryParts.Min : null;
  return {
    ...buildTaskReportSchedule(shifts, { openingMinutes: observedOpening }),
    source: firstEntry ? 'FIRST_CLOCK_IN' : 'SCHEDULE',
  };
}

function taskReportDeliveryKey(now, slotMinutes) {
  const { y, m, d } = localParts(now);
  const ymd = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return `equipe_tasks_report:${ymd}:${String(slotMinutes)}`;
}

async function reserveTaskReportDelivery(key, now = new Date()) {
  try {
    await prisma.config.create({
      data: {
        id: key,
        key,
        value: JSON.stringify({ status: 'SENDING', reservedAt: now.toISOString() }),
      },
    });
    return true;
  } catch (error) {
    if (error?.code === 'P2002') return false;
    throw error;
  }
}

async function maybeSendScheduledTaskReport(now = new Date()) {
  const schedule = await loadTaskReportSchedule(now);
  if (!schedule.scheduleKnown) return { sent: false, reason: 'no_schedule' };
  const { H, Min } = localParts(now);
  const currentMinutes = (H * 60) + Min;
  const slot = schedule.slots.find((value) => value === currentMinutes);
  if (slot === undefined) return { sent: false, reason: 'not_due', schedule };

  const deliveryKey = taskReportDeliveryKey(now, slot);
  const reserved = await reserveTaskReportDelivery(deliveryKey, now);
  if (!reserved) return { sent: false, reason: 'already_processed', schedule };

  const result = await sendTaskComplianceReport(slot, now);
  if (result.sent) {
    await prisma.config.update({
      where: { key: deliveryKey },
      data: { value: JSON.stringify({ status: 'SENT', sentAt: new Date().toISOString(), chunks: result.chunks }) },
    }).catch(() => {});
  } else {
    // Libera para a segunda tentativa dentro do mesmo minuto (:30).
    await prisma.config.delete({ where: { key: deliveryKey } }).catch(() => {});
  }
  return { ...result, schedule, slot };
}

// ---------------------------------------------------------------------
// CRON — vendas/presença fixos; tarefas conforme a primeira escala do dia
// ---------------------------------------------------------------------
function startEquipeReportsCron() {
  if (process.env.DISABLE_EQUIPE_REPORTS === '1') {
    console.log('[equipeReports] desativado (DISABLE_EQUIPE_REPORTS=1)');
    return;
  }
  // Vendas e presença continuam nos checkpoints já existentes.
  const checkpoint = (h) => async () => {
    try { await sendSalesReport(h); } catch (e) { console.error('[equipeReports] sendSalesReport', h, e.message); }
    try { await sendPresenceReport(); } catch (e) { console.error('[equipeReports] sendPresenceReport', e.message); }
  };
  cron.schedule('0 13 * * *', checkpoint(13), { timezone: 'America/Fortaleza' });
  cron.schedule('0 18 * * *', checkpoint(18), { timezone: 'America/Fortaleza' });
  cron.schedule('0 21 * * *', checkpoint(21), { timezone: 'America/Fortaleza' });
  // Verifica duas vezes no minuto previsto. A reserva persistente impede duplicidade.
  cron.schedule('0,30 * * * * *', () => {
    maybeSendScheduledTaskReport().catch((e) => console.error('[equipeReports] tarefas por escala', e.message));
  }, { timezone: 'America/Fortaleza' });
  const jid = vendasGroupJid();
  console.log(
    `[equipeReports] cron iniciado (vendas+presença 13h/18h/21h; tarefas +1h da primeira escala e depois a cada 3h)` +
    (jid ? '' : ' — ⚠️ WHATSAPP_GROUP_JID vazio: nada será enviado até configurar o grupo')
  );
  loadTaskReportSchedule().then((schedule) => {
    if (!schedule.scheduleKnown) {
      console.log('[equipeReports] tarefas: hoje ainda não há escala válida; nenhum horário foi estimado');
      return;
    }
    console.log(
      `[equipeReports] tarefas de hoje: abertura ${formatMinutes(schedule.openingMinutes)} (${schedule.source === 'FIRST_CLOCK_IN' ? 'primeiro ponto' : 'escala'}); envios ${schedule.slots.map(formatMinutes).join(', ')}`
    );
  }).catch((e) => console.error('[equipeReports] leitura da escala', e.message));
}

module.exports = {
  startEquipeReportsCron,
  sendSalesReport,
  buildSalesReport,
  notifyClockEvent,
  notifyPersonalClockMessage,
  buildPersonalTaskReportText,
  notifyTaskStatusChange,
  buildLiveTaskUpdateText,
  buildPresenceReport,
  sendPresenceReport,
  buildTaskComplianceReport,
  sendTaskComplianceReport,
  loadTaskReportSchedule,
  maybeSendScheduledTaskReport,
  pontoGroupJid,
  vendasGroupJid,
  tarefasGroupJid,
};
