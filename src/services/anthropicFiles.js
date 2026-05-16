// =====================================================================
// Anthropic Files API — upload PDFs/XMLs/Excels pra referenciar nas
// conversas. Útil pra processar NF-es, planilhas de fornecedor, etc.
// =====================================================================
// Requer beta header: anthropic-beta: files-api-2025-04-14
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function _client() {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { 'anthropic-beta': 'files-api-2025-04-14' },
  });
}

/**
 * Upload de arquivo. Suporta PDF, JPEG, PNG, GIF, WebP, XML, TXT, CSV.
 * @param {string} filePath - caminho local
 * @returns {Promise<{ok, fileId, filename, sizeBytes}>}
 */
async function uploadFile(filePath) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  if (!fs.existsSync(filePath)) return { ok: false, error: 'arquivo não encontrado: ' + filePath };
  try {
    const client = _client();
    const stream = fs.createReadStream(filePath);
    const file = await client.beta.files.upload({ file: stream });
    return {
      ok: true,
      fileId: file.id,
      filename: file.filename,
      sizeBytes: file.size_bytes,
      mimeType: file.mime_type,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function listFiles() {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  try {
    const client = _client();
    const list = await client.beta.files.list();
    return { ok: true, files: list.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function deleteFile(fileId) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  try {
    const client = _client();
    await client.beta.files.delete(fileId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Chat com arquivo anexado.
 * @param {string} fileId - id retornado do upload
 * @param {string} prompt - o que perguntar/extrair
 */
async function chatWithFile(fileId, prompt, opts = {}) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  try {
    const client = _client();
    const resp = await client.messages.create({
      model: opts.model || process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: opts.maxTokens || 2000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', file_id: fileId } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { ok: true, text, usage: resp.usage };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { isConfigured, uploadFile, listFiles, deleteFile, chatWithFile };
