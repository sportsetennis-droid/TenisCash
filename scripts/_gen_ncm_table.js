// Gera src/data/ncm-validos.json (array dos codigos NCM de 8 digitos validos hoje).
// Fonte: BrasilAPI (espelho da tabela oficial). Rodar quando quiser atualizar a tabela.
const fs = require('fs'); const path = require('path');
(async () => {
  const list = await (await fetch('https://brasilapi.com.br/api/ncm/v1', { signal: AbortSignal.timeout(60000) })).json();
  const codes = [...new Set(list.map(n => String(n.codigo).replace(/\D/g, '')).filter(c => c.length === 8))].sort();
  const dir = path.join(__dirname, '..', 'src', 'data'); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'ncm-validos.json');
  fs.writeFileSync(out, JSON.stringify(codes));
  console.log('Gravado ' + out + ' com ' + codes.length + ' NCMs de 8 digitos validos (atualizado de ' + list.length + ' entradas da tabela).');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
