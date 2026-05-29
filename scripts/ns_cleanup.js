// Remove do Nuvemshop TODOS os produtos, exceto os 33 elegíveis (4 classificações).
// Fase 1 (default): backup completo + verificação do keep-set (NÃO apaga).
// Fase 2 (--confirm): apaga tudo que NÃO está no keep-set.
const fs = require('fs');
const path = require('path');
const { prisma } = require('../src/middleware');

const API_BASE = process.env.NUVEMSHOP_API_BASE_URL || 'https://api.tiendanube.com/v1';
const CONFIRM = process.argv.includes('--confirm');
const BAD_CAT = ['', 'A CLASSIFICAR', 'A DEFINIR'];
const has = (v) => v != null && String(v).trim() !== '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCtx(p) { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch { return {}; } }
function isFull(p) {
  const cls = (parseCtx(p).classification) || {};
  return has(p.category) && !BAD_CAT.includes(String(p.category).trim())
    && has(p.subcategory) && has(cls.modality) && has(cls.tier);
}

let CONN;
async function nsFetch(method, urlPath) {
  const url = `${API_BASE}/${CONN.nuvemshopUserId}${urlPath}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { method, headers: { 'Authentication': `bearer ${CONN.accessToken}`, 'Content-Type': 'application/json', 'User-Agent': 'TenisCash/1.0' } });
    if (r.status === 429) { const wait = Number(r.headers.get('retry-after') || 2) * 1000 + 500; await sleep(wait); continue; }
    const total = r.headers.get('x-total-count') || r.headers.get('total-count');
    let body = null;
    if (r.status !== 204) { try { body = await r.json(); } catch { body = null; } }
    return { status: r.status, body, total };
  }
  return { status: 429, body: null };
}

(async () => {
  CONN = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
  if (!CONN) { console.log('SEM conexão NS'); process.exit(1); }

  // ---- keep-set: NS product IDs dos 33 elegíveis (4 classificações) ----
  const candidates = await prisma.product.findMany({
    where: { active: true, category: { notIn: BAD_CAT }, subcategory: { not: null } },
    select: { id: true, name: true, aiContext: true, category: true, subcategory: true },
  });
  const eligible = candidates.filter(isFull);
  const maps = await prisma.nuvemshopProductMapping.findMany({
    where: { localProductId: { in: eligible.map((e) => e.id) } },
    select: { nuvemshopProductId: true, localProductId: true },
  });
  const keepIds = new Set(maps.map((m) => String(m.nuvemshopProductId)));
  console.log(`elegíveis (4 classif.): ${eligible.length}`);
  console.log(`keep-set (NS IDs com mapping): ${keepIds.size}`);

  // ---- baixa TODOS os produtos do NS (full) p/ backup ----
  const all = [];
  let page = 1;
  while (true) {
    const r = await nsFetch('GET', `/products?per_page=200&page=${page}&fields=id,name,published,handle`);
    if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0) break;
    all.push(...r.body);
    if (r.body.length < 200) break;
    page++;
    await sleep(150);
  }
  console.log(`produtos no NS (baixados): ${all.length}`);

  // cross-check: published=true deve bater com keep-set
  const published = all.filter((p) => p.published).map((p) => String(p.id));
  console.log(`publicados no NS: ${published.length}`);
  const pubNotKeep = published.filter((id) => !keepIds.has(id));
  const keepNotPub = [...keepIds].filter((id) => !published.includes(id));
  if (pubNotKeep.length) console.log(`  ⚠ publicados que NÃO estão no keep-set: ${pubNotKeep.length} -> ${pubNotKeep.slice(0,10)}`);
  if (keepNotPub.length) console.log(`  ⚠ keep-set que NÃO está publicado: ${keepNotPub.length} -> ${keepNotPub.slice(0,10)}`);

  const toDelete = all.filter((p) => !keepIds.has(String(p.id)));
  console.log(`A APAGAR: ${toDelete.length}`);
  console.log(`A MANTER: ${all.length - toDelete.length}`);

  // backup
  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `ns_cleanup_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ when: stamp, keepIds: [...keepIds], allProducts: all, toDelete: toDelete.map((p) => ({ id: p.id, name: p.name, published: p.published })) }, null, 2));
  console.log(`BACKUP salvo: ${file}`);

  // GUARDA: nunca apagar se keep-set fugiu do esperado
  if (keepIds.size === 0 || keepIds.size > 200) { console.log('ABORT: keep-set fora do esperado (0 ou >200). Não apaguei nada.'); process.exit(1); }

  if (!CONFIRM) { console.log('\n[DRY] Nada apagado. Rode com --confirm para apagar.'); process.exit(0); }

  // ---- DELETE ----
  console.log('\n=== APAGANDO ===');
  let ok = 0, fail = 0;
  const errs = [];
  for (let i = 0; i < toDelete.length; i++) {
    const p = toDelete[i];
    if (keepIds.has(String(p.id))) continue; // dupla proteção
    const r = await nsFetch('DELETE', `/products/${p.id}`);
    if (r.status === 200 || r.status === 204 || r.status === 404) ok++;
    else { fail++; errs.push({ id: p.id, status: r.status, msg: r.body && r.body.message }); }
    if (i % 100 === 0) console.log(`  ...${i}/${toDelete.length} (ok ${ok}, fail ${fail})`);
    await sleep(220);
  }
  console.log(`\n=== RESULTADO === apagados: ${ok} | falhas: ${fail}`);
  if (errs.length) console.log('erros (10):', JSON.stringify(errs.slice(0, 10), null, 2));

  // limpa mappings locais dos apagados
  const deletedIds = toDelete.map((p) => String(p.id));
  const delMap = await prisma.nuvemshopProductMapping.deleteMany({ where: { nuvemshopProductId: { in: deletedIds } } });
  console.log(`mappings locais removidos: ${delMap.count}`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
