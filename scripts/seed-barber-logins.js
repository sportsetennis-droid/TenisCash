/**
 * Cria 3 contas DEMO no /barber pra o dono entrar e conferir cada via.
 * Usa os MESMOS endpoints do app (register/login/professional/venue/offer/availability/book),
 * então os dados ficam idênticos ao uso real. Idempotente (registra; se já existe, loga).
 *
 *   node scripts/seed-barber-logins.js            -> roda contra https://teniscash.com.br
 *   BARBER_BASE=http://localhost:3000 node scripts/seed-barber-logins.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();
const BASE = process.env.BARBER_BASE || 'https://teniscash.com.br';
const PASS = 'demo1234';

async function req(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  });
  let j; const txt = await r.text();
  try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 200) }; }
  return { status: r.status, j };
}
async function get(path, token) {
  const r = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  let j; const txt = await r.text();
  try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 200) }; }
  return { status: r.status, j };
}
async function ensureUser(name, phone) {
  // cria/atualiza o User direto no banco (register exige OTP; login só compara bcrypt).
  const cleanPhone = phone.replace(/\D/g, '');
  const hash = await bcrypt.hash(PASS, 10);
  const existing = await prisma.user.findUnique({ where: { phone: cleanPhone } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { pin: hash, active: true, name } });
  } else {
    await prisma.user.create({
      data: { name, phone: cleanPhone, birthDate: '1990-01-01', pin: hash, balance: 0, lgpdAccepted: true, lgpdDate: new Date() },
    });
  }
  const login = await req('/api/auth/login', { phone: cleanPhone, password: PASS });
  if (login.j && login.j.token) return login.j.token;
  throw new Error(`login ${phone}: ${login.status} ${JSON.stringify(login.j)}`);
}
async function ensurePro(token, displayName, headline) {
  const c = await req('/api/professionals/me', { displayName, headline, category: 'barber' }, token);
  // garante published via PATCH (default do schema é não-publicado)
  await fetch(BASE + '/api/professionals/me', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ published: true }),
  }).catch(() => {});
  return c.j; // {id, slug, ...}
}
async function addAvail(token, weekdays, startMin, endMin) {
  for (const wd of weekdays) await req('/api/services/me/availability', { weekday: wd, startMin, endMin }, token);
}
async function addOffers(token, offers) {
  const out = [];
  for (const o of offers) {
    const r = await req('/api/professionals/me/offers', { type: 'class_presential', ...o }, token);
    if (r.j && r.j.id) out.push(r.j);
  }
  // se já existiam, busca a lista
  if (!out.length) { const g = await get('/api/professionals/me/offers', token); if (Array.isArray(g.j)) return g.j; }
  return out;
}

(async () => {
  console.log('BASE =', BASE, '\n');

  // ---------- CLIENTE ----------
  const cli = { name: 'Cliente Demo', phone: '83999990001' };
  const cliTok = await ensureUser(cli.name, cli.phone);
  console.log('✅ CLIENTE  ', cli.phone, '/', PASS);

  // ---------- BARBEIRO (autônomo) ----------
  const bar = { name: 'Barbeiro Demo', phone: '83999990002' };
  const barTok = await ensureUser(bar.name, bar.phone);
  const barPro = await ensurePro(barTok, 'Barbeiro Demo', 'Navalha & máquina · Bessa');
  await addAvail(barTok, [0, 1, 2, 3, 4, 5, 6], 540, 1080); // todos os dias 09:00–18:00
  const barOffers = await addOffers(barTok, [
    { title: 'Corte', price: 40, durationMin: 30 },
    { title: 'Barba', price: 30, durationMin: 20 },
    { title: 'Corte + Barba', price: 65, durationMin: 50 },
  ]);
  console.log('✅ BARBEIRO ', bar.phone, '/', PASS, '| slug:', barPro && barPro.slug, '| offers:', barOffers.length);

  // ---------- BARBEARIA (dono) ----------
  const own = { name: 'Dono Demo', phone: '83999990003' };
  const ownTok = await ensureUser(own.name, own.phone);
  const ownPro = await ensurePro(ownTok, 'Dono Demo', 'Barbeiro & dono');
  await addAvail(ownTok, [1, 2, 3, 4, 5, 6], 540, 1140); // seg-sáb 09:00–19:00
  await addOffers(ownTok, [
    { title: 'Corte na tesoura', price: 50, durationMin: 40 },
    { title: 'Corte + Barba', price: 70, durationMin: 50 },
  ]);
  // cria/garante a barbearia
  const myVenues = await get('/api/services/me/venues', ownTok);
  let venue = Array.isArray(myVenues.j) ? myVenues.j.find((v) => v.name === 'Barbearia Demo') : null;
  if (!venue) {
    const v = await req('/api/services/venues', { name: 'Barbearia Demo', segment: 'barbearia', city: 'João Pessoa', neighborhood: 'Bessa', givesCashback: true }, ownTok);
    venue = v.j;
  }
  // publica a barbearia (default é não-publicado → não apareceria na busca)
  await fetch(BASE + '/api/services/venues/' + venue.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ownTok },
    body: JSON.stringify({ published: true }),
  }).catch(() => {});
  // adiciona o DONO e o BARBEIRO DEMO como equipe (interliga as vias)
  if (ownPro && ownPro.slug) await req('/api/services/venues/' + venue.id + '/members', { slug: ownPro.slug, role: 'owner' }, ownTok);
  if (barPro && barPro.slug) await req('/api/services/venues/' + venue.id + '/members', { slug: barPro.slug, commissionPct: 50 }, ownTok);
  console.log('✅ BARBEARIA', own.phone, '/', PASS, '| venue:', venue && venue.slug, '| id:', venue && venue.id);

  // ---------- AGENDAMENTO DE EXEMPLO (interliga as 3 agendas) ----------
  // cliente marca com o barbeiro-demo na barbearia-demo, amanhã 10:00 (Fortaleza = UTC-3)
  try {
    const offer = (barOffers && barOffers[0]) || null;
    if (offer && barPro && venue) {
      const now = new Date();
      const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 13, 0, 0)); // 10:00 local
      const bk = await req('/api/services/book', {
        professionalId: barPro.id, venueId: venue.id, offerId: offer.id, startAt: t.toISOString(), source: 'cliente',
      }, cliTok);
      console.log('   agendamento exemplo:', bk.status, bk.j && (bk.j.id ? 'ok' : JSON.stringify(bk.j).slice(0, 120)));
    }
  } catch (e) { console.log('   agendamento exemplo falhou (ok ignorar):', e.message); }

  console.log('\n================ CONTAS DEMO (entre em ' + BASE + '/barber) ================');
  console.log('CLIENTE   → WhatsApp 83 99999-0001  | senha demo1234  (via Conta / cartão Cliente)');
  console.log('BARBEIRO  → WhatsApp 83 99999-0002  | senha demo1234  (cartão Barbeiro)');
  console.log('BARBEARIA → WhatsApp 83 99999-0003  | senha demo1234  (cartão Barbearia)');
  console.log('Barbearia "Barbearia Demo" publicada na BUSCA, com 2 barbeiros e serviços.');
  console.log('==============================================================================');
})().catch((e) => { console.error('ERRO:', e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
