/* =====================================================================
 * baratao-connect.js — conecta o WhatsApp do BARATAO DOS ESPORTES ao Evolution
 * =====================================================================
 * O que faz (idempotente):
 *   1. Cria a instancia 'baratao' no servidor Evolution (o mesmo da S&T).
 *   2. Aponta o webhook dela pro TenisCash (/api/whatsapp/evolution).
 *   3. Gera o QR (salvo em tmp/) e, se voce passar o numero, o CODIGO DE PAREAMENTO.
 *
 * IMPORTANTE — NAO DERRUBA O WHATSAPP ATUAL:
 *   A Evolution conecta como APARELHO VINCULADO (igual WhatsApp Web / multi-device).
 *   O WhatsApp do numero do Baratao continua funcionando no celular normalmente;
 *   o robo passa a RECEBER as mensagens em paralelo. Pra parear, no celular do
 *   Baratao: WhatsApp > Aparelhos conectados > Conectar um aparelho > escaneia o QR.
 *
 * COMO RODAR (precisa das chaves do Evolution, que estao no Railway):
 *   railway run node scripts/baratao-connect.js                 # cria + gera QR
 *   railway run node scripts/baratao-connect.js --status        # so checa o estado
 *   BARATAO_NUMBER=5583XXXXXXXX railway run node scripts/baratao-connect.js   # + codigo de pareamento
 *
 * Variaveis (tem default, so sobrescreva se precisar):
 *   EVOLUTION_API_URL, EVOLUTION_API_KEY        (do servidor Evolution)
 *   BARATAO_EVOLUTION_INSTANCE  = baratao
 *   BARATAO_NUMBER              = (opcional — so pra gerar codigo de pareamento)
 *   BARATAO_WEBHOOK_URL         = https://teniscash.com.br/api/whatsapp/evolution
 * ===================================================================== */

const fs = require('fs');
const path = require('path');

const EVO_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const EVO_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.BARATAO_EVOLUTION_INSTANCE || 'baratao';
const NUMBER = (process.env.BARATAO_NUMBER || '').replace(/\D/g, ''); // opcional
const WEBHOOK_URL =
  process.env.BARATAO_WEBHOOK_URL ||
  `${(process.env.BARATAO_WEBHOOK_BASE || 'https://teniscash.com.br').replace(/\/+$/, '')}/api/whatsapp/evolution`;
const EVENTS = ['MESSAGES_UPSERT'];

const STATUS_ONLY = process.argv.includes('--status');

async function api(method, p, body) {
  const res = await fetch(`${EVO_URL}${p}`, {
    method,
    headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* sem corpo */ }
  return { status: res.status, ok: res.ok, json };
}

async function getState() {
  const r = await api('GET', `/instance/connectionState/${encodeURIComponent(INSTANCE)}`);
  if (r.ok && r.json) return r.json.instance?.state || r.json.state || 'unknown';
  return null; // nao existe ainda
}

async function main() {
  if (!EVO_URL || !EVO_KEY) {
    console.error('\n❌ EVOLUTION_API_URL / EVOLUTION_API_KEY ausentes.');
    console.error('   Rode com as chaves do servidor Evolution. Ex (prod):');
    console.error('     railway run node scripts/baratao-connect.js\n');
    process.exit(1);
  }

  console.log('=== Baratao dos Esportes — conexao WhatsApp (Evolution) ===');
  console.log('Servidor :', EVO_URL);
  console.log('Instancia:', INSTANCE);
  console.log('Numero   :', NUMBER || '(nao informado — pareia por QR)');
  console.log('Webhook  :', WEBHOOK_URL);
  console.log('');

  let state = await getState();
  console.log('Estado atual:', state || '(instancia nao existe)');

  if (STATUS_ONLY) {
    if (state === 'open') console.log('✅ Numero PAREADO e conectado.');
    else if (state) console.log('⚠️  Instancia existe mas NAO esta conectada (state=' + state + '). Rode sem --status pra parear.');
    else console.log('ℹ️  Instancia ainda nao foi criada. Rode sem --status.');
    return;
  }

  // 1. Cria a instancia se nao existir
  if (!state) {
    console.log('\n→ Criando instancia...');
    const create = await api('POST', '/instance/create', {
      instanceName: INSTANCE,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    });
    if (!create.ok) {
      console.error('❌ Falha ao criar instancia:', create.status, JSON.stringify(create.json));
      process.exit(1);
    }
    console.log('✅ Instancia criada.');
  } else if (state === 'open') {
    console.log('\n✅ Ja esta conectada. Nada a parear.');
  }

  // 2. Aponta o webhook pro TenisCash (sempre, pra garantir que esta certo)
  console.log('\n→ Configurando webhook...');
  const wh = await api('POST', `/webhook/set/${encodeURIComponent(INSTANCE)}`, {
    webhook: { enabled: true, url: WEBHOOK_URL, webhookByEvents: false, webhookBase64: false, events: EVENTS },
  });
  if (wh.ok) console.log('✅ Webhook configurado:', WEBHOOK_URL);
  else console.warn('⚠️  Webhook pode nao ter sido setado:', wh.status, JSON.stringify(wh.json));

  // 3. Parear (se ainda nao conectado): gera QR (e codigo de pareamento se tiver numero)
  state = await getState();
  if (state === 'open') {
    console.log('\n✅ Numero PAREADO e conectado. Pronto.');
    return;
  }

  console.log('\n→ Gerando pareamento...');
  const connPath = NUMBER
    ? `/instance/connect/${encodeURIComponent(INSTANCE)}?number=${NUMBER}`
    : `/instance/connect/${encodeURIComponent(INSTANCE)}`;
  const conn = await api('GET', connPath);
  if (!conn.ok) {
    console.error('❌ Falha ao gerar pareamento:', conn.status, JSON.stringify(conn.json));
    process.exit(1);
  }
  const j = conn.json || {};
  const pairing = j.pairingCode || j.code || (j.instance && j.instance.pairingCode);
  const base64 = j.base64 || j.qrcode?.base64 || (j.instance && j.instance.qrcode && j.instance.qrcode.base64);

  if (base64) {
    const tmp = path.join(__dirname, '..', 'tmp');
    try { fs.mkdirSync(tmp, { recursive: true }); } catch {}
    const file = path.join(tmp, 'baratao-qr.png');
    const raw = String(base64).replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(file, Buffer.from(raw, 'base64'));
    console.log('🖼️  QR salvo em:', file);
  }

  console.log('\n==================================================');
  if (pairing) {
    console.log('   CODIGO DE PAREAMENTO:  ' + String(pairing).replace(/(.{4})(.{4})/, '$1-$2'));
    console.log('--------------------------------------------------');
    console.log('   No celular do BARATAO DOS ESPORTES:');
    console.log('   WhatsApp > Aparelhos conectados > Conectar um aparelho');
    console.log('   > Conectar com numero de telefone > digite o codigo acima.');
  } else {
    console.log('   Abra o QR salvo em tmp/baratao-qr.png e escaneie no');
    console.log('   WhatsApp do Baratao (Aparelhos conectados > Conectar um aparelho).');
    console.log('   (NAO derruba o WhatsApp atual — entra como aparelho vinculado.)');
  }
  console.log('==================================================');
  console.log('\nDepois de parear, confirme com:  railway run node scripts/baratao-connect.js --status');
}

main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
