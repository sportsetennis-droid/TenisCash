// Teste pos-update v2.1 de UMA loja: health + NFC-e R$2 com 2 pagamentos (05+01) pela
// maquina DA PROPRIA loja + cancelamento. Uso: node scripts/fiscal-test-emit.js LOJA01 900091
const fs = require('fs'); const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
const agentClient = require('../src/services/fiscalAgentClient');

const CODE = process.argv[2]; const NNF = parseInt(process.argv[3], 10);
if (!CODE || !NNF) { console.error('uso: node scripts/fiscal-test-emit.js LOJA0X 9000XX'); process.exit(1); }

(async () => {
  const store = await prisma.store.findUnique({ where: { code: CODE }, include: { fiscalIssuer: true } });
  const health = await agentClient.ping(store);
  console.log(CODE + ' via ' + store.fiscalAgentUrl + ' | /health: v' + (health.version || '?') + ' (' + (health.store || '?') + ')');
  if (!String(health.version || '').startsWith('2.1')) { console.log('>> agente ainda NAO esta no v2.1 â€” update nao aplicou/agente nao reiniciou.'); await prisma.$disconnect(); return; }

  const emit = await agentClient.emitNFCe(store, {
    issuer: store.fiscalIssuer, nNF: NNF,
    items: [{ sku: 'TESTE', name: 'TESTE TROCA V21 ' + CODE, ncm: '64041100', cfop: '5102', unidade: 'UN', qty: 1, unitPrice: 2.00 }],
    payments: [{ tPag: '05', valor: 1.00 }, { tPag: '01', valor: 1.00 }],
  });
  console.log('Split-pay: ' + JSON.stringify({ ok: emit.ok, status: emit.status, motivo: emit.motivo, error: emit.error }).slice(0, 220));
  if (emit.ok && String(emit.status) === '100') {
    const prot = (emit.rawResponse.match(/<nProt>(\d+)<\/nProt>/) || [])[1];
    const c = await agentClient.cancel(store, { issuer: store.fiscalIssuer, accessKey: emit.accessKey, protocol: prot, reason: 'Teste do agente v2.1 na loja - cancelamento imediato' });
    console.log('Cancelado: ' + JSON.stringify({ ok: c.ok, status: c.status }));
    console.log('\n==== ' + CODE + ' COMPLETA: emite, troca e cancela 100% pela maquina da loja ====');
  }
  await prisma.$disconnect();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });

