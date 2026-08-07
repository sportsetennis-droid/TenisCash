// =====================================================================
// fiscal-swap-cert.js — troca o certificado A1 da emissão fiscal (1 comando)
// =====================================================================
// Uso:  node scripts/fiscal-swap-cert.js "<caminho do .pfx>" "<senha>" [--apply]
//
// O que faz (na ordem):
//   1. Valida o PFX com openssl: CN, CNPJ, validade. EXIGE CNPJ-base
//      44052617 (Meta Esportes — o CNPJ dos FiscalIssuer). Cert de outro
//      CNPJ-base a SEFAZ rejeita com cStat 290 (--force pula a trava,
//      só use se os issuers migrarem de CNPJ).
//   2. --apply: sobe PFX_BASE64 + PFX_SENHA no serviço fiscal-agent-cloud
//      (Railway; setar variável já redeploya sozinho) — é ele que atende
//      as 6 lojas hoje (Store.fiscalAgentUrl).
//   3. --apply: troca o arquivo local C:\Chianca\NFe_Emissao001\Certificado2026.pfx
//      (com backup .vencido.bak) — usado pelo Chianca ERP e pelo agente da
//      matriz (failover FISCAL_EXTRA_AGENTS) — e reinicia a task do agente.
//   4. Espera o /health do cloud voltar com o cert novo.
//
// Depois: node scripts/fiscal-test-emit.js LOJA02 9000NN  (emite R$ baixo + cancela)
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const CLOUD_SERVICE = 'fiscal-agent-cloud';
const CLOUD_HEALTH = 'https://fiscal-agent-cloud-production.up.railway.app/health';
const CHIANCA_PFX = 'C:\\Chianca\\NFe_Emissao001\\Certificado2026.pfx';
const CNPJ_BASE_ESPERADO = '44052617';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const [pfxPath, senha] = args;

function die(msg) { console.error('❌ ' + msg); process.exit(1); }

if (!pfxPath || !senha) {
  die('Uso: node scripts/fiscal-swap-cert.js "<caminho.pfx>" "<senha>" [--apply]');
}
if (!fs.existsSync(pfxPath)) die('PFX não encontrado: ' + pfxPath);

// --- 1. Valida o certificado ---
let certPem;
try {
  certPem = execFileSync('openssl', ['pkcs12', '-in', pfxPath, '-clcerts', '-nokeys', '-passin', 'pass:' + senha, '-legacy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch {
  try { // openssl sem suporte a -legacy (PFX moderno AES)
    certPem = execFileSync('openssl', ['pkcs12', '-in', pfxPath, '-clcerts', '-nokeys', '-passin', 'pass:' + senha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e2) {
    die('openssl não abriu o PFX — senha errada? (' + String(e2.message).slice(0, 120) + ')');
  }
}
const info = execFileSync('openssl', ['x509', '-noout', '-subject', '-startdate', '-enddate'], { input: certPem, encoding: 'utf8' });
const cn = (info.match(/CN\s*=\s*([^\n,]+)/) || [])[1] || '?';
const notAfterStr = (info.match(/notAfter=(.+)/) || [])[1];
const notAfter = notAfterStr ? new Date(notAfterStr) : null;
const cnpjCert = (cn.match(/(\d{14})/) || [])[1] || '';

console.log('Certificado:', cn.trim());
console.log('Válido até :', notAfter ? notAfter.toISOString() : '?');

if (!notAfter || notAfter.getTime() < Date.now() + 24 * 3600 * 1000) {
  die('Certificado vencido ou vencendo em <24h — não adianta subir.');
}
if (!cnpjCert.startsWith(CNPJ_BASE_ESPERADO)) {
  const msg = 'CNPJ do cert (' + (cnpjCert || '?') + ') NÃO é do grupo ' + CNPJ_BASE_ESPERADO + ' — a SEFAZ rejeita nota das lojas com ele (cStat 290).';
  if (!FORCE) die(msg + ' Use --force SÓ se os FiscalIssuer tiverem migrado de CNPJ.');
  console.warn('⚠️ ' + msg + ' (--force: seguindo mesmo assim)');
}
console.log('✅ Certificado válido pro grupo ' + cnpjCert.slice(0, 8));

if (!APPLY) {
  console.log('\nDRY-RUN (nada alterado). Com --apply eu faço:');
  console.log('  1. Railway ' + CLOUD_SERVICE + ': PFX_BASE64 + PFX_SENHA novos (redeploya sozinho)');
  console.log('  2. Troca ' + CHIANCA_PFX + ' (backup .vencido.bak) + reinicia task TenisCashFiscalAgent');
  console.log('  3. Espera o /health do cloud voltar');
  console.log('  4. Você roda: node scripts/fiscal-test-emit.js LOJA02 9000NN');
  process.exit(0);
}

// --- 2. Sobe pro fiscal-agent-cloud (Railway) ---
const b64 = fs.readFileSync(pfxPath).toString('base64');
console.log('\n[1/3] Subindo cert novo pro ' + CLOUD_SERVICE + ' (' + b64.length + ' chars base64)…');
execSync(`railway variables --set "PFX_BASE64=${b64}" --set "PFX_SENHA=${senha}" --service ${CLOUD_SERVICE}`, { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });

// --- 3. Troca o PFX local (Chianca ERP + agente da matriz) ---
console.log('[2/3] Trocando PFX local da matriz/Chianca…');
try {
  if (fs.existsSync(CHIANCA_PFX)) {
    const bak = CHIANCA_PFX + '.vencido-' + new Date().toISOString().slice(0, 10) + '.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(CHIANCA_PFX, bak);
  }
  fs.copyFileSync(pfxPath, CHIANCA_PFX);
  console.log('  arquivo trocado:', CHIANCA_PFX);
  try {
    execSync('schtasks /end /tn TenisCashFiscalAgent', { stdio: 'ignore' });
    execSync('schtasks /run /tn TenisCashFiscalAgent', { stdio: 'ignore' });
    console.log('  agente da matriz reiniciado (task TenisCashFiscalAgent)');
  } catch { console.warn('  ⚠️ não reiniciei a task TenisCashFiscalAgent — reinicie manual'); }
} catch (e) {
  console.warn('  ⚠️ falha ao trocar o PFX local (' + e.message + ') — troque na mão e reinicie a task');
}

// --- 4. Espera o cloud voltar ---
console.log('[3/3] Esperando o ' + CLOUD_SERVICE + ' redeployar (até 5 min)…');
(async () => {
  const deadline = Date.now() + 5 * 60 * 1000;
  await new Promise(r => setTimeout(r, 20000)); // dá tempo do deploy começar
  while (Date.now() < deadline) {
    try {
      const r = await fetch(CLOUD_HEALTH, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.ok && j.pfxSize > 0) {
        console.log('✅ Cloud no ar: v' + j.version + ' pfxSize=' + j.pfxSize);
        console.log('\nAGORA TESTE: node scripts/fiscal-test-emit.js LOJA02 9000NN (número novo, R$ baixo, cancela no fim)');
        console.log('As vendas pendentes re-emitem sozinhas no próximo ciclo do robô fiscal (~10 min).');
        process.exit(0);
      }
    } catch { /* deploy em andamento */ }
    await new Promise(r => setTimeout(r, 10000));
  }
  console.warn('⚠️ /health não confirmou em 5 min — confira: railway logs --service ' + CLOUD_SERVICE);
})();
