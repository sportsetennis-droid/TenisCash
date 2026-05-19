// Parser do backup tab_parametros do Chianca
const fs = require('fs');
const path = process.argv[2] || 'C:/Chianca/CHINTEGRA/Bck_Tab_parametros_SerieNF1_Contadores_Maior.txt';
const data = fs.readFileSync(path, 'utf8');

const headerM = data.match(/INSERT INTO tab_parametros \(([^)]*)\) VALUES/);
if (!headerM) { console.error('header não encontrado'); process.exit(1); }
const headers = headerM[1].split(',').map(s => s.trim());

// Extrai a parte de valores (depois de "VALUES (")
const startIdx = data.indexOf('VALUES (');
const rawValues = data.slice(startIdx + 'VALUES ('.length, data.lastIndexOf(')'));

// Split por ',' fora de aspas simples
const vals = [];
let cur = '', inQ = false, prev = '';
for (let i = 0; i < rawValues.length; i++) {
  const c = rawValues[i];
  if (c === "'" && prev !== '\\') { inQ = !inQ; cur += c; }
  else if (c === ',' && !inQ) { vals.push(cur.trim().replace(/^'|'$/g, '')); cur = ''; }
  else cur += c;
  prev = c;
}
if (cur.trim()) vals.push(cur.trim().replace(/^'|'$/g, ''));

console.log('Headers:', headers.length, '| Values:', vals.length);
const keep = [
  'contador_nota_fiscal','contador_lote','contador_lote_nfe','contador_nf_servico',
  'contador_carta_correcao','data_inicio_nfe','dt_inicio_nfe','versao_nfe',
  'serie_nf','config_pdv_nfce','identificador_csc','codigo_csc','configuracao_nf',
  'arquivo_confignfe','contador_numero_nf_contigencia','contador_ultnsu',
  'arquivo_caminho_newch','codigo_simples_nacional','codigo_estabelecimento'
];
for (let i = 0; i < headers.length; i++) {
  if (keep.includes(headers[i])) {
    const v = String(vals[i] || '').slice(0, 300);
    console.log('  ' + headers[i] + ' = ' + v);
  }
}
