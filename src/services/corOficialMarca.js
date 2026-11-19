'use strict';
// =====================================================================
// COR OFICIAL PELO SITE DA MARCA — dono, 18/11/2026
// "Se não traz aí vc pesquisa no site da marca. Ensine isso aos agentes."
//
// Quando a NF-e (ou a caixa) não traz a cor por extenso, o agente pesquisa
// no SITE OFICIAL DA MARCA pelo CÓDIGO EXATO do card (código de barras) e
// usa a cor que a marca escreve. Regras (nada de chute):
//   - só vale item do site cujo código de barras é IGUAL ao do card;
//   - dois tamanhos do card com cores diferentes no site = conflito → não usa;
//   - a cor tem de virar português por extenso com certeza (dicionário
//     colorName); palavra desconhecida → não grava, vira pendência;
//   - sem resposta / site fora / bloqueio → não grava nada.
// Lojas oficiais que respondem pela API pública VTEX (conferidas 18/11/2026):
// FILA, Umbro, Penalty, Mizuno, Olympikus, OUS, Topper, Kenner, Asics, Skechers,
// Under Armour, Reebok, Speedo, Kappa, Caju; Puma/Asics também pela Drastosa
// (fornecedora oficial, campo "Cores" em português).
// =====================================================================
const { expandColorName } = require('./colorName');

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// marca (normalizada) → lojas oficiais (ordem de preferência)
const LOJAS = {
  FILA: ['www.fila.com.br'],
  UMBRO: ['www.umbro.com.br'],
  PENALTY: ['www.penalty.com.br'],
  MIZUNO: ['www.mizuno.com.br'],
  OLYMPIKUS: ['www.olympikus.com.br'],
  OUS: ['www.ous.com.br'],
  TOPPER: ['www.topper.com.br'],
  RAINHA: ['www.rainha.com.br'],
  KENNER: ['www.kenner.com.br'],
  ASICS: ['www.asics.com.br', 'www.drastosa.com.br'],
  PUMA: ['www.drastosa.com.br'],
  SKECHERS: ['www.skechers.com.br'],
  'UNDER ARMOUR': ['www.underarmour.com.br'],
  REEBOK: ['www.reebok.com.br'],
  SPEEDO: ['www.speedo.com.br'],
  KAPPA: ['www.kappa.com.br'],
  'CAJU BRASIL': ['www.cajubrasil.com.br'],
  CONVERSE: ['www.converse.com.br'],
};
function lojasDaMarca(marca) { return LOJAS[norm(marca)] || []; }

const ean13 = (e) => String(e || '').replace(/\D/g, '').padStart(13, '0');
const mesmoCodigo = (a, b) => String(a || '').replace(/\D/g, '').replace(/^0+/, '') === String(b || '').replace(/\D/g, '').replace(/^0+/, '');

// "PRETO/ROSE CLARO/CINZA" → "Preto/Rose Claro/Cinza" (a régua do portão aceita cor curada em caixa mista)
function titulo(s) {
  return String(s).toLowerCase().replace(/(^|[\s/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(E|De|Da|Do)\b/g, (w) => w.toLowerCase());
}

// Cor que a marca escreve para aquele item: campo de especificação "Cor"/"Cores" do produto.
// Ordem: a cor do ITEM (o código de barras) vence a do produto. 'Cor predominante' é filtro
// genérico do site (Penalty põe 'Branco' numa bola cujo item é 'Azul') — nunca usar.
function corDoProduto(prod, item) {
  for (const fonte of [item, prod]) for (const k of ['Cor', 'Cores', 'cor', 'COR', 'Cor do Produto']) {
    const v = fonte && fonte[k];
    const s = Array.isArray(v) ? v.filter(Boolean).join('/') : v;
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  return null;
}

// Consulta uma loja VTEX pelo código de barras. Devolve { cor, produto, referencia, link } ou null.
async function consultarLoja(host, ean, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
  const url = `https://${host}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${ean13(ean)}`;
  let lista;
  try {
    const r = await fetchFn(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!r || !r.ok) return null;
    lista = await r.json();
  } catch (_) { return null; }
  if (!Array.isArray(lista)) return null;
  for (const prod of lista) {
    const item = (prod.items || []).find((i) => mesmoCodigo(i.ean, ean) || (i.referenceId || []).some((x) => mesmoCodigo(x && x.Value, ean)));
    if (!item) continue; // só o item com o MESMO código
    const cor = corDoProduto(prod, item);
    if (!cor) continue;
    return { cor, produto: prod.productName || null, referencia: prod.productReference || null, link: prod.link || null, fonte: url };
  }
  return null;
}

// Procura a cor oficial de um card pelos seus códigos de barras (até `maxCodigos`).
// Devolve { ok:true, cor, bruto, fonte, ean, ... } ou { ok:false, motivo }.
async function buscarCorOficial({ marca, eans = [] }, opts = {}) {
  const lojas = lojasDaMarca(marca);
  if (!lojas.length) return { ok: false, motivo: 'marca sem loja oficial cadastrada' };
  const codigos = [...new Set((eans || []).map((e) => String(e || '').replace(/\D/g, '')).filter((e) => e.length >= 8 && e.length <= 14))].slice(0, opts.maxCodigos || 3);
  if (!codigos.length) return { ok: false, motivo: 'card sem código de barras' };
  const achados = [];
  for (const host of lojas) {
    for (const e of codigos) {
      const r = await consultarLoja(host, e, opts);
      if (r) achados.push({ ...r, ean: e, host });
    }
    if (achados.length) break; // a primeira loja que responde manda
  }
  if (!achados.length) return { ok: false, motivo: 'código não encontrado no site oficial' };
  const distintas = [...new Set(achados.map((a) => norm(a.cor)))];
  if (distintas.length > 1) return { ok: false, motivo: 'conflito: tamanhos do card com cores diferentes no site (' + achados.map((a) => a.cor).join(' × ') + ')' };
  const a = achados[0];
  const bruto = a.cor;
  const r = expandColorName(titulo(bruto), { brand: marca });
  if (!r.certain || !r.value) return { ok: false, motivo: 'cor oficial com palavra fora do dicionário: ' + bruto + ' (' + (r.unknown || []).join(', ') + ')', bruto, fonte: a.fonte };
  return { ok: true, cor: r.value, bruto, fonte: a.link ? `https://${a.host}${new URL(a.link, 'https://x').pathname}` : a.fonte, consulta: a.fonte, ean: a.ean, produto: a.produto, referencia: a.referencia, conferidos: achados.length };
}

module.exports = { LOJAS, lojasDaMarca, consultarLoja, buscarCorOficial, corDoProduto, titulo };
