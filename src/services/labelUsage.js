const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

// Short use cases, not performance promises. Model overrides take precedence
// over imported classifications (e.g. Recovery is not recovery footwear).
function labelUsage(product, classification = {}) {
  const name = norm(product?.name || product?.originalProductName || product?.productName);
  const brand = norm(product?.brand);
  const modality = norm(classification.modality || product?.modality);
  const approved = require('./approvedLabelUsage')(name, brand, modality);
  if (approved) return approved;
  if (brand === 'MIZUNO') {
    if (/MORELIA\s*SALA\s*PRO/.test(name)) return ['FUTSAL', 'PROFISSIONAL'];
    if (/MORELIA\s*II\s*PRO/.test(name)) return ['FUTEBOL DE CAMPO', 'PROFISSIONAL'];
  }
  if (brand === 'KAPPA' && /CHUTEIRAS?/.test(name + ' ' + norm(product?.category))) {
    const surface = name + ' ' + modality;
    const activity = /FUTSAL|\bINDOOR\b/.test(surface) ? 'FUTSAL'
      : /SOCIETY/.test(surface) ? 'SOCIETY'
      : /\bCAMPO\b/.test(surface) ? 'FUTEBOL DE CAMPO' : 'CHUTEIRA';
    return [activity, 'PARA TREINO'];
  }
  const casual = ['USO CASUAL', 'E DIA A DIA'];
  // Store-approved classification for the Munich futsal models in the catalog.
  if (brand === 'MUNICH' && (/GRESCA\s*2[.,]0|CONTINENTAL\s*V2/.test(name) || /FUTSAL/.test(modality))) {
    return ['FUTSAL', 'PROFISSIONAL'];
  }
  if (brand === 'EVERLAST') {
    if (/CLIMBER\s*RUN/.test(name)) return ['CAMINHADA', 'E CORRIDA LEVE'];
    if (/CLIMBER\s*(PRO|ULTRA)/.test(name)) return ['TREINO DE FORÇA', 'CROSS E FUNCIONAL'];
    if (/STATION|FORCEKNIT|RING\s*(4|IV)/.test(name)) return ['ACADEMIA', 'E TREINO DE FORÇA'];
    if (/\bSOLO\b/.test(name)) return ['CAMINHADA', 'E DIA A DIA'];
    if (/BLAZER|NEW\s*YORK/.test(name)) return casual;
  }
  if (brand === 'FILA') {
    if (/RECOVERY|SPRITZ|STRIKER|MAXXI\s*LITE|DIFFUSION|PROGRESS\s*LITE|FREESTYLE|GO\s*TRAINER|STREET\s*FIT/.test(name)) return ['ACADEMIA', 'E TREINO'];
    if (/SKY\s*TRAIL/.test(name)) return ['CORRIDA', 'EM TRILHAS'];
    if (/RACER|FLOAT\s*MAXXI|MAXXIMUS|COMET|FASTNESS|ENDURANCE/.test(name)) return ['PARA CORRIDA', ''];
    if (/ACD\s*CLASSIC|RENNO|COURT\s*80|DAILY|CORDA/.test(name)) return casual;
  }
  const surface = name + ' ' + modality;
  if (/FUTSAL|\bINDOOR\b/.test(surface)) return ['PARA FUTSAL', ''];
  if (/SOCIETY/.test(surface)) return ['PARA SOCIETY', ''];
  if (/\bCAMPO\b/.test(surface)) return ['FUTEBOL DE CAMPO', ''];
  if (/CHINELO|SANDALIA|DRIFTER/.test(name + ' ' + modality)) return ['DIA A DIA', 'E LAZER'];
  if (brand === 'OLYMPIKUS' && /PURPURA/.test(name)) return ['DIA A DIA', 'E CAMINHADA'];
  if (/CORRIDA|RUNNING/.test(modality)) return ['PARA CORRIDA', ''];
  if (/CAMINHADA/.test(modality)) return ['PARA CAMINHADA', ''];
  if (/TREINO|MUSCULACAO|CROSS/.test(modality)) return ['ACADEMIA', 'E TREINO'];
  if (/CASUAL|ESTILO DE VIDA|LIFESTYLE|LIFE STYLE/.test(modality)) return casual;
  if (['SPEEDO','OUS','CONVERSE','ALLSTAR','ALL STAR'].includes(brand) || (brand === 'REEBOK' && /STREET\s*RIDE/.test(name))) return casual;
  return null;
}
module.exports = { labelUsage };
