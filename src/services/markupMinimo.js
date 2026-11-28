// REGRA TOTAL (dono 2026-11-28): "é proibido markup abaixo de 100%".
// Preço de venda nunca fica abaixo de custo × 2. Vale para toda marca, categoria e caminho:
//   1) trava na gravação (middleware Prisma): markupPercent < 100 vira 100 e preço abaixo de custo × 2
//      sobe para custo × 2 (também quando o custo sobe);
//   2) varredura de hora em hora: corrige qualquer card que tenha entrado por outro caminho
//      (script, importação com outro cliente Prisma), e o fornecedor com markup médio < 100.
// A promoção (promoPrice) é desconto à parte e não é mexida aqui.
// Não há variável para baixar o mínimo: mudar a regra é decisão do dono, no código.

const MARKUP_MINIMO = 100;
const FATOR = 1 + MARKUP_MINIMO / 100;

const valor = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(typeof v.toNumber === 'function')) {
    if ('set' in v) return valor(v.set);
    return null; // increment/decrement etc.: tratado pela varredura
  }
  const n = Number(typeof v === 'object' ? v.toNumber() : v);
  return Number.isFinite(n) ? n : null;
};
const precoMinimo = (custo) => Math.round(custo * FATOR * 100) / 100;

// Ajusta UM registro de dados de gravação. `atual` = {price, costPrice} já gravados (update) ou null.
function ajustarDados(row, atual) {
  if (!row || typeof row !== 'object') return null;
  const mk = valor(row.markupPercent);
  if (mk !== null && mk < MARKUP_MINIMO) row.markupPercent = MARKUP_MINIMO;
  const toca = 'price' in row || 'costPrice' in row;
  if (!toca) return null;
  const custo = 'costPrice' in row ? valor(row.costPrice) : valor(atual?.costPrice);
  const preco = 'price' in row ? valor(row.price) : valor(atual?.price);
  if (!(custo > 0) || preco === null) return null;
  const min = precoMinimo(custo);
  if (preco + 0.005 >= min) return null;
  row.price = min;
  return { de: preco, para: min, custo };
}

function instalarTravaMarkup(prisma) {
  prisma.$use(async (params, next) => {
    try {
      if (params.model === 'Supplier' && ['create', 'update', 'upsert', 'updateMany', 'createMany'].includes(params.action)) {
        const rows = params.action === 'upsert' ? [params.args.create, params.args.update] : (Array.isArray(params.args.data) ? params.args.data : [params.args.data]);
        for (const r of rows) { const am = r && valor(r.averageMarkup); if (am !== null && am < MARKUP_MINIMO) r.averageMarkup = MARKUP_MINIMO; }
      }
      if (params.model === 'Product') {
        if (params.action === 'create' || params.action === 'createMany') {
          const rows = Array.isArray(params.args.data) ? params.args.data : [params.args.data];
          for (const r of rows) { const a = ajustarDados(r, null); if (a) console.warn('[markup 100%] preço subiu na criação', a); }
        } else if (params.action === 'upsert') {
          ajustarDados(params.args.create, null);
          const d = params.args.update;
          if (d && ('price' in d || 'costPrice' in d)) {
            const atual = await prisma.product.findUnique({ where: params.args.where, select: { price: true, costPrice: true } }).catch(() => null);
            ajustarDados(d, atual);
          } else ajustarDados(d, null);
        } else if (params.action === 'update') {
          const d = params.args.data;
          if (d && ('price' in d || 'costPrice' in d)) {
            const atual = ('price' in d && 'costPrice' in d) ? null
              : await prisma.product.findUnique({ where: params.args.where, select: { price: true, costPrice: true } }).catch(() => null);
            const a = ajustarDados(d, atual);
            if (a) console.warn('[markup 100%] preço subiu na gravação', JSON.stringify({ where: params.args.where, ...a }));
          } else ajustarDados(d, null);
        } else if (params.action === 'updateMany') {
          ajustarDados(params.args.data, null); // sem custo conhecido por linha: a varredura completa
        }
      }
    } catch (e) { console.warn('[markup 100%] trava não aplicada:', e.message); }
    return next(params);
  });
}

const state = { lastRunAt: null, lastResult: null, lastError: null };

// Corrige o que estiver abaixo de 100% (cards ativos com custo). Registra no card de onde para onde.
async function corrigirMarkupAbaixo(db, { aplicar = true, agora = new Date() } = {}) {
  const abaixo = await db.$queryRawUnsafe(
    'SELECT id, price::float AS price, "costPrice"::float AS custo, "markupPercent"::float AS mk FROM "Product" ' +
    'WHERE active AND (("costPrice" > 0 AND price < round(("costPrice" * $1)::numeric, 2) - 0.005) OR "markupPercent" < $2)', FATOR, MARKUP_MINIMO);
  const sup = await db.$queryRawUnsafe('SELECT id FROM "Supplier" WHERE "averageMarkup" < $1', MARKUP_MINIMO);
  const res = { cards: abaixo.length, precos: 0, fornecedores: sup.length };
  if (!aplicar) return res;
  for (const c of abaixo) {
    const novo = c.custo > 0 ? Math.max(c.price, precoMinimo(c.custo)) : c.price;
    const mudouPreco = novo !== c.price;
    const reg = { de: c.price, para: novo, markupDe: c.mk, markupPara: MARKUP_MINIMO, em: agora.toISOString(), por: 'regra markup mínimo 100% (dono 28/11)' };
    await db.$executeRawUnsafe(
      'UPDATE "Product" SET price = $2, "markupPercent" = GREATEST(COALESCE("markupPercent", $3), $3), "updatedAt" = now()' +
      (mudouPreco ? ', "aiContext" = COALESCE(CASE WHEN jsonb_typeof("aiContext") = \'object\' THEN "aiContext" END, \'{}\'::jsonb) || jsonb_build_object(\'precoAlterado\', $4::jsonb)' : '') +
      ' WHERE id = $1', c.id, novo, MARKUP_MINIMO, ...(mudouPreco ? [JSON.stringify(reg)] : []));
    if (mudouPreco) res.precos++;
  }
  if (sup.length) await db.$executeRawUnsafe('UPDATE "Supplier" SET "averageMarkup" = $1 WHERE "averageMarkup" < $1', MARKUP_MINIMO);
  return res;
}

function iniciarVarreduraMarkup(db) {
  const rodar = () => corrigirMarkupAbaixo(db)
    .then((r) => { state.lastRunAt = new Date().toISOString(); state.lastResult = r; state.lastError = null; if (r.cards || r.fornecedores) console.log('[markup 100%] corrigido', JSON.stringify(r)); })
    .catch((e) => { state.lastError = e.message; console.warn('[markup 100%] varredura falhou:', e.message); });
  setTimeout(rodar, 2 * 60 * 1000);
  setInterval(rodar, 60 * 60 * 1000);
  console.log('[markup 100%] regra ligada: preço nunca abaixo de custo × 2 (varredura de hora em hora)');
}
function estadoMarkupMinimo() { return { markupMinimo: MARKUP_MINIMO, ...JSON.parse(JSON.stringify(state)) }; }

module.exports = { MARKUP_MINIMO, precoMinimo, ajustarDados, instalarTravaMarkup, corrigirMarkupAbaixo, iniciarVarreduraMarkup, estadoMarkupMinimo };
