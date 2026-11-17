// club.medalha-pendente — detector (regra, custo zero)
// Torneio finalizado → PRÉVIA das medalhas por categoria (ouro/prata/bronze)
// lida dos jogos encerrados (FINAL/THIRD com vencedor) ou da classificação
// (pontos corridos com rank). Nunca emite medalha: vira proposta pro dono.
// Sem 3º lugar disputado, o bronze NÃO é deduzido: fica para o organizador.
const FIM = ['FINISHED', 'WALKOVER'];

function podioMataMata(jogos) {
  const final = jogos.find((m) => m.stage === 'FINAL' && FIM.includes(m.status) && m.winnerEntryId);
  if (!final) return null;
  const prata = final.homeEntryId === final.winnerEntryId ? final.awayEntryId : final.homeEntryId;
  const terceiro = jogos.find((m) => m.stage === 'THIRD' && FIM.includes(m.status) && m.winnerEntryId);
  const semis = jogos.filter((m) => m.stage === 'SEMI' && FIM.includes(m.status) && m.winnerEntryId);
  return {
    ouro: final.winnerEntryId,
    prata,
    bronze: terceiro ? [terceiro.winnerEntryId] : [],
    bronzeADefinir: terceiro ? [] : semis.map((m) => (m.homeEntryId === m.winnerEntryId ? m.awayEntryId : m.homeEntryId)).filter(Boolean),
    fonte: [`jogo FINAL ${final.id}`].concat(terceiro ? [`jogo THIRD ${terceiro.id}`] : semis.map((m) => `semifinal ${m.id}`)),
  };
}

module.exports = {
  id: 'club.medalha-pendente',
  camada: 'detector',
  missao: 'Montar a prévia das medalhas de um torneio finalizado para o dono aprovar.',
  escuta: ['torneio.finalizado'],
  emite: ['proposta.emitir-medalhas'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'propor',
  regras: ['tabela-oficial-literal', 'nunca-deduzir', 'lgpd-cpf-hash'],
  tempoMax: 20000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    if (!d.tournamentId) return [{ tipo: 'dado-faltante', dados: { motivo: 'torneio.finalizado sem tournamentId' } }];
    const t = await ler.tournament.findUnique({ where: { id: d.tournamentId }, select: { id: true, name: true, slug: true, status: true, sport: true } });
    if (!t) return [{ tipo: 'dado-faltante', dados: { motivo: 'torneio não encontrado', tournamentId: d.tournamentId } }];
    const cats = await ler.tournamentCategory.findMany({ where: { tournamentId: t.id, ...(d.categoryId ? { id: d.categoryId } : {}) }, select: { id: true, name: true } });
    const saidas = [];
    for (const cat of cats) {
      const jogos = await ler.tournamentMatch.findMany({ where: { categoryId: cat.id }, select: { id: true, stage: true, status: true, homeEntryId: true, awayEntryId: true, winnerEntryId: true } });
      if (jogos.some((m) => !FIM.includes(m.status) && m.status !== 'CANCELED')) continue; // categoria ainda tem jogo em aberto
      let podio = podioMataMata(jogos);
      if (!podio) {
        const tab = await ler.tournamentStanding.findMany({ where: { categoryId: cat.id, rank: { not: null, lte: 3 } }, orderBy: { rank: 'asc' }, select: { id: true, entryId: true, rank: true } });
        if (tab.length < 2 || jogos.some((m) => m.stage !== 'LEAGUE' && m.stage !== 'GROUP')) continue; // sem final encerrada e sem tabela final: não deduz
        const r = (n) => (tab.find((x) => x.rank === n) || {}).entryId || null;
        podio = { ouro: r(1), prata: r(2), bronze: r(3) ? [r(3)] : [], bronzeADefinir: [], fonte: tab.map((x) => `classificação rank ${x.rank} (${x.id})`) };
      }
      const ids = [podio.ouro, podio.prata, ...podio.bronze].filter(Boolean);
      const entries = await ler.tournamentEntry.findMany({ where: { id: { in: ids.concat(podio.bronzeADefinir) } }, select: { id: true, name: true, members: { select: { userId: true, user: { select: { cpf: true } } } } } });
      const porId = new Map(entries.map((e) => [e.id, e]));
      const linha = (id, medalha) => {
        const e = porId.get(id);
        if (!e) return null;
        const atletas = e.members.map((m) => ({ userId: m.userId, temCpf: !!(m.user && m.user.cpf) })); // CPF nunca sai; só se existe
        return { medalha, entryId: id, nome: e.name, atletas, semConta: atletas.length === 0 };
      };
      const lista = [linha(podio.ouro, 'ouro'), linha(podio.prata, 'prata'), ...podio.bronze.map((id) => linha(id, 'bronze'))].filter(Boolean);
      if (!lista.length) continue;
      const bloqueados = lista.flatMap((l) => l.atletas.filter((a) => !a.temCpf)).length;
      saidas.push({
        tipo: 'proposta.emitir-medalhas',
        dados: {
          titulo: `Medalhas · ${t.name} · ${cat.name}`.slice(0, 190),
          descricao: 'PRÉVIA. Nenhuma medalha é emitida sem a sua aprovação. Atleta sem CPF fica bloqueado até completar o cadastro.',
          risco: bloqueados ? 'medio' : 'baixo',
          chave: `medalhas-${t.id}-${cat.id}`,
          previa: {
            torneio: { id: t.id, nome: t.name, slug: t.slug }, categoria: { id: cat.id, nome: cat.name },
            podio: lista.map((l) => ({ medalha: l.medalha, nome: l.nome, entryId: l.entryId, atletas: l.atletas.length, bloqueadosSemCpf: l.atletas.filter((a) => !a.temCpf).length, semConta: l.semConta })),
            bronzeADefinirPeloOrganizador: podio.bronzeADefinir.map((id) => (porId.get(id) || {}).name || id),
            bloqueadosSemCpf: bloqueados,
          },
          acao: { nome: 'rna.registrar' },
          evidencia: [`Torneio ${t.id} status ${t.status}`].concat(podio.fonte),
        },
      });
    }
    return saidas;
  },
};
