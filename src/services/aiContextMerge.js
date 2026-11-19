// =====================================================================
// Grava SÓ as chaves pedidas no Product.aiContext, de forma ATÔMICA.
// Uso: assinaturas de sincronização (nsImagesSig, nsCardSig, nsMirrorSig…).
// Nunca regrava o aiContext inteiro a partir de uma leitura antiga — senão
// uma edição do dono feita no meio de um envio à Nuvemshop (cor,
// classificação…) seria desfeita sem aviso (auditoria 2026-11-18).
// =====================================================================

async function mergeAiContext(prisma, productId, patch = {}, remove = []) {
  const n = await prisma.$executeRawUnsafe(
    'UPDATE "Product" SET "aiContext" = ((CASE WHEN "aiContext" IS NULL THEN \'{}\'::jsonb ELSE "aiContext" END) - $3::text[]) || $2::jsonb ' +
    'WHERE id = $1 AND ("aiContext" IS NULL OR jsonb_typeof("aiContext") = \'object\')',
    productId, JSON.stringify(patch || {}), Array.isArray(remove) ? remove : []);
  if (n === 1) return true;
  // aiContext em formato antigo (texto JSON): lê, junta e grava em JS
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { aiContext: true } });
  if (!p) return false;
  let ctx = {};
  try { ctx = (typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext) || {}; } catch (_) { ctx = {}; }
  if (typeof ctx !== 'object' || Array.isArray(ctx)) ctx = {};
  for (const k of remove || []) delete ctx[k];
  Object.assign(ctx, patch || {});
  await prisma.product.update({ where: { id: productId }, data: { aiContext: ctx } });
  return true;
}

module.exports = { mergeAiContext };
