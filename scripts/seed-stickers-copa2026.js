'use strict';
// Seed all 980 Panini Copa do Mundo FIFA 2026 stickers
// 20 special + 48 teams × 20 = 980

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TEAMS = [
  // CONCACAF
  { code: 'CAN', name: 'Canadá',           confederation: 'CONCACAF' },
  { code: 'USA', name: 'Estados Unidos',    confederation: 'CONCACAF' },
  { code: 'MEX', name: 'México',            confederation: 'CONCACAF' },
  { code: 'PAN', name: 'Panamá',            confederation: 'CONCACAF' },
  { code: 'CUR', name: 'Curaçao',           confederation: 'CONCACAF' },
  { code: 'HAI', name: 'Haiti',             confederation: 'CONCACAF' },
  // CONMEBOL
  { code: 'ARG', name: 'Argentina',         confederation: 'CONMEBOL' },
  { code: 'BRA', name: 'Brasil',            confederation: 'CONMEBOL' },
  { code: 'COL', name: 'Colômbia',          confederation: 'CONMEBOL' },
  { code: 'ECU', name: 'Equador',           confederation: 'CONMEBOL' },
  { code: 'PAR', name: 'Paraguai',          confederation: 'CONMEBOL' },
  { code: 'URU', name: 'Uruguai',           confederation: 'CONMEBOL' },
  // UEFA
  { code: 'ALE', name: 'Alemanha',          confederation: 'UEFA' },
  { code: 'AUT', name: 'Áustria',           confederation: 'UEFA' },
  { code: 'BEL', name: 'Bélgica',           confederation: 'UEFA' },
  { code: 'DIN', name: 'Dinamarca',         confederation: 'UEFA' },
  { code: 'ESC', name: 'Escócia',           confederation: 'UEFA' },
  { code: 'ESP', name: 'Espanha',           confederation: 'UEFA' },
  { code: 'FRA', name: 'França',            confederation: 'UEFA' },
  { code: 'ING', name: 'Inglaterra',        confederation: 'UEFA' },
  { code: 'ITA', name: 'Itália',            confederation: 'UEFA' },
  { code: 'NOR', name: 'Noruega',           confederation: 'UEFA' },
  { code: 'HOL', name: 'Países Baixos',     confederation: 'UEFA' },
  { code: 'POL', name: 'Polônia',           confederation: 'UEFA' },
  { code: 'POR', name: 'Portugal',          confederation: 'UEFA' },
  { code: 'RTC', name: 'Rep. Tcheca',       confederation: 'UEFA' },
  { code: 'SUE', name: 'Suécia',            confederation: 'UEFA' },
  { code: 'SUI', name: 'Suíça',             confederation: 'UEFA' },
  // CAF
  { code: 'EGI', name: 'Egito',             confederation: 'CAF' },
  { code: 'ALG', name: 'Argélia',           confederation: 'CAF' },
  { code: 'ASA', name: 'África do Sul',     confederation: 'CAF' },
  { code: 'CPV', name: 'Cabo Verde',        confederation: 'CAF' },
  { code: 'GAN', name: 'Gana',              confederation: 'CAF' },
  { code: 'MAR', name: 'Marrocos',          confederation: 'CAF' },
  { code: 'SEN', name: 'Senegal',           confederation: 'CAF' },
  { code: 'TUN', name: 'Tunísia',           confederation: 'CAF' },
  { code: 'CMA', name: 'Costa do Marfim',   confederation: 'CAF' },
  { code: 'RDC', name: 'RD Congo',          confederation: 'CAF' },
  // AFC
  { code: 'AUS', name: 'Austrália',         confederation: 'AFC' },
  { code: 'CDS', name: 'Coreia do Sul',     confederation: 'AFC' },
  { code: 'IRA', name: 'Irã',               confederation: 'AFC' },
  { code: 'IRQ', name: 'Iraque',            confederation: 'AFC' },
  { code: 'JPN', name: 'Japão',             confederation: 'AFC' },
  { code: 'JOR', name: 'Jordânia',          confederation: 'AFC' },
  { code: 'TAI', name: 'Tailândia',         confederation: 'AFC' },
  { code: 'UZB', name: 'Uzbequistão',       confederation: 'AFC' },
  { code: 'VIE', name: 'Vietnã',            confederation: 'AFC' },
  // OFC
  { code: 'NZL', name: 'Nova Zelândia',     confederation: 'OFC' },
];

function pad(n) { return n.toString().padStart(2, '0'); }

async function main() {
  const stickers = [];

  // 1 INTRO
  stickers.push({ section: 'INT', sectionName: 'Abertura', confederation: '', number: 1,
    label: 'SOMOS 26', displayCode: 'INT-01', isSpecial: true, isShield: false, isTeamPhoto: false });

  // 8 FWC
  for (let i = 1; i <= 8; i++) {
    stickers.push({ section: 'FWC', sectionName: 'Especiais FIFA WC', confederation: '', number: i,
      label: `FWC ${i}`, displayCode: `FWC-${pad(i)}`, isSpecial: true, isShield: false, isTeamPhoto: false });
  }

  // 11 Museu FIFA
  for (let i = 1; i <= 11; i++) {
    stickers.push({ section: 'MUS', sectionName: 'Museu FIFA', confederation: '', number: i,
      label: `Museu ${i}`, displayCode: `MUS-${pad(i)}`, isSpecial: true, isShield: false, isTeamPhoto: false });
  }

  // 48 teams × 20 stickers
  for (const team of TEAMS) {
    for (let n = 1; n <= 20; n++) {
      let label, isShield = false, isTeamPhoto = false;
      if (n === 1)  { label = 'Escudo'; isShield = true; }
      else if (n === 20) { label = 'Foto do Time'; isTeamPhoto = true; }
      else { label = `Jogador ${n}`; }

      stickers.push({
        section: team.code,
        sectionName: team.name,
        confederation: team.confederation,
        number: n,
        label,
        displayCode: `${team.code}-${pad(n)}`,
        isShield,
        isTeamPhoto,
        isSpecial: false,
      });
    }
  }

  console.log(`Total para seed: ${stickers.length} figurinhas (esperado: 980)`);

  let created = 0, skipped = 0;
  for (const s of stickers) {
    const exists = await prisma.sticker.findUnique({
      where: { section_number: { section: s.section, number: s.number } },
    });
    if (!exists) {
      await prisma.sticker.create({ data: s });
      created++;
    } else {
      skipped++;
    }
  }

  console.log(`Concluído. Criadas: ${created} | Já existiam: ${skipped}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
