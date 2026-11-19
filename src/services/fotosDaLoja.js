'use strict';
// =====================================================================
// FOTOS PELA LOJA — dono, 19/11/2026: "Faça sem crédito" / "Arrume outro jeito".
// A busca paga acabou o crédito e a busca grátis no site da marca acha pouco
// (a maior parte do estoque é modelo fora de linha). Todo card que falta foto
// tem a PEÇA na loja: o vendedor fotografa.
//
// Regras (nada de chute, regra 27 = 5 fotos da MESMA cor):
//   - antes de fotografar, o vendedor BIPA o código da peça; a foto só entra se
//     o código for deste card (mesmo código = mesma cor e mesmo modelo);
//   - vendedor só envia para card com estoque em loja da conta dele (gestor/admin: qualquer);
//   - imagem reduzida para JPEG ≤ 1200 px no servidor; no máximo 5 no card;
//   - "completar" soma às fotos válidas que o card já tem; "trocar" substitui todas
//     (quando as atuais são de outra cor); as anteriores ficam guardadas;
//   - grava quem tirou, em que loja, quando e por qual código (aiContext.fotosDaLoja).
// O espelho do card (regra 28) leva as fotos para a Nuvemshop sozinho.
// =====================================================================
const { canSend } = require('./scanTransfers');
const { usableImageCount, minPhotos } = require('./nuvemshopEligibility');
const barcodePolicy = require('../../public/scanner-barcode-policy');

const MAX_FOTOS = 5;
const MAX_BYTES = 6 * 1024 * 1024; // por imagem recebida (antes de reduzir)

function falha(msg, status = 400) { const e = new Error(msg); e.status = status; throw e; }
const contexto = (p) => { try { return (typeof p?.aiContext === 'string' ? JSON.parse(p.aiContext) : p?.aiContext) || {}; } catch (_) { return {}; } };
function galeria(p) {
  try { const v = typeof p?.imageUrls === 'string' ? JSON.parse(p.imageUrls) : p?.imageUrls; return Array.isArray(v) ? v : []; } catch (_) { return []; }
}
function fotosValidas(p) {
  const ok = (s) => typeof s === 'string' && s.trim() && !/lookaside\.instagram\.com|\/crawler\/|google_widget|\/seo\//i.test(s)
    && (/^data:image\/[a-z0-9.+-]+;base64,/i.test(s.trim()) || /^https?:\/\//i.test(s.trim()));
  return [...new Set([p?.imageUrl, ...galeria(p)].filter(ok).map((s) => s.trim()))];
}

// Cards ativos com estoque nesta loja e menos de 5 fotos (os com menos fotos primeiro).
async function pendentes(db, actor, storeId, { limite = 300 } = {}) {
  if (!storeId) falha('Escolha a loja.');
  if (!canSend(actor, storeId)) falha('Esta loja não está vinculada à sua conta.', 403);
  const linhas = await db.$queryRawUnsafe(
    'SELECT p.id, p.name, p.brand, p."imageUrl", p."imageUrls", p."aiContext", ' +
    'json_agg(json_build_object(\'tamanho\', s.size, \'codigo\', s.barcode, \'estoque\', ss.stock) ORDER BY s.size) AS tamanhos ' +
    'FROM "Product" p JOIN "ProductSize" s ON s."productId" = p.id JOIN "StoreStock" ss ON ss."productSizeId" = s.id ' +
    'WHERE p.active AND ss."storeId" = $1 AND ss.stock > 0 GROUP BY p.id', storeId);
  const min = minPhotos();
  return linhas
    .map((p) => ({ p, n: usableImageCount(p) }))
    .filter((x) => x.n < min)
    .sort((a, b) => a.n - b.n || String(a.p.brand || '').localeCompare(String(b.p.brand || '')) || String(a.p.name).localeCompare(String(b.p.name)))
    .slice(0, limite)
    .map(({ p, n }) => {
      const ctx = contexto(p);
      const capa = fotosValidas(p).find((u) => /^https?:\/\//i.test(u)) || null; // miniatura leve (sem base64 na lista)
      return { id: p.id, nome: p.name, marca: p.brand, cor: ctx.color || null, fotos: n, faltam: min - n, capa, tamanhos: p.tamanhos };
    });
}

// Reduz e padroniza a imagem (JPEG ≤ 1200 px). Recusa o que não for imagem.
async function reduzir(dataUrl, sharpLib) {
  const m = /^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || '').trim());
  if (!m) falha('Envie a foto como imagem (JPEG, PNG ou WEBP).');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) falha('Foto vazia ou grande demais (máximo 6 MB).');
  const sharp = sharpLib || require('sharp');
  let out;
  try {
    const img = sharp(buf, { failOn: 'error' }).rotate();
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < 300 || meta.height < 300) falha('Foto pequena demais: chegue mais perto da peça (mínimo 300 px).');
    out = await img.resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } catch (e) {
    if (e.status) throw e;
    falha('Não foi possível ler a foto. Tire de novo.');
  }
  return 'data:image/jpeg;base64,' + out.toString('base64');
}

// Grava as fotos tiradas na loja no card. modo: 'completar' (padrão) | 'trocar'.
async function salvar(db, actor, productId, { storeId, codigo, imagens, modo = 'completar' } = {}, { agora = new Date(), sharpLib = null } = {}) {
  if (!storeId) falha('Escolha a loja.');
  if (!canSend(actor, storeId)) falha('Esta loja não está vinculada à sua conta.', 403);
  if (!['completar', 'trocar'].includes(modo)) falha('Modo inválido.');
  const lista = Array.isArray(imagens) ? imagens : [];
  if (!lista.length) falha('Tire pelo menos 1 foto.');
  if (lista.length > MAX_FOTOS) falha('No máximo 5 fotos.');
  const lido = String(codigo || '').trim();
  if (!lido) falha('Bipe o código da peça antes de fotografar.');

  const produto = await db.product.findUnique({ where: { id: productId }, include: { sizes: { select: { id: true, barcode: true, storeStocks: { where: { storeId }, select: { stock: true } } } } } });
  if (!produto || !produto.active) falha('Produto não encontrado ou inativo.', 404);
  // o código bipado tem de ser de um tamanho DESTE card (mesmo código = mesma cor)
  const variantes = new Set(barcodePolicy.variants(lido));
  const tamanho = produto.sizes.find((s) => s.barcode && variantes.has(s.barcode));
  if (!tamanho) falha('Este código não é deste produto. Confira a peça: a foto tem de ser da mesma cor e modelo.', 409);
  if (!produto.sizes.some((s) => s.storeStocks.some((x) => x.stock > 0))) falha('Este produto não tem estoque nesta loja.', 409);

  const novas = [];
  for (const im of lista) novas.push(await reduzir(im, sharpLib));
  const anteriores = fotosValidas(produto);
  const finais = [...new Set(modo === 'trocar' ? novas : [...anteriores, ...novas])].slice(0, MAX_FOTOS);

  const ctx = contexto(produto);
  const registro = {
    em: agora.toISOString(), por: actor.name || null, userId: actor.id, storeId, codigo: tamanho.barcode, modo,
    enviadas: novas.length, total: finais.length,
    // guarda as anteriores só quando são links (base64 já fica no histórico do banco e pesaria o card)
    anteriores: [produto.imageUrl, ...galeria(produto)].filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)),
    trocouBase64: modo === 'trocar' ? anteriores.filter((u) => u.startsWith('data:')).length : 0,
  };
  const historico = Array.isArray(ctx.fotosDaLojaHistorico) ? ctx.fotosDaLojaHistorico.slice(-9) : [];
  // atômico: só grava se as fotos do card continuam as que foram lidas (não atropela edição do meio)
  const n = await db.$executeRawUnsafe(
    'UPDATE "Product" SET "imageUrl" = $2, "imageUrls" = $3::jsonb, "aiContext" = (COALESCE("aiContext", \'{}\'::jsonb) - \'fotoOficialTentativa\') || jsonb_build_object(\'fotosDaLoja\', $4::jsonb, \'fotosDaLojaHistorico\', $5::jsonb), "updatedAt" = now() ' +
    'WHERE id = $1 AND (jsonb_typeof("aiContext") = \'object\' OR "aiContext" IS NULL) AND COALESCE("imageUrl", \'\') = $6::text AND COALESCE("imageUrls", \'[]\'::jsonb) = $7::jsonb',
    produto.id, finais[0], JSON.stringify(finais.slice(1)), JSON.stringify(registro), JSON.stringify([...historico, registro]),
    String(produto.imageUrl || ''), JSON.stringify(galeria(produto)));
  if (n !== 1) falha('As fotos deste produto mudaram enquanto você enviava. Abra de novo e envie.', 409);
  return { ok: true, productId: produto.id, fotos: finais.length, faltam: Math.max(0, minPhotos() - finais.length), codigo: tamanho.barcode };
}

module.exports = { pendentes, salvar, reduzir, fotosValidas, MAX_FOTOS };
