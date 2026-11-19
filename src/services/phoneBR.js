// =====================================================================
// Telefone brasileiro no formato do ENVIO de WhatsApp: só dígitos, com 55
// na frente, 12 ou 13 dígitos (55 + DDD + número). Inválido → null.
// Fonte única: o envio (src/whatsapp.js), o limitador e o código do
// cadastro da Liga usam a MESMA função — "83 9…" e "5583 9…" são o
// mesmo número para tudo.
// =====================================================================

function formatPhoneBR(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (!p) return null;
  if (!p.startsWith('55')) p = '55' + p;
  if (p.length < 12 || p.length > 13) return null;
  return p;
}

module.exports = { formatPhoneBR };
