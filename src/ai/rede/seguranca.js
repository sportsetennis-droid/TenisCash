// =====================================================================
// RNA — middleware de segurança (envolve TODA ativação)
//  1. mascararPII: CPF, telefone, e-mail, chaves/tokens nunca vão pra IA.
//  2. politica: o que mexe em preço, cliente, dinheiro ou publicação vira
//     SEMPRE proposta (aprovação do dono). Nenhum neurônio age direto.
//  3. injecao: conteúdo externo (WhatsApp, e-mail, XML, Instagram) é DADO,
//     nunca instrução; frases de comando escondidas viram alerta.
//  4. antiChute: proposta sem evidência (de onde veio cada dado) é barrada.
// =====================================================================

const RX = {
  cpf: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
  cnpj: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
  fone: /(?:\+?55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g,
  email: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  segredo: /\b(?:sk|pk|rk|re|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
};

// CNPJ de empresa é público (fornecedor) — só mascaramos se pedirem.
function mascararTexto(s, { cnpj = false } = {}) {
  if (typeof s !== 'string') return s;
  let t = s.replace(RX.segredo, '[segredo]').replace(RX.email, '[email]');
  if (cnpj) t = t.replace(RX.cnpj, '[cnpj]');
  t = t.replace(RX.cpf, '[cpf]').replace(RX.fone, '[telefone]');
  return t;
}
const CHAVES_SENSIVEIS = /^(cpf|telefone|phone|fone|celular|email|e-mail|senha|password|pin|token|secret|chave|identitySalt|privateKeySealed)$/i;
function mascararPII(v, opts = {}, depth = 0) {
  if (depth > 8) return '[...]';
  if (typeof v === 'string') return mascararTexto(v, opts);
  if (Array.isArray(v)) return v.map((x) => mascararPII(x, opts, depth + 1));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = CHAVES_SENSIVEIS.test(k) ? '[protegido]' : mascararPII(x, opts, depth + 1);
    return o;
  }
  return v;
}

// Temas que SEMPRE exigem o "sim" do dono (regra global do CLAUDE.md).
const TEMAS_PROTEGIDOS = ['preco', 'desconto', 'cliente', 'whatsapp', 'mensagem', 'dinheiro', 'pagamento', 'cashback', 'publicar', 'nuvemshop', 'estoque-ajuste', 'compra'];

// Valida a saída de um neurônio. Retorna { ok, sinais, bloqueios }.
function politica(neuronio, saidas) {
  const bloqueios = [];
  const ok = [];
  for (const s of saidas || []) {
    if (!s || typeof s.tipo !== 'string') { bloqueios.push({ motivo: 'sinal-invalido', sinal: s }); continue; }
    const permitido = (neuronio.emite || []).some((t) => t === s.tipo || (t.endsWith('*') && s.tipo.startsWith(t.slice(0, -1))));
    if (!permitido && s.tipo !== 'dado-faltante') { bloqueios.push({ motivo: 'tipo-nao-declarado', tipo: s.tipo }); continue; }
    if (s.tipo.startsWith('acao.')) {
      // ação direta só existe para coisas sem risco; o que toca tema protegido vira proposta
      const tema = String((s.dados && s.dados.tema) || '');
      if (TEMAS_PROTEGIDOS.some((t) => tema.includes(t))) { bloqueios.push({ motivo: 'acao-direta-proibida', tipo: s.tipo, tema }); continue; }
    }
    if (s.tipo.startsWith('proposta.')) {
      const ev = s.dados && s.dados.evidencia;
      if (!Array.isArray(ev) || !ev.length) { bloqueios.push({ motivo: 'proposta-sem-evidencia', tipo: s.tipo }); continue; }
      if (typeof s.dados.titulo !== 'string' || !s.dados.titulo.trim()) { bloqueios.push({ motivo: 'proposta-sem-titulo', tipo: s.tipo }); continue; }
    }
    ok.push(s);
  }
  return { ok: bloqueios.length === 0, sinais: ok, bloqueios };
}

// Conteúdo vindo de fora: procura instruções escondidas (prompt injection).
const RX_INJECAO = [
  /ignor[ea]\s+(as|todas|the|all|previous|anteriores)/i,
  /(voc[eê]|you)\s+(agora\s+[eé]|are now)/i,
  /(system|sistema)\s*prompt/i,
  /aprovad[oa]\s+pelo\s+(dono|douglas|gerente)/i,
  /(mude|altere|change|set)\s+(o\s+)?(pre[cç]o|price|desconto|discount)/i,
  /(envie|mande|send)\s+.*(cpf|senha|token|password)/i,
  /<\s*(script|iframe)/i,
];
function injecao(texto) {
  const t = String(texto || '');
  const hits = RX_INJECAO.filter((r) => r.test(t)).map((r) => r.source);
  return { suspeito: hits.length > 0, padroes: hits };
}

module.exports = { mascararPII, mascararTexto, politica, injecao, TEMAS_PROTEGIDOS };
