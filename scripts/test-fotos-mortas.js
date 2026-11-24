'use strict';
// Teste do gerente que retira fotos com link morto (src/services/fotosMortas.js).
// Sem banco: um db falso registra as consultas. Uso: node scripts/test-fotos-mortas.js
const assert = require('node:assert/strict');
const { conferirCard, retirarFotosMortas, morto } = require('../src/services/fotosMortas');

let ok = 0;
const t = async (nome, fn) => { await fn(); ok++; console.log('ok -', nome); };

function dbFalso(produtos = []) {
  const db = { updates: [], merges: [] };
  db.$queryRawUnsafe = async () => produtos;
  db.$executeRawUnsafe = async (sql, ...args) => {
    if (/SET "imageUrl"/.test(sql)) { db.updates.push(args); return 1; }
    db.merges.push(args); return 1; // mergeAiContext
  };
  db.product = { findUnique: async () => null, update: async () => null };
  return db;
}
const agora = new Date('2026-11-24T15:00:00Z');
const duasHorasAntes = new Date(agora.getTime() - 2 * 3600 * 1000).toISOString();
const suspeito = (...urls) => ({ fotosLinksSuspeitos: Object.fromEntries(urls.map((u) => [u, duasHorasAntes])) });

(async () => {
  await t('só 404 e 410 contam como morto', () => {
    assert.equal(morto(404), true); assert.equal(morto(410), true);
    for (const s of [null, 200, 206, 301, 403, 429, 500, 503]) assert.equal(morto(s), false, String(s));
  });

  await t('1º 404 só marca suspeito; não retira nada', async () => {
    const db = dbFalso();
    const p = { id: 'p0', imageUrl: 'https://a/1.jpg', imageUrls: ['https://morta/2.jpg'] };
    const r = await conferirCard(db, p, { agora, checar: async (u) => (u.includes('morta') ? 404 : 200) });
    assert.deepEqual(r, []);
    assert.equal(db.updates.length, 0);
    assert.deepEqual(JSON.parse(db.merges[0][1]).fotosLinksSuspeitos, { 'https://morta/2.jpg': agora.toISOString() });
  });

  await t('2º 404 com menos de 1 hora ainda não retira', async () => {
    const db = dbFalso();
    const meiaHora = new Date(agora.getTime() - 30 * 60 * 1000).toISOString();
    const p = { id: 'p0b', imageUrl: 'https://a/1.jpg', imageUrls: ['https://morta/2.jpg'], aiContext: { fotosLinksSuspeitos: { 'https://morta/2.jpg': meiaHora } } };
    const r = await conferirCard(db, p, { agora, checar: async (u) => (u.includes('morta') ? 404 : 200) });
    assert.deepEqual(r, []);
    assert.equal(db.updates.length, 0);
    assert.equal(JSON.parse(db.merges[0][1]).fotosLinksSuspeitos['https://morta/2.jpg'], meiaHora);
  });

  await t('suspeito que voltou a responder 200 deixa de ser suspeito', async () => {
    const db = dbFalso();
    const p = { id: 'p0c', imageUrl: 'https://a/1.jpg', imageUrls: [], aiContext: suspeito('https://a/1.jpg') };
    await conferirCard(db, p, { agora, checar: async () => 200 });
    assert.deepEqual(JSON.parse(db.merges[0][1]).fotosLinksSuspeitos, {});
  });

  await t('2º 404 depois de 1 hora: retira só o link morto e mantém a ordem das outras fotos', async () => {
    const db = dbFalso();
    const p = { id: 'p1', imageUrl: 'https://a/1.jpg', imageUrls: ['https://a/2.jpg', 'https://morta/3.jpg', 'data:image/jpeg;base64,AAA', 'https://a/5.jpg'], aiContext: suspeito('https://morta/3.jpg') };
    const r = await conferirCard(db, p, { agora, checar: async (u) => (u.includes('morta') ? 404 : 200) });
    assert.deepEqual(r, ['https://morta/3.jpg']);
    assert.equal(db.updates.length, 1);
    const [id, principal, galeria, evid, antesPrincipal, antesGaleria] = db.updates[0];
    assert.equal(id, 'p1');
    assert.equal(principal, 'https://a/1.jpg');
    assert.deepEqual(JSON.parse(galeria), ['https://a/2.jpg', 'data:image/jpeg;base64,AAA', 'https://a/5.jpg']);
    assert.deepEqual(JSON.parse(evid).urls, ['https://morta/3.jpg']);
    assert.equal(antesPrincipal, 'https://a/1.jpg'); // trava atômica: confere o que foi lido
    assert.equal(JSON.parse(antesGaleria).length, 4);
  });

  await t('principal morta: a próxima foto vira a principal', async () => {
    const db = dbFalso();
    const p = { id: 'p2', imageUrl: 'https://morta/1.jpg', imageUrls: ['https://a/2.jpg', 'https://a/3.jpg'], aiContext: suspeito('https://morta/1.jpg') };
    await conferirCard(db, p, { agora, checar: async (u) => (u.includes('morta') ? 410 : 200) });
    const [, principal, galeria] = db.updates[0];
    assert.equal(principal, 'https://a/2.jpg');
    assert.deepEqual(JSON.parse(galeria), ['https://a/3.jpg']);
  });

  await t('erro de rede, 403 e 500 não retiram nada', async () => {
    const db = dbFalso();
    const p = { id: 'p3', imageUrl: 'https://x/1.jpg', imageUrls: ['https://y/2.jpg', 'https://z/3.jpg'], aiContext: suspeito('https://x/1.jpg', 'https://y/2.jpg', 'https://z/3.jpg') };
    const st = { 'https://x/1.jpg': null, 'https://y/2.jpg': 403, 'https://z/3.jpg': 500 };
    const r = await conferirCard(db, p, { agora, checar: async (u) => st[u] });
    assert.deepEqual(r, []);
    assert.equal(db.updates.length, 0);
    assert.equal(db.merges.length, 1); // só marca a data da conferência
  });

  await t('card conferido há menos de 1 dia é pulado; limite de links respeitado', async () => {
    const ontemCedo = new Date(agora.getTime() - 2 * 3600 * 1000).toISOString();
    const db = dbFalso([
      { id: 'a', imageUrl: 'https://a/1.jpg', imageUrls: [], conferido: ontemCedo },
      { id: 's', imageUrl: 'https://s/1.jpg', imageUrls: [], conferido: new Date(agora.getTime() - 30 * 60 * 1000).toISOString(), suspeito: true },
      { id: 'b', imageUrl: 'https://b/1.jpg', imageUrls: ['https://b/2.jpg'], conferido: null },
      { id: 'c', imageUrl: 'https://c/1.jpg', imageUrls: ['https://c/2.jpg'], conferido: null },
    ]);
    const vistos = [];
    const r = await retirarFotosMortas(db, { agora, limiteLinks: 3, checar: async (u) => { vistos.push(u); return 200; } });
    assert.equal(r.cards, 1);
    assert.deepEqual(vistos, ['https://b/1.jpg', 'https://b/2.jpg']);
  });

  await t('desliga com CUIDADOR_FOTO_MORTA=0', async () => {
    process.env.CUIDADOR_FOTO_MORTA = '0';
    const r = await retirarFotosMortas(dbFalso([{ id: 'x', imageUrl: 'https://x/1.jpg', imageUrls: [] }]), { agora, checar: async () => 404 });
    delete process.env.CUIDADOR_FOTO_MORTA;
    assert.equal(r.cards, 0);
  });

  console.log(`\n${ok} testes ok`);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
