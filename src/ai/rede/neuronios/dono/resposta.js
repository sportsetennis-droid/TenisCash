// dono.resposta — analista (IA barata só pra REDIGIR)
// Responde pergunta do dono com DADO REAL do banco (só leitura):
//   estoque por EAN / REF / loja, vendas do dia, NF-e, propostas pendentes.
// Etapa 1 (regra): identifica a intenção e consulta o banco → lista de FATOS,
//   cada um com a FONTE (tabela + filtro).
// Etapa 2 (IA barata): só redige a resposta a partir dos fatos. Se a IA
//   escrever um número que não está nos fatos, a resposta da IA é descartada
//   e vale o texto da regra (nunca inventa).
// Sem dado → responde que não achou (e nem chama a IA).

const OFFSET_MS = 3 * 3600 * 1000; // America/Fortaleza = UTC-3 fixo
const DIA = 24 * 3600 * 1000;
const VENDA_INVALIDA = ['canceled', 'cancelled', 'cancelada', 'refunded', 'estornada', 'pending', 'pendente'];
const STOP_LOJA = new Set(['sports', 'tennis', 'loja', 'dos', 'das', 'de', 'do', 'da', 'praia', 'esportes', 'ecommerce', 'e-commerce']);

function fortaleza(quando) {
  const d = quando ? new Date(quando) : new Date();
  const l = new Date(d.getTime() - OFFSET_MS);
  const inicio = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), 3, 0, 0));
  return { agora: d, inicio, ymd: l.toISOString().slice(0, 10) };
}
const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const reais = (v) => 'R$ ' + (Math.round(Number(v || 0) * 100) / 100).toFixed(2).replace('.', ',');
const digitos = (s) => String(s || '').match(/\d+/g) || [];

// ---------------- etapa 1: intenção ----------------
function intencoes(texto, lojas) {
  const t = sem(texto);
  const chaves = (String(texto).match(/\b\d{44}\b/g) || []);
  const eans = (String(texto).match(/\b\d{8,14}\b/g) || []);
  const refM = String(texto).match(/\bref(?:er[eê]ncia)?\.?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9.\-\/]{2,30})/i);
  const lojasCitadas = lojas.filter((l) => {
    if (new RegExp('\\b' + sem(l.code) + '\\b').test(t)) return true;
    return sem(l.name).split(/[^a-z0-9-]+/).filter((w) => w.length >= 4 && !STOP_LOJA.has(w)).some((w) => new RegExp('\\b' + w + '\\b').test(t));
  });
  return {
    chaves,
    eans,
    ref: refM ? refM[1].replace(/[.,;:?!]+$/, '') : null,
    lojas: lojasCitadas,
    estoque: /\bestoque|\bquant[oa]s?\b|\btem\b|\bpares\b|\bunidades\b/.test(t),
    vendas: /\bvend(a|as|eu|emos|ido|eram)\b|faturamento|faturou/.test(t),
    ontem: /\bontem\b/.test(t),
    nfe: /\bnf-?e\b|\bnotas?\b|nota fiscal|\bxml\b/.test(t),
    propostas: /propost|pendente|aprova/.test(t),
  };
}

// ---------------- etapa 1: consultas (só leitura) ----------------
async function porEan(ler, ean, F) {
  const sizes = await ler.productSize.findMany({
    where: { barcode: ean },
    select: { size: true, stock: true, barcode: true, product: { select: { name: true, sku: true, brand: true, active: true } }, storeStocks: { select: { stock: true, store: { select: { code: true } } } } },
    take: 5,
  });
  if (!sizes.length) { F.nao.push(`EAN ${ean} não está cadastrado em nenhum tamanho (ProductSize.barcode)`); return; }
  for (const s of sizes) {
    const fis = s.storeStocks.filter((x) => x.stock !== 0).map((x) => `${x.store.code} ${x.stock}`);
    const tot = s.storeStocks.reduce((a, x) => a + x.stock, 0);
    F.fatos.push(`EAN ${ean}: ${s.product.name} (REF ${s.product.sku}) tamanho ${s.size} — físico ${tot}${fis.length ? ' (' + fis.join(', ') + ')' : ''}; comprado (NF-e) ${s.stock}`);
    F.fontes.push(`ProductSize.barcode=${ean} + StoreStock (físico por loja)`);
  }
}

async function porRef(ler, ref, F) {
  const prods = await ler.product.findMany({
    where: { OR: [{ sku: { equals: ref, mode: 'insensitive' } }, { sku: { startsWith: ref, mode: 'insensitive' } }] },
    select: { name: true, sku: true, active: true, aiContext: true, sizes: { select: { size: true, stock: true, storeStocks: { select: { stock: true, store: { select: { code: true } } } } } } },
    take: 5,
  });
  if (!prods.length) { F.nao.push(`REF ${ref} não encontrada (Product.sku)`); return; }
  for (const p of prods) {
    const porLoja = {};
    let comprado = 0;
    for (const s of p.sizes) {
      comprado += s.stock;
      for (const x of s.storeStocks) porLoja[x.store.code] = (porLoja[x.store.code] || 0) + x.stock;
    }
    const fis = Object.entries(porLoja).filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v}`);
    const tot = Object.values(porLoja).reduce((a, v) => a + v, 0);
    const cor = p.aiContext && p.aiContext.color ? ` cor ${p.aiContext.color}` : '';
    F.fatos.push(`REF ${p.sku}: ${p.name}${cor}${p.active ? '' : ' (card inativo)'} — ${p.sizes.length} tamanho(s), físico ${tot}${fis.length ? ' (' + fis.join(', ') + ')' : ''}; comprado (NF-e) ${comprado}`);
    F.fontes.push(`Product.sku=${p.sku} + ProductSize + StoreStock`);
  }
}

async function estoqueLoja(ler, lojas, F) {
  if (lojas.length) {
    for (const l of lojas) {
      const r = await ler.storeStock.aggregate({ where: { storeId: l.id, stock: { gt: 0 } }, _sum: { stock: true }, _count: { _all: true } });
      const un = (r._sum && r._sum.stock) || 0;
      const linhas = (r._count && r._count._all) || 0;
      if (!linhas) { F.nao.push(`nenhum estoque físico localizado na ${l.code} ${l.name} (StoreStock)`); continue; }
      F.fatos.push(`Estoque físico ${l.code} ${l.name}: ${un} unidade(s) em ${linhas} código(s)/tamanho(s)`);
      F.fontes.push(`StoreStock storeId=${l.code} stock>0 (soma)`);
    }
    return;
  }
  const g = await ler.storeStock.groupBy({ by: ['storeId'], where: { stock: { gt: 0 } }, _sum: { stock: true } });
  if (!g.length) { F.nao.push('nenhum estoque físico localizado (StoreStock)'); return; }
  const cod = await ler.store.findMany({ where: { id: { in: g.map((x) => x.storeId) } }, select: { id: true, code: true } });
  const m = new Map(cod.map((x) => [x.id, x.code]));
  F.fatos.push('Estoque físico por loja: ' + g.map((x) => `${m.get(x.storeId) || x.storeId} ${x._sum.stock}`).join(', '));
  F.fontes.push('StoreStock stock>0 agrupado por loja');
}

async function vendas(ler, lojas, ontem, agora, F) {
  const f = fortaleza(agora);
  const de = ontem ? new Date(f.inicio.getTime() - DIA) : f.inicio;
  const ate = ontem ? f.inicio : f.agora;
  const dia = ontem ? fortaleza(de).ymd : f.ymd;
  const alvo = lojas.length ? lojas : [null];
  for (const l of alvo) {
    const where = { createdAt: { gte: de, lt: ate }, status: { notIn: VENDA_INVALIDA }, ...(l ? { storeId: l.id } : {}) };
    const r = await ler.sale.aggregate({ where, _sum: { totalAmount: true }, _count: { _all: true } });
    const n = (r._count && r._count._all) || 0;
    const quem = l ? `${l.code} ${l.name}` : 'todas as lojas';
    if (!n) { F.nao.push(`nenhuma venda registrada em ${dia} (${quem}) na tabela Sale`); continue; }
    F.fatos.push(`Vendas ${dia}${ontem ? '' : ' até agora'} (${quem}): ${n} venda(s), total ${reais(r._sum.totalAmount)}`);
    F.fontes.push(`Sale createdAt em ${dia} (Fortaleza), status válido${l ? ', loja ' + l.code : ''}`);
  }
}

async function nfe(ler, chaves, agora, F) {
  for (const k of chaves) {
    const d = await ler.xmlFiscalDocument.findUnique({ where: { accessKey: k }, select: { number: true, issuerName: true, docType: true, issueDate: true, totalValue: true, _count: { select: { items: true } } } });
    if (!d) { F.nao.push(`NF-e chave ${k} não foi importada (XmlFiscalDocument.accessKey)`); continue; }
    F.fatos.push(`NF-e ${d.number || '?'} de ${d.issuerName || 'emitente não informado'}: ${d.docType || 'tipo não classificado'}, emitida ${d.issueDate ? fortaleza(d.issueDate).ymd : '?'}, ${d._count.items} item(ns), total ${reais(d.totalValue)}`);
    F.fontes.push(`XmlFiscalDocument.accessKey=${k}`);
  }
  if (chaves.length) return;
  const f = fortaleza(agora);
  const g = await ler.xmlFiscalDocument.groupBy({ by: ['docType'], where: { createdAt: { gte: f.inicio } }, _count: { _all: true } });
  if (g.length) {
    F.fatos.push(`NF-e importadas hoje (${f.ymd}): ` + g.map((x) => `${x.docType || 'sem tipo'} ${x._count._all}`).join(', '));
    F.fontes.push(`XmlFiscalDocument createdAt em ${f.ymd} agrupado por docType`);
  } else F.nao.push(`nenhuma NF-e importada hoje (${f.ymd})`);
  const ult = await ler.xmlFiscalDocument.findFirst({ where: { docType: 'entrada' }, orderBy: { createdAt: 'desc' }, select: { number: true, issuerName: true, createdAt: true, totalValue: true } });
  if (ult) {
    F.fatos.push(`Última NF-e de entrada importada: nº ${ult.number || '?'} de ${ult.issuerName || '?'} em ${fortaleza(ult.createdAt).ymd}, total ${reais(ult.totalValue)}`);
    F.fontes.push('XmlFiscalDocument docType=entrada (mais recente)');
  }
}

async function propostas(ler, F) {
  const g = await ler.aIApproval.groupBy({ by: ['type'], where: { status: 'pending' }, _count: { _all: true } });
  const tot = g.reduce((a, x) => a + x._count._all, 0);
  if (!tot) { F.nao.push('nenhuma proposta pendente de aprovação (AIApproval)'); return; }
  const top = await ler.aIApproval.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 5, select: { title: true } });
  F.fatos.push(`Propostas pendentes: ${tot} (` + g.map((x) => `${x.type} ${x._count._all}`).join(', ') + ')');
  F.fatos.push('Mais antigas: ' + top.map((x) => x.title).join(' | '));
  F.fontes.push('AIApproval status=pending');
}

function textoRegra(F) {
  const partes = [];
  if (F.fatos.length) partes.push(F.fatos.join('\n'));
  if (F.nao.length) partes.push('Não achei: ' + F.nao.join('; ') + '.');
  return partes.join('\n');
}

// A IA só redige: todo número do texto dela tem que existir nos fatos (ou na pergunta).
function numerosConferem(texto, F, pergunta) {
  const norm = (n) => String(Number(n));
  const ok = new Set([...F.fatos, ...F.nao, pergunta].flatMap(digitos).flatMap((n) => [n, norm(n)]));
  return digitos(texto).every((n) => ok.has(n) || ok.has(norm(n)));
}

module.exports = {
  id: 'dono.resposta',
  camada: 'analista',
  missao: 'Responder a pergunta do dono só com dado real do banco, citando a fonte de cada número.',
  escuta: ['dono.pergunta'],
  emite: ['dono.resposta'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'ler',
  regras: ['dados-reais', 'nunca-inventar', 'timezone-fortaleza', 'estoque-fisico-vs-comprado'],
  tempoMax: 30000,
  async disparar({ sinal, ler, agora, pensar }) {
    const pergunta = String((sinal.dados && sinal.dados.texto) || '').slice(0, 1000);
    const base = { pergunta, userId: (sinal.dados && sinal.dados.userId) || null };
    if (!pergunta.trim()) return [];
    const lojas = await ler.store.findMany({ select: { id: true, code: true, name: true } });
    const I = intencoes(pergunta, lojas);
    const F = { fatos: [], fontes: [], nao: [] };
    const eans = I.eans.filter((e) => !I.chaves.includes(e));

    if (I.chaves.length || I.nfe) await nfe(ler, I.chaves, agora, F);
    for (const e of eans.slice(0, 5)) await porEan(ler, e, F);
    if (I.ref) await porRef(ler, I.ref, F);
    if (I.vendas) await vendas(ler, I.lojas, I.ontem, agora, F);
    if (I.propostas) await propostas(ler, F);
    if (I.estoque && !eans.length && !I.ref && !I.vendas && !I.propostas && !I.nfe && !I.chaves.length) await estoqueLoja(ler, I.lojas, F);

    const entendeu = I.chaves.length || eans.length || I.ref || I.vendas || I.propostas || I.nfe || I.estoque;
    if (!entendeu) {
      return [{ tipo: 'dono.resposta', forca: 1, dados: Object.assign(base, { achou: false, fontes: [], redigidoPor: 'regra',
        texto: 'Não achei o que buscar nessa pergunta. Sei responder com dado do sistema: estoque por EAN, por REF ou por loja; vendas de hoje/ontem; NF-e (chave de 44 dígitos ou importadas hoje); propostas pendentes.' }) }];
    }
    if (!F.fatos.length) {
      return [{ tipo: 'dono.resposta', forca: 1, dados: Object.assign(base, { achou: false, fontes: [], redigidoPor: 'regra', texto: textoRegra(F) }) }];
    }

    let texto = textoRegra(F);
    let redigidoPor = 'regra';
    if (pensar) {
      const r = await pensar({
        instrucao: 'Redija a resposta ao dono em português, curta e direta, usando SOMENTE os FATOS e NAO_ACHADOS. Não acrescente número, produto, loja ou conclusão que não esteja nos fatos. Se algo não foi achado, diga que não achou. JSON: {"texto": "..."}',
        entrada: { pergunta, fatos: F.fatos, naoAchados: F.nao },
        schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
        maxTokens: 600,
      }).catch(() => null);
      const t = r && r.ok && r.json && typeof r.json.texto === 'string' ? r.json.texto.trim() : '';
      if (t && numerosConferem(t, F, pergunta)) { texto = t; redigidoPor = 'ia'; }
    }
    return [{ tipo: 'dono.resposta', forca: 1, dados: Object.assign(base, { achou: true, texto, fontes: [...new Set(F.fontes)], fatos: F.fatos, naoAchados: F.nao, redigidoPor }) }];
  },
};
