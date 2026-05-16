// =====================================================================
// Slack Notifier — manda mensagens pro Slack via Incoming Webhook.
// Simples, direto, sem precisar de OAuth ou Bot Token.
// =====================================================================
// ENV: SLACK_WEBHOOK_URL (obtido em Slack > Apps > Incoming Webhooks)
// =====================================================================

function isConfigured() {
  return !!process.env.SLACK_WEBHOOK_URL;
}

/**
 * Manda mensagem simples no Slack.
 * @param {string} text  - texto da mensagem (suporta *bold*, _italic_, `code`)
 * @param {Object} [opts]
 * @param {Array}  [opts.blocks]   - Block Kit, se quiser layout rico
 * @param {string} [opts.username] - sobrescreve nome do bot
 * @param {string} [opts.iconEmoji]- ex: ':tennis:'
 * @returns {Promise<{ok, status, error?}>}
 */
async function send(text, opts = {}) {
  if (!isConfigured()) return { ok: false, error: 'SLACK_WEBHOOK_URL não configurada' };
  try {
    const body = { text };
    if (opts.blocks) body.blocks = opts.blocks;
    if (opts.username) body.username = opts.username;
    if (opts.iconEmoji) body.icon_emoji = opts.iconEmoji;
    const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, status: res.status, error: txt };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Notifica conclusão de curadoria em massa.
 */
async function notifyCurationDone({ supplier, total, imageOk, descOk, nsOk, errors, costBRL }) {
  return send('', {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🧠 Curadoria IA concluída' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Fornecedor:*\n${supplier || '(geral)'}` },
          { type: 'mrkdwn', text: `*Produtos:*\n${total}` },
          { type: 'mrkdwn', text: `*Imagens:*\n${imageOk}/${total}` },
          { type: 'mrkdwn', text: `*Descrições:*\n${descOk}/${total}` },
          { type: 'mrkdwn', text: `*Nuvemshop:*\n${nsOk}/${total}` },
          { type: 'mrkdwn', text: `*Falhas:*\n${errors}` },
          { type: 'mrkdwn', text: `*Custo total:*\nR$ ${(costBRL || 0).toFixed(2)}` },
        ],
      },
    ],
  });
}

/**
 * Notifica novo pedido na Nuvemshop.
 */
async function notifyNewOrder({ orderNumber, customer, totalBRL, items }) {
  return send('', {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🛒 Novo pedido!' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Pedido:*\n#${orderNumber}` },
          { type: 'mrkdwn', text: `*Cliente:*\n${customer || '(anônimo)'}` },
          { type: 'mrkdwn', text: `*Total:*\nR$ ${(totalBRL || 0).toFixed(2)}` },
          { type: 'mrkdwn', text: `*Itens:*\n${items || '?'}` },
        ],
      },
    ],
  });
}

/**
 * Notifica baixo estoque.
 */
async function notifyLowStock({ sku, name, stock, threshold = 5 }) {
  return send(`⚠️ Estoque baixo: *${name}* (SKU ${sku}) — ${stock} un. restantes (alerta < ${threshold})`);
}

module.exports = { isConfigured, send, notifyCurationDone, notifyNewOrder, notifyLowStock };
