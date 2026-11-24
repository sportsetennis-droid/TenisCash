'use strict';
// =====================================================================
// FOTOS COM LINK MORTO (dono 24/11/2026: "Resolva pq as Fotos não aparecem")
// Parte das fotos dos cards é link para o site de origem (site da marca ou
// revendedor, gravado pelo gerente de marca). Quando a loja de origem apaga a
// imagem, o card fica com uma foto quebrada no app e na consulta de estoque.
//
// De hora em hora o gerente de marca confere alguns links e retira do card
// SÓ o que o servidor de origem diz que não existe mais (HTTP 404 ou 410) em
// DUAS conferências com pelo menos 1 hora de intervalo: a Shopify às vezes
// responde 404 para foto que existe (24/11: 16 links voltaram a responder 200).
// O primeiro 404 só marca o link como suspeito (aiContext.fotosLinksSuspeitos).
// Erro de rede, tempo esgotado, 403 ou 5xx não retiram nada (pode ser
// instabilidade). A foto retirada fica registrada em aiContext.fotosRetiradas,
// e o card volta para a fila de fotos (cuidarFotos completa pelo código exato).
// Desliga com CUIDADOR_FOTO_MORTA=0.
// =====================================================================
const { mergeAiContext } = require('./aiContextMerge');

const UM_DIA = 24 * 3600 * 1000;
const UMA_HORA = 3600 * 1000;
const isLink = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim());
const objeto = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};

async function statusDoLink(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TenisCash-fotos/1.0)', Range: 'bytes=0-0' } });
    try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (_) {}
    return r.status;
  } catch (_) {
    return null; // rede/tempo: não decide nada
  } finally { clearTimeout(t); }
}
const morto = (status) => status === 404 || status === 410;

// Confere um card. Devolve as URLs retiradas (ou [] se nada saiu).
async function conferirCard(db, p, { agora = new Date(), checar = statusDoLink } = {}) {
  const antes = [p.imageUrl, ...(Array.isArray(p.imageUrls) ? p.imageUrls : [])].filter((u) => typeof u === 'string' && u.trim());
  const links = [...new Set(antes.filter(isLink))];
  const suspeitosAntes = objeto(objeto(p.aiContext).fotosLinksSuspeitos);
  const mortos = [];
  const suspeitos = {};
  for (const u of links) {
    if (!morto(await checar(u))) continue;
    const desde = Date.parse(suspeitosAntes[u] || '');
    if (desde && agora.getTime() - desde >= UMA_HORA) mortos.push(u); // 2º 404, 1 hora depois: sai
    else suspeitos[u] = suspeitosAntes[u] || agora.toISOString(); // 1º 404: só fica suspeito
  }
  if (!mortos.length) {
    await mergeAiContext(db, p.id, { fotosLinksConferidosEm: agora.toISOString(), fotosLinksSuspeitos: suspeitos });
    return [];
  }
  const ficam = antes.filter((u) => !mortos.includes(u));
  // atômico: só grava se a foto principal e a galeria continuam as que foram lidas
  const n = await db.$executeRawUnsafe(
    'UPDATE "Product" SET "imageUrl" = $2, "imageUrls" = $3::jsonb, "updatedAt" = now(), "aiContext" = COALESCE("aiContext", \'{}\'::jsonb) || jsonb_build_object(' +
    '\'fotosLinksConferidosEm\', $7::text, \'fotosLinksSuspeitos\', $8::jsonb, ' +
    '\'fotosRetiradas\', (CASE WHEN jsonb_typeof("aiContext"->\'fotosRetiradas\') = \'array\' THEN "aiContext"->\'fotosRetiradas\' ELSE \'[]\'::jsonb END) || jsonb_build_array($4::jsonb)) ' +
    'WHERE id = $1 AND (jsonb_typeof("aiContext") = \'object\' OR "aiContext" IS NULL) AND COALESCE("imageUrl", \'\') = $5::text AND (CASE WHEN jsonb_typeof("imageUrls") = \'array\' THEN "imageUrls" ELSE \'[]\'::jsonb END) = $6::jsonb',
    p.id, ficam[0] || null, JSON.stringify(ficam.slice(1)),
    JSON.stringify({ em: agora.toISOString(), urls: mortos, motivo: 'link morto: o site de origem respondeu 404/410 em duas conferências com 1 hora de intervalo', por: 'gerente da marca' }),
    String(p.imageUrl || ''), JSON.stringify(Array.isArray(p.imageUrls) ? p.imageUrls : []), agora.toISOString(), JSON.stringify(suspeitos));
  return n === 1 ? mortos : [];
}

// Cards ativos com foto em link: primeiro os que têm link suspeito, depois o conferido há mais tempo.
async function retirarFotosMortas(db, { agora = new Date(), limiteLinks = Number(process.env.CUIDADOR_FOTO_MORTA_LIMITE || 150), checar = statusDoLink } = {}) {
  const res = { cards: 0, links: 0, retiradas: 0, itens: [] };
  if (process.env.CUIDADOR_FOTO_MORTA === '0') return res;
  const lista = await db.$queryRawUnsafe(
    'SELECT p.id, p.name, p.brand, p."imageUrl", p."imageUrls", p."aiContext", p."aiContext"->>\'fotosLinksConferidosEm\' AS conferido, ' +
    '(jsonb_typeof(p."aiContext"->\'fotosLinksSuspeitos\') = \'object\' AND p."aiContext"->\'fotosLinksSuspeitos\' <> \'{}\'::jsonb) AS suspeito FROM "Product" p ' +
    'WHERE p.active AND (p."imageUrl" ~* \'^https?://\' OR (jsonb_typeof(p."imageUrls") = \'array\' AND p."imageUrls"::text ~* \'"https?://\')) ' +
    'ORDER BY 8 DESC NULLS LAST, (p."aiContext"->>\'fotosLinksConferidosEm\') NULLS FIRST, p."updatedAt" DESC LIMIT 400');
  for (const p of lista) {
    const t = p.conferido && Date.parse(p.conferido);
    // cada card no máximo 1 vez por dia; card com link suspeito volta depois de 1 hora
    if (t && agora.getTime() - t < (p.suspeito ? UMA_HORA : UM_DIA)) continue;
    const n = [p.imageUrl, ...(Array.isArray(p.imageUrls) ? p.imageUrls : [])].filter(isLink).length;
    if (res.links + n > limiteLinks) break;
    res.cards++; res.links += n;
    const tiradas = await conferirCard(db, p, { agora, checar }).catch(() => []);
    if (tiradas.length) {
      res.retiradas += tiradas.length;
      if (res.itens.length < 50) res.itens.push({ productId: p.id, nome: p.name, marca: p.brand, retiradas: tiradas });
    }
  }
  return res;
}

module.exports = { statusDoLink, conferirCard, retirarFotosMortas, morto };
