// Gera public/medalhas/demo-data.js — medalhas de EXEMPLO (marca d'água),
// assinadas de verdade por um emissor de DEMONSTRAÇÃO (chave descartável),
// pra galeria /medalhas/demo e pros testes visuais. Não toca no banco.
//   node scripts/medal-demo-data.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'demo-only';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mc = require('../src/services/medalCrypto');
const Tpl = require('../public/medalhas/medal-template.js');

// buildCredential/viewOf sem banco: carrega o serviço com prisma "vazio".
const medals = require('../src/services/medals');

const issuer = Object.assign({ id: 'demo-issuer', name: 'Emissor de demonstração', kind: 'ORGANIZER', signatoryName: 'Organização Exemplo', url: null }, mc.generateIssuerKeys());

const events = {
  bt1: { id: 'tpl-bt-bessa', name: 'Circuito Beach Tennis — Etapa Bessa', sport: 'BEACH_TENNIS', circuit: 'Circuito BT 2026', version: 1, design: Tpl.generate({ name: 'Circuito Beach Tennis — Etapa Bessa', sport: 'BEACH_TENNIS', primary: '#0e6ba8', secondary: '#f2a516', font: 'archivo', pattern: 'waves', shape: 'round' }) },
  bt2: { id: 'tpl-bt-tambau', name: 'Circuito Beach Tennis — Etapa Tambaú', sport: 'BEACH_TENNIS', circuit: 'Circuito BT 2026', version: 1, design: Tpl.generate({ name: 'Circuito Beach Tennis — Etapa Tambaú', sport: 'BEACH_TENNIS', primary: '#0b8f86', secondary: '#ff7a3d', font: 'archivo', pattern: 'waves', shape: 'round' }) },
  run: { id: 'tpl-run', name: 'Corrida Praia de Tambaú 10K', sport: 'RUNNING', circuit: null, version: 1, design: Tpl.generate({ name: 'Corrida Praia de Tambaú 10K', sport: 'RUNNING', primary: '#c81d4e', secondary: '#1d1d3b', font: 'barlow', pattern: 'diagonal', shape: 'hex' }) },
  fut: { id: 'tpl-fut', name: 'Copa Master de Futsal', sport: 'FUTSAL', circuit: null, version: 1, design: Tpl.generate({ name: 'Copa Master de Futsal', sport: 'FUTSAL', primary: '#1f2a44', secondary: '#e63946', font: 'anton', pattern: 'hex', shape: 'classic' }) },
  ten: { id: 'tpl-ten', name: 'Estadual de Tênis da Paraíba', sport: 'TENNIS', circuit: null, version: 1, design: Tpl.generate({ name: 'Estadual de Tênis da Paraíba', sport: 'TENNIS', primary: '#2d6a4f', secondary: '#d4a017', font: 'oswald', pattern: 'grid', shape: 'badge' }) },
};

const people = [
  { key: 'gold', ev: 'bt1', name: 'Marina Duarte', cat: 'Dupla Feminina B', gender: 'F', tier: 'GOLD', placement: 1, distinctions: ['UNBEATEN'], ed: [1, 1], result: { score: '6/4 6/3', opponent: 'Ana Souto & Bia Lins' }, date: '2026-10-18', loc: 'Arena Bessa, João Pessoa/PB' },
  { key: 'silver', ev: 'bt2', name: 'Marina Duarte', cat: 'Dupla Feminina B', gender: 'F', tier: 'SILVER', placement: 2, distinctions: [], ed: [1, 1], result: { score: '4/6 6/7', opponent: 'Clara Nóbrega & Lia Melo' }, date: '2026-11-08', loc: 'Arena Tambaú, João Pessoa/PB' },
  { key: 'bronze', ev: 'bt1', name: 'Rafael Lima', cat: 'Dupla Masculina C', gender: 'M', tier: 'BRONZE', placement: 3, distinctions: [], ed: [1, 1], result: { score: '6/2 6/4', opponent: 'Caio Arruda & Tiago Leal' }, date: '2026-10-18', loc: 'Arena Bessa, João Pessoa/PB' },
  { key: 'finisher', ev: 'run', name: 'Rafael Lima', cat: '10 km Geral', gender: 'M', tier: 'FINISHER', placement: 47, distinctions: [], ed: [47, 312], result: { time: '52:41', note: 'Tempo líquido (chip)' }, date: '2026-09-07', loc: 'Orla de Tambaú, João Pessoa/PB' },
  { key: 'scorer', ev: 'fut', name: 'Bruno Cavalcanti', cat: 'Master 40+', gender: 'M', tier: 'SPECIAL', achievement: 'TOP_SCORER', placement: null, distinctions: [], ed: [1, 1], result: { score: '14 gols', note: 'Artilharia oficial da categoria' }, date: '2026-11-09', loc: 'Ginásio do Bessa, João Pessoa/PB' },
  { key: 'state', ev: 'ten', name: 'Helena Araújo', cat: 'Simples Feminino 35+', gender: 'F', tier: 'GOLD', placement: 1, distinctions: ['STATE_CHAMPION'], ed: [1, 1], result: { score: '6/3 3/6 10/7', opponent: 'Paula Freire' }, date: '2026-08-23', loc: 'Clube Cabo Branco, João Pessoa/PB' },
  { key: 'revoked', ev: 'fut', name: 'Diego Moura', cat: 'Master 40+', gender: 'M', tier: 'SILVER', placement: 2, distinctions: [], ed: [1, 1], result: { score: '2 x 3', opponent: 'Cabo Branco' }, date: '2026-11-09', loc: 'Ginásio do Bessa, João Pessoa/PB', revoked: true },
];

(async () => {
  const out = [];
  let n = 100;
  for (const p of people) {
    const tpl = events[p.ev];
    const salt = mc.newIdentitySalt();
    const m = {
      serial: 'CST-2026-' + String(++n).padStart(6, '0'), credentialId: 'urn:uuid:' + crypto.randomUUID(), issuedAt: new Date(p.date + 'T22:00:00Z'),
      recipientName: p.name, identityHash: mc.identityHash('00000000000', salt), identitySalt: salt,
      sport: tpl.sport, eventName: tpl.name, categoryName: p.cat, gender: p.gender,
      series: tpl.circuit ? 'circuit:circuito-bt-2026:' + p.cat.toLowerCase().replace(/\W+/g, '-') : 'event:' + tpl.id,
      achievement: p.achievement || 'PLACEMENT', tier: p.tier, placement: p.placement, distinctions: p.distinctions,
      editionNumber: p.ed[0], editionTotal: p.ed[1], eventDate: new Date(p.date), location: p.loc,
      result: Object.assign({}, p.result, { location: p.loc, gender: p.gender }),
    };
    const jwt = mc.signCredentialJwt(medals.buildCredential(m, issuer, tpl), issuer);
    const medal = Object.assign({}, m, { templateId: tpl.id, issuerId: issuer.id, credentialJwt: jwt, verificationCode: mc.verificationCode(jwt), status: p.revoked ? 'REVOKED' : 'ACTIVE', revokedAt: p.revoked ? new Date('2026-11-12') : null });
    const v = await medals.viewOf(medal, { template: tpl, issuer, username: 'exemplo' });
    v.sample = true;
    v.history = [{ action: 'ISSUED', at: m.issuedAt, note: 'Emitida com base no resultado oficial' }].concat(p.revoked ? [{ action: 'REVOKED', reasonLabel: 'Recurso', note: 'Recurso 03/2026 julgado procedente: resultado alterado', at: new Date('2026-11-12') }] : []);
    out.push(Object.assign({ key: p.key }, v));
  }
  const file = path.join(__dirname, '../public/medalhas/demo-data.js');
  fs.writeFileSync(file, '/* gerado por scripts/medal-demo-data.js — medalhas de EXEMPLO (emissor de demonstração) */\nwindow.MEDAL_DEMO = ' + JSON.stringify(out) + ';\n');
  console.log('ok', out.length, 'medalhas de exemplo ->', path.relative(process.cwd(), file), fs.statSync(file).size, 'bytes');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
