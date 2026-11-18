// Poderes do agente do vendedor no WhatsApp (dono 18/11/2026: "Faça tudo do 1 ao 8").
//  1 foto do produto → identifica (visão) e o agente consulta o estoque
//  2 áudio → transcreve e o agente responde
//  3 ficha do cliente (compras + saldo TenisCash) pelo telefone
//  4 foto oficial do produto pra repassar ao cliente
//  5 pedido de transferência entre lojas (vira pedido + aviso à loja de origem; o estoque só
//    se move quando a origem bipa a transferência — nada sai sozinho)
//  6 venda perdida (o que o cliente queria e não tinha)
//  7 TenisCash do cliente: saldo + mensagem pronta de como usar (não gasta saldo: uso é no caixa)
//  8 placar da loja hoje (total da loja, sem expor número de colega)
// Regras: só consulta e registra; não muda preço, não move estoque, não envia nada pro cliente.

const crypto = require('crypto');
const TZ_OFFSET_MS = 3 * 3600 * 1000;
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const todayYmd = () => new Date(Date.now() - TZ_OFFSET_MS).toISOString().slice(0, 10);
const firstName = (n) => { const w = String(n || '').trim().split(/\s+/)[0] || ''; return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); };

let ready = null;
function ensureSchema(prisma) {
  if (!ready) {
    ready = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LostSale" (
      "id" TEXT PRIMARY KEY, "sellerId" TEXT NOT NULL, "storeId" TEXT, "product" TEXT NOT NULL, "size" TEXT,
      "reason" TEXT NOT NULL DEFAULT 'SEM_ESTOQUE', "note" TEXT, "productId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT NOW())`)
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function phoneVariants(raw) { return require('./whatsappFunctions').phoneVariants(raw); }

// 3 + 7 — ficha do cliente pelo telefone (nome, saldo, compras). Sem CPF/e-mail.
async function clientFile(prisma, phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return { erro: 'Telefone inválido. Use DDD + número.' };
  const user = await prisma.user.findFirst({ where: { phone: { in: variants } }, select: { id: true, name: true, balance: true, createdAt: true } });
  const sellerClients = await prisma.sellerClient.findMany({ where: { phone: { in: variants } }, select: { id: true, name: true } });
  const or = [];
  if (user) or.push({ customerUserId: user.id });
  if (sellerClients.length) or.push({ clientId: { in: sellerClients.map((c) => c.id) } });
  if (!or.length) return { encontrado: false, mensagem: 'Esse telefone não tem cadastro nem compra registrada no TenisCash.' };
  const sales = await prisma.sale.findMany({
    where: { OR: or, status: { not: 'canceled' } }, orderBy: { createdAt: 'desc' }, take: 8,
    select: { createdAt: true, totalAmount: true, tcUsed: true, tcEarned: true, storeId: true, items: { select: { productName: true, size: true, quantity: true } } },
  });
  const agg = await prisma.sale.aggregate({ where: { OR: or, status: { not: 'canceled' } }, _sum: { totalAmount: true }, _count: { _all: true } });
  const storeIds = [...new Set(sales.map((s) => s.storeId).filter(Boolean))];
  const storeName = Object.fromEntries((storeIds.length ? await prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true } }) : []).map((x) => [x.id, x.name]));
  return {
    encontrado: true,
    nome: (user && user.name) || (sellerClients[0] && sellerClients[0].name) || null,
    saldoTenisCash: user ? Number(user.balance || 0) : null,
    totalComprado: Number(agg._sum.totalAmount || 0),
    numeroDeCompras: agg._count._all,
    ultimasCompras: sales.map((s) => ({
      data: new Date(s.createdAt.getTime() - TZ_OFFSET_MS).toISOString().slice(0, 10), loja: storeName[s.storeId] || null, valor: s.totalAmount,
      itens: s.items.map((i) => `${i.quantity > 1 ? i.quantity + 'x ' : ''}${i.productName}${i.size ? ' tam ' + i.size : ''}`),
    })),
    comoUsarTenisCash: 'O saldo é usado no caixa da loja: o cliente informa o telefone e o desconto entra na compra. Também dá pra usar no site gerando o cupom no app TenisCash.',
    observacao: 'Dado pessoal do cliente: use só pra atender ele. Não repasse a terceiros.',
  };
}

// 7 — mensagem pronta (rascunho) pro vendedor mandar ao cliente; o vendedor envia, não o sistema.
function tenisCashDraft(nome, saldo) {
  if (!(saldo > 0)) return null;
  return `Oi${nome ? ', ' + firstName(nome) : ''}! 🧡 Você tem ${brl(saldo)} de TenisCash na Sports & Tennis. Dá pra usar como desconto na sua próxima compra: é só passar seu telefone no caixa da loja. Te espero aqui!`;
}

function imagesOf(p) {
  const list = [];
  if (p.imageUrl) list.push(p.imageUrl);
  if (Array.isArray(p.imageUrls)) for (const u of p.imageUrls) if (typeof u === 'string' && u && !list.includes(u)) list.push(u);
  return list.filter((u) => /^https?:\/\//.test(u) || /^data:image\//.test(u));
}

// 4 — foto oficial do produto (até 3) pra repassar ao cliente.
async function productPhotos(prisma, query, color) {
  const terms = String(query || '').trim().split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
  if (!terms.length) return { erro: 'Diga o produto (modelo, marca ou código).' };
  const products = await prisma.product.findMany({
    where: { active: true, AND: terms.map((t) => ({ OR: [{ name: { contains: t, mode: 'insensitive' } }, { sku: { contains: t, mode: 'insensitive' } }, { brand: { contains: t, mode: 'insensitive' } }, { sizes: { some: { barcode: { contains: t } } } }] })) },
    take: 12, select: { id: true, name: true, brand: true, sku: true, imageUrl: true, imageUrls: true, aiContext: true },
  });
  const withColor = (p) => { try { const c = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext; return (c && c.color) || null; } catch (_) { return null; } };
  let found = products.map((p) => ({ id: p.id, nome: p.name, marca: p.brand, ref: p.sku, cor: withColor(p), fotos: imagesOf(p) })).filter((p) => p.fotos.length);
  if (color) { const c = String(color).toLowerCase(); const f = found.filter((p) => String(p.cor || p.nome).toLowerCase().includes(c)); if (f.length) found = f; }
  if (!found.length) return { encontrado: false, mensagem: products.length ? 'Achei o produto, mas ele está sem foto no cadastro.' : 'Não achei produto com esse nome/código.' };
  return { encontrado: true, opcoes: found.slice(0, 4).map((p) => ({ id: p.id, nome: p.nome, cor: p.cor, ref: p.ref, qtdFotos: p.fotos.length })), escolhido: found[0] };
}

// 5 — pedido de transferência: registra e avisa a loja de origem (estoque não se move aqui).
async function requestTransfer(prisma, seller, input, { send } = {}) {
  const prod = String(input.produto || '').trim().slice(0, 160);
  if (!prod) return { erro: 'Diga o produto.' };
  const toStore = seller.storeId ? await prisma.store.findUnique({ where: { id: seller.storeId }, select: { id: true, code: true, name: true } }) : null;
  if (!toStore) return { erro: 'Seu cadastro está sem loja. Peça pro Douglas vincular.' };
  const stores = await prisma.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true } });
  const de = String(input.de_loja || '').toLowerCase();
  const fromStore = stores.find((s) => s.code.toLowerCase() === de || s.name.toLowerCase().includes(de)) || null;
  if (!fromStore) return { erro: 'Não achei a loja de origem. Lojas: ' + stores.map((s) => s.code + ' ' + s.name).join(', ') };
  if (fromStore.id === toStore.id) return { erro: 'A loja de origem é a mesma loja de destino.' };
  const qtd = Math.max(1, Math.min(20, parseInt(input.quantidade, 10) || 1));
  const tam = String(input.tamanho || '').trim().slice(0, 12);
  const title = `Transferência: ${qtd}x ${prod}${tam ? ' tam ' + tam : ''} — ${fromStore.code} → ${toStore.code}`;
  const req = await prisma.sellerInternalRequest.create({ data: {
    sellerId: seller.id, storeId: toStore.id, category: 'PRODUCT', title: title.slice(0, 190), urgency: input.urgente ? 'HIGH' : 'NORMAL',
    description: `Pedido feito pelo WhatsApp por ${seller.name}. De ${fromStore.name} para ${toStore.name}. ${qtd}x ${prod}${tam ? ' tamanho ' + tam : ''}.${input.observacao ? ' Obs.: ' + String(input.observacao).slice(0, 300) : ''} A transferência só vale quando a origem bipar o envio.`,
  } });
  // Avisa quem da loja de origem bateu ponto hoje (ou tem escala) — mensagem interna da equipe.
  let avisados = 0;
  if (send) {
    const dayStart = new Date(todayYmd() + 'T03:00:00.000Z');
    const today = await prisma.clockIn.findMany({ where: { storeId: fromStore.id, type: 'entry', timestamp: { gte: dayStart } }, distinct: ['userId'], select: { userId: true } });
    const users = today.length ? await prisma.user.findMany({ where: { id: { in: today.map((t) => t.userId) }, role: 'seller', active: true }, select: { phone: true } }) : [];
    for (const u of users) {
      if (!u.phone || /[a-z@_]/i.test(u.phone)) continue;
      const r = await send(u.phone, `📦 *Pedido de transferência* — ${toStore.name} pede pra ${fromStore.name}:\n${qtd}x ${prod}${tam ? ' tam ' + tam : ''}${input.observacao ? '\nObs.: ' + String(input.observacao).slice(0, 200) : ''}\nQuem pediu: ${firstName(seller.name)}.\n\nSe tiver, separe e faça a transferência pelo app (Bipar › Transferência). Se não tiver, avise ${firstName(seller.name)}.`).catch(() => null);
      if (r && r.ok) avisados++;
    }
  }
  return { ok: true, pedido: req.id, titulo: title, lojaOrigemAvisada: avisados, aviso: 'O estoque não muda agora: só quando a loja de origem bipar a transferência.' };
}

// 6 — venda perdida.
async function lostSale(prisma, seller, input) {
  await ensureSchema(prisma);
  const prod = String(input.produto || '').trim().slice(0, 200);
  if (!prod) return { erro: 'Diga o produto que o cliente queria.' };
  const reasons = { sem_estoque: 'SEM_ESTOQUE', sem_tamanho: 'SEM_TAMANHO', preco: 'PRECO', sem_cor: 'SEM_COR', outro: 'OUTRO' };
  const reason = reasons[String(input.motivo || 'sem_estoque').toLowerCase()] || 'OUTRO';
  const id = crypto.randomUUID();
  await prisma.$executeRaw`INSERT INTO "LostSale" ("id","sellerId","storeId","product","size","reason","note")
    VALUES (${id}, ${seller.id}, ${seller.storeId || null}, ${prod}, ${String(input.tamanho || '').slice(0, 12) || null}, ${reason}, ${String(input.observacao || '').slice(0, 300) || null})`;
  const [c] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "LostSale" WHERE lower("product") = lower(${prod}) AND "createdAt" > NOW() - INTERVAL '30 days'`;
  return { ok: true, registrado: id, vezesNos30Dias: c ? c.n : 1, mensagem: 'Registrado. Isso vira sinal pra compra.' };
}

// 8 — placar da loja hoje (agregado; não mostra número de colega).
async function storeScoreboard(prisma, seller) {
  if (!seller.storeId) return { erro: 'Seu cadastro está sem loja.' };
  const store = await prisma.store.findUnique({ where: { id: seller.storeId }, select: { id: true, name: true } });
  const day = todayYmd(); const start = new Date(day + 'T03:00:00.000Z');
  const [agg, mine, working] = await Promise.all([
    prisma.sale.aggregate({ where: { storeId: seller.storeId, createdAt: { gte: start }, status: { not: 'canceled' } }, _sum: { totalAmount: true }, _count: { _all: true } }),
    prisma.sale.aggregate({ where: { storeId: seller.storeId, sellerId: seller.id, createdAt: { gte: start }, status: { not: 'canceled' } }, _sum: { totalAmount: true }, _count: { _all: true } }),
    prisma.clockIn.findMany({ where: { storeId: seller.storeId, type: 'entry', timestamp: { gte: start } }, distinct: ['userId'], select: { userId: true } }),
  ]);
  const dailyGoal = Number(process.env.PULSE_DAILY_GOAL || 1000);
  const people = Math.max(1, working.length);
  const total = Number(agg._sum.totalAmount || 0), goal = dailyGoal * people;
  return {
    loja: store ? store.name : null, hoje: day,
    lojaHoje: { vendas: agg._count._all, valor: total, ticketMedio: agg._count._all ? total / agg._count._all : 0 },
    metaDaLojaHoje: { valor: goal, conta: `${people} pessoa(s) com ponto hoje × ${brl(dailyGoal)}`, percentual: goal ? Math.round((total / goal) * 100) : 0, falta: Math.max(0, goal - total) },
    voceHoje: { vendas: mine._count._all, valor: Number(mine._sum.totalAmount || 0), metaDoDia: dailyGoal },
    observacao: 'Placar da loja é o total; não informe valores de colegas.',
  };
}

// 1 — identificar produto na foto (marca, modelo, cor, códigos legíveis).
async function identifyProductPhoto(base64, mimetype, caption) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !base64) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mt = allowed.includes(String(mimetype || '').toLowerCase()) ? String(mimetype).toLowerCase() : 'image/jpeg';
  const client = new Anthropic({ apiKey: key });
  const resp = await client.messages.create({
    model: process.env.SELLER_VISION_MODEL || process.env.SELLER_AGENT_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mt, data: base64 } },
      { type: 'text', text: 'Foto tirada por vendedor de loja de artigos esportivos. Responda em português, só o que dá pra VER (não chute): marca, modelo, cor, tipo de produto, e TODOS os códigos legíveis (código de barras/EAN, referência/artigo, tamanho na etiqueta ou caixa). Formato: "Marca: …; Modelo: …; Cor: …; Tipo: …; Códigos: …; Tamanho: …". Use "não visível" no que não der pra ler.' + (caption ? ' Legenda do vendedor: ' + String(caption).slice(0, 200) : '') },
    ] }],
  });
  return (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim() || null;
}

module.exports = { ensureSchema, clientFile, tenisCashDraft, productPhotos, imagesOf, requestTransfer, lostSale, storeScoreboard, identifyProductPhoto };
