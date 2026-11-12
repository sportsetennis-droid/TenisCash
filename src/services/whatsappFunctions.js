// =====================================================================
// whatsappFunctions.js — FUNÇÕES PELO WHATSAPP (TenisCash 2.0)
// O cliente pede pelo WhatsApp da loja, o sistema roda por dentro e entrega
// no próprio WhatsApp. Roda ANTES do atendente de IA: se a mensagem é um
// pedido de função, responde aqui e a IA nem é chamada.
//
// Funções disponíveis:
//   • 2ª via do cupom fiscal ("2 via", "segunda via", "perdi meu cupom"...)
//   • menu ("menu", "funções", "ajuda") — lista o que dá pra pedir
//
// SEGURANÇA/LGPD: só entrega cupom LIGADO AO NÚMERO de quem pediu (cliente
// cadastrado com esse telefone, cliente do vendedor com esse telefone, ou
// cupom que já foi enviado pra esse número). Nunca busca por CPF digitado
// — senão qualquer um pediria o cupom de outra pessoa.
//
// Pra criar uma função nova: escrever um handler { name, match(text), run(ctx) }
// e colocar em FUNCTIONS. O menu se monta sozinho.
// =====================================================================
const { prisma } = require('../middleware');
const { sendCustomMessage } = require('../whatsapp');
const { deliverCupom } = require('./cupomDelivery');

const LOOKBACK_DAYS = 365;     // cupons de até 1 ano atrás
const MAX_LIST = 5;            // no máximo 5 cupons na lista
const PENDING_TTL_MS = 10 * 60 * 1000; // escolha da lista vale 10 min

// telefone -> { docIds: [...], expires } (cliente escolhendo na lista)
const pending = new Map();

// ---------- utilidades ----------
function norm(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ª|º/g, 'a')
    .replace(/\s+/g, ' ')
    .trim();
}

// Todas as formas que o mesmo número pode estar gravado no banco:
// com/sem 55 e com/sem o 9º dígito (o WhatsApp às vezes manda sem o 9).
function phoneVariants(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return [];
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  const locals = new Set([d]);
  if (rest.length === 9 && rest.startsWith('9')) locals.add(ddd + rest.slice(1)); // sem o 9
  if (rest.length === 8) locals.add(ddd + '9' + rest);                             // com o 9
  const out = new Set();
  for (const l of locals) { out.add(l); out.add('55' + l); }
  return [...out];
}

function fmtMoney(v) {
  return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' });
}
function storeName(doc) {
  return (doc.issuer && (doc.issuer.fantasyName || doc.issuer.companyName)) || 'Sports & Tennis';
}

// ---------- busca dos cupons do número ----------
async function findCuponsForPhone(phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return [];
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000);

  const [users, clients] = await Promise.all([
    prisma.user.findMany({ where: { phone: { in: variants } }, select: { id: true, cpf: true } }),
    prisma.sellerClient.findMany({ where: { phone: { in: variants } }, select: { id: true } }),
  ]);
  const userIds = users.map(u => u.id);
  const clientIds = clients.map(c => c.id);
  const cpfs = users.map(u => String(u.cpf || '').replace(/\D/g, '')).filter(c => c.length === 11);

  let saleIds = [];
  if (userIds.length || clientIds.length) {
    const or = [];
    if (userIds.length) or.push({ customerUserId: { in: userIds } });
    if (clientIds.length) or.push({ clientId: { in: clientIds } });
    const sales = await prisma.sale.findMany({ where: { OR: or, createdAt: { gte: since } }, select: { id: true } });
    saleIds = sales.map(s => s.id);
  }

  // cupom que já foi mandado pra esse número antes (botão do PDV)
  let sentIds = [];
  try {
    const rows = await prisma.$queryRaw`
      SELECT id FROM "FiscalDocument"
      WHERE "createdAt" >= ${since} AND response->>'waTo' = ANY(${variants})`;
    sentIds = rows.map(r => r.id);
  } catch (e) { /* busca extra: não derruba a função */ }

  const or = [];
  if (saleIds.length) or.push({ saleId: { in: saleIds } });
  if (sentIds.length) or.push({ id: { in: sentIds } });
  // CPF do PRÓPRIO cadastro desse número (não CPF digitado)
  for (const cpf of cpfs) or.push({ recipientCnpjCpf: cpf });
  if (!or.length) return [];

  return prisma.fiscalDocument.findMany({
    where: {
      AND: [
        { OR: or },
        // devolução de troca (NF-e 55 pra própria empresa) não é cupom de compra.
        // Cupom SEM CPF (null) tem que continuar entrando: NOT sozinho descartaria o null.
        { OR: [{ recipientCnpjCpf: null }, { NOT: { recipientCnpjCpf: { startsWith: '44052617' } } }] },
      ],
      status: 'authorized',
      accessKey: { not: null },
      docType: { in: ['NFCE', 'NFE'] },
      createdAt: { gte: since },
    },
    include: { issuer: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_LIST,
  });
}

// ---------- função: 2ª via do cupom ----------
const SEGUNDA_VIA = {
  name: '2ª via do cupom fiscal',
  hint: 'escreva *2 via*',
  match(t) {
    if (/\b(2|segunda) ?a? ?via\b/.test(t)) return true;
    // pergunta geral ("vocês emitem nota?") não é pedido de 2ª via
    if (/(emite|emitem|emitir|tem nota|da nota|dao nota|sai com nota|com nota fiscal\?)/.test(t)) return false;
    const docWord = /\b(cupom|cupon|nota|nf|nfce|nfc-e|comprovante)\b/.test(t);
    const intent = /(reenvi|mand|envi|perdi|precis|quero|cade|segunda|2 via|copia)/.test(t);
    return docWord && intent;
  },
  async run({ phone, pushName }) {
    const docs = await findCuponsForPhone(phone);
    const nome = pushName ? ' ' + String(pushName).split(' ')[0] : '';
    if (!docs.length) {
      return reply(phone,
        'Oi' + nome + '! Procurei aqui e não encontrei cupom fiscal ligado a este número de WhatsApp. 🧾\n\n' +
        'Pode ser que a compra tenha sido registrada com outro telefone. Fala com a loja onde você comprou que o vendedor reenvia na hora. 💚');
    }
    if (docs.length === 1) return sendDoc(docs[0], phone);

    pending.set(phone, { docIds: docs.map(d => d.id), expires: Date.now() + PENDING_TTL_MS });
    const lines = docs.map((d, i) =>
      (i + 1) + ') ' + fmtDate(d.createdAt) + ' · ' + storeName(d) + ' · R$ ' + fmtMoney(d.totalValue));
    return reply(phone,
      'Oi' + nome + '! Achei estes cupons no seu número 🧾\n\n' + lines.join('\n') +
      '\n\nResponda só com o *número* do cupom que você quer (ex: 1).');
  },
};

async function sendDoc(doc, phone) {
  const d = doc.issuer ? doc : await prisma.fiscalDocument.findUnique({ where: { id: doc.id }, include: { issuer: true } });
  const out = await deliverCupom(d, phone, { prisma, force: true, source: 'whatsapp-2via' });
  console.log('[wa-funcoes] 2a via cupom ' + d.number + ' -> ' + phone + ': ' + (out.ok ? 'OK ' + out.via : 'FALHA ' + out.error));
  if (!out.ok) {
    await reply(phone, 'Tentei te mandar o cupom mas deu um erro aqui. 😕 Fala com a loja que eles reenviam na hora.');
  }
  return out;
}

// ---------- função: menu ----------
const MENU = {
  name: 'menu',
  match: (t) => /^(menu|funcoes|funcao|ajuda|opcoes|opcao|servicos)[!?.]*$/.test(t),
  async run({ phone }) {
    const items = FUNCTIONS.filter(f => f !== MENU).map((f, i) => (i + 1) + ') ' + f.name + ' — ' + f.hint);
    return reply(phone,
      '📲 *O que eu resolvo pra você por aqui:*\n\n' + items.join('\n') +
      '\n\nOu é só escrever o que você procura que eu te ajudo. 🙂');
  },
};

const FUNCTIONS = [MENU, SEGUNDA_VIA];

function reply(phone, text) {
  return sendCustomMessage(phone, text).catch(e => ({ ok: false, error: e.message }));
}

// ---------- entrada: chamada pelo webhook ----------
// Retorna true se a mensagem foi tratada aqui (aí a IA NÃO responde).
async function tryHandle({ phone, text, pushName }) {
  try {
    const t = norm(text);
    // remetente sem número de telefone utilizável (ex: id @lid) -> segue o fluxo normal
    if (!phone || !t || !phoneVariants(phone).length) return false;

    // resposta da lista ("1", "2"...)
    const p = pending.get(phone);
    if (p) {
      if (Date.now() > p.expires) pending.delete(phone);
      else {
        const m = t.match(/^(\d)$/);
        if (m) {
          const idx = Number(m[1]) - 1;
          if (idx >= 0 && idx < p.docIds.length) {
            pending.delete(phone);
            const doc = await prisma.fiscalDocument.findUnique({ where: { id: p.docIds[idx] }, include: { issuer: true } });
            if (doc) await sendDoc(doc, phone);
            return true;
          }
        }
      }
    }

    for (const f of FUNCTIONS) {
      if (f.match(t)) {
        console.log('[wa-funcoes] ' + phone + ' pediu: ' + f.name);
        await f.run({ phone, text, pushName });
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('[wa-funcoes] erro:', err.message);
    return false; // em erro, deixa a IA seguir normalmente
  }
}

module.exports = { tryHandle, phoneVariants, findCuponsForPhone, _norm: norm, _functions: FUNCTIONS };
