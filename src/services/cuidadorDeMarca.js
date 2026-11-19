'use strict';
// =====================================================================
// CUIDADOR DE CADASTRO DA MARCA — regra 31 (dono, 18/11/2026)
// "Cada agente por marca precisa saber preencher e cuidar do seu estoque e
//  inclusive ser responsável de colocar na Nuvemshop."
//
// O gerente de cada marca PREENCHE SOZINHO o que tem prova escrita no próprio
// card (nunca chuta, nunca sobrescreve o que já está preenchido):
//   - categoria  ← o TIPO escrito no nome (régua da regra 30)
//   - público    ← MASCULINO/FEMININO/JR escrito no nome (JR só vira Menino em
//                  Chuteiras, único nó infantil dessa árvore; Tênis precisa do gênero escrito)
//   - modalidade ← FUTSAL/SOCIETY/CAMPO escrito no nome da chuteira
// O que exige julgamento (especialidade, cor sem prova, foto, descrição) vira
// pendência/proposta para o dono. Publicar continua automático pela trava oficial
// (subida automática de hora em hora); preço nunca é tocado.
// Só cuida de card ATIVO com estoque físico nas lojas do site e ainda fora dele.
// =====================================================================
const { tipoDoNome, modalidadeChuteira, publicoDoNome } = require('../ai/rede/regras/local-certo');
const { mergeAiContext } = require('./aiContextMerge');

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const vazio = (v) => ['', 'A CLASSIFICAR', 'A DEFINIR', 'NAO DEFINIDO', 'SEM MARCA'].includes(norm(v));

const CATEGORIA_DO_TIPO = { 'tênis': 'Tênis', chuteira: 'Chuteiras', 'sandália/chinelo': 'Sandálias', 'acessório': 'Acessórios', roupa: 'Vestuário' };
const MODALIDADE = { FUTSAL: 'Futsal', SOCIETY: 'Society', CAMPO: 'Campo' };

// O que dá para preencher deste card, só com prova escrita. Devolve { mudancas, provas }.
function planejar(p) {
  const ctx = (p.aiContext && typeof p.aiContext === 'object' && !Array.isArray(p.aiContext)) ? p.aiContext : {};
  const cls = ctx.classification || {};
  const mudancas = {}; const provas = [];
  let categoria = p.category;
  if (vazio(categoria)) {
    const t = tipoDoNome(p.name);
    if (t && CATEGORIA_DO_TIPO[t.tipo]) { categoria = CATEGORIA_DO_TIPO[t.tipo]; mudancas.category = categoria; provas.push(`categoria ${categoria}: nome diz "${t.palavra}"`); }
  }
  const cat = norm(categoria);
  if (vazio(p.subcategory)) {
    const pub = publicoDoNome(p.name);
    let sub = null;
    if (pub.infantil) {
      if (cat === 'CHUTEIRAS') sub = 'Menino';
      else if (cat === 'TENIS' && pub.genero) sub = pub.genero === 'masculino' ? 'Menino' : 'Menina';
    } else if (pub.genero) sub = pub.genero === 'masculino' ? 'Homem' : 'Mulher';
    else if (/\bUNISS?EX\b/.test(norm(p.name))) sub = 'Unissex';
    if (sub) { mudancas.subcategory = sub; provas.push(`público ${sub}: nome diz ${pub.infantil ? 'infantil' + (pub.genero ? ' ' + pub.genero : '') : (pub.genero || 'unissex')}`); }
  }
  if (cat === 'CHUTEIRAS' && vazio(cls.modality)) {
    const mod = modalidadeChuteira(p.name);
    if (mod) { mudancas.modality = MODALIDADE[mod]; provas.push(`modalidade ${MODALIDADE[mod]}: nome diz ${mod}`); }
  }
  return { mudancas, provas };
}

// O que ainda falta e só o dono/loja resolve (para o gerente mostrar).
function pendencias(p, mudancas = {}) {
  const ctx = (p.aiContext && typeof p.aiContext === 'object') ? p.aiContext : {};
  const cls = ctx.classification || {};
  const f = [];
  if (vazio(mudancas.category || p.category)) f.push('categoria');
  if (vazio(mudancas.subcategory || p.subcategory)) f.push('público (subcategoria)');
  if (vazio(mudancas.modality || cls.modality)) f.push('modalidade');
  if (vazio(cls.tier)) f.push('especialidade');
  if (!String(ctx.color || '').trim()) f.push('cor');
  return f;
}

// Cards de uma marca (ou todas) com estoque físico nas lojas do site e fora da Nuvemshop.
async function candidatos(db, { marca = null, storeIds = [] } = {}) {
  if (!storeIds.length) return [];
  return db.$queryRawUnsafe(
    'SELECT p.id, p.name, p.brand, p.category, p.subcategory, p."aiContext" FROM "Product" p ' +
    'WHERE p.active = true AND ($1::text IS NULL OR upper(p.brand) = upper($1)) ' +
    ' AND EXISTS (SELECT 1 FROM "StoreStock" ss JOIN "ProductSize" ps ON ps.id = ss."productSizeId" WHERE ps."productId" = p.id AND ss.stock > 0 AND ss."storeId" = ANY($2::text[])) ' +
    ' AND NOT EXISTS (SELECT 1 FROM "NuvemshopProductMapping" m WHERE m."localProductId" = p.id AND m."syncStatus" <> \'hidden-invalid\')',
    marca, storeIds);
}

async function cuidar(db, { marca = null, aplicar = true, agora = new Date() } = {}) {
  const { nuvemshopStockStoreIds } = require('./nuvemshopEligibility');
  const lista = await candidatos(db, { marca, storeIds: nuvemshopStockStoreIds() });
  const res = { cards: lista.length, preenchidos: 0, campos: 0, itens: [] };
  for (const p of lista) {
    const { mudancas, provas } = planejar(p);
    const n = Object.keys(mudancas).length;
    if (!n) continue;
    res.preenchidos++; res.campos += n;
    if (res.itens.length < 50) res.itens.push({ productId: p.id, nome: p.name, marca: p.brand, mudancas, provas });
    if (!aplicar) continue;
    // nunca sobrescreve: a gravação confere de novo que o campo continua vazio
    const dados = {};
    if (mudancas.category) dados.category = mudancas.category;
    if (mudancas.subcategory) dados.subcategory = mudancas.subcategory;
    if (Object.keys(dados).length) {
      // cada campo a preencher tem que CONTINUAR vazio na hora de gravar (AND); senão não grava nada
      const VAZIOS = ['', 'A CLASSIFICAR', 'A DEFINIR', 'A classificar', 'A definir'];
      // category é obrigatória no schema (sem null); subcategory pode ser null
      await db.product.updateMany({ where: { id: p.id, AND: Object.keys(dados).map((k) => (k === 'category' ? { [k]: { in: VAZIOS } } : { OR: [{ [k]: null }, { [k]: { in: VAZIOS } }] })) }, data: dados });
    }
    const patch = { preenchidoPeloGerente: { em: agora.toISOString(), campos: mudancas, provas } };
    if (mudancas.modality) {
      const atual = await db.product.findUnique({ where: { id: p.id }, select: { aiContext: true } });
      const cls = (atual && atual.aiContext && atual.aiContext.classification) || {};
      if (vazio(cls.modality)) patch.classification = { ...cls, modality: mudancas.modality };
    }
    await mergeAiContext(db, p.id, patch);
  }
  return res;
}

const state = { lastRunAt: null, lastResult: null, lastError: null };
function iniciarCuidadorDeMarca(db) {
  if (process.env.CUIDADOR_DE_MARCA === '0') { console.log('[cuidador de marca] desligado (CUIDADOR_DE_MARCA=0)'); return; }
  const rodar = () => cuidar(db).then((r) => { state.lastRunAt = new Date().toISOString(); state.lastResult = { cards: r.cards, preenchidos: r.preenchidos, campos: r.campos }; state.lastError = null; if (r.preenchidos) console.log('[cuidador de marca]', JSON.stringify(state.lastResult)); })
    .catch((e) => { state.lastError = e.message; console.warn('[cuidador de marca] falhou:', e.message); });
  setTimeout(rodar, 4 * 60 * 1000);
  setInterval(rodar, 60 * 60 * 1000);
  console.log('[cuidador de marca] ligado: cada marca preenche sozinha o que tem prova escrita (de hora em hora)');
}
function estadoCuidadorDeMarca() { return JSON.parse(JSON.stringify(state)); }

module.exports = { planejar, pendencias, candidatos, cuidar, iniciarCuidadorDeMarca, estadoCuidadorDeMarca };
