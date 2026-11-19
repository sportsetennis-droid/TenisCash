// =====================================================================
// APEX F2 — HTML do TELÃO (/t/:slug/telao) e do EMBED (/t/:slug/embed)
// ---------------------------------------------------------------------
// Casca HTML/CSS gerada no servidor; os dados vêm da API pública
// (/api/public/tournaments/:slug) e o tempo real do SSE
// (/api/tournaments/:id/live). JS em public/club/*.js (ES5: TV de ginásio
// costuma ter navegador velho).
// =====================================================================

const { publicDomain } = require('../config/publicUrl');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const FONT = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;0,800;1,800;1,900&display=swap" rel="stylesheet">';

function telaoHtml(cfg) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Telão · ${esc(cfg.name)}</title>
<meta name="theme-color" content="#0B0B0D">
${FONT}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--o:#E5571E;--bk:#0B0B0D;--p:#17171C;--p2:#202027;--m:#A1A1AA;--w:#fff;--live:#DC2626}
  html,body{height:100%;background:var(--bk);color:var(--w);overflow:hidden}
  body{font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-weight:700;-webkit-font-smoothing:antialiased}
  body.idle{cursor:none}
  .scr{position:fixed;inset:0;display:flex;flex-direction:column;padding:2.2vh 2.4vw;background:linear-gradient(165deg,#1A1A20 0%,#0B0B0D 55%)}
  .stripe{position:absolute;right:-20vw;top:-14vh;width:70vw;height:7vh;background:var(--o);transform:rotate(-32deg);opacity:.95;pointer-events:none}
  .stripe.b{top:-4vh;height:1.6vh;opacity:.5}
  .bar{position:absolute;left:0;top:0;height:.6vh;background:var(--o);width:0;transition:width linear}
  header{display:flex;align-items:center;gap:1.6vw;position:relative;z-index:2;min-height:12vh}
  header .tl{height:10vh;width:10vh;object-fit:contain}
  header .tt{flex:1;min-width:0}
  .eye{color:var(--o);font-size:2.6vh;letter-spacing:.3vh;text-transform:uppercase}
  h1{font-weight:900;font-style:italic;font-size:6vh;line-height:1;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .clock{font-weight:900;font-style:italic;font-size:6.5vh;line-height:1}
  .qr{display:flex;align-items:center;gap:1vw;background:#fff;color:var(--bk);border-radius:1.4vh;padding:.8vh 1.2vh .8vh .8vh}
  .qr img{height:11vh;width:11vh;display:block}
  .qr span{font-size:2.2vh;line-height:1.05;text-transform:uppercase;max-width:9vw}
  main{flex:1;position:relative;z-index:2;display:flex;flex-direction:column;min-height:0;margin-top:2vh}
  .st{font-weight:900;font-style:italic;font-size:5.4vh;text-transform:uppercase;margin-bottom:2vh;display:flex;align-items:center;gap:1.4vw}
  .st small{font-style:normal;font-weight:700;color:var(--m);font-size:3vh;letter-spacing:.2vh}
  .st .lv{background:var(--live);font-size:3vh;padding:.4vh 1.2vw;border-radius:1vh;font-style:italic;animation:pl 1.2s infinite}
  @keyframes pl{50%{opacity:.55}}
  .fade{animation:fd .6s ease}
  @keyframes fd{from{opacity:0;transform:translateY(1.5vh)}to{opacity:1;transform:none}}
  .crest{flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:22%;font-weight:900;font-style:italic;color:#fff;overflow:hidden}
  .crest img{width:100%;height:100%;object-fit:contain}
  /* jogo ao vivo */
  .lives{display:flex;gap:2vw;flex:1;min-height:0}
  .lm{flex:1;background:var(--p);border-radius:2.4vh;border:.3vh solid rgba(220,38,38,.55);display:flex;flex-direction:column;padding:2.6vh 2vw;min-width:0}
  .lm .cat{color:var(--m);font-size:2.8vh;text-transform:uppercase;letter-spacing:.2vh}
  .lm .row{display:flex;align-items:center;justify-content:space-between;margin:2vh 0}
  .lm .sd{width:32%;display:flex;flex-direction:column;align-items:center;gap:1.4vh;text-align:center}
  .lm .nm{font-weight:800;font-style:italic;font-size:4.2vh;line-height:1.02;text-transform:uppercase}
  .lm .sc{font-weight:900;font-style:italic;font-size:17vh;line-height:.9;display:flex;gap:1.2vw;align-items:center}
  .lm .sc i{font-size:7vh;color:var(--m)}
  .lm.one .sc{font-size:24vh}
  .lm.one .nm{font-size:5.6vh}
  .tlx{display:flex;flex-direction:column;gap:.9vh;margin-top:auto;overflow:hidden}
  .ev{display:flex;align-items:center;gap:1vw;font-size:3.1vh;background:rgba(255,255,255,.04);border-radius:1vh;padding:.7vh 1vw}
  .ev.a{flex-direction:row-reverse;text-align:right}
  .ev b{color:var(--o);min-width:4vw}
  .ev .k{width:1.8vh;height:2.5vh;border-radius:.3vh;background:#FACC15;flex-shrink:0}
  .ev .k.r{background:var(--live)}
  .ev .g{width:1.9vh;height:1.9vh;border-radius:50%;background:var(--o);flex-shrink:0}
  /* listas */
  .list{display:grid;grid-template-columns:1fr 1fr;gap:1.6vh 1.6vw}
  .mi{display:flex;align-items:center;gap:1.2vw;background:var(--p);border-radius:1.8vh;padding:1.6vh 1.4vw;border-left:.8vh solid var(--o);min-width:0}
  .mi .hr{font-weight:900;font-style:italic;font-size:4.6vh;min-width:9vw;text-align:center;line-height:1}
  .mi .hr small{display:block;font-size:2.2vh;color:var(--m);font-style:normal;font-weight:700}
  .mi .tm{flex:1;min-width:0;display:flex;flex-direction:column;gap:.6vh}
  .mi .ln{display:flex;align-items:center;gap:.8vw;font-weight:800;font-style:italic;font-size:3.4vh;text-transform:uppercase;white-space:nowrap;overflow:hidden}
  .mi .ln span{overflow:hidden;text-overflow:ellipsis}
  .mi .ln b{margin-left:auto;font-weight:900;font-size:4vh}
  .mi .ln.w b,.mi .ln.w span{color:var(--o)}
  .mi .sub{color:var(--m);font-size:2.3vh;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* tabela */
  .groups{display:flex;gap:1.8vw;flex:1;min-height:0}
  .grp{flex:1;min-width:0;display:flex;flex-direction:column}
  .grp h3{font-weight:900;font-style:italic;color:var(--o);font-size:3.8vh;text-transform:uppercase;margin-bottom:1vh}
  table{width:100%;border-collapse:separate;border-spacing:0 .7vh}
  th{color:var(--m);font-size:2.4vh;font-weight:700;text-align:center;padding:0 .4vw}
  th.l{text-align:left}
  td{background:var(--p);font-size:3.4vh;text-align:center;padding:1vh .5vw;font-weight:700}
  td:first-child{border-radius:1.2vh 0 0 1.2vh;font-weight:900;font-style:italic;width:4vw}
  td:last-child{border-radius:0 1.2vh 1.2vh 0;font-weight:900;font-size:4vh}
  td.l{text-align:left;font-weight:800;font-style:italic;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:22vw}
  td.l .crest{display:inline-flex;vertical-align:middle;margin-right:.7vw}
  tr.q td:first-child{color:var(--o);box-shadow:inset .6vh 0 0 var(--o)}
  /* artilharia */
  .sc-list{display:grid;grid-template-columns:1fr 1fr;gap:1.4vh 1.6vw}
  .sr{display:flex;align-items:center;gap:1.2vw;background:var(--p);border-radius:1.6vh;padding:1.4vh 1.4vw}
  .sr .ps{font-weight:900;font-style:italic;font-size:4.4vh;width:4.5vw;color:var(--w)}
  .sr.top .ps{color:var(--o)}
  .sr .pn{flex:1;min-width:0}
  .sr .pn div{font-weight:800;font-style:italic;font-size:3.6vh;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sr .pn small{color:var(--m);font-size:2.4vh;font-weight:600}
  .sr .gl{font-weight:900;font-style:italic;font-size:6vh}
  /* patrocínio */
  .spg{display:flex;flex-wrap:wrap;gap:3vh 2vw;align-items:center;justify-content:center;flex:1;align-content:center}
  .spc{background:#fff;border-radius:2vh;height:20vh;width:22vw;display:flex;align-items:center;justify-content:center;padding:2vh 2vw}
  .spc img{max-width:100%;max-height:100%;object-fit:contain}
  .spc b{color:var(--bk);font-weight:900;font-style:italic;font-size:5vh;text-transform:uppercase;text-align:center}
  footer{position:relative;z-index:2;display:flex;align-items:center;gap:1.4vw;margin-top:1.6vh;height:8vh;border-top:.25vh solid rgba(255,255,255,.12);padding-top:1.2vh}
  footer .lb{color:var(--m);font-size:2.2vh;letter-spacing:.3vh;text-transform:uppercase}
  .tick{flex:1;overflow:hidden;white-space:nowrap;position:relative;height:100%}
  .tick .in{display:inline-flex;gap:1.6vw;align-items:center;height:100%;animation:mq 40s linear infinite;padding-left:100%}
  .tick .chip{background:#fff;border-radius:1vh;height:100%;padding:.6vh 1.2vw;display:inline-flex;align-items:center}
  .tick .chip img{height:100%;max-width:12vw;object-fit:contain}
  .tick .chip b{color:var(--bk);font-weight:900;font-style:italic;font-size:3vh;text-transform:uppercase}
  @keyframes mq{to{transform:translateX(-100%)}}
  footer .club{height:5.6vh;opacity:.95}
  footer .dom{font-size:2.6vh;opacity:.85;white-space:nowrap}
  .empty{flex:1;display:flex;align-items:center;justify-content:center;font-weight:900;font-style:italic;font-size:6vh;color:var(--m);text-transform:uppercase}
  /* GOL! */
  .goal{position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 40%,rgba(229,87,30,.96),rgba(11,11,13,.97) 70%);opacity:0;pointer-events:none;transition:opacity .35s}
  .goal.on{opacity:1}
  .goal .big{font-weight:900;font-style:italic;font-size:34vh;line-height:.85;text-transform:uppercase;text-shadow:0 1.5vh 6vh rgba(0,0,0,.5);animation:pop .7s cubic-bezier(.2,1.6,.4,1)}
  .goal .who{font-weight:800;font-style:italic;font-size:7vh;text-transform:uppercase;margin-top:2vh;text-align:center}
  .goal .sc{font-weight:900;font-style:italic;font-size:9vh;margin-top:1vh}
  @keyframes pop{from{transform:scale(.3)}to{transform:scale(1)}}
  .hint{position:fixed;bottom:2vh;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.75);padding:1vh 2vw;border-radius:1vh;font-size:2.4vh;z-index:30;transition:opacity .5s}
  @media (max-aspect-ratio:1/1){ /* celular em pé: empilha */
    .lives,.groups{flex-direction:column}
    .list,.sc-list{grid-template-columns:1fr}
    .qr{display:none}
    h1{font-size:4vh}
  }
</style>
</head>
<body>
<div class="scr">
  <div class="stripe"></div><div class="stripe b"></div><div class="bar" id="bar"></div>
  <header>
    ${cfg.logo ? `<img class="tl" src="${esc(cfg.logo)}" alt="">` : ''}
    <div class="tt"><div class="eye" id="eye">Ao vivo no ginásio</div><h1>${esc(cfg.name)}</h1></div>
    <div class="clock" id="clock"></div>
    <div class="qr"><img src="/api/tournaments/${esc(cfg.tid)}/qr.png?size=300" alt="QR"><span>Acompanhe no celular</span></div>
  </header>
  <main id="main"><div class="empty">Carregando…</div></main>
  <footer>
    <span class="lb" id="splb">Patrocínio</span>
    <div class="tick"><div class="in" id="tick"></div></div>
    <img class="club" src="/brand/club-sports-tennis.svg" alt="Club Sports &amp; Tennis">
    <span class="dom">${esc(publicDomain())}/t/${esc(cfg.slug)}</span>
  </footer>
</div>
<div class="goal" id="goal"><div class="big" id="gbig">GOL!</div><div class="who" id="gwho"></div><div class="sc" id="gsc"></div></div>
<div class="hint" id="hint">Toque na tela para tela cheia</div>
<script>window.CLUB_TELAO=${json(cfg)};</script>
<script src="/club/live-sse.js"></script>
<script src="/club/telao.js"></script>
</body>
</html>`;
}

function embedHtml(cfg) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(cfg.name)}</title>
${FONT}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--o:#E5571E;--bg:#fff;--card:#F4F4F5;--line:#E4E4E7;--txt:#0B0B0D;--m:#71717A}
  ${cfg.dark ? ':root{--bg:#0B0B0D;--card:#17171C;--line:rgba(255,255,255,.1);--txt:#fff;--m:#A1A1AA}' : ''}
  html,body{background:var(--bg);color:var(--txt)}
  body{font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;font-weight:600;font-size:16px;padding:12px;-webkit-font-smoothing:antialiased}
  .hd{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
  .hd b{font-weight:900;font-style:italic;font-size:20px;text-transform:uppercase;line-height:1.05}
  .pills{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin-bottom:8px;-webkit-overflow-scrolling:touch}
  .pills::-webkit-scrollbar{display:none}
  .pill{flex-shrink:0;border:1px solid var(--line);background:var(--card);color:var(--txt);font:700 14px 'Barlow Condensed',sans-serif;padding:8px 12px;border-radius:999px;cursor:pointer;min-height:36px;text-transform:uppercase}
  .pill.on{background:var(--o);border-color:var(--o);color:#fff}
  .tabs .pill{border-radius:8px}
  .gh{font-weight:900;font-style:italic;color:var(--o);font-size:17px;text-transform:uppercase;margin:12px 0 6px}
  table{width:100%;border-collapse:collapse;font-size:15px}
  th{font-size:12px;color:var(--m);text-transform:uppercase;padding:6px 4px;text-align:center;font-weight:700}
  td{padding:8px 4px;text-align:center;border-top:1px solid var(--line);font-weight:700}
  .l{text-align:left}
  td.l{display:flex;align-items:center;gap:7px;font-weight:800;text-transform:uppercase}
  td.l img,.cr{width:22px;height:22px;object-fit:contain;flex-shrink:0;border-radius:5px}
  .cr{display:inline-flex;align-items:center;justify-content:center;background:var(--o);color:#fff;font-size:10px;font-weight:900}
  tr.q td:first-child{color:var(--o);box-shadow:inset 3px 0 0 var(--o)}
  .pts{font-weight:900;font-size:17px}
  .m{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:10px 12px;margin-bottom:8px}
  .m.live{border-color:#DC2626}
  .m .meta{font-size:12.5px;color:var(--m);margin-bottom:6px;display:flex;justify-content:space-between;gap:6px}
  .m .lv{color:#DC2626;font-weight:800}
  .m .t{display:flex;align-items:center;gap:8px;font-weight:800;font-size:16px;text-transform:uppercase;padding:2px 0}
  .m .t span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .m .t b{font-weight:900;font-size:19px}
  .m .t.w{color:var(--o)}
  .m .tl{font-size:12.5px;color:var(--m);margin-top:6px}
  .empty{padding:22px 10px;text-align:center;color:var(--m)}
  .ft{margin-top:12px;text-align:center;font-size:12.5px}
  .ft a{color:var(--o);font-weight:800;text-decoration:none}
  .sp{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:12px}
  .sp a,.sp span{background:#fff;border:1px solid var(--line);border-radius:8px;height:40px;padding:4px 10px;display:inline-flex;align-items:center;color:#0B0B0D;font-weight:900;font-style:italic;text-decoration:none}
  .sp img{max-height:30px;max-width:110px;object-fit:contain}
</style>
</head>
<body>
<div class="hd"><b>${esc(cfg.name)}</b></div>
<div class="pills" id="cats"></div>
<div class="pills tabs" id="tabs"></div>
<div id="body"><div class="empty">Carregando…</div></div>
<div class="sp" id="sp"></div>
<div class="ft"><a href="/t/${esc(cfg.slug)}" target="_blank" rel="noopener">Ver tudo no Club Sports &amp; Tennis →</a></div>
<script>window.CLUB_EMBED=${json(cfg)};</script>
<script src="/club/live-sse.js"></script>
<script src="/club/embed.js"></script>
</body>
</html>`;
}

module.exports = { telaoHtml, embedHtml };
