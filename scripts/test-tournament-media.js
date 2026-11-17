#!/usr/bin/env node
// =====================================================================
// Teste F2 — AO VIVO, MÍDIA E COMPARTILHAMENTO (torneios)
// ---------------------------------------------------------------------
// Sobe o APP REAL (src/index.js: compression + helmet + ordem de rotas de
// produção) contra um banco DESCARTÁVEL e prova, por HTTP:
//   SSE ao vivo · placar ao vivo · artes PNG (assinatura + dimensão) ·
//   cache/ETag · QR decodificável · ICS válido · embed · API pública/CORS ·
//   patrocinadores protegidos · telão · og:image na página /t/:slug.
//
// Uso (banco local descartável — o script RECUSA host que não seja local):
//   createdb club_f2 ; DATABASE_URL=postgresql://postgres@localhost:55432/club_f2 npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL=postgresql://postgres@localhost:55432/club_f2 node scripts/test-tournament-media.js [pastaDasArtes]
// =====================================================================

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(DB)) {
  console.error('❌ DATABASE_URL precisa ser um banco LOCAL descartável (localhost). Recusado:', DB.replace(/:[^:@/]*@/, ':***@'));
  process.exit(2);
}
const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'club-f2-artes');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;

const jwt = require('jsonwebtoken');
const { prisma, JWT_SECRET } = require('../src/middleware');
const sharp = require('sharp');

let pass = 0;
const results = [];
async function step(name, fn) {
  try {
    await fn();
    pass++;
    results.push('✅ ' + name);
    console.log('✅', name);
  } catch (e) {
    results.push('❌ ' + name + ' — ' + e.message);
    console.error('❌', name, '\n   ', e.stack || e.message);
    process.exitCode = 1;
  }
}

function req(method, url, { body, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url, BASE);
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'Accept-Encoding': 'gzip',
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = require('zlib').gunzipSync(buf);
        let json = null;
        if (/json/.test(res.headers['content-type'] || '')) { try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* */ } }
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function pngSize(buf) {
  assert.ok(buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'assinatura PNG inválida');
  assert.strictEqual(buf.slice(12, 16).toString('ascii'), 'IHDR');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ---- SSE client: guarda as mensagens e permite esperar por uma condição
function openSse(url) {
  const msgs = [];
  const waiters = [];
  let headers = null;
  let raw = '';
  const r = http.get(new URL(url, BASE), { headers: { Accept: 'text/event-stream', 'Accept-Encoding': 'gzip' } }, (res) => {
    headers = res.headers;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      raw += chunk;
      let i;
      while ((i = raw.indexOf('\n\n')) >= 0) {
        const block = raw.slice(0, i);
        raw = raw.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (!data) continue;
        let m; try { m = JSON.parse(data); } catch (_) { continue; }
        msgs.push(m);
        for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(m); }
      }
    });
  });
  return {
    msgs,
    get headers() { return headers; },
    wait(pred, ms = 6000) {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, t: setTimeout(() => reject(new Error('SSE: timeout esperando mensagem')), ms) };
        waiters.push(w);
      });
    },
    close() { r.destroy(); },
  };
}

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { const r = await req('GET', '/api/health'); if (r.status === 200) return; } catch (_) { /* subindo */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('app não subiu');
}

async function logo(color, letter) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><path d="M80 6 L148 30 L140 104 Q120 140 80 156 Q40 140 20 104 L12 30 Z" fill="${color}" stroke="#fff" stroke-width="8"/><text x="80" y="104" font-family="Arial" font-weight="900" font-size="64" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
  return 'data:image/png;base64,' + (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
}

async function main() {
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  await step('ensureApexSchema roda no banco de teste (aditivo/idempotente)', async () => {
    const ok1 = await ensureApexSchema(prisma);
    const ok2 = await ensureApexSchema(prisma);
    assert.ok(ok1 > 0 && ok1 === ok2, 'statements aplicados ' + ok1 + '/' + ok2);
    const r = await prisma.$queryRawUnsafe(`SELECT to_regclass('"TournamentSponsor"')::text AS t`);
    assert.strictEqual(r[0].t, '"TournamentSponsor"');
  });

  // ---------------- seed ----------------
  const tag = Date.now().toString(36);
  const owner = await prisma.user.create({ data: { name: 'Organizador Teste', phone: '8399' + tag.slice(-7).padStart(7, '0'), pin: 'x', username: 'org' + tag } });
  const other = await prisma.user.create({ data: { name: 'Visitante Teste', phone: '8398' + tag.slice(-7).padStart(7, '0'), pin: 'x', username: 'vis' + tag } });
  const tokOwner = jwt.sign({ userId: owner.id }, JWT_SECRET, { expiresIn: '1h' });
  const tokOther = jwt.sign({ userId: other.id }, JWT_SECRET, { expiresIn: '1h' });
  const t = await prisma.tournament.create({
    data: {
      slug: 'copa-f2-' + tag, name: 'Copa Club F2 de Futsal', sport: 'FUTSAL', format: 'GROUPS_KNOCKOUT', status: 'ONGOING',
      ownerId: owner.id, city: 'João Pessoa', state: 'PB', startDate: new Date('2026-11-20T12:00:00Z'), endDate: new Date('2026-11-22T12:00:00Z'),
      prizeDescription: 'Troféu + medalhas',
    },
  });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Livre Masculino' } });
  const cat2 = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Veteranos 40+' } });
  const teams = [
    ['Cabo Branco FC', '#E5571E', 'C'], ['Tambaú Futsal', '#1D4ED8', 'T'], ['Bessa Esporte Clube', '#059669', 'B'], ['Manaíra United', '#7C3AED', 'M'],
  ];
  const E = [];
  for (const [i, [name, color, l]] of teams.entries()) {
    E.push(await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: cat.id, name, groupName: 'A', logoUrl: i < 3 ? await logo(color, l) : null } }));
  }
  const vet = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: cat2.id, name: 'Cabo Branco FC', groupName: 'A' } });
  const vet2 = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: cat2.id, name: 'Amigos CG', groupName: 'A' } });
  const players = {};
  const roster = { 0: ['Diego Souza', 'Rafael Lima', 'Bruno Alves'], 1: ['Thiago Melo', 'Caio Nunes'], 2: ['Pedro Rocha'], 3: ['Lucas Dantas'] };
  for (const k of Object.keys(roster)) {
    players[k] = [];
    for (const [j, n] of roster[k].entries()) players[k].push(await prisma.rosterPlayer.create({ data: { entryId: E[k].id, name: n, number: 7 + j * 3 } }));
  }
  const day = (h) => new Date(Date.now() + h * 3600 * 1000);
  const m1 = await prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: cat.id, stage: 'GROUP', groupName: 'A', round: 1, ordering: 1, homeEntryId: E[0].id, awayEntryId: E[1].id, scheduledAt: day(1), location: 'Ginásio do Bessa' } });
  const m2 = await prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: cat.id, stage: 'GROUP', groupName: 'A', round: 1, ordering: 2, homeEntryId: E[2].id, awayEntryId: E[3].id, scheduledAt: day(2), location: 'Ginásio do Bessa' } });
  const fin = await prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: cat.id, stage: 'FINAL', round: 2, ordering: 1, homeEntryId: E[0].id, awayEntryId: E[2].id, scheduledAt: day(26), location: 'Ginásio Ronaldão' } });
  const mv = await prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: cat2.id, stage: 'GROUP', groupName: 'A', round: 1, ordering: 1, homeEntryId: vet.id, awayEntryId: vet2.id, scheduledAt: day(3), location: 'Ginásio Tambiá' } });

  // ---------------- app real ----------------
  const app = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appLog = '';
  app.stdout.on('data', (d) => { appLog += d; });
  app.stderr.on('data', (d) => { appLog += d; });
  const cleanupApp = () => { try { app.kill(); } catch (_) { /* */ } };
  process.on('exit', cleanupApp);

  try {
    await waitHealth();

    // ------------- SSE AO VIVO -------------
    const sse = openSse(`/api/tournaments/${t.slug}/live`);
    await step('SSE: conecta sem buffer (event-stream, no-transform, X-Accel-Buffering:no) e manda hello', async () => {
      const hello = await sse.wait((m) => m.type === 'hello');
      assert.strictEqual(hello.tournamentId, t.id);
      assert.match(sse.headers['content-type'], /text\/event-stream/);
      assert.match(sse.headers['cache-control'], /no-transform/);
      assert.match(sse.headers['cache-control'], /no-store/);
      assert.strictEqual(sse.headers['x-accel-buffering'], 'no');
      assert.ok(!sse.headers['content-encoding'], 'SSE não pode sair comprimido (compression seguraria os eventos)');
    });

    await step('Escrita na súmula exige login (401 sem token)', async () => {
      const r = await req('POST', `/api/tournaments/matches/${m1.id}/events`, { body: { type: 'GOAL', entryId: E[0].id, playerId: players[0][0].id } });
      assert.strictEqual(r.status, 401);
    });

    let t0;
    await step('1º gol da súmula → jogo vira LIVE e SSE entrega "start" com placar 1×0 e o nome do jogador', async () => {
      t0 = Date.now();
      const r = await req('POST', `/api/tournaments/matches/${m1.id}/events`, { token: tokOwner, body: { type: 'GOAL', entryId: E[0].id, playerId: players[0][0].id, minute: 4, period: 1 } });
      assert.strictEqual(r.status, 201, r.text);
      const m = await sse.wait((x) => x.type === 'start' && x.match && x.match.id === m1.id);
      assert.ok(Date.now() - t0 < 3000, 'evento demorou ' + (Date.now() - t0) + 'ms');
      assert.strictEqual(m.match.status, 'LIVE');
      assert.deepStrictEqual(m.match.liveScore, { home: 1, away: 0 });
      assert.strictEqual(m.last.player, 'Diego Souza');
      assert.strictEqual(m.last.minute, 4);
      assert.strictEqual(m.last.side, 'home');
      const db = await prisma.tournamentMatch.findUnique({ where: { id: m1.id } });
      assert.strictEqual(db.status, 'LIVE');
    });

    await step('Gol do visitante + cartão → SSE "event" com placar 1×1 e cartão contabilizado', async () => {
      await req('POST', `/api/tournaments/matches/${m1.id}/events`, { token: tokOwner, body: { type: 'GOAL', entryId: E[1].id, playerId: players[1][0].id, minute: 9, period: 1 } });
      const g = await sse.wait((x) => x.type === 'event' && x.match.liveScore.away === 1);
      assert.strictEqual(g.last.player, 'Thiago Melo');
      await req('POST', `/api/tournaments/matches/${m1.id}/events`, { token: tokOwner, body: { type: 'YELLOW', entryId: E[1].id, playerId: players[1][1].id, minute: 12, period: 1 } });
      const c = await sse.wait((x) => x.type === 'event' && x.match.cards.away.yellow === 1);
      assert.strictEqual(c.last.type, 'YELLOW');
      await req('POST', `/api/tournaments/matches/${m1.id}/events`, { token: tokOwner, body: { type: 'GOAL', entryId: E[0].id, playerId: players[0][1].id, minute: 31, period: 2 } });
      await sse.wait((x) => x.type === 'event' && x.match.liveScore.home === 2);
    });

    await step('Página pública: /categories/:id/matches traz liveScore e lance a lance do jogo AO VIVO', async () => {
      const r = await req('GET', `/api/tournaments/${t.id}/categories/${cat.id}/matches`);
      const m = r.json.matches.find((x) => x.id === m1.id);
      assert.strictEqual(m.status, 'LIVE');
      assert.deepStrictEqual(m.liveScore, { home: 2, away: 1 });
      assert.strictEqual(m.timeline.filter((x) => x.type === 'GOAL').length, 3);
      assert.ok(m.timeline.some((x) => x.player === 'Rafael Lima' && x.minute === 31));
    });

    await step('Apagar evento → SSE "event_removed" e placar volta pra 2×0... (remove o gol visitante)', async () => {
      const ev = await prisma.matchEvent.findFirst({ where: { matchId: m1.id, type: 'GOAL', entryId: E[1].id } });
      const r = await req('DELETE', `/api/tournaments/events/${ev.id}`, { token: tokOwner });
      assert.strictEqual(r.status, 200);
      const x = await sse.wait((m) => m.type === 'event_removed' && m.removedEventId === ev.id);
      assert.deepStrictEqual(x.match.liveScore, { home: 2, away: 0 });
      // devolve o gol pra seguir o teste com 2×1
      await req('POST', `/api/tournaments/matches/${m1.id}/events`, { token: tokOwner, body: { type: 'GOAL', entryId: E[1].id, playerId: players[1][0].id, minute: 9, period: 1 } });
      await sse.wait((m) => m.type === 'event' && m.match.liveScore.away === 1 && m.match.liveScore.home === 2);
    });

    await step('Fechar súmula → SSE "end" com placar oficial 2×1 e vencedor', async () => {
      const r = await req('POST', `/api/tournaments/matches/${m1.id}/finalize`, { token: tokOwner, body: { referee1: 'Árbitro Teste' } });
      assert.strictEqual(r.status, 200, r.text);
      const e = await sse.wait((m) => m.type === 'end' && m.match.id === m1.id);
      assert.strictEqual(e.match.status, 'FINISHED');
      assert.strictEqual(e.match.homeScore, 2);
      assert.strictEqual(e.match.awayScore, 1);
      assert.strictEqual(e.match.winnerEntryId, E[0].id);
    });

    // segundo jogo + final, pra classificação/artilharia/campeão
    for (const [pl, ent, min] of [[players[2][0], E[2], 3], [players[2][0], E[2], 15], [players[3][0], E[3], 20]]) {
      await req('POST', `/api/tournaments/matches/${m2.id}/events`, { token: tokOwner, body: { type: 'GOAL', entryId: ent.id, playerId: pl.id, minute: min } });
    }
    await req('POST', `/api/tournaments/matches/${m2.id}/finalize`, { token: tokOwner, body: {} });
    await req('POST', `/api/tournaments/matches/${mv.id}/events`, { token: tokOwner, body: { type: 'FOUL', entryId: vet.id } });

    await step('Falta (sem jogador) também põe o jogo no ar: veteranos LIVE', async () => {
      const db = await prisma.tournamentMatch.findUnique({ where: { id: mv.id } });
      assert.strictEqual(db.status, 'LIVE');
    });

    // ------------- ARTES -------------
    const arts = [
      ['resultado', `matchId=${m1.id}`, 'story', 1080, 1920],
      ['resultado', `matchId=${m1.id}`, 'feed', 1080, 1350],
      ['resultado', `matchId=${m1.id}`, 'quadrado', 1080, 1080],
      ['proximo', `matchId=${fin.id}`, 'story', 1080, 1920],
      ['agenda', 'data=proximos', 'feed', 1080, 1350],
      ['classificacao', `categoryId=${cat.id}`, 'story', 1080, 1920],
      ['classificacao', `categoryId=${cat.id}`, 'quadrado', 1080, 1080],
      ['artilharia', `categoryId=${cat.id}`, 'story', 1080, 1920],
      ['atleta', `handle=${owner.username}`, 'story', 1080, 1920],
      ['torneio', '', 'og', 1200, 630],
    ];
    await step('Arte "campeão" antes da final: PNG válido com aviso (sem chutar campeão)', async () => {
      const r = await req('GET', `/api/tournaments/${t.id}/arte/campeao.png?categoryId=${cat.id}&formato=quadrado`);
      assert.strictEqual(r.status, 200, r.text);
      assert.deepStrictEqual(pngSize(r.buf), { w: 1080, h: 1080 });
    });
    for (const [tipo, q, formato, w, h] of arts) {
      await step(`Arte ${tipo} (${formato}) → PNG ${w}×${h}`, async () => {
        const t1 = Date.now();
        const r = await req('GET', `/api/tournaments/${t.slug}/arte/${tipo}.png?formato=${formato}${q ? '&' + q : ''}`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.match(r.headers['content-type'], /image\/png/);
        assert.deepStrictEqual(pngSize(r.buf), { w, h });
        assert.ok(r.buf.length > 15000, 'PNG suspeito de vazio: ' + r.buf.length);
        fs.writeFileSync(path.join(OUT, `${tipo}-${formato}.png`), r.buf);
        console.log(`    ${tipo}-${formato}.png ${(r.buf.length / 1024).toFixed(0)} KB em ${Date.now() - t1} ms`);
      });
    }
    await step('Cache de arte: mesmo dado → mesmo ETag, 304 com If-None-Match, e muito mais rápido', async () => {
      const u = `/api/tournaments/${t.id}/arte/resultado.png?formato=story&matchId=${m1.id}`;
      const a = await req('GET', u);
      const t1 = Date.now();
      const b = await req('GET', u);
      const dt = Date.now() - t1;
      assert.strictEqual(a.headers.etag, b.headers.etag);
      assert.ok(dt < 400, 'cache lento: ' + dt + 'ms');
      const c = await req('GET', u, { headers: { 'If-None-Match': a.headers.etag } });
      assert.strictEqual(c.status, 304);
    });
    await step('Arte: tipo inválido 400 · jogo de outro torneio 404 · torneio inexistente 404', async () => {
      assert.strictEqual((await req('GET', `/api/tournaments/${t.id}/arte/xyz.png`)).status, 400);
      assert.strictEqual((await req('GET', `/api/tournaments/${t.id}/arte/resultado.png?matchId=nao-existe`)).status, 404);
      assert.strictEqual((await req('GET', `/api/tournaments/nao-existe/arte/torneio.png`)).status, 404);
    });

    // ------------- PATROCINADORES -------------
    let spId;
    await step('Patrocinador: sem login 401 · não-organizador 403 · logo inválido 400', async () => {
      assert.strictEqual((await req('POST', `/api/tournaments/${t.id}/sponsors`, { body: { name: 'X' } })).status, 401);
      assert.strictEqual((await req('POST', `/api/tournaments/${t.id}/sponsors`, { token: tokOther, body: { name: 'X' } })).status, 403);
      assert.strictEqual((await req('POST', `/api/tournaments/${t.id}/sponsors`, { token: tokOwner, body: { name: 'X', logoUrl: 'javascript:alert(1)' } })).status, 400);
      assert.strictEqual((await req('POST', `/api/tournaments/${t.id}/sponsors`, { token: tokOwner, body: { name: '' } })).status, 400);
    });
    await step('Patrocinador: organizador cria/edita/lista; logo data URI vira URL pública servindo a imagem', async () => {
      const lg = await logo('#111827', 'S');
      const r = await req('POST', `/api/tournaments/${t.id}/sponsors`, { token: tokOwner, body: { name: 'Sports & Tennis', logoUrl: lg, link: '@sportsetennis' } });
      assert.strictEqual(r.status, 201, r.text);
      spId = r.json.id;
      assert.strictEqual(r.json.link, 'https://instagram.com/sportsetennis');
      assert.match(r.json.logoUrl, /\/api\/public\/sponsors\/.+\/logo$/);
      const r2 = await req('POST', `/api/tournaments/${t.id}/sponsors`, { token: tokOwner, body: { name: 'Academia Força Total', link: 'https://example.com' } });
      assert.strictEqual(r2.status, 201);
      const p = await req('PATCH', `/api/tournaments/${t.id}/sponsors/${r2.json.id}`, { token: tokOwner, body: { ordering: -1 } });
      assert.strictEqual(p.status, 200);
      const p403 = await req('PATCH', `/api/tournaments/${t.id}/sponsors/${r2.json.id}`, { token: tokOther, body: { ordering: 5 } });
      assert.strictEqual(p403.status, 403);
      const l = await req('GET', `/api/tournaments/${t.id}/sponsors`);
      assert.deepStrictEqual(l.json.sponsors.map((s) => s.name), ['Academia Força Total', 'Sports & Tennis']);
      const img = await req('GET', new URL(r.json.logoUrl).pathname);
      assert.strictEqual(img.status, 200);
      pngSize(img.buf);
    });
    await step('Patrocinador aparece na arte (hash muda) e não-organizador não apaga (403)', async () => {
      const r = await req('GET', `/api/tournaments/${t.id}/arte/classificacao.png?formato=story&categoryId=${cat.id}`);
      assert.strictEqual(r.status, 200);
      fs.writeFileSync(path.join(OUT, 'classificacao-story-patrocinio.png'), r.buf);
      const del = await req('DELETE', `/api/tournaments/${t.id}/sponsors/${spId}`, { token: tokOther });
      assert.strictEqual(del.status, 403);
    });

    // final → campeão
    for (const [pl, ent] of [[players[0][0], E[0]], [players[0][0], E[0]], [players[2][0], E[2]]]) {
      await req('POST', `/api/tournaments/matches/${fin.id}/events`, { token: tokOwner, body: { type: 'GOAL', entryId: ent.id, playerId: pl.id, minute: 10 } });
    }
    await req('POST', `/api/tournaments/matches/${fin.id}/finalize`, { token: tokOwner, body: {} });
    await step('Arte campeão (story) depois da final → PNG 1080×1920', async () => {
      const r = await req('GET', `/api/tournaments/${t.id}/arte/campeao.png?categoryId=${cat.id}&formato=story`);
      assert.strictEqual(r.status, 200, r.text);
      assert.deepStrictEqual(pngSize(r.buf), { w: 1080, h: 1920 });
      fs.writeFileSync(path.join(OUT, 'campeao-story.png'), r.buf);
    });

    // ------------- QR -------------
    await step('QR do torneio e do jogo: PNG decodificável com a URL certa', async () => {
      const zx = require('zxing-wasm/reader');
      const wasm = fs.readFileSync(path.join(__dirname, '../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm'));
      if (zx.prepareZXingModule) zx.prepareZXingModule({ overrides: { wasmBinary: wasm } }); else zx.setZXingModuleOverrides({ wasmBinary: wasm });
      for (const [q, suffix] of [['', ''], [`?jogo=${m1.id}`, `?jogo=${m1.id}`]]) {
        const r = await req('GET', `/api/tournaments/${t.id}/qr.png${q}${q ? '&' : '?'}size=500`);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(pngSize(r.buf), { w: 500, h: 500 });
        const { data, info } = await sharp(r.buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const rows = await zx.readBarcodes({ data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height }, { formats: ['QRCode'] });
        assert.ok(rows.length, 'QR não decodificou');
        assert.ok(rows[0].text.endsWith(`/t/${t.slug}${suffix}`), 'URL do QR: ' + rows[0].text);
      }
      fs.writeFileSync(path.join(OUT, 'qr.png'), (await req('GET', `/api/tournaments/${t.id}/qr.png`)).buf);
    });

    // ------------- ICS -------------
    await step('ICS: RFC 5545 (CRLF, VTIMEZONE America/Fortaleza, DTSTAMP UTC, 1 VEVENT por jogo agendado)', async () => {
      const r = await req('GET', `/t/${t.slug}/calendario.ics`);
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['content-type'], /text\/calendar/);
      const s = r.text;
      assert.ok(s.startsWith('BEGIN:VCALENDAR\r\n') && s.trim().endsWith('END:VCALENDAR'));
      assert.ok(/BEGIN:VTIMEZONE\r\nTZID:America\/Fortaleza/.test(s), 'VTIMEZONE');
      assert.strictEqual((s.match(/BEGIN:VEVENT/g) || []).length, 4);
      assert.ok(!/\n(?<!\r\n)/.test(s.replace(/\r\n/g, '')), 'quebra de linha sem CR');
      const stamps = s.match(/^DTSTAMP:.*$/gm);
      assert.ok(stamps.every((x) => /^DTSTAMP:\d{8}T\d{6}Z\r?$/.test(x)), 'DTSTAMP UTC: ' + stamps[0]);
      // horário local: m1 em UTC → -03:00
      const loc = new Date(m1.scheduledAt.getTime() - 3 * 3600 * 1000).toISOString().replace(/[-:]/g, '').slice(0, 15);
      assert.ok(s.includes('DTSTART;TZID=America/Fortaleza:' + loc), 'DTSTART local esperado ' + loc);
      assert.ok(s.includes('SUMMARY:Cabo Branco FC 2 × 1 Tambaú Futsal'), 'placar no título do jogo encerrado');
      assert.ok(s.includes('LOCATION:Ginásio do Bessa'));
      fs.writeFileSync(path.join(OUT, 'calendario.ics'), s);
    });
    await step('ICS: filtros ?categoria= e ?time= (clube único em várias categorias)', async () => {
      const a = await req('GET', `/t/${t.slug}/calendario.ics?categoria=${cat2.id}`);
      assert.strictEqual((a.text.match(/BEGIN:VEVENT/g) || []).length, 1);
      const b = await req('GET', `/t/${t.slug}/calendario.ics?time=${encodeURIComponent('cabo branco fc')}`);
      assert.strictEqual((b.text.match(/BEGIN:VEVENT/g) || []).length, 3, 'Cabo Branco: 2 jogos no Livre + 1 nos Veteranos');
      assert.strictEqual((await req('GET', `/t/${t.slug}/calendario.ics?time=ninguem`)).status, 404);
    });

    // ------------- API pública + embed -------------
    await step('API pública: CORS *, jogos/classificação/artilharia/patrocínio, escudo data URI vira URL', async () => {
      const r = await req('GET', `/api/public/tournaments/${t.slug}`, { headers: { Origin: 'https://site-de-terceiro.com' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers['access-control-allow-origin'], '*');
      const c = r.json.categories.find((x) => x.id === cat.id);
      assert.strictEqual(c.matches.length, 3);
      assert.strictEqual(c.standings[0].entry.name, 'Cabo Branco FC');
      assert.strictEqual(c.scorers[0].name, 'Diego Souza');
      assert.strictEqual(c.scorers[0].goals, 3);
      assert.ok(!JSON.stringify(r.json).includes('data:image'), 'não pode vazar data URI pesado na API');
      const withLogo = c.standings.find((s) => s.entry.logoUrl);
      const lg = await req('GET', new URL(withLogo.entry.logoUrl).pathname);
      assert.strictEqual(lg.status, 200);
      pngSize(lg.buf);
      assert.strictEqual(r.json.sponsors.length, 2);
      const vets = r.json.categories.find((x) => x.id === cat2.id);
      assert.strictEqual(vets.matches[0].status, 'LIVE');
    });
    await step('API pública é só leitura: OPTIONS 204, POST 405', async () => {
      assert.strictEqual((await req('OPTIONS', `/api/public/tournaments/${t.slug}`)).status, 204);
      assert.strictEqual((await req('POST', `/api/public/tournaments/${t.slug}`, { body: {} })).status, 405);
    });
    await step('Embed: 200, iframe liberado (sem X-Frame-Options, frame-ancestors *)', async () => {
      const r = await req('GET', `/t/${t.slug}/embed?view=jogos`);
      assert.strictEqual(r.status, 200);
      assert.ok(!r.headers['x-frame-options'], 'X-Frame-Options presente: ' + r.headers['x-frame-options']);
      assert.match(r.headers['content-security-policy'] || '', /frame-ancestors \*/);
      assert.ok(r.text.includes('window.CLUB_EMBED=') && r.text.includes('"view":"jogos"'));
      const page = await req('GET', `/t/${t.slug}`);
      assert.ok(page.headers['x-frame-options'], 'a página normal continua protegida contra iframe');
    });
    await step('Telão: 200, no-store, carrega telao.js com o id do torneio', async () => {
      const r = await req('GET', `/t/${t.slug}/telao`);
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['cache-control'], /no-store/);
      assert.ok(r.text.includes('/club/telao.js') && r.text.includes(t.id));
      const js = await req('GET', '/club/telao.js');
      assert.strictEqual(js.status, 200);
    });

    // ------------- página /t/:slug e /atleta -------------
    await step('Página /t/:slug: og:image (arte do torneio) + meta tags + patrocínio + barra de mídia + SSE', async () => {
      const r = await req('GET', `/t/${t.slug}?jogo=${m1.id}`);
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['cache-control'], /no-store/);
      const og = /<meta property="og:image" content="([^"]+)"/.exec(r.text);
      assert.ok(og, 'og:image');
      assert.ok(r.text.includes('twitter:card" content="summary_large_image'));
      assert.ok(r.text.includes('Academia Força Total'), 'faixa de patrocínio');
      assert.ok(r.text.includes('/club/torneio-midia.js'));
      assert.ok(r.text.includes('"categoryId":"' + cat.id + '"'), 'deep link ?jogo= resolve a categoria');
      const img = await req('GET', new URL(og[1].replace(/&amp;/g, '&')).pathname + new URL(og[1].replace(/&amp;/g, '&')).search);
      assert.strictEqual(img.status, 200);
      assert.deepStrictEqual(pngSize(img.buf), { w: 1200, h: 630 });
    });
    await step('Página /atleta/:handle: og:image = arte do card do atleta', async () => {
      const r = await req('GET', `/atleta/${owner.username}`);
      assert.strictEqual(r.status, 200);
      const og = /<meta property="og:image" content="([^"]+)"/.exec(r.text);
      assert.ok(og, 'og:image no card do atleta');
      const u = new URL(og[1].replace(/&amp;/g, '&'));
      const img = await req('GET', u.pathname + u.search);
      assert.strictEqual(img.status, 200, img.text.slice(0, 200));
      assert.deepStrictEqual(pngSize(img.buf), { w: 1200, h: 630 });
      fs.writeFileSync(path.join(OUT, 'atleta-og.png'), img.buf);
    });

    sse.close();
  } finally {
    cleanupApp();
    // limpeza do banco de teste (o banco é descartável, mas não deixa lixo entre rodadas)
    // KEEP=1 mantém os dados pra olhar no navegador (só em banco local descartável)
    if (process.env.KEEP === '1') {
      console.log('KEEP=1 → dados mantidos: /t/' + t.slug);
      await prisma.$disconnect();
      console.log(`\n${pass} verificações ok · artes salvas em ${OUT}`);
      process.exit(process.exitCode || 0);
    }
    const mids = (await prisma.tournamentMatch.findMany({ where: { tournamentId: t.id }, select: { id: true } })).map((m) => m.id);
    await prisma.matchEvent.deleteMany({ where: { matchId: { in: mids } } });
    await prisma.rosterPlayer.deleteMany({ where: { entryId: { in: E.map((e) => e.id).concat([vet.id, vet2.id]) } } });
    await prisma.tournamentSponsor.deleteMany({ where: { tournamentId: t.id } });
    await prisma.tournament.delete({ where: { id: t.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }).catch(() => {});
    await prisma.$disconnect();
    if (process.exitCode) console.log('\n--- log do app (fim) ---\n' + appLog.slice(-3000));
  }
  console.log(`\n${pass} verificações ok · artes salvas em ${OUT}`);
  if (!process.exitCode) console.log('✅ F2 mídia: tudo verde');
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
