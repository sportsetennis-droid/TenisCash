// Guard de deploy: confere que TODO require relativo no src/ aponta pra um arquivo
// VERSIONADO NO GIT (não só presente no PC). Pega a bomba "arquivo gitignored mas
// requerido" que quebra o build do Railway com MODULE_NOT_FOUND (causa do 502 2026-06-07).
// Roda local (antes de pushar) e no CI. Sai com código 1 se achar require quebrado.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const trackedList = execSync('git ls-files', { cwd: ROOT }).toString().split('\n').filter(Boolean);
const tracked = new Set(trackedList.map(p => path.resolve(ROOT, p)));

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(full, acc); }
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) acc.push(full);
  }
  return acc;
}

function resolvesTracked(fromFile, req) {
  const base = path.resolve(path.dirname(fromFile), req);
  const cands = [base, base + '.js', base + '.mjs', base + '.json', base + '.cjs', path.join(base, 'index.js')];
  return cands.some(c => tracked.has(c));
}

const files = walk(path.join(ROOT, 'src'));
const RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g; // só requires relativos (./ ou ../)
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = RE.exec(src))) {
    if (!resolvesTracked(f, m[1])) {
      console.error(`❌ ${path.relative(ROOT, f)}  ->  require('${m[1]}') NÃO está versionado no git (existe local? talvez. No build do Railway = MODULE_NOT_FOUND)`);
      bad++;
    }
  }
}
if (bad) { console.error(`\n💥 ${bad} require(s) quebrado(s). O deploy do Railway vai falhar (502). Commite o arquivo ou remova o require.`); process.exit(1); }
console.log(`✅ ${files.length} arquivos do src/ checados — todos os require relativos apontam pra arquivo versionado.`);
