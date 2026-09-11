const { campaignLabelModel } = require('./campaignLabelModel');
const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
function campaignLabelReview(products, describe) {
  const groups = new Map();
  for (const p of products) {
    const model = campaignLabelModel({ ...p, productName: describe(p) });
    const brand = /^(CONVERSE|ALL ?STAR)$/.test(norm(p.brand)) ? 'ALL STAR' : norm(p.brand);
    const usage = p.labelUsage || [];
    const boot = /^(UMBRO|JOMA|KAPPA|MIZUNO|MUNICH|TOPPER)$/.test(brand);
    const issue = !usage.filter(Boolean).length ? 'Funcionalidade não definida'
      : boot && (!/FUTSAL|SOCIETY|FUTEBOL DE CAMPO/.test(usage[0]) || !usage[1]) ? 'Falta modalidade ou nível de uso'
      : /^(PARA CORRIDA|PARA CAMINHADA|PARA TREINO)$/.test(usage[0]) ? 'Funcionalidade genérica sem aprovação'
      : /LONGAS DIST/.test(norm(usage.join(' '))) ? 'Falta indicação de uso aprovada para este modelo' : null;
    const key = JSON.stringify([brand, norm(model), Math.round(Number(p.price)*100), p.promoPrice == null ? null : Math.round(Number(p.promoPrice)*100), usage]);
    if (groups.has(key)) { groups.get(key).variantCount++; continue; }
    groups.set(key, { ...p, labelModel: model, variantCount: 1, labelIssue: issue });
  }
  // A colour/size variation may not silently select a different use case.
  const usages = new Map();
  for (const p of groups.values()) {
    const key = norm(p.brand) + '|' + norm(p.labelModel) + (/^(UMBRO|JOMA|KAPPA|MIZUNO|MUNICH|TOPPER)$/.test(norm(p.brand)) ? '|' + (p.labelUsage?.[0] || '') : '');
    if (!usages.has(key)) usages.set(key, new Set());
    usages.get(key).add(JSON.stringify(p.labelUsage));
  }
  for (const p of groups.values()) {
    const key = norm(p.brand) + '|' + norm(p.labelModel) + (/^(UMBRO|JOMA|KAPPA|MIZUNO|MUNICH|TOPPER)$/.test(norm(p.brand)) ? '|' + (p.labelUsage?.[0] || '') : '');
    if (usages.get(key).size > 1) p.labelIssue = 'Funcionalidades divergentes para o mesmo modelo; conferir modalidade';
  }
  const result = [...groups.values()];
  return { products: result, originalCount: products.length, labelCount: result.length * 2, pending: result.filter(p => p.labelIssue) };
}
module.exports = { campaignLabelReview };
