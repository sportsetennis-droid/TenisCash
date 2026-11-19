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
// COR (dono 18/11: "se não traz aí vc pesquisa no site da marca"): cor vazia ou com sigla
// que o portão recusa é buscada no SITE OFICIAL DA MARCA pelo código de barras exato
// (corOficialMarca). Só grava se o site confirma aquele código e a cor vira português certo;
// a cor antiga fica em colorRaw e a fonte em colorEvidencia.
// O que exige julgamento (especialidade, cor sem prova, foto, descrição) vira
// pendência/proposta para o dono. Publicar continua automático pela trava oficial
// (subida automática de hora em hora); preço nunca é tocado.
// Só cuida de card ATIVO com estoque físico nas lojas do site e ainda fora dele.
// =====================================================================
const { tipoDoNome, modalidadeChuteira, publicoDoNome } = require('../ai/rede/regras/local-certo');
const { mergeAiContext } = require('./aiContextMerge');

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
// MESMA definição de "vazio" no plano e na gravação (auditoria 18/11)
const VAZIOS = new Set(['', 'A CLASSIFICAR', 'A DEFINIR', 'NAO DEFINIDO', 'SEM MARCA']);
const vazio = (v) => VAZIOS.has(norm(v));

// Só valores que existem na ÁRVORE OFICIAL (scripts/seed-category-tree.js), por categoria.
// Sandálias (categoria) e Unissex não estão na árvore: o gerente não preenche — vai para o dono.
// Roupa → "Roupas" (dono 19/11: entre Roupas e Vestuário, fica "Roupas").
const CATEGORIA_DO_TIPO = { 'tênis': 'Tênis', chuteira: 'Chuteiras', 'acessório': 'Acessórios', roupa: 'Roupas' };
const PUBLICO_DA_ARVORE = {
  TENIS: { masculino: 'Homem', feminino: 'Feminino', infantil_masculino: 'Menino', infantil_feminino: 'Menina' },
  CHUTEIRAS: { masculino: 'Homem', infantil_masculino: 'Menino', infantil_sem_genero: 'Menino' }, // árvore: só Homem/Menino
  VESTUARIO: { masculino: 'Homem', feminino: 'Mulher', infantil_masculino: 'Menino', infantil_feminino: 'Menina' },
  ROUPAS: { masculino: 'Homem', feminino: 'Mulher', infantil_masculino: 'Menino', infantil_feminino: 'Menina' },
  ACESSORIOS: { masculino: 'Homem', feminino: 'Mulher', infantil_masculino: 'Menino', infantil_feminino: 'Menina' },
};
const MODALIDADE = { FUTSAL: 'Futsal', SOCIETY: 'Society', CAMPO: 'Campo' };

// numeração infantil escrita no nome ("28/33") ou na grade do card (calçado < 34): nunca vira adulto
// Numeração infantil: calçado 15–33; roupa/acessório 1–16 ou idade ("10A"). Vale no nome e na grade.
function temNumeracaoInfantil(p, cat = norm(p.category)) {
  const nome = norm(p.name);
  // meia/meião usa a numeração do PÉ (19/22, 23/26…): mesma régua do calçado
  const calcado = cat === 'TENIS' || cat === 'CHUTEIRAS' || /\b(MEIAS?|MEIAO|MEIOES)\b/.test(nome);
  const infantilNum = (n) => (calcado ? n >= 15 && n <= 33 : n >= 1 && n <= 16);
  if (/(?<![A-Z0-9])\d{1,2}\s?A(?![A-Z0-9])/.test(nome)) return true; // "10A", "7A/14A"
  const nums = [...nome.matchAll(/(?<![\d.,])(\d{1,2})(?:\s*[/-]\s*(\d{1,2}))?(?![\d.,])/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean).map(Number);
  // no nome, só faixa "a/b" conta como grade (número solto pode ser modelo: "PEGASUS 41", "GEL 27")
  const faixas = [...nome.matchAll(/(?<![\d.,])(\d{1,2})\s*[/-]\s*(\d{1,2})(?![\d.,])/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
  if (faixas.some(infantilNum)) return true;
  if (calcado && nums.some((n) => n >= 15 && n <= 33)) return true;
  // grade: cada número de uma faixa ("27/28", "19-22") é conferido
  return (p.tamanhos || []).some((t) => {
    const s = String(t).trim().toUpperCase();
    if (/^\d{1,2}\s?A$/.test(s)) return true;
    return s.split(/\s*[/-]\s*/).some((x) => { const n = Number(x.replace(',', '.')); return x !== '' && Number.isFinite(n) && infantilNum(n); });
  });
}
// Prova de ADULTO pela grade: pelo menos um tamanho real legível (não placeholder T-/Único-) e nenhum infantil.
function gradeProvaAdulto(p, cat = norm(p.category)) {
  const reais = (p.tamanhos || []).map((t) => String(t || '').trim()).filter((t) => t && !/^T-/i.test(t) && !/^(U|UN|UNICO|ÚNICO|UNICA)$/i.test(t) && !/^[uú]nico-/i.test(t));
  if (!(p.tamanhos || []).length) return !(cat === 'TENIS' || cat === 'CHUTEIRAS' || cat === 'VESTUARIO' || cat === 'ROUPAS') && !temNumeracaoInfantil(p, cat); // acessório sem grade: só se o nome não tiver numeração infantil
  return reais.length > 0 && !temNumeracaoInfantil(p, cat);
}

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
  const arvore = PUBLICO_DA_ARVORE[cat];
  if (vazio(p.subcategory) && arvore) {
    const pub = publicoDoNome(p.name);
    let chaveArv = null;
    if (pub.infantil) chaveArv = pub.genero ? 'infantil_' + pub.genero : 'infantil_sem_genero';
    else if (pub.genero && gradeProvaAdulto(p, cat)) chaveArv = pub.genero; // adulto só com grade real e sem numeração infantil
    const sub = chaveArv ? arvore[chaveArv] : null; // sem nó na árvore (ex.: chuteira feminina) = não preenche
    if (sub) { mudancas.subcategory = sub; provas.push(`público ${sub}: nome diz ${pub.infantil ? 'infantil' + (pub.genero ? ' ' + pub.genero : '') : pub.genero}`); }
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
    'SELECT p.id, p.name, p.brand, p.category, p.subcategory, p."aiContext", ARRAY(SELECT ps.size FROM "ProductSize" ps WHERE ps."productId" = p.id) AS tamanhos FROM "Product" p ' +
    'WHERE p.active = true AND ($1::text IS NULL OR upper(p.brand) = upper($1)) ' +
    ' AND EXISTS (SELECT 1 FROM "StoreStock" ss JOIN "ProductSize" ps ON ps.id = ss."productSizeId" WHERE ps."productId" = p.id AND ss.stock > 0 AND ss."storeId" = ANY($2::text[])) ' +
    ' AND NOT EXISTS (SELECT 1 FROM "NuvemshopProductMapping" m WHERE m."localProductId" = p.id AND m."syncStatus" <> \'hidden-invalid\')',
    marca, storeIds);
}

// Grava UM campo só se ele continuar exatamente como foi lido (vazio). Devolve true se gravou.
async function gravarSeIgual(db, id, campo, lido, novo) {
  const r = await db.product.updateMany({ where: { id, [campo]: lido == null ? null : lido }, data: { [campo]: novo } });
  return r.count === 1;
}

// Cor: só cor vazia ou que o portão recusa (sigla/código/tamanho na cor); nunca troca cor por extenso.
function precisaCorOficial(p) {
  const { rawColorReason } = require('./nuvemshopEligibility');
  const ctx = (p.aiContext && typeof p.aiContext === 'object' && !Array.isArray(p.aiContext)) ? p.aiContext : {};
  const cor = String(ctx.color || '').trim();
  if (cor && !rawColorReason(cor)) return false;
  const t = ctx.corOficialTentativa;
  // não repete a mesma busca sem resposta por 7 dias
  if (t && t.em && Date.now() - new Date(t.em).getTime() < 7 * 86400000 && t.corLida === cor) return false;
  return true;
}

// Busca e grava a cor oficial (atômico: só se a cor no banco continuar a mesma que foi lida).
async function corPeloSiteDaMarca(db, p, { buscarCor, agora }) {
  const ctx = (p.aiContext && typeof p.aiContext === 'object' && !Array.isArray(p.aiContext)) ? p.aiContext : {};
  const corLida = String(ctx.color || '').trim();
  const eans = (await db.productSize.findMany({ where: { productId: p.id }, select: { barcode: true } })).map((s) => s.barcode).filter(Boolean);
  const r = await buscarCor({ marca: p.brand, eans });
  if (!r || !r.ok) {
    await mergeAiContext(db, p.id, { corOficialTentativa: { em: agora.toISOString(), corLida, motivo: (r && r.motivo) || 'sem resposta' } });
    return null;
  }
  const evid = { fonte: r.fonte, consulta: r.consulta || null, codigo: r.ean, corNoSite: r.bruto, anterior: corLida || null, em: agora.toISOString(), por: 'gerente da marca (site oficial)' };
  const n = await db.$executeRawUnsafe(
    `UPDATE "Product" SET "aiContext" = (COALESCE("aiContext", '{}'::jsonb) - 'colorReview' - 'corOficialTentativa') || jsonb_build_object('color', $2::text, 'colorEvidencia', $3::jsonb) ` +
    `|| CASE WHEN COALESCE("aiContext"->>'colorRaw', '') = '' AND $4::text <> '' THEN jsonb_build_object('colorRaw', $4::text) ELSE '{}'::jsonb END ` +
    `WHERE id = $1 AND (jsonb_typeof("aiContext") = 'object' OR "aiContext" IS NULL) AND btrim(COALESCE("aiContext"->>'color', '')) = $4::text`,
    p.id, r.cor, JSON.stringify(evid), corLida);
  return n === 1 ? { cor: r.cor, anterior: corLida || null, fonte: r.fonte } : null;
}

// ---------------------------------------------------------------------
// FOTOS OFICIAIS (dono 19/11: "Faça sem crédito" — a busca paga acabou o crédito).
// O gerente completa as 5 fotos (regra 27) com as fotos do SITE OFICIAL DA MARCA
// para o código de barras exato do card: grátis e da cor certa. Troca as fotos
// atuais só quando o site tem MAIS fotos válidas que o card (nunca piora o card).
// Tentativa sem resultado fica 7 dias sem repetir (aiContext.fotoOficialTentativa).
// ---------------------------------------------------------------------
const SETE_DIAS = 7 * 24 * 3600 * 1000;
function precisaFotoOficial(p, agora = new Date()) {
  const { usableImageCount, minPhotos } = require('./nuvemshopEligibility');
  const ctx = (p.aiContext && typeof p.aiContext === 'object' && !Array.isArray(p.aiContext)) ? p.aiContext : {};
  if (usableImageCount(p) >= minPhotos()) return false;
  const t = ctx.fotoOficialTentativa && Date.parse(ctx.fotoOficialTentativa.em);
  return !(t && agora.getTime() - t < SETE_DIAS);
}

async function fotosPeloSiteDaMarca(db, p, { buscarFotos, agora }) {
  const { usableImageCount } = require('./nuvemshopEligibility');
  // ordem fixa dos códigos (auditoria 19/11): mesma consulta a cada rodada
  const eans = (await db.productSize.findMany({ where: { productId: p.id }, select: { barcode: true } })).map((s) => s.barcode).filter(Boolean).sort();
  const r = await buscarFotos({ marca: p.brand, eans });
  const atuais = usableImageCount(p);
  if (!r || !r.ok || !Array.isArray(r.fotos) || r.fotos.length <= atuais) {
    await mergeAiContext(db, p.id, { fotoOficialTentativa: { em: agora.toISOString(), motivo: (r && r.ok) ? `site tem ${r.fotos.length} foto(s), card já tem ${atuais}` : ((r && r.motivo) || 'sem resposta') } });
    return null;
  }
  const { lojasDaMarca } = require('./corOficialMarca');
  const oficial = !!(r.host && lojasDaMarca(p.brand).includes(r.host));
  const evid = { fonte: r.fonte, consulta: r.consulta || null, host: r.host || null, codigo: r.ean, fotos: r.fotos.length, anteriores: [p.imageUrl, ...(Array.isArray(p.imageUrls) ? p.imageUrls : [])].filter(Boolean), em: agora.toISOString(), por: oficial ? 'gerente da marca (site oficial da marca)' : 'gerente da marca (revendedor, mesmo código de barras)' };
  // atômico: só troca se a foto principal E a galeria continuam as que foram lidas (não atropela edição do meio)
  const n = await db.$executeRawUnsafe(
    'UPDATE "Product" SET "imageUrl" = $2, "imageUrls" = $3::jsonb, "aiContext" = (COALESCE("aiContext", \'{}\'::jsonb) - \'fotoOficialTentativa\') || jsonb_build_object(\'fotosOficiais\', $4::jsonb), "updatedAt" = now() ' +
    'WHERE id = $1 AND (jsonb_typeof("aiContext") = \'object\' OR "aiContext" IS NULL) AND COALESCE("imageUrl", \'\') = $5::text AND COALESCE("imageUrls", \'[]\'::jsonb) = $6::jsonb',
    p.id, r.fotos[0], JSON.stringify(r.fotos.slice(1)), JSON.stringify(evid), String(p.imageUrl || ''), JSON.stringify(Array.isArray(p.imageUrls) ? p.imageUrls : []));
  return n === 1 ? { fotos: r.fotos.length, antes: atuais, fonte: r.fonte } : null;
}

// Cards ativos com estoque nas lojas do site (publicados ou não) e menos de 5 fotos, de qualquer marca.
async function cuidarFotos(db, { aplicar = true, agora = new Date(), buscarFotos = null, limite = Number(process.env.CUIDADOR_FOTO_LIMITE || 30) } = {}) {
  const busca = buscarFotos || (process.env.CUIDADOR_FOTO_OFICIAL === '0' ? null : require('./corOficialMarca').buscarFotosOficiais);
  const res = { verificados: 0, consultas: 0, fotos: 0, itens: [] };
  if (!busca) return res;
  const { nuvemshopStockStoreIds } = require('./nuvemshopEligibility');
  const lojas = nuvemshopStockStoreIds();
  const lista = await db.$queryRawUnsafe(
    'SELECT p.id, p.name, p.brand, p."imageUrl", p."imageUrls", p."aiContext" FROM "Product" p WHERE p.active AND EXISTS (' +
    'SELECT 1 FROM "ProductSize" s JOIN "StoreStock" ss ON ss."productSizeId" = s.id WHERE s."productId" = p.id AND ss.stock > 0' +
    (lojas.length ? ' AND ss."storeId" = ANY($1::text[])' : '') + ') ORDER BY p."updatedAt" DESC', ...(lojas.length ? [lojas] : []));
  for (const p of lista) {
    if (res.consultas >= limite) break;
    if (!precisaFotoOficial(p, agora)) continue; // qualquer marca: site oficial e revendedores pelo código exato
    res.verificados++;
    if (!aplicar) continue;
    res.consultas++;
    const f = await fotosPeloSiteDaMarca(db, p, { buscarFotos: busca, agora }).catch(() => null);
    if (f) { res.fotos++; if (res.itens.length < 50) res.itens.push({ productId: p.id, nome: p.name, marca: p.brand, fotos: f.fotos, antes: f.antes, fonte: f.fonte }); }
  }
  return res;
}

async function cuidar(db, { marca = null, aplicar = true, agora = new Date(), buscarCor = null, limiteCor = Number(process.env.CUIDADOR_COR_LIMITE || 30) } = {}) {
  const { nuvemshopStockStoreIds } = require('./nuvemshopEligibility');
  const lista = await candidatos(db, { marca, storeIds: nuvemshopStockStoreIds() });
  const res = { cards: lista.length, preenchidos: 0, campos: 0, cores: 0, itens: [] };
  const busca = buscarCor || (process.env.CUIDADOR_COR_OFICIAL === '0' ? null : require('./corOficialMarca').buscarCorOficial);
  let consultas = 0;
  for (const p of lista) {
    if (aplicar && busca && consultas < limiteCor && precisaCorOficial(p)) {
      consultas++;
      const c = await corPeloSiteDaMarca(db, p, { buscarCor: busca, agora }).catch(() => null);
      if (c) { res.cores++; if (res.itens.length < 50) res.itens.push({ productId: p.id, nome: p.name, marca: p.brand, mudancas: { color: c.cor }, provas: ['cor ' + c.cor + ': site oficial da marca pelo código de barras (' + c.fonte + ')'] }); }
    }
    const { mudancas, provas } = planejar(p);
    if (!Object.keys(mudancas).length) continue;
    if (!aplicar) { res.preenchidos++; res.campos += Object.keys(mudancas).length; if (res.itens.length < 50) res.itens.push({ productId: p.id, nome: p.name, marca: p.brand, mudancas, provas }); continue; }
    // grava campo a campo, cada um só se continuar como foi lido; registra SÓ o que foi gravado
    const feito = {}; const provasFeitas = [];
    const prova = (k) => provas.find((x) => x.startsWith({ category: 'categoria', subcategory: 'público', modality: 'modalidade' }[k])) || null;
    let categoriaOk = true;
    if (mudancas.category) { categoriaOk = await gravarSeIgual(db, p.id, 'category', p.category, mudancas.category); if (categoriaOk) { feito.category = mudancas.category; provasFeitas.push(prova('category')); } }
    // público e modalidade dependem da categoria: só seguem se ela ficou como planejado
    if (categoriaOk && mudancas.subcategory && await gravarSeIgual(db, p.id, 'subcategory', p.subcategory, mudancas.subcategory)) { feito.subcategory = mudancas.subcategory; provasFeitas.push(prova('subcategory')); }
    if (categoriaOk && mudancas.modality) {
      // atômico: só a chave modality dentro de classification, e só se continuar vazia (não apaga edição do meio)
      const n = await db.$executeRawUnsafe(
        'UPDATE "Product" SET "aiContext" = COALESCE("aiContext", \'{}\'::jsonb) || jsonb_build_object(\'classification\', COALESCE("aiContext"->\'classification\', \'{}\'::jsonb) || jsonb_build_object(\'modality\', $2::text)) ' +
        'WHERE id = $1 AND (jsonb_typeof("aiContext") = \'object\' OR "aiContext" IS NULL) AND upper(btrim(COALESCE("aiContext"->\'classification\'->>\'modality\', \'\'))) IN (\'\', \'A CLASSIFICAR\', \'A DEFINIR\', \'NAO DEFINIDO\', \'NÃO DEFINIDO\')',
        p.id, mudancas.modality);
      if (n === 1) { feito.modality = mudancas.modality; provasFeitas.push(prova('modality')); }
    }
    if (!Object.keys(feito).length) continue;
    res.preenchidos++; res.campos += Object.keys(feito).length;
    if (res.itens.length < 50) res.itens.push({ productId: p.id, nome: p.name, marca: p.brand, mudancas: feito, provas: provasFeitas });
    await mergeAiContext(db, p.id, { preenchidoPeloGerente: { em: agora.toISOString(), campos: feito, provas: provasFeitas.filter(Boolean) } });
  }
  return res;
}

const state = { lastRunAt: null, lastResult: null, lastError: null };
function iniciarCuidadorDeMarca(db) {
  if (process.env.CUIDADOR_DE_MARCA === '0') { console.log('[cuidador de marca] desligado (CUIDADOR_DE_MARCA=0)'); return; }
  // trava: uma rodada por vez (auditoria 19/11 — cor + fotos podem passar da hora no pior caso)
  let rodando = false;
  const rodar = () => {
    if (rodando) { state.lastSkippedAt = new Date().toISOString(); return Promise.resolve(); }
    rodando = true;
    return cuidar(db).then(async (r) => {
      const f = await cuidarFotos(db).catch((e) => ({ erro: e.message, fotos: 0, consultas: 0 }));
      state.lastRunAt = new Date().toISOString();
      state.lastResult = { cards: r.cards, preenchidos: r.preenchidos, campos: r.campos, cores: r.cores, fotosOficiais: f.fotos, fotosConsultas: f.consultas, ...(f.erro ? { fotosErro: f.erro } : {}) };
      state.lastError = null;
      if (r.preenchidos || r.cores || f.fotos) console.log('[cuidador de marca]', JSON.stringify(state.lastResult));
    })
      .catch((e) => { state.lastError = e.message; console.warn('[cuidador de marca] falhou:', e.message); })
      .finally(() => { rodando = false; });
  };
  setTimeout(rodar, 4 * 60 * 1000);
  setInterval(rodar, 60 * 60 * 1000);
  console.log('[cuidador de marca] ligado: cada marca preenche sozinha o que tem prova escrita (de hora em hora)');
}
function estadoCuidadorDeMarca() { return JSON.parse(JSON.stringify(state)); }

module.exports = { precisaCorOficial, corPeloSiteDaMarca, precisaFotoOficial, fotosPeloSiteDaMarca, cuidarFotos, temNumeracaoInfantil, gradeProvaAdulto, planejar, pendencias, candidatos, cuidar, iniciarCuidadorDeMarca, estadoCuidadorDeMarca };
