// =====================================================================
// register-shipping-carrier.js
// =====================================================================
// Apos re-OAuth com scope 'write_shipping_carriers', registra o carrier
// 'Sports & Tennis Express' na Nuvemshop apontando pro endpoint
// /api/shipping/calculate publico.
//
// Idempotente: se ja existe, atualiza. Caso contrario cria.
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split(/\r?\n/).forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const { PrismaClient } = require('@prisma/client');
const ns = require('../src/services/nuvemshop');
const prisma = new PrismaClient();

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br';

(async () => {
  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
  if (!conn) { console.error('Sem conexao Nuvemshop'); process.exit(1); }

  console.log('Scope atual:', conn.scope);
  if (!conn.scope.includes('write_shipping_carriers')) {
    console.error('\n⚠ Scope NAO inclui write_shipping_carriers. Faca o re-OAuth primeiro.');
    console.error('  Acesse: ' + PUBLIC_BASE + '/api/nuvemshop/oauth/install');
    process.exit(1);
  }

  // Lista carriers existentes
  const existing = await ns.nuvemshopApi(conn, 'GET', '/shipping_carriers');
  const myCarrier = (Array.isArray(existing) ? existing : []).find(c => c.callback_url?.includes(PUBLIC_BASE));

  const payload = {
    name: 'Sports & Tennis Express',
    callback_url: `${PUBLIC_BASE}/api/shipping/calculate`,
    types: ['ship', 'pickup'],
    active: true,
  };

  let carrier;
  if (myCarrier) {
    console.log('Carrier existe (id=' + myCarrier.id + '), atualizando...');
    carrier = await ns.nuvemshopApi(conn, 'PUT', `/shipping_carriers/${myCarrier.id}`, payload);
  } else {
    console.log('Criando carrier...');
    carrier = await ns.nuvemshopApi(conn, 'POST', '/shipping_carriers', payload);
  }

  console.log('\nCarrier registrado:');
  console.log('  id:', carrier.id);
  console.log('  name:', carrier.name);
  console.log('  callback_url:', carrier.callback_url);
  console.log('  active:', carrier.active);
  console.log('  types:', JSON.stringify(carrier.types));

  // Cria option(s) — slot disponivel ao cliente no checkout
  try {
    const opts = await ns.nuvemshopApi(conn, 'GET', `/shipping_carriers/${carrier.id}/options`);
    if (!Array.isArray(opts) || !opts.length) {
      console.log('\nCriando option padrao...');
      const opt = await ns.nuvemshopApi(conn, 'POST', `/shipping_carriers/${carrier.id}/options`, {
        code: 'sportstennis-express',
        name: 'Sports & Tennis Express',
        active: true,
        additional_cost: 0,
        additional_days: 0,
      });
      console.log('  Option id:', opt.id);
    } else {
      console.log('\nOptions ja existem:', opts.length);
    }
  } catch (e) {
    console.warn('Falha em options:', e.message);
  }

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FATAL:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
