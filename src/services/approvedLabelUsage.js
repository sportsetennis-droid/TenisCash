// Text approved by the store owner, before printing the combined campaign.
module.exports = function approvedUsage(name, brand, modality) {
  const casual = ['USO CASUAL', 'E DIA A DIA'];
  if (/^(CONVERSE|ALL ?STAR)$/.test(brand)) return ['O TÊNIS MAIS DESEJADO', 'DO MUNDO.'];
  if (brand === 'KAPPA') {
    // References verified against model listings; training level approved by owner.
    if (/\bK(102|111)\b/.test(name)) return ['FUTSAL', 'PARA TREINO'];
    if (/\bK(101|110|116|119)\b/.test(name)) return ['SOCIETY', 'PARA TREINO'];
    if (/\bK(100|109|118)\b/.test(name)) return ['FUTEBOL DE CAMPO', 'PARA TREINO'];
  }
  if (brand === 'FILA') {
    if (/SKY\s*TRAIL|SKT\s*TRAIL/.test(name)) return ['CORRIDA EM TRILHAS', 'ATÉ 21 KM'];
    if (/SPEEDZONE|XTREME|MAXXI.*PRO/.test(name)) return ['CORRIDA', 'ATÉ 21 KM'];
    if (/FLOAT.*MAXXI.*2/.test(name)) return ['CORRIDA', 'ATÉ 10 KM'];
    if (/FASTPACE/.test(name)) return ['CORRIDA', 'ATÉ 5 KM'];
    if (/DRIFTER|CHINELO|SLIDE/.test(name)) return ['DIA A DIA', 'E LAZER'];
    if (/ACD|RENNO|COURT\s*80|DAILY|DISRUPTOR|CORDA/.test(name)) return casual;
    if (/RECOVERY|COMET|IMPROVE|FASTNESS|STRIKER|NAIROBI|MAXXIMUS|ENDURANCE|SPRITZ|FREESTYLE|DIFFUSION|PROGRESS|EFECTO|MAXXI\s*LITE/.test(name)) return ['CORRIDA', 'E TREINO LEVE'];
  }
  if (brand === 'DIADORA') {
    if (/STRATUS|VULCANO|GIOVE|LEGGENDA|ILLUSIONE|SAGA/.test(name)) return ['CAMINHADA, CORRIDA', 'E TREINO LEVE'];
    if (/MONZA|MODENA|MARINO|SFORZA|CENTRALE|PLAYMAKER|ESSENZIALE/.test(name)) return casual;
  }
  if (brand === 'SPEEDO') {
    if (/CHINELO|SANDALIA|SLIDE/.test(name)) return ['DIA A DIA', 'E LAZER'];
    if (/SPO[ -]?(100|110|140)\b/.test(name) || /CASUAL|ESTILO DE VIDA|LIFE.?STYLE/.test(modality)) return casual;
    if (/CORRIDA|CAMINHADA|TREINO/.test(modality)) return ['CAMINHADA, CORRIDA', 'E TREINO LEVE'];
  }
  if (brand === 'OUS') {
    if (/PHIBO|HEVEA/.test(name)) return casual;
    if (/IMIGRANTE|UENO|EMERGENTE|ARQ|2K|NACC|FLUENTE/.test(name)) return ['SKATE', 'E DIA A DIA'];
  }
  if (brand === 'EVERLAST') {
    if (/SOLO|BLAZER|NEW\s*YORK/.test(name)) return casual;
    if (/STATION|FORCEKNIT|RING\s*(4|IV)|CLIMBER\s*(PRO|ULTRA)/.test(name)) return ['TREINO DE FORÇA E ACADEMIA', 'CROSS E FUNCIONAL'];
  }
  if (brand === 'OLYMPIKUS') {
    if (/CORRE.*TRILHA/.test(name)) return ['CORRIDA EM TRILHAS', 'LONGAS DISTÂNCIAS'];
    if (/JOGGING/.test(name)) return casual;
    if (/VENUM/.test(name)) return ['DIA A DIA', 'E BRINCADEIRAS'];
    // Owner's wording for sporting use; stable across imported colour variants.
    if (/CHALLENGER|REVERSO|COSMO|VIRTUOSE|FLIT|GIRO|MESCLA|ORBITA|PURPURA|RITMO|ZEX/.test(name)) return ['CORRIDA', 'E TREINO LEVE'];
  }
  let activity = /FUTSAL|FSAL|INDOOR/.test(name) ? 'FUTSAL' : /SOCIETY|SCTY/.test(name) ? 'SOCIETY' : /CAMPO/.test(name) ? 'FUTEBOL DE CAMPO'
    : /FUTSAL/.test(modality) ? 'FUTSAL' : /SOCIETY/.test(modality) ? 'SOCIETY' : /CAMPO/.test(modality) ? 'FUTEBOL DE CAMPO' : null;
  if (brand === 'TOPPER') {
    if (/FUSE/.test(name)) return ['FUTSAL', 'PROFISSIONAL'];
    if (activity && /DOMINATOR.*PRO/.test(name)) return [activity, 'PROFISSIONAL'];
    if (activity && /TOP\s*CUP|BOLEIRO|VOLEIRO/.test(name)) return [activity, 'PARA INICIANTES'];
    if (activity && /MAESTRO|LETRA|FURIA/.test(name)) return [activity, 'PARA TREINO'];
  }
  if (brand === 'UMBRO' && activity) {
    if (/CLUB|ADAMANT/.test(name) && !/ADAMANT.*\bPRO\b/.test(name)) return [activity, 'PARA TREINO'];
    if (/ADAMANT.*\bPRO\b/.test(name)) return [activity, 'PROFISSIONAL'];
    if (/ACTION|FORCE|ORBIT|CANNON/.test(name)) return [activity, 'PARA INICIANTES'];
    if (/SCORE.*GRAVITY/.test(name)) return [activity, 'INICIANTES E TREINO'];
    if (/VELOCITA.*PREMIER/.test(name)) return [activity, 'PARA TREINO'];
  }
  if (brand === 'JOMA' && activity) {
    if (/TOP\s*FLEX.*(JR|JUNIOR)|EVOLUTION/.test(name)) return [activity, /TOP\s*FLEX/.test(name) ? 'TREINOS E JOGOS' : 'PARA TREINO'];
    if (/AGUILA.*CUP|REGATE|TOP\s*FLEX/.test(name)) return [activity, 'PROFISSIONAL'];
    if (/FS.*REACTIVE/.test(name)) return [activity, 'JOGOS INTENSOS'];
    if (/DRIBLING|MAXIMA|CANCHA|AGUILA/.test(name)) return [activity, 'PARA TREINO'];
  }
  return null;
};
