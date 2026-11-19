// =====================================================================
// APEX — ARTES AUTOMÁTICAS dos torneios (PNG server-side)
// ---------------------------------------------------------------------
// satori (layout → SVG) + @resvg/resvg-js (SVG → PNG). Sem navegador,
// sem API paga. Fonte da marca: Barlow Condensed (OFL, src/assets/fonts).
// Marca: preto + laranja #E5571E + branco · logo do Club no rodapé.
//
// Tipos: resultado · proximo · agenda · classificacao · artilharia ·
//        campeao · atleta · torneio (capa / og:image)
// Formatos: story 1080×1920 · feed 1080×1350 · quadrado 1080×1080 · og 1200×630
//
// Cache em memória por hash dos DADOS (mudou placar → hash novo → arte nova).
// Regras de arte (constituição de publicações): nada de "imagem ilustrativa",
// foto real quando existe (escudo/foto do atleta), sem emoji na arte.
// =====================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { prisma } = require('../middleware');
const { publicDomain } = require('../config/publicUrl');
const gameRules = require('./tournamentRules');

const ORANGE = '#E5571E';
const BLACK = '#0B0B0D';
const PANEL = '#17171C';
const PANEL2 = '#202027';
const MUTED = '#A1A1AA';
const WHITE = '#FFFFFF';

const FORMATS = {
  story: { w: 1080, h: 1920, s: 1, rows: { agenda: 8, table: 12, scorers: 10, scorersList: 6 } },
  feed: { w: 1080, h: 1350, s: 0.9, rows: { agenda: 6, table: 8, scorers: 7, scorersList: 3 } },
  quadrado: { w: 1080, h: 1080, s: 0.8, rows: { agenda: 4, table: 6, scorers: 5, scorersList: 2 } },
  og: { w: 1200, h: 630, s: 0.55, rows: { agenda: 3, table: 4, scorers: 4, scorersList: 0 } },
};
const TYPES = ['resultado', 'proximo', 'agenda', 'classificacao', 'artilharia', 'campeao', 'atleta', 'torneio'];

const SPORT_LABEL = {
  TENNIS: 'Tênis', BEACH_TENNIS: 'Beach Tennis', PADEL: 'Padel', FUTSAL: 'Futsal', SOCCER: 'Futebol',
  VOLLEY: 'Vôlei', BASKETBALL: 'Basquete', HANDBALL: 'Handebol', TABLE_TENNIS: 'Tênis de Mesa', OTHER: 'Esporte',
};
const STAGE_LABEL = {
  FINAL: 'Final', SEMI: 'Semifinal', THIRD: 'Disputa de 3º lugar', QUARTER: 'Quartas de final',
  RO16: 'Oitavas de final', RO32: '16-avos de final', RO64: '32-avos de final',
};
const TZ = 'America/Fortaleza';

// --------------------------------------------------------------------
// Fontes, logo e motor (lazy)
// --------------------------------------------------------------------
const FONT_DIR = path.join(__dirname, '../assets/fonts');
let FONTS = null;
function fonts() {
  if (FONTS) return FONTS;
  const f = (file) => fs.readFileSync(path.join(FONT_DIR, file));
  FONTS = [
    { name: 'Barlow', data: f('BarlowCondensed-SemiBold.ttf'), weight: 600, style: 'normal' },
    { name: 'Barlow', data: f('BarlowCondensed-Bold.ttf'), weight: 700, style: 'normal' },
    { name: 'Barlow', data: f('BarlowCondensed-ExtraBoldItalic.ttf'), weight: 800, style: 'italic' },
    { name: 'Barlow', data: f('BarlowCondensed-BlackItalic.ttf'), weight: 900, style: 'italic' },
  ];
  return FONTS;
}

let satoriFn = null;
async function getSatori() {
  if (satoriFn) return satoriFn;
  // satori tem build dual; import() dinâmico funciona em CommonJS e no ESM puro.
  const mod = await import('satori');
  satoriFn = mod.default || mod;
  return satoriFn;
}
let ResvgCls = null;
function getResvg() {
  if (!ResvgCls) ResvgCls = require('@resvg/resvg-js').Resvg;
  return ResvgCls;
}

let CLUB_LOGO = null; // data URI PNG (branco)
function clubLogo() {
  if (CLUB_LOGO) return CLUB_LOGO;
  try {
    const svg = fs.readFileSync(path.join(__dirname, '../../public/brand/club-sports-tennis.svg'), 'utf8');
    const Resvg = getResvg();
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 620 }, background: 'rgba(0,0,0,0)' }).render().asPng();
    CLUB_LOGO = 'data:image/png;base64,' + Buffer.from(png).toString('base64');
  } catch (e) {
    console.error('[tournamentArt] logo do Club:', e.message);
    CLUB_LOGO = '';
  }
  return CLUB_LOGO;
}
const CLUB_LOGO_RATIO = 931 / 303;

// --------------------------------------------------------------------
// Imagens externas (escudo, foto, patrocinador) → PNG data URI normalizado
// --------------------------------------------------------------------
const IMG_CACHE = new Map(); // key -> data URI | '' (falhou)
const IMG_MAX = 400;
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  return !h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '0.0.0.0' || h.startsWith('[');
}
async function loadImage(src, box = 256, cover = false) {
  if (!src || typeof src !== 'string') return '';
  const key = (src.length > 200 ? crypto.createHash('sha1').update(src).digest('hex') : src) + '|' + box + (cover ? 'c' : '');
  if (IMG_CACHE.has(key)) return IMG_CACHE.get(key);
  let out = '';
  try {
    let buf = null;
    const m = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(src);
    if (m) buf = Buffer.from(m[1], 'base64');
    else if (/^\/media\//.test(src)) buf = await require('./mediaStore').bytesOf(src); // Liga F5: imagem guardada por conteúdo
    else if (/^https?:\/\//i.test(src)) {
      const u = new URL(src);
      if (!isPrivateHost(u.hostname)) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        try {
          const r = await fetch(u, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'ClubArte/1.0' } });
          const len = Number(r.headers.get('content-length') || 0);
          if (r.ok && (!len || len < 6 * 1024 * 1024)) {
            const ab = await r.arrayBuffer();
            if (ab.byteLength < 6 * 1024 * 1024) buf = Buffer.from(ab);
          }
        } finally { clearTimeout(timer); }
      }
    }
    if (buf && buf.length) {
      const sharp = require('sharp');
      const png = await sharp(buf, { density: 200 })
        .resize(box, box, { fit: cover ? 'cover' : 'inside', withoutEnlargement: false })
        .png()
        .toBuffer();
      out = 'data:image/png;base64,' + png.toString('base64');
    }
  } catch (_) {
    out = '';
  }
  if (IMG_CACHE.size >= IMG_MAX) IMG_CACHE.delete(IMG_CACHE.keys().next().value);
  IMG_CACHE.set(key, out);
  return out;
}

// --------------------------------------------------------------------
// Mini "JSX" pro satori
// --------------------------------------------------------------------
const flat = (arr) => arr.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== '');
function div(style, ...children) {
  const kids = flat(children);
  return { type: 'div', props: { style: { display: 'flex', ...style }, children: kids.length === 1 ? kids[0] : kids } };
}
function text(style, value) {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children: String(value == null ? '' : value) } };
}
function img(src, w, h, style = {}) {
  return { type: 'img', props: { src, width: Math.round(w), height: Math.round(h), style: { width: Math.round(w), height: Math.round(h), objectFit: 'contain', ...style } } };
}
const up = (s) => String(s == null ? '' : s).toLocaleUpperCase('pt-BR');
const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const px = (v, fmt) => Math.round(v * fmt.s);
function hue(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
function initials(name) {
  const p = String(name || '?').replace(/[^0-9A-Za-zÀ-ÿ ]/g, ' ').trim().split(/\s+/);
  return up(((p[0] || '?')[0] || '?') + ((p[1] || '')[0] || '')) || '?';
}
const H = { fontFamily: 'Barlow', fontWeight: 900, fontStyle: 'italic' }; // títulos
const B = { fontFamily: 'Barlow', fontWeight: 700 }; // corpo forte
const R = { fontFamily: 'Barlow', fontWeight: 600 }; // corpo

function crest(entry, size) {
  if (entry && entry.logo) {
    return div({ width: size, height: size, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }, img(entry.logo, size, size));
  }
  const name = entry ? entry.name : '?';
  // Liga F2/F4: time com clube e sem escudo usa as CORES do clube no selo
  const pc = entry && HEX.test(entry.primaryColor || '') ? entry.primaryColor : '';
  const sc = entry && HEX.test(entry.secondaryColor || '') ? entry.secondaryColor : WHITE;
  return div(
    {
      width: size, height: size, borderRadius: Math.round(size * 0.24), flexShrink: 0,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: pc || (entry ? `hsl(${hue(name)}, 45%, 32%)` : PANEL2),
      border: `${Math.max(2, Math.round(size * 0.025))}px solid rgba(255,255,255,0.18)`,
    },
    text({ ...H, color: pc ? sc : WHITE, fontSize: Math.round(size * 0.4) }, entry ? initials(name) : '?')
  );
}
const HEX = /^#[0-9A-Fa-f]{6}$/;

function fmtWhen(d, opts) {
  try {
    return new Date(d).toLocaleString('pt-BR', { timeZone: TZ, ...opts });
  } catch (_) { return ''; }
}
function stageText(m) {
  if (!m) return '';
  if (m.stage === 'GROUP') return `Grupo ${m.groupName || '?'} · Rodada ${m.round}`;
  if (m.stage === 'LEAGUE') return `Rodada ${m.round}`;
  return STAGE_LABEL[m.stage] || m.stage || '';
}

// --------------------------------------------------------------------
// Moldura comum: faixas laranja, cabeçalho do torneio, patrocínio e rodapé
// --------------------------------------------------------------------
function frame(fmt, d, head, content) {
  const P = fmt === FORMATS.og ? 44 : px(70, fmt);
  const isOg = fmt === FORMATS.og;
  // faixas laranja só no canto superior direito (o cabeçalho para antes delas) + brilho laranja no rodapé
  const k = isOg ? 0.7 : fmt.s;
  const decor = [
    div({ position: 'absolute', top: Math.round(-70 * k), right: Math.round(-130 * k), width: Math.round(420 * k), height: Math.round(78 * k), backgroundColor: ORANGE, transform: 'rotate(-32deg)' }),
    div({ position: 'absolute', top: Math.round(40 * k), right: Math.round(-150 * k), width: Math.round(420 * k), height: Math.round(20 * k), backgroundColor: ORANGE, opacity: 0.6, transform: 'rotate(-32deg)' }),
    div({ position: 'absolute', bottom: -fmt.h * 0.25, right: -fmt.w * 0.3, width: fmt.w * 1.0, height: fmt.h * 0.55, backgroundImage: 'radial-gradient(circle at 50% 50%, rgba(229,87,30,0.22) 0%, rgba(229,87,30,0) 65%)' }),
  ];
  const tLogo = d.tournamentLogo ? img(d.tournamentLogo, px(isOg ? 150 : 130, fmt), px(isOg ? 150 : 130, fmt)) : null;
  const header = div(
    { position: 'relative', alignItems: 'center', gap: px(28, fmt), maxWidth: fmt.w - P * 2 - Math.round(200 * k) },
    tLogo,
    div(
      { flexDirection: 'column', flexShrink: 1 },
      head.eyebrow ? text({ ...B, color: ORANGE, fontSize: px(isOg ? 44 : 38, fmt), letterSpacing: 2 }, up(head.eyebrow)) : null,
      text({ ...H, color: WHITE, fontSize: px(isOg ? 92 : 78, fmt), lineHeight: 1, marginTop: px(4, fmt) }, up(cut(head.title || d.tournamentName, 46))),
      head.subtitle ? text({ ...R, color: MUTED, fontSize: px(isOg ? 44 : 36, fmt), marginTop: px(8, fmt) }, cut(head.subtitle, 70)) : null
    )
  );
  const sponsors = (d.sponsors || []).slice(0, isOg ? 4 : 6);
  const sponsorRow = sponsors.length && !head.noSponsors
    ? div(
        { flexDirection: 'column', gap: px(14, fmt), marginTop: px(24, fmt) },
        text({ ...B, color: MUTED, fontSize: px(26, fmt), letterSpacing: 3 }, 'PATROCÍNIO'),
        div(
          { alignItems: 'center', gap: px(22, fmt), flexWrap: 'wrap' },
          sponsors.map((sp) =>
            div(
              { height: px(96, fmt), minWidth: px(150, fmt), paddingLeft: px(18, fmt), paddingRight: px(18, fmt), borderRadius: px(16, fmt), backgroundColor: WHITE, alignItems: 'center', justifyContent: 'center' },
              sp.logo ? img(sp.logo, px(170, fmt), px(70, fmt)) : text({ ...H, color: BLACK, fontSize: px(34, fmt) }, up(cut(sp.name, 26)))
            )
          )
        )
      )
    : null;
  const logo = clubLogo();
  const footer = div(
    { position: 'relative', flexShrink: 0, alignItems: 'center', justifyContent: 'space-between', marginTop: px(26, fmt), paddingTop: px(22, fmt), borderTop: `${Math.max(2, px(3, fmt))}px solid rgba(255,255,255,0.14)` },
    logo ? img(logo, px(isOg ? 300 : 280, fmt), px(isOg ? 300 : 280, fmt) / CLUB_LOGO_RATIO) : text({ ...H, color: WHITE, fontSize: px(40, fmt) }, 'CLUB SPORTS & TENNIS'),
    text({ ...B, color: WHITE, fontSize: px(isOg ? 40 : 32, fmt), opacity: 0.85 }, d.url || '')
  );
  return div(
    {
      // border-box: o padding fica DENTRO dos 1080 px (no satori o padrão estoura a largura)
      width: fmt.w, height: fmt.h, boxSizing: 'border-box', position: 'relative', overflow: 'hidden', flexDirection: 'column',
      backgroundColor: BLACK, backgroundImage: 'linear-gradient(165deg, #1A1A20 0%, #0B0B0D 55%, #0B0B0D 100%)',
      padding: P, fontFamily: 'Barlow', color: WHITE,
    },
    decor,
    header,
    div({ position: 'relative', flexGrow: 1, flexShrink: 1, flexDirection: 'column', marginTop: px(isOg ? 18 : 40, fmt), minHeight: 0, overflow: 'hidden' }, content),
    sponsorRow ? div({ position: 'relative', flexShrink: 0 }, sponsorRow) : null,
    footer
  );
}

// --------------------------------------------------------------------
// Templates
// --------------------------------------------------------------------
function tplResultado(fmt, d) {
  const m = d.match;
  const isOg = fmt === FORMATS.og;
  const done = m.status === 'FINISHED' || m.status === 'WALKOVER';
  const liveNow = m.status === 'LIVE';
  if (!done && !liveNow) return tplProximo(fmt, d);
  const hs = done ? m.homeScore : m.liveScore.home;
  const as = done ? m.awayScore : m.liveScore.away;
  const crestSize = isOg ? 170 : px(250, fmt);
  const side = (entry, win) =>
    div(
      { flexDirection: 'column', alignItems: 'center', width: isOg ? 300 : px(330, fmt), gap: px(22, fmt) },
      crest(entry, crestSize),
      text({ ...H, fontWeight: 800, color: win ? WHITE : '#D4D4D8', fontSize: isOg ? 40 : px(56, fmt), lineHeight: 1.05, textAlign: 'center', justifyContent: 'center' }, up(cut(entry ? entry.name : 'A definir', 28)))
    );
  const hw = m.winnerEntryId && m.homeEntry && m.winnerEntryId === m.homeEntry.id;
  const aw = m.winnerEntryId && m.awayEntry && m.winnerEntryId === m.awayEntry.id;
  // placar de 2 dígitos (futsal 12×10) encolhe pra não encostar nos escudos
  const digits = String(hs == null ? '-' : hs).length + String(as == null ? '-' : as).length;
  const scF = digits >= 4 ? 0.66 : digits === 3 ? 0.8 : 1;
  const score = div(
    { alignItems: 'center', gap: px(14, fmt), marginTop: isOg ? 0 : -px(60, fmt), flexShrink: 0 },
    text({ ...H, fontSize: Math.round((isOg ? 170 : px(240, fmt)) * scF), lineHeight: 1, color: hw ? ORANGE : WHITE }, hs == null ? '-' : hs),
    text({ ...H, fontSize: Math.round((isOg ? 70 : px(100, fmt)) * scF), color: MUTED }, '×'),
    text({ ...H, fontSize: Math.round((isOg ? 170 : px(240, fmt)) * scF), lineHeight: 1, color: aw ? ORANGE : WHITE }, as == null ? '-' : as)
  );
  const pill = div(
    { alignSelf: 'center', backgroundColor: liveNow ? '#DC2626' : ORANGE, paddingLeft: px(30, fmt), paddingRight: px(30, fmt), paddingTop: px(8, fmt), paddingBottom: px(8, fmt), borderRadius: px(14, fmt), transform: 'skewX(-10deg)' },
    text({ ...H, color: WHITE, fontSize: isOg ? 40 : px(48, fmt), letterSpacing: 2 }, liveNow ? 'AO VIVO' : m.status === 'WALKOVER' ? 'W.O.' : 'FIM DE JOGO')
  );
  const pen = m.decidedByPenalties && m.homePenalties != null
    ? text({ ...B, color: WHITE, fontSize: px(isOg ? 60 : 44, fmt), alignSelf: 'center', marginTop: px(18, fmt) }, `Pênaltis ${m.homePenalties} × ${m.awayPenalties}`)
    : null;
  // artilheiros do jogo (lance a lance)
  const maxList = fmt.rows.scorersList;
  // Liga F4: lance que marca ponto pela regra da categoria (futsal: gol; basquete: cestas
  // de 1/2/3 com o valor; vôlei: set é do time → sem lista de autores)
  const scoring = m.scoring || { GOAL: 1 };
  const unit = m.unit || { one: 'gol', many: 'gols', short: 'GOLS' };
  const goals = unit.short === 'SETS' ? [] : (m.timeline || []).filter((t) => scoring[t.type]);
  const listSide = (sideKey) => {
    const g = goals.filter((x) => x.side === sideKey);
    const rows = g.slice(0, maxList).map((x) =>
      div({ alignItems: 'center', gap: px(12, fmt), justifyContent: sideKey === 'home' ? 'flex-start' : 'flex-end' },
        div({ width: px(16, fmt), height: px(16, fmt), borderRadius: 999, backgroundColor: ORANGE }),
        text({ ...B, color: WHITE, fontSize: px(36, fmt) }, cut(x.player || (unit.short === 'GOLS' ? 'Gol' : 'Cesta'), 22) + (unit.short === 'PTS' ? `  +${scoring[x.type]}` : '') + (x.minute != null ? `  ${x.minute}'` : ''))
      )
    );
    if (g.length > maxList) rows.push(text({ ...R, color: MUTED, fontSize: px(30, fmt) }, unit.short === 'PTS' ? `+${g.length - maxList} cesta(s)` : `+${g.length - maxList} gol(s)`));
    return div({ flexDirection: 'column', gap: px(10, fmt), width: '48%', alignItems: sideKey === 'home' ? 'flex-start' : 'flex-end' }, rows);
  };
  const scorers = maxList && goals.length
    ? div({ justifyContent: 'space-between', marginTop: px(40, fmt), padding: px(30, fmt), backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: px(24, fmt) }, listSide('home'), listSide('away'))
    : null;
  const where = [m.scheduledAt ? fmtWhen(m.scheduledAt, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '', m.location || ''].filter(Boolean).join('  ·  ');
  return frame(fmt, d, { eyebrow: [d.categoryName, stageText(m)].filter(Boolean).join(' · '), title: d.tournamentName }, [
    div({ flexGrow: 1, flexDirection: 'column', justifyContent: 'center' },
      isOg ? null : pill,
      div({ alignItems: 'center', justifyContent: 'space-between', marginTop: isOg ? 0 : px(50, fmt) }, side(m.homeEntry, hw), score, side(m.awayEntry, aw)),
      pen,
      scorers,
      where && !isOg ? text({ ...R, color: MUTED, fontSize: px(34, fmt), alignSelf: 'center', marginTop: px(34, fmt) }, where) : null
    ),
  ]);
}

function tplProximo(fmt, d) {
  const m = d.match;
  const isOg = fmt === FORMATS.og;
  const crestSize = isOg ? 170 : px(240, fmt);
  const side = (entry, label) =>
    div({ flexDirection: 'column', alignItems: 'center', width: isOg ? 320 : px(360, fmt), gap: px(22, fmt) },
      crest(entry, crestSize),
      text({ ...H, fontWeight: 800, color: WHITE, fontSize: isOg ? 40 : px(56, fmt), lineHeight: 1.05, textAlign: 'center', justifyContent: 'center' }, up(cut(entry ? entry.name : label || 'A definir', 28))));
  const when = m.scheduledAt ? fmtWhen(m.scheduledAt, { weekday: 'long', day: '2-digit', month: '2-digit' }) : 'Data a definir';
  const hour = m.scheduledAt ? fmtWhen(m.scheduledAt, { hour: '2-digit', minute: '2-digit' }) : '';
  return frame(fmt, d, { eyebrow: 'Próximo jogo', title: d.tournamentName, subtitle: [d.categoryName, stageText(m)].filter(Boolean).join(' · ') }, [
    div({ flexGrow: 1, flexDirection: 'column', justifyContent: 'center' },
      div({ alignItems: 'center', justifyContent: 'space-between' },
        side(m.homeEntry, m.homeSourceLabel),
        text({ ...H, fontSize: isOg ? 90 : px(130, fmt), color: ORANGE }, 'VS'),
        side(m.awayEntry, m.awaySourceLabel)),
      div({ flexDirection: 'column', alignItems: 'center', marginTop: px(isOg ? 20 : 60, fmt), padding: px(34, fmt), backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: px(26, fmt), borderLeft: `${px(12, fmt)}px solid ${ORANGE}` },
        text({ ...H, fontSize: isOg ? 56 : px(88, fmt), color: WHITE, lineHeight: 1 }, up(when) + (hour ? '  ' + hour : '')),
        m.location ? text({ ...B, fontSize: isOg ? 36 : px(44, fmt), color: MUTED, marginTop: px(12, fmt) }, up(cut(m.location, 40))) : null)
    ),
  ]);
}

function tplAgenda(fmt, d) {
  const rows = d.matches.slice(0, fmt.rows.agenda);
  const crestSize = px(84, fmt);
  const line = (m) =>
    div({ alignItems: 'center', gap: px(22, fmt), padding: px(20, fmt), backgroundColor: PANEL, borderRadius: px(22, fmt), marginBottom: px(16, fmt), borderLeft: `${px(10, fmt)}px solid ${m.status === 'LIVE' ? '#DC2626' : ORANGE}` },
      div({ flexDirection: 'column', alignItems: 'center', width: px(150, fmt) },
        text({ ...H, fontSize: px(58, fmt), color: m.status === 'LIVE' ? '#F87171' : WHITE, lineHeight: 1 }, m.status === 'LIVE' ? 'AO VIVO' : m.scheduledAt ? fmtWhen(m.scheduledAt, { hour: '2-digit', minute: '2-digit' }) : '--:--'),
        d.multiDay && m.scheduledAt ? text({ ...R, fontSize: px(26, fmt), color: MUTED }, fmtWhen(m.scheduledAt, { day: '2-digit', month: '2-digit' })) : null),
      div({ flexGrow: 1, flexDirection: 'column', gap: px(8, fmt) },
        div({ alignItems: 'center', gap: px(14, fmt) },
          crest(m.homeEntry, crestSize),
          text({ ...H, fontWeight: 800, fontSize: px(44, fmt), color: WHITE }, up(cut(m.homeEntry ? m.homeEntry.name : m.homeSourceLabel || 'A definir', 22))),
          text({ ...H, fontSize: px(40, fmt), color: ORANGE }, '×'),
          text({ ...H, fontWeight: 800, fontSize: px(44, fmt), color: WHITE }, up(cut(m.awayEntry ? m.awayEntry.name : m.awaySourceLabel || 'A definir', 22))),
          crest(m.awayEntry, crestSize)),
        text({ ...R, fontSize: px(28, fmt), color: MUTED }, [m.categoryName, stageText(m), m.location].filter(Boolean).join('  ·  '))));
  const more = d.matches.length > rows.length ? text({ ...B, color: MUTED, fontSize: px(32, fmt), marginTop: px(6, fmt) }, `+ ${d.matches.length - rows.length} jogo(s) na página do torneio`) : null;
  return frame(fmt, d, { eyebrow: d.agendaTitle, title: d.tournamentName, subtitle: d.agendaSubtitle }, [
    rows.length
      ? div({ flexDirection: 'column' }, rows.map(line), more)
      : div({ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }, text({ ...H, fontSize: px(60, fmt), color: MUTED }, 'SEM JOGOS AGENDADOS')),
  ]);
}

function tplClassificacao(fmt, d) {
  const isOg = fmt === FORMATS.og;
  // poucas linhas → tabela maior (não sobra um vazio enorme no story)
  const totalRows = d.groups.reduce((n, g) => n + g.rows.length + (g.name ? 1.6 : 0) + 0.8, 0);
  const z = isOg ? 1 : Math.max(1, Math.min(1.25, (fmt.rows.table + 3) / Math.max(totalRows, 1)));
  const zh = z; // altura da linha cresce até 25%
  const zp = (v) => Math.round(px(v, fmt) * Math.min(z, 1.08)); // fonte/escudo crescem pouco (nome precisa caber)
  const fs = zp(isOg ? 54 : 42);
  const cols = ['P', 'J', 'V', 'E', 'D', 'SG'];
  const cw = px(isOg ? 88 : 66, fmt); // colunas numéricas não crescem com o zoom (o nome precisa de espaço)
  const q = d.qualify || 2;
  // quantos caracteres cabem no nome (condensada itálica ≈ 0,42 em por letra maiúscula) → corta com "…"
  const P = isOg ? 44 : px(70, fmt);
  const nameW = fmt.w - 2 * P - zp(36) - zp(64) - 6 * cw - zp(isOg ? 66 : 58) - zp(16) - zp(14);
  const maxCh = Math.max(8, Math.floor(nameW / (fs * 0.42)));
  const th = div({ alignItems: 'center', paddingLeft: zp(18), paddingRight: zp(18), marginBottom: zp(10) },
    text({ ...B, color: MUTED, fontSize: zp(28), width: zp(64), flexShrink: 0 }, '#'),
    text({ ...B, color: MUTED, fontSize: zp(28), flexGrow: 1, flexBasis: 0 }, 'EQUIPE'),
    cols.map((c) => text({ ...B, color: c === 'P' ? ORANGE : MUTED, fontSize: zp(28), width: cw, flexShrink: 0, justifyContent: 'center' }, c)));
  const blocks = d.groups.map((g) => {
    const rows = g.rows.map((r, i) =>
      div({ alignItems: 'center', paddingLeft: zp(18), paddingRight: zp(18), height: Math.round(px(isOg ? 92 : 86, fmt) * zh), backgroundColor: i % 2 ? 'rgba(255,255,255,0.03)' : PANEL, borderLeft: `${zp(8)}px solid ${i < q ? ORANGE : 'transparent'}` },
        text({ ...H, fontSize: fs, color: i < q ? ORANGE : WHITE, width: zp(64), flexShrink: 0 }, r.rank || i + 1),
        div({ alignItems: 'center', gap: zp(16), flexGrow: 1, flexBasis: 0, minWidth: 0, overflow: 'hidden', marginRight: zp(14) },
          crest(r.entry, zp(isOg ? 66 : 58)),
          text({ ...H, fontWeight: 800, fontSize: fs, color: WHITE, whiteSpace: 'nowrap' }, up(cut(r.entry.name, maxCh)))),
        [r.points, r.played, r.won, r.drawn, r.lost, r.scoreFor - r.scoreAgainst].map((v, k) =>
          text({ ...(k === 0 ? H : B), fontSize: k === 0 ? fs : zp(isOg ? 46 : 38), color: k === 0 ? WHITE : '#D4D4D8', width: cw, flexShrink: 0, justifyContent: 'center' }, v))));
    return div({ flexDirection: 'column', marginBottom: zp(26) },
      g.name ? text({ ...H, color: ORANGE, fontSize: zp(46), marginBottom: zp(8) }, up('Grupo ' + g.name)) : null,
      th, div({ flexDirection: 'column', borderRadius: zp(18), overflow: 'hidden' }, rows));
  });
  return frame(fmt, d, { eyebrow: 'Classificação', title: d.tournamentName, subtitle: d.categoryName + (d.provisional ? ' · tabela inicial' : '') }, [
    blocks.length
      ? div({ flexDirection: 'column', flexGrow: 1, justifyContent: isOg ? 'flex-start' : 'center' }, blocks)
      : div({ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }, text({ ...H, fontSize: px(60, fmt), color: MUTED }, 'SEM CLASSIFICAÇÃO AINDA')),
  ]);
}

function tplArtilharia(fmt, d) {
  const unitA = d.unit || { one: 'gol', many: 'gols', short: 'GOLS' };
  const rows = d.ranking.slice(0, fmt.rows.scorers);
  const first = rows[0];
  const big = first && fmt !== FORMATS.og
    ? div({ alignItems: 'center', gap: px(30, fmt), padding: px(34, fmt), borderRadius: px(28, fmt), backgroundColor: ORANGE, marginBottom: px(26, fmt) },
        crest(first.entry, px(150, fmt)),
        div({ flexDirection: 'column', flexGrow: 1 },
          text({ ...B, fontSize: px(32, fmt), color: 'rgba(255,255,255,0.85)', letterSpacing: 2 }, unitA.short === 'PTS' ? 'CESTINHA' : 'ARTILHEIRO'),
          text({ ...H, fontSize: px(74, fmt), color: WHITE, lineHeight: 1 }, up(cut((first.number != null ? first.number + ' ' : '') + first.name, 22))),
          text({ ...B, fontSize: px(34, fmt), color: WHITE, opacity: 0.9 }, up(cut(first.team, 30)))),
        div({ flexDirection: 'column', alignItems: 'center' },
          text({ ...H, fontSize: px(150, fmt), color: WHITE, lineHeight: 1 }, first.goals),
          text({ ...B, fontSize: px(30, fmt), color: WHITE }, up(first.goals === 1 ? unitA.one : unitA.many))))
    : null;
  const rest = (big ? rows.slice(1) : rows).map((r, i) => {
    const pos = (big ? i + 2 : i + 1);
    return div({ alignItems: 'center', gap: px(22, fmt), height: px(fmt === FORMATS.og ? 96 : 92, fmt), paddingLeft: px(22, fmt), paddingRight: px(26, fmt), backgroundColor: i % 2 ? 'rgba(255,255,255,0.03)' : PANEL, borderRadius: px(16, fmt), marginBottom: px(10, fmt) },
      text({ ...H, fontSize: px(48, fmt), color: pos <= 3 ? ORANGE : WHITE, width: px(70, fmt) }, pos + 'º'),
      crest(r.entry, px(60, fmt)),
      div({ flexDirection: 'column', flexGrow: 1 },
        text({ ...H, fontWeight: 800, fontSize: px(44, fmt), color: WHITE, lineHeight: 1 }, up(cut((r.number != null ? r.number + ' ' : '') + r.name, 26))),
        text({ ...R, fontSize: px(28, fmt), color: MUTED }, cut(r.team, 34))),
      text({ ...H, fontSize: px(64, fmt), color: WHITE }, r.goals));
  });
  return frame(fmt, d, { eyebrow: unitA.short === 'PTS' ? 'Cestinhas (pontos)' : 'Artilharia', title: d.tournamentName, subtitle: d.categoryName || 'Todas as categorias' }, [
    rows.length ? div({ flexDirection: 'column' }, big, rest) : div({ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }, text({ ...H, fontSize: px(60, fmt), color: MUTED }, 'SEM ' + up(unitA.many) + ' AINDA')),
  ]);
}

function tplCampeao(fmt, d) {
  const isOg = fmt === FORMATS.og;
  if (!d.champion) {
    return frame(fmt, d, { eyebrow: 'Campeão', title: d.tournamentName, subtitle: d.categoryName }, [
      div({ flexGrow: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'column' },
        text({ ...H, fontSize: px(80, fmt), color: WHITE }, 'FINAL AINDA NÃO DISPUTADA'),
        text({ ...B, fontSize: px(40, fmt), color: MUTED, marginTop: px(16, fmt) }, 'A arte do campeão sai quando a final terminar')),
    ]);
  }
  const m = d.final;
  return frame(fmt, d, { eyebrow: d.categoryName, title: d.tournamentName }, [
    div({ flexGrow: 1, flexDirection: isOg ? 'row' : 'column', alignItems: 'center', justifyContent: 'center', gap: px(isOg ? 60 : 20, fmt) },
      div({ flexDirection: 'column', alignItems: 'center' },
        text({ ...H, fontSize: isOg ? 150 : px(210, fmt), color: ORANGE, lineHeight: 0.9, letterSpacing: 2 }, 'CAMPEÃO'),
        isOg ? null : div({ width: px(260, fmt), height: px(14, fmt), backgroundColor: ORANGE, transform: 'skewX(-20deg)', marginTop: px(10, fmt) })),
      div({ flexDirection: 'column', alignItems: 'center', gap: px(26, fmt), marginTop: isOg ? 0 : px(40, fmt) },
        crest(d.champion, isOg ? 200 : px(380, fmt)),
        text({ ...H, fontSize: isOg ? 70 : px(110, fmt), color: WHITE, lineHeight: 1, textAlign: 'center', justifyContent: 'center' }, up(cut(d.champion.name, 24))),
        m && m.homeScore != null && !isOg
          ? text({ ...B, fontSize: px(42, fmt), color: MUTED }, `Final: ${m.homeEntry ? m.homeEntry.name : ''} ${m.homeScore} × ${m.awayScore} ${m.awayEntry ? m.awayEntry.name : ''}` + (m.decidedByPenalties ? ` (pên. ${m.homePenalties}×${m.awayPenalties})` : ''))
          : null,
        d.runnerUp && !isOg ? text({ ...B, fontSize: px(38, fmt), color: MUTED }, 'Vice: ' + d.runnerUp.name) : null)),
  ]);
}

function tplAtleta(fmt, d) {
  const a = d.athlete;
  const isOg = fmt === FORMATS.og;
  const av = isOg ? 300 : px(380, fmt);
  const photo = a.photo
    ? img(a.photo, av, av, { borderRadius: 999, objectFit: 'cover', border: `${px(10, fmt)}px solid ${ORANGE}` })
    : div({ width: av, height: av, borderRadius: 999, backgroundColor: ORANGE, alignItems: 'center', justifyContent: 'center' }, text({ ...H, fontSize: av * 0.4, color: WHITE }, initials(a.name)));
  const cell = (v, l) => div({ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: isOg ? 190 : px(290, fmt), height: isOg ? 130 : px(190, fmt), backgroundColor: PANEL, borderRadius: px(22, fmt), borderBottom: `${px(8, fmt)}px solid ${ORANGE}` },
    text({ ...H, fontSize: isOg ? 64 : px(90, fmt), color: WHITE, lineHeight: 1 }, v),
    text({ ...B, fontSize: isOg ? 24 : px(30, fmt), color: MUTED, letterSpacing: 1 }, up(l)));
  // Liga F5: números pelo esporte principal (raquete: aproveitamento, sem "GOLS")
  const cells = Array.isArray(a.cells) && a.cells.length
    ? a.cells.map((c) => cell(c.value, c.label))
    : [cell(a.matches, 'Jogos'), cell(a.wins, 'Vitórias'), cell(a.goals, 'Gols'), cell(a.assists || 0, 'Assist.'), cell(a.titles || 0, 'Títulos'), cell(a.tournaments, 'Torneios')];
  const idBlock = div({ flexDirection: 'column', alignItems: isOg ? 'flex-start' : 'center' },
    text({ ...H, fontSize: isOg ? 74 : px(100, fmt), color: WHITE, lineHeight: 1, textAlign: 'center' }, up(cut(a.name, 26))),
    a.username ? text({ ...B, fontSize: isOg ? 38 : px(44, fmt), color: ORANGE, marginTop: px(8, fmt) }, '@' + a.username) : null,
    a.rating ? text({ ...B, fontSize: isOg ? 32 : px(36, fmt), color: MUTED, marginTop: px(6, fmt) }, `Rating ${a.rating}${a.ratingSport ? ' · ' + a.ratingSport : ''}`) : null);
  return frame(fmt, d, { eyebrow: 'Card do atleta', title: d.tournamentName || 'Club Sports & Tennis', noSponsors: !d.sponsors || !d.sponsors.length }, [
    isOg
      ? div({ flexGrow: 1, alignItems: 'center', gap: 50 }, photo, div({ flexDirection: 'column', gap: 26 }, idBlock, div({ gap: 18 }, cells.slice(0, 3))))
      : div({ flexGrow: 1, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: px(40, fmt) },
          photo, idBlock,
          div({ flexWrap: 'wrap', gap: px(22, fmt), justifyContent: 'center', width: px(940, fmt) }, cells)),
  ]);
}

function tplTorneio(fmt, d) {
  const t = d.tournament;
  const isOg = fmt === FORMATS.og;
  const chip = (v) => div({ paddingLeft: px(26, fmt), paddingRight: px(26, fmt), paddingTop: px(10, fmt), paddingBottom: px(10, fmt), borderRadius: px(14, fmt), backgroundColor: PANEL2, border: '2px solid rgba(255,255,255,0.12)' },
    text({ ...B, fontSize: isOg ? 34 : px(40, fmt), color: WHITE }, v));
  const chips = [SPORT_LABEL[t.sport] || t.sport, d.dateLine, d.place, `${d.entries} equipes`, `${d.categories} categoria${d.categories === 1 ? '' : 's'}`].filter(Boolean);
  return frame(fmt, d, { eyebrow: d.statusLabel, title: ' ', noSponsors: isOg && !(d.sponsors || []).length }, [
    div({ flexGrow: 1, flexDirection: isOg ? 'row' : 'column', alignItems: 'center', justifyContent: 'center', gap: px(isOg ? 50 : 40, fmt), marginTop: isOg ? -110 : -px(120, fmt) },
      d.tournamentLogoBig ? img(d.tournamentLogoBig, isOg ? 300 : px(520, fmt), isOg ? 300 : px(520, fmt)) : null,
      div({ flexDirection: 'column', alignItems: isOg ? 'flex-start' : 'center', gap: px(26, fmt), flexShrink: 1 },
        text({ ...H, fontSize: isOg ? 86 : px(118, fmt), color: WHITE, lineHeight: 0.95, textAlign: isOg ? 'left' : 'center', justifyContent: isOg ? 'flex-start' : 'center' }, up(cut(t.name, 60))),
        div({ flexWrap: 'wrap', gap: px(16, fmt), justifyContent: isOg ? 'flex-start' : 'center', maxWidth: isOg ? 700 : px(900, fmt) }, chips.map(chip)),
        d.prize && !isOg ? text({ ...B, fontSize: px(40, fmt), color: ORANGE }, cut('Premiação: ' + d.prize, 60)) : null)),
  ]);
}

const TEMPLATES = {
  resultado: tplResultado, proximo: tplProximo, agenda: tplAgenda, classificacao: tplClassificacao,
  artilharia: tplArtilharia, campeao: tplCampeao, atleta: tplAtleta, torneio: tplTorneio,
};

// --------------------------------------------------------------------
// Dados (Postgres) → objeto da arte
// --------------------------------------------------------------------
class ArtError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function loadTournament(idOrSlug) {
  return prisma.tournament.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    select: { id: true, slug: true, name: true, sport: true, status: true, bannerUrl: true, city: true, state: true, startDate: true, endDate: true, prizeDescription: true, visibility: true, archivedAt: true },
  });
}

async function loadSponsors(tournamentId) {
  try {
    const list = await prisma.tournamentSponsor.findMany({ where: { tournamentId, active: true }, orderBy: [{ ordering: 'asc' }, { createdAt: 'asc' }], take: 8 });
    return Promise.all(list.map(async (s) => ({ name: s.name, logo: s.logoUrl ? await loadImage(s.logoUrl, 220) : '' })));
  } catch (_) {
    return []; // tabela ainda não criada (deploy antes do ensureApexSchema) → arte sai sem patrocínio
  }
}

async function entryView(e) {
  if (!e) return null;
  // Liga F2: nome e escudo do CLUBE quando o time tem clube (fallback: campos da inscrição)
  if (e.id && e.entryName === undefined) await require('./clubIdentity').brand(e);
  return { id: e.id, name: e.name, logo: e.logoUrl ? await loadImage(e.logoUrl, 300) : '', primaryColor: e.primaryColor || null, secondaryColor: e.secondaryColor || null };
}

const MATCH_SELECT = {
  id: true, tournamentId: true, categoryId: true, stage: true, round: true, groupName: true, ordering: true,
  status: true, scheduledAt: true, location: true, homeScore: true, awayScore: true, winnerEntryId: true,
  homePenalties: true, awayPenalties: true, decidedByPenalties: true, homeEntryId: true, awayEntryId: true,
  homeSourceLabel: true, awaySourceLabel: true,
  homeEntry: { select: { id: true, name: true, logoUrl: true } },
  awayEntry: { select: { id: true, name: true, logoUrl: true } },
  category: { select: { name: true, gameRules: true } },
};

async function matchView(m, sport) {
  const live = require('./tournamentLive');
  const ld = (await live.liveDataFor([m]))[m.id];
  const rules = gameRules.resolveRules(m.category, sport);
  return {
    ...m,
    scoring: rules.scoring, unit: gameRules.scoreUnit(rules),
    categoryName: m.category ? m.category.name : '',
    homeEntry: await entryView(m.homeEntry),
    awayEntry: await entryView(m.awayEntry),
    liveScore: ld.liveScore, timeline: ld.timeline,
  };
}

function dayBounds(dateStr) {
  // dia em Fortaleza (UTC-3 fixo, sem horário de verão)
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))
    ? dateStr
    : new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const start = new Date(ymd + 'T00:00:00-03:00');
  return { ymd, start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

async function buildData(t, tipo, q) {
  const base = {
    tournamentName: t.name,
    tournamentLogo: t.bannerUrl ? await loadImage(t.bannerUrl, 300) : '',
    url: `${publicDomain()}/t/${t.slug}`,
    sponsors: await loadSponsors(t.id),
  };
  const catId = q.categoryId || q.categoria || null;
  let category = null;
  if (catId) {
    category = await prisma.tournamentCategory.findFirst({ where: { id: String(catId), tournamentId: t.id }, select: { id: true, name: true, gameRules: true } });
    if (!category) throw new ArtError(404, 'categoria não encontrada');
  }

  if (tipo === 'resultado' || tipo === 'proximo') {
    let m = null;
    if (q.matchId || q.jogo) {
      m = await prisma.tournamentMatch.findFirst({ where: { id: String(q.matchId || q.jogo), tournamentId: t.id }, select: MATCH_SELECT });
      if (!m) throw new ArtError(404, 'jogo não encontrado');
    } else if (tipo === 'proximo') {
      const where = { tournamentId: t.id, status: 'SCHEDULED', scheduledAt: { gte: new Date(Date.now() - 2 * 3600 * 1000) } };
      if (category) where.categoryId = category.id;
      m = await prisma.tournamentMatch.findFirst({ where, orderBy: { scheduledAt: 'asc' }, select: MATCH_SELECT });
      if (!m) throw new ArtError(404, 'nenhum próximo jogo agendado');
    } else {
      throw new ArtError(400, 'informe matchId');
    }
    const mv = await matchView(m, t.sport);
    return { ...base, match: mv, categoryName: mv.categoryName };
  }

  if (tipo === 'agenda') {
    const where = { tournamentId: t.id, status: { in: ['SCHEDULED', 'LIVE'] } };
    if (category) where.categoryId = category.id;
    let title; let subtitle; let multiDay = false;
    if (q.data === 'proximos' || q.dia === 'proximos') {
      where.scheduledAt = { gte: new Date(Date.now() - 2 * 3600 * 1000) };
      title = 'Próximos jogos'; multiDay = true;
    } else {
      const b = dayBounds(q.data || q.dia);
      where.scheduledAt = { gte: b.start, lt: b.end };
      const today = dayBounds().ymd === b.ymd;
      title = today ? 'Jogos de hoje' : 'Agenda do dia';
      subtitle = fmtWhen(b.start.getTime() + 12 * 3600 * 1000, { weekday: 'long', day: '2-digit', month: 'long' });
    }
    const ms = await prisma.tournamentMatch.findMany({ where, orderBy: [{ scheduledAt: 'asc' }, { ordering: 'asc' }], take: 30, select: MATCH_SELECT });
    const matches = [];
    for (const m of ms.slice(0, 12)) matches.push(await matchView(m, t.sport));
    // os que ficaram de fora só contam (sem carregar escudo)
    for (const m of ms.slice(12)) matches.push({ ...m, categoryName: m.category ? m.category.name : '' });
    return { ...base, matches, agendaTitle: title, agendaSubtitle: [subtitle, category && category.name].filter(Boolean).join(' · '), multiDay };
  }

  if (tipo === 'classificacao') {
    if (!category) throw new ArtError(400, 'informe categoryId');
    let standings = await prisma.tournamentStanding.findMany({
      where: { categoryId: category.id },
      orderBy: [{ groupName: 'asc' }, { rank: 'asc' }, { points: 'desc' }],
      select: { groupName: true, rank: true, played: true, won: true, drawn: true, lost: true, scoreFor: true, scoreAgainst: true, points: true, entry: { select: { id: true, name: true, logoUrl: true } } },
    });
    let provisional = false;
    if (!standings.length) {
      provisional = true;
      const entries = await prisma.tournamentEntry.findMany({ where: { categoryId: category.id, status: 'CONFIRMED' }, select: { id: true, name: true, logoUrl: true, groupName: true }, orderBy: { name: 'asc' } });
      standings = entries.map((e, i) => ({ groupName: e.groupName, rank: i + 1, played: 0, won: 0, drawn: 0, lost: 0, scoreFor: 0, scoreAgainst: 0, points: 0, entry: e }));
    }
    const byG = new Map();
    for (const s of standings) {
      const g = s.groupName || '';
      if (!byG.has(g)) byG.set(g, []);
      byG.get(g).push(s);
    }
    await require('./clubIdentity').brandNested(standings, ['entry']); // Liga F2: nome do clube
    // Liga F4: escudo (do clube, quando tem) na tabela; sem escudo o selo usa as cores do clube
    for (const r of standings.slice(0, 24)) if (r.entry && r.entry.logoUrl && !r.entry.logo) r.entry.logo = await loadImage(r.entry.logoUrl, 160);
    let groups = [...byG.entries()].map(([name, rows]) => ({ name, rows }));
    if (q.grupo) groups = groups.filter((g) => g.name.toLowerCase() === String(q.grupo).toLowerCase());
    if (!groups.length) throw new ArtError(404, 'grupo não encontrado');
    return { ...base, categoryName: category.name, provisional, groups, _needsRowsFit: true };
  }

  if (tipo === 'artilharia') {
    const sheet = require('./matchSheet');
    const rows = await sheet.playerStats(t.id, { kind: 'scorers', categoryId: category ? category.id : null });
    const top = rows.filter((r) => r.goals > 0).slice(0, 12);
    const eids = [...new Set(top.map((r) => r.entryId))];
    const ents = await prisma.tournamentEntry.findMany({ where: { id: { in: eids } }, select: { id: true, name: true, logoUrl: true } });
    const eMap = {};
    for (const e of ents) eMap[e.id] = await entryView(e);
    // unidade pela regra da categoria (sem categoria: a 1ª do torneio; legado = gols)
    const catForUnit = category || await prisma.tournamentCategory.findFirst({ where: { tournamentId: t.id }, select: { gameRules: true } }).catch(() => null);
    const unit = gameRules.scoreUnit(gameRules.resolveRules(catForUnit, t.sport));
    return { ...base, unit, categoryName: category ? category.name : '', ranking: top.map((r) => ({ name: r.name, number: r.number, team: r.team, goals: r.goals, entry: eMap[r.entryId] || { name: r.team } })) };
  }

  if (tipo === 'campeao') {
    if (!category) throw new ArtError(400, 'informe categoryId');
    const fin = await prisma.tournamentMatch.findFirst({ where: { categoryId: category.id, stage: 'FINAL' }, orderBy: { ordering: 'asc' }, select: MATCH_SELECT });
    let champion = null; let runnerUp = null; let finalV = null;
    if (fin && ['FINISHED', 'WALKOVER'].includes(fin.status) && fin.winnerEntryId) {
      finalV = await matchView(fin, t.sport);
      champion = finalV.homeEntry && finalV.homeEntry.id === fin.winnerEntryId ? finalV.homeEntry : finalV.awayEntry;
      runnerUp = champion === finalV.homeEntry ? finalV.awayEntry : finalV.homeEntry;
    } else if (!fin) {
      // pontos corridos: líder da tabela com o torneio encerrado
      const allDone = (await prisma.tournamentMatch.count({ where: { categoryId: category.id, status: { notIn: ['FINISHED', 'WALKOVER', 'CANCELED'] } } })) === 0;
      const top = await prisma.tournamentStanding.findMany({ where: { categoryId: category.id }, orderBy: [{ rank: 'asc' }, { points: 'desc' }], take: 2, select: { entry: { select: { id: true, name: true, logoUrl: true } } } });
      if (allDone && top.length) {
        champion = await entryView(top[0].entry);
        runnerUp = top[1] ? await entryView(top[1].entry) : null;
      }
    }
    return { ...base, categoryName: category.name, champion, runnerUp, final: finalV };
  }

  if (tipo === 'atleta') {
    const engine = require('./tournamentEngine');
    const handle = q.handle || q.atleta;
    if (!handle) throw new ArtError(400, 'informe handle');
    const userId = await engine.resolveUserId(String(handle));
    if (!userId) throw new ArtError(404, 'atleta não encontrado');
    // Liga F2: números do HISTÓRICO único (todas as ligas), só torneios PÚBLICOS —
    // a arte é imagem pública (og:image), nunca mostra torneio privado.
    const card = await engine.buildAthleteCard(userId, { viewer: null });
    if (!card) throw new ArtError(404, 'atleta não encontrado');
    const goals = card.stats.goals || 0;
    const r0 = card.ratings[0];
    return {
      ...base,
      athlete: {
        name: card.user.name, username: card.user.username,
        photo: card.user.avatarUrl ? await loadImage(card.user.avatarUrl, 600, true) : '',
        matches: card.stats.matchesPlayed, wins: card.stats.wins, winRate: card.stats.winRate,
        tournaments: card.stats.tournaments, trainings: card.stats.trainings, goals,
        assists: card.stats.assists || 0, titles: card.stats.titles || 0, draws: card.stats.draws || 0,
        rating: r0 ? r0.rating.toFixed(1) : null, ratingSport: r0 ? SPORT_LABEL[r0.sport] || r0.sport : null,
        cells: (card.statCells || []).map((c) => ({ value: String(c.value), label: c.label })),
      },
      url: card.user.username ? `${publicDomain()}/atleta/${card.user.username}` : base.url,
    };
  }

  if (tipo === 'torneio') {
    const [entries, categories] = await Promise.all([
      prisma.tournamentEntry.count({ where: { tournamentId: t.id } }),
      prisma.tournamentCategory.count({ where: { tournamentId: t.id } }),
    ]);
    const fmtD = (x) => (x ? fmtWhen(x, { day: '2-digit', month: '2-digit', year: 'numeric' }).slice(0, 10) : '');
    const STATUS = { DRAFT: 'Em breve', OPEN: 'Inscrições abertas', ONGOING: 'Em andamento', FINISHED: 'Encerrado', CANCELED: 'Cancelado' };
    return {
      ...base,
      tournament: { name: t.name, sport: t.sport },
      tournamentLogo: '', // na capa o logo vai grande no meio
      tournamentLogoBig: t.bannerUrl ? await loadImage(t.bannerUrl, 520) : '',
      dateLine: t.startDate ? fmtD(t.startDate) + (t.endDate ? ' a ' + fmtD(t.endDate) : '') : '',
      place: [t.city, t.state].filter(Boolean).join('/'),
      entries, categories, statusLabel: STATUS[t.status] || '', prize: t.prizeDescription || '',
    };
  }
  throw new ArtError(400, 'tipo de arte inválido');
}

// --------------------------------------------------------------------
// Render + cache
// --------------------------------------------------------------------
const PNG_CACHE = new Map(); // hash -> Buffer
const PNG_MAX = 150;
const INFLIGHT = new Map();

function fitRows(tipo, fmt, data) {
  if (tipo !== 'classificacao') return data;
  // cabe quantas linhas? corta grupos excedentes (sem cortar no meio de um grupo)
  const limit = fmt.rows.table;
  const out = [];
  let used = 0;
  for (const g of data.groups) {
    if (out.length && used + g.rows.length > limit) break;
    out.push({ ...g, rows: g.rows.slice(0, Math.max(limit - used, 1)) });
    used += g.rows.length;
  }
  return { ...data, groups: out };
}

async function renderPng(tipo, formato, data) {
  const fmt = FORMATS[formato] || FORMATS.story;
  const d = fitRows(tipo, fmt, data);
  const satori = await getSatori();
  const svg = await satori(TEMPLATES[tipo](fmt, d), { width: fmt.w, height: fmt.h, fonts: fonts() });
  const Resvg = getResvg();
  const png = new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } }).render().asPng();
  return Buffer.from(png);
}

// API principal: devolve { png, hash, width, height }
// opts.allowPrivate: a ROTA já conferiu a visibilidade (membro de torneio privado).
// Sem isso, privado/arquivado = 404 (uso direto continua seguro por padrão).
async function buildArt(idOrSlug, tipo, query = {}, opts = {}) {
  if (!TYPES.includes(tipo)) throw new ArtError(400, 'tipo de arte inválido (' + TYPES.join(', ') + ')');
  const formato = FORMATS[query.formato] ? query.formato : (tipo === 'torneio' && !query.formato ? 'og' : 'story');
  let t = null;
  if (tipo === 'atleta' && (idOrSlug === 'club' || idOrSlug === '-')) {
    t = { id: null, slug: '', name: 'Club Sports & Tennis', bannerUrl: null };
  } else {
    t = await loadTournament(idOrSlug);
    if (!t || t.archivedAt || (t.visibility === 'private' && !opts.allowPrivate)) throw new ArtError(404, 'torneio não encontrado');
  }
  const data = t.id ? await buildData(t, tipo, query) : await buildData({ ...t, id: '__none__' }, tipo, query);
  const hash = crypto.createHash('sha1').update(tipo + '|' + formato + '|' + JSON.stringify(data)).digest('hex');
  const fmt = FORMATS[formato];
  const priv = !!(t && t.visibility === 'private'); // arte de torneio privado não vai pra cache público
  if (PNG_CACHE.has(hash)) return { png: PNG_CACHE.get(hash), hash, width: fmt.w, height: fmt.h, cached: true, private: priv };
  if (INFLIGHT.has(hash)) return { png: await INFLIGHT.get(hash), hash, width: fmt.w, height: fmt.h, cached: true, private: priv };
  const p = renderPng(tipo, formato, data);
  INFLIGHT.set(hash, p);
  try {
    const png = await p;
    if (PNG_CACHE.size >= PNG_MAX) PNG_CACHE.delete(PNG_CACHE.keys().next().value);
    PNG_CACHE.set(hash, png);
    return { png, hash, width: fmt.w, height: fmt.h, cached: false, private: priv };
  } finally {
    INFLIGHT.delete(hash);
  }
}

module.exports = { buildArt, ArtError, FORMATS, TYPES, loadImage, _renderPng: renderPng, _buildData: buildData };
