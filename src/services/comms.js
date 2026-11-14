// =====================================================================
// COMUNICAÇÃO — status dos canais, pareamento e mensagens ENTRE canais.
// ---------------------------------------------------------------------
// Uma empresa só fala pelos PRÓPRIOS canais (S&T ↔ S&T, Baratão ↔ Baratão,
// Meta Fardamentos ↔ Meta Fardamentos). Mandar pelo canal de outra empresa
// é recusado aqui, no servidor.
// =====================================================================
const { prisma } = require('../middleware');
const { EMPRESAS, CANAIS, canalByInstance, canaisDaEmpresa } = require('../config/canais');
const { sendEvolutionRaw } = require('../whatsapp');
const crm = require('./crmContacts');

const EVO = (process.env.EVOLUTION_API_URL || '').replace(/[^\x21-\x7E]/g, '').replace(/\/+$/, '');
const KEY = (process.env.EVOLUTION_API_KEY || '').replace(/[^\x21-\x7E]/g, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.APP_URL || 'https://teniscash.com.br').replace(/\/+$/, '');
const WEBHOOK_URL = PUBLIC_URL + '/api/whatsapp/evolution';

async function evo(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  if (!EVO || !KEY) throw new Error('Evolution não configurado');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(EVO + path, {
      method, signal: ctrl.signal,
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, body: j };
  } finally { clearTimeout(timer); }
}

async function liveInstances() {
  const map = {};
  try {
    const r = await evo('/instance/fetchInstances');
    const arr = Array.isArray(r.body) ? r.body : (r.body.instances || []);
    for (const it of arr) {
      const i = it.instance || it;
      const name = i.instanceName || i.name;
      if (!name) continue;
      map[name] = {
        status: i.connectionStatus || i.status || i.state || 'unknown',
        number: String(i.ownerJid || i.number || i.owner || '').replace(/\D/g, '') || null,
        profileName: i.profileName || null,
      };
    }
  } catch (_) { /* Evolution fora: tudo "unknown" */ }
  return map;
}

// Visão geral por empresa: cada canal com status ao vivo + CRM.
async function overview() {
  const live = await liveInstances();
  const now = new Date();
  const fort = new Date(now.getTime() - 3 * 3600 * 1000);
  const startDay = new Date(Date.UTC(fort.getUTCFullYear(), fort.getUTCMonth(), fort.getUTCDate(), 3, 0, 0));
  const empresas = [];
  for (const emp of Object.values(EMPRESAS)) {
    const canais = [];
    for (const c of canaisDaEmpresa(emp.key)) {
      const l = live[c.instance];
      const [contatos, novosHoje, askOn] = await Promise.all([
        prisma.crmContact.count({ where: { empresa: emp.key, firstChannel: c.instance } }).catch(() => null),
        prisma.crmContact.count({ where: { empresa: emp.key, firstChannel: c.instance, firstSeenAt: { gte: startDay } } }).catch(() => null),
        crm.askEnabled(c.instance),
      ]);
      canais.push({
        instance: c.instance, label: c.label, storeCode: c.storeCode, mode: c.mode,
        whatsapp: c.whatsapp, instagram: c.instagram,
        exists: !!l, status: l ? l.status : 'nao_criado', connectedNumber: l ? l.number : null,
        numberMismatch: !!(l && l.number && c.whatsapp && crm.canonPhone(l.number) !== crm.canonPhone(c.whatsapp)),
        perguntaNome: askOn, contatos, novosHoje,
      });
    }
    const [total, semNome, hoje] = await Promise.all([
      prisma.crmContact.count({ where: { empresa: emp.key } }).catch(() => null),
      prisma.crmContact.count({ where: { empresa: emp.key, name: null } }).catch(() => null),
      prisma.crmContact.count({ where: { empresa: emp.key, firstSeenAt: { gte: startDay } } }).catch(() => null),
    ]);
    empresas.push({ ...emp, canais, crm: { total, semNome, novosHoje: hoje } });
  }
  return { evolutionConfigured: !!(EVO && KEY), webhookUrl: WEBHOOK_URL, empresas };
}

function assertCanal(instance) {
  const c = canalByInstance(instance);
  if (!c) { const e = new Error('Canal desconhecido'); e.status = 404; throw e; }
  return c;
}

// Cria a instância (se não existir), garante o webhook e devolve o QR pra ler no celular da loja.
async function connectCanal(instance) {
  const canal = assertCanal(instance);
  const live = await liveInstances();
  let created = false;
  if (!live[instance]) {
    const r = await evo('/instance/create', {
      method: 'POST',
      body: {
        instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true,
        webhook: { url: WEBHOOK_URL, byEvents: false, base64: false, events: ['MESSAGES_UPSERT'] },
      },
    });
    if (!r.ok && r.status !== 403 && r.status !== 409) throw new Error('Não consegui criar o número na Evolution (HTTP ' + r.status + ')');
    created = r.ok;
  }
  // Webhook sempre apontando pro nosso servidor (idempotente).
  await evo('/webhook/set/' + encodeURIComponent(instance), {
    method: 'POST',
    body: { webhook: { enabled: true, url: WEBHOOK_URL, byEvents: false, base64: false, events: ['MESSAGES_UPSERT'] } },
  }).catch(() => null);

  const st = await evo('/instance/connectionState/' + encodeURIComponent(instance)).catch(() => null);
  const state = st && st.body ? ((st.body.instance && st.body.instance.state) || st.body.state) : null;
  if (state === 'open') return { instance, label: canal.label, created, state: 'open', qr: null };
  const c = await evo('/instance/connect/' + encodeURIComponent(instance));
  const b = c.body || {};
  const qr = b.base64 || (b.qrcode && b.qrcode.base64) || null;
  const pairingCode = b.pairingCode || null;
  return { instance, label: canal.label, created, state: (b.instance && b.instance.state) || 'connecting', qr, pairingCode };
}

function mesmaEmpresa(a, b) { return a && b && a.empresa === b.empresa; }

// Manda texto por um canal. "to" = instância de outro canal (mesma empresa) OU telefone.
async function sendFromCanal({ from, to, text, actor }) {
  const origem = assertCanal(from);
  const msg = String(text || '').trim();
  if (!msg) { const e = new Error('Mensagem vazia'); e.status = 400; throw e; }
  let destino = canalByInstance(to);
  let numero;
  if (destino) {
    if (!mesmaEmpresa(origem, destino)) { const e = new Error(`Bloqueado: ${EMPRESAS[origem.empresa].nome} não fala pelo canal de ${EMPRESAS[destino.empresa].nome}`); e.status = 403; throw e; }
    if (!destino.whatsapp) { const e = new Error(`${destino.label} não tem WhatsApp cadastrado`); e.status = 400; throw e; }
    numero = crm.canonPhone(destino.whatsapp);
  } else {
    numero = crm.canonPhone(to);
    if (!numero || numero.length < 12) { const e = new Error('Destino inválido'); e.status = 400; throw e; }
  }
  const r = await sendEvolutionRaw(numero, msg, origem.instance);
  console.log(`[comms] ${actor || 'admin'}: ${origem.instance} -> ${destino ? destino.instance : numero}: ${r.ok ? 'OK' : 'FALHOU ' + r.error}`);
  if (!r.ok) { const e = new Error('Envio falhou: ' + (r.error || 'canal desconectado?')); e.status = 502; throw e; }
  return { ok: true, from: origem.instance, to: destino ? destino.instance : numero, messageId: r.messageId || null };
}

// Repassa um cliente do CRM de um canal pro WhatsApp de outro canal da MESMA empresa.
async function repassarCliente({ from, to, contactId, nota, actor }) {
  const origem = assertCanal(from);
  const destino = assertCanal(to);
  if (!mesmaEmpresa(origem, destino)) { const e = new Error('Repasse só entre canais da mesma empresa'); e.status = 403; throw e; }
  const ct = await prisma.crmContact.findUnique({ where: { id: String(contactId || '') } });
  if (!ct || ct.empresa !== origem.empresa) { const e = new Error('Contato não encontrado nesta empresa'); e.status = 404; throw e; }
  const nome = ct.name || ct.profileName || 'Cliente';
  const fone = /^\d+$/.test(ct.phone) ? ct.phone : null;
  const linhas = [
    `📲 *Cliente repassado* — de ${origem.label} para ${destino.label}`,
    `👤 ${nome}${ct.name ? '' : ' (nome do perfil)'}`,
    fone ? `📞 wa.me/${fone}` : (ct.instagram ? `📷 @${ct.instagram}` : null),
    nota ? `📝 ${String(nota).trim().slice(0, 500)}` : null,
  ].filter(Boolean);
  const r = await sendFromCanal({ from, to, text: linhas.join('\n'), actor });
  await prisma.crmContact.update({
    where: { id: ct.id },
    data: { notes: [ct.notes, `${new Date().toISOString().slice(0, 16)} repassado ${origem.instance}→${destino.instance}${nota ? ': ' + String(nota).slice(0, 200) : ''}`].filter(Boolean).join('\n') },
  }).catch(() => {});
  return r;
}

module.exports = { overview, connectCanal, sendFromCanal, repassarCliente, liveInstances, WEBHOOK_URL, CANAIS };
