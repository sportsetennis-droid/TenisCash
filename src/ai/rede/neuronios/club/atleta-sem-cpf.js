// club.atleta-sem-cpf — detector (regra, custo zero)
// Torneio finalizado → lista (crm.lista, motivo 'sem-cpf') dos atletas que
// jogaram e estão BLOQUEADOS para receber medalha porque não têm CPF no
// cadastro. Sai só o userId: CPF/telefone nunca entram no sinal. A lista
// segue pro rascunho de WhatsApp (convite a completar o cadastro no app).
module.exports = {
  id: 'club.atleta-sem-cpf',
  camada: 'detector',
  missao: 'Listar os atletas de um torneio finalizado que estão sem CPF no cadastro.',
  escuta: ['torneio.finalizado'],
  emite: ['crm.lista'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['lgpd-sem-pii-no-sinal', 'lgpd-cpf-hash'],
  tempoMax: 20000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    if (!d.tournamentId) return [];
    const t = await ler.tournament.findUnique({ where: { id: d.tournamentId }, select: { id: true, name: true } });
    if (!t) return [];
    const membros = await ler.entryMember.findMany({
      where: { entry: { tournamentId: t.id, status: { not: 'WITHDRAWN' }, ...(d.categoryId ? { categoryId: d.categoryId } : {}) }, user: { cpf: null, active: true } },
      select: { userId: true },
    });
    const ids = [...new Set(membros.map((m) => m.userId))];
    if (!ids.length) return [];
    return [{
      tipo: 'crm.lista',
      forca: 0.8,
      dados: {
        motivo: 'sem-cpf',
        torneio: { id: t.id, nome: t.name },
        clientes: ids.map((userId) => ({ userId, motivo: 'sem-cpf' })),
        chave: `sem-cpf-${t.id}${d.categoryId ? '-' + d.categoryId : ''}`,
        evidencia: [`${ids.length} atleta(s) inscrito(s) em ${t.name} com User.cpf vazio (EntryMember → User)`],
      },
    }];
  },
};
