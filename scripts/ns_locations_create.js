// One-off: create NS locations for the 4 physical stores + map Ecommerce to default
const { prisma } = require('../src/middleware');
const ns = require('../src/services/nuvemshop');

const onlyDigits = (s) => (s || '').replace(/\D/g, '');

// 4 lojas físicas que viram locations no Nuvemshop
const PHYSICAL = [
  { code: 'LOJA02', locName: 'Praia do Bessa' },
  { code: 'LOJA05', locName: 'Praia de Tambaú' },
  { code: 'LOJA03', locName: 'Rainha da Borborema' },
  { code: 'LOJA06', locName: 'Tambiá' },
];

function buildPayload(store, locName) {
  return {
    name: { pt_BR: locName },
    address: {
      zipcode: onlyDigits(store.cep),
      street: store.address ? store.address.replace(/,\s*\d+\s*$/, '').trim() : '',
      number: (store.address && (store.address.match(/,\s*(\d+)\s*$/) || [])[1]) || 'S/N',
      locality: store.neighborhood || '',
      reference: store.complement || null,
      city: store.city || 'João Pessoa',
      region: { code: 'NE', name: 'Nordeste' },
      province: { code: 'PB', name: 'Paraíba' },
      country: { code: 'BR', name: 'Brasil' },
      latitude: store.latitude,
      longitude: store.longitude,
    },
  };
}

(async () => {
  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });

  // mapeia locations existentes por nome pt_BR (para evitar duplicar)
  const existing = await ns.nuvemshopApi(conn, 'GET', '/locations');
  const byName = {};
  for (const l of existing) {
    const nm = (l.name && (l.name.pt_BR || l.name.pt) || '').trim().toLowerCase();
    if (nm) byName[nm] = l;
  }
  const defaultLoc = existing.find((l) => l.is_default) || existing[0];

  const results = [];

  for (const { code, locName } of PHYSICAL) {
    const store = await prisma.store.findUnique({ where: { code } });
    if (!store) { console.log('SKIP', code, 'sem store'); continue; }

    let loc = byName[locName.trim().toLowerCase()];
    if (loc) {
      console.log('JÁ EXISTE', locName, '→', loc.id);
    } else {
      const payload = buildPayload(store, locName);
      try {
        loc = await ns.nuvemshopApi(conn, 'POST', '/locations', payload);
        console.log('CRIADA', locName, '→', loc.id);
      } catch (e) {
        console.log('ERRO criar', locName, '::', e.message);
        console.log('  payload:', JSON.stringify(payload));
        continue;
      }
    }
    await prisma.store.update({ where: { code }, data: { nuvemshopLocationId: loc.id } });
    results.push({ code, locName, locationId: loc.id });
  }

  // Ecommerce (LOJA04) = estoque geral → location default da loja
  if (defaultLoc) {
    await prisma.store.update({ where: { code: 'LOJA04' }, data: { nuvemshopLocationId: defaultLoc.id } });
    results.push({ code: 'LOJA04', locName: 'Ecommerce (default)', locationId: defaultLoc.id });
    console.log('ECOMMERCE LOJA04 → default', defaultLoc.id, '(' + ((defaultLoc.name && (defaultLoc.name.pt_BR || defaultLoc.name.pt)) || '?') + ')');
  }

  console.log('\n=== MAPEAMENTO FINAL ===');
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
