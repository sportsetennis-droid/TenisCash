// Lista os grupos de WhatsApp da instância Evolution (pra achar o JID do grupo da empresa).
// Uso: node scripts/list-whatsapp-groups.js
// Depois: cole o JID em WHATSAPP_GROUP_JID no .env (e no Railway).
require('dotenv').config();

const URL = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const KEY = process.env.EVOLUTION_API_KEY;
const INST = process.env.EVOLUTION_INSTANCE || 'teniscash';

(async () => {
  if (!URL || !KEY) {
    console.error('❌ Evolution não configurado no .env (EVOLUTION_API_URL / EVOLUTION_API_KEY).');
    process.exit(1);
  }
  const endpoint = `${URL}/group/fetchAllGroups/${encodeURIComponent(INST)}?getParticipants=false`;
  let data;
  try {
    const r = await fetch(endpoint, { headers: { apikey: KEY } });
    data = await r.json().catch(() => null);
    if (!r.ok) {
      console.error(`❌ Evolution respondeu ${r.status}:`, JSON.stringify(data));
      console.error('   Dica: a instância precisa estar CONECTADA (número pareado).');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Erro de conexão com a Evolution:', e.message);
    process.exit(1);
  }

  const groups = Array.isArray(data) ? data : (data?.groups || []);
  if (!groups.length) {
    console.log('⚠️  Nenhum grupo retornado. A instância "' + INST + '" está conectada e participa de algum grupo?');
    return;
  }

  groups.sort((a, b) => String(a.subject || '').localeCompare(String(b.subject || '')));
  console.log(`\n📋 ${groups.length} grupo(s) na instância "${INST}":\n`);
  for (const g of groups) {
    console.log(`• ${g.subject || '(sem nome)'}`);
    console.log(`    JID: ${g.id}`);
    if (g.size != null) console.log(`    membros: ${g.size}`);
    console.log('');
  }
  console.log('👉 Copie o JID do GRUPO DA EMPRESA e coloque em WHATSAPP_GROUP_JID (.env e Railway).');
})();
