// =====================================================================
// leadRouter.js — passa o cliente do WhatsApp pra um HUMANO da loja certa.
// Ordem de quem recebe:
//   1. vendedor ESCALADO HOJE naquela loja (escala mensal)
//   2. vendedor da escala semanal fixa daquele dia
//   3. WhatsApp da própria loja (bio do Instagram)
//   4. grupo de vendedores (último recurso, nunca deixa o cliente sem ninguém)
// O vendedor recebe um resumo pronto + link pra chamar o cliente.
// Anti-repetição: mesmo cliente + mesma loja + mesmo motivo = 1 aviso a cada 2h.
// =====================================================================
const { prisma } = require('../middleware');
const { sendCustomMessage, sendEvolutionRaw } = require('../whatsapp');
const { findLoja, fmtPhone } = require('../config/lojasContato');

const DEDUPE_MS = 2 * 60 * 60 * 1000;
const recent = new Map(); // chave -> { at, result }

const MOTIVO_LABEL = { venda: '🛒 Quer comprar', troca: '🔁 Troca', garantia: '🛠️ Garantia' };

function ymdFortaleza(d = new Date()) {
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function hhmmFortaleza(d = new Date()) {
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(11, 16);
}
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || null; }

// Vendedores escalados hoje na loja (quem está no horário primeiro).
async function sellersOnShift(storeCode) {
  const store = await prisma.store.findUnique({ where: { code: storeCode }, select: { id: true } });
  if (!store) return [];
  const ymd = ymdFortaleza();
  const now = hhmmFortaleza();
  const workDate = new Date(ymd + 'T03:00:00.000Z'); // mesmo formato do adminSchedule

  const pick = (rows) => rows
    .filter(r => r.seller && r.seller.active !== false && r.seller.phone)
    .sort((a, b) => {
      const ina = a.startTime <= now && now < a.endTime ? 0 : 1;
      const inb = b.startTime <= now && now < b.endTime ? 0 : 1;
      return ina - inb;
    })
    .map(r => ({ id: r.seller.id, name: r.seller.name, phone: r.seller.phone, inShift: r.startTime <= now && now < r.endTime }));

  const monthly = await prisma.sellerMonthlyShift.findMany({
    where: { storeId: store.id, workDate },
    include: { seller: { select: { id: true, name: true, phone: true, active: true } } },
  }).catch(() => []);
  let list = pick(monthly);
  if (list.length) return list;

  const weekday = new Date(ymd + 'T12:00:00.000Z').getUTCDay();
  const weekly = await prisma.sellerSchedule.findMany({
    where: { storeId: store.id, weekday, active: true },
    include: { seller: { select: { id: true, name: true, phone: true, active: true } } },
  }).catch(() => []);
  return pick(weekly);
}

// Distribui entre os vendedores do turno (não manda tudo pro mesmo).
const rr = new Map();
function roundRobin(storeCode, list) {
  const inShift = list.filter(s => s.inShift);
  const pool = inShift.length ? inShift : list;
  const i = (rr.get(storeCode) || 0) % pool.length;
  rr.set(storeCode, i + 1);
  return pool[i];
}

/**
 * @param {object} p
 * @param {string} p.loja     nome/código da loja ("Bessa", "LOJA05"...)
 * @param {'venda'|'troca'|'garantia'} p.motivo
 * @param {{phone:string,name?:string}} p.cliente
 * @param {string} p.resumo   o que o cliente quer (produto, tamanho, problema)
 * @returns {Promise<{ok:boolean, loja?:object, vendedor?:string|null, via?:string, already?:boolean, error?:string}>}
 */
async function routeLead({ loja: lojaQ, motivo = 'venda', cliente, resumo }) {
  const loja = findLoja(lojaQ);
  if (!loja) return { ok: false, error: 'loja nao encontrada: ' + lojaQ };
  const clientPhone = String((cliente && cliente.phone) || '').replace(/\D/g, '');
  if (!clientPhone) return { ok: false, error: 'telefone do cliente ausente' };

  const key = clientPhone + '|' + loja.code + '|' + motivo;
  const prev = recent.get(key);
  if (prev && Date.now() - prev.at < DEDUPE_MS) return { ...prev.result, already: true };

  const nomeCliente = (cliente && cliente.name) || 'Cliente';
  const msg =
    '🔔 *Cliente do WhatsApp — ' + (loja.hidden ? 'Loja online (site)' : 'loja ' + loja.nome) + '*\n' +
    (MOTIVO_LABEL[motivo] || motivo) + '\n\n' +
    '👤 ' + nomeCliente + ' · ' + fmtPhone(clientPhone) + '\n' +
    '📝 ' + String(resumo || '').slice(0, 600) + '\n\n' +
    '👉 Chama agora: wa.me/' + clientPhone + '\n' +
    '_Atendimento automático já avisou o cliente que você vai chamar._';

  let result = null;
  try {
    const sellers = await sellersOnShift(loja.code);
    if (sellers.length) {
      const s = roundRobin(loja.code, sellers);
      const r = await sendCustomMessage(s.phone, msg);
      if (r && r.ok) result = { ok: true, loja, vendedor: firstName(s.name), via: 'vendedor' };
      else console.warn('[leadRouter] falha ao avisar vendedor', s.name, r && r.error);
    }
  } catch (e) { console.warn('[leadRouter] escala:', e.message); }

  if (!result && loja.whatsapp) {
    const r = await sendCustomMessage(loja.whatsapp, msg).catch(e => ({ ok: false, error: e.message }));
    if (r && r.ok) result = { ok: true, loja, vendedor: null, via: 'whatsapp-loja' };
  }

  if (!result) {
    const grupo = process.env.EVOLUTION_GRUPO_VENDEDORES || '120363418791122078@g.us';
    const r = await sendEvolutionRaw(grupo, msg).catch(e => ({ ok: false, error: e.message }));
    result = r && r.ok ? { ok: true, loja, vendedor: null, via: 'grupo' } : { ok: false, loja, error: (r && r.error) || 'nao consegui avisar ninguem' };
  }

  console.log('[leadRouter] ' + motivo + ' ' + clientPhone + ' -> ' + loja.code + ' via ' + (result.via || 'FALHA') + (result.vendedor ? ' (' + result.vendedor + ')' : ''));
  if (result.ok) recent.set(key, { at: Date.now(), result });
  return result;
}

module.exports = { routeLead, sellersOnShift, _ymdFortaleza: ymdFortaleza };
