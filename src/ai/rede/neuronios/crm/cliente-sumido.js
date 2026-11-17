// crm.cliente-sumido — detector (regra, custo zero)
// Toda semana: clientes com cashback (User.balance) parado e/ou sem compra há
// 60+ dias. Sai SÓ o id do cliente (+ saldo e dias): telefone/CPF/e-mail
// NUNCA entram no sinal. Quem contata é o dono, depois de aprovar.
const { fortaleza, DIA, reais, VENDA_INVALIDA } = require('../../regras/comercial');

const DIAS = () => Number(process.env.RNA_CRM_DIAS_SUMIDO || 60);
const MAX = 500;

module.exports = {
  id: 'crm.cliente-sumido',
  camada: 'detector',
  missao: 'Achar clientes com cashback parado ou sem compra há 60 dias ou mais.',
  escuta: ['relogio.semanal'],
  emite: ['crm.reativar'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['lgpd-sem-pii-no-sinal', 'dados-reais'],
  tempoMax: 30000,
  async disparar({ sinal, ler, agora }) {
    const f = fortaleza((sinal.dados && sinal.dados.quando) || agora);
    const corte = new Date(f.inicio.getTime() - DIAS() * DIA);
    // última compra por cliente (vendas válidas)
    const ultimas = await ler.sale.groupBy({
      by: ['customerUserId'],
      where: { customerUserId: { not: null }, status: { notIn: VENDA_INVALIDA } },
      _max: { createdAt: true }, _count: { _all: true },
    });
    const ultima = new Map(ultimas.map((u) => [u.customerUserId, { em: u._max.createdAt, compras: u._count._all }]));
    // candidatos: quem comprou (e sumiu) + quem tem saldo de cashback
    const comSaldo = await ler.user.findMany({ where: { active: true, role: 'user', balance: { gt: 0 } }, select: { id: true, balance: true } });
    const ids = new Set(comSaldo.map((u) => u.id));
    for (const [id, u] of ultima) if (u.em < corte) ids.add(id);
    if (!ids.size) return [];
    const usuarios = await ler.user.findMany({ where: { id: { in: [...ids] }, active: true, role: 'user' }, select: { id: true, balance: true } });
    const clientes = [];
    for (const u of usuarios) {
      const c = ultima.get(u.id);
      const dias = c ? Math.floor((f.inicio - c.em) / DIA) : null;
      const sumido = c && c.em < corte;
      const saldoParado = u.balance > 0 && (!c || c.em < corte);
      if (!sumido && !saldoParado) continue;
      clientes.push({
        userId: u.id,
        saldo: Math.round(u.balance * 100) / 100,
        diasSemCompra: dias,
        compras: c ? c.compras : 0,
        motivo: saldoParado && sumido ? 'saldo-parado-e-sumido' : saldoParado ? 'saldo-parado' : 'sumido',
      });
    }
    if (!clientes.length) return [];
    clientes.sort((a, b) => b.saldo - a.saldo || (b.diasSemCompra || 0) - (a.diasSemCompra || 0));
    const lista = clientes.slice(0, MAX);
    const saldoTotal = lista.reduce((s, c) => s + c.saldo, 0);
    return [{
      tipo: 'crm.reativar',
      forca: 0.8,
      impactoRS: Math.round(saldoTotal),
      dados: {
        clientes: lista,
        total: clientes.length,
        saldoParadoRS: Math.round(saldoTotal * 100) / 100,
        diasCorte: DIAS(),
        semana: f.ymd,
        chave: `reativar-${f.ymd}`,
        evidencia: [
          `${clientes.length} cliente(s): sem compra desde ${fortaleza(corte).ymd} (tabela Sale) e/ou com cashback parado (User.balance)`,
          `Cashback parado somado: ${reais(saldoTotal)}`,
        ],
      },
    }];
  },
};
