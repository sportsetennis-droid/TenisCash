// A IA NAO pode oferecer tamanho que so existe no comprado (NFe), sem loja.
// E precisa ACHAR o produto certo mesmo na busca "marca + modelo".
require('dotenv').config();
const { getAttendantReply } = require('../src/services/aiAttendant');

(async () => {
  const casos = [
    { phone: '558300000044', text: 'tem o kappa sparta no 44?' }, // 44 comprado SEM loja -> NAO
    { phone: '558300000042', text: 'tem o kappa sparta no 42? me manda o link' }, // 42 em loja -> SIM
    { phone: '558300000444', text: 'tem o speedcross 6 no 44?' }, // 44 comprado SEM loja -> NAO
    { phone: '558300000442', text: 'tem o speedcross 6 no 42? me manda o link' }, // 42 em loja -> SIM
  ];
  for (const c of casos) {
    console.log('\n>>> ' + c.text);
    const r = await getAttendantReply({ phone: c.phone, text: c.text, pushName: 'Teste' });
    console.log(r.reply || JSON.stringify(r));
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERRO:', e);
  process.exit(1);
});
