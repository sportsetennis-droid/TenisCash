// fiscal-status.js — raio-x READ-ONLY do sistema fiscal:
// roteamento por loja, saude/versao de cada agente, series e numeracao.
// Uso: node scripts/fiscal-status.js
const fs = require('fs'); const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
const agentClient = require('../src/services/fiscalAgentClient');

(async () => {
  const stores = await prisma.store.findMany({ where: { fiscalIssuerId: { not: null } }, include: { fiscalIssuer: true }, orderBy: { code: 'asc' } });
  console.log('LOJA   | agente (URL)                                | saude        | NFC-e        | NFe55 (propria)');
  console.log('-'.repeat(118));
  for (const s of stores) {
    const i = s.fiscalIssuer;
    let h; try { h = await agentClient.ping(s); } catch (e) { h = { ok: false, error: e.message }; }
    const saude = h.ok ? ('v' + (h.version || '?')) : 'FORA DO AR';
    console.log(
      s.code.padEnd(6) + ' | ' +
      String(s.fiscalAgentUrl || '(sem)').padEnd(44).slice(0, 44) + ' | ' +
      saude.padEnd(12) + ' | ' +
      ('s' + i.nfceSerie + ' prox ' + i.nfceNextNumber).padEnd(12) + ' | ' +
      's' + i.nfeSerie + ' prox ' + i.nfeNextNumber +
      (i.csc ? '' : '   << SEM CSC!') +
      (s.fiscalAgentEnabled ? '' : '   << AGENTE DESLIGADO!')
    );
  }
  console.log('\nLembretes: agente >=2.1 = troca/devolucao/modelo-55 ok | failover loja-cobre-loja e automatico');
  console.log('Teste real de uma loja: node scripts/fiscal-test-emit.js LOJA0X 9000NN (nNF de teste sempre NOVO)');
  await prisma.$disconnect();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
