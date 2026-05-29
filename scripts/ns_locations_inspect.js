// One-off: inspect NS locations + store data
const { prisma } = require('../src/middleware');
const ns = require('../src/services/nuvemshop');

(async () => {
  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
  console.log('CONN userId=', conn?.nuvemshopUserId, 'scope=', conn?.scope);

  const locations = await ns.nuvemshopApi(conn, 'GET', '/locations');
  console.log('\n=== EXISTING LOCATIONS (full) ===');
  console.log(JSON.stringify(locations, null, 2));

  const codes = ['LOJA02', 'LOJA05', 'LOJA03', 'LOJA06', 'LOJA04'];
  const stores = await prisma.store.findMany({ where: { code: { in: codes } } });
  console.log('\n=== STORES ===');
  for (const s of stores) {
    console.log(JSON.stringify({
      code: s.code, name: s.name, address: s.address, complement: s.complement,
      neighborhood: s.neighborhood, city: s.city, state: s.state, cep: s.cep,
      phone: s.phone, latitude: s.latitude, longitude: s.longitude,
    }));
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
