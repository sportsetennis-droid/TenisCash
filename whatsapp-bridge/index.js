// =====================================================================
// Ponte WhatsApp (NAO-OFICIAL) do TenisCash.
// ---------------------------------------------------------------------
// RODA numa maquina que fica LIGADA o tempo todo (PC da loja / VPS).
// NAO roda no Railway (o container reinicia e perde a sessao do WhatsApp).
//
// Fluxo: mostra o QR -> voce escaneia com o WhatsApp -> conecta -> puxa os
// avisos pendentes do TenisCash (fila /api/wa/pending) e envia, devagar.
//
// ⚠️ AVISO: automatizar envio e CONTRA as regras do WhatsApp. O numero que
//    escanear PODE SER BANIDO. Use um numero DEDICADO, nao o do atendimento.
//
// Variaveis de ambiente:
//   WA_BRIDGE_KEY   (obrigatoria) a MESMA chave secreta configurada no servidor
//   TENISCASH_API   (opcional)    default https://teniscash.com.br
//   WA_POLL_MS      (opcional)    intervalo de verificacao (default 15000)
//   WA_SEND_GAP_MS  (opcional)    pausa entre envios (default 4000, reduz ban)
// =====================================================================

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const API = (process.env.TENISCASH_API || 'https://teniscash.com.br').replace(/\/+$/, '');
const KEY = process.env.WA_BRIDGE_KEY || '';
const POLL_MS = Number(process.env.WA_POLL_MS || 15000);
const GAP_MS = Number(process.env.WA_SEND_GAP_MS || 4000);

if (!KEY) {
  console.error('\n[ERRO] Defina WA_BRIDGE_KEY (a mesma chave secreta do servidor TenisCash).\n');
  process.exit(1);
}
if (typeof fetch !== 'function') {
  console.error('\n[ERRO] Precisa de Node 18 ou mais novo (tem fetch embutido).\n');
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }), // sessao salva aqui
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', (qr) => {
  console.log('\n================ ESCANEIE O QR ================');
  console.log('No WhatsApp: Configuracoes > Aparelhos conectados > Conectar aparelho\n');
  qrcode.generate(qr, { small: true });
  console.log('\n(o QR troca a cada ~20s; se sumir, espere o proximo aparecer)\n');
});
client.on('authenticated', () => console.log('🔑 Autenticado. Preparando...'));
client.on('auth_failure', (m) => console.error('✗ Falha de autenticacao:', m));
client.on('disconnected', (r) => console.error('⚠️ Desconectado:', r, '\nReabra o programa pra reconectar.'));

let running = false;
async function pump() {
  if (running) return; running = true;
  try {
    const r = await fetch(`${API}/api/wa/pending?key=${encodeURIComponent(KEY)}&limit=20`);
    if (!r.ok) { running = false; return; }
    const data = await r.json().catch(() => ({}));
    const msgs = data.messages || [];
    for (const m of msgs) {
      const digits = String(m.phone || '').replace(/\D/g, '');
      if (!digits) { await markSent(m.id, false, 'telefone vazio'); continue; }
      try {
        const num = await client.getNumberId(digits); // confirma que o numero tem WhatsApp
        if (!num) { await markSent(m.id, false, 'sem WhatsApp'); continue; }
        await client.sendMessage(num._serialized, String(m.body || ''));
        await markSent(m.id, true);
        console.log('→ enviado para', digits);
      } catch (e) {
        await markSent(m.id, false, String((e && e.message) || e));
        console.error('✗ falhou', digits, (e && e.message) || e);
      }
      await sleep(GAP_MS); // devagar de proposito: reduz risco de ban
    }
  } catch (e) { /* rede caiu: tenta no proximo ciclo */ }
  running = false;
}
async function markSent(id, ok, error) {
  try {
    await fetch(`${API}/api/wa/sent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, id, ok: !!ok, error: error || null }),
    });
  } catch (e) { /* tenta de novo depois */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

client.on('ready', () => {
  console.log('\n✅ WhatsApp conectado! Enviando os avisos do TenisCash.');
  console.log('   Deixe este programa ABERTO. Fechou = para de enviar.\n');
  pump();
  setInterval(pump, POLL_MS);
});

console.log('Iniciando a ponte WhatsApp do TenisCash... (aguarde o QR)');
client.initialize();
