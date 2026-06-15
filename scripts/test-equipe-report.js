// Testa o relatório de vendas SEM enviar nada (read-only, mostra o texto no terminal).
// Uso:
//   node scripts/test-equipe-report.js            (checkpoint 13h)
//   node scripts/test-equipe-report.js 18
//   node scripts/test-equipe-report.js 21
//
// Para ENVIAR de verdade pro grupo (precisa WHATSAPP_GROUP_JID setado + instância conectada):
//   node scripts/test-equipe-report.js 13 --send
require('dotenv').config();

(async () => {
  const arg = parseInt(process.argv[2], 10);
  const hour = [13, 18, 21].includes(arg) ? arg : 13;
  const doSend = process.argv.includes('--send');

  const { buildSalesReport, sendSalesReport, vendasGroupJid } = require('../src/services/equipeReports');

  if (doSend) {
    const jid = vendasGroupJid();
    if (!jid) {
      console.error('❌ WHATSAPP_GROUP_JID não configurado — não há pra onde enviar. Rode list-whatsapp-groups.js primeiro.');
      process.exit(1);
    }
    console.log(`📤 Enviando relatório ${hour}h para o grupo ${jid} ...`);
    const out = await sendSalesReport(hour);
    console.log(out.sent ? '✅ Enviado.' : `❌ Não enviado: ${out.error || out.reason}`);
    console.log('\n--- texto ---\n' + (out.text || ''));
    process.exit(out.sent ? 0 : 1);
  }

  const text = await buildSalesReport(hour);
  console.log('\n================ PREVIEW (não enviado) ================\n');
  console.log(text);
  console.log('\n======================================================');
  console.log('Para enviar de verdade: node scripts/test-equipe-report.js ' + hour + ' --send');
  process.exit(0);
})().catch((e) => {
  console.error('Erro:', e);
  process.exit(1);
});
