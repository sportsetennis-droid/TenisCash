// Pulso diário do vendedor pelo WhatsApp (dono 17/11/2026): cada vendedor recebe cedo o PRÓPRIO
// resultado (ontem + mês + ranking + quanto falta pra próxima faixa da comissão + onde trabalha hoje)
// com um fechamento de ativação na linha do dono: "o dia vai passar de qualquer jeito; a energia é a
// mesma; o que muda é o que você produz". Só números reais do banco; sem frase pronta de autoajuda.
//
// ENVIO PARA A EQUIPE SÓ DEPOIS QUE O DONO APROVAR O TEXTO. Por enquanto: prévia/teste pro dono.

const TZ_OFFSET_MS = 3 * 3600 * 1000; // America/Fortaleza (UTC-3, sem horário de verão)
const TIER_CENTS = Number(process.env.PULSE_TIER_CENTS || 2000000); // R$ 20 mil: comissão 1% → 2% (dono 16/11)
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

// Fechamentos (rodam pelo dia do ano — não repete o mesmo dois dias seguidos).
const CLOSINGS = [
  'O dia de hoje vai passar de qualquer jeito. A energia que você vai gastar é a mesma, vendendo ou não. O que muda é o que fica no fim do dia. Faz valer. 🧡',
  'Hoje tem as mesmas horas para todo mundo. Quem decide se elas viram resultado é você. Bora pra cima. 🧡',
  'Você vai estar na loja de qualquer jeito. Então que cada cliente que entrar saia atendido de verdade. 🧡',
  'Dia parado e dia produtivo cansam igual. Só um deles paga. Escolhe o que paga. 🧡',
  'O relógio não para pra ninguém. Cada atendimento de hoje é uma chance que não volta amanhã. 🧡',
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

module.exports = { buildPulse, formatPulse, CLOSINGS, localYmd };
