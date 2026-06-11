// Migração: produtos publicados → categorias CANÔNICAS do menu (e marca).
// 1) backup da árvore + categorias atuais de cada produto mapeado
// 2) corrige typo "Profissinal" → "Profissional" (Chuteiras > Society)
// 3) DELETA os ramos-fantasma criados pelo push antigo (lista explícita, folha→pai)
// 4) re-push de todos os mapeados ativos com a resolução nova (cadeia canônica + marca)
// 5) relatório final
// Uso: node scripts/migrate-ns-categories.js [--apply]   (sem --apply = dry-run das etapas 2-4)
const fs = require('fs'); const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
const nh = require('../src/services/nuvemshopHandlers');
const APPLY = process.argv.includes('--apply');
const UA = 'TenisCash (bernardo_douglas@icloud.com)';

// Ramos-fantasma criados por pushes antigos (gêmeos canônicos existem no menu) — folhas primeiro.
const GHOSTS = [
  // Chuteiras > Homem (duplica Chuteiras > Futsal/Society/Campo do menu)
  { id: 39280332, why: 'Chuteiras>Homem>Futsal>Iniciante (canônico: Chuteiras>Futsal>Iniciante)' },
  { id: 39280321, why: 'Chuteiras>Homem>Futsal>Profissional' },
  { id: 39280324, why: 'Chuteiras>Homem>Futsal>Treino' },
  { id: 39063422, why: 'Chuteiras>Homem>Society>Iniciante' },
  { id: 39280334, why: 'Chuteiras>Homem>Society>Profissional' },
  { id: 39063427, why: 'Chuteiras>Homem>Society>Treino' },
  { id: 39280320, why: 'Chuteiras>Homem>Futsal' },
  { id: 39063420, why: 'Chuteiras>Homem>Society' },
  { id: 39063419, why: 'Chuteiras>Homem' },
  // 2ª raiz "Roupas" (duplica Roupas/dna-feminino do menu)
  { id: 39251771, why: 'Roupas(dup)>Mulher>Bermuda>Com Bolso' },
  { id: 39251770, why: 'Roupas(dup)>Mulher>Bermuda' },
  { id: 39251769, why: 'Roupas(dup)>Mulher' },
  { id: 39251768, why: 'Roupas raiz duplicada' },
  // Estilo de Vida duplicada sob Tênis > Mulher
  { id: 39056351, why: 'Tênis>Mulher>Estilo de Vida(dup)>Clássico' },
  { id: 39056339, why: 'Tênis>Mulher>Estilo de Vida duplicada' },
  // LifeStyle duplicada sob Tênis > Menina (canônico: Estilo de Vida)
  { id: 39233578, why: 'Tênis>Menina>LifeStyle(dup)>Clássico' },
  { id: 39233577, why: 'Tênis>Menina>LifeStyle duplicada' },
  // A CLASSIFICAR (produto não-classificado nem sobe — regra das 4; categorias mortas no menu)
  { id: 39056258, why: 'A CLASSIFICAR raiz duplicada' },
  { id: 39056257, why: 'A CLASSIFICAR raiz' },
];

async function api(conn, method, p, body) {
  const r = await fetch('https://api.tiendanube.com/v1/' + conn.nuvemshopUserId + p, {
    method, headers: { 'Authentication': 'bearer ' + conn.accessToken, 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404) return { __404: true };
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 150));
  return r.status === 204 ? {} : r.json();
}
async function allPages(conn, base) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const b = await api(conn, 'GET', `${base}${base.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b);
    if (b.length < 100) break;
  }
  return out;
}
const nm = (c) => (typeof c.name === 'object' ? c.name.pt : c.name) || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });

  // ===== 1. BACKUP =====
  const cats = await allPages(conn, '/categories');
  const prodsNs = await allPages(conn, '/products');
  const backup = {
    when: new Date().toISOString(),
    categories: cats.map((c) => ({ id: c.id, name: nm(c), parent: c.parent, handle: c.handle })),
    productCategories: prodsNs.map((p) => ({ id: p.id, name: typeof p.name === 'object' ? p.name.pt : p.name, categories: (p.categories || []).map((c) => c.id) })),
  };
  const bdir = path.join(__dirname, 'backups');
  if (!fs.existsSync(bdir)) fs.mkdirSync(bdir, { recursive: true });
  const bfile = path.join(bdir, 'migrate-ns-categories-backup.json');
  fs.writeFileSync(bfile, JSON.stringify(backup, null, 1), 'utf8');
  console.log('backup salvo:', bfile, `(${cats.length} categorias, ${prodsNs.length} produtos)`);

  // ===== 2. TYPO Profissinal -> Profissional =====
  const typo = cats.find((c) => nm(c).trim().toLowerCase() === 'profissinal');
  if (typo) {
    console.log(`typo: [${typo.id}] "Profissinal" -> "Profissional"` + (APPLY ? '' : ' (dry-run)'));
    if (APPLY) await api(conn, 'PUT', '/categories/' + typo.id, { name: { pt: 'Profissional' } });
  } else console.log('typo "Profissinal": não encontrado (já corrigido?)');

  // ===== 3. DELETE dos fantasmas =====
  const catIds = new Set(cats.map((c) => c.id));
  for (const g of GHOSTS) {
    if (!catIds.has(g.id)) { console.log(`ghost ${g.id} já não existe — ok`); continue; }
    console.log(`DELETE categoria ${g.id} — ${g.why}` + (APPLY ? '' : ' (dry-run)'));
    if (APPLY) {
      const r = await api(conn, 'DELETE', '/categories/' + g.id);
      if (r.__404) console.log('  (404 — já tinha sumido)');
      await sleep(250);
    }
  }

  // ===== 4. RE-PUSH dos mapeados ativos =====
  const mapped = await prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } });
  const prods = await prisma.product.findMany({ where: { id: { in: mapped.map((m) => m.localProductId) }, active: true }, select: { id: true, name: true } });
  console.log(`\nre-push de ${prods.length} produtos mapeados ativos` + (APPLY ? '' : ' (dry-run — pulado)'));
  if (APPLY) {
    nh.clearNsCache && nh.clearNsCache();
    let ok = 0, skip = 0, err = 0;
    for (const p of prods) {
      try {
        const r = await nh.pushProductToNuvemshop(p.id, conn);
        if (r && r.skipped) { skip++; console.log(`  SKIP ${p.name}: ${r.reason}`); }
        else ok++;
      } catch (e) { err++; console.log(`  ERRO ${p.name}: ${e.message.slice(0, 120)}`); }
      await sleep(350);
    }
    console.log(`re-push: ${ok} ok, ${skip} skip, ${err} erro`);
  }

  // ===== 5. RELATÓRIO =====
  if (APPLY) {
    const cats2 = await allPages(conn, '/categories');
    const byId = new Map(cats2.map((c) => [c.id, c]));
    const pathOf = (c) => { const parts = []; let cur = c; let g = 0; while (cur && g++ < 10) { parts.unshift(nm(cur)); cur = cur.parent ? byId.get(cur.parent) : null; } return parts.join(' > '); };
    const prods2 = await allPages(conn, '/products?published=true');
    const counts = new Map();
    for (const p of prods2) for (const c of p.categories || []) counts.set(c.id, (counts.get(c.id) || 0) + 1);
    console.log('\n=== CATEGORIAS COM PRODUTOS (depois) ===');
    for (const [cid, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const c = byId.get(cid);
      console.log(`  ${String(n).padStart(3)} -> [${cid}] ${c ? pathOf(c) : '??'}`);
    }
    console.log('\ntotal de categorias na loja:', cats2.length, '(antes:', cats.length + ')');
  }
})().catch((e) => console.error('ERRO:', e.stack)).finally(() => prisma.$disconnect());
