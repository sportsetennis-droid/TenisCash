// =====================================================================
// Testes das MEDALHAS DIGITAIS.
//   node scripts/test-medals.js                 → parte A (sem banco)
//   MEDAL_TEST_DATABASE_URL=postgres://… node scripts/test-medals.js
//                                               → A + B (fluxo real num banco DESCARTÁVEL)
// ⚠ A parte B escreve no banco informado: use SÓ banco de teste, nunca produção.
// =====================================================================
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste-medalhas';
if (process.env.MEDAL_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.MEDAL_TEST_DATABASE_URL;
const assert = require('assert');
const crypto = require('crypto');
const mc = require('../src/services/medalCrypto');
const MV = require('../public/medalhas/medal-verify.js');
const Tpl = require('../public/medalhas/medal-template.js');
const Card = require('../public/medalhas/medal-card.js');
const Shelf = require('../public/medalhas/medal-shelf.js');

let pass = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass += 1; results.push('  ✓ ' + name); } catch (e) { results.push('  ✗ ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e)); process.exitCode = 1; }
}

async function partA() {
  console.log('A) núcleo, template e carta (sem banco)');
  const k = mc.generateIssuerKeys();
  const cred = { '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:uuid:' + crypto.randomUUID(), type: ['VerifiableCredential', 'OpenBadgeCredential'], issuer: { id: k.did, type: ['Profile'], name: 'Org' }, validFrom: new Date().toISOString(), credentialSubject: { type: ['AchievementSubject'] } };
  const jwt = mc.signCredentialJwt(cred, k);
  await t('did:key Ed25519 (z6Mk…) e ida/volta da chave', () => { assert.ok(k.did.startsWith('did:key:z6Mk')); assert.strictEqual(mc.didKeyFromRaw(mc.rawFromDidKey(k.did)), k.did); });
  await t('assina e verifica no servidor', () => assert.ok(mc.verifyCredentialJwt(jwt).valid));
  await t('verificador do navegador: WebCrypto e JS puro', async () => { assert.ok((await MV.verify(jwt)).valid); assert.ok((await MV.verify(jwt, { forcePure: true })).valid); });
  await t('adulteração é recusada (nome trocado no payload)', async () => {
    const p = jwt.split('.'); const body = JSON.parse(mc.fromB64u(p[1])); body.issuer.name = 'Outro';
    const bad = p[0] + '.' + mc.b64u(JSON.stringify(body)) + '.' + p[2];
    assert.ok(!mc.verifyCredentialJwt(bad).valid); assert.ok(!(await MV.verify(bad)).valid); assert.ok(!(await MV.verify(bad, { forcePure: true })).valid);
  });
  await t('assinatura de OUTRO emissor é recusada (troca de did)', async () => {
    const k2 = mc.generateIssuerKeys(); const p = jwt.split('.'); const body = JSON.parse(mc.fromB64u(p[1])); body.issuer.id = k2.did; body.iss = k2.did;
    const h = JSON.parse(mc.fromB64u(p[0])); h.kid = mc.kidFor(k2.did);
    const forged = mc.b64u(JSON.stringify(h)) + '.' + mc.b64u(JSON.stringify(body)) + '.' + p[2];
    assert.ok(!(await MV.verify(forged)).valid);
  });
  await t('vetor oficial RFC 8032 (Ed25519, JS puro)', async () => {
    const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
    const r = await MV.verifyEd25519(hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'), new Uint8Array(0), hex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'), { forcePure: true });
    assert.ok(r.ok);
  });
  await t('PNG assado: credencial entra e sai igual (servidor e navegador)', () => {
    const png = require('fs').readFileSync(require('path').join(__dirname, '../public/brand/sports-tennis-icon-192.png'));
    const baked = mc.bakePng(png, jwt);
    assert.strictEqual(mc.unbakePng(baked), jwt);
    assert.strictEqual(MV.unbakePng(baked.buffer.slice(baked.byteOffset, baked.byteOffset + baked.length)), jwt);
    const b2 = Buffer.from(Card.bake(new Uint8Array(png), jwt)); assert.strictEqual(mc.unbakePng(b2), jwt);
  });
  await t('hash de identidade: CPF + sal secreto (com ou sem pontuação)', () => {
    const s = mc.newIdentitySalt();
    assert.strictEqual(mc.identityHash('123.456.789-09', s), mc.identityHash('12345678909', s));
    assert.notStrictEqual(mc.identityHash('12345678909', s), mc.identityHash('12345678909', mc.newIdentitySalt()));
  });
  await t('cofre: chave privada cifrada não abre com outro segredo', () => {
    const sealed = mc.sealSecret('x'); assert.strictEqual(mc.openSecret(sealed), 'x');
    const old = process.env.JWT_SECRET; process.env.JWT_SECRET = 'outro';
    assert.throws(() => mc.openSecret(sealed)); process.env.JWT_SECRET = old;
  });
  await t('template determinístico por evento e respeita escolhas do organizador', () => {
    const a = Tpl.generate({ name: 'Copa X', sport: 'FUTSAL' }), b = Tpl.generate({ name: 'Copa X', sport: 'FUTSAL' }), c = Tpl.generate({ name: 'Copa Y', sport: 'FUTSAL' });
    assert.deepStrictEqual(a, b); assert.notDeepStrictEqual(a.palette, c.palette);
    const d = Tpl.generate({ name: 'Copa X', primary: '#123456', font: 'anton', pattern: 'hex', shape: 'badge' });
    assert.strictEqual(d.palette.primary, '#123456'); assert.strictEqual(d.font, 'anton'); assert.strictEqual(d.pattern, 'hex'); assert.strictEqual(d.crest.shape, 'badge');
    assert.strictEqual(Tpl.generate({ name: 'Circuito Beach Tennis da Paraíba' }).crest.initials, 'CBT');
    assert.strictEqual(Tpl.generate({ name: 'x', crestImage: 'javascript:alert(1)' }).crest.image, null);
  });
  const base = { serial: 'CST-2026-000001', status: 'ACTIVE', achievement: 'PLACEMENT', distinctions: [], edition: { n: 1, total: 1 }, athlete: { name: 'Fulana de Tal' }, event: { name: 'Copa <Teste> & "Cia"', category: 'Feminino A', sport: 'TENNIS', date: '2026-11-01', location: 'JP' }, result: { score: '6/4' }, organizer: { name: 'Org', did: k.did }, verificationCode: 'AAAA-BBBB-CCCC', verifyUrl: 'https://x/v/1', qr: await require('../src/services/medals').qrOf('https://x/v/1'), design: Tpl.generate({ name: 'Copa', sport: 'TENNIS' }) };
  await t('carta: todas as variantes renderizam sem "undefined"/"NaN" e escapam texto', () => {
    const variants = [{ tier: 'GOLD', placement: 1 }, { tier: 'SILVER', placement: 2 }, { tier: 'BRONZE', placement: 3 }, { tier: 'FINISHER', placement: 47, edition: { n: 47, total: 312 } }, { tier: 'GOLD', placement: 1, distinctions: ['UNBEATEN', 'STATE_CHAMPION'] }, { tier: 'SPECIAL', achievement: 'TOP_SCORER' }, { tier: 'SPECIAL', achievement: 'MVP' }, { tier: 'GOLD', placement: 1, status: 'REVOKED' }];
    for (const v of variants) {
      const view = Object.assign({}, base, v);
      for (const svg of [Card.front(view, { uid: 'a' }), Card.back(view, { uid: 'b' })]) {
        assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
        assert.ok(!/undefined|NaN/.test(svg), 'tem undefined/NaN em ' + JSON.stringify(v));
        assert.ok(!svg.includes('<Teste>') && svg.includes('&lt;TESTE&gt;'), 'não escapou');
      }
    }
  });
  await t('rótulos: feminino, raridade só por mérito, "1 de 1" e "47 de 312"', () => {
    assert.strictEqual(Card.placementLabel({ tier: 'GOLD', placement: 1, gender: 'F' }), 'CAMPEÃ');
    assert.strictEqual(Card.placementLabel({ tier: 'SILVER', placement: 2 }), 'VICE-CAMPEÃO');
    assert.strictEqual(Card.placementLabel({ tier: 'SPECIAL', achievement: 'TOP_SCORER', gender: 'F' }), 'ARTILHEIRA');
    assert.ok(Card.isRare({ distinctions: ['UNBEATEN'] })); assert.ok(Card.isRare({ achievement: 'MVP', distinctions: [] })); assert.ok(!Card.isRare({ tier: 'GOLD', achievement: 'PLACEMENT', distinctions: [] }));
    assert.strictEqual(Card.editionText({ edition: { n: 47, total: 312 } }), '47 DE 312');
  });
  await t('estante: agrupa por esporte/série e expõe os espaços vazios do pódio', () => {
    const mk = (tier, series, sport) => Object.assign({}, base, { tier, placement: { GOLD: 1, SILVER: 2, BRONZE: 3 }[tier], series, event: Object.assign({}, base.event, { sport, circuit: 'Circuito' }) });
    const g = Shelf.group([mk('SILVER', 's1', 'BEACH_TENNIS'), mk('BRONZE', 's1', 'BEACH_TENNIS'), mk('GOLD', 's2', 'TENNIS')]);
    assert.strictEqual(g.length, 2); assert.strictEqual(g[0].sport, 'BEACH_TENNIS'); assert.strictEqual(g[0].series[0].medals.length, 2);
    assert.strictEqual(Shelf.top3([mk('BRONZE', 'a', 'X'), Object.assign(mk('GOLD', 'b', 'X'), { distinctions: ['UNBEATEN'] }), mk('SILVER', 'c', 'X')])[0].tier, 'GOLD');
  });
  await t('rotas: não existe transferência, venda nem autodeclaração', () => {
    const router = require('../src/routes/medals');
    const paths = router.stack.filter((l) => l.route).map((l) => Object.keys(l.route.methods)[0].toUpperCase() + ' ' + l.route.path);
    assert.ok(!paths.some((p) => /transfer|sell|venda|claim|self/i.test(p)), paths.join(', '));
    assert.ok(paths.includes('POST /:serial/revoke'));
  });
}

async function partB() {
  console.log('B) fluxo real no banco de TESTE');
  const { prisma } = require('../src/middleware');
  const medals = require('../src/services/medals');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const tag = 'mt' + Date.now().toString(36);
  const cpf = () => String(Math.floor(1e10 + Math.random() * 8.9e10)).slice(0, 11);
  const mkUser = (name, withCpf, role) => prisma.user.create({ data: { name, phone: tag + Math.random().toString().slice(2, 10), pin: 'x', cpf: withCpf ? cpf() : null, role: role || 'user' } });

  await t('ensureApexSchema roda sem erro e é idempotente', async () => { await ensureApexSchema(prisma); await ensureApexSchema(prisma); });

  const owner = await mkUser('Organizadora Teste', true);
  const stranger = await mkUser('Curioso', true);
  const P = []; for (let i = 0; i < 8; i++) P.push(await mkUser('Atleta ' + i, i !== 7)); // Atleta 7 SEM CPF
  await prisma.athleteProfile.create({ data: { userId: P[0].id, username: tag + 'a0' } });
  const tour = await prisma.tournament.create({ data: { slug: tag, name: 'Torneio BT ' + tag, sport: 'BEACH_TENNIS', format: 'KNOCKOUT', isDoubles: true, status: 'FINISHED', ownerId: owner.id, city: 'João Pessoa', state: 'PB', endDate: new Date('2026-11-10') } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: tour.id, name: 'Dupla Feminina B', gender: 'F' } });
  const E = [];
  for (let i = 0; i < 4; i++) {
    const e = await prisma.tournamentEntry.create({ data: { tournamentId: tour.id, categoryId: cat.id, name: 'Dupla ' + i } });
    await prisma.entryMember.createMany({ data: [{ entryId: e.id, userId: P[i * 2].id }, { entryId: e.id, userId: P[i * 2 + 1].id }] });
    E.push(e);
  }
  const match = (stage, h, a, w, st) => prisma.tournamentMatch.create({ data: { tournamentId: tour.id, categoryId: cat.id, stage, homeEntryId: h.id, awayEntryId: a.id, winnerEntryId: w ? w.id : null, status: st || 'FINISHED', homeScore: 2, awayScore: 0 } });
  await match('SEMI', E[0], E[3], E[0]); await match('SEMI', E[1], E[2], E[1]);
  const third = await match('THIRD', E[2], E[3], null, 'SCHEDULED');
  const final = await match('FINAL', E[0], E[1], E[0]);

  await t('sem resultado oficial (3º lugar pendente) NÃO emite', async () => {
    const pv = await medals.previewTournament(tour.id, { id: owner.id, role: 'user' });
    assert.strictEqual(pv.categories[0].confirmed, false); assert.ok(/3º/.test(pv.categories[0].reason));
  });
  await prisma.tournamentMatch.update({ where: { id: third.id }, data: { winnerEntryId: E[2].id, status: 'FINISHED' } });

  await t('quem não organiza não vê nem emite (403)', async () => {
    await assert.rejects(medals.previewTournament(tour.id, { id: stranger.id, role: 'user' }), (e) => e.status === 403);
    await assert.rejects(medals.issueTournament(tour.id, { id: stranger.id, role: 'user' }), (e) => e.status === 403);
  });
  await t('sem emissor cadastrado: prévia avisa e emissão recusa (409)', async () => {
    const pv = await medals.previewTournament(tour.id, { id: owner.id, role: 'user' }); assert.strictEqual(pv.issuer, null);
    await assert.rejects(medals.issueTournament(tour.id, { id: owner.id, role: 'user' }), (e) => e.status === 409);
  });
  const issuer = await medals.createIssuer({ ownerUserId: owner.id, name: 'Liga de Teste ' + tag, kind: 'ORGANIZER', signatoryName: 'Organizadora Teste' });

  let pv;
  await t('prévia: pódio do resultado oficial, invicta, concluintes numerados, sem-CPF bloqueado', async () => {
    pv = await medals.previewTournament(tour.id, { id: owner.id, role: 'user' });
    const c = pv.categories[0];
    assert.ok(c.confirmed); assert.ok(c.unbeaten, 'campeã venceu semi e final → invicta');
    const by = (uid) => c.medals.find((m) => m.userId === uid);
    assert.strictEqual(by(P[0].id).tier, 'GOLD'); assert.deepStrictEqual(by(P[0].id).distinctions, ['UNBEATEN']);
    assert.strictEqual(by(P[2].id).tier, 'SILVER'); assert.strictEqual(by(P[4].id).tier, 'BRONZE');
    assert.strictEqual(by(P[6].id).tier, 'FINISHER'); assert.deepStrictEqual(by(P[6].id).edition, { n: 4, total: 4 });
    assert.ok(!by(P[7].id), 'sem CPF não entra'); assert.ok(c.blocked.some((b) => /CPF/.test(b.reason)));
    assert.strictEqual(c.medals.length, 7);
  });
  let res;
  await t('emissão: 7 medalhas assinadas, título estadual só pra campeã, MVP', async () => {
    res = await medals.issueTournament(tour.id, { id: owner.id, role: 'user' }, { distinctions: { [P[0].id]: ['STATE_CHAMPION'], [P[2].id]: ['STATE_CHAMPION'] }, mvp: { [cat.id]: P[1].id } });
    assert.strictEqual(res.issued.length, 8, JSON.stringify(res)); // 7 + MVP
    const champ = await prisma.medal.findFirst({ where: { userId: P[0].id, tournamentId: tour.id } });
    assert.deepStrictEqual(champ.distinctions.sort(), ['STATE_CHAMPION', 'UNBEATEN']);
    const vice = await prisma.medal.findFirst({ where: { userId: P[2].id, tournamentId: tour.id } });
    assert.deepStrictEqual(vice.distinctions, [], 'título estadual não vale pra vice');
    assert.strictEqual(champ.result.opponent, 'Dupla 1'); assert.strictEqual(champ.result.score, '2 x 0'); assert.strictEqual(champ.result.note, 'Final');
    assert.strictEqual(vice.result.score, '0 x 2', 'placar do ponto de vista de quem recebe');
    const bronze = await prisma.medal.findFirst({ where: { userId: P[4].id, tournamentId: tour.id } });
    assert.strictEqual(bronze.result.opponent, 'Dupla 3'); assert.strictEqual(bronze.result.note, 'Disputa de 3º lugar');
    assert.ok(await prisma.medal.findFirst({ where: { userId: P[1].id, achievement: 'MVP' } }));
  });
  await t('reemitir é idempotente (nada duplicado)', async () => {
    const again = await medals.issueTournament(tour.id, { id: owner.id, role: 'user' });
    assert.strictEqual(again.issued.length, 0);
    assert.strictEqual(await prisma.medal.count({ where: { tournamentId: tour.id } }), 8);
  });
  const medal = await prisma.medal.findFirst({ where: { userId: P[0].id, tournamentId: tour.id, achievement: 'PLACEMENT' } });
  await t('credencial OB 3.0 válida offline + campos obrigatórios + série/código', async () => {
    const r = await MV.verify(medal.credentialJwt); assert.ok(r.valid, JSON.stringify(r.checks));
    const p = r.payload;
    assert.deepStrictEqual(p.type, ['VerifiableCredential', 'OpenBadgeCredential']);
    assert.ok(p['@context'].includes('https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json'));
    assert.strictEqual(p.issuer.id, issuer.did); assert.strictEqual(p.credentialSubject.achievement.type[0], 'Achievement');
    assert.strictEqual(p.credentialStatus.type, '1EdTechRevocationList');
    assert.strictEqual(p.medal.tier, 'GOLD'); assert.strictEqual(p.medal.edition.number, 1); assert.ok(p.medal.template.design.palette);
    assert.ok(/^CST-\d{4}-\d{6}$/.test(medal.serial)); assert.strictEqual(medal.verificationCode, mc.verificationCode(medal.credentialJwt));
    assert.ok(!medal.credentialJwt.includes(medal.identitySalt), 'sal NÃO pode ir na credencial pública');
  });
  await t('titularidade: hash público = CPF do dono + sal secreto', async () => {
    const u = await prisma.user.findUnique({ where: { id: P[0].id } });
    const idHash = (await MV.verify(medal.credentialJwt)).payload.credentialSubject.identifier.find((i) => i.hashed).identityHash;
    assert.strictEqual(idHash, mc.identityHash(u.cpf, medal.identitySalt));
    assert.notStrictEqual(idHash, mc.identityHash(P[1].cpf || '00000000000', medal.identitySalt));
  });
  await t('estante pública e página da medalha (sem sal, com histórico)', async () => {
    const s = await medals.shelf(tag + 'a0');
    assert.strictEqual(s.medals.length, 1); assert.ok(!('ownershipCode' in s.medals[0]));
    const v = await medals.bySerial(medal.serial);
    assert.strictEqual(v.history[0].action, 'ISSUED'); assert.ok(v.qr.bits.length === v.qr.size * v.qr.size);
    assert.ok(!JSON.stringify(v).includes(medal.identitySalt));
    const w = await medals.wallet(P[0].id); assert.strictEqual(w[0].ownershipCode, medal.identitySalt);
  });
  await t('revogação: só o emissor, exige motivo+decisão, histórico e lista pública', async () => {
    await assert.rejects(medals.setStatus(medal.serial, { id: stranger.id, role: 'user' }, { action: 'REVOKED', reason: 'DOPING', note: 'xxxxx' }), (e) => e.status === 403);
    await assert.rejects(medals.setStatus(medal.serial, { id: owner.id, role: 'user' }, { action: 'REVOKED', reason: 'X', note: 'xxxxx' }), (e) => e.status === 400);
    await assert.rejects(medals.setStatus(medal.serial, { id: owner.id, role: 'user' }, { action: 'REVOKED', reason: 'APPEAL', note: '' }), (e) => e.status === 400);
    await medals.setStatus(medal.serial, { id: owner.id, role: 'user' }, { action: 'REVOKED', reason: 'APPEAL', note: 'Recurso 01/2026 procedente' });
    const sl = await medals.statusList(issuer.id, medal.credentialId);
    assert.ok(sl.revokedCredentials.some((x) => x.id === medal.credentialId && x.reason === 'Recurso'));
    assert.deepStrictEqual(sl.history.map((h) => h.action), ['ISSUED', 'REVOKED']);
    const chk = await MV.checkStatus((await MV.verify(medal.credentialJwt)).payload, async () => ({ ok: true, json: async () => sl }));
    assert.ok(chk.checked && chk.revoked);
    assert.strictEqual((await medals.shelf(tag + 'a0')).medals.length, 0, 'revogada sai da estante');
    assert.strictEqual((await medals.bySerial(medal.serial)).status, 'REVOKED', 'mas continua verificável');
    await medals.setStatus(medal.serial, { id: owner.id, role: 'user' }, { action: 'REINSTATED', note: 'Decisão reformada' });
    assert.strictEqual((await medals.bySerial(medal.serial)).history.length, 3);
  });
  await t('emissão manual (corrida): lista oficial do emissor, "47 de 312", sem CPF pula', async () => {
    const tpl = await medals.saveTemplate({ id: owner.id, role: 'user' }, { issuerId: issuer.id, name: 'Corrida Teste 10K', sport: 'RUNNING', design: { primary: '#c81d4e' } });
    await assert.rejects(medals.saveTemplate({ id: stranger.id, role: 'user' }, { issuerId: issuer.id, name: 'Hack', sport: 'RUNNING' }), (e) => e.status === 403);
    const r = await medals.issueManual({ id: owner.id, role: 'user' }, { issuerId: issuer.id, templateId: tpl.id, categoryName: '10 km Geral', eventDate: '2026-09-07', location: 'Orla', recipients: [
      { cpf: P[3].cpf, tier: 'FINISHER', placement: 47, edition: { n: 47, total: 312 }, result: { time: '52:41' } },
      { username: P[7].id, tier: 'FINISHER', placement: 48, edition: { n: 48, total: 312 } },
    ] });
    assert.strictEqual(r.issued.length, 1); assert.ok(/CPF/.test(r.skipped[0].reason));
    const m = await prisma.medal.findUnique({ where: { serial: r.issued[0].serial } });
    assert.strictEqual(m.editionNumber, 47); assert.strictEqual(m.editionTotal, 312); assert.strictEqual(m.result.time, '52:41');
    assert.ok((await MV.verify(m.credentialJwt)).valid);
  });

  // limpeza (banco de teste)
  const mids = (await prisma.medal.findMany({ where: { issuerId: issuer.id }, select: { id: true } })).map((m) => m.id);
  await prisma.medalStatusEvent.deleteMany({ where: { medalId: { in: mids } } });
  await prisma.medal.deleteMany({ where: { issuerId: issuer.id } });
  await prisma.medalTemplate.deleteMany({ where: { issuerId: issuer.id } });
  await prisma.medalIssuer.delete({ where: { id: issuer.id } });
  await prisma.tournament.delete({ where: { id: tour.id } });
  await prisma.athleteProfile.deleteMany({ where: { userId: P[0].id } });
  await prisma.user.deleteMany({ where: { phone: { startsWith: tag } } });
  await prisma.$disconnect();
}

(async () => {
  await partA();
  if (process.env.MEDAL_TEST_DATABASE_URL) await partB();
  else results.push('  (parte B pulada: defina MEDAL_TEST_DATABASE_URL com um banco DESCARTÁVEL)');
  console.log(results.join('\n'));
  console.log((process.exitCode ? 'FALHOU' : 'OK') + ' — ' + pass + ' testes passaram');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
