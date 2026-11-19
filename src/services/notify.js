// =====================================================================
// APEX — Notificações in-app (central de avisos do atleta)
// ---------------------------------------------------------------------
// Grava avisos na tabela AppNotification + push no celular (clubPush, Web
// Push com as chaves VAPID do banco) + WhatsApp quando a Cloud API está ligada. O app lê via
// GET /api/tournaments/notifications/mine e mostra o sininho com contador.
// Nunca derruba o fluxo que chamou: erro aqui é logado, não propagado.
//
// Liga Aberta F4 — WhatsApp SÓ NO QUE O ATLETA ESCOLHEU (regra do projeto: nada de
// mensagem a cliente sem ele pedir). Os tipos de aviso do Club/torneio listados em
// APEX_WA_TYPES só vão pro WhatsApp se a pessoa ligou aquele tipo nas preferências
// (ClubNotifyPref.whatsapp; padrão DESLIGADO — 'organizer' nasce ligado só para conta
// da equipe). Tipo FORA da lista = comportamento antigo (sai se a Cloud API/ponte
// estiver ligada). Os avisos operacionais da loja (ponto do vendedor, agenda do grupo,
// código de verificação, mensagens da equipe, CRM) NÃO passam por este arquivo —
// usam src/whatsapp.js, services/payroll/notify, systemMessenger — e não mudam.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
let prisma = new PrismaClient();
const whatsappCloud = require('./whatsappCloud');
const clubPush = require('./clubPush');

function setPrisma(p) { prisma = p; }

// Tipos de aviso do APEX (torneio, clube, treino, desafio, conquista) → WhatsApp só com preferência.
// Mapa EXPLÍCITO tipo → categoria da preferência (a mesma tela do push).
const APEX_WA_TYPES = Object.freeze({
  result: 'result',        // resultado / súmula fechada / correção / prêmio
  game_soon: 'game_soon',  // jogo em 30 min
  schedule: 'schedule',    // jogo agendado / horário
  training: 'training',    // treinos
  team: 'invite',          // time (entrou, pedido, convite)
  club: 'invite',          // clube permanente
  club_invite: 'invite',
  invite: 'invite',
  entry: 'entry',          // inscrição (do atleta); a do ORGANIZADOR vem com opts.waCategory='organizer'
  challenge: 'challenge',  // desafio 1x1
  badge: 'info',           // conquista do app de atividade (já vai com whatsapp:false)
  role: 'organizer',       // torneio transferido / papel na organização
  info: 'info',            // aviso do Club sem tipo (o padrão do notify) — também só com preferência
});
// Tipo FORA do mapa = comportamento antigo (WhatsApp sai). Hoje nenhum chamador usa tipo fora
// do mapa; o teste da F4 varre todo arquivo que importa este módulo e falha se aparecer um
// tipo novo sem estar aqui (assim nenhum aviso do Club vai pro WhatsApp sem opt-in por engano).

function whatsappOn() { return whatsappCloud.enabled() || !!process.env.WA_BRIDGE_KEY; }

// Decide se ESTE aviso pode ir pro WhatsApp desta pessoa. Não envia nada.
// → { send: bool, reason, category? }
async function whatsappDecision(userId, type, opts = {}) {
  if (opts.whatsapp === false) return { send: false, reason: 'whatsapp:false' };
  if (!whatsappOn()) return { send: false, reason: 'canal desligado' };
  const t = String(type || 'info');
  if (!Object.prototype.hasOwnProperty.call(APEX_WA_TYPES, t)) return { send: true, reason: 'tipo fora do Club (comportamento antigo)' };
  const cat = clubPush.waCategory(t, opts.waCategory || APEX_WA_TYPES[t]);
  const u = await prisma.user.findUnique({ where: { id: String(userId) }, select: { role: true } }).catch(() => null);
  const allowed = await clubPush.whatsappAllowed(userId, cat, { role: u ? u.role : null }).catch(() => false);
  return allowed ? { send: true, reason: 'preferência ligada', category: cat } : { send: false, reason: 'preferência desligada', category: cat };
}

const pending = new Set();
function track(p) { pending.add(p); p.finally(() => pending.delete(p)).catch(() => {}); return p; }
async function flush() { while (pending.size) await Promise.allSettled([...pending]); }

// opts.whatsapp=false → só o sininho (ex: conquistas do app de atividade).
// opts.waCategory → categoria da preferência de WhatsApp (ex: 'organizer' em aviso pro dono do torneio).
async function notify(userId, { type, title, body, link } = {}, opts = {}) {
  if (!userId) return null;
  try {
    const n = await prisma.appNotification.create({
      data: {
        userId,
        type: type || 'info',
        title: title ? String(title).slice(0, 120) : null,
        body: String(body || '').slice(0, 500),
        link: link ? String(link).slice(0, 300) : null,
      },
    });
    // WhatsApp: liga com a Cloud API oficial (WHATSAPP_TOKEN) OU a ponte (WA_BRIDGE_KEY).
    // Sem nenhuma das duas, não faz nada (só o sininho). Aviso do Club: só com a preferência
    // ligada. Nunca derruba o fluxo (best-effort, sem esperar).
    if (opts.whatsapp !== false && whatsappOn()) {
      track(whatsappDecision(userId, n.type, opts)
        .then((d) => (d.send ? enqueueWhatsApp(userId, title, body) : null))
        .catch(() => {}));
    }
    // Push no celular (Club): só pra quem tem inscrição e deixou o tipo ligado. Best-effort.
    clubPush.sendPush(userId, { type: n.type, title, body, link });
    return n;
  } catch (e) {
    console.error('[notify] falhou:', e.message);
    return null;
  }
}

// Enfileira o aviso e, se a Cloud API oficial estiver ligada, envia na hora.
async function enqueueWhatsApp(userId, title, body) {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!u || !u.phone) return;
    const text = (title ? `${title}: ` : '') + String(body || '').slice(0, 900);
    const row = await prisma.whatsAppOutbox.create({ data: { phone: u.phone, body: text, userId } });
    // Envio imediato pela API OFICIAL (se ligada). A ponte não-oficial, se usada, puxa o PENDING.
    if (whatsappCloud.enabled()) {
      const r = await whatsappCloud.sendNotification(u.phone, text);
      await prisma.whatsAppOutbox.update({
        where: { id: row.id },
        data: r.ok ? { status: 'SENT', sentAt: new Date() } : { status: 'FAILED', error: String(r.error || '').slice(0, 300) },
      }).catch(() => {});
    }
  } catch (e) { /* silencioso: WhatsApp é best-effort */ }
}

// Dispara o mesmo aviso pra vários usuários (ex: os 2 da dupla).
// Opcionalmente ignora um userId (ex: não notificar quem fez a ação).
async function notifyMany(userIds, payload, exceptUserId, opts = {}) {
  const seen = new Set();
  const out = [];
  for (const uid of userIds || []) {
    if (!uid || uid === exceptUserId || seen.has(uid)) continue;
    seen.add(uid);
    out.push(await notify(uid, payload, opts));
  }
  return out;
}

module.exports = { notify, notifyMany, whatsappDecision, APEX_WA_TYPES, flush, setPrisma };
