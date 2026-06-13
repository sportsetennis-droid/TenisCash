// =====================================================================
// CÉREBRO DE MARCA — conhecimento por marca pra CLASSIFICAR sem chutar.
// =====================================================================
// Cada marca escreve o nome do produto do seu jeito e tem suas LINHAS de modelo.
// Daqui sai: CATEGORIA + SUBCATEGORIA(gênero) + MODALIDADE.
// ⛔ ESPECIALIDADE (tier) NÃO é chutada — vem da descrição técnica/humano (regra do dono).
// Quando a linha/gênero não dá pra saber com certeza → retorna null/parcial → vai pro humano.
//
// Hoje: NIKE. Outras marcas entram aqui depois (uma de cada vez, ensinadas pelo dono).
// =====================================================================

const up = (s) => String(s || '').toUpperCase();

// ---- NIKE: linha de modelo -> modalidade ----
const NIKE = {
  // corrida (adulto=Corrida, infantil=Corridinha — resolvido por idade lá embaixo)
  corrida: /\b(REVOLUTION|VOMERO|PEGASUS|DOWNSHIFTER|RUN ?DEFY|FLEX ?RUNNER|WINFLO|STRUCTURE|INTERVAL|ZOOM ?FLY|STREAKFLY|INFINITY ?RN|PACER|JUNIPER|MILER|RIVAL ?FLY)\b/,
  basquete: /\b(JORDAN|LEBRON|KD|KYRIE|GIANNIS|FREAK|COSMIC|SABRINA)\b/,
  treino: /\b(METCON|RENEW|SUPERREP|FLEXMETHOD|ZOOM ?TR)\b/,
  estiloVida: /\b(COURT|BLAZER|AIR ?FORCE|FORCE ?1|AF1|DUNK|CORTEZ|KILLSHOT|TANJUN|REVOLT|WAFFLE|FIELD ?GENERAL)\b/,
  futebol: /\b(BECO|PHANTOM|MERCURIAL|TIEMPO|PREMIER|LEGEND)\b/,
};

// Devolve {category, modality} pela LINHA do modelo (sem gênero ainda).
// modality '__CORRIDA__' = resolver Corrida/Corridinha por idade.
// modality null = sabe a categoria mas não a quadra (humano decide).
function nikeLine(name) {
  const n = up(name);
  // FUTEBOL -> Chuteiras (modalidade pela quadra: IC=Futsal, TF=Society, FG/SG/AG/Campo=Campo)
  if (NIKE.futebol.test(n) || /\bFUTSAL\b|\bSOCIETY\b|\bCAMPO\b/.test(n) || /\b(IC|TF|FG|SG|AG)\b/.test(n)) {
    let modality = null;
    if (/\bTF\b|SOCIETY/.test(n)) modality = 'Society';
    else if (/\b(FG|SG|AG)\b|CAMPO/.test(n)) modality = 'Campo';
    else if (/\bIC\b|FUTSAL/.test(n)) modality = 'Futsal';
    return { category: 'Chuteiras', modality };
  }
  if (NIKE.corrida.test(n)) return { category: 'Tênis', modality: '__CORRIDA__' };
  if (NIKE.basquete.test(n)) return { category: 'Tênis', modality: 'Basquete' };
  if (NIKE.treino.test(n)) return { category: 'Tênis', modality: 'Musculação/Crossfit' };
  if (NIKE.estiloVida.test(n)) return { category: 'Tênis', modality: 'Estilo de Vida' };
  // desconhecido de propósito: SB/Skate (árvore não tem Skate ainda), Air Max (dono não decidiu) -> humano
  return null;
}

// Gênero pela escrita do nome. '__KIDS__' = infantil sem dizer menino/menina (humano decide a subcategoria).
function genderOf(name) {
  const n = up(name);
  if (/FEMININO|WMNS|\bW ?NIKE|^W\b/.test(n)) return 'Mulher';
  if (/MASCULINO|\bMENS\b/.test(n)) return 'Homem';
  if (/INFANTIL|JUVENIL|KIDS|\bGS\b|\bPS\b|\bTD\b/.test(n)) return '__KIDS__';
  return null;
}

// Classifica um produto da marca. Retorna {category, subcategory, modality, gender} — campos
// que não dá pra saber com certeza voltam null (NUNCA chuta). specialty nunca sai daqui.
function classify(brand, name) {
  if (!/nike/i.test(brand || '')) return null; // só Nike por enquanto
  const line = nikeLine(name);
  if (!line) return null; // linha desconhecida -> humano
  const g = genderOf(name);

  let subcategory = null;
  if (line.category === 'Chuteiras') {
    if (g === 'Homem') subcategory = 'Homem';
    else if (g === '__KIDS__') subcategory = 'Menino'; // chuteira infantil na árvore = Menino
    // Mulher em chuteira: árvore não tem -> humano
  } else { // Tênis
    if (g === 'Mulher') subcategory = 'Mulher';
    else if (g === 'Homem') subcategory = 'Homem';
    // __KIDS__ no Tênis: menino/menina indefinido -> humano (subcategory null)
  }

  let modality = line.modality;
  if (modality === '__CORRIDA__') modality = (g === '__KIDS__') ? 'Corridinha' : 'Corrida';

  return { category: line.category, subcategory, modality, gender: g };
}

module.exports = { classify, nikeLine, genderOf };
