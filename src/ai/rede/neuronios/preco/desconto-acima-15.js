// =====================================================================
// preco.desconto-acima-15 — DETECTOR (regra, custo zero)
// Missão única: travar desconto acima de 15% que não passou pela validação
// de margem (pricing-margin). Regra global: "NUNCA aprovar descontos > 15%
// sem pricing-margin-agent validar".
// Escuta qualquer sinal preco.* que carregue desconto:
//   dados.descontoPct (0–100) | dados.desconto (0–1 ou 0–100) |
//   dados.precoAtual + dados.precoNovo | dados.itens[] com os mesmos campos.
// Validação aceita: dados.validacaoMargem.agente === 'pricing-margin' em
// sinal interno (conteúdo externo nunca valida margem).
// =====================================================================
const LIMITE = 15;

function pct(x) {
  if (!x || typeof x !== 'object') return null;
  if (x.descontoPct != null && Number.isFinite(Number(x.descontoPct))) return Number(x.descontoPct);
  if (x.desconto != null && Number.isFinite(Number(x.desconto))) { const v = Number(x.desconto); return v <= 1 ? v * 100 : v; }
  const a = Number(x.precoAtual); const n = Number(x.precoNovo);
  if (a > 0 && Number.isFinite(n)) return (1 - n / a) * 100;
  return null;
}

module.exports = {
  id: 'preco.desconto-acima-15',
  camada: 'detector',
  missao: 'Bloquear desconto acima de 15% sem validação de margem do pricing.',
  escuta: ['preco.*'],
  emite: ['seg.bloqueio'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['desconto-15-pricing-margin'],
  tempoMax: 10000,
  async disparar({ sinal }) {
    const d = sinal.dados || {};
    const itens = Array.isArray(d.itens) && d.itens.length ? d.itens : [d];
    const acima = itens.map((it) => ({ it, p: pct(it) })).filter((x) => x.p != null && x.p > LIMITE + 1e-9);
    if (!acima.length) return [];
    const validado = !sinal.externo && d.validacaoMargem && d.validacaoMargem.agente === 'pricing-margin' && d.validacaoMargem.ok === true;
    if (validado) return [];
    return [{
      tipo: 'seg.bloqueio',
      forca: 1,
      dados: {
        chave: 'desconto15:' + sinal.id,
        regra: 'desconto > 15% exige validação de margem (pricing-margin)',
        sinalOrigem: { id: sinal.id, tipo: sinal.tipo, origem: sinal.origem },
        itens: acima.map(({ it, p }) => ({ productId: it.productId || null, descontoPct: Math.round(p * 100) / 100, precoAtual: it.precoAtual ?? null, precoNovo: it.precoNovo ?? null })),
        motivo: sinal.externo ? 'desconto vindo de conteúdo externo' : 'sem validacaoMargem do pricing-margin',
        evidencia: acima.map(({ it, p }) => 'desconto ' + p.toFixed(2) + '% ' + (it.productId ? 'no produto ' + it.productId : '') + ' (sinal ' + sinal.tipo + ')'),
      },
    }];
  },
};
