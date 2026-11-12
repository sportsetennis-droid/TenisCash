// =====================================================================
// whatsappFunctions.js — FUNÇÕES PELO WHATSAPP (TenisCash 2.0)
// O cliente pede pelo WhatsApp da loja, o sistema roda por dentro e entrega
// no próprio WhatsApp. Roda ANTES do atendente de IA: se a mensagem é um
// pedido de função, responde aqui e a IA nem é chamada.
//
// Funções disponíveis:
//   • RECEPÇÃO: "oi"/"menu" -> menu humano com 7 opções (comprar, troca,
//     garantia, 2ª via, lojas, site, Founder & CEO)
//   • 2ª via do cupom fiscal ("2 via", "segunda via", "perdi meu cupom"...)
//   • troca / garantia: pergunta a loja + o caso e passa pro vendedor de turno
//   • nossas lojas: endereço, mapa, WhatsApp e Instagram de cada loja
// "Quero comprar" segue pra IA (estoque real), que passa o lead pro vendedor.
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
    const nome = pushName ? ', ' + String(pushName).split(' ')[0] : '';
    if (!docs.length) {
      return reply(phone,
        'Oi' + nome + '! Procurei aqui e não encontrei cupom fiscal ligado a este número de WhatsApp. 🧾\n\n' +
        'Pode ser que a compra tenha sido registrada com outro telefone. Fala com a loja onde você comprou que o vendedor reenvia na hora. 🧡');
    }
    if (docs.length === 1) return sendDoc(docs[0], phone);

    setState(phone, 'cupom', { docIds: docs.map(d => d.id) });
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

// =====================================================================
// RECEPÇÃO (triagem): o cliente diz "oi" e recebe o menu humano.
// Estado por telefone: menu | cupom | tg_loja | tg_desc (vale 30 min).
// =====================================================================
const { SITE, CEO, LOJAS, findLoja, mapsLink, fmtPhone } = require('../config/lojasContato');
const { routeLead } = require('./leadRouter');

const STATE_TTL_MS = 30 * 60 * 1000;
const state = new Map(); // phone -> { stage, data, expires }
function setState(phone, stage, data = {}) { state.set(phone, { stage, data, expires: Date.now() + STATE_TTL_MS }); }
function getState(phone) {
  const s = state.get(phone);
  if (!s) return null;
  if (Date.now() > s.expires) { state.delete(phone); return null; }
  return s;
}
function clearState(phone) { state.delete(phone); }
function firstName(n) { const f = String(n || '').trim().split(/\s+/)[0]; return f && !/^\d+$/.test(f) ? f : ''; }
const oiNome = (pushName) => (firstName(pushName) ? ', ' + firstName(pushName) : '');

// Lojas físicas que aparecem pro cliente (a loja online vem separada)
const LOJAS_FISICAS = LOJAS.filter(l => !l.hidden);
const ONLINE_NOME = 'Loja online (site)';

function isGreeting(t) {
  if (!/^(oi+e?|ola+|opa|eai|e ai|ei|hey|hello|alo|bom dia|boa tarde|boa noite|boa)\b/.test(t)) return false;
  if (/(tenis|chuteira|tamanho|numero|preco|valor|tem |camisa|bola|meia|short|mochila|\d)/.test(t)) return false;
  return t.split(' ').length <= 6;
}

function menuText(pushName) {
  return 'Oi' + oiNome(pushName) + '! Aqui é a *Sports & Tennis* 🧡 Que bom ter você por aqui.\n' +
    'Me conta, como posso te ajudar?\n\n' +
    '1️⃣ Quero comprar\n' +
    '2️⃣ Troca\n' +
    '3️⃣ Garantia\n' +
    '4️⃣ 2ª via do cupom fiscal\n' +
    '5️⃣ Nossas lojas (endereço, mapa, WhatsApp e Instagram)\n' +
    '6️⃣ Nosso site\n' +
    '7️⃣ Fale com o Founder & CEO\n\n' +
    'É só responder com o número 😉';
}

function lojasText() {
  const blocos = LOJAS_FISICAS.map(l => {
    const linhas = ['📍 *' + l.nome + '* — ' + l.local + (l.cidade !== 'João Pessoa' ? ' • ' + l.cidade : '')];
    linhas.push('🗺️ ' + mapsLink(l));
    if (l.whatsapp) linhas.push('💬 ' + fmtPhone(l.whatsapp) + ' · wa.me/' + l.whatsapp);
    if (l.instagram) linhas.push('📸 instagram.com/' + l.instagram);
    return linhas.join('\n');
  });
  return '*Nossas lojas* 🏬\n\n' + blocos.join('\n\n') + '\n\n🛍️ Loja online: ' + SITE;
}

function lojaPickText(motivo) {
  const head = motivo === 'garantia' ? 'Vamos cuidar disso pra você 🛠️' : 'Claro, a gente resolve sua troca! 🔁';
  const opts = LOJAS_FISICAS.map((l, i) => (i + 1) + ') ' + l.nome).concat((LOJAS_FISICAS.length + 1) + ') ' + ONLINE_NOME);
  return head + '\nEm qual loja você comprou?\n\n' + opts.join('\n') + '\n\nResponda com o número.';
}

function startTrocaGarantia(phone, motivo) {
  setState(phone, 'tg_loja', { motivo });
  return reply(phone, lojaPickText(motivo));
}

async function finishTrocaGarantia(phone, pushName, data, descricao) {
  clearState(phone);
  const lojaNome = data.online ? ONLINE_NOME : data.lojaNome;
  const r = await routeLead({
    loja: data.online ? 'online' : data.lojaCode,
    motivo: data.motivo,
    cliente: { phone, name: pushName },
    resumo: 'Comprou em: ' + lojaNome + '\n' + descricao,
  });
  const loja = data.online ? null : findLoja(data.lojaCode);
  let txt = r.ok
    ? 'Pronto' + oiNome(pushName) + '! ✅ Já passei seu caso pra ' + (r.vendedor ? '*' + r.vendedor + '*, da ' : 'equipe da ') +
      '*' + lojaNome + '*. Em breve te chamam aqui no WhatsApp. 🧡'
    : 'Anotei tudo' + oiNome(pushName) + '! 📝 Nossa equipe vai te chamar no WhatsApp em breve. 🧡';
  if (loja && loja.whatsapp) txt += '\n\nSe preferir, fala direto com a loja: wa.me/' + loja.whatsapp;
  if (!data.online) txt += '\n\nDica: leva o produto e, se tiver, o cupom (pede a 2ª via aqui escrevendo *2 via*).';
  return reply(phone, txt);
}

const OPCOES = {
  1: ({ phone, pushName }) => {
    clearState(phone);
    return reply(phone, 'Show' + oiNome(pushName) + '! 😄 Me conta o que você procura (modelo, marca ou esporte) e o seu tamanho, que eu já confiro no estoque das lojas.');
  },
  2: ({ phone }) => startTrocaGarantia(phone, 'troca'),
  3: ({ phone }) => startTrocaGarantia(phone, 'garantia'),
  4: (ctx) => { clearState(ctx.phone); return SEGUNDA_VIA.run(ctx); },
  5: ({ phone }) => { clearState(phone); return reply(phone, lojasText()); },
  6: ({ phone }) => {
    clearState(phone);
    return reply(phone, '🛍️ Nossa loja online: ' + SITE + '\n\nQualquer dúvida sobre um produto, é só me chamar aqui. 😉');
  },
  7: ({ phone }) => {
    clearState(phone);
    return reply(phone,
      'Você pode falar direto com o ' + CEO.titulo + ' da Sports & Tennis, *' + CEO.nome + '* 🧡\n' +
      '👉 wa.me/' + CEO.whatsapp + '\n\nEle acompanha pessoalmente as mensagens que chegam por lá.');
  },
};

// ---------- funções acionadas por palavra (fora do menu) ----------
const MENU = {
  name: 'menu',
  match: (t) => /^(menu|funcoes|funcao|ajuda|opcoes|opcao|servicos|inicio|voltar)[!?.]*$/.test(t) || isGreeting(t),
  run({ phone, pushName }) {
    setState(phone, 'menu');
    return reply(phone, menuText(pushName));
  },
};
const LOJAS_FN = {
  name: 'nossas lojas',
  match: (t) => /(endereco|onde fica|onde ficam|localizacao|quais lojas|suas lojas|nossas lojas|instagram|whatsapp da loja|numero da loja|telefone da loja)/.test(t),
  run: ({ phone }) => reply(phone, lojasText()),
};
const TROCA_FN = {
  name: 'troca',
  match: (t) => /\b(trocar|troca)\b/.test(t),
  run: ({ phone }) => startTrocaGarantia(phone, 'troca'),
};
const GARANTIA_FN = {
  name: 'garantia',
  match: (t) => /\b(garantia|defeito|descolou|descolando|rasgou|quebrou)\b/.test(t),
  run: ({ phone }) => startTrocaGarantia(phone, 'garantia'),
};

const FUNCTIONS = [MENU, SEGUNDA_VIA, LOJAS_FN, TROCA_FN, GARANTIA_FN];

function reply(phone, text) {
  return sendCustomMessage(phone, text).catch(e => ({ ok: false, error: e.message }));
}

// ---------- respostas a um estado aberto ----------
async function handleState(s, { phone, t, text, pushName }) {
  if (/^(cancelar|cancela|sair|parar)$/.test(t)) {
    clearState(phone);
    await reply(phone, 'Tudo bem! Se precisar de algo, é só escrever *menu*. 😉');
    return true;
  }
  const digit = (t.match(/^(\d)[.)!]?$/) || [])[1];

  if (s.stage === 'menu') {
    const byWord = /^(comprar|quero comprar|compra)$/.test(t) ? 1 : /^(troca|trocar)$/.test(t) ? 2 : /^garantia$/.test(t) ? 3 : null;
    const n = digit ? Number(digit) : byWord;
    if (n && OPCOES[n]) { await OPCOES[n]({ phone, text, pushName }); return true; }
    clearState(phone); // escreveu outra coisa: segue o fluxo normal (funções/IA)
    return false;
  }

  if (s.stage === 'cupom') {
    if (digit) {
      const idx = Number(digit) - 1;
      if (idx >= 0 && idx < s.data.docIds.length) {
        clearState(phone);
        const doc = await prisma.fiscalDocument.findUnique({ where: { id: s.data.docIds[idx] }, include: { issuer: true } });
        if (doc) await sendDoc(doc, phone);
        return true;
      }
    }
    clearState(phone);
    return false;
  }

  if (s.stage === 'tg_loja') {
    let loja = null; let online = false;
    if (digit) {
      const i = Number(digit) - 1;
      if (i >= 0 && i < LOJAS_FISICAS.length) loja = LOJAS_FISICAS[i];
      else if (i === LOJAS_FISICAS.length) online = true;
    } else if (/(site|online|internet)/.test(t)) online = true;
    else loja = findLoja(t);
    if (!loja && !online) {
      await reply(phone, 'Não entendi a loja 😅 Responde só com o número da lista, por favor.');
      return true;
    }
    setState(phone, 'tg_desc', { ...s.data, lojaCode: loja && loja.code, lojaNome: loja && loja.nome, online });
    await reply(phone, s.data.motivo === 'garantia'
      ? 'Entendi! Agora me conta: qual é o produto e o que aconteceu com ele? 📝'
      : 'Beleza! Agora me conta: qual produto você quer trocar e por qual motivo? Se for tamanho, diz qual número você precisa. 📝');
    return true;
  }

  if (s.stage === 'tg_desc') {
    await finishTrocaGarantia(phone, pushName, s.data, text);
    return true;
  }
  return false;
}


// ---------- entrada: chamada pelo webhook ----------
// Retorna true se a mensagem foi tratada aqui (aí a IA NÃO responde).
async function tryHandle({ phone, text, pushName }) {
  try {
    const t = norm(text);
    // remetente sem número de telefone utilizável (ex: id @lid) -> segue o fluxo normal
    if (!phone || !t || !phoneVariants(phone).length) return false;

    const s = getState(phone);
    if (s && await handleState(s, { phone, t, text, pushName })) return true;

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

module.exports = { tryHandle, phoneVariants, findCuponsForPhone, _norm: norm, _functions: FUNCTIONS, _state: state, _isGreeting: isGreeting, _lojasText: lojasText, _menuText: menuText };
