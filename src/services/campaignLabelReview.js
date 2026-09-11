const { campaignLabelModel } = require('./campaignLabelModel');
const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
function campaignLabelReview(products, describe) {
  const groups = new Map();
  for (const p of products) {
    const printedModel = campaignLabelModel({ ...p, originalProductName: p.name, productName: describe(p) });
    const model = printedModel.replace(/\s+(?:FSAL|SCTY)$/, '');
    const brand = /^(CONVERSE|ALL ?STAR)$/.test(norm(p.brand)) ? 'ALL STAR' : norm(p.brand);
    const usage = p.labelUsage || [];
    const boot = /^(UMBRO|JOMA|KAPPA|MIZUNO|MUNICH|TOPPER)$/.test(brand);
    const issue = !usage.filter(Boolean).length ? 'Funcionalidade não definida'
      : boot && (!/FUTSAL|SOCIETY|FUTEBOL DE CAMPO/.test(usage[0]) || !/^(PROFISSIONAL|PARA TREINO|PARA INICIANTES)$/.test(usage[1])) ? 'Falta modalidade ou nível de uso'
      : /^(PARA CORRIDA|PARA CAMINHADA|PARA TREINO)$/.test(usage[0]) ? 'Funcionalidade genérica sem aprovação'
      : /LONGAS DIST/.test(norm(usage.join(' '))) ? 'Falta indicação de uso aprovada para este modelo' : null;
    // Quantity belongs to the commercial model, never to a price/use/colour.
    const key = JSON.stringify([brand, norm(model)]);
    const variant = { productId: p.id, price: p.price, promoPrice: p.promoPrice, labelUsage: usage };
    if (groups.has(key)) {
      const group = groups.get(key);
      group.variantCount++;
      group.labelVariants.push(variant);
      if (issue) group.labelIssue = issue;
      continue;
    }
    groups.set(key, { ...p, labelModel: model, variantCount: 1, labelIssue: issue, labelVariants: [variant] });
  }
  for (const p of groups.values()) {
    const prices = new Set(p.labelVariants.map(v => JSON.stringify([v.price, v.promoPrice ?? null])));
    const usages = new Set(p.labelVariants.map(v => JSON.stringify(v.labelUsage)));
    const issues = [p.labelIssue];
    if (prices.size > 1) issues.push('Preços divergentes: definir um preço para as duas etiquetas do modelo');
    if (usages.size > 1) issues.push('Modalidades ou funcionalidades divergentes: definir o texto das duas etiquetas do modelo');
    p.labelIssue = issues.filter(Boolean).join('; ') || null;
  }
  const result = [...groups.values()];
  return { products: result, originalCount: products.length, requestedLabelCount: result.length * 2, labelCount: result.filter(p => !p.labelIssue).length * 2, pending: result.filter(p => p.labelIssue) };
}
module.exports = { campaignLabelReview };
