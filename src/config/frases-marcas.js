// FRASES POR MARCA — a linha que aparece logo abaixo do nome do produto na etiqueta.
//
// Regra que vale aqui (definida com o dono):
//  1. A frase precisa ser VERDADE — se afirmar algo, tem que ser comprovável.
//  2. A frase só trabalha se o que ela afirma for EXCLUSIVO daquela marca.
//     Palavra de categoria ("conforto", "qualidade", "tecnologia") sozinha o cliente pula.
//  3. NUNCA transferir frase entre marcas: cada marca está num momento diferente
//     na cabeça do cliente.
//
// Quando a marca não tem frase aqui, a etiqueta continua usando a classificação
// do produto (Modalidade/Especialidade), como sempre foi.

const FRASES_POR_MARCA = {
  // Marca italiana (1911); os 661 produtos Fila do catálogo têm origem fiscal
  // 0 = NACIONAL, ou seja, fabricados no Brasil. A frase é fato, não retórica.
  // Quebrada em duas linhas de propósito: linha curta = fonte maior = lê de longe.
  fila: 'ORIGEM ITALIANA,\nCONFORTO BRASILEIRO',
};

function normalizarMarca(marca) {
  return String(marca || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Devolve a frase da marca, ou null se essa marca ainda não tem frase própria. */
function fraseDaMarca(marca) {
  const chave = normalizarMarca(marca);
  if (!chave) return null;
  return FRASES_POR_MARCA[chave] || null;
}

module.exports = { FRASES_POR_MARCA, fraseDaMarca, normalizarMarca };
