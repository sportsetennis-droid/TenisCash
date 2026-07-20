// Producao diaria do vendedor — politica Sports & Tennis.
// Regras ficam centralizadas para a API, a interface e os testes usarem a
// mesma definicao. Penalidades trabalhistas nunca sao aplicadas aqui.

const crypto = require('crypto');

const POLICY_VERSION = 'ST-PRODUCAO-2026-07-V1';
const INCENTIVE_PCT = 10;

const REQUIRED = Object.freeze({
  ARRIVAL_STORY: ['sellerName', 'shiftHours', 'availableForSales', 'date', 'openingHours', 'storeLocation'],
  ARRIVAL_REEL: ['sellerName', 'shiftHours', 'availableForSales', 'whatsappReposted'],
  PRODUCT_REEL: ['priceInformed', 'maxDiscountInformed', 'technologiesExplained', 'differentialsExplained', 'whatsappReposted'],
  EXIT_STORY: ['customersThanked', 'nextDayAvailabilityInformed'],
  EXIT_REEL: ['customersThanked', 'nextDayAvailabilityInformed', 'whatsappReposted'],
});

function buildRules() {
  const rules = [];
  const add = (rule) => rules.push(Object.freeze({ position: rules.length, ...rule }));

  add({ key: 'ARRIVAL_STORY_1', phase: 'ARRIVAL', title: 'Chegada — Story com foto da loja aberta', mediaType: 'photo', requirementSet: 'ARRIVAL_STORY' });
  add({ key: 'ARRIVAL_REEL_1', phase: 'ARRIVAL', title: 'Chegada — Reels da loja (aprox. 20 segundos)', mediaType: 'video', targetDurationSec: 20, requirementSet: 'ARRIVAL_REEL', whatsappRequired: true });

  for (let i = 1; i <= 2; i += 1) {
    add({ key: `FIRST_TURN_REEL_${i}`, phase: 'FIRST_TURN', title: `Primeiro turno — Reels de produtos ${i}/2`, mediaType: 'video', targetDurationSec: 45, exactDuration: true, requiredProducts: 3, requirementSet: 'PRODUCT_REEL', productReel: true, whatsappRequired: true });
  }
  for (let i = 1; i <= 5; i += 1) {
    add({ key: `FIRST_TURN_STORY_${i}`, phase: 'FIRST_TURN', title: `Primeiro turno — Foto de produto ${i}/5`, mediaType: 'photo', productStory: true });
  }

  for (let i = 1; i <= 2; i += 1) {
    add({ key: `SECOND_TURN_REEL_${i}`, phase: 'SECOND_TURN', title: `Segundo turno — Reels de produtos ${i}/2`, mediaType: 'video', targetDurationSec: 45, exactDuration: true, requiredProducts: 3, requirementSet: 'PRODUCT_REEL', productReel: true, whatsappRequired: true });
  }
  for (let i = 1; i <= 5; i += 1) {
    add({ key: `SECOND_TURN_STORY_${i}`, phase: 'SECOND_TURN', title: `Segundo turno — Foto de produto ${i}/5`, mediaType: 'photo', productStory: true });
  }

  add({ key: 'EXIT_STORY_1', phase: 'EXIT', title: 'Saida — Story com foto da loja', mediaType: 'photo', requirementSet: 'EXIT_STORY' });
  add({ key: 'EXIT_REEL_1', phase: 'EXIT', title: 'Saida — Reels de agradecimento', mediaType: 'video', requirementSet: 'EXIT_REEL', whatsappRequired: true });
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
    errors.push(`Envie ${rule.mediaType === 'photo' ? 'a foto' : 'o video'} ou informe o link da publicacao.`);
  }
  if (publicationUrl && !isHttpUrl(publicationUrl)) errors.push('O link da publicacao e invalido.');

  const confirmations = parseConfirmations(payload.requirementsConfirmedJson || payload.confirmations);
  for (const key of requiredConfirmations(rule)) {
    if (confirmations[key] !== true) errors.push(`Confirme o requisito: ${key}.`);
  }

  if (rule.mediaType === 'video' && payload.noInstagramStoryConfirmed !== true && payload.noInstagramStoryConfirmed !== 'true') {
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
  dayProgress,
  monthlyEligibility,
};
