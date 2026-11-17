// Teste estático do painel mobile da Rede (public/rede.html).
// Uso: node scripts/test-rede-painel.cjs
// 1) extrai os <script> inline e roda `node --check` (sintaxe);
// 2) confere as regras mobile-first do CLAUDE.md e as rotas da API usadas.
// Não sobe servidor e não toca no banco. O teste visual é no navegador (?demo=1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'rede.html'), 'utf8');
let falhas = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FALHA') + ' ' + msg); if (!cond) falhas++; };

// 1) sintaxe do JS embutido
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
ok(scripts.length >= 1, 'tem script inline (' + scripts.length + ')');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rede-painel-'));
scripts.forEach((code, i) => {
  const f = path.join(tmp, 'script' + i + '.js');
  fs.writeFileSync(f, code);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); ok(true, 'node --check script ' + i); }
  catch (e) { ok(false, 'node --check script ' + i + ': ' + String(e.stderr || e.message).split('\n').slice(0, 4).join(' | ')); }
});
fs.rmSync(tmp, { recursive: true, force: true });

// 2) mobile-first (regra permanente do CLAUDE.md)
ok(/name="viewport"[^>]*viewport-fit=cover/.test(html), 'viewport-fit=cover');
ok(/env\(safe-area-inset-top/.test(html) && /env\(safe-area-inset-bottom/.test(html), 'safe-area top/bottom');
ok(/max-width:\s*480px/.test(html), 'container max-width 480px');
ok(/apple-mobile-web-app-capable/.test(html) && /rel="manifest"/.test(html), 'PWA metas + manifest');
ok(/min-height:\s*44px/.test(html), 'alvos de toque >= 44px');
ok(/@media \(min-width:\s*900px\)/.test(html), 'frame centralizado no desktop (>=900px)');
ok(/id="tabs"/.test(html) && /#tabs\{position:absolute;[^}]*bottom:0/.test(html), 'bottom nav fixa');
ok(/\.sheet\{position:absolute;left:0;right:0;bottom:0/.test(html), 'modais como bottom-sheet');
ok(/localStorage\.getItem\('tc_token'\)/.test(html) && /'Bearer '/.test(html), 'token tc_token + Authorization Bearer');
ok(/#EA5128/i.test(html), 'laranja da marca');
const ext = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]).filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u));
ok(ext.length === 0, 'sem dependência externa além de Google Fonts' + (ext.length ? ': ' + ext.join(', ') : ''));

// 3) toda rota usada existe em src/routes/rede.js
const rotas = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'rede.js'), 'utf8');
[['get', '/painel'], ['get', '/traces'], ['get', '/traces/:traceId'], ['get', '/propostas'], ['post', '/propostas/:id/decisao'], ['post', '/propostas/:id/executar'],
 ['patch', '/neuronios/:id'], ['get', '/objetivos'], ['post', '/objetivos/compilar'], ['post', '/objetivos'], ['patch', '/objetivos/:id'], ['post', '/sinais'], ['get', '/ao-vivo']]
  .forEach(([m, p]) => ok(rotas.includes(`router.${m}('${p}'`), `API ${m.toUpperCase()} ${p} existe no backend`));
['/painel', '/traces', '/propostas', '/decisao', '/executar', '/neuronios/', '/objetivos', '/objetivos/compilar', '/sinais', '/ao-vivo'].forEach((p) => ok(html.includes("'" + p) || html.includes(p + "'"), 'painel chama ' + p));

console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
process.exit(falhas ? 1 : 0);
