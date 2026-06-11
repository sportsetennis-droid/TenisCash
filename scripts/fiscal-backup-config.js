// fiscal-backup-config.js — exporta a configuracao fiscal completa (FiscalIssuer +
// campos fiscais de Store) pra um JSON FORA do repositorio. CONTEM SEGREDOS
// (CSC, tokens de agente) -> destino C:\Users\sport\TenisCashBackups\, NUNCA commitar.
// Rodar apos qualquer mudanca de emitente/serie/roteamento. Restauracao = upsert por CNPJ.
// Uso: node scripts/fiscal-backup-config.js
const fs = require('fs'); const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();

(async () => {
  const issuers = await prisma.fiscalIssuer.findMany({ orderBy: { cnpj: 'asc' } });
  const stores = await prisma.store.findMany({
    where: { fiscalIssuerId: { not: null } },
    select: { id: true, code: true, name: true, fiscalIssuerId: true, fiscalAgentEnabled: true, fiscalAgentUrl: true, fiscalAgentToken: true },
    orderBy: { code: 'asc' },
  });
  const dir = 'C:\\Users\\sport\\TenisCashBackups';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(dir, 'fiscal-config-' + stamp + '.json');
  fs.writeFileSync(file, JSON.stringify({
    geradoEm: new Date().toISOString(),
    nota: 'Config fiscal completa (issuers + roteamento de agentes). CONTEM SEGREDOS - nao commitar. PFX ficam em C:\\Chianca\\NFe_Emissao0XX\\ em cada maquina de loja; AGENT_TOKEN tambem em C:\\TenisCashAgent\\.env de cada loja.',
    issuers, stores,
  }, null, 2));
  console.log('Backup fiscal salvo: ' + file);
  console.log('  issuers: ' + issuers.length + ' | stores roteadas: ' + stores.length);
  await prisma.$disconnect();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
