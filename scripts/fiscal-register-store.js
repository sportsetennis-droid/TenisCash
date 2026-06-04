// =====================================================================
// fiscal-register-store.js  — cadastra/atualiza o emissor fiscal de UMA loja
// =====================================================================
// Cada loja = 1 CNPJ = 1 FiscalIssuer. Faz upsert do FiscalIssuer (por CNPJ)
// e liga na Store (por code), setando o Fiscal Agent.
//
// IDEMPOTENTE: re-rodar NÃO reseta a numeração (nfceNextNumber só é semeado
// em 100000 na PRIMEIRA criação; depois é preservado).
//
// USO:
//   1) Preencha o bloco CONFIG abaixo com os dados DA LOJA.
//   2) Rode na matriz:  node scripts/fiscal-register-store.js
//   3) Confira a saída (deve terminar com "OK — pronto pra emitir").
// Ver runbook: agents/fiscal-agent/DEPLOY-NOVA-LOJA.md
// =====================================================================

// ----------------------- EDITE AQUI POR LOJA -------------------------
const CONFIG = {
  storeCode: 'LOJA03',                 // Store.code (a Store já tem que existir no banco)
  cnpj: '44052617000398',              // só dígitos (14)
  companyName: 'Meta Esportes Ltda',
  fantasyName: 'Sports & Tennis Rainha da Borborema',
  ie: 'INFORMAR',                      // Inscrição Estadual da loja (PB)
  // Endereço (cabeçalho da NFC-e)
  street: 'INFORMAR',
  number: 'INFORMAR',
  complement: '',
  neighborhood: 'INFORMAR',
  city: 'Campina Grande',
  cityCode: '2504009',                 // IBGE 7 díg (João Pessoa=2507507, Campina Grande=2504009)
  state: 'PB',
  zip: 'INFORMAR',
  phone: '',
  // NFC-e — pegar da config da Chianca da loja (codigo_csc + identificador_csc) ou portal SEFAZ-PB
  csc: 'INFORMAR',
  cscId: '000002',                     // idCSC (string, ex '000001' / '000002')
  crt: 3,                              // 3 = Regime Normal
  // Fiscal Agent (do setup.ps1 + tailscale funnel da loja)
  fiscalAgentUrl: 'https://HOST-DA-LOJA.tail0386f5.ts.net',
  fiscalAgentToken: 'INFORMAR',        // AGENT_TOKEN impresso pelo setup.ps1
};
// ---------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function die(msg) { console.error('ABORTADO:', msg); process.exit(1); }

(async () => {
  const c = CONFIG;
  // Validações
  const cnpj = String(c.cnpj).replace(/\D/g, '');
  if (cnpj.length !== 14) die('cnpj inválido (precisa 14 dígitos): ' + c.cnpj);
  for (const k of ['storeCode', 'companyName', 'ie', 'street', 'neighborhood', 'city', 'cityCode', 'csc', 'cscId', 'fiscalAgentUrl', 'fiscalAgentToken']) {
    if (!c[k] || /INFORMAR|HOST-DA-LOJA/.test(String(c[k]))) die('campo nao preenchido: ' + k + ' = ' + c[k]);
  }
  if (!/^\d{7}$/.test(String(c.cityCode))) die('cityCode precisa ser 7 dígitos IBGE: ' + c.cityCode);

  // Store tem que existir
  const store = await prisma.store.findUnique({ where: { code: c.storeCode } });
  if (!store) die('Store nao encontrada pelo code "' + c.storeCode + '". Crie a Store primeiro (ou ajuste o code).');

  const issuerData = {
    companyName: c.companyName, fantasyName: c.fantasyName || c.companyName,
    ie: c.ie, street: c.street, number: c.number || 'S/N', complement: c.complement || null,
    neighborhood: c.neighborhood, city: c.city, cityCode: String(c.cityCode), state: c.state || 'PB',
    zip: String(c.zip).replace(/\D/g, ''), phone: c.phone || null,
    csc: c.csc, cscId: c.cscId, crt: c.crt || 3,
    environment: 'production', active: true, nfceSerie: 1,
  };

  // Upsert do FiscalIssuer por CNPJ. nfceNextNumber só na criação (NÃO reseta em update).
  const issuer = await prisma.fiscalIssuer.upsert({
    where: { cnpj },
    create: { cnpj, ...issuerData, nfceNextNumber: 100000, nfeSerie: 1, nfeNextNumber: 1 },
    update: issuerData, // sem nfceNextNumber -> preserva a numeração existente
  });

  // Liga a Store no issuer + Fiscal Agent
  await prisma.store.update({
    where: { id: store.id },
    data: {
      fiscalIssuerId: issuer.id,
      fiscalAgentUrl: c.fiscalAgentUrl.replace(/\/$/, ''),
      fiscalAgentToken: c.fiscalAgentToken,
      fiscalAgentEnabled: true,
    },
  });

  // Verificação
  const chk = await prisma.fiscalIssuer.findUnique({ where: { id: issuer.id } });
  const s = await prisma.store.findUnique({ where: { id: store.id } });
  console.log('\n=== EMISSOR CADASTRADO ===');
  console.log('Store:', s.name, '(' + s.code + ')');
  console.log('CNPJ:', chk.cnpj, '| IE:', chk.ie, '| CRT:', chk.crt, '| env:', chk.environment, '| ativo:', chk.active);
  console.log('CSC:', (chk.csc || '').slice(0, 8) + '... | idCSC:', chk.cscId);
  console.log('Endereço:', chk.street, chk.number, '-', chk.neighborhood + ',', chk.city + '/' + chk.state, '(IBGE', chk.cityCode + ')');
  console.log('nfceSerie:', chk.nfceSerie, '| nfceNextNumber:', chk.nfceNextNumber);
  console.log('Agent: enabled=' + s.fiscalAgentEnabled, '| url=' + s.fiscalAgentUrl, '| token=' + (s.fiscalAgentToken ? '***' + s.fiscalAgentToken.slice(-4) : 'VAZIO'));
  const faltam = [!chk.csc && 'CSC', !chk.ie && 'IE', !s.fiscalAgentUrl && 'fiscalAgentUrl', !s.fiscalAgentToken && 'token'].filter(Boolean);
  console.log(faltam.length ? '\n⚠️ FALTA: ' + faltam.join(', ') : '\n✅ OK — pronto pra emitir. Rode o teste de validação (runbook 3.5) antes da venda real.');
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); }).finally(() => prisma.$disconnect());
