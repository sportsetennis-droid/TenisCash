// =====================================================================
// CRM DE CONTATOS — todo mundo que chega pelo WhatsApp (e DM do Instagram)
// vira contato no CRM DA EMPRESA DONA DO CANAL (dono 2026-11-14:
// "todas as pessoas que chegarem pelo WhatsApp você tem que cadastrar no CRM.
//  Pergunta o nome, pelo nome já cadastra").
//
// Regras:
//  - 1 contato por (empresa, telefone). S&T, Baratão e Meta Fardamentos têm
//    CRMs separados (a mesma pessoa pode existir nos três, sem misturar).
//  - Já é cliente (User TenisCash / MfCustomer)? O nome vem do cadastro e a
//    pessoa NÃO é perguntada.
//  - Senão o sistema pergunta o nome UMA vez, guarda a 1ª mensagem e, quando
//    o nome chega, cadastra e segue o atendimento com a mensagem original.
//  - Resposta que não parece nome (ex: "tem tênis 40?") → não insiste: fica o
//    nome do perfil do WhatsApp como provisório e o atendimento segue.
//  - Nunca pergunta em conversa onde a EQUIPE já está falando (mesma regra do
//    robô: "robô respeita o humano"), nem em mensagem antiga/histórico.
//  - Interruptor por canal: Config 'comms_pergunta_nome_<instância>' = 'off'.
// =====================================================================
const { prisma } = require('../middleware');
const { EMPRESAS, canalByInstance } = require('../config/canais');

const ASK_WINDOW_MS = 24 * 3600 * 1000;   // pergunta vale 24h; depois pode perguntar de novo
const RECENT_MSG_MS = 5 * 60 * 1000;      // só reage a mensagem nova (não a histórico ao parear)
const HUMAN_WINDOW_MS = 30 * 24 * 3600 * 1000;

// ---------------- telefone ----------------
// Canônico BR: 55 + DDD + 9 + 8 dígitos (o WhatsApp às vezes manda sem o 9).
function canonPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) d = d.slice(0, 4) + '9' + d.slice(4);
  return d;
}
function phoneVariants(raw) {
  const c = canonPhone(raw);
  if (!c) return [];
  const out = new Set([c]);
  if (c.startsWith('55')) {
    const local = c.slice(2);
    out.add(local);
    if (local.length === 11 && local[2] === '9') { out.add(local.slice(0, 2) + local.slice(3)); out.add('55' + local.slice(0, 2) + local.slice(3)); }
  }
  return [...out];
}

// ---------------- nome ----------------
const NAO_NOME = new Set(('oi ola ole opa eai salve bom boa dia tarde noite tudo bem sim nao ok okay blz beleza obrigado obrigada valeu vlw ' +
  'quero queria gostaria tem tenho preciso procuro procurando preco valor quanto custa tenis chuteira camisa camiseta short bermuda ' +
  'meia bola mochila bone nike adidas puma asics mizuno olympikus fila umbro penalty hoka reebok numero tamanho loja endereco ' +
  'horario aberto aberta funciona entrega frete pix cartao troca trocar garantia cupom nota menu atendente vendedor pessoa ' +
  'robo ia teste kkk kkkk rs haha hello hi como voce qual quem onde quando favor por pode poderia ver vi foto site link ' +
  'cliente aqui ja compra comprei pedido orcamento fardamento fardamentos uniforme uniformes empresa escola time interesse duvida').split(' '));
const MINUSC = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }

function parseName(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 80 || /[?@\d#/\\]|https?:/i.test(t)) return null;
  t = t.replace(/[.!,;:)\u{1F300}-\u{1FAFF}☀-➿]+$/u, '').trim();
  const m = norm(t).match(/^(?:(?:oi|ola|bom dia|boa tarde|boa noite)[ ,!]*)?(?:o meu nome e|meu nome e|me chamo|eu me chamo|eu sou o|eu sou a|eu sou|sou o|sou a|sou|aqui e o|aqui e a|aqui e|e o|e a)\s+(.+)$/);
  if (m) t = t.slice(t.length - m[1].length).trim();
  t = t.replace(/[.!,;:]+$/, '').trim();
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ' -]{2,60}$/.test(t)) return null;
  const words = t.split(' ').filter(Boolean);
  if (!words.length || words.length > 5) return null;
  if (NAO_NOME.has(norm(words[0]))) return null;
  if (words.some((w) => NAO_NOME.has(norm(w)) && !MINUSC.has(norm(w)))) return null;
  return words.map((w, i) => (i > 0 && MINUSC.has(norm(w)) ? w.toLowerCase()
    : w.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-'))).join(' ');
}
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

// ---------------- payload da Evolution ----------------
function parseEvolution(body) {
  const data = Array.isArray(body && body.data) ? body.data[0] : ((body && body.data) || {});
  const key = data.key || {};
  const jid = String(key.remoteJid || '');
  const isGroup = jid.endsWith('@g.us');
  const altJid = String(key.remoteJidAlt || key.senderPn || data.senderPn || '');
  const isLid = /@lid$/i.test(jid);
  const digits = ((isLid && altJid) ? altJid : jid).replace(/[^0-9]/g, '');
  const m = data.message || {};
  const text = String(m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim();
  const tsSec = Number(data.messageTimestamp) || 0;
  return {
    data, key, jid, altJid, isGroup, fromMe: !!key.fromMe,
    phone: isLid && !altJid ? null : canonPhone(digits),
    lidKey: isLid && !altJid ? jid : null,           // contato @lid sem telefone: chave = jid
    replyTo: isLid && !altJid ? jid : canonPhone(digits),
    pushName: data.pushName || null, text, msgId: key.id || null,
    tsMs: tsSec > 0 ? tsSec * 1000 : Date.now(),
  };
}
function rewriteText(body, newText) {
  const data = Array.isArray(body.data) ? body.data[0] : body.data;
  if (data) data.message = { conversation: newText };
}

// ---------------- interruptor por canal ----------------
const switchCache = new Map(); // instance -> { at, on }
async function askEnabled(instance) {
  const c = switchCache.get(instance);
  if (c && Date.now() - c.at < 60 * 1000) return c.on;
  let on = true;
  try {
    const row = await prisma.config.findUnique({ where: { key: 'comms_pergunta_nome_' + instance } });
    on = !(row && row.value === 'off');
  } catch (_) { /* banco fora: mantém default */ }
  switchCache.set(instance, { at: Date.now(), on });
  return on;
}
async function setAskEnabled(instance, on) {
  const key = 'comms_pergunta_nome_' + instance;
  const value = on ? 'on' : 'off';
  await prisma.config.upsert({ where: { key }, update: { value }, create: { id: key, key, value } });
  switchCache.set(instance, { at: Date.now(), on: !!on });
}

async function humanTalking(instance, jids) {
  try {
    const row = await prisma.whatsappMessage.findFirst({
      where: { instance, chatJid: { in: jids.filter(Boolean) }, fromMe: true, ts: { gte: new Date(Date.now() - HUMAN_WINDOW_MS) } },
      select: { id: true },
    });
    return !!row;
  } catch (_) { return false; }
}

// ---------------- cadastro ----------------
async function findKnownName(empresa, phone) {
  if (!phone) return null;
  const vars = phoneVariants(phone);
  try {
    if (empresa === 'st' || empresa === 'baratao') {
      const u = await prisma.user.findFirst({ where: { phone: { in: vars } }, select: { id: true, name: true } });
      if (u && u.name && u.name.trim().length > 1) return { name: u.name.trim(), userId: u.id };
    }
    if (empresa === 'metafard') {
      const c = await prisma.mfCustomer.findFirst({ where: { phone: { in: vars } }, select: { name: true } });
      if (c && c.name) return { name: c.name.trim(), userId: null };
    }
  } catch (_) { /* sem vínculo */ }
  return null;
}

// Registra (ou atualiza) o contato. Nunca lança.
async function registerContact({ empresa, instance, storeCode, phone, lidKey, profileName, instagram }) {
  const key = phone || lidKey;
  if (!empresa || !key) return null;
  try {
    const now = new Date();
    const existing = await prisma.crmContact.findUnique({ where: { empresa_phone: { empresa, phone: key } } });
    if (existing) {
      return await prisma.crmContact.update({
        where: { id: existing.id },
        data: {
          lastChannel: instance, lastSeenAt: now, messages: { increment: 1 },
          ...(profileName && profileName !== existing.profileName ? { profileName } : {}),
          ...(instagram && !existing.instagram ? { instagram } : {}),
          ...(!existing.storeCode && storeCode ? { storeCode } : {}),
        },
      });
    }
    const known = await findKnownName(empresa, phone);
    return await prisma.crmContact.create({
      data: {
        empresa, phone: key, profileName: profileName || null, instagram: instagram || null,
        firstChannel: instance, lastChannel: instance, storeCode: storeCode || null,
        name: known ? known.name : null, nameSource: known ? 'cadastro' : null,
        nameState: known ? 'ok' : null, userId: known ? known.userId : null, messages: 1,
      },
    }).catch(async (e) => {
      // corrida (2 mensagens juntas): o outro criou primeiro
      if (String(e.code) === 'P2002') return prisma.crmContact.findUnique({ where: { empresa_phone: { empresa, phone: key } } });
      throw e;
    });
  } catch (e) {
    console.error('[crm] falha ao registrar contato:', e.message);
    return null;
  }
}

function askText(empresa) {
  const nome = (EMPRESAS[empresa] || {}).nome || 'nossa loja';
  if (empresa === 'st') return `Oi! 🧡 Que bom te ver por aqui na *${nome}*.\nPra eu te atender pelo nome: *como você se chama?*`;
  return `Olá! Seja bem-vindo(a) à *${nome}*.\nPra eu te atender pelo nome: *como você se chama?*`;
}
function thanksText(empresa, name, mode, hasPending) {
  const n = firstName(name);
  const heart = empresa === 'st' ? ' 🧡' : '';
  if (mode === 'loja') return `Prazer, ${n}!${heart} Já anotei aqui. Alguém da nossa equipe já te responde por aqui.`;
  return hasPending ? `Prazer, ${n}!${heart}` : `Prazer, ${n}!${heart} Em que posso te ajudar?`;
}

// Porteiro do nome. Devolve:
//   { action: 'stop' }                 → já respondemos (pergunta/agradecimento), não seguir
//   { action: 'continue', text }       → seguir o fluxo normal com esse texto
async function nameGate({ contact, canal, text, send }) {
  if (!contact || contact.name || contact.nameState === 'ok' || contact.nameState === 'desistiu') return { action: 'continue', text };
  const awaiting = contact.nameState === 'aguardando' && contact.nameAskedAt && (Date.now() - new Date(contact.nameAskedAt).getTime() < ASK_WINDOW_MS);

  if (awaiting) {
    const name = parseName(text);
    if (name) {
      const pending = contact.pendingText || null;
      await prisma.crmContact.update({ where: { id: contact.id }, data: { name, nameSource: 'perguntado', nameState: 'ok', pendingText: null } }).catch(() => {});
      console.log(`[crm] ${canal.empresa}: nome cadastrado "${name}" (${contact.phone})`);
      await send(thanksText(canal.empresa, name, canal.mode, !!pending)).catch(() => {});
      return pending ? { action: 'continue', text: pending } : { action: 'stop' };
    }
    // Não parece nome: não insiste. Fica o nome do perfil e o atendimento segue.
    const joined = [contact.pendingText, text].filter(Boolean).join('\n');
    await prisma.crmContact.update({ where: { id: contact.id }, data: { nameState: 'desistiu', pendingText: null } }).catch(() => {});
    return { action: 'continue', text: joined };
  }

  // 1º contato sem nome: pergunta e guarda a mensagem pra responder depois.
  await prisma.crmContact.update({
    where: { id: contact.id },
    data: { nameState: 'aguardando', nameAskedAt: new Date(), pendingText: text ? String(text).slice(0, 2000) : null },
  }).catch(() => {});
  const r = await send(askText(canal.empresa)).catch((e) => ({ ok: false, error: e.message }));
  console.log(`[crm] ${canal.empresa}/${canal.instance}: perguntou o nome de ${contact.phone} -> ${r && r.ok ? 'OK' : 'FALHOU ' + (r && r.error)}`);
  if (!r || !r.ok) {
    // não conseguiu perguntar: libera o fluxo pra não travar o cliente
    await prisma.crmContact.update({ where: { id: contact.id }, data: { nameState: null, nameAskedAt: null, pendingText: null } }).catch(() => {});
    return { action: 'continue', text };
  }
  return { action: 'stop' };
}

// Cadastra o remetente de um payload da Evolution no CRM da empresa do canal.
async function registerFromEvolution(instance, body) {
  const canal = canalByInstance(instance);
  const parsed = parseEvolution(body);
  if (!canal || parsed.isGroup || parsed.fromMe || !parsed.jid || parsed.jid === 'status@broadcast') return { canal, parsed, contact: null };
  const contact = await registerContact({
    empresa: canal.empresa, instance, storeCode: canal.storeCode,
    phone: parsed.phone, lidKey: parsed.lidKey, profileName: parsed.pushName,
  });
  return { canal, parsed, contact };
}

// Aplica o porteiro do nome (só mensagem nova, interruptor do canal ligado,
// e sem a equipe conversando com a pessoa).
async function applyGate({ canal, parsed, contact, text, send }) {
  const t = text === undefined ? parsed.text : text;
  if (!canal || !contact) return { action: 'continue', text: t };
  if (Date.now() - parsed.tsMs > RECENT_MSG_MS) return { action: 'continue', text: t };
  if (!(await askEnabled(canal.instance))) return { action: 'continue', text: t };
  // Antes de PERGUNTAR (não ao receber a resposta): se a equipe já fala com a pessoa, não se mete.
  if (!contact.name && !contact.nameState && await humanTalking(canal.instance, [parsed.jid, parsed.altJid])) return { action: 'continue', text: t };
  const sender = send || ((msg) => require('../whatsapp').sendEvolutionRaw(parsed.replyTo, msg, canal.instance));
  return nameGate({ contact, canal, text: t, send: sender });
}

// Atalho: cadastra + porteiro (canais de loja e canais com robô próprio).
async function handleEvolutionInbound({ instance, body, send }) {
  const r = await registerFromEvolution(instance, body);
  if (!r.contact) return { action: 'continue', ...r, text: r.parsed.text };
  const g = await applyGate({ ...r, send });
  return { ...g, ...r };
}

module.exports = {
  canonPhone, phoneVariants, parseName, parseEvolution, rewriteText,
  askEnabled, setAskEnabled, registerContact, nameGate, registerFromEvolution, applyGate, handleEvolutionInbound, humanTalking,
};
