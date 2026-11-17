// =====================================================================
// RNA — regras da casa compartilhadas pelos neurônios comerciais
// (vendas, CRM, marketing, financeiro, Club). Não é neurônio: é
// biblioteca. Datas sempre em America/Fortaleza (UTC-3 fixo, sem DST).
// Texto pro cliente segue docs/marketing/CONSTITUICAO-PUBLICACOES.md.
// =====================================================================
const crypto = require('crypto');

const OFFSET_MS = 3 * 3600 * 1000; // Fortaleza = UTC-3 fixo

// Partes da data em Fortaleza. `quando` = Date | ISO | número.
function fortaleza(quando) {
  const d = quando ? new Date(quando) : new Date();
  const local = new Date(d.getTime() - OFFSET_MS);
  const y = local.getUTCFullYear(), m = local.getUTCMonth(), dia = local.getUTCDate();
  const inicio = new Date(Date.UTC(y, m, dia, 3, 0, 0)); // 00:00 Fortaleza
  return {
    agora: d,
    inicio,
    fim: new Date(inicio.getTime() + 24 * 3600 * 1000),
    ymd: `${y}-${String(m + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
    hora: local.getUTCHours(),
    diaSemana: local.getUTCDay(), // 0 = domingo
  };
}
const DIA = 24 * 3600 * 1000;
const NOMES_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const reais = (v) => 'R$ ' + (Math.round(Number(v || 0) * 100) / 100).toFixed(2).replace('.', ',');
const pct = (v) => (Math.round(Number(v || 0) * 1000) / 10).toFixed(1).replace('.', ',') + '%';

// Status de venda que NÃO contam como venda.
const VENDA_INVALIDA = ['canceled', 'cancelled', 'cancelada', 'refunded', 'estornada', 'pending', 'pendente'];

// ---------------- Constituição de Comunicação ----------------
// Corrige o que é regra literal do dono; aponta o que precisa de olho humano.
const CORRECOES = [
  { rx: /\bconsultor(a|es|as)?(\s+de\s+vendas)?\b/gi, para: (m) => (/^C/.test(m) ? 'Vendedor' : 'vendedor'), regra: 'é VENDEDOR, nunca consultor (dono 2026-11-15)' },
  { rx: /\s*,?\s*sem\s+juros\b/gi, para: '', regra: '10x sem "sem juros" (Constituição item 7)' },
  { rx: /\b50\s*%\s*(off|de\s+desconto|desconto)\b/gi, para: '50% DE DESCONTO', regra: '"50% DE DESCONTO" exato (Constituição item 7)' },
  { rx: /\s*\(?imagem\s+ilustrativa\)?\.?/gi, para: '', regra: 'proibido "imagem ilustrativa"' },
  { rx: /💚/g, para: '🧡', regra: 'tudo é laranja (🧡, nunca 💚)' },
];
const ALERTAS = [
  { rx: /consulte\s+(o\s+)?seu\s+tamanho/i, regra: '"consulte seu tamanho" não pode ser a chamada principal (item 8)' },
  { rx: /\bat[eé]\s+\d{1,2}\s*%/i, regra: '"ATÉ X%" só na chamada geral, autorizado e "em produtos selecionados"' },
  { rx: /\b\d{1,2}\s*%/, regra: 'menciona percentual de desconto: precisa autorização do dono (>15% só com pricing)' },
  { rx: /\b(BR|PT|AZ|VD|VM|RO|AMC|MR|CZ|BCO|PTO|MAR)\s*\/\s*(BR|PT|AZ|VD|VM|RO|AMC|MR|CZ|BCO|PTO|MAR)\b/, regra: 'cor abreviada: cor sempre por extenso e em português' },
  { rx: /\b(garantido|melhor\s+pre[cç]o\s+da\s+cidade|[uú]ltimas\s+unidades|s[oó]\s+hoje)\b/i, regra: 'promessa/urgência que não veio de dado real' },
];

function revisarTexto(texto) {
  let t = String(texto || '');
  const corrigido = [];
  for (const c of CORRECOES) {
    if (c.rx.test(t)) { corrigido.push(c.regra); t = t.replace(c.rx, c.para); }
    c.rx.lastIndex = 0;
  }
  const alertas = ALERTAS.filter((a) => a.rx.test(t)).map((a) => a.regra);
  return { texto: t.replace(/[ \t]{2,}/g, ' ').trim(), corrigido, alertas };
}

module.exports = { fortaleza, DIA, NOMES_DIA, hash, reais, pct, VENDA_INVALIDA, revisarTexto };
