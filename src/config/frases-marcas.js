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
  // Duas linhas de propósito: linha curta = fonte maior = lê de longe.
  // Sem vírgula: a quebra de linha já faz a pausa, a vírgula vira sujeira.
  fila: 'ORIGEM ITALIANA\nCONFORTO BRASILEIRO',

  // 3ª maior empresa de calçados do mundo em receita (2024: US$ 8,97 bi — só
  // Nike e adidas vendem mais). Escolhida pelo dono: a marca sofre de "não
  // existe na cabeça do cliente", então a frase cria legitimidade antes de
  // descrever produto. ATENÇÃO: é dado de ranking — se mudar, trocar a frase.
  skechers: '3ª MAIOR DO MUNDO\nCONFORTO O DIA TODO',

  // O Freestyle (1982) foi o primeiro tênis esportivo feito para mulher e criou
  // a categoria de calçado de aeróbica/academia. Pioneirismo é fato e é só dela —
  // por isso a frase afirma o que ela INVENTOU, não o tamanho que ela tem.
  reebok: 'INVENTOU O TÊNIS DE ACADEMIA\nA MARCA DO FITNESS',

  // Puma × Jil Sander (1998) foi a primeira parceria entre marca esportiva e
  // estilista de alta-costura — abriu a porta que Nike e adidas atravessaram
  // depois. Some o Clyde (1973) virando moda de rua e o Fenty da Rihanna (2015).
  // No estoque da loja a Puma é 50% vestuário: a frase cobre a marca inteira,
  // não só as 6 chuteiras.
  puma: 'CRIOU O ESTILO DE VIDA\nESPORTIVO NA MODA',
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
