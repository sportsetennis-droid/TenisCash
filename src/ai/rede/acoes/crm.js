// =====================================================================
// RNA — ações de CRM executadas SÓ depois do "sim" do dono (acoes.executar
// já recusa o que não está approved). Revalida tudo antes de mexer:
//  crm.whatsapp-aprovado: enfileira na WhatsAppOutbox (a mesma fila oficial
//  do notify.js) EXATAMENTE o texto que o dono viu na prévia. Texto mudou,
//  hash não bate, cliente sem consentimento LGPD/telefone → não envia.
//  Não chama API direto: a fila é processada pelos canais já existentes.
// =====================================================================
const crypto = require('crypto');

const MAX_DEST = 200;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = (registrar) => {
  registrar('crm.whatsapp-aprovado', {
    descricao: 'Enfileira no WhatsApp o texto APROVADO (idêntico à prévia) para os clientes da lista com consentimento LGPD.',
    async executar(args, { aprovacao, db }) {
      const texto = String((args && args.texto) || '');
      const previa = aprovacao && aprovacao.payload && aprovacao.payload.previa;
      if (!texto.trim()) throw new Error('texto vazio');
      if (!previa || previa.texto !== texto) throw new Error('texto diferente do que o dono aprovou na prévia');
      if (!args.textoHash || sha(texto) !== args.textoHash) throw new Error('hash do texto não confere');
      if (aprovacao.status !== 'approved') throw new Error('proposta não aprovada');
      const ids = [...new Set((args.userIds || []).map(String))];
      if (!ids.length) throw new Error('lista vazia');
      if (ids.length > MAX_DEST) throw new Error(`lista com ${ids.length} clientes (máx ${MAX_DEST} por aprovação)`);
      const users = await db.user.findMany({ where: { id: { in: ids }, active: true, lgpdAccepted: true }, select: { id: true, name: true, phone: true } });
      const desde = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      let enfileiradas = 0, repetidas = 0;
      for (const u of users) {
        if (!u.phone) continue;
        const nome = String(u.name || '').trim().split(/\s+/)[0] || '';
        const body = texto.replace(/\{nome\}/g, nome).replace(/Oi, !/, 'Oi!');
        const ja = await db.whatsAppOutbox.findFirst({ where: { phone: u.phone, body, createdAt: { gte: desde } }, select: { id: true } });
        if (ja) { repetidas++; continue; }
        await db.whatsAppOutbox.create({ data: { phone: u.phone, body, userId: u.id } });
        enfileiradas++;
      }
      return { ok: true, enfileiradas, repetidas, semConsentimentoOuInativo: ids.length - users.length, aprovacaoId: aprovacao.id };
    },
  });
};
