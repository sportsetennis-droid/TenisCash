// Parseia o _chat.txt do export do WhatsApp Chat e extrai
// pares (foto, tamanhos) — uma linha por foto.
// Tamanhos podem vir em múltiplas linhas (40\n41) ou com qty (35 - 2).
//
// Uso: node scripts/parse-whatsapp-stock.js <pasta_extraida> [--out file.json]
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) { console.error('Uso: parse-whatsapp-stock.js <dir>'); process.exit(1); }
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null;

const txt = fs.readFileSync(path.join(dir, '_chat.txt'), 'utf8');

// Cada mensagem começa com '[dd/mm/yyyy, hh:mm:ss] AUTOR:' e pode ter
// múltiplas linhas até a próxima mensagem.
// Regex pra capturar bloco inteiro de uma mensagem com anexo PHOTO:
const blocks = txt.split(/(?=‎?\[\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}\])/);

const entries = [];
for (const b of blocks) {
  const m = b.match(/<anexado: (\d+-PHOTO-[\d-]+\.jpg)>/);
  if (!m) continue;
  const photo = m[1];
  // Extrai TEXTO da mensagem antes do anexo (são os tamanhos)
  // Geralmente fica entre "AUTOR:" e "<anexado:"
  const txtPart = b.replace(/^‎?\[\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}\] [^:]+: /, '')
                   .replace(/<anexado:.*$/s, '')
                   .replace(/^‎+/, '').trim();
  // Quebra por linhas + extrai tokens numéricos / "tam - qty"
  const sizes = [];
  txtPart.split('\n').forEach(line => {
    const t = line.replace(/[‎\s]/g, ' ').trim();
    // Padrões:
    // "40" → size 40 qty 1
    // "40 41" → 2 sizes (mas raro no chat)
    // "35 - 2" → size 35 qty 2
    // "PP", "G" etc → letra
    const mq = t.match(/^(\d{1,3}|PP|P|M|G|GG|XG)\s*[-x]\s*(\d{1,2})$/i);
    if (mq) {
      sizes.push({ size: mq[1].toUpperCase(), qty: parseInt(mq[2], 10) || 1 });
      return;
    }
    const ms = t.match(/^(\d{1,3}|PP|P|M|G|GG|XG)$/i);
    if (ms) {
      sizes.push({ size: ms[1].toUpperCase(), qty: 1 });
    }
  });
  entries.push({ photo, sizes, rawText: txtPart });
}

console.log(`Total fotos com tamanhos: ${entries.length}`);
console.log(`Total fotos no diretório: ` + fs.readdirSync(dir).filter(f => /PHOTO.*\.jpg$/.test(f)).length);
console.log('\nAmostras (primeiras 5):');
entries.slice(0, 5).forEach((e, i) => {
  console.log(` ${i+1}. ${e.photo}`);
  console.log(`    Texto: "${e.rawText.slice(0, 60)}"`);
  console.log(`    Sizes: ${e.sizes.map(s => s.qty > 1 ? `${s.size}x${s.qty}` : s.size).join(', ') || '(vazio)'}`);
});

if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(entries, null, 2));
  console.log(`\n✓ ${entries.length} entradas salvas em ${outPath}`);
}
