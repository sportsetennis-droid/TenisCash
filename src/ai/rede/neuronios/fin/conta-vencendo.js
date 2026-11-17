// fin.conta-vencendo — detector (regra, custo zero)
// Todo dia: contas a pagar (FinTitle PAYABLE em aberto/parcial) vencidas,
// vencendo hoje e nos próximos 3 dias, por loja → dono.pendencia.
// Só avisa: pagar/liberar é sempre do dono no módulo financeiro.
const { fortaleza, DIA, reais } = require('../../regras/comercial');

module.exports = {
  id: 'fin.conta-vencendo',
  camada: 'detector',
  missao: 'Avisar o dono das contas a pagar vencidas, vencendo hoje ou nos próximos 3 dias.',
  escuta: ['relogio.diario'],
  emite: ['dono.pendencia'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['timezone-fortaleza', 'dinheiro-so-dono'],
  tempoMax: 20000,
  async disparar({ sinal, ler, agora }) {
    const f = fortaleza((sinal.dados && sinal.dados.quando) || agora);
    const ate = new Date(f.fim.getTime() + 3 * DIA); // até o fim do 3º dia
    const titulos = await ler.finTitle.findMany({
      where: { kind: 'PAYABLE', status: { in: ['OPEN', 'PARTIAL'] }, dueDate: { lt: ate } },
      select: { id: true, storeId: true, description: true, payee: true, amountCents: true, paidPrincipalCents: true, dueDate: true, status: true, approvalStatus: true, amountConfirmed: true },
      orderBy: { dueDate: 'asc' }, take: 300,
    });
    if (!titulos.length) return [];
    const lojas = await ler.store.findMany({ where: { id: { in: [...new Set(titulos.map((t) => t.storeId).filter(Boolean))] } }, select: { id: true, code: true } });
    const codigo = new Map(lojas.map((l) => [l.id, l.code]));
    const contas = titulos.map((t) => {
      const saldo = (t.amountCents - t.paidPrincipalCents) / 100;
      const quando = t.dueDate < f.inicio ? 'vencida' : t.dueDate < f.fim ? 'hoje' : 'proximos-3-dias';
      return { id: t.id, loja: codigo.get(t.storeId) || 'EMPRESA', descricao: t.description, favorecido: t.payee, saldo, vencimento: fortaleza(t.dueDate).ymd, quando, status: t.status, liberada: t.approvalStatus === 'APPROVED', valorConfirmado: t.amountConfirmed };
    }).filter((c) => c.saldo > 0);
    if (!contas.length) return [];
    const soma = (q) => contas.filter((c) => c.quando === q).reduce((s, c) => s + c.saldo, 0);
    const resumo = { vencidas: soma('vencida'), hoje: soma('hoje'), proximos3dias: soma('proximos-3-dias') };
    const naoLiberadas = contas.filter((c) => !c.liberada && c.quando !== 'proximos-3-dias').length;
    return [{
      tipo: 'dono.pendencia',
      forca: resumo.vencidas > 0 || resumo.hoje > 0 ? 1 : 0.7,
      impactoRS: Math.round(resumo.vencidas + resumo.hoje + resumo.proximos3dias),
      dados: {
        assunto: 'contas-a-pagar',
        titulo: `Contas a pagar: ${reais(resumo.hoje)} hoje · ${reais(resumo.vencidas)} vencidas · ${reais(resumo.proximos3dias)} em 3 dias`,
        resumo, naoLiberadas, contas,
        chave: `contas-${f.ymd}`,
        evidencia: [`${contas.length} título(s) PAYABLE OPEN/PARTIAL com vencimento até ${fortaleza(ate - 1).ymd} (FinTitle; saldo = valor − principal pago)`],
      },
    }];
  },
};
