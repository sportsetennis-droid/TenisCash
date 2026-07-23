// Producao diaria do vendedor — politica Sports & Tennis.
// Regras ficam centralizadas para a API, a interface e os testes usarem a
// mesma definicao. Penalidades trabalhistas nunca sao aplicadas aqui.

const crypto = require('crypto');
const vision = require('./sellerProductionVision');

const POLICY_VERSION = 'ST-PRODUCAO-2026-07-V2';
const INCENTIVE_PCT = 10;

const REQUIRED = Object.freeze({
  ARRIVAL_STORY: ['sellerName', 'shiftHours', 'availableForSales', 'date', 'openingHours', 'storeLocation'],
  ARRIVAL_REEL: ['sellerName', 'shiftHours', 'availableForSales', 'whatsappReposted'],
  PRODUCT_REEL: ['priceInformed', 'maxDiscountInformed', 'technologiesExplained', 'differentialsExplained', 'whatsappReposted'],
  EXIT_STORY: ['customersThanked', 'nextDayAvailabilityInformed'],
  EXIT_REEL: ['customersThanked', 'nextDayAvailabilityInformed', 'whatsappReposted'],
  BAG_PHOTO: ['closedBagExternalPhoto'],
  FLOOR_CLEANING: ['floorCleanAndDry'],
  STORE_ORGANIZATION: ['storeOrganized'],
  PRODUCT_LOCATION: ['productsInCorrectPlaces'],
  STORE_PHONE: ['storePhoneChargedWhenIdle', 'problemReportedIfAny'],
  CARD_MACHINE: ['cardMachineChargedWhenIdle', 'problemReportedIfAny'],
  PACKAGING: ['packagingChecked', 'shortageReportedIfAny'],
});

function buildRules() {
  const rules = [];
  const add = (rule) => rules.push(Object.freeze({ position: rules.length, ...rule }));

  add({ key: 'ARRIVAL_STORY_1', phase: 'ARRIVAL', title: 'Chegada — Story com foto da loja aberta', mediaType: 'photo', requirementSet: 'ARRIVAL_STORY', socialStory: true });
  add({ key: 'ARRIVAL_REEL_1', phase: 'ARRIVAL', title: 'Chegada — Reels da loja (aprox. 20 segundos)', mediaType: 'video', targetDurationSec: 20, requirementSet: 'ARRIVAL_REEL', whatsappRequired: true, socialReel: true });
  add({ key: 'ARRIVAL_BAG_PHOTO', phase: 'ARRIVAL', title: 'Chegada — foto externa da bolsa fechada', mediaType: 'photo', requirementSet: 'BAG_PHOTO', internalOnly: true, purpose: 'Controle interno de entrada e saída de volumes, sem inspeção do conteúdo.' });
  add({ key: 'FLOOR_CLEAN_PHOTOS', phase: 'ARRIVAL', title: 'Loja — fotos do piso limpo e seco', mediaType: 'photo', requirementSet: 'FLOOR_CLEANING', internalOnly: true });
  add({ key: 'STORE_ORGANIZATION_PHOTOS', phase: 'ARRIVAL', title: 'Loja — fotos da arrumação geral', mediaType: 'photo', requirementSet: 'STORE_ORGANIZATION', internalOnly: true });
  add({ key: 'PRODUCT_LOCATION_PHOTOS', phase: 'ARRIVAL', title: 'Loja — produtos nos locais corretos', mediaType: 'photo', requirementSet: 'PRODUCT_LOCATION', internalOnly: true });
  add({ key: 'STORE_PHONE_READY', phase: 'ARRIVAL', title: 'Loja — celular carregado ou no carregador quando sem uso', mediaType: 'photo', requirementSet: 'STORE_PHONE', internalOnly: true });
  add({ key: 'CARD_MACHINE_READY', phase: 'ARRIVAL', title: 'Loja — maquineta carregada ou no carregador quando sem uso', mediaType: 'photo', requirementSet: 'CARD_MACHINE', internalOnly: true });
  add({ key: 'PACKAGING_CHECK', phase: 'ARRIVAL', title: 'Loja — embalagens conferidas e falta comunicada', mediaType: 'photo', requirementSet: 'PACKAGING', internalOnly: true });

  for (let i = 1; i <= 2; i += 1) {
    add({ key: `FIRST_TURN_REEL_${i}`, phase: 'FIRST_TURN', title: `Primeiro turno — Reels de produtos ${i}/2`, mediaType: 'video', targetDurationSec: 45, exactDuration: true, requiredProducts: 3, requirementSet: 'PRODUCT_REEL', productReel: true, whatsappRequired: true, socialReel: true });
  }
  for (let i = 1; i <= 5; i += 1) {
    add({ key: `FIRST_TURN_STORY_${i}`, phase: 'FIRST_TURN', title: `Primeiro turno — Foto de produto ${i}/5`, mediaType: 'photo', productStory: true, socialStory: true });
  }

  for (let i = 1; i <= 2; i += 1) {
    add({ key: `SECOND_TURN_REEL_${i}`, phase: 'SECOND_TURN', title: `Segundo turno — Reels de produtos ${i}/2`, mediaType: 'video', targetDurationSec: 45, exactDuration: true, requiredProducts: 3, requirementSet: 'PRODUCT_REEL', productReel: true, whatsappRequired: true, socialReel: true });
  }
  for (let i = 1; i <= 5; i += 1) {
    add({ key: `SECOND_TURN_STORY_${i}`, phase: 'SECOND_TURN', title: `Segundo turno — Foto de produto ${i}/5`, mediaType: 'photo', productStory: true, socialStory: true });
  }

  add({ key: 'EXIT_STORY_1', phase: 'EXIT', title: 'Saída — Story com foto da loja', mediaType: 'photo', requirementSet: 'EXIT_STORY', socialStory: true });
  add({ key: 'EXIT_REEL_1', phase: 'EXIT', title: 'Saída — Reels de agradecimento', mediaType: 'video', requirementSet: 'EXIT_REEL', whatsappRequired: true, socialReel: true });
  add({ key: 'EXIT_BAG_PHOTO', phase: 'EXIT', title: 'Saída — foto externa da bolsa fechada', mediaType: 'photo', requirementSet: 'BAG_PHOTO', internalOnly: true, purpose: 'Controle interno de entrada e saída de volumes, sem inspeção do conteúdo.' });
  return Object.freeze(rules);
}

const RULES = buildRules();
const RULE_BY_KEY = new Map(RULES.map((rule) => [rule.key, rule]));
const POLICY_DIGEST = crypto.createHash('sha256').update(JSON.stringify({ version: POLICY_VERSION, incentivePct: INCENTIVE_PCT, rules: RULES, required: REQUIRED })).digest('hex');

function ruleForKey(key) {
  return RULE_BY_KEY.get(String(key || '').toUpperCase()) || null;
}

function requiredConfirmations(rule) {
  return rule?.requirementSet ? [...(REQUIRED[rule.requirementSet] || [])] : [];
}

function normalizeProductRef(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

function parseConfirmations(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function validateSubmission(rule, payload, context = {}) {
  const errors = [];
  if (!rule) return ['Atividade invalida.'];

  const publicationUrl = String(payload.publicationUrl || '').trim();
  const whatsappProofUrl = String(payload.whatsappProofUrl || '').trim();
  const evidenceMediaTypes = Array.isArray(context.evidenceMediaTypes) ? context.evidenceMediaTypes : [];
  const evidenceKinds = Array.isArray(context.evidenceKinds) ? context.evidenceKinds : [];
  const hasExpectedUpload = evidenceMediaTypes.includes(rule.mediaType);
  if (rule.mediaType === 'video' && !isHttpUrl(publicationUrl)) {
    errors.push('Informe o link do Reels publicado no feed da loja.');
  } else if (!hasExpectedUpload && !isHttpUrl(publicationUrl)) {
    errors.push(rule.internalOnly
      ? 'Envie a foto/print ou informe o link da evidencia privada.'
      : `Envie ${rule.mediaType === 'photo' ? 'a foto' : 'o video'} ou informe o link da publicacao.`);
  }
  if (publicationUrl && !isHttpUrl(publicationUrl)) errors.push(rule.internalOnly ? 'O link da evidencia e invalido.' : 'O link da publicacao e invalido.');

  const confirmations = parseConfirmations(payload.requirementsConfirmedJson || payload.confirmations);
  for (const key of requiredConfirmations(rule)) {
    if (confirmations[key] !== true) errors.push(`Confirme o requisito: ${key}.`);
  }

  if (rule.socialReel && payload.noInstagramStoryConfirmed !== true && payload.noInstagramStoryConfirmed !== 'true') {
    errors.push('Confirme que o Reels nao foi repostado no Story do Instagram.');
  }

  if (rule.whatsappRequired) {
    const hasWhatsappEvidence = evidenceKinds.includes('WHATSAPP_PROOF') || isHttpUrl(whatsappProofUrl);
    if (!hasWhatsappEvidence) errors.push('Envie a prova ou o link do status do WhatsApp da loja.');
    if (whatsappProofUrl && !isHttpUrl(whatsappProofUrl)) errors.push('O link da prova do WhatsApp e invalido.');
  }

  if (rule.targetDurationSec) {
    const duration = Number(payload.durationSeconds);
    if (!Number.isInteger(duration) || duration <= 0) errors.push('Informe a duracao do video em segundos.');
    else if (rule.exactDuration && duration !== rule.targetDurationSec) errors.push(`O Reels deve ter ${rule.targetDurationSec} segundos.`);
  }

  if (rule.requiredProducts) {
    const normalized = [...new Set((payload.productRefs || []).map(normalizeProductRef).filter(Boolean))];
    if (normalized.length < rule.requiredProducts) errors.push(`Informe pelo menos ${rule.requiredProducts} produtos diferentes.`);
    const usedToday = new Set((context.usedProductRefs || []).map(normalizeProductRef).filter(Boolean));
    const repeated = normalized.filter((ref) => usedToday.has(ref));
    if (repeated.length) errors.push(`Produto repetido no mesmo dia: ${repeated.join(', ')}.`);
  }

  return errors;
}

/**
 * Decide se uma atividade pode ser fiscalizada imediatamente pelo robô.
 * A decisão é deliberadamente limitada a fatos verificáveis no envio:
 * arquivo não vazio, tipo correto, hash sem duplicidade e campos que já
 * passaram por validateSubmission. Conteúdo visual que não puder ser
 * comprovado automaticamente continua na fila para revisão humana.
 */
function automaticSubmissionReviewLegacy({ rule, payload = {}, evidence = [] } = {}) {
  if (!rule) return { approved: false, reason: 'Regra da atividade não encontrada.' };

  const rows = Array.isArray(evidence) ? evidence : [];
  const validationErrors = validateSubmission(rule, payload, {
    evidenceMediaTypes: rows.map((entry) => entry.mediaType).filter(Boolean),
    evidenceKinds: rows.map((entry) => entry.kind).filter(Boolean),
  });
  if (validationErrors.length) {
    return { approved: false, reason: validationErrors.join(' ') };
  }
  const flagged = rows.find((entry) => {
    const checks = entry?.automatedChecks || {};
    return entry?.automatedStatus === 'FLAGGED_DUPLICATE'
      || checks.exactDuplicateDetected
      || checks.fileNonEmpty === false
      || checks.mediaTypeMatches === false;
  });
  if (flagged) {
    return { approved: false, reason: 'Evidência duplicada ou tecnicamente inconsistente.' };
  }

  const missingIntegrity = rows.find((entry) => {
    const checks = entry?.automatedChecks || {};
    return !checks.hashCaptured || checks.fileNonEmpty !== true;
  });
  if (missingIntegrity) {
    return { approved: false, reason: 'Evidência sem integridade técnica confirmada.' };
  }

  // validateSubmission já conferiu links, confirmações, duração, produtos e
  // prova do WhatsApp. O robô só registra a decisão automática; ele não
  // inventa aprovação quando o envio não passou por aquela validação.
  return {
    approved: true,
    note: 'Aprovada automaticamente: requisitos, evidências e integridade técnica conferidos pelo robô.',
    payload,
  };
}

async function automaticSubmissionReview({ rule, payload = {}, evidence = [], visualReview = null } = {}) {
  if (!rule) return { approved: false, rejected: false, needsHumanReview: true, reason: 'Regra da atividade não encontrada.' };

  const rows = Array.isArray(evidence) ? evidence : [];
  const validationErrors = validateSubmission(rule, payload, {
    evidenceMediaTypes: rows.map((entry) => entry.mediaType).filter(Boolean),
    evidenceKinds: rows.map((entry) => entry.kind).filter(Boolean),
  });
  if (validationErrors.length) return { approved: false, rejected: true, needsHumanReview: false, reason: validationErrors.join(' ') };

  const flagged = rows.find((entry) => {
    const checks = entry?.automatedChecks || {};
    return entry?.automatedStatus === 'FLAGGED_DUPLICATE'
      || checks.exactDuplicateDetected
      || checks.fileNonEmpty === false
      || checks.mediaTypeMatches === false;
  });
  if (flagged) return { approved: false, rejected: true, needsHumanReview: false, reason: 'Evidência duplicada ou tecnicamente inconsistente.' };

  const missingIntegrity = rows.find((entry) => {
    const checks = entry?.automatedChecks || {};
    return !checks.hashCaptured || checks.fileNonEmpty !== true;
  });
  if (missingIntegrity) return { approved: false, rejected: true, needsHumanReview: false, reason: 'Evidência sem integridade técnica confirmada.' };

  const visual = visualReview || await vision.reviewSubmission({ rule, payload, evidence: rows });
  const decision = String(visual?.decision || 'REVIEW').toUpperCase();
  const confidence = Math.round(Number(visual?.confidence || 0) * 100);
  if (decision === 'APPROVE') {
    return {
      approved: true,
      rejected: false,
      needsHumanReview: false,
      note: `Aprovada instantaneamente pela conferência visual (${confidence}%): ${visual.reason}`,
      visual,
      payload,
    };
  }
  if (decision === 'REJECT') {
    return {
      approved: false,
      rejected: true,
      needsHumanReview: false,
      reason: `Devolvida instantaneamente pela conferência visual (${confidence}%): ${visual.reason}`,
      visual,
      payload,
    };
  }
  return {
    approved: false,
    rejected: false,
    needsHumanReview: true,
    reason: `Aguardando conferência humana: ${visual?.reason || 'resultado visual inconclusivo.'}`,
    visual,
    payload,
  };
}

function dayProgress(items) {
  const rows = Array.isArray(items) ? items : [];
  const total = rows.length;
  const approved = rows.filter((item) => ['APPROVED', 'EXCUSED'].includes(item.status)).length;
  const submitted = rows.filter((item) => item.status === 'SUBMITTED').length;
  const rejected = rows.filter((item) => item.status === 'REJECTED').length;
  const pending = rows.filter((item) => item.status === 'PENDING').length;
  return { total, approved, submitted, rejected, pending, complete: total > 0 && approved === total };
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function monthlyEligibility(days, baseSalary, options = {}) {
  const rows = Array.isArray(days) ? days : [];
  const expected = rows.filter((day) => day.status !== 'EXCUSED');
  const approvedDays = expected.filter((day) => day.status === 'APPROVED').length;
  const noncompliantDays = expected.filter((day) => day.status === 'NONCOMPLIANT').length;
  const openDays = expected.length - approvedDays - noncompliantDays;
  let status = 'OPEN';
  if (noncompliantDays > 0) status = 'INELIGIBLE';
  else if (options.periodClosed && expected.length > 0 && openDays === 0) status = 'ELIGIBLE';
  else if (options.periodClosed && (expected.length === 0 || openDays > 0)) status = 'NEEDS_REVIEW';
  const salary = Number(baseSalary);
  const eligibleAmount = status === 'ELIGIBLE' && Number.isFinite(salary) && salary >= 0
    ? round2(salary * INCENTIVE_PCT / 100)
    : null;
  return {
    status,
    expectedDays: expected.length,
    approvedDays,
    noncompliantDays,
    openDays,
    incentivePct: INCENTIVE_PCT,
    eligibleAmount,
  };
}

module.exports = {
  POLICY_VERSION,
  POLICY_DIGEST,
  INCENTIVE_PCT,
  RULES,
  ruleForKey,
  requiredConfirmations,
  normalizeProductRef,
  parseConfirmations,
  validateSubmission,
  automaticSubmissionReview,
  dayProgress,
  monthlyEligibility,
};
