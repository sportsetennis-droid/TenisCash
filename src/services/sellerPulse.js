// Pulso diário do vendedor pelo WhatsApp (dono 17/11/2026): cada vendedor recebe cedo o PRÓPRIO
// resultado (ontem + mês + ranking + quanto falta pra próxima faixa da comissão + onde trabalha hoje)
// com um fechamento de ativação na linha do dono: "o dia vai passar de qualquer jeito; a energia é a
// mesma; o que muda é o que você produz". Só números reais do banco; sem frase pronta de autoajuda.
//
// Envio pra equipe autorizado pelo dono em 17/11/2026: 1 hora antes do expediente de cada vendedor (runPreShift).

const TZ_OFFSET_MS = 3 * 3600 * 1000; // America/Fortaleza (UTC-3, sem horário de verão)
const TIER_CENTS = Number(process.env.PULSE_TIER_CENTS || 2000000); // R$ 20 mil: comissão 1% → 2% (dono 16/11)
// Meta diária de cada vendedor (dono 17/11/2026: "Meta diária é mil reais").
const DAILY_GOAL = Number(process.env.PULSE_DAILY_GOAL || 1000);
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brl0 = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
function firstName(name) {
  const w = String(name || '').trim().split(/\s+/)[0] || '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}
function localYmd(ms) { return new Date(ms - TZ_OFFSET_MS).toISOString().slice(0, 10); }
function dayBounds(ymd) { const s = new Date(ymd + 'T03:00:00.000Z'); return { start: s, end: new Date(s.getTime() + 86400000) }; }
function addDays(ymd, n) { return new Date(Date.parse(ymd + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function dow(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); }
function br(ymd) { return ymd.split('-').reverse().slice(0, 2).join('/'); }

// Frases em rodízio (dono 17/11/2026: "tem que alternar as frases"). Ver pick(): o mesmo vendedor
// não repete frase em dias seguidos e, no mesmo dia, a frase varia entre os vendedores.
const CLOSINGS = [
  'O dia de hoje vai passar de qualquer jeito. A energia que você vai gastar é a mesma, vendendo ou não. O que muda é o que fica no fim do dia. Faz valer. 🧡',
  'Hoje tem as mesmas horas para todo mundo. Quem decide se elas viram resultado é você. Bora pra cima. 🧡',
  'Você vai estar na loja de qualquer jeito. Então que cada cliente que entrar saia atendido de verdade. 🧡',
  'Dia parado e dia produtivo cansam igual. Só um deles paga. Escolhe o que paga. 🧡',
  'O relógio não para pra ninguém. Cada atendimento de hoje é uma chance que não volta amanhã. 🧡',
  'Ninguém lembra do dia que passou devagar. Faz o de hoje valer a pena. 🧡',
  'Cada cliente que entra é uma venda esperando o seu atendimento. Vai buscar. 🧡',
  'O resultado do mês é feito de dias como o de hoje. Começa forte. 🧡',
  'Quem aborda primeiro, vende primeiro. Hoje é dia de chegar junto. 🧡',
  'Não espera o cliente pedir ajuda. Oferece, mostra, faz ele experimentar. 🧡',
  'Hoje não tem dia fraco: tem cliente pra encantar. Vai com tudo. 🧡',
  'Venda boa começa com um bom-dia sincero. O resto você sabe fazer. 🧡',
  'A meta não se bate no fim do mês. Ela se bate hoje, atendimento por atendimento. 🧡',
  'Mostra o segundo produto. Muita venda grande começou com "deixa eu te mostrar mais um". 🧡',
  'O dia é seu. Faz ele contar no placar. 🧡',
];

// Calcula o pulso de um vendedor. now = instante de referência (o envio cedo fala de ONTEM).
async function buildPulse(prisma, sellerId, { nowMs = Date.now() } = {}) {
  const today = localYmd(nowMs);
  const yesterday = addDays(today, -1);
  const y = dayBounds(yesterday);
  const monthKey = today.slice(0, 7);
  const monthStart = new Date(monthKey + '-01T03:00:00.000Z');
  const [yy, mm] = monthKey.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(yy, mm, 1, 3));
  const todayStart = dayBounds(today).start;

  const user = await prisma.user.findUnique({ where: { id: sellerId }, select: { id: true, name: true, phone: true, active: true } });
  if (!user) throw new Error('vendedor não encontrado');

  const notCanceled = { status: { not: 'canceled' } };
  const [ySales, monthAgg, todayShift] = await Promise.all([
    prisma.sale.findMany({
      where: { sellerId, createdAt: { gte: y.start, lt: y.end }, ...notCanceled },
      select: { totalAmount: true, items: { select: { quantity: true } } },
    }),
    // Ranking do mês até ontem (o dia de hoje ainda está começando).
    prisma.sale.groupBy({
      by: ['sellerId'], _sum: { totalAmount: true },
      where: { createdAt: { gte: monthStart, lt: todayStart }, ...notCanceled },
    }),
    findTodayShift(prisma, sellerId, today),
  ]);

  const yRevenue = ySales.reduce((s, x) => s + (Number(x.totalAmount) || 0), 0);
  const yCount = ySales.length;
  const yPieces = ySales.reduce((s, x) => s + (x.items || []).reduce((a, i) => a + (Number(i.quantity) || 0), 0), 0);
  const ranked = monthAgg.map((r) => ({ sellerId: r.sellerId, total: Number(r._sum.totalAmount) || 0 }))
    .filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  const pos = ranked.findIndex((r) => r.sellerId === sellerId);
  const monthTotal = pos >= 0 ? ranked[pos].total : 0;
  const ahead = pos > 0 ? ranked[pos - 1].total - monthTotal : null;
  const daysLeft = Math.max(1, Math.round((monthEnd - todayStart) / 86400000)); // conta hoje
  const tierMissing = Math.max(0, TIER_CENTS / 100 - monthTotal);

  return {
    today, yesterday, sellerId, name: user.name, phone: user.phone, active: user.active,
    yesterdayResult: { count: yCount, revenue: yRevenue, pieces: yPieces, ticket: yCount ? yRevenue / yCount : 0, wasOff: !yCount && !(await workedOn(prisma, sellerId, yesterday)) },
    month: { total: monthTotal, position: pos >= 0 ? pos + 1 : null, sellers: ranked.length, gapToNext: ahead, daysLeft, tierMissing, tierValue: TIER_CENTS / 100 },
    todayShift,
  };
}

async function findTodayShift(prisma, sellerId, ymd) {
  const b = dayBounds(ymd);
  const published = await prisma.sellerMonthlySchedule.findFirst({ where: { month: ymd.slice(0, 7), status: 'PUBLISHED' }, select: { id: true } });
  let shift = null;
  if (published) {
    shift = await prisma.sellerMonthlyShift.findFirst({ where: { scheduleId: published.id, sellerId, workDate: { gte: new Date(ymd + 'T00:00:00Z'), lte: new Date(ymd + 'T23:59:59Z') } }, include: { store: { select: { name: true } } } });
  } else {
    shift = await prisma.sellerSchedule.findFirst({ where: { sellerId, active: true, weekday: dow(ymd) }, include: { store: { select: { name: true } } } });
  }
  const off = await prisma.agendaActivity.findFirst({
    where: { sellerId, type: { in: ['folga', 'ferias'] }, date: { lt: b.end }, OR: [{ endDate: { gte: b.start } }, { endDate: null, date: { gte: new Date(ymd + 'T00:00:00Z') } }] },
    select: { type: true },
  });
  if (off) return { off: true, type: off.type };
  if (!shift) return null;
  return { off: false, store: shift.store ? shift.store.name : null, start: shift.startTime, end: shift.endTime };
}

async function workedOn(prisma, sellerId, ymd) {
  const b = dayBounds(ymd);
  const c = await prisma.clockIn.count({ where: { userId: sellerId, type: 'entry', timestamp: { gte: b.start, lt: b.end } } }).catch(() => 1);
  return c > 0;
}

function formatPulse(p) {
  const L = [];
  const yr = p.yesterdayResult;
  const m = p.month;
  L.push(`Bom dia, ${firstName(p.name)}! ☀️`);
  L.push('');
  if (yr.count) {
    L.push(`*Ontem (${WEEKDAYS[dow(p.yesterday)]}, ${br(p.yesterday)}):* ${yr.count} ${yr.count === 1 ? 'venda' : 'vendas'} · ${brl(yr.revenue)}`);
    L.push(`Ticket médio ${brl(yr.ticket)}${yr.pieces ? ` · ${yr.pieces} ${yr.pieces === 1 ? 'peça' : 'peças'}` : ''}`);
  } else if (yr.wasOff) {
    L.push(`*Ontem (${WEEKDAYS[dow(p.yesterday)]}, ${br(p.yesterday)}):* sem venda registrada (sem ponto no dia).`);
  } else {
    L.push(`*Ontem (${WEEKDAYS[dow(p.yesterday)]}, ${br(p.yesterday)}):* nenhuma venda registrada no seu nome.`);
  }
  L.push('');
  if (m.position) {
    L.push(`*No mês:* ${brl(m.total)} · ${m.position}º lugar entre ${m.sellers} vendedores`);
    if (m.position > 1 && m.gapToNext != null) L.push(`Faltam ${brl0(m.gapToNext + 1)} para passar o ${m.position - 1}º lugar.`);
    if (m.position === 1) L.push('Você lidera a rede. Agora é manter a distância. 🏆');
  } else {
    L.push('*No mês:* ainda sem venda registrada no seu nome.');
  }
  if (m.tierMissing > 0) {
    const perDay = m.tierMissing / m.daysLeft;
    L.push(`Faltam ${brl0(m.tierMissing)} para ${brl0(m.tierValue)}, quando a comissão do mês inteiro sobe de 1% para 2%. São ${m.daysLeft} ${m.daysLeft === 1 ? 'dia' : 'dias'}: ${brl0(perDay)} por dia.`);
  } else {
    L.push(`Você já passou de ${brl0(m.tierValue)}: sua comissão do mês inteiro está em 2%. 🔥`);
  }
  const s = p.todayShift;
  if (s && s.off) { L.push(''); L.push(s.type === 'ferias' ? 'Hoje você está de férias. Descansa! 🏖️' : 'Hoje é sua folga. Descansa e volta com tudo! 🌴'); }
  else if (s) { L.push(''); L.push(`*Hoje:* ${s.store || 'loja'}, ${s.start} às ${s.end}.`); }
  if (!(s && s.off)) {
    const doy = Math.floor((Date.parse(p.today + 'T12:00:00Z') - Date.UTC(Number(p.today.slice(0, 4)), 0, 1)) / 86400000);
    L.push('');
    L.push(CLOSINGS[doy % CLOSINGS.length]);
  }
  return L.join('\n');
}

// =====================================================================
// EXPEDIENTE (dono 17/11/2026): "Eles precisam receber uma mensagem 1 hora antes de iniciar seu
// expediente: o início do expediente, a meta do dia, o resultado do dia anterior e a meta mensal,
// engajamento, agradecimento e mensagem de autoestima. E a notificação dos pontos que bater."
// =====================================================================
let pulseSchema = null;
function ensurePulseSchema(prisma) {
  if (!pulseSchema) {
    pulseSchema = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SellerMonthlyGoal" (
        "sellerId" TEXT NOT NULL, "month" TEXT NOT NULL, "goalCents" INTEGER NOT NULL,
        "updatedById" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), PRIMARY KEY ("sellerId", "month"))`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SellerPulseSend" (
        "day" TEXT NOT NULL, "sellerId" TEXT NOT NULL, "kind" TEXT NOT NULL,
        "ok" BOOLEAN NOT NULL DEFAULT false, "error" TEXT, "sentAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(), PRIMARY KEY ("day", "sellerId", "kind"))`);
    })().catch((e) => { pulseSchema = null; throw e; });
  }
  return pulseSchema;
}

async function getGoals(prisma, month) {
  await ensurePulseSchema(prisma);
  return prisma.$queryRaw`SELECT "sellerId", "goalCents" FROM "SellerMonthlyGoal" WHERE "month" = ${month}`;
}
async function setGoal(prisma, sellerId, month, goalCents, updatedById) {
  await ensurePulseSchema(prisma);
  if (goalCents == null) { await prisma.$executeRaw`DELETE FROM "SellerMonthlyGoal" WHERE "sellerId" = ${sellerId} AND "month" = ${month}`; return; }
  await prisma.$executeRaw`INSERT INTO "SellerMonthlyGoal" ("sellerId","month","goalCents","updatedById","updatedAt") VALUES (${sellerId}, ${month}, ${goalCents}, ${updatedById || null}, NOW())
    ON CONFLICT ("sellerId","month") DO UPDATE SET "goalCents" = EXCLUDED."goalCents", "updatedById" = EXCLUDED."updatedById", "updatedAt" = NOW()`;
}

// Turnos do vendedor num intervalo (escala publicada do mês; senão a fixa), sem os dias de folga/férias.
async function shiftsBetween(prisma, sellerId, fromYmd, toYmd) {
  const days = [];
  for (let d = fromYmd; d <= toYmd; d = addDays(d, 1)) days.push(d);
  const from = new Date(fromYmd + 'T00:00:00Z'), to = new Date(toYmd + 'T23:59:59Z');
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  const [published, monthly, recurring, offs] = await Promise.all([
    prisma.sellerMonthlySchedule.findMany({ where: { month: { in: months }, status: 'PUBLISHED' }, select: { month: true } }),
    prisma.sellerMonthlyShift.findMany({ where: { sellerId, workDate: { gte: from, lte: to }, schedule: { status: 'PUBLISHED' } }, include: { store: { select: { name: true } } } }),
    prisma.sellerSchedule.findMany({ where: { sellerId, active: true }, include: { store: { select: { name: true } } } }),
    prisma.agendaActivity.findMany({ where: { sellerId, type: { in: ['folga', 'ferias'] }, date: { lte: to }, OR: [{ endDate: { gte: from } }, { endDate: null, date: { gte: from } }] }, select: { date: true, endDate: true, type: true } }),
  ]);
  const pub = new Set(published.map((p) => p.month));
  const ymdOf = (d) => new Date(d).toISOString().slice(0, 10);
  return days.map((ymd) => {
    const off = offs.find((o) => ymd >= ymdOf(o.date) && ymd <= ymdOf(o.endDate || o.date));
    if (off) return { ymd, off: off.type };
    const s = pub.has(ymd.slice(0, 7)) ? monthly.find((m) => ymdOf(m.workDate) === ymd) : recurring.find((r) => r.weekday === dow(ymd));
    return s ? { ymd, store: s.store ? s.store.name : null, start: s.startTime, end: s.endTime } : { ymd };
  });
}

const GRATITUDE = [
  'Obrigado pelo seu trabalho. Cada cliente bem atendido leva o nome da Sports & Tennis pra casa.',
  'Valeu por estar com a gente. A loja funciona porque você está lá.',
  'Obrigado por vestir a camisa. O seu esforço é visto.',
  'Gratidão por fazer parte do time. É o seu atendimento que faz o cliente voltar.',
  'Obrigado pela dedicação. Resultado bom tem o seu nome.',
  'Obrigado por cuidar da loja como se fosse sua.',
  'Valeu pela entrega de sempre. Faz diferença pra todo o time.',
  'Obrigado por representar bem a Sports & Tennis em cada atendimento.',
  'A gente reconhece o seu trabalho. Obrigado por estar com a gente.',
  'Obrigado pela sua energia. Ela contagia a equipe e o cliente.',
  'Valeu por cada cliente que você atendeu com carinho. Isso volta.',
  'Obrigado pela confiança e pelo compromisso com o time.',
  'Seu trabalho é parte do crescimento da empresa. Obrigado!',
  'Obrigado por ser exemplo de atendimento na loja.',
  'Valeu por estar junto nessa caminhada. A gente cresce com você.',
];
const ESTEEM = [
  'Você sabe vender. Confia no seu atendimento.',
  'Você é capaz de bater essa meta. Já mostrou isso antes.',
  'Cliente compra de quem passa segurança, e isso você tem.',
  'Conhecer o produto é o seu ponto forte. Usa ele hoje.',
  'Você faz diferença no time. Dá pra sentir quando você está na loja.',
  'Seu sorriso abre venda. Usa sem moderação.',
  'Você evoluiu muito. Olha pra trás e vê o quanto já cresceu.',
  'Você tem o que precisa pra fazer um grande dia.',
  'Você é bom no que faz. Hoje é mais um dia de provar isso.',
  'O cliente sente quando o vendedor acredita no produto. E você acredita.',
  'Você não está aqui por acaso. Tem talento pra isso.',
  'Cada "não" de ontem te deixou mais preparado pro "sim" de hoje.',
  'Você é referência pra quem está começando. Isso tem valor.',
  'Confia em você. Seu jeito de atender é único.',
  'Você consegue. Uma venda de cada vez.',
];
// Rodízio: posição = (dia + deslocamento do vendedor) — muda todo dia e espalha a equipe.
function dayNumber(ymd) { return Math.floor(Date.parse(String(ymd).slice(0, 10) + 'T12:00:00Z') / 86400000); }
function sellerOffset(sellerId, salt) {
  let h = 0; const key = String(sellerId) + ':' + salt;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}
function pick(list, ymd, sellerId, salt = 0) {
  return list[(dayNumber(ymd) + sellerOffset(sellerId, salt)) % list.length];
}

// Mensagem de 1 hora antes do expediente.
async function buildPreShift(prisma, sellerId, { nowMs = Date.now(), hint = null } = {}) {
  const p = await buildPulse(prisma, sellerId, { nowMs });
  const monthEnd = addDays(p.today.slice(0, 7) + '-01', 40).slice(0, 7) + '-01';
  const lastDay = addDays(monthEnd, -1);
  const shifts = await shiftsBetween(prisma, sellerId, p.today, lastDay);
  const today = (shifts[0] && shifts[0].start) ? shifts[0] : (hint || shifts[0] || {});
  const workDaysLeft = shifts.filter((s) => s.start).length;
  // Meta do mês: a cadastrada no admin; senão R$ 1.000 × dias de escala do vendedor no mês.
  const [goalRow] = (await getGoals(prisma, p.today.slice(0, 7))).filter((g) => g.sellerId === sellerId);
  let goal = goalRow ? Number(goalRow.goalCents) / 100 : null, goalSource = goalRow ? 'cadastrada' : null, monthWorkDays = null;
  if (goal == null) {
    const monthShifts = await shiftsBetween(prisma, sellerId, p.today.slice(0, 7) + '-01', lastDay);
    monthWorkDays = monthShifts.filter((x) => x.start).length;
    if (monthWorkDays) { goal = DAILY_GOAL * monthWorkDays; goalSource = 'diaria'; }
  }
  const missing = goal != null ? Math.max(0, goal - p.month.total) : null;
  const yesterdayHit = p.yesterdayResult.revenue >= DAILY_GOAL;
  return { ...p, shiftToday: today, workDaysLeft, goal, goalSource, monthWorkDays, goalMissing: missing, dayGoal: DAILY_GOAL, yesterdayHit };
}

function formatPreShift(p, { nowMs = Date.now() } = {}) {
  const hour = new Date(nowMs - TZ_OFFSET_MS).getUTCHours();
  const hello = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const L = [`${hello}, ${firstName(p.name)}! ${hour < 12 ? "☀️" : "👋"}`];
  const s = p.shiftToday;
  if (s && s.start && s.approx) L.push(`⏰ *Seu expediente hoje* começa por volta das ${s.start}${s.store ? ` — ${s.store}` : ''}.`);
  else if (s && s.start) L.push(`⏰ *Seu expediente hoje:* ${s.store || 'loja'}, das ${s.start} às ${s.end}.`);
  L.push('');
  const yr = p.yesterdayResult;
  if (yr.count) L.push(`📊 *Ontem (${WEEKDAYS[dow(p.yesterday)]}, ${br(p.yesterday)}):* ${yr.count} ${yr.count === 1 ? 'venda' : 'vendas'} · ${brl(yr.revenue)} · ticket ${brl(yr.ticket)}`);
  else L.push(`📊 *Ontem (${WEEKDAYS[dow(p.yesterday)]}, ${br(p.yesterday)}):* ${yr.wasOff ? 'você não estava na loja.' : 'nenhuma venda registrada no seu nome.'}`);
  if (yr.count) L.push(yr.revenue >= p.dayGoal ? '✅ Bateu a meta do dia ontem!' : `Faltaram ${brl0(p.dayGoal - yr.revenue)} para a meta do dia ontem.`);
  L.push(`🎯 *Meta de hoje:* ${brl0(p.dayGoal)}`);
  if (p.goal != null) {
    const pct = p.goal > 0 ? Math.round((p.month.total / p.goal) * 100) : 0;
    L.push(`📅 *Meta do mês:* ${brl0(p.goal)}${p.goalSource === 'diaria' ? ` (${p.monthWorkDays} dias × ${brl0(p.dayGoal)})` : ''} · você está em ${brl0(p.month.total)} (${pct}%)${p.month.position ? ` · ${p.month.position}º lugar na rede` : ''}`);
    if (p.goalMissing <= 0) L.push('🏆 Meta do mês batida! Agora é ir além.');
  } else {
    L.push(`📅 *No mês:* ${brl0(p.month.total)}${p.month.position ? ` · ${p.month.position}º lugar na rede` : ''}`);
  }
  if (p.month.tierMissing > 0) L.push(`Faltam ${brl0(p.month.tierMissing)} para ${brl0(p.month.tierValue)}, quando a comissão do mês inteiro sobe de 1% para 2%.`);
  else L.push(`🔥 Você já passou de ${brl0(p.month.tierValue)}: comissão do mês inteiro em 2%.`);
  L.push('');
  L.push('🙏 ' + pick(GRATITUDE, p.today, p.sellerId, 1));
  L.push('💪 ' + pick(ESTEEM, p.today, p.sellerId, 2));
  L.push('');
  L.push(pick(CLOSINGS, p.today, p.sellerId, 3));
  return L.join('\n');
}

function enabled() { return String(process.env.PULSE_WHATSAPP || 'on').toLowerCase() !== 'off'; }
function defaultSend() { const wa = require('../whatsapp'); return (phone, msg) => wa.sendCustomMessage(phone, msg); }
function minutes(hhmm) { const [h, m] = String(hhmm || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; }

// Sem escala lançada (18/11/2026: ninguém tinha escala e ninguém recebeu): usa o horário em que a pessoa
// costuma bater a ENTRADA neste mesmo dia da semana (últimas 4 semanas, mínimo 2 dias). Assim folga
// habitual (dia da semana em que ela não costuma vir) não recebe mensagem.
async function typicalStart(prisma, sellerId, ymd, nowMs = Date.now()) {
  const since = new Date(nowMs - 28 * 86400000);
  const rows = await prisma.clockIn.findMany({ where: { userId: sellerId, type: 'entry', timestamp: { gte: since, lt: dayBounds(ymd).start } }, orderBy: { timestamp: 'asc' }, select: { timestamp: true, store: { select: { name: true } } } });
  const firstByDay = new Map();
  for (const r of rows) {
    const t = new Date(r.timestamp.getTime() - TZ_OFFSET_MS), d = t.toISOString().slice(0, 10);
    if (dow(d) !== dow(ymd) || firstByDay.has(d)) continue;
    firstByDay.set(d, { min: t.getUTCHours() * 60 + t.getUTCMinutes(), store: r.store ? r.store.name : null });
  }
  const days = [...firstByDay.values()];
  if (days.length < 2) return null;
  const mins = days.map((x) => x.min).sort((a, b) => a - b);
  const med = mins[Math.floor(mins.length / 2)];
  const rounded = Math.round(med / 15) * 15; // "por volta das" — arredonda em 15 min
  const hh = String(Math.floor(rounded / 60)).padStart(2, '0') + ':' + String(rounded % 60).padStart(2, '0');
  return { min: med, start: hh, store: days[days.length - 1].store, approx: true };
}
function validPhone(raw) {
  const t = String(raw || '');
  if (/[a-z@_]/i.test(t)) return false; // ex.: "email_1789..." não é telefone
  const d = t.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13;
}

// Roda a cada 5 min: manda a mensagem pra quem começa o expediente daqui a até 60 min (1 vez por dia).
async function runPreShift(prisma, { nowMs = Date.now(), send = defaultSend(), lead = 60 } = {}) {
  if (!enabled()) return { skipped: 'PULSE_WHATSAPP=off' };
  await ensurePulseSchema(prisma);
  const today = localYmd(nowMs);
  const local = new Date(nowMs - TZ_OFFSET_MS); const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  const sellers = await prisma.user.findMany({ where: { role: 'seller', active: true }, select: { id: true, phone: true } });
  let sent = 0, failed = 0;
  const done = new Set((await prisma.$queryRaw`SELECT "sellerId" FROM "SellerPulseSend" WHERE "day" = ${today} AND "kind" = 'preshift'`).map((r) => r.sellerId));
  // Trava (dono 17/11/2026: "não mandar para o vendedor que não está mais na empresa"): só recebe
  // quem bateu ponto ou vendeu nos últimos 21 dias. Cadastro ativo sozinho não basta.
  const since = new Date(nowMs - 21 * 86400000);
  const [recentClock, recentSale] = await Promise.all([
    prisma.clockIn.findMany({ where: { timestamp: { gte: since } }, distinct: ['userId'], select: { userId: true } }),
    prisma.sale.findMany({ where: { createdAt: { gte: since } }, distinct: ['sellerId'], select: { sellerId: true } }),
  ]);
  const working = new Set([...recentClock.map((r) => r.userId), ...recentSale.map((r) => r.sellerId)]);
  // Cargo: logística e supervisor têm acesso de vendedor mas não recebem meta/resultado de vendedor.
  const titles = await require('./jobTitle').all(prisma).catch(() => ({}));
  for (const sl of sellers) {
    if (done.has(sl.id) || !working.has(sl.id) || (titles[sl.id] && titles[sl.id] !== 'VENDEDOR')) continue;
    if (!validPhone(sl.phone)) continue;
    const [s] = await shiftsBetween(prisma, sl.id, today, today);
    if (s && s.off) continue; // folga/férias lançada
    let start = s && s.start ? minutes(s.start) : null, hint = null;
    if (start == null) { hint = await typicalStart(prisma, sl.id, today, nowMs); start = hint ? hint.min : null; }
    if (start == null || nowMin < start - lead || nowMin >= start) continue; // janela: de 1h antes até o início
    const claimed = await prisma.$executeRaw`INSERT INTO "SellerPulseSend" ("day","sellerId","kind") VALUES (${today}, ${sl.id}, 'preshift') ON CONFLICT DO NOTHING`;
    if (!claimed) continue;
    try {
      const msg = formatPreShift(await buildPreShift(prisma, sl.id, { nowMs, hint }), { nowMs });
      const r = await send(sl.phone, msg).catch((e) => ({ ok: false, error: e.message }));
      await prisma.$executeRaw`UPDATE "SellerPulseSend" SET "ok" = ${!!(r && r.ok)}, "error" = ${r && r.ok ? null : String((r && r.error) || 'falhou')} WHERE "day" = ${today} AND "sellerId" = ${sl.id} AND "kind" = 'preshift'`;
      if (r && r.ok) sent++; else failed++;
    } catch (e) { failed++; console.error('[pulso] pré-expediente', sl.id, e.message); }
  }
  return { sent, failed, day: today };
}

// Aviso pessoal a cada batida de ponto.
const ENTRY_LINES = ['Bom trabalho! 🧡', 'Bora fazer um grande dia! 🔥', 'Que hoje seja de muita venda! 🧡', 'Começou! Primeiro cliente é seu. 💪', 'Boa! Agora é atendimento de primeira. 🧡', 'Dia valendo! Vai com tudo. 🔥', 'Bem-vindo(a) de volta à loja! 🧡'];
const BACK_LINES = ['Bora pra segunda parte do dia! 💪', 'Volta com tudo! 🔥', 'Recarregado(a)? Agora é vender. 🧡', 'Segundo tempo começando! ⚽'];
const EXIT_LINES = ['Obrigado pelo dia, {nome}. Descansa! 🧡', 'Valeu pela entrega hoje, {nome}. Bom descanso! 🧡', 'Dia encerrado, {nome}. Obrigado por tudo hoje! 🙏', 'Missão cumprida, {nome}. Até a próxima! 🧡', 'Obrigado, {nome}! Recarrega a energia pra amanhã. 💪'];
const CLOCK_LABEL = { entry: ['✅', 'Entrada'], break_start: ['☕', 'Saída para o intervalo'], break_end: ['✅', 'Volta do intervalo'], exit: ['🏁', 'Saída'] };
async function notifyClock(prisma, { userId, storeName, type, at }, { send = defaultSend() } = {}) {
  if (!enabled()) return { skipped: true };
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true, role: true } });
  if (!u || !validPhone(u.phone) || u.role !== 'seller') return { skipped: true };
  const [emoji, label] = CLOCK_LABEL[type] || ['🕒', 'Ponto'];
  const hhmm = new Date(new Date(at).getTime() - TZ_OFFSET_MS).toISOString().slice(11, 16);
  let msg = `${emoji} *${label}* registrada às ${hhmm}${storeName ? ` — ${storeName}` : ''}.`;
  const ymdAt = localYmd(new Date(at).getTime());
  if (type === 'entry') msg += ' ' + pick(ENTRY_LINES, ymdAt, userId, 4);
  if (type === 'break_end') msg += ' ' + pick(BACK_LINES, ymdAt, userId, 5);
  if (type === 'exit') {
    const start = dayBounds(localYmd(new Date(at).getTime())).start;
    const agg = await prisma.sale.aggregate({ where: { sellerId: userId, createdAt: { gte: start }, status: { not: 'canceled' } }, _sum: { totalAmount: true }, _count: { _all: true } });
    const n = agg._count._all;
    const total = Number(agg._sum.totalAmount || 0);
    msg += n ? `\nHoje: ${n} ${n === 1 ? 'venda' : 'vendas'} · ${brl(total)}.` : '\nHoje: nenhuma venda registrada no seu nome.';
    msg += total >= DAILY_GOAL ? ' ✅ Meta do dia batida!' : ` Faltaram ${brl0(DAILY_GOAL - total)} para a meta do dia (${brl0(DAILY_GOAL)}).`;
    msg += '\n' + pick(EXIT_LINES, ymdAt, userId, 6).replace('{nome}', firstName(u.name));
  }
  return send(u.phone, msg).catch((e) => ({ ok: false, error: e.message }));
}

module.exports = { typicalStart, validPhone, buildPulse, formatPulse, CLOSINGS, localYmd, ensurePulseSchema, getGoals, setGoal, shiftsBetween, buildPreShift, formatPreShift, runPreShift, notifyClock };
