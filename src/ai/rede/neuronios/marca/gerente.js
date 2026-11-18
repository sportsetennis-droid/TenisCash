// =====================================================================
// marca.gerente — DETECTOR (regra, custo zero)
// Missão única: montar, todo dia, o RAIO-X de cada marca — estoque (comprado ×
// localizado por loja), venda (loja física × site), site (publicado, pronto,
// barrado) e cadastro — e apontar o que precisa do dono, por ordem de gravidade.
//
// É o "gerente da marca": um por marca, todos com a mesma régua. Não mexe em
// nada — só lê e relata. As correções continuam saindo dos mini agentes de
// cada assunto (estoque, preço, Nuvemshop…) como PROPOSTA para o dono aprovar.
// Pedido sob demanda: sinal `marca.pedir` com dados.marca (painel /marcas.html).
// =====================================================================
const raioX = require('./_raio-x');
const { chave } = require('../../regras/marcas');

const DIAS_PARADO = () => Math.max(30, Number(process.env.RNA_PARADO_DIAS || 90));

module.exports = {
  id: 'marca.gerente',
  camada: 'detector',
  missao: 'Montar o raio-x diário de cada marca (estoque, venda loja×site, site e cadastro) e apontar o que precisa do dono.',
  escuta: ['relogio.diario', 'marca.pedir'],
  emite: ['marca.relatorio'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['estoque-fisico-storestock', 'comprado-nunca-recalcula', 'nunca-inventar-dado', 'nuvemshop-foto-descricao', 'nuvemshop-4-classificacoes', 'lugar-certo'],
  tempoMax: 180000,
  async disparar({ sinal, ler, agora }) {
    const quando = agora || new Date();
    let soMarca = null;
    if (sinal.tipo === 'marca.pedir') {
      soMarca = chave(sinal.dados && sinal.dados.marca);
      if (!soMarca) return [{ tipo: 'marca.relatorio', forca: 0.1, dados: { chave: 'marca|?|' + Date.now(), erro: 'marca não informada ou indefinida', pedido: sinal.dados || {} } }];
    }
    const marcas = await raioX.calcular(ler, { agora: quando, soMarca, diasParado: DIAS_PARADO() });
    const dia = quando.toISOString().slice(0, 10);
    return marcas.map((m) => ({
      tipo: 'marca.relatorio',
      forca: Math.max(0.1, m.atencao / 100),
      impactoRS: m.parados.valorCustoRS || null,
      dados: Object.assign({ chave: 'marca|' + m.marca + '|' + (soMarca ? 'pedido|' + quando.getTime() : dia), dia, geradoEm: quando.toISOString(), sobDemanda: !!soMarca }, m),
    }));
  },
};
