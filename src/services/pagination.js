// =====================================================================
// Liga Aberta F5 — paginação por CURSOR (limit + cursor → nextCursor).
// ---------------------------------------------------------------------
// Regras:
//  - Sem ?limit e sem ?cursor → a rota mantém a resposta ANTIGA (lista inteira),
//    a não ser que o total passe do teto seguro da rota: aí devolve a 1ª página
//    com nextCursor (o front segue o cursor). Assim o Master Cup e o front atual
//    continuam iguais.
//  - Cursor = base64url de JSON. Nunca é offset: é a CHAVE da última linha
//    (keyset), então inserir/apagar no meio não duplica nem pula item.
//  - Banco: keysetWhere() monta o "depois deste item" na ordem da consulta
//    (com id como desempate final). Campo que pode ser nulo = NULLS LAST.
//  - Lista calculada em memória (rankings): pageArray() acha a posição da
//    chave da última linha e corta depois dela.
// =====================================================================

class PageError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function decodeCursor(str) {
  if (str == null || str === '') return null;
  const s = String(str);
  if (s.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(s)) throw new PageError('cursor inválido');
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (!v || typeof v !== 'object') throw new Error('x');
    return v;
  } catch (_) {
    throw new PageError('cursor inválido');
  }
}

/**
 * Lê ?limit e ?cursor.
 * opts.defaultLimit  tamanho da página quando só veio o cursor
 * opts.maxLimit      teto de ?limit
 * Retorna { paged, limit, cursor } — paged=false quando não veio nem limit nem cursor.
 */
function parsePage(query = {}, opts = {}) {
  const def = opts.defaultLimit || 20;
  const max = opts.maxLimit || 100;
  const hasLimit = query.limit != null && query.limit !== '';
  const hasCursor = query.cursor != null && query.cursor !== '';
  let limit = def;
  if (hasLimit) {
    // limit estranho (0, "abc") cai no padrão, como as rotas faziam antes da paginação
    const n = Math.floor(Number(query.limit));
    limit = Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
  }
  return { paged: hasLimit || hasCursor, limit, cursor: hasCursor ? decodeCursor(query.cursor) : null };
}

// ---------------------------------------------------------------- banco (keyset)
// spec: [{ field, dir: 'asc'|'desc', nullable?: bool, type?: 'date'|'number'|'string'|'bool' }]
// O ÚLTIMO campo tem que ser único (id).
function valueOut(v) {
  if (v instanceof Date) return { d: v.toISOString() };
  return v === undefined ? null : v;
}
function valueIn(v, type) {
  if (v && typeof v === 'object' && typeof v.d === 'string') {
    const d = new Date(v.d);
    if (Number.isNaN(d.getTime())) throw new PageError('cursor inválido');
    return d;
  }
  if (type === 'date' && v != null) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new PageError('cursor inválido');
    return d;
  }
  return v;
}

/** Cursor da linha (guarda só os campos da ordenação). */
function cursorOf(row, spec) {
  return encodeCursor({ k: spec.map((s) => valueOut(row[s.field])) });
}

/** orderBy do Prisma coerente com o keyset (nulos por último). */
function orderByOf(spec) {
  return spec.map((s) => (s.nullable ? { [s.field]: { sort: s.dir, nulls: 'last' } } : { [s.field]: s.dir }));
}

/** where "depois do cursor" na ordem do spec. */
function keysetWhere(spec, cursor) {
  if (!cursor) return null;
  const vals = cursor.k;
  if (!Array.isArray(vals) || vals.length !== spec.length) throw new PageError('cursor inválido');
  const v = vals.map((x, i) => valueIn(x, spec[i].type));
  for (let i = 0; i < spec.length; i++) {
    const t = spec[i].type;
    const x = v[i];
    if (x === null && !spec[i].nullable) throw new PageError('cursor inválido');
    // tipo de cada campo conferido aqui: cursor adulterado = 400, nunca 500 no Prisma
    if (x === null) continue;
    if (t === 'number' && (typeof x !== 'number' || !Number.isFinite(x))) throw new PageError('cursor inválido');
    if (t === 'bool' && typeof x !== 'boolean') throw new PageError('cursor inválido');
    if (t === 'date' && !(x instanceof Date)) throw new PageError('cursor inválido');
    if ((t === 'string' || !t) && (typeof x !== 'string' || x.length > 300)) throw new PageError('cursor inválido');
  }
  const ors = [];
  for (let i = 0; i < spec.length; i++) {
    const eqs = [];
    for (let j = 0; j < i; j++) eqs.push({ [spec[j].field]: v[j] === null ? null : v[j] });
    const s = spec[i];
    const x = v[i];
    let after;
    if (x === null) {
      after = null; // NULLS LAST: nada vem "depois" de um nulo neste nível
    } else if (s.type === 'bool' || typeof x === 'boolean') {
      // false < true
      if (s.dir === 'desc') after = x === true ? { [s.field]: false } : null;
      else after = x === false ? { [s.field]: true } : null;
      if (after && s.nullable) after = { OR: [after, { [s.field]: null }] };
      else if (!after && s.nullable) after = { [s.field]: null };
    } else {
      const cmp = s.dir === 'desc' ? { lt: x } : { gt: x };
      after = s.nullable ? { OR: [{ [s.field]: cmp }, { [s.field]: null }] } : { [s.field]: cmp };
    }
    if (after) ors.push(eqs.length ? { AND: [...eqs, after] } : after);
  }
  return ors.length ? { OR: ors } : { id: '__nada__' };
}

/**
 * Busca uma página no banco.
 * delegate: prisma.<model>; args: { where, select|include }; spec: ordem (último = id).
 */
async function findPage(delegate, args, spec, page) {
  const after = module.exports.keysetWhere(spec, page.cursor); // via exports (prova de sabotagem do teste)
  const where = after ? { AND: [args.where || {}, after] } : (args.where || {});
  const rows = await delegate.findMany({ ...args, where, orderBy: orderByOf(spec), take: page.limit + 1 });
  const more = rows.length > page.limit;
  const items = more ? rows.slice(0, page.limit) : rows;
  return { items, nextCursor: more ? cursorOf(items[items.length - 1], spec) : null };
}

// ---------------------------------------------------------------- memória
/**
 * Corta uma lista JÁ ORDENADA (determinística).
 * keyOf(item) = chave única e estável do item (ex.: id do atleta).
 * Cursor = { a: chave do último item, i: posição } — se a chave sumiu (lista mudou),
 * usa a posição como reserva.
 */
function pageArray(list, page, keyOf) {
  let start = 0;
  if (page.cursor) {
    const c = page.cursor;
    if (typeof c.a !== 'string' && typeof c.a !== 'number') throw new PageError('cursor inválido');
    const idx = list.findIndex((x) => String(keyOf(x)) === String(c.a));
    if (idx >= 0) start = idx + 1;
    else {
      const i = Math.floor(Number(c.i));
      if (!Number.isFinite(i) || i < 0) throw new PageError('cursor inválido');
      start = Math.min(i + 1, list.length);
    }
  }
  const items = list.slice(start, start + page.limit);
  const more = start + page.limit < list.length;
  const last = items[items.length - 1];
  return { items, start, nextCursor: more && last ? encodeCursor({ a: String(keyOf(last)), i: start + items.length - 1 }) : null };
}

function sendPageError(res, e) {
  if (e instanceof PageError) { res.status(400).json({ error: e.message }); return true; }
  return false;
}

// Ordens usadas pelas rotas (o último campo é sempre o id — desempate único).
const POST_SPEC = Object.freeze([{ field: 'pinned', dir: 'desc', type: 'bool' }, { field: 'createdAt', dir: 'desc', type: 'date' }, { field: 'id', dir: 'desc', type: 'string' }]);
const MATCH_SPEC = Object.freeze([{ field: 'round', dir: 'asc', type: 'number' }, { field: 'ordering', dir: 'asc', type: 'number' }, { field: 'id', dir: 'asc', type: 'string' }]);
const VITRINE_SPEC = Object.freeze([{ field: 'status', dir: 'asc', type: 'string' }, { field: 'startDate', dir: 'desc', type: 'date', nullable: true }, { field: 'id', dir: 'desc', type: 'string' }]);

module.exports = { POST_SPEC, MATCH_SPEC, VITRINE_SPEC, PageError, encodeCursor, decodeCursor, parsePage, cursorOf, orderByOf, keysetWhere, findPage, pageArray, sendPageError };
