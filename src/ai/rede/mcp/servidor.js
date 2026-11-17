// =====================================================================
// SERVIDOR MCP DO TENISCASH — /mcp (docs/REDE-NEURAL-DE-AGENTES.md §9/§10,
// manual: docs/rede/MCP.md). Liga o Claude (Code, Desktop, celular) e os
// agentes à MESMA rede, com as regras duras dentro das ferramentas.
//
//   uso (src/index.js, antes do app.get('*')): este módulo .mount(app)  — ver docs/rede/MCP.md
//
// SDK oficial @modelcontextprotocol/sdk 1.32.x (linha 1.x, tem build CommonJS:
// require('@modelcontextprotocol/sdk/server/mcp.js') resolve dist/cjs).
//
// Transporte Streamable HTTP em modo HÍBRIDO:
//  - `initialize` abre SESSÃO em memória (precisa dela para o servidor pedir
//    confirmação ao dono por ELICITATION no meio de uma chamada);
//  - qualquer outra requisição sem sessão conhecida (ex.: depois de um deploy
//    no Railway apagar a memória) é atendida SEM ESTADO, um servidor por
//    requisição — o cliente não quebra; só perde a elicitation naquela chamada
//    e a decisão cai no caminho `confirmar=true`.
//  - MCP_SESSOES=0 desliga as sessões (100% sem estado).
//
// Segurança: só `Authorization: Bearer <JWT do TenisCash>` (nunca ?token=),
// validado pelo authMiddleware (banco é a autoridade: conta inativa/rebaixada
// cai na hora) e SÓ admin/superadmin/manager. Sessão fica presa ao usuário
// que a abriu. Leituras usam o proxy só-leitura da rede; toda resposta passa
// por mascararPII. Nenhuma ferramenta muda preço, manda WhatsApp ou publica.
// =====================================================================
'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');

const { prisma, authMiddleware } = require('../../../middleware');
const { isAdminRole } = require('../../../services/designAccess');
const { assessProductForNuvemshop, nuvemshopStoreStocksQuery } = require('../../../services/nuvemshopEligibility');
const { soLeitura } = require('../ferramentas');
const { mascararPII } = require('../seguranca');

const VERSAO = '1.0.0';
const MAX_SESSOES = Number(process.env.MCP_MAX_SESSOES || 50);
const SESSAO_OCIOSA_MS = Number(process.env.MCP_SESSAO_OCIOSA_MIN || 30) * 60 * 1000;
const LIMITE_TEXTO = 14000;
const SEM_GTIN = /SEM\s*GTIN/i;

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
class ErroFerramenta extends Error {
  constructor(mensagem, proximoPasso) { super(mensagem); this.proximoPasso = proximoPasso || null; }
}
const erro = (m, p) => new ErroFerramenta(m, p);

// Campos que são CÓDIGO (EAN, chave de acesso, CNPJ de empresa, ids): não passam
// pelo mascarador de texto, senão um código de 11 dígitos vira "[cpf]".
const CAMPO_CODIGO = /^(id|ids|codigo|codigos|ean|barcode|ref|sku|chaveAcesso|traceId|sinalId|propostaId|objetivoId|cnpj|cnpjEmitente|cnpjDestinatario|numero|serie|serial|loja|lojas)$/;
const CAMPO_SENSIVEL = /^(cpf|telefone|phone|fone|celular|email|e-mail|senha|password|pin|token|secret|chave|identitySalt|identityHash|privateKeySealed|credentialJwt)$/i;
function limpar(v, k, prof = 0) {
  if (prof > 10) return '[...]';
  if (k && CAMPO_CODIGO.test(k) && (typeof v === 'string' || typeof v === 'number')) return v;
  if (Array.isArray(v)) return v.map((x) => limpar(x, k, prof + 1));
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object') {
    const o = {};
    for (const [kk, x] of Object.entries(v)) o[kk] = CAMPO_SENSIVEL.test(kk) ? '[protegido]' : limpar(x, kk, prof + 1);
    return o;
  }
  return mascararPII(v);
}

function resposta(obj) {
  let texto = JSON.stringify(limpar(obj));
  if (texto.length > LIMITE_TEXTO) texto = texto.slice(0, LIMITE_TEXTO) + '…[cortado: refine a busca para ver o resto]';
  return { content: [{ type: 'text', text: texto }] };
}
function respostaErro(e) {
  const msg = e instanceof ErroFerramenta ? e.message : 'Falha interna ao consultar o TenisCash.';
  const prox = e instanceof ErroFerramenta ? e.proximoPasso : 'Tente de novo em instantes; se repetir, avise o dono (o erro ficou no log do servidor).';
  if (!(e instanceof ErroFerramenta)) console.error('[MCP] ferramenta falhou:', e && e.message);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(limpar({ erro: msg, proximoPasso: prox })) }] };
}

const trunc = (s, n = 280) => (s == null ? null : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const corDe = (ctx) => (ctx && typeof ctx === 'object' && ctx.color) || null;
const ordenarTamanho = (a, b) => {
  const na = parseFloat(String(a).replace(',', '.')); const nb = parseFloat(String(b).replace(',', '.'));
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  const g = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG'];
  const ia = g.indexOf(String(a).toUpperCase()); const ib = g.indexOf(String(b).toUpperCase());
  if (ia >= 0 && ib >= 0) return ia - ib;
  return String(a).localeCompare(String(b));
};
const codigoPublico = (b) => (b && !SEM_GTIN.test(b) ? b : null);

// Dia em America/Fortaleza (UTC-3 fixo, sem horário de verão).
function diaFortaleza(data) {
  let y, m, d;
  if (data) {
    const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(data));
    if (!p) throw erro('Data inválida: use AAAA-MM-DD (ex.: 2026-11-17).', 'Envie a data no formato AAAA-MM-DD ou omita para hoje.');
    [y, m, d] = [Number(p[1]), Number(p[2]), Number(p[3])];
  } else {
    const agora = new Date(Date.now() - 3 * 3600 * 1000);
    [y, m, d] = [agora.getUTCFullYear(), agora.getUTCMonth() + 1, agora.getUTCDate()];
  }
  const inicio = new Date(Date.UTC(y, m - 1, d, 3, 0, 0));
  if (Number.isNaN(inicio.getTime())) throw erro('Data inválida.', 'Use AAAA-MM-DD.');
  return { data: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, inicio, fim: new Date(inicio.getTime() + 24 * 3600 * 1000) };
}

// CNPJ destinatário → loja (CLAUDE.md). O banco (FiscalIssuer→Store) tem prioridade.
const LOJA_POR_CNPJ = {
  '44052617000126': 'LOJA01', '44052617000207': 'LOJA02', '44052617000398': 'LOJA03',
  '44052617000479': 'LOJA04', '44052617000550': 'LOJA05', '44052617000630': 'LOJA06',
};
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
// Regra do CLAUDE.md: transferência = CNPJ raiz igual (emitente×destinatário) OU CFOP 5152/6152.
// Não confia só no docType gravado (import antigo pode ter classificado errado).
function tipoPelaRegra(doc, cfops) {
  if (!doc) return 'outros';
  if (doc.docType === 'saida') return 'saida';
  const raiz = (c) => soDigitos(c).slice(0, 8);
  const mesmaRaiz = !!raiz(doc.issuerCnpj) && raiz(doc.issuerCnpj) === raiz(doc.recipientCnpj);
  const cfopTransf = (cfops || []).some((c) => ['5152', '6152'].includes(String(c || '')));
  return mesmaRaiz || cfopTransf ? 'transferencia' : 'entrada';
}

// ---------------------------------------------------------------------
// Ferramentas (por TAREFA)
// ---------------------------------------------------------------------
const LEITURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function registrarFerramentas(server, ctx) {
  const { db, ler, usuario } = ctx;
  const reg = (nome, def, fn) => server.registerTool(nome, def, async (args, extra) => {
    try { return resposta(await fn(args || {}, extra)); } catch (e) { return respostaErro(e); }
  });

  async function lojasPorId() {
    const lojas = await ler.store.findMany({ select: { id: true, code: true, name: true } });
    return new Map(lojas.map((l) => [l.id, l]));
  }
  function localizacao(storeStocks, lojas) {
    const por = {}; let total = 0;
    for (const s of storeStocks || []) {
      if (!s.stock) continue;
      const l = lojas.get(s.storeId) || (s.store ? s.store : null);
      const cod = (l && l.code) || s.storeId;
      por[cod] = (por[cod] || 0) + s.stock;
      total += s.stock;
    }
    return { porLoja: por, total };
  }

  // ---------------- LEITURA ----------------
  reg('estoque_por_codigo', {
    title: 'Estoque por código de barras (EAN)',
    description: 'Bipou ou leu um código de barras? Diz de qual produto/tamanho ele é, quanto foi COMPRADO (NF-e de entrada, número fixo) e onde está LOCALIZADO por loja (bipes/StoreStock). Comprado e localizado divergem de propósito durante a contagem: isso não é erro. "SEM GTIN" não é código e é recusado. Se o código não tem card, mostra se ele aparece em NF-e (entrada ou transferência).',
    inputSchema: { codigo: z.string().min(4).max(32).describe('Código de barras (EAN/GTIN) exatamente como lido, ex.: 7908341493884') },
    annotations: Object.assign({ title: 'Estoque por código' }, LEITURA),
  }, async ({ codigo }) => {
    const c = String(codigo).trim();
    if (SEM_GTIN.test(c)) throw erro('"SEM GTIN" não é código de barras: existe em milhares de itens de todas as marcas.', 'Peça o código impresso na etiqueta/caixa ou use estoque_por_produto com a referência.');
    const variantes = [...new Set([c, c.replace(/^0+/, ''), '0' + c].filter((x) => x && !SEM_GTIN.test(x)))];
    const [lojas, tamanhos] = await Promise.all([
      lojasPorId(),
      ler.productSize.findMany({
        where: { barcode: { in: variantes } }, take: 5,
        select: { id: true, size: true, stock: true, barcode: true, sizeConfirmedAt: true, storeStocks: { select: { storeId: true, stock: true } }, product: { select: { id: true, sku: true, name: true, brand: true, active: true, aiContext: true } } },
      }),
    ]);
    const nfe = await ler.xmlFiscalItem.findMany({ where: { ean: { in: variantes } }, take: 200, select: { quantity: true, productId: true, cfop: true, fiscalDocument: { select: { docType: true, issuerCnpj: true, recipientCnpj: true } } } });
    const resumoNfe = { entrada: { itens: 0, qtd: 0 }, transferencia: { itens: 0, qtd: 0 }, outros: { itens: 0, qtd: 0 } };
    for (const i of nfe) {
      const t0 = tipoPelaRegra(i.fiscalDocument, [i.cfop]);
      const t = t0 === 'saida' ? 'outros' : t0;
      resumoNfe[t].itens++; resumoNfe[t].qtd += Number(i.quantity) || 0;
    }
    if (!tamanhos.length) {
      return {
        encontrado: false, codigo: c, nfe: resumoNfe,
        explicacao: resumoNfe.entrada.itens
          ? 'O código está em NF-e de ENTRADA mas não está vinculado a nenhum tamanho de card.'
          : resumoNfe.transferencia.itens
            ? 'O código só aparece em TRANSFERÊNCIA: transferência nunca cria card; falta a NF-e de entrada original.'
            : 'Código desconhecido no cadastro e nas NF-e importadas.',
        proximoPasso: 'Não invente o produto/tamanho. Confira a etiqueta física e procure por referência com estoque_por_produto.',
      };
    }
    return {
      encontrado: true, codigo: c,
      resultados: tamanhos.map((t) => {
        const loc = localizacao(t.storeStocks, lojas);
        return {
          produto: { id: t.product.id, ref: t.product.sku, nome: t.product.name, marca: t.product.brand, cor: corDe(t.product.aiContext), ativo: t.product.active },
          tamanho: t.size, tamanhoConfirmadoPelaCaixa: !!t.sizeConfirmedAt, codigo: t.barcode,
          comprado: t.stock, localizado: loc.porLoja, totalLocalizado: loc.total, faltaLocalizar: Math.max(0, (t.stock || 0) - loc.total),
          alerta: loc.total > (t.stock || 0) ? 'localizado maior que comprado: conferir na loja (nunca apagar bipe)' : undefined,
        };
      }),
      nfe: resumoNfe,
    };
  });

  reg('estoque_por_produto', {
    title: 'Estoque por produto (referência ou nome)',
    description: 'Procura o card pela REFERÊNCIA (Product.sku / ref do fornecedor) ou por palavras do nome e devolve cada tamanho com código, COMPRADO e LOCALIZADO por loja. Use para "tem o modelo X no 41 em qual loja?". Só cards ativos, a não ser que incluirInativos=true. Máximo 10 cards por chamada.',
    inputSchema: {
      busca: z.string().min(2).max(80).describe('Referência (ex.: CK09090001) ou palavras do nome (ex.: "megaride 01")'),
      incluirInativos: z.boolean().optional().describe('true para incluir cards desativados'),
      limite: z.number().int().min(1).max(10).optional().describe('Quantos cards no máximo (padrão 5)'),
    },
    annotations: Object.assign({ title: 'Estoque por produto' }, LEITURA),
  }, async ({ busca, incluirInativos, limite }) => {
    const b = String(busca).trim();
    let termos = b.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
    if (!termos.length) termos = [b]; // nunca AND vazio (casaria o catálogo inteiro)
    const lim = limite || 5;
    const where = { AND: [incluirInativos ? {} : { active: true }, { OR: [
      { sku: { equals: b, mode: 'insensitive' } },
      { sku: { startsWith: b, mode: 'insensitive' } },
      { AND: termos.map((t) => ({ name: { contains: t, mode: 'insensitive' } })) },
    ] }] };
    const [lojas, total, produtos] = await Promise.all([
      lojasPorId(),
      ler.product.count({ where }),
      ler.product.findMany({
        where, take: 40, orderBy: { updatedAt: 'desc' },
        select: { id: true, sku: true, name: true, brand: true, active: true, price: true, aiContext: true, sizes: { select: { size: true, stock: true, barcode: true, sizeConfirmedAt: true, storeStocks: { select: { storeId: true, stock: true } } } } },
      }),
    ]);
    if (!produtos.length) throw erro(`Nenhum card ${incluirInativos ? '' : 'ativo '}encontrado para "${b}".`, 'Tente só a referência, menos palavras, ou incluirInativos=true. Com o código de barras use estoque_por_codigo.');
    const up = b.toUpperCase();
    produtos.sort((x, y) => (y.sku.toUpperCase() === up) - (x.sku.toUpperCase() === up) || (y.sku.toUpperCase().startsWith(up)) - (x.sku.toUpperCase().startsWith(up)));
    return {
      totalEncontrados: total,
      mostrando: Math.min(lim, produtos.length),
      dica: total > lim ? 'Há mais cards: refine a busca (referência exata ou mais palavras).' : undefined,
      produtos: produtos.slice(0, lim).map((p) => {
        let comprado = 0; let localizado = 0;
        const tamanhos = p.sizes.slice().sort((a, c) => ordenarTamanho(a.size, c.size)).map((s) => {
          const loc = localizacao(s.storeStocks, lojas);
          comprado += s.stock || 0; localizado += loc.total;
          return { tam: s.size, codigo: codigoPublico(s.barcode), comprado: s.stock, localizado: loc.porLoja, confirmadoPelaCaixa: !!s.sizeConfirmedAt };
        });
        return { id: p.id, ref: p.sku, nome: p.name, marca: p.brand, cor: corDe(p.aiContext), ativo: p.active, precoVenda: p.price, totalComprado: comprado, totalLocalizado: localizado, tamanhos };
      }),
    };
  });

  reg('vendas_do_dia', {
    title: 'Vendas do dia por loja',
    description: 'Total vendido, nº de vendas, peças, desconto e ticket médio por loja num dia (horário de Fortaleza, 00:00–23:59). Conta só vendas concluídas; canceladas/estornadas aparecem à parte. Sem data = hoje.',
    inputSchema: {
      data: z.string().optional().describe('Dia no formato AAAA-MM-DD (padrão: hoje em Fortaleza)'),
      loja: z.string().max(40).optional().describe('Código (LOJA02) ou parte do nome (Bessa) para filtrar uma loja'),
    },
    annotations: Object.assign({ title: 'Vendas do dia' }, LEITURA),
  }, async ({ data, loja }) => {
    const dia = diaFortaleza(data);
    const lojas = await lojasPorId();
    let filtroLoja = null;
    if (loja) {
      const q = String(loja).trim().toUpperCase();
      const achada = [...lojas.values()].find((l) => l.code.toUpperCase() === q) || [...lojas.values()].find((l) => l.name.toUpperCase().includes(q));
      if (!achada) throw erro(`Loja "${loja}" não encontrada.`, 'Use o código (LOJA01…LOJA07) ou parte do nome: ' + [...lojas.values()].map((l) => l.code + ' ' + l.name).join(', '));
      filtroLoja = achada.id;
    }
    const base = { createdAt: { gte: dia.inicio, lt: dia.fim }, ...(filtroLoja ? { storeId: filtroLoja } : {}) };
    const [ok, outros] = await Promise.all([
      ler.sale.groupBy({ by: ['storeId'], where: Object.assign({}, base, { status: 'completed' }), _sum: { totalAmount: true, discount: true, tcUsed: true }, _count: { _all: true } }),
      ler.sale.groupBy({ by: ['status'], where: Object.assign({}, base, { status: { not: 'completed' } }), _sum: { totalAmount: true }, _count: { _all: true } }),
    ]);
    const porLoja = [];
    for (const g of ok) {
      const pecas = await ler.saleItem.aggregate({ _sum: { quantity: true }, where: { sale: Object.assign({}, base, { status: 'completed', storeId: g.storeId }) } });
      const l = g.storeId ? lojas.get(g.storeId) : null;
      const total = Number((g._sum.totalAmount || 0).toFixed(2));
      porLoja.push({ loja: l ? l.code : g.storeId ? g.storeId : 'SEM-LOJA', nomeLoja: l ? l.name : null, vendas: g._count._all, totalRS: total, pecas: pecas._sum.quantity || 0, descontoRS: Number((g._sum.discount || 0).toFixed(2)), tenisCashUsadoRS: Number((g._sum.tcUsed || 0).toFixed(2)), ticketMedioRS: g._count._all ? Number((total / g._count._all).toFixed(2)) : 0 });
    }
    porLoja.sort((a, b) => b.totalRS - a.totalRS);
    const total = porLoja.reduce((s, x) => s + x.totalRS, 0);
    return {
      data: dia.data, fuso: 'America/Fortaleza',
      totalRS: Number(total.toFixed(2)), vendas: porLoja.reduce((s, x) => s + x.vendas, 0), porLoja,
      naoConcluidas: outros.map((o) => ({ status: o.status, vendas: o._count._all, totalRS: Number((o._sum.totalAmount || 0).toFixed(2)) })),
    };
  });

  reg('nfe_por_chave', {
    title: 'NF-e por chave de acesso',
    description: 'Resumo de uma NF-e importada pela chave de 44 dígitos: emitente (fornecedor = EMISSOR), destinatário e loja, valor, itens, e se é ENTRADA (compra, conta como comprado) ou TRANSFERÊNCIA (movimento interno: nunca conta como compra nem cria card). Recalcula a classificação pela regra (CNPJ raiz igual ou CFOP 5152/6152) e avisa se diverge do gravado.',
    inputSchema: { chave: z.string().min(44).max(60).describe('Chave de acesso de 44 dígitos (pode ter espaços/pontos)') },
    annotations: Object.assign({ title: 'NF-e por chave' }, LEITURA),
  }, async ({ chave }) => {
    const k = soDigitos(chave);
    if (k.length !== 44) throw erro(`A chave tem ${k.length} dígitos; precisa de 44.`, 'Copie a chave inteira do DANFE/XML (44 dígitos).');
    const doc = await ler.xmlFiscalDocument.findUnique({ where: { accessKey: k }, select: { id: true, number: true, series: true, issuerCnpj: true, issuerName: true, recipientCnpj: true, recipientName: true, issueDate: true, totalValue: true, docType: true, status: true, createdAt: true } });
    if (!doc) throw erro('NF-e não importada no TenisCash.', 'Procure o XML no disco (Downloads/Documents/Desktop/OneDrive; o nome do arquivo costuma ser a chave) e importe pela aba NFE Geral. Os dígitos 3-6 da chave são AAMM da emissão.');
    const itens = await ler.xmlFiscalItem.findMany({ where: { fiscalDocumentId: doc.id }, take: 3000, select: { supplierCode: true, description: true, ean: true, quantity: true, cfop: true, productId: true } });
    const pelaRegra = tipoPelaRegra(doc, itens.map((i) => i.cfop));
    let loja = null;
    if (doc.recipientCnpj) {
      const emissor = await ler.fiscalIssuer.findUnique({ where: { cnpj: soDigitos(doc.recipientCnpj) }, select: { id: true } }).catch(() => null);
      const st = emissor ? await ler.store.findFirst({ where: { fiscalIssuerId: emissor.id }, select: { code: true, name: true } }) : null;
      loja = st ? st.code : LOJA_POR_CNPJ[soDigitos(doc.recipientCnpj)] || null;
    }
    const tipo = doc.docType || pelaRegra;
    const semGtin = itens.filter((i) => !i.ean || SEM_GTIN.test(i.ean)).length;
    return {
      chaveAcesso: k, numero: doc.number, serie: doc.series, emissao: doc.issueDate,
      cnpjEmitente: doc.issuerCnpj, emitente: doc.issuerName, cnpjDestinatario: doc.recipientCnpj, destinatario: doc.recipientName, loja,
      valorTotalRS: doc.totalValue, tipoGravado: doc.docType, tipoPelaRegra: pelaRegra,
      divergente: !!doc.docType && doc.docType !== pelaRegra ? 'classificação gravada difere da regra: revisar antes de usar em compra/custo' : undefined,
      contaComoCompra: tipo === 'entrada',
      regra: tipo === 'transferencia' ? 'Transferência: não é compra, não mexe em custo nem cria card; aparece só no card que já existe.' : tipo === 'entrada' ? 'Entrada: compra de fornecedor (o fornecedor é o EMITENTE).' : undefined,
      itens: {
        linhas: itens.length, quantidade: itens.reduce((s, i) => s + (Number(i.quantity) || 0), 0),
        vinculados: itens.filter((i) => i.productId).length, semVinculo: itens.filter((i) => !i.productId).length, semGtin,
        amostra: itens.slice(0, 10).map((i) => ({ ref: i.supplierCode, descricao: trunc(i.description, 90), ean: codigoPublico(i.ean), qtd: i.quantity, cfop: i.cfop, vinculado: !!i.productId })),
      },
    };
  });

  reg('produto_nuvemshop_status', {
    title: 'Produto pode subir pra Nuvemshop?',
    description: 'Roda a MESMA trava de publicação do site (src/services/nuvemshopEligibility) e explica, item por item, por que o card pode ou não subir: 4 classificações (categoria, sub, modalidade, especialidade), foto, descrição, preço de venda > custo, cor por extenso, nome limpo, estoque físico > 0 nas lojas que valem pro site, códigos de barras. Só lê; não publica nada.',
    inputSchema: { produto: z.string().min(2).max(80).describe('id do card, referência (sku) ou código de barras de um tamanho') },
    annotations: Object.assign({ title: 'Status Nuvemshop do produto' }, LEITURA),
  }, async ({ produto }) => {
    const q = String(produto).trim();
    if (SEM_GTIN.test(q)) throw erro('"SEM GTIN" não identifica produto.', 'Use o id, a referência ou um código de barras real.');
    const sel = { include: { sizes: { include: { storeStocks: nuvemshopStoreStocksQuery() } } } };
    let p = await ler.product.findUnique(Object.assign({ where: { id: q } }, sel)).catch(() => null);
    if (!p) p = await ler.product.findUnique(Object.assign({ where: { sku: q } }, sel));
    if (!p) {
      const ps = await ler.productSize.findFirst({ where: { barcode: q }, select: { productId: true } });
      if (ps) p = await ler.product.findUnique(Object.assign({ where: { id: ps.productId } }, sel));
    }
    if (!p) throw erro(`Card "${q}" não encontrado por id, referência ou código.`, 'Ache o card com estoque_por_produto e use o id que ele devolver.');
    const a = assessProductForNuvemshop(p);
    const mapa = await ler.nuvemshopProductMapping.findUnique({ where: { localProductId: p.id }, select: { nuvemshopProductId: true, syncStatus: true, lastSyncedAt: true } });
    const cls = (a.context && a.context.classification) || {};
    return {
      id: p.id, ref: p.sku, nome: p.name, marca: p.brand,
      podeSubir: a.eligible,
      motivosQueBarram: a.reasons,
      avisos: a.warnings,
      checagem: {
        classificacao: { categoria: p.category || null, subcategoria: p.subcategory || null, modalidade: cls.modality || null, especialidade: cls.tier || null },
        temFoto: !a.reasons.includes('sem foto valida'), temDescricao: !a.reasons.includes('sem descricao'),
        precoVendaRS: p.price, temCusto: Number(p.costPrice || 0) > 0, precoAcimaDoCusto: !(Number(p.costPrice || 0) > 0) || Number(p.price || 0) > Number(p.costPrice || 0),
        tamanhosComEstoqueFisicoSite: a.publicSizes.map((s) => ({ tam: s.size, fisico: s.stock })),
      },
      naLojaVirtual: mapa ? { nuvemshopProductId: mapa.nuvemshopProductId, sync: mapa.syncStatus, ultimaSync: mapa.lastSyncedAt } : null,
      proximoPasso: a.eligible
        ? (mapa ? 'Já está mapeado: a sincronização automática mantém a vitrine.' : 'Elegível: a subida automática (de hora em hora) pega este card; nada a fazer aqui.')
        : 'Corrija os motivos no admin (classificação/foto/descrição/preço). Não invente dado que não está na fonte.',
    };
  });

  reg('propostas_pendentes', {
    title: 'Propostas da rede esperando o dono',
    description: 'Lista as propostas da Rede Neural de Agentes que aguardam decisão (aprovar, rejeitar ou pedir correção), com título, risco, prévia do que muda, evidência e quem propôs. Use antes de decidir_proposta.',
    inputSchema: { limite: z.number().int().min(1).max(50).optional().describe('Quantas (padrão 20)') },
    annotations: Object.assign({ title: 'Propostas pendentes' }, LEITURA),
  }, async ({ limite }) => {
    const [total, lista] = await Promise.all([
      ler.aIApproval.count({ where: { type: { startsWith: 'rna_' }, status: 'pending' } }),
      ler.aIApproval.findMany({ where: { type: { startsWith: 'rna_' }, status: 'pending' }, orderBy: { createdAt: 'desc' }, take: limite || 20 }),
    ]);
    return {
      total,
      propostas: lista.map((p) => {
        const pl = p.payload || {}; const rna = pl.rna || {};
        return { propostaId: p.id, tipo: p.type, titulo: p.title, risco: p.riskLevel, criadaEm: p.createdAt, neuronio: rna.neuronio || null, traceId: rna.traceId || null, impactoRS: rna.impactoRS || null, acao: (pl.acao && pl.acao.nome) || 'rna.registrar', previa: trunc(typeof pl.previa === 'string' ? pl.previa : JSON.stringify(pl.previa || null), 400), evidencia: (Array.isArray(pl.evidencia) ? pl.evidencia : []).slice(0, 5).map((e) => trunc(typeof e === 'string' ? e : JSON.stringify(e), 160)), descricao: trunc(p.description, 400) };
      }),
    };
  });

  reg('rastro_da_rede', {
    title: 'Rastro de um evento na rede',
    description: 'Mostra o caminho de um evento (traceId) pela rede: sinais que correram, mini agentes que acenderam (status, custo R$, tempo, erro) e propostas geradas. Use com o traceId devolvido por perguntar_a_rede ou listado em propostas_pendentes.',
    inputSchema: { traceId: z.string().min(3).max(80).describe('Identificador do rastro, ex.: tr_lx…') },
    annotations: Object.assign({ title: 'Rastro da rede' }, LEITURA),
  }, async ({ traceId }) => {
    const id = String(traceId).trim();
    const [sinais, ativacoes, propostas] = await Promise.all([
      ler.rnaSinal.findMany({ where: { traceId: id }, orderBy: { criadoEm: 'asc' }, take: 100 }),
      ler.rnaAtivacao.findMany({ where: { traceId: id }, orderBy: { criadoEm: 'asc' }, take: 150 }),
      ler.aIApproval.findMany({ where: { type: { startsWith: 'rna_' }, payload: { path: ['rna', 'traceId'], equals: id } }, take: 30 }),
    ]);
    if (!sinais.length) throw erro('Rastro não encontrado.', 'Confira o traceId. Se acabou de perguntar, espere alguns segundos; se a rede estiver desligada (RNA_ATIVA=0) nenhum rastro é gravado.');
    const custo = ativacoes.reduce((s, a) => s + (a.custoRS || 0), 0);
    return {
      traceId: id, custoRS: Number(custo.toFixed(4)), emAndamento: ativacoes.length === 0 ? 'nenhum mini agente acendeu (ainda)' : undefined,
      sinais: sinais.map((s) => { const d = Object.assign({}, s.dados || {}); delete d._caminho; return { tipo: s.tipo, origem: s.origem, profundidade: s.profundidade, forca: s.forca, loja: s.loja, em: s.criadoEm, dados: trunc(JSON.stringify(d), 240) }; }),
      ativacoes: ativacoes.map((a) => ({ neuronio: a.neuronio, status: a.status, ativacao: a.ativacao, custoRS: a.custoRS, ms: a.ms, erro: trunc(a.erro, 200), em: a.criadoEm })),
      propostas: propostas.map((p) => ({ propostaId: p.id, titulo: p.title, status: p.status, risco: p.riskLevel })),
    };
  });

  reg('painel_da_rede', {
    title: 'Painel da rede',
    description: 'Visão geral da Rede Neural de Agentes: ligada/desligada, gasto de IA hoje x teto, propostas pendentes, mini agentes (ativos, por camada, os que mais disparam e quanto acertam), objetivos ativos e candidatos a poda.',
    inputSchema: {},
    annotations: Object.assign({ title: 'Painel da rede' }, LEITURA),
  }, async () => {
    const { motor, aprendizado } = require('../index');
    const [linhas, gasto, objetivos, pendentes, poda] = await Promise.all([
      ler.rnaNeuronio.findMany({ orderBy: { disparos: 'desc' } }),
      motor.gastoHoje(),
      ler.rnaObjetivo.findMany({ where: { status: { in: ['ativo', 'pausado'] } }, orderBy: { criadoEm: 'desc' }, take: 20 }),
      ler.aIApproval.count({ where: { type: { startsWith: 'rna_' }, status: 'pending' } }),
      aprendizado.candidatosPoda(db).catch(() => []),
    ]);
    const porCamada = {};
    for (const n of linhas) porCamada[n.camada] = (porCamada[n.camada] || 0) + 1;
    return {
      ativa: process.env.RNA_ATIVA !== '0',
      gastoHojeRS: Number((gasto || 0).toFixed(4)), tetoDiaRS: Number(process.env.RNA_ORCAMENTO_DIA_RS || 5),
      propostasPendentes: pendentes,
      neuronios: { total: linhas.length, ativos: linhas.filter((n) => n.ativo).length, porCamada, carregadosNoCodigo: motor.estado.neuronios.size, errosDeContrato: motor.estado.errosRegistro.length },
      maisAtivos: linhas.slice(0, 10).map((n) => ({ id: n.id, camada: n.camada, ativo: n.ativo, disparos: n.disparos, acertos: n.acertos, erros: n.erros, custoRS: Number((n.custoRS || 0).toFixed(4)), limiar: n.limiar })),
      objetivos: objetivos.map((o) => ({ objetivoId: o.id, texto: trunc(o.texto, 160), status: o.status, loja: o.loja, prazo: o.prazo, gastoRS: o.gastoRS })),
      candidatosPoda: poda.slice(0, 10),
    };
  });

  reg('medalhas_do_atleta', {
    title: 'Medalhas públicas do atleta',
    description: 'Medalhas e conquistas PÚBLICAS de um atleta do Club pelo @handle: medalhas verificáveis (série, evento, colocação) quando o módulo de medalhas está no ar, e conquistas do app (badges). Nunca devolve CPF, código de titularidade nem a credencial assinada.',
    inputSchema: { handle: z.string().min(2).max(60).describe('@ do atleta, ex.: @douglas ou douglas') },
    annotations: Object.assign({ title: 'Medalhas do atleta' }, LEITURA),
  }, async ({ handle }) => {
    const h = String(handle).trim().replace(/^@/, '');
    let user = await ler.user.findUnique({ where: { username: h }, select: { id: true, name: true, username: true } }).catch(() => null);
    if (!user) {
      const ap = await ler.athleteProfile.findUnique({ where: { username: h }, select: { userId: true } });
      if (ap) user = await ler.user.findUnique({ where: { id: ap.userId }, select: { id: true, name: true, username: true } });
    }
    if (!user) throw erro(`Atleta @${h} não encontrado.`, 'Confira o @ (o mesmo do card público /atleta/<handle>).');
    const badges = await ler.badgeEarned.findMany({ where: { userId: user.id }, orderBy: { earnedAt: 'desc' }, take: 50, select: { badgeKey: true, earnedAt: true } });
    let medalhas = null;
    if (ler.medal && typeof ler.medal.findMany === 'function') {
      const ms = await ler.medal.findMany({ where: { userId: user.id, status: 'ACTIVE' }, orderBy: { issuedAt: 'desc' }, take: 50, select: { serial: true, sport: true, eventName: true, categoryName: true, achievement: true, tier: true, placement: true, editionNumber: true, editionTotal: true, eventDate: true, issuedAt: true } }).catch(() => []);
      medalhas = ms.map((m) => ({ serial: m.serial, esporte: m.sport, evento: m.eventName, categoria: m.categoryName, conquista: m.achievement, nivel: m.tier, colocacao: m.placement, edicao: m.editionNumber && m.editionTotal ? `${m.editionNumber}/${m.editionTotal}` : null, data: m.eventDate || m.issuedAt }));
    }
    return {
      atleta: { handle: '@' + (user.username || h), nome: user.name, cardPublico: '/atleta/' + (user.username || h) },
      medalhas: medalhas === null ? 'módulo de medalhas verificáveis ainda não está neste servidor' : medalhas,
      conquistas: badges.map((b) => ({ badge: b.badgeKey, em: b.earnedAt })),
    };
  });

  // ---------------- PROPOR (não executa) ----------------
  reg('perguntar_a_rede', {
    title: 'Perguntar à rede',
    description: 'Manda uma pergunta/pedido do dono para a Rede Neural de Agentes (sinal dono.pergunta). Não executa nada: os mini agentes analisam e, se for o caso, geram PROPOSTAS para o dono aprovar. Devolve o traceId; acompanhe com rastro_da_rede e veja propostas em propostas_pendentes. Pode gastar IA dentro do teto diário.',
    inputSchema: {
      pergunta: z.string().min(5).max(1000).describe('O que o dono quer saber/resolver, em português'),
      loja: z.string().max(10).optional().describe('Código da loja (LOJA02…) se a pergunta for de uma loja'),
    },
    annotations: { title: 'Perguntar à rede', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ pergunta, loja }) => {
    const rede = require('../index');
    if (process.env.RNA_ATIVA === '0') throw erro('A rede está desligada (RNA_ATIVA=0).', 'Peça ao dono para ligar a rede no Railway (RNA_ATIVA) ou use as ferramentas de leitura.');
    const cfg = rede.SENSORES['dono.pergunta'];
    const lj = loja && /^LOJA\d{2}$/i.test(loja) ? loja.toUpperCase() : null;
    const s = await rede.emitir(Object.assign({}, cfg, { tipo: 'dono.pergunta', loja: lj, dados: { texto: String(pergunta).trim(), userId: usuario.id, pedidoDono: true, canal: 'mcp' } }));
    if (!s) throw erro('A rede não aceitou o sinal agora.', 'Tente de novo em instantes; se repetir, confira o painel_da_rede.');
    return { traceId: s.traceId, sinalId: s.id, status: 'enviado', proximoPasso: 'Aguarde alguns segundos e chame rastro_da_rede com este traceId; propostas geradas aparecem em propostas_pendentes.' };
  });

  const rascunhosHoje = { dia: null, n: 0 };
  reg('criar_objetivo_rascunho', {
    title: 'Rascunho de objetivo para a rede',
    description: 'Transforma um objetivo de negócio escrito pelo dono (ex.: "girar o estoque parado de Skechers no Bessa em 30 dias") em RASCUNHO com KPIs, região da rede, restrições, prazo e orçamento de IA. NÃO cria nem ativa o objetivo: o dono revisa e ativa no painel da rede. Usa a IA forte (custa centavos); máx. 20 rascunhos por dia.',
    inputSchema: { texto: z.string().min(8).max(500).describe('Objetivo em linguagem natural') },
    annotations: { title: 'Rascunho de objetivo', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ texto }) => {
    const hoje = diaFortaleza().data;
    if (rascunhosHoje.dia !== hoje) { rascunhosHoje.dia = hoje; rascunhosHoje.n = 0; }
    if (rascunhosHoje.n >= 20) throw erro('Limite de 20 rascunhos de objetivo por dia atingido.', 'Revise os rascunhos já feitos ou tente amanhã.');
    rascunhosHoje.n++;
    const r = await require('../objetivos').compilar(String(texto).trim());
    return { rascunho: r, ativado: false, proximoPasso: 'Mostre o rascunho ao dono. Para valer, ele revisa e cria o objetivo no painel da rede (POST /api/admin/rede/objetivos); este servidor nunca ativa objetivo sozinho.' };
  });

  // ---------------- DECIDIR (destrutiva, exige confirmação do dono) ----------------
  reg('decidir_proposta', {
    title: 'Decidir proposta da rede (dono)',
    description: 'Registra a decisão do DONO numa proposta pendente: approved (aprovar), rejected (rejeitar) ou correction_requested (pedir correção, com nota). A decisão ajusta o aprendizado da rede e NÃO executa a ação (a execução continua no painel). CONFIRMAÇÃO OBRIGATÓRIA: se o seu cliente MCP suporta elicitation, o servidor pergunta ao dono na tela e só decide com "confirmo". Se não suporta, a primeira chamada só mostra a prévia; mostre-a ao dono e chame de novo com confirmar=true SOMENTE depois do "sim" explícito dele. Nunca confirme por conta própria.',
    inputSchema: {
      propostaId: z.string().min(5).max(60).describe('id da proposta (de propostas_pendentes)'),
      decisao: z.enum(['approved', 'rejected', 'correction_requested']).describe('approved = aprovar · rejected = rejeitar · correction_requested = pedir correção'),
      nota: z.string().max(1000).optional().describe('Motivo/observação do dono (obrigatória para correction_requested)'),
      confirmar: z.boolean().optional().describe('true SOMENTE depois que o dono disse "sim" explicitamente para esta decisão'),
    },
    annotations: { title: 'Decidir proposta', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ propostaId, decisao, nota, confirmar }, extra) => {
    const ap = await db.aIApproval.findUnique({ where: { id: String(propostaId) } });
    if (!ap || !String(ap.type).startsWith('rna_')) throw erro('Proposta da rede não encontrada.', 'Liste as pendentes com propostas_pendentes e use o propostaId exato.');
    if (ap.status !== 'pending') throw erro(`Proposta já decidida (${ap.status}).`, 'Nada a fazer; veja o histórico no painel da rede.');
    if (decisao === 'correction_requested' && !(nota && nota.trim())) throw erro('Pedir correção exige nota dizendo o que corrigir.', 'Chame de novo com nota="o que está errado".');
    const ROTULO = { approved: 'APROVAR', rejected: 'REJEITAR', correction_requested: 'PEDIR CORREÇÃO' };
    const pl = ap.payload || {};
    const previa = {
      propostaId: ap.id, titulo: ap.title, risco: ap.riskLevel, decisao: ROTULO[decisao], nota: nota || null,
      acaoSeAprovada: (pl.acao && pl.acao.nome) || 'rna.registrar (só registra)',
      oQueMuda: trunc(typeof pl.previa === 'string' ? pl.previa : JSON.stringify(pl.previa || null), 500),
      evidencia: (Array.isArray(pl.evidencia) ? pl.evidencia : []).slice(0, 5).map((e) => trunc(typeof e === 'string' ? e : JSON.stringify(e), 160)),
    };

    const caps = server.server.getClientCapabilities() || {};
    let confirmadoPor = null;
    if (caps.elicitation) {
      let r;
      try {
        r = await server.server.elicitInput({
          message: limpar({ m: `Confirma ${ROTULO[decisao]} a proposta "${ap.title}" (risco ${ap.riskLevel})? Ação se aprovada: ${previa.acaoSeAprovada}.${nota ? ' Nota: ' + nota : ''}` }).m,
          requestedSchema: { type: 'object', properties: { confirmo: { type: 'boolean', title: 'Confirmo esta decisão', description: 'Marque só se você (dono) quer registrar esta decisão.' } }, required: ['confirmo'] },
        }, { relatedRequestId: extra && extra.requestId, timeout: 5 * 60 * 1000 });
      } catch (e) {
        r = null;
        if (!confirmar) throw erro('Não consegui perguntar ao dono na tela (' + trunc(e.message, 120) + '). Nada foi decidido.', 'Mostre a prévia ao dono e, só depois do "sim" dele, chame de novo com confirmar=true.');
      }
      if (r) {
        if (r.action !== 'accept' || !r.content || r.content.confirmo !== true) {
          return { decidido: false, motivo: 'O dono não confirmou na tela (' + r.action + ').', previa, proximoPasso: 'Nada mudou. Pergunte ao dono o que ele prefere.' };
        }
        confirmadoPor = 'elicitation';
      }
    }
    if (!confirmadoPor) {
      if (confirmar !== true) {
        return { decidido: false, aguardandoConfirmacao: true, previa, proximoPasso: 'Mostre esta prévia ao dono. Só depois do "sim" explícito dele, chame decidir_proposta de novo com os mesmos dados e confirmar=true.' };
      }
      confirmadoPor = 'confirmar=true';
    }

    // Atômico: só decide se continua pendente (dois cliques não decidem duas vezes).
    const nota2 = [nota || null, '[via MCP, ' + confirmadoPor + ']'].filter(Boolean).join(' ');
    const r = await db.aIApproval.updateMany({ where: { id: ap.id, status: 'pending' }, data: { status: decisao, decisionNote: nota2.slice(0, 1000), approvedById: usuario.id, decidedAt: new Date() } });
    if (r.count !== 1) throw erro('A proposta foi decidida por outra pessoa/janela agora há pouco.', 'Liste de novo com propostas_pendentes.');
    const atualizada = await db.aIApproval.findUnique({ where: { id: ap.id } });
    const aprendizagem = await require('../aprendizado').aoDecidir(atualizada, db).catch((e) => ({ erro: e.message }));
    console.log(`[MCP] proposta ${ap.id} → ${decisao} por ${usuario.id} (${confirmadoPor})`);
    return {
      decidido: true, propostaId: ap.id, status: decisao, confirmadoPor,
      ajustesDeAprendizado: (aprendizagem.ajustes || []).length, erroAprendizado: aprendizagem.erro,
      proximoPasso: decisao === 'approved' ? 'Aprovada (não executada). A execução da ação continua no painel da rede, por pessoa.' : 'Registrado.',
    };
  });
}

function criarServidor(ctx) {
  const server = new McpServer(
    { name: 'teniscash', title: 'TenisCash — Sports & Tennis', version: VERSAO },
    { instructions: 'Servidor do TenisCash (varejo Sports & Tennis + Club). Ferramentas por tarefa: estoque, vendas, NF-e, Nuvemshop, rede de agentes, medalhas. Regras: nunca inventar dado (tamanho, cor, preço); comprado (NF-e) e localizado (bipe) são medidas diferentes; transferência não é compra; nada muda preço, envia mensagem ou publica; decidir_proposta só com o "sim" explícito do dono.' },
  );
  registrarFerramentas(server, ctx);
  return server;
}

// ---------------------------------------------------------------------
// HTTP (Express)
// ---------------------------------------------------------------------
function rpcErro(res, status, mensagem, extra = {}) {
  if (res.headersSent) return;
  if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="teniscash-mcp"');
  res.status(status).json({ jsonrpc: '2.0', error: { code: extra.code || -32001, message: mensagem }, id: null });
}

function mount(app, opcoes = {}) {
  const db = opcoes.db || prisma;
  const ler = soLeitura(db);
  const usarSessoes = opcoes.sessoes != null ? !!opcoes.sessoes : process.env.MCP_SESSOES !== '0';
  const sessoes = new Map(); // id → { transport, server, userId, visto }

  // Só header Bearer + JWT válido + conta ativa + papel de dono.
  function exigirDono(req, res, next) {
    const h = String(req.headers.authorization || '');
    if (!/^Bearer\s+\S+/i.test(h)) return rpcErro(res, 401, 'Sem token. Envie o header "Authorization: Bearer <JWT do TenisCash>" de um usuário admin (o mesmo login do /admin).');
    authMiddleware(req, {
      status: (s) => ({ json: (b) => rpcErro(res, s, (b && b.error ? b.error + '. ' : '') + 'Gere um token novo fazendo login no admin.') }),
    }, () => {
      if (!isAdminRole(req.userRole)) return rpcErro(res, 403, 'Acesso só para o dono/administração (admin, superadmin ou manager).');
      req.headers['accept-encoding'] = 'identity'; // compression não pode segurar o fluxo SSE
      next();
    });
  }

  const limite = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.MCP_RATE_MIN || 240), keyGenerator: (req) => 'mcp:' + req.userId, validate: false, standardHeaders: true, legacyHeaders: false, handler: (req, res) => rpcErro(res, 429, 'Muitas chamadas por minuto. Espere um pouco.') });
  const corpo = express.json({ limit: '1mb' });
  const ctxDe = (req) => ({ db, ler, usuario: { id: req.userId, role: req.userRole } });

  function sessaoDe(req, res) {
    const sid = req.headers['mcp-session-id'];
    if (!sid || !usarSessoes) return { sid: null };
    const s = sessoes.get(String(sid));
    if (s && s.userId !== req.userId) { rpcErro(res, 403, 'Esta sessão pertence a outro usuário. Reconecte com o seu token.'); return { negado: true }; }
    if (s) s.visto = Date.now();
    return { sid, s };
  }

  async function semEstado(req, res) {
    const server = criarServidor(ctxDe(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  function fecharMaisAntiga() {
    let velha = null;
    for (const [id, s] of sessoes) if (!velha || s.visto < velha[1].visto) velha = [id, s];
    if (velha) { sessoes.delete(velha[0]); velha[1].transport.close().catch(() => {}); }
  }

  const post = async (req, res) => {
    try {
      const { negado, s } = sessaoDe(req, res);
      if (negado) return;
      if (s) return await s.transport.handleRequest(req, res, req.body);
      if (usarSessoes && isInitializeRequest(req.body)) {
        while (sessoes.size >= MAX_SESSOES) fecharMaisAntiga();
        const ctx = ctxDe(req);
        const server = criarServidor(ctx);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => { sessoes.set(id, { transport, server, userId: ctx.usuario.id, visto: Date.now() }); },
        });
        transport.onclose = () => { if (transport.sessionId) sessoes.delete(transport.sessionId); server.close().catch(() => {}); };
        await server.connect(transport);
        return await transport.handleRequest(req, res, req.body);
      }
      // Sem sessão conhecida (cliente sem sessão ou servidor reiniciou): atende sem estado.
      return await semEstado(req, res);
    } catch (e) {
      console.error('[MCP] POST /mcp:', e.message);
      rpcErro(res, 500, 'Erro interno no servidor MCP. Tente de novo.', { code: -32603 });
    }
  };

  const getOuDelete = async (req, res) => {
    try {
      const { negado, sid, s } = sessaoDe(req, res);
      if (negado) return;
      if (!s) {
        if (sid) return rpcErro(res, 404, 'Sessão não encontrada (o servidor pode ter reiniciado). Reconecte enviando initialize.');
        res.set('Allow', 'POST');
        return rpcErro(res, 405, 'Sem sessão: use POST /mcp (este servidor também funciona sem estado).', { code: -32000 });
      }
      return await s.transport.handleRequest(req, res);
    } catch (e) {
      console.error('[MCP] ' + req.method + ' /mcp:', e.message);
      rpcErro(res, 500, 'Erro interno no servidor MCP.', { code: -32603 });
    }
  };

  app.post('/mcp', exigirDono, limite, corpo, post);
  app.get('/mcp', exigirDono, limite, getOuDelete);
  app.delete('/mcp', exigirDono, limite, getOuDelete);

  const faxina = setInterval(() => {
    const corte = Date.now() - SESSAO_OCIOSA_MS;
    for (const [id, s] of sessoes) if (s.visto < corte) { sessoes.delete(id); s.transport.close().catch(() => {}); }
  }, 5 * 60 * 1000);
  if (faxina.unref) faxina.unref();

  console.log(`[MCP] servidor TenisCash em /mcp (${usarSessoes ? 'sessões + fallback sem estado' : 'sem estado'})`);
  return {
    sessoes,
    async fechar() { clearInterval(faxina); for (const s of sessoes.values()) await s.transport.close().catch(() => {}); sessoes.clear(); },
  };
}

module.exports = { mount, criarServidor, _interno: { limpar, diaFortaleza } };
