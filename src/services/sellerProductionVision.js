// Fiscalização visual imediata das evidências da produção diária.
// A análise é uma pré-fiscalização objetiva: só aprova quando a imagem ou os
// quadros amostrados do vídeo mostram claramente o requisito. Em dúvida,
// devolve REVIEW para não transformar uma inferência em fato.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');
const evidenceStore = require('./productionEvidenceStore');

const MODEL = process.env.AI_VISION_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function taskInstruction(rule) {
  const key = String(rule?.key || '');
  const instructions = {
    ARRIVAL_STORY_1: 'Confirme que a imagem mostra a loja aberta e que a data está legível. Nome, turno, disponibilidade, horário e localização devem estar visíveis quando exigidos no registro.',
    ARRIVAL_BAG_PHOTO: 'Confirme somente uma foto externa de uma bolsa fechada. Não exija nem aceite a abertura ou exposição do conteúdo.',
    EXIT_BAG_PHOTO: 'Confirme somente uma foto externa de uma bolsa fechada. Não exija nem aceite a abertura ou exposição do conteúdo.',
    FLOOR_CLEAN_PHOTOS: 'Confirme que o piso da loja aparece de forma suficiente e está limpo e seco.',
    STORE_ORGANIZATION_PHOTOS: 'Confirme que a área mostrada está organizada, sem desordem evidente.',
    PRODUCT_LOCATION_PHOTOS: 'Confirme que a foto mostra produtos expostos nos locais corretos, com contexto suficiente para a conferência.',
    STORE_PHONE_READY: 'Confirme que o celular da loja aparece e está carregado ou conectado ao carregador.',
    CARD_MACHINE_READY: 'Confirme que a maquineta aparece e está carregada ou conectada ao carregador.',
    PACKAGING_CHECK: 'Confirme que há embalagens da loja disponíveis e identificáveis.',
  };
  if (instructions[key]) return instructions[key];
  if (rule?.productStory) return 'Confirme que a imagem mostra claramente um produto esportivo, sem ser apenas um print vazio ou uma imagem sem relação com a tarefa.';
  if (rule?.productReel) return 'Confirme nos quadros que aparecem produtos esportivos e que não há evidência clara de conteúdo incompatível. A duração, os produtos e os links são conferidos separadamente pelo sistema.';
  if (rule?.socialReel) return 'Confirme nos quadros que aparece a loja, o vendedor ou conteúdo de atendimento compatível com o Reels informado.';
  if (rule?.socialStory) return 'Confirme que a imagem mostra conteúdo compatível com a atividade de Story.';
  return 'Confirme se a evidência mostra claramente a atividade registrada.';
}

function parseJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

async function imageDataUrl(filePath, mimeType) {
  const source = await fs.promises.readFile(filePath);
  let output = source;
  let mediaType = mimeType && /^image\/(png|webp|jpeg)$/i.test(mimeType) ? mimeType : 'image/jpeg';
  try {
    output = await sharp(source)
      .rotate()
      .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
    mediaType = 'image/jpeg';
  } catch (_) {
    // Se a conversão falhar, ainda tentamos a imagem original se for suportada.
  }
  if (output.length > MAX_IMAGE_BYTES) {
    try {
      output = await sharp(output).resize({ width: 1000, height: 1000, fit: 'inside' }).jpeg({ quality: 55 }).toBuffer();
      mediaType = 'image/jpeg';
    } catch (_) {}
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: output.toString('base64') } };
}

function runFfmpeg(args, timeoutMs = 9000) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(false); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function videoFrames(filePath, durationSeconds) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'seller-production-vision-'));
  const safeDuration = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0 ? Number(durationSeconds) : 45;
  const points = [...new Set([1, Math.max(1, Math.floor(safeDuration / 2)), Math.max(1, Math.floor(safeDuration - 1))])];
  const frames = [];
  try {
    for (const point of points) {
      const outputPath = path.join(tempDir, `${crypto.randomUUID()}.jpg`);
      const ok = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-ss', String(point), '-i', filePath, '-frames:v', '1', '-vf', 'scale=1400:-2', '-q:v', '4', '-y', outputPath]);
      if (ok && fs.existsSync(outputPath)) frames.push(await imageDataUrl(outputPath, 'image/jpeg'));
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
  return frames;
}

async function collectImages(rule, payload, evidence) {
  const rows = (Array.isArray(evidence) ? evidence : []).filter((entry) => entry?.kind === 'PRIMARY');
  const images = [];
  let frameOnly = false;
  for (const row of rows.slice(0, MAX_IMAGES)) {
    const filePath = evidenceStore.resolve(row.storedName);
    if (!filePath) continue;
    if (row.mediaType === 'photo') {
      images.push(await imageDataUrl(filePath, row.mimeType));
    } else if (row.mediaType === 'video') {
      const frames = await videoFrames(filePath, payload.durationSeconds || rule.targetDurationSec);
      images.push(...frames);
      frameOnly = true;
    }
  }
  return { images: images.slice(0, MAX_IMAGES), frameOnly };
}

async function reviewSubmission({ rule, payload = {}, evidence = [] } = {}) {
  if (!isConfigured()) return { configured: false, decision: 'REVIEW', confidence: 0, reason: 'IA visual não configurada; a prova técnica sozinha não permite aprovação.' };
  const collected = await collectImages(rule, payload, evidence);
  if (!collected.images.length) {
    return { configured: true, decision: 'REVIEW', confidence: 0, reason: 'Não foi possível abrir uma evidência visual direta. Envie o arquivo no próprio registro, não somente um link externo.' };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `Você é o fiscal visual da produção diária da Sports & Tennis.\n\nAtividade: ${rule.title}\nRegra visual: ${taskInstruction(rule)}\nRelato do vendedor: ${String(payload.note || '').slice(0, 1200)}\n\nAnalise somente o que está visível nas imagens. Não trate o relato ou o nome do arquivo como prova.\n- APPROVE: todos os pontos visuais exigidos estão claramente visíveis.\n- REJECT: há incompatibilidade clara, evidência vazia, duplicada visualmente ou mostra outra coisa.\n- REVIEW: imagem parcial, ilegível, ambígua ou insuficiente. Nunca invente detalhes.\n${collected.frameOnly ? 'Os anexos são quadros amostrados de um vídeo; aprove somente se os quadros forem coerentes e claros, e indique que a verificação é por amostragem.' : ''}\n\nResponda somente JSON válido: {"decision":"APPROVE|REJECT|REVIEW","confidence":0.0,"reason":"motivo curto em PT-BR","checks":["pontos observados"]}`;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: 'Responda apenas JSON. Seja conservador: dúvida é REVIEW, nunca aprovação por suposição.',
      messages: [{ role: 'user', content: [...collected.images, { type: 'text', text: prompt }] }],
    });
    const parsed = parseJson((response.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
    const decision = ['APPROVE', 'REJECT', 'REVIEW'].includes(String(parsed?.decision || '').toUpperCase()) ? String(parsed.decision).toUpperCase() : 'REVIEW';
    const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0));
    const reason = String(parsed?.reason || 'A IA não conseguiu explicar a conferência visual.').slice(0, 1200);
    // Aprovação e rejeição automáticas exigem clareza; resultados ambíguos ficam
    // visíveis imediatamente como REVIEW, sem travar o vendedor em silêncio.
    const finalDecision = decision !== 'REVIEW' && confidence >= 0.9 ? decision : 'REVIEW';
    return {
      configured: true,
      decision: finalDecision,
      confidence,
      reason: finalDecision === 'REVIEW' && decision !== 'REVIEW' ? `Resultado visual inconclusivo (${Math.round(confidence * 100)}%): ${reason}` : reason,
      checks: Array.isArray(parsed?.checks) ? parsed.checks.slice(0, 12) : [],
      frameOnly: collected.frameOnly,
      model: MODEL,
    };
  } catch (err) {
    return { configured: true, decision: 'REVIEW', confidence: 0, reason: `Falha na conferência visual automática: ${String(err.message || err).slice(0, 500)}` };
  }
}

module.exports = { isConfigured, reviewSubmission, taskInstruction };
