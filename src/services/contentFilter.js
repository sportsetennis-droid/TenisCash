// =====================================================================
// Liga Aberta F6 — FILTRO de nome e texto ofensivo (pt-BR)
// ---------------------------------------------------------------------
// Usado na criação/edição de: torneio, categoria, time, clube, jogador do elenco,
// aviso do mural, jogador do racha, @ e nome do cadastro de atleta.
//
// Como compara (sem falso-positivo em nome de bairro/cidade/time):
//  1. caixa baixa, sem acento (NFD), "ç" vira "c"
//  2. leetspeak simples: 0→o 1→i 3→e 4→a 5→s 7→t @→a $→s ("!" é pontuação, não letra)
//  3. letra repetida vira uma só ("porrrra" = "pora"; o dicionário passa pela mesma conta)
//  4. compara PALAVRA INTEIRA (token), nunca pedaço: "Cuité" não é "cu", "Bessa" não é nada
//  5. letras soltas em sequência ("p u t a", "p.u.t.a") são juntadas e conferidas
//  6. poucas RAÍZES fortes (≥ 5 letras e sem uso comum) pegam variações ("caralhinho")
// A lista NÃO tem palavra ambígua que é sobrenome/bicho/cor em pt-BR (pinto, rola, veado,
// macaco, preto, nego, pica, chupa, kkk...) — preferimos deixar passar a barrar nome real.
// Bloqueio = 400 em português, SEM repetir a palavra (blockMessage).
// =====================================================================

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

function baseNormalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[013457@$]/g, (c) => LEET[c] || c);
}
const collapse = (w) => w.replace(/([a-z])\1+/g, '$1');

function tokensOf(text) {
  const raw = baseNormalize(text).split(/[^a-z]+/).filter(Boolean).map(collapse);
  // letras soltas em sequência (≥ 3) viram uma palavra: "p u t a" → "puta"
  const out = [];
  let run = [];
  const flush = () => { if (run.length >= 3) out.push(collapse(run.join(''))); run = []; };
  for (const t of raw) {
    if (t.length === 1) run.push(t);
    else { flush(); }
    out.push(t);
  }
  flush();
  return out;
}

// Palavras inteiras (forma original; passam pela mesma normalização)
const WORDS = [
  // palavrões / obscenos
  'porra', 'caralho', 'karalho', 'krl', 'buceta', 'boceta', 'xoxota', 'xota', 'xereca', 'piroca', 'pau no cu',
  'cu', 'cuzao', 'cuzinho', 'cusao', 'foder', 'foda', 'fodase', 'fodasse', 'fodido', 'fodida', 'fudido', 'fudida', 'fuder',
  'merda', 'bosta', 'puta', 'puto', 'putinha', 'putaria', 'puteiro', 'fdp', 'pqp', 'vsf', 'tnc', 'vtnc', 'vtmnc',
  'filhodaputa', 'fiadaputa', 'vaisefuder', 'vaitomarnocu',
  'punheta', 'punheteiro', 'siririca', 'cacete', 'caceta', 'rapariga', 'quenga', 'vadia', 'vagabunda', 'vagabundo',
  'arrombado', 'arrombada', 'escroto', 'escrota', 'babaca', 'otario', 'otaria', 'corno', 'cornudo', 'chifrudo',
  'desgracado', 'desgracada', 'safado', 'safada', 'porno', 'pornografia', 'nudes', 'xvideos',
  // discriminação / ódio
  'viado', 'viadinho', 'bicha', 'bichinha', 'boiola', 'baitola', 'sapatao', 'sapatona', 'traveco', 'travecao',
  'crioulo', 'retardado', 'retardada', 'mongoloide', 'aleijado', 'debiloide',
  'nazista', 'nazismo', 'hitler', 'heil', 'suastica', 'kukluxklan', 'paraibada', 'baianada', 'nordestinada',
  // golpe / spam
  'pix gratis', 'ganhe dinheiro',
];
// Raízes FORTES: pegam variação dentro da MESMA palavra (caralhinho, bucetuda, punhetao...).
const ROOTS = ['caralh', 'bucet', 'bocet', 'xoxot', 'punhet', 'piroc', 'putari', 'arromb', 'fodend', 'fudend', 'viadinh', 'viadag', 'sapatao', 'travec', 'nazist', 'hitler'];
// Expressão: sequência de palavras (já normalizadas) que só ofende junta.
const PHRASES = WORDS.filter((w) => /\s/.test(w)).map((w) => tokensOf(w));
const SINGLE = new Set(WORDS.filter((w) => !/\s/.test(w)).map((w) => tokensOf(w).join('')));
const ROOTS_N = ROOTS.map((r) => collapse(baseNormalize(r)));
// Só ofendem em contexto: valem em texto livre (aviso), não em NOME próprio (time/jogador).
const SOFT = new Set(['safado', 'safada'].map((w) => collapse(baseNormalize(w))));

function plainForms(tok) {
  const f = [tok];
  if (tok.length > 3 && tok.endsWith('s')) f.push(tok.slice(0, -1));
  if (tok.length > 4 && tok.endsWith('es')) f.push(tok.slice(0, -2));
  return f;
}

// Acha a 1ª palavra ofensiva (uso interno — NUNCA devolver ao cliente).
function findOffense(text, { kind = 'name' } = {}) {
  const toks = tokensOf(text);
  if (!toks.length) return null;
  for (const t of toks) {
    for (const f of plainForms(t)) {
      if (SINGLE.has(f) && !(kind === 'name' && SOFT.has(f))) return f;
    }
    if (t.length >= 5 && ROOTS_N.some((r) => t.startsWith(r))) return t;
  }
  // expressões (sequência exata de palavras)
  for (const p of PHRASES) {
    if (kind === 'name' && p.every((x) => SOFT.has(x))) continue;
    for (let i = 0; i + p.length <= toks.length; i++) {
      if (p.every((x, j) => toks[i + j] === x)) return p.join(' ');
    }
  }
  return null;
}

function isOffensive(text, opts) { return !!findOffense(text, opts); }

const LABEL = {
  tournament: 'O nome do torneio', category: 'O nome da categoria', team: 'O nome do time', club: 'O nome do clube',
  player: 'O nome do jogador', post: 'O texto do aviso', handle: 'O @ escolhido', name: 'O nome', pickup: 'O nome do jogador do racha', text: 'O texto',
};
function blockMessage(field) {
  return `${LABEL[field] || 'O texto'} tem palavra ofensiva ou imprópria. Troque e tente de novo.`;
}

class ContentBlockedError extends Error {
  constructor(field) { super(blockMessage(field)); this.status = 400; this.code = 'CONTENT_BLOCKED'; this.field = field; }
}

// Confere vários campos de uma vez: [{ field:'team', value:'...', kind? }]. Lança ContentBlockedError.
function assertClean(items) {
  for (const it of [].concat(items || [])) {
    if (!it || it.value == null || it.value === '') continue;
    const kind = it.kind || (it.field === 'post' || it.field === 'text' ? 'text' : 'name');
    const vals = Array.isArray(it.value) ? it.value : [it.value];
    for (const v of vals) if (module.exports.findOffense(String(v), { kind })) throw new ContentBlockedError(it.field); // via exports: teste de sabotagem
  }
}

// Versão para rota: responde 400 JSON e devolve false se bloqueou.
function guard(res, items) {
  try { assertClean(items); return true; } catch (e) {
    if (e instanceof ContentBlockedError) { res.status(400).json({ error: e.message, code: e.code, field: e.field }); return false; }
    throw e;
  }
}

module.exports = { findOffense, isOffensive, assertClean, guard, blockMessage, ContentBlockedError, tokensOf, _WORDS: WORDS, _ROOTS: ROOTS };
