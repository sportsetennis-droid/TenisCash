// =====================================================================
// FRONTS — frentes de inteligência de mídia internacional sobre o Brasil
// =====================================================================
// Cada "front" é um tema/região que um agente vai pesquisar (busca web nativa
// do Claude) procurando o que falam do Brasil na Copa — com foco no que a
// imprensa brasileira NÃO valoriza. O orquestrador cria 1 agente por front.
// =====================================================================

const FRONTS = [
  {
    id: 'argentina', label: 'Argentina', lang: 'es',
    outlets: ['Olé', 'TyC Sports', 'Clarín', 'La Nación'],
    focus: 'rivalidade histórica; como veem a Seleção e os craques do Brasil hoje; provocações e elogios',
  },
  {
    id: 'inglaterra', label: 'Inglaterra / Reino Unido', lang: 'en',
    outlets: ['BBC Sport', 'The Guardian', 'The Athletic', 'The Telegraph'],
    focus: 'análise tática britânica sobre o Brasil; jogadores brasileiros na Premier League vistos por lá',
  },
  {
    id: 'espanha', label: 'Espanha', lang: 'es',
    outlets: ['Marca', 'AS', 'Mundo Deportivo', 'Sport'],
    focus: 'leitura espanhola do Brasil; comparações com a Espanha; brasileiros em LaLiga',
  },
  {
    id: 'franca', label: 'França', lang: 'fr',
    outlets: ["L'Équipe", 'RMC Sport', 'Le Parisien'],
    focus: 'visão francesa do Brasil (histórico 1998/2006); brasileiros na Ligue 1',
  },
  {
    id: 'italia', label: 'Itália', lang: 'it',
    outlets: ['La Gazzetta dello Sport', 'Corriere dello Sport', 'Tuttosport'],
    focus: 'leitura tática italiana; memória de 1982/1994; técnicos italianos e o Brasil (Ancelotti)',
  },
  {
    id: 'marrocos', label: 'Marrocos / Mundo Árabe (ADVERSÁRIO DE HOJE)', lang: 'fr/ar/en',
    outlets: ['Hespress', 'Le360', 'beIN Sports', 'imprensa marroquina'],
    focus: 'como o Marrocos e a imprensa árabe encaram enfrentar o Brasil HOJE; respeito/medo/confiança',
    priority: true,
  },
  {
    id: 'eua', label: 'EUA (PAÍS-SEDE)', lang: 'en',
    outlets: ['ESPN', 'The Athletic', 'Fox Sports', 'CBS Sports'],
    focus: 'cobertura americana do Brasil como atração da Copa em casa; star power; torcida brasileira nos EUA',
  },
  {
    id: 'portugal', label: 'Portugal', lang: 'pt-PT',
    outlets: ['A Bola', 'Record', 'O Jogo'],
    focus: 'olhar português sobre a Seleção e os brasileiros no futebol europeu',
  },
  {
    id: 'africa', label: 'África (pan-africana)', lang: 'en/fr',
    outlets: ['BBC Africa', 'Africa Foot', 'imprensa africana'],
    focus: 'como a África vê o Brasil; conexão histórica/afetiva Brasil-África no futebol',
  },
  {
    id: 'alemanha', label: 'Alemanha', lang: 'de',
    outlets: ['Kicker', 'Bild', 'SPORT1'],
    focus: 'memória do 7x1; respeito atual ao Brasil; brasileiros na Bundesliga',
  },
];

module.exports = { FRONTS };
