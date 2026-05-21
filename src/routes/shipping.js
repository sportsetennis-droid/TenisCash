// =====================================================================
// Routes: /api/shipping — calculo de frete custom pra Nuvemshop
// =====================================================================
// Endpoint publico que a Nuvemshop chama durante o checkout pra obter
// opcoes de frete custom. Retorna:
//   - Retirada na loja (gratis) — se CEP destino fica ate 30km de alguma loja
//   - Entrega expressa 4h (gratis) — mesmo criterio
//   - Vazio caso contrario (so opcoes nativas NS aparecem)
//
// Doc do contrato: https://tiendanube.github.io/api-documentation/resources/shipping_carrier
// =====================================================================
const express = require('express');
const { prisma } = require('../middleware');

const router = express.Router();

// =====================================================================
// Geocoding cache (CEP -> lat/lng via ViaCEP + Nominatim)
// =====================================================================
const _cepCache = new Map();
const CEP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function geocodeCep(cep) {
  const clean = String(cep).replace(/\D/g, '');
  if (clean.length !== 8) return null;
  const cached = _cepCache.get(clean);
  if (cached && (Date.now() - cached.ts) < CEP_CACHE_TTL_MS) return cached.value;

  try {
    // 1. ViaCEP pra obter logradouro+cidade+UF
    const vcRes = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
    const vc = await vcRes.json();
    if (vc.erro) return null;
    const query = `${vc.logradouro || ''}, ${vc.localidade}, ${vc.uf}, Brasil`;

    // 2. Nominatim (OpenStreetMap) pra obter coords (free, sem chave)
    const nmRes = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      { headers: { 'User-Agent': 'TenisCash/1.0 (shipping)' } },
    );
    const nm = await nmRes.json();
    if (!Array.isArray(nm) || !nm[0]) return null;
    const value = { lat: parseFloat(nm[0].lat), lng: parseFloat(nm[0].lon), city: vc.localidade, uf: vc.uf };
    _cepCache.set(clean, { ts: Date.now(), value });
    return value;
  } catch (err) {
    console.error('[shipping geocode] erro:', err.message);
    return null;
  }
}

// Haversine — distancia em km entre dois pontos lat/lng
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =====================================================================
// POST /api/shipping/calculate
// Body (Nuvemshop): { destination, origin, items, currency, language }
// destination.postal_code = CEP do cliente
// items[] = { quantity, weight, dimensions, price, ... }
// Resposta: { rates: [{ name, code, price, currency, type, days, ...}] }
// =====================================================================
router.post('/calculate', async (req, res) => {
  try {
    const body = req.body || {};
    const destCep = (body.destination?.postal_code || body.destination?.zip || '').replace(/\D/g, '');
    if (!destCep || destCep.length !== 8) {
      return res.json({ rates: [] });
    }

    // Geocode CEP destino
    const destCoords = await geocodeCep(destCep);
    if (!destCoords) return res.json({ rates: [] });

    // Carrega 4 lojas fisicas ativas com lat/lng cadastrados
    const stores = await prisma.store.findMany({
      where: {
        active: true,
        latitude: { not: null },
        longitude: { not: null },
        // So lojas Sports & Tennis (exclui Baratao, Ecommerce virtual)
        name: { contains: 'Sports & Tennis', mode: 'insensitive' },
        NOT: { name: { contains: 'Ecommerce', mode: 'insensitive' } },
      },
      orderBy: { code: 'asc' },
    });

    if (!stores.length) return res.json({ rates: [] });

    // Calcula distancia destino vs cada loja, pega a mais proxima
    const ranked = stores.map((s) => ({
      store: s,
      distanceKm: haversineKm(destCoords.lat, destCoords.lng, s.latitude, s.longitude),
    })).sort((a, b) => a.distanceKm - b.distanceKm);

    const closest = ranked[0];
    const MAX_KM = 30;

    if (closest.distanceKm > MAX_KM) {
      // Fora da area de cobertura — sem opcoes custom (so Correios)
      return res.json({ rates: [] });
    }

    // Dentro de 30km: retorna Retirada + Entrega 4h, ambos gratis
    const rates = [
      {
        name: `Retirada na loja ${closest.store.name.replace(/^Sports & Tennis\s*/i, '')}`,
        code: `pickup-${closest.store.code}`,
        price: '0.00',
        currency: 'BRL',
        type: 'pickup',
        // Phone do estabelecimento se houver
        phone: closest.store.phone || null,
        // Endereco completo pro cliente saber onde retirar
        address: closest.store.address ? `${closest.store.address}${closest.store.complement ? ', ' + closest.store.complement : ''}${closest.store.neighborhood ? ', ' + closest.store.neighborhood : ''}, ${closest.store.city || 'João Pessoa'}/${closest.store.state || 'PB'}` : null,
        days: 0,
        time: 'até 4h',
        // ID que NS armazena, vc pode recuperar depois pra saber em qual loja retirar
        reference: closest.store.code,
      },
      {
        name: `Entrega expressa 4h (loja ${closest.store.name.replace(/^Sports & Tennis\s*/i, '')})`,
        code: `express-${closest.store.code}`,
        price: '0.00',
        currency: 'BRL',
        type: 'ship',
        days: 0,
        time: 'até 4h',
        reference: closest.store.code,
      },
    ];

    res.json({ rates });
  } catch (err) {
    console.error('[shipping/calculate] erro:', err);
    res.json({ rates: [] }); // falha silenciosa pra nao quebrar checkout
  }
});

// =====================================================================
// GET /api/shipping/test — endpoint de teste manual (admin/dev)
// =====================================================================
router.get('/test', async (req, res) => {
  const cep = req.query.cep;
  if (!cep) return res.json({ error: 'passe ?cep=58000000' });
  const coords = await geocodeCep(cep);
  if (!coords) return res.json({ error: 'CEP não geocodificado' });

  const stores = await prisma.store.findMany({
    where: {
      active: true, latitude: { not: null }, longitude: { not: null },
      name: { contains: 'Sports & Tennis', mode: 'insensitive' },
      NOT: { name: { contains: 'Ecommerce', mode: 'insensitive' } },
    },
  });
  const distances = stores.map((s) => ({
    code: s.code, name: s.name, address: s.address, cep: s.cep,
    distanceKm: Math.round(haversineKm(coords.lat, coords.lng, s.latitude, s.longitude) * 100) / 100,
  })).sort((a, b) => a.distanceKm - b.distanceKm);

  res.json({
    cepDestino: cep,
    coordsDestino: coords,
    storesProximas: distances,
    cobertura30km: distances.filter((d) => d.distanceKm <= 30),
  });
});

module.exports = router;
