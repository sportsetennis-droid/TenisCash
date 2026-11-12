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
// SEGURANÇA/LGPD (2ª via): o cliente informa data + valor total da compra; cupom
// que tem CPF só é entregue se o CPF digitado bater. Nunca "pelo número do WhatsApp"
// (mandava cupom de outra pessoa — dono 2026-11-12).
//
// Pra criar uma função nova: escrever um handler { name, match(text), run(ctx) }
// e colocar em FUNCTIONS. O menu se monta sozinho.
// =====================================================================
const { prisma } = require('../middleware');
const { sendCustomMessage, sendEvolutionRaw, sendEvolutionImage } = require('../whatsapp');
// Cartão laranja com a logo oficial (public/wa-site-card.png, gerado do PNG oficial da marca).
const SITE_CARD_URL = (process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br').replace(/\/+$/, '') + '/wa-site-card.png';
const { deliverCupom } = require('./cupomDelivery');


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

// ---------- 2ª via: o cliente SE IDENTIFICA (data + valor + CPF se tiver) ----------
// Dono 2026-11-12: achar pelo número do WhatsApp mandou cupom de outra pessoa
// ("ele tem que dizer alguma coisa para identificar o cupom dele"). Agora:
// data da compra + valor total são obrigatórios; cupom COM CPF só sai se o CPF
// digitado bater (o dado pessoal fica protegido); cupom sem CPF não tem dado
// pessoal. Vários parecidos -> lista com loja, hora e produto pra ele escolher.
function nowFortaleza() { return new Date(Date.now() - 3 * 3600 * 1000); }
function ymdOf(d) { return d.toISOString().slice(0, 10); }

function parseDataCompra(t) {
  const hoje = nowFortaleza();
  if (/\bhoje\b/.test(t)) return ymdOf(hoje);
  if (/\banteontem\b/.test(t)) return ymdOf(new Date(hoje.getTime() - 2 * 864e5));
  if (/\bontem\b/.test(t)) return ymdOf(new Date(hoje.getTime() - 864e5));
  let d, m, y;
  const full = t.match(/\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{2,4}))?\b/);
  if (full) { d = +full[1]; m = +full[2]; y = full[3] ? +full[3] : null; }
  else {
    const dia = t.match(/\bdia\s+(\d{1,2})\b/);
    if (!dia) return null;
    d = +dia[1]; m = hoje.getUTCMonth() + 1; y = null;
  }
  if (y !== null && y < 100) y += 2000;
  if (y === null) {
    y = hoje.getUTCFullYear();
    // data "no futuro" = ano passado (ex: 28/12 dito em janeiro)
    if (new Date(Date.UTC(y, m - 1, d)) > hoje) y -= 1;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // 31/02 etc
  return ymdOf(dt);
}

function parseValorCompra(t) {
  const s = t.replace(/r\$\s*/g, '');
  // 1º "131.99" (ponto decimal, 1-2 casas); senão "1.234,56" / "131,99" / "131"
  const m = s.match(/(?:^|[^\d.,])(\d+)\.(\d{1,2})(?![\d.,])/) ? s.match(/()()(\d+)\.(\d{1,2})(?![\d.,])/)
    : s.match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?!\d)/);
  if (!m) return null;
  let value; let hasCents;
  if (m[3] !== undefined) { value = Number(m[3] + '.' + m[4]); hasCents = true; }
  else { value = Number(m[1].replace(/\./g, '') + (m[2] ? '.' + m[2].padEnd(2, '0') : '')); hasCents = !!m[2]; }
  if (!(value > 0) || value > 100000) return null;
  return { value, hasCents };
}

function parseCpf(t) {
  const d = String(t || '').replace(/\D/g, '');
  return d.length === 11 ? d : null;
}
function maskCpf(c) { return c ? '***.' + c.slice(3, 6) + '.' + c.slice(6, 9) + '-**' : ''; }
function fmtDataBr(ymd) { const [y, m, d] = ymd.split('-'); return d + '/' + m + '/' + y; }
function fmtHora(dt) { return new Date(dt).toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit' }); }

// Primeiro produto do cupom (lido do XML autorizado), pra ajudar o cliente a escolher.
function produtoDoCupom(doc) {
  const xml = String(doc.xmlContent || '');
  const nomes = [...xml.matchAll(/<xProd>([^<]{1,120})<\/xProd>/g)].map(x => x[1].trim());
  if (!nomes.length) return '';
  return nomes[0] + (nomes.length > 1 ? ' (+' + (nomes.length - 1) + ' item' + (nomes.length > 2 ? 's' : '') + ')' : '');
}

async function buscarCupons({ ymd, valor, cpf }) {
  const start = new Date(ymd + 'T03:00:00.000Z');          // 00:00 em Fortaleza
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const tol = valor.hasCents ? 0.01 : 0.999;               // "131" casa 131,00..131,99
  const cpfFilter = cpf
    ? { recipientCnpjCpf: { in: [cpf, cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')] } }
    : { OR: [{ recipientCnpjCpf: null }, { recipientCnpjCpf: '' }] }; // sem CPF: só cupom anônimo
  return prisma.fiscalDocument.findMany({
    where: {
      AND: [cpfFilter],
      status: 'authorized',
      accessKey: { not: null },
      docType: { in: ['NFCE', 'NFE'] },
      createdAt: { gte: start, lt: end },
      totalValue: { gte: valor.value - (valor.hasCents ? tol : 0), lte: valor.value + tol },
    },
    include: { issuer: true },
    orderBy: { createdAt: 'asc' },
    take: 8,
  });
}

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
    // 1) Tem CADASTRO TenisCash com esse WhatsApp? Mostra as compras do cadastro
    //    e o cliente CONFIRMA qual é (dono 2026-11-12: "se tiver o cadastro da pessoa
    //    ... já puxar o cupom que ela quer"). Nada sai sem ele escolher.
    const docs = await cuponsDoCadastro(phone).catch((e) => { console.warn('[wa-funcoes] cadastro:', e.message); return []; });
    if (docs.length) {
      setState(phone, 'cupom', { docIds: docs.map(d => d.id), manual: true });
      const lines = docs.map((d, i) => (i + 1) + ') ' + fmtDate(d.createdAt) + ' · ' +
        storeName(d).replace(/^Sports & Tennis\s*/i, '') + ' · R$ ' + fmtMoney(d.totalValue) +
        (produtoDoCupom(d) ? '\n    ' + produtoDoCupom(d) : ''));
      return reply(phone,
        'Claro' + oiNome(pushName) + '! Achei estas compras no seu cadastro 🧾\n\n' + lines.join('\n') +
        '\n\n0) Não está aqui\n\nQual é a sua? Responda só com o *número*.');
    }
    // 2) Sem cadastro (ou sem compra no cadastro): o cliente se identifica.
    return pedirDadosCompra(phone, pushName);
  },
};

function pedirDadosCompra(phone, pushName) {
  setState(phone, 'via_data', {});
  return reply(phone,
    'Claro' + oiNome(pushName) + '! Vou achar seu cupom 🧾\n\n' +
    '📅 *Qual foi a data da compra?*\n(ex: 10/11, hoje, ontem)');
}

// Compras do CADASTRO TenisCash (User.phone — WhatsApp confirmado por código no
// cadastro). Só esse vínculo forte: cliente-de-vendedor / cupom já enviado ficam
// de fora (foi assim que um cupom de outra compra apareceu). Últimas 5 do ano.
async function cuponsDoCadastro(phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return [];
  const users = await prisma.user.findMany({ where: { phone: { in: variants }, active: true }, select: { id: true, cpf: true } });
  if (!users.length) return [];
  const since = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  const sales = await prisma.sale.findMany({ where: { customerUserId: { in: users.map(u => u.id) }, createdAt: { gte: since } }, select: { id: true } });
  const or = [];
  if (sales.length) or.push({ saleId: { in: sales.map(s => s.id) } });
  for (const u of users) {
    const cpf = String(u.cpf || '').replace(/\D/g, '');
    if (cpf.length === 11) or.push({ recipientCnpjCpf: { in: [cpf, cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')] } });
  }
  if (!or.length) return [];
  return prisma.fiscalDocument.findMany({
    where: {
      AND: [
        { OR: or },
        // devolução (NF-e 55 pra própria empresa) não é cupom de compra; cupom sem CPF continua
        { OR: [{ recipientCnpjCpf: null }, { NOT: { recipientCnpjCpf: { startsWith: '44052617' } } }] },
      ],
      status: 'authorized', accessKey: { not: null }, docType: { in: ['NFCE', 'NFE'] }, createdAt: { gte: since },
    },
    include: { issuer: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
}

async function finishSegundaVia(phone, data) {
  const docs = await buscarCupons(data);
  if (!docs.length) {
    clearState(phone);
    return reply(phone,
      'Não achei cupom com esses dados 😕\n' +
      '📅 ' + fmtDataBr(data.ymd) + ' · 💰 R$ ' + fmtMoney(data.valor.value) + (data.cpf ? ' · 🪪 ' + maskCpf(data.cpf) : ' · sem CPF') + '\n\n' +
      'Confere a data e o valor total e manda *2 via* de novo.' +
      (data.cpf ? '' : ' Se você colocou CPF na nota, informa o CPF quando eu perguntar.') +
      '\nSe preferir, a loja onde você comprou reenvia na hora. 🧡');
  }
  if (docs.length === 1) { clearState(phone); return sendDoc(docs[0], phone); }
  setState(phone, 'cupom', { docIds: docs.map(d => d.id) });
  const lines = docs.map((d, i) =>
    (i + 1) + ') ' + fmtHora(d.createdAt) + ' · ' + storeName(d).replace(/^Sports & Tennis\s*/i, '') + ' · R$ ' + fmtMoney(d.totalValue) +
    (produtoDoCupom(d) ? '\n    ' + produtoDoCupom(d) : ''));
  return reply(phone,
    'Achei ' + docs.length + ' cupons nesse dia com esse valor 🧾\n\n' + lines.join('\n') +
    '\n\nQual é o seu? Responda só com o *número* (ex: 1).');
}

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
  5: ({ phone }) => { clearState(phone); return reply(phone, lojasText(), { linkPreview: false }); },
  6: async ({ phone }) => {
    clearState(phone);
    // Cartão com a LOGO OFICIAL (laranja) no lugar da prévia automática do site,
    // que vinha com a logo apagada/errada (dono 2026-11-12).
    const caption = '🛍️ Nossa loja online: ' + SITE + '\n\nQualquer dúvida sobre um produto, é só me chamar aqui. 😉';
    if (!replyJids.get(phone)) {
      const img = await sendEvolutionImage(phone, SITE_CARD_URL, caption).catch(e => ({ ok: false, error: e.message }));
      if (img && img.ok) return img;
      console.warn('[wa-funcoes] cartao do site falhou, mando texto: ' + (img && img.error));
    }
    return reply(phone, caption, { linkPreview: false });
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
  run: ({ phone }) => reply(phone, lojasText(), { linkPreview: false }),
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

// Contato "@lid" sem telefone conhecido: responde no próprio JID (definido no tryHandle).
const replyJids = new Map(); // phone -> jid
async function reply(phone, text, opts = {}) {
  const jid = replyJids.get(phone);
  const out = await (jid ? sendEvolutionRaw(jid, text) : sendCustomMessage(phone, text, opts))
    .catch(e => ({ ok: false, error: e.message }));
  if (!out || !out.ok) console.warn('[wa-funcoes] falha ao responder ' + phone + ': ' + (out && out.error));
  return out;
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

  // 2ª via: data -> valor -> CPF (ou "não")
  if (s.stage === 'via_data') {
    const ymd = parseDataCompra(t);
    if (!ymd) { await reply(phone, 'Não entendi a data 😅 Manda assim: *10/11* (ou *hoje*, *ontem*).'); return true; }
    setState(phone, 'via_valor', { ymd });
    await reply(phone, '💰 *Qual foi o valor total da compra?*\n(ex: 131,99)');
    return true;
  }
  if (s.stage === 'via_valor') {
    const valor = parseValorCompra(t);
    if (!valor) { await reply(phone, 'Não entendi o valor 😅 Manda só o número, assim: *131,99*'); return true; }
    setState(phone, 'via_cpf', { ...s.data, valor });
    await reply(phone, '🪪 *Você colocou CPF na nota?*\nSe sim, manda o CPF. Se não, responde *não*.');
    return true;
  }
  if (s.stage === 'via_cpf') {
    const cpf = parseCpf(t);
    const semCpf = /^(nao|n|nao coloquei|sem cpf|nenhum|não)[.!]?$/.test(t);
    if (!cpf && !semCpf) { await reply(phone, 'Manda o CPF com 11 números (ex: 123.456.789-00) ou responde *não*.'); return true; }
    await finishSegundaVia(phone, { ...s.data, cpf: cpf || null });
    return true;
  }

  if (s.stage === 'cupom') {
    // "0) Não está aqui" (lista do cadastro) -> pede data/valor/CPF
    if (s.data.manual && (digit === '0' || /^(nao|nenhum|nenhuma|nao esta|outro|outra)[.!]?$/.test(t))) {
      clearState(phone);
      await pedirDadosCompra(phone, pushName);
      return true;
    }
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
async function tryHandle({ phone, text, pushName, replyJid = null }) {
  try {
    const t = norm(text);
    if (!phone || !t) return false;
    // sem telefone utilizável e sem JID pra responder -> segue o fluxo normal
    if (!replyJid && !phoneVariants(phone).length) return false;
    if (replyJid) replyJids.set(phone, replyJid); else replyJids.delete(phone);

    const s = getState(phone);
    if (s && await handleState(s, { phone, t, text, pushName })) return true;

    // Número 1–7 sozinho = opção do menu, MESMO sem estado guardado. O estado vive
    // na memória do servidor: um reinício (deploy) entre o "oi" e o número apagava
    // e o cliente ficava sem resposta.
    const lone = !s && (t.match(/^([1-7])[.)!]?$/) || [])[1];
    if (lone && OPCOES[Number(lone)]) {
      console.log('[wa-funcoes] ' + phone + ' opcao ' + lone + ' (sem estado)');
      await OPCOES[Number(lone)]({ phone, text, pushName });
      return true;
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

module.exports = { tryHandle, phoneVariants, _parseDataCompra: parseDataCompra, _parseValorCompra: parseValorCompra, _norm: norm, _functions: FUNCTIONS, _state: state, _isGreeting: isGreeting, _lojasText: lojasText, _menuText: menuText };
