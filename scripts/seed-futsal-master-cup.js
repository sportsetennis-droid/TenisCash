'use strict';
// =====================================================================
// Seed do torneio REAL: FUTSAL MASTER CUP 2026 (2ª edição)
// 19 a 22 de novembro de 2026 — João Pessoa/PB. Sports & Tennis é colaborador.
// Primeiro torneio rodado no sistema APEX.
//
// Cria: 1 Tournament (FUTSAL, grupos+mata-mata) + 5 categorias por idade
// (40+, 45+, 50+, 55+, 60+), com os TIMES e os GRUPOS já definidos na arte
// (inscrição de clube, sem exigir conta por atleta). Idempotente: rodar de
// novo NÃO duplica (casa torneio por slug, categoria por nome, time por nome).
//
// NÃO gera os jogos automaticamente — isso é 1 clique no admin/torneios
// ("Gerar jogos"), que agora RESPEITA estes grupos.
//
// Uso (na máquina/servidor com DATABASE_URL de produção):
//   node scripts/seed-futsal-master-cup.js            (dry-run: só mostra)
//   node scripts/seed-futsal-master-cup.js --apply    (grava)
//   OWNER_EMAIL=dono@... node scripts/seed-futsal-master-cup.js --apply
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const SLUG = 'futsal-master-cup-2026';

// Dados LITERAIS da arte (categoria → grupo → times "Nome - UF").
// GROUPS_KNOCKOUT = fase de grupos + mata-mata. 60+ é grupo único (pontos corridos).
const CATEGORIES = [
  {
    name: '40+', format: 'GROUPS_KNOCKOUT',
    groups: {
      A: ['Brasil Sertão - RN', 'Sport do Recife - PE', 'EPCF Guarabira - PB', 'Bola no Pé - PB'],
      B: ['EBN Areia - PB', 'Santa Cruz - PE', 'AAPB/Núcleobari - PB', 'Cabo Branco - PB'],
    },
  },
  {
    name: '45+', format: 'GROUPS_KNOCKOUT',
    groups: {
      A: ['Brasil Sertão - RN', 'AAPB/Núcleobari - PB', 'Cabo Branco - PB', 'Santa Cruz - PE'],
      B: ['EPCF Guarabira - PB', 'Bayeux Futsal - PB', 'Bola no Pé - PB'],
    },
  },
  {
    name: '50+', format: 'GROUPS_KNOCKOUT',
    groups: {
      A: ['COPM - PB', 'Sport do Recife - PE', 'Foz Futsal - PR', 'Cabo Branco - PB'],
      B: ['Santa Cruz - PE', 'Brasil Sertão - RN', 'Amigos CG - PB', 'Real Madri - SE'],
    },
  },
  {
    name: '55+', format: 'GROUPS_KNOCKOUT',
    groups: {
      A: ['Amigos CG - PB', 'Foz Futsal - PR', 'Cristo Rei Futsal - PB'],
      B: ['Cabo Branco - PB', 'Santa Cruz - PE', 'Brasil Sertão - RN'],
    },
  },
  {
    name: '60+', format: 'ROUND_ROBIN',
    groups: {
      // grupo único (pontos corridos) — fica tudo no grupo "U"
      U: ['Causos e Lendas - PB', 'Ástrea - PB', 'Brasil Sertão - RN', 'Amigos CG - PB', 'Foz Futsal - PR'],
    },
  },
];

async function findOwner() {
  if (process.env.OWNER_EMAIL) {
    const u = await prisma.user.findUnique({ where: { email: process.env.OWNER_EMAIL }, select: { id: true, name: true, email: true } });
    if (u) return u;
    console.log(`⚠️  OWNER_EMAIL=${process.env.OWNER_EMAIL} não encontrado — usando primeiro admin.`);
  }
  const admin = await prisma.user.findFirst({
    where: { role: { in: ['admin', 'superadmin', 'manager'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, email: true },
  });
  return admin;
}

async function main() {
  console.log(`\n🏆 FUTSAL MASTER CUP 2026 — seed ${APPLY ? '(GRAVANDO)' : '(dry-run — nada gravado)'}\n`);

  const owner = await findOwner();
  if (!owner) {
    console.error('❌ Nenhum usuário admin/gerente encontrado pra ser o organizador. Abortei.');
    process.exit(1);
  }
  console.log(`Organizador: ${owner.name || owner.email} (${owner.id})\n`);

  const totalTeams = CATEGORIES.reduce((s, c) => s + Object.values(c.groups).flat().length, 0);
  CATEGORIES.forEach((c) => {
    console.log(`  ${c.name} [${c.format}]`);
    Object.entries(c.groups).forEach(([g, teams]) => console.log(`    Grupo ${g}: ${teams.join(', ')}`));
  });
  console.log(`\n  Total: ${CATEGORIES.length} categorias · ${totalTeams} inscrições de times\n`);

  if (!APPLY) {
    console.log('Dry-run. Confira os times/grupos acima. Pra gravar: --apply\n');
    return;
  }

  // 1) Torneio (idempotente por slug)
  let t = await prisma.tournament.findUnique({ where: { slug: SLUG } });
  if (!t) {
    t = await prisma.tournament.create({
      data: {
        slug: SLUG,
        name: 'Futsal Master Cup 2026',
        sport: 'FUTSAL',
        format: 'GROUPS_KNOCKOUT',
        isDoubles: false,
        ownerId: owner.id,
        city: 'João Pessoa',
        state: 'PB',
        description: '2ª edição do Futsal Master Cup — categorias master por idade.',
        startDate: new Date('2026-11-19T00:00:00-03:00'),
        endDate: new Date('2026-11-22T23:59:59-03:00'),
        status: 'OPEN',
        visibility: 'public',
        cashEnabled: false, // torneio SEM TenisCash real
      },
    });
    console.log(`✅ Torneio criado: ${t.name} (/t/${t.slug})`);
  } else {
    console.log(`• Torneio já existe: ${t.name} (/t/${t.slug})`);
  }

  // 2) Categorias + times
  for (const c of CATEGORIES) {
    let cat = await prisma.tournamentCategory.findFirst({ where: { tournamentId: t.id, name: c.name } });
    if (!cat) {
      cat = await prisma.tournamentCategory.create({
        data: { tournamentId: t.id, name: c.name, gender: 'OPEN', format: c.format },
      });
      console.log(`  ✅ Categoria ${c.name} criada`);
    } else {
      if (cat.format !== c.format) {
        cat = await prisma.tournamentCategory.update({ where: { id: cat.id }, data: { format: c.format } });
      }
      console.log(`  • Categoria ${c.name} já existe`);
    }

    for (const [groupName, teams] of Object.entries(c.groups)) {
      for (const teamName of teams) {
        const existing = await prisma.tournamentEntry.findFirst({ where: { categoryId: cat.id, name: teamName } });
        if (existing) {
          if (existing.groupName !== groupName) {
            await prisma.tournamentEntry.update({ where: { id: existing.id }, data: { groupName } });
            console.log(`    ~ ${teamName}: grupo ajustado → ${groupName}`);
          }
          continue;
        }
        await prisma.tournamentEntry.create({
          data: {
            tournamentId: t.id,
            categoryId: cat.id,
            name: teamName,
            groupName: groupName === 'U' ? null : groupName,
            status: 'CONFIRMED',
          },
        });
        console.log(`    ✅ ${teamName} (Grupo ${groupName})`);
      }
    }
  }

  console.log('\n✅ Pronto. Agora é só abrir cada categoria no /torneios.html e clicar "Gerar jogos".');
  console.log('   O sistema respeita estes grupos (não re-sorteia).\n');
}

main()
  .catch((e) => {
    console.error('❌ Erro:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
