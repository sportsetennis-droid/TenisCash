// Final prices approved by Douglas on 12 September 2026, for every color/size.
const PRICES = Object.freeze({ CENTRALE:199, ESSENZIALE:199, GIOVE:189,
  ILLUSIONE:129, LEGGENDA:199, MARINO:119, MODENA:129, MONZA:139,
  PLAYMAKER:199, SAGA:129, SFORZA:239, 'STRATUS II':199, 'VULCANO II':199 });
function diadoraFixedPrice(item) {
  if (String(item.brand || '').trim().toUpperCase() !== 'DIADORA') return null;
  const name = String(item.originalProductName || item.productName || item.name || '').toUpperCase();
  const matches = Object.keys(PRICES).filter(model => new RegExp('\\b' + model.replace(/ /g, '\\s+') + '\\b').test(name));
  return matches.length === 1 ? PRICES[matches[0]] : null;
}
module.exports = { PRICES, diadoraFixedPrice };
