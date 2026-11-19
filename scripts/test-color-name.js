// Teste do dicionário de cor por extenso (constituição 14/11/2026 + cores oficiais 18/11/2026).
// node scripts/test-color-name.js
const assert = require('assert');
const { expandColorName, labelColorName } = require('../src/services/colorName');

const ok = (raw, brand, esperado) => {
  const r = expandColorName(raw, { brand });
  assert.ok(r.certain, `${raw} (${brand || '-'}) deveria ser certa: ${JSON.stringify(r)}`);
  assert.strictEqual(r.value, esperado, `${raw} (${brand || '-'})`);
};
const incerta = (raw, brand) => {
  const r = expandColorName(raw, { brand });
  assert.ok(!r.certain, `${raw} (${brand || '-'}) NÃO pode ser expandida sem evidência: ${JSON.stringify(r)}`);
  assert.strictEqual(r.value, raw, 'incerta devolve o texto original, sem chute');
};

// siglas globais certas continuam
ok('BC/AZ/PT', '', 'Branco/Azul/Preto');
ok('AML/PTO', 'KEMPA', 'Amarelo/Preto');
ok('Core Black/Cloud White', 'ADIDAS', 'Preto/Branco');

// ambíguas continuam sem expansão (PR, MR, RO fora da Poker)
incerta('BC-AZ-PR', 'PENALTY');
incerta('MR/VM', 'PENALTY');
incerta('RO', '');
ok('BR/PR', 'POKER', 'Branco/Prata'); // Poker tem evidência

// Skechers: código de cor da marca (mesmo em todos os estilos)
ok('BKRD', 'SKECHERS', 'Preto/Vermelho');
ok('CCRD', 'Skechers', 'Grafite/Vermelho');
ok('SLT', 'SKECHERS', 'Ardósia');
ok('WMLT', 'SKECHERS', 'Branco/Multicolorido');
incerta('LBPK', 'SKECHERS'); // Lilás num estilo, Azul em outro
incerta('BKRD', 'NIKE'); // o código Skechers não vale para outra marca

// nomes oficiais em português das marcas (FILA, Umbro, OUS, Kenner, Nike traduzido)
ok('Azul Roxeado/Azul Granito/Laranja Papaya', 'FILA', 'Azul Roxeado/Azul Granito/Laranja Papaya');
ok('Bege/Rosê/Azaleia', 'FILA', 'Bege/Rosê/Azaleia');
ok('Grafite/Preto/Roxo Elétrico', 'UMBRO', 'Grafite/Preto/Roxo Elétrico');
ok('Marrom/Chantilly/Preto', 'OUS', 'Marrom/Chantilly/Preto');
ok('Azul Noturno/Azul Marinho', 'KENNER', 'Azul Noturno/Azul Marinho');
ok('Baunilha', 'KENNER', 'Baunilha');
ok('Platina/Antracite', 'NIKE', 'Platina/Antracite');
ok('Preto/Branco/Goma', 'ADIDAS', 'Preto/Branco/Goma');
ok('Azul/Preto/Rosa Flúor', 'UMBRO', 'Azul/Preto/Rosa Fluorescente');

// etiqueta: incerta não imprime sigla chutada
assert.strictEqual(labelColorName('LBPK', { brand: 'SKECHERS' }), null);
assert.strictEqual(labelColorName('BKRD', { brand: 'SKECHERS' }), 'PRETO/VERMELHO');

console.log('test-color-name: OK');
