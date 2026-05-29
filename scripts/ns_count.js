// Conta produtos no Nuvemshop (via header total-count) e cruza com nossos mappings.
const { prisma } = require('../src/middleware');

const API_BASE = process.env.NUVEMSHOP_API_BASE_URL || 'https://api.tiendanube.com/v1';

(async () => {
  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });

  async function totalCount(path) {
    const url = `${API_BASE}/${conn.nuvemshopUserId}${path}${path.includes('?') ? '&' : '?'}per_page=1&page=1`;
    const r = await fetch(url, { headers: { 'Authentication': `bearer ${conn.accessToken}`, 'User-Agent': 'TenisCash/1.0' } });
    return {
      total: r.headers.get('x-total-count') || r.headers.get('total-count') || '?',
      status: r.status,
    };
  }

  const allProds = await totalCount('/products');
  const publishedProds = await totalCount('/products?published=true');

  const mappings = await prisma.nuvemshopProductMapping.count();
  const mappedActive = await prisma.nuvemshopProductMapping.count({
    where: { localProduct: { active: true } },
  }).catch(() => null);

  console.log('=== NUVEMSHOP (loja ao vivo) ===');
  console.log('produtos TOTAIS no NS:      ', allProds.total, '(http', allProds.status + ')');
  console.log('produtos PUBLICADOS no NS:  ', publishedProds.total, '(http', publishedProds.status + ')');
  console.log('\n=== NOSSO LADO ===');
  console.log('mappings (produtos que NÓS já ligamos ao NS):', mappings);
  if (mappedActive != null) console.log('  desses, com produto local ATIVO:', mappedActive);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
