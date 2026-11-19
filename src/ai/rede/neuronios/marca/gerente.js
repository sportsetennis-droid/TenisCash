// =====================================================================
// marca.gerente — DETECTOR (regra, custo zero)
// Missão única: montar, todo dia, o RAIO-X de cada marca — estoque (comprado ×
// localizado por loja), venda (loja física × site), site (publicado, pronto,
// barrado) e cadastro — e apontar o que precisa do dono, por ordem de gravidade.
//
// É o "gerente da marca": um por marca, todos com a mesma régua. Não mexe em
// nada — só lê e relata. As correções continuam saindo dos mini agentes de
// cada assunto (estoque, preço, Nuvemshop…) como PROPOSTA para o dono aprovar.
// Pedido sob demanda: sinal `marca.pedir` com dados.marca (painel /marcas.html).
// =====================================================================
const raioX = require('./_raio-x');
const { chave } = require('../../regras/marcas');

const DIAS_PARADO = () => Math.max(30, Number(process.env.RNA_PARADO_DIAS || 90));

// Regra 31 (dono 18/11): o gerente é responsável por colocar a marca no site. Para cada card dele
// com estoque nas lojas do site, fora da Nuvemshop e sem foto ou sem descrição, aciona os agentes
// de foto oficial e de descrição (que PROPÕEM ao dono). Até 15 por marca por dia.
const POR_MARCA = () => Math.max(1, Number(process.env.RNA_CADASTRO_POR_MARCA || 15));
async function cadastroIncompleto(ler, marcasDoRelatorio, quando) {
  const { nuvemshopStockStoreIds } = require('../../../../services/nuvemshopEligibility');
  const lojas = nuvemshopStockStoreIds();
  if (!lojas.length) return [];
  const rows = await ler.$queryRawUnsafe(
    'SELECT p.id, p.name, p.brand, ' +
    "  (coalesce(regexp_replace(p.\"longDescription\", '\\s', '', 'g'), '') = '' AND coalesce(regexp_replace(p.\"shortDescription\", '\\s', '', 'g'), '') = '') AS sem_descricao, " +
    // mesma conta do portão (usableImageCount): principal + galeria, válidas, sem repetir, sem Instagram/crawler
    "  (SELECT count(DISTINCT md5(btrim(x))) FROM (SELECT p.\"imageUrl\" AS x UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.\"imageUrls\"::jsonb) = 'array' THEN p.\"imageUrls\"::jsonb ELSE '[]'::jsonb END)) t " +
    "     WHERE btrim(x) ~* '^(https?://|data:image/[a-z0-9.+-]+.base64,)' AND btrim(x) !~* '(lookaside\\.instagram\\.com|/crawler/|google_widget|/seo/)') AS n_fotos " +
    'FROM "Product" p WHERE p.active = true ' +
    ' AND EXISTS (SELECT 1 FROM "StoreStock" ss JOIN "ProductSize" ps ON ps.id = ss."productSizeId" WHERE ps."productId" = p.id AND ss.stock > 0 AND ss."storeId" = ANY($1::text[])) ' +
    ' AND NOT EXISTS (SELECT 1 FROM "NuvemshopProductMapping" m WHERE m."localProductId" = p.id AND m."syncStatus" <> \'hidden-invalid\')', lojas);
  const marcas = new Set(marcasDoRelatorio);
  const cont = new Map(); const dia = quando.toISOString().slice(0, 10); const out = [];
  for (const r of rows) {
    const k = chave(r.brand);
    if (!k || !marcas.has(k)) continue;
    // card fora do site é NOVO: a regra 27 exige 5 fotos válidas para subir
    const falta = [Number(r.n_fotos || 0) < 5 && 'foto', r.sem_descricao && 'descricao'].filter(Boolean);
    if (!falta.length) continue;
    const n = cont.get(k) || 0; if (n >= POR_MARCA()) continue; cont.set(k, n + 1);
    out.push({ tipo: 'marca.cadastro-incompleto', forca: 0.6, dados: { chave: 'cadastro|' + r.id, nFotos: Number(r.n_fotos || 0), productId: r.id, marca: k, falta, produto: { nome: r.name, marca: r.brand }, motivo: 'card com estoque nas lojas do site e fora da Nuvemshop' } });
  }
  return out;
}

module.exports = {
  id: 'marca.gerente',
  camada: 'detector',
  missao: 'Montar o raio-x diário de cada marca (estoque, venda loja×site, site e cadastro) e apontar o que precisa do dono.',
  escuta: ['relogio.diario', 'marca.pedir'],
  emite: ['marca.relatorio', 'marca.cadastro-incompleto'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['estoque-fisico-storestock', 'comprado-nunca-recalcula', 'nunca-inventar-dado', 'nuvemshop-foto-descricao', 'nuvemshop-4-classificacoes', 'lugar-certo'],
  tempoMax: 180000,
  async disparar({ sinal, ler, agora }) {
    const quando = agora || new Date();
    let soMarca = null;
    if (sinal.tipo === 'marca.pedir') {
      soMarca = chave(sinal.dados && sinal.dados.marca);
      if (!soMarca) return [{ tipo: 'marca.relatorio', forca: 0.1, dados: { chave: 'marca|?|' + Date.now(), erro: 'marca não informada ou indefinida', pedido: sinal.dados || {} } }];
    }
    const marcas = await raioX.calcular(ler, { agora: quando, soMarca, diasParado: DIAS_PARADO() });
    const pedidos = await cadastroIncompleto(ler, marcas.map((m) => m.marca), quando).catch(() => []);
    const dia = quando.toISOString().slice(0, 10);
    return pedidos.concat(marcas.map((m) => ({
      tipo: 'marca.relatorio',
      forca: Math.max(0.1, m.atencao / 100),
      impactoRS: m.parados.valorCustoRS || null,
      dados: Object.assign({ chave: 'marca|' + m.marca + '|' + (soMarca ? 'pedido|' + quando.getTime() : dia), dia, geradoEm: quando.toISOString(), sobDemanda: !!soMarca }, m),
    })));
  },
};
