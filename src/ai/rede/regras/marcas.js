// =====================================================================
// RNA — marcas: chave única de cada marca + FICHA (o que a casa já aprendeu
// sobre ela). A ficha é CONHECIMENTO REGISTRADO (CLAUDE.md, levantamento dos
// fornecedores e conferências reais), nunca palpite. Campo que não se sabe
// fica ausente — o gerente de marca mostra "sem ficha" em vez de inventar.
// Usada pelo gerente de marca (neuronios/marca) e pelo painel /marcas.html.
// =====================================================================

const SEM_MARCA = new Set(['', 'A DEFINIR', 'A CLASSIFICAR', 'MARCA NAO INFORMADA', 'SEM MARCA', 'NAO DEFINIDO']);

// Grafias diferentes da MESMA marca no cadastro → uma chave só.
const APELIDOS = {
  'CAJU': 'CAJU BRASIL',
  'CAJUBRASIL': 'CAJU BRASIL',
  'LETS GYM': "LET'S GYM",
  'LET S GYM': "LET'S GYM",
  'BODY FOR SURE': 'BODY FOR SURE',
  'HOPE': 'HOPE RESORT',
  'ALL STAR': 'CONVERSE',
};

function normalizar(brand) {
  return String(brand == null ? '' : brand)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

// Chave da marca (ou null quando o card não tem marca de verdade).
function chave(brand) {
  const n = normalizar(brand);
  if (SEM_MARCA.has(n)) return null;
  return APELIDOS[n] || n;
}

// Fichas — fonte entre parênteses no próprio texto quando ajuda a conferir.
const FICHAS = {
  ADIDAS: {
    fornecedores: ['ALPAR DO BRASIL'],
    nfe: 'cProd = o próprio EAN (0+EAN); descrição traz só a FAIXA de tamanho ("38/43").',
    tamanho: 'NUNCA vem da NF-e: só da CAIXA física (bipe pede o tamanho; placeholder T-<EAN> até confirmar).',
    cor: 'A referência (ex IE3100) já é o colorway: cor sai da página oficial da referência.',
    foto: 'adidas.com.br só pelo navegador: fetch("/api/products/<ARTIGO>") → view_list.',
    armadilhas: ['Erro 2026-06-09: tamanhos chutados de 829 códigos — nunca deduzir tamanho da NF-e.'],
  },
  PUMA: {
    fornecedores: ['DRASTOSA'],
    nfe: 'cProd "ESTILO   CORTAM" (ex 404440   002038): estilo 6 dígitos + cor 3 + tamanho.',
    tamanho: 'Sufixo do cProd; acessórios usam PEQ/MED/GRD/EGR (são tamanhos).',
    cor: 'Código de cor no cProd; nome em inglês na NF-e (traduzir por extenso).',
    foto: 'images.puma.com/.../global/<estilo>/<cor2>/<sv01..|bv|mod01..>/fnd/BRA/...',
  },
  NIKE: {
    fornecedores: ['HAF'],
    nfe: 'Refs por tamanho, 1 EAN por ref.',
    cor: 'A NF-e NÃO traz a cor — colorway pela styleColor.',
    foto: 'api.nike.com product_feed v3 por styleColor (marketplace US).',
  },
  CONVERSE: {
    fornecedores: ['COOPERSHOES'],
    nfe: 'Ref CK/CT/CO + 8 dígitos (modelGroup = 6 primeiros).',
    foto: 'CDN converse.com.br/media/catalog/product/<r0>/<r1>/<ref>_<a-h>_08x1.jpg (placeholder de 1692 bytes = não existe).',
  },
  SKECHERS: {
    fornecedores: ['SKECHERS'],
    nfe: 'Ref LETRAS-ESTILO-COR-TAM (ex GTW-129627-ORG-34).',
    foto: 'images.skechers.com/<estilo>_<COR>_<vista>; códigos ...BR (só Brasil) não existem lá.',
    armadilhas: ['Nunca rodar split-por-código em marca já reconstruída; rebuild pela NF-e (2026-06-10).'],
  },
  ASICS: {
    fornecedores: ['DRASTOSA'],
    nfe: 'Ref "MODELO COR+TAM" (ex 1011B958 403039).',
    foto: 'asics.com.br VTEX ft=<estilo>, productReference <estilo>-<cor>; só modelos à venda.',
  },
  HOKA: {
    fornecedores: ['DR COMERCIO'],
    nfe: 'cProd ESTILO+COR+TAM (ex 1162011CBLL44); 1 card por ESTILO+COR.',
    cor: 'Decodificar o código de cor pelo cProd exato (ex CBLL = Cobalt Blue/Ultramarine).',
    armadilhas: ['Nunca unificar por foto de revendedor; Clifton masc 1162030 ≠ fem 1162031.'],
  },
  REEBOK: {
    fornecedores: ['RB BRASIL', 'SPORTCOM (bolas e acessórios)'],
    nfe: 'Calçado: 9 dígitos + M/W + 5 letras de cor + 2 de tamanho.',
    armadilhas: ['Bolas Sportcom: etiqueta diz "Vortex Beach", NF-e diz "Zig Generation Beach" (mesmo código) — 2026-11-18.'],
  },
  MIZUNO: { fornecedores: ['VULCABRAS'], nfe: 'Ref NUM-COR-TAM (ex 101060060-ROSA46-35).' },
  FILA: { fornecedores: ['FILA BRASIL'], nfe: 'Ref F##L#####-DESCRIÇÃO no nome; tamanho na DESCRIÇÃO.', armadilhas: ['Escreve a mesma ref com e sem o tamanho colado.'] },
  UMBRO: { fornecedores: ['DASS NORDESTE'], nfe: 'Ref U##FB#####-DESCRIÇÃO no nome; tamanho na DESCRIÇÃO.' },
  KAPPA: { fornecedores: ['VECTRON', 'SPR'], nfe: 'cProd K100.05.37 (ref.cor.tam).', armadilhas: ['K100/K101/K102 = cards diferentes mesmo com texto igual.'] },
  PENALTY: { fornecedores: ['CAMBUCI'], nfe: 'cProd = código + tamanho (2 dígitos ou -U).', foto: 'penalty.com.br VTEX por EAN.' },
  TOPPER: { fornecedores: ['TOPSHOES', 'BETEL', 'MUNDI'], foto: 'topper.com.br (plataforma Netshoes): linhas antigas não aparecem.' },
  OLYMPIKUS: { fornecedores: ['VULCABRAS'], foto: 'olympikus.com.br VTEX por EAN.' },
  'CAJU BRASIL': { fornecedores: ['TOP CONFECÇÕES'], nfe: 'cProd NNN.NNN+NNNNN+tam (ex 017.00701068P).', foto: 'cajubrasil.com.br VTEX productReference NNN.NNN-NNNNN.' },
  'BODY FOR SURE': { fornecedores: ['FILO'], nfe: 'Tamanho na descrição ("COR: NNN TAM: X"); cProd inteiro = ref.', armadilhas: ['Descrição igual com código diferente = produtos diferentes (2026-06-10).'] },
  LUPO: { fornecedores: ['LUPO S/A', 'LUPO NORDESTE'], nfe: 'Ref NNNNN-NNNNNNNNNN.', armadilhas: ['Cor/tamanho só nas CAIXAS.'] },
  DIADORA: { fornecedores: ['BRANDS BRASIL'], nfe: 'cProd = código de barras; ref no nome; tamanho no fim da descrição.' },
  SPEEDO: { fornecedores: ['HIPERFLEX'], nfe: 'cProd SPO01.01-02.36.', foto: 'Calçado Hiperflex não está no site da Speedo.' },
  SALOMON: { fornecedores: ['WINNERS'], foto: 'salomon.com bloqueia acesso direto.' },
  FIBER: { fornecedores: ['FIBER COMPANY'], nfe: 'Ref XXX-NNNN-VER-TAM.', armadilhas: ['Cor não é tamanho (protetor BLACK×GRAY, 2026-06-10).'] },
  KENNER: { fornecedores: ['TESS'], foto: 'kenner.com.br VTEX.' },
  OUS: { foto: 'ous.com.br VTEX, productReference <modelo>_<cor>.' },
  EVERLAST: { fornecedores: ['NESK'], nfe: 'cProd SEMA195.195B.38.' },
  JOMA: { fornecedores: ['FIRST SPORTS'] },
  KEMPA: { fornecedores: ['FIRST SPORTS'], armadilhas: ['Eagle Pro: NF-e diz PTO/BCO e a bola é vermelha/branca (2026-11-18).'] },
  SPALDING: { fornecedores: ['FIRST SPORTS'] },
  KAGIVA: { fornecedores: ['MUNDI MERCANTIL'], nfe: 'cProd = código interno impresso na bola ("CÓD 7453" = 000007453); SUB 7/9/11/13 = refs 7384/7383/7382/7381.', armadilhas: ['Card "SUB 11" ainda guarda o código da SUB 9 — separar.'] },
  MIKASA: { fornecedores: ['BR8'], nfe: 'cProd MK000xxx, muitos itens SEM EAN na NF-e.', armadilhas: ['Código 4907225881154 é V390W (etiqueta), não V360W.'] },
  'NEW BALANCE': { fornecedores: ['NEW BRASIL'], foto: 'newbalance.com.br VTEX.' },
  'UNDER ARMOUR': { fornecedores: ['VULCABRAS'], foto: 'underarmour.com.br VTEX.' },
};

function ficha(k) {
  return FICHAS[k] || null;
}

module.exports = { chave, normalizar, ficha, FICHAS, SEM_MARCA };
