// =====================================================================
// pagbank-register-store.js — cadastra a conta PagBank de UMA loja
// =====================================================================
// Seta Store.pagbankToken / pagbankPixKey / pagbankSandbox / pagbankEnabled.
// O TOKEN É SEGREDO: vem do AMBIENTE, NUNCA fica no código (nem commitado).
// Usa SQL cru (não depende do client regenerado).
//
// USO (PowerShell, na matriz):
//   $env:PAGBANK_TOKEN  = 'SEU_TOKEN_DA_LOJA'
//   $env:PAGBANK_PIXKEY = 'chave-pix-da-conta'   # opcional (auditoria)
//   node scripts/pagbank-register-store.js LOJA02            # sandbox (default)
//   node scripts/pagbank-register-store.js LOJA02 --prod     # produção
//   node scripts/pagbank-register-store.js LOJA02 --off      # desliga o fluxo PIX-QR
// =====================================================================

const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const storeCode = process.argv[2];
const sandbox = !process.argv.includes('--prod');
const enabled = !process.argv.includes('--off');
const token = process.env.PAGBANK_TOKEN;
const pixKey = process.env.PAGBANK_PIXKEY || null;

function die(m) { console.error('ABORTADO:', m); process.exit(1); }

(async () => {
  if (!storeCode) die('uso: node scripts/pagbank-register-store.js <STORECODE> [--prod] [--off]  (env: PAGBANK_TOKEN, PAGBANK_PIXKEY)');
  if (enabled && !token) die('PAGBANK_TOKEN não definido. Ex (PowerShell): $env:PAGBANK_TOKEN="seu_token"; node scripts/pagbank-register-store.js ' + storeCode);
  const store = await prisma.$queryRawUnsafe('SELECT id, name, code FROM "Store" WHERE code = $1', storeCode);
  if (!store.length) die('Store não encontrada pelo code: ' + storeCode);

  await prisma.$executeRawUnsafe(
    'UPDATE "Store" SET "pagbankToken" = $1, "pagbankPixKey" = $2, "pagbankSandbox" = $3, "pagbankEnabled" = $4 WHERE code = $5',
    enabled ? token : null, pixKey, sandbox, enabled, storeCode
  );

  const chk = await prisma.$queryRawUnsafe(
    'SELECT code, "pagbankPixKey", "pagbankSandbox", "pagbankEnabled", (CASE WHEN "pagbankToken" IS NULL THEN \'VAZIO\' ELSE \'***\' || right("pagbankToken", 4) END) tok FROM "Store" WHERE code = $1',
    storeCode
  );
  const r = chk[0];
  console.log('\n=== PagBank cadastrado ===');
  console.log('Loja:', store[0].name, '(' + r.code + ')');
  console.log('token:', r.tok, '| pixKey:', r.pagbankPixKey || '(não setada)');
  console.log('sandbox:', r.pagbanksandbox ?? r.pagbankSandbox, '| enabled:', r.pagbankenabled ?? r.pagbankEnabled);
  console.log(enabled ? '\n✅ pronto. Teste no sandbox antes de --prod.' : '\n✅ PIX-QR DESLIGADO nessa loja.');
  await prisma.$disconnect();
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
