// =====================================================================
// opsGuard.js — guarda dos endpoints temporários de operação/debug (/api/_*)
// =====================================================================
// PROBLEMA: este repositório é PÚBLICO. Qualquer string de "guard" hardcoded
// no código (ex.: ?g=reinado2026) é conhecida por quem lê o GitHub — ou seja,
// os endpoints _falgen (gasta $ na fal.ai), _loopbrain (roda IA), _agentpush,
// _fiscaldiag etc. estavam efetivamente ABERTOS.
//
// SOLUÇÃO: o segredo passa a vir da env var DEBUG_OPS_KEY (setada SÓ no
// Railway, nunca no código). Enquanto ela não existir, cai no segredo LEGADO
// do próprio endpoint pra não quebrar o que já está em uso — mas loga um aviso
// a cada uso legado. Definir DEBUG_OPS_KEY no Railway fecha o buraco de uma vez
// (a partir daí só a env vale, os segredos do código deixam de funcionar).
//
// Uso:
//   const { opsKeyOk } = require('./opsGuard');
//   if (!opsKeyOk(req, 'reinado2026')) return res.status(403).json({ error: 'forbidden' });
// =====================================================================

function opsKeyOk(req, legacyKey) {
  const provided = String((req && req.query && req.query.g) || '');
  const strong = process.env.DEBUG_OPS_KEY;
  if (strong) return provided.length > 0 && provided === strong; // modo seguro: só a env vale
  if (legacyKey && provided === legacyKey) {
    console.warn('[opsGuard] ' + ((req && req.path) || '?') + ' liberado por chave LEGADA do código — defina DEBUG_OPS_KEY no Railway pra fechar');
    return true;
  }
  return false;
}

module.exports = { opsKeyOk };
