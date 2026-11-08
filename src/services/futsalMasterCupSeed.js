// =====================================================================
// II FUTSAL MASTER CUP 2026 — carga da TABELA OFICIAL
// 19 a 22/nov · João Pessoa/PB · ginásios Ronaldão e Marista.
// Primeiro torneio real rodado no sistema APEX. Sports & Tennis colabora.
//
// Fonte: "TABELA OFICIAL II MASTER CUP" (coordenação técnica). Carrega os
// 65 jogos EXATOS (dia/hora/ginásio/categoria/grupo/times). Idempotente:
// dedup de jogo por (tournamentId, ordering=nº do jogo); times por nome.
//
// ⚠️ LEITURA LITERAL + NÃO CHUTAR (regra do dono): jogos cujos times ficaram
// AMBÍGUOS na tabela (44 e 51 — ver notas) ou que dependem de resultado
// (30 e 56, "vs perdedor/vencedor do J8"), e todo o mata-mata, entram como
// "A CONFIRMAR" (sem time) e são preenchidos depois pelo organizador.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SLUG = 'futsal-master-cup-2026';
const TZ = '-03:00'; // America/Fortaleza
const R = 'Ginásio Ronaldão';
const M = 'Ginásio Marista';

// Times por categoria (nomes OFICIAIS da tabela) + grupo.
const TEAMS = {
  '40+': { A: ['Brasil Sertão - RN', 'Bola no Pé - PB', 'Sport - PE', 'EPCF/Guarabira'],
           B: ['EBN - PB', 'Cabo Branco - PB', 'Santa Cruz - PE', 'AAPB - PB'] },
  '45+': { A: ['Brasil Sertão - RN', 'AAPB - PB', 'Cabo Branco - PB', 'Santa Cruz - PE'],
           B: ['EPCF/Guarabira', 'Bayeux Futsal - PB', 'Bola no Pé - PB'] },
  '50+': { A: ['COPM - PB', 'Sport - PE', 'Foz Futsal - PR', 'Cabo Branco - PB'],
           B: ['Santa Cruz - PE', 'Brasil Sertão - RN', 'Amigos CG - PB', 'Real Madri - SE'] },
  '55+': { A: ['Amigos CG - PB', 'Foz Futsal - PR', 'Cristo Rei - PB'],
           B: ['Cabo Branco - PB', 'Santa Cruz - PE', 'Brasil Sertão - RN'] },
  '60+': { U: ['Causos e Lendas - PB', 'Astrea - PB', 'Brasil Sertão - RN', 'Amigos CG - PB', 'Foz Futsal - PR'] },
};

// Formato por categoria (50+/40+/45+ grupos+mata-mata; 55+ cruzado A×B; 60+ pontos corridos)
const CAT_FORMAT = { '40+': 'GROUPS_KNOCKOUT', '45+': 'GROUPS_KNOCKOUT', '50+': 'GROUPS_KNOCKOUT', '55+': 'GROUPS', '60+': 'ROUND_ROBIN' };

// Jogos: [nº, dia, hora, ginásio, categoria, stage, grupo, casa, visitante]
// stage: G=grupo, SF=semifinal, FIN=final. null em casa/visitante = A CONFIRMAR.
const X = null; // a confirmar
const GAMES = [
  [1, '19', '14:00', R, '60+', 'G', 'U', 'Causos e Lendas - PB', 'Astrea - PB'],
  [2, '19', '14:50', R, '60+', 'G', 'U', 'Amigos CG - PB', 'Foz Futsal - PR'],
  [3, '19', '15:40', R, '55+', 'G', 'AxB', 'Foz Futsal - PR', 'Cabo Branco - PB'],
  [4, '19', '16:30', R, '55+', 'G', 'AxB', 'Cristo Rei - PB', 'Santa Cruz - PE'],
  [5, '19', '17:20', R, '55+', 'G', 'AxB', 'Amigos CG - PB', 'Brasil Sertão - RN'],
  [6, '19', '18:10', R, '45+', 'G', 'A', 'AAPB - PB', 'Cabo Branco - PB'],
  [7, '19', '19:00', R, '45+', 'G', 'A', 'Brasil Sertão - RN', 'Santa Cruz - PE'],
  [8, '19', '19:50', R, '45+', 'G', 'B', 'Bola no Pé - PB', 'Bayeux Futsal - PB'],
  [9, '19', '20:40', R, '50+', 'G', 'A', 'COPM - PB', 'Sport - PE'],
  [10, '19', '21:30', R, '50+', 'G', 'A', 'Cabo Branco - PB', 'Foz Futsal - PR'],

  [11, '20', '08:00', M, '50+', 'G', 'B', 'Santa Cruz - PE', 'Brasil Sertão - RN'],
  [12, '20', '08:50', M, '50+', 'G', 'B', 'Real Madri - SE', 'Amigos CG - PB'],
  [13, '20', '09:40', M, '60+', 'G', 'U', 'Foz Futsal - PR', 'Causos e Lendas - PB'],
  [14, '20', '10:30', M, '60+', 'G', 'U', 'Astrea - PB', 'Brasil Sertão - RN'],
  [15, '20', '11:20', M, '55+', 'G', 'AxB', 'Santa Cruz - PE', 'Foz Futsal - PR'],
  [16, '20', '12:10', M, '55+', 'G', 'AxB', 'Brasil Sertão - RN', 'Cristo Rei - PB'],
  [17, '20', '13:00', M, '55+', 'G', 'AxB', 'Cabo Branco - PB', 'Amigos CG - PB'],
  [18, '20', '13:50', M, '50+', 'G', 'A', 'Foz Futsal - PR', 'COPM - PB'],
  [19, '20', '14:40', M, '50+', 'G', 'A', 'Sport - PE', 'Cabo Branco - PB'],
  [20, '20', '15:30', M, '50+', 'G', 'B', 'Brasil Sertão - RN', 'Real Madri - SE'],
  [21, '20', '16:20', M, '50+', 'G', 'B', 'Amigos CG - PB', 'Santa Cruz - PE'],
  [22, '20', '17:10', M, '60+', 'G', 'U', 'Amigos CG - PB', 'Brasil Sertão - RN'],
  [23, '20', '18:00', M, '60+', 'G', 'U', 'Foz Futsal - PR', 'Astrea - PB'],
  [24, '20', '09:00', R, '40+', 'G', 'A', 'Brasil Sertão - RN', 'Bola no Pé - PB'],
  [25, '20', '09:50', R, '40+', 'G', 'A', 'Sport - PE', 'EPCF/Guarabira'],
  [26, '20', '10:40', R, '40+', 'G', 'B', 'EBN - PB', 'Cabo Branco - PB'],
  [27, '20', '11:30', R, '40+', 'G', 'B', 'Santa Cruz - PE', 'AAPB - PB'],
  [28, '20', '12:20', R, '45+', 'G', 'A', 'AAPB - PB', 'Brasil Sertão - RN'],
  [29, '20', '13:10', R, '45+', 'G', 'A', 'Santa Cruz - PE', 'Cabo Branco - PB'],
  // 30: 45+ B "EPCF x PERDEDOR do J8" → visitante a confirmar (depende do jogo 8)
  [30, '20', '14:00', R, '45+', 'G', 'B', 'EPCF/Guarabira', X],
  [31, '20', '14:50', R, '40+', 'G', 'A', 'Brasil Sertão - RN', 'EPCF/Guarabira'],
  [32, '20', '15:40', R, '40+', 'G', 'A', 'Bola no Pé - PB', 'Sport - PE'],
  [33, '20', '16:30', R, '40+', 'G', 'B', 'EBN - PB', 'AAPB - PB'],
  [34, '20', '17:20', R, '40+', 'G', 'B', 'Cabo Branco - PB', 'Santa Cruz - PE'],

  [35, '21', '08:00', M, '60+', 'G', 'U', 'Brasil Sertão - RN', 'Causos e Lendas - PB'],
  [36, '21', '08:50', M, '60+', 'G', 'U', 'Astrea - PB', 'Amigos CG - PB'],
  [37, '21', '09:40', M, '50+', 'G', 'A', 'COPM - PB', 'Cabo Branco - PB'],
  [38, '21', '10:30', M, '50+', 'G', 'A', 'Sport - PE', 'Foz Futsal - PR'],
  [39, '21', '11:20', M, '50+', 'G', 'B', 'Brasil Sertão - RN', 'Amigos CG - PB'],
  [40, '21', '12:10', M, '50+', 'G', 'B', 'Santa Cruz - PE', 'Real Madri - SE'],
  [41, '21', '13:00', M, '55+', 'G', 'AxB', 'Foz Futsal - PR', 'Brasil Sertão - RN'],
  [42, '21', '13:50', M, '55+', 'G', 'AxB', 'Cristo Rei - PB', 'Cabo Branco - PB'],
  [43, '21', '14:40', M, '55+', 'G', 'AxB', 'Amigos CG - PB', 'Santa Cruz - PE'],
  // 44: 60+ "Cabo Branco x Amigos CG" — Cabo Branco NÃO é do 60+ (provável erro,
  // faltou Causos e Lendas x Amigos CG). A confirmar.
  [44, '21', '15:30', M, '60+', 'G', 'U', X, X],
  [45, '21', '16:20', M, '60+', 'G', 'U', 'Brasil Sertão - RN', 'Foz Futsal - PR'],
  [46, '21', '18:00', M, '50+', 'SF', null, X, X],
  [47, '21', '18:50', M, '50+', 'SF', null, X, X],
  [48, '21', '19:40', M, '55+', 'SF', null, X, X],
  [49, '21', '20:30', M, '55+', 'SF', null, X, X],
  [50, '21', '08:00', R, '40+', 'G', 'A', 'Sport - PE', 'Brasil Sertão - RN'],
  // 51: 40+ B "EBN x Brasil Sertão" — Brasil Sertão é do grupo A (provável erro,
  // faltou EBN x Santa Cruz). A confirmar.
  [51, '21', '08:50', R, '40+', 'G', 'B', X, X],
  [52, '21', '09:40', R, '40+', 'G', 'A', 'EPCF/Guarabira', 'Bola no Pé - PB'],
  [53, '21', '10:30', R, '40+', 'G', 'B', 'AAPB - PB', 'Cabo Branco - PB'],
  [54, '21', '11:20', R, '45+', 'G', 'A', 'Cabo Branco - PB', 'Brasil Sertão - RN'],
  [55, '21', '12:10', R, '45+', 'G', 'A', 'AAPB - PB', 'Santa Cruz - PE'],
  // 56: 45+ B "EPCF x VENCEDOR do J8" → visitante a confirmar (depende do jogo 8)
  [56, '21', '13:00', R, '45+', 'G', 'B', 'EPCF/Guarabira', X],
  [57, '21', '18:00', R, '40+', 'SF', null, X, X],
  [58, '21', '18:50', R, '40+', 'SF', null, X, X],
  [59, '21', '19:40', R, '45+', 'SF', null, X, X],
  [60, '21', '20:30', R, '45+', 'SF', null, X, X],

  [61, '22', '09:00', M, '60+', 'FIN', null, X, X],
  [62, '22', '10:00', M, '55+', 'FIN', null, X, X],
  [63, '22', '11:00', M, '50+', 'FIN', null, X, X],
  [64, '22', '12:00', M, '45+', 'FIN', null, X, X],
  [65, '22', '13:00', M, '40+', 'FIN', null, X, X],
];

const STAGE_OF = { G: 'GROUP', SF: 'SEMI', FIN: 'FINAL' };
const ROUND_OF = { G: 1, SF: 2, FIN: 3 };

async function findOwner(ownerId) {
  if (ownerId) {
    const u = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, name: true } });
    if (u) return u;
  }
  return prisma.user.findFirst({
    where: { role: { in: ['admin', 'superadmin', 'manager'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
}

async function importFutsalMasterCup(ownerId) {
  const owner = await findOwner(ownerId);
  if (!owner) return { ok: false, error: 'nenhum admin/gerente pra ser organizador' };

  // 1) Torneio (idempotente por slug)
  let t = await prisma.tournament.findUnique({ where: { slug: SLUG } });
  if (!t) {
    t = await prisma.tournament.create({
      data: {
        slug: SLUG, name: 'II Futsal Master Cup 2026', sport: 'FUTSAL',
        format: 'GROUPS_KNOCKOUT', isDoubles: false, ownerId: owner.id,
        city: 'João Pessoa', state: 'PB',
        description: '2ª edição · categorias master 40+ a 60+ · 19 a 22 de novembro de 2026.',
        startDate: new Date('2026-11-19T00:00:00' + TZ),
        endDate: new Date('2026-11-22T23:59:59' + TZ),
        status: 'ONGOING', visibility: 'public', cashEnabled: false,
      },
    });
  } else if (ownerId && t.ownerId !== ownerId) {
    // Importar logado = reivindicar a organização (aparece em "Meus torneios").
    t = await prisma.tournament.update({ where: { id: t.id }, data: { ownerId: owner.id } });
  }

  // 2) Categorias + times (idempotente)
  const catId = {}; // nome -> id
  const entryId = {}; // "cat|time" -> entryId
  for (const [catName, groups] of Object.entries(TEAMS)) {
    let cat = await prisma.tournamentCategory.findFirst({ where: { tournamentId: t.id, name: catName } });
    if (!cat) {
      cat = await prisma.tournamentCategory.create({
        data: { tournamentId: t.id, name: catName, gender: 'OPEN', format: CAT_FORMAT[catName] },
      });
    }
    catId[catName] = cat.id;
    for (const [grp, teams] of Object.entries(groups)) {
      for (const name of teams) {
        let e = await prisma.tournamentEntry.findFirst({ where: { categoryId: cat.id, name } });
        if (!e) {
          e = await prisma.tournamentEntry.create({
            data: { tournamentId: t.id, categoryId: cat.id, name, groupName: grp, status: 'CONFIRMED' },
          });
        } else if (e.groupName !== grp) {
          await prisma.tournamentEntry.update({ where: { id: e.id }, data: { groupName: grp } });
        }
        entryId[catName + '|' + name] = e.id;
      }
    }
  }

  // 3) Jogos (idempotente por ordering = nº do jogo)
  let created = 0;
  let tbd = 0;
  for (const [n, day, time, venue, catName, stageCode, grp, home, away] of GAMES) {
    const cid = catId[catName];
    if (!cid) continue;
    const exists = await prisma.tournamentMatch.findFirst({ where: { tournamentId: t.id, ordering: n } });
    if (exists) continue;
    const homeId = home ? entryId[catName + '|' + home] || null : null;
    const awayId = away ? entryId[catName + '|' + away] || null : null;
    if (!homeId || !awayId) tbd += 1;
    await prisma.tournamentMatch.create({
      data: {
        tournamentId: t.id, categoryId: cid,
        stage: STAGE_OF[stageCode], round: ROUND_OF[stageCode], ordering: n,
        groupName: grp || null,
        homeEntryId: homeId, awayEntryId: awayId,
        scheduledAt: new Date('2026-11-' + day + 'T' + time + ':00' + TZ),
        location: venue, status: 'SCHEDULED',
      },
    });
    created += 1;
  }

  const totalTeams = Object.values(TEAMS).reduce((s, g) => s + Object.values(g).flat().length, 0);
  return {
    ok: true, slug: t.slug, tournamentId: t.id,
    categories: Object.keys(TEAMS).length, teams: totalTeams,
    matchesCreated: created, matchesTBD: tbd,
    publicUrl: '/t/' + t.slug,
  };
}

module.exports = { importFutsalMasterCup, SLUG };
