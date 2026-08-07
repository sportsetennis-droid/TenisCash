// fiscal-diagnose.js — "POR QUE O CUPOM NAO ESTA SAINDO?" (READ-ONLY, nao muda NADA)
// Roda em maquina com .env/DATABASE_URL:  node scripts/fiscal-diagnose.js
// Mesma logica do endpoint GET /api/_fiscaldiag (src/services/fiscalDiagnose.js).
const fs = require('fs'); const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
const { buildFiscalDiagnoseReport } = require('../src/services/fiscalDiagnose');

(async () => {
  console.log(await buildFiscalDiagnoseReport(prisma));
  await prisma.$disconnect();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
