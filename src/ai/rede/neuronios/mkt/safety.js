// mkt.safety — analista (IA barata)
// Revisa o rascunho de campanha ANTES de chegar ao dono: corrige o que é
// regra literal da Constituição de Comunicação (vendedor≠consultor, "50% DE
// DESCONTO", sem "sem juros", sem "imagem ilustrativa", laranja 🧡) e aponta
// o resto (percentual não autorizado, cor abreviada, promessa sem dado).
// Saída: proposta.campanha revisada. Nunca publica nem agenda (item 13).
const { revisarTexto } = require('../../regras/comercial');

const SCHEMA = {
  type: 'object',
  properties: { problemas: { type: 'array', items: { type: 'string' } }, aprovadoParaDono: { type: 'boolean' } },
  required: ['problemas', 'aprovadoParaDono'],
};
const CAMPOS = ['titulo', 'conceito', 'gancho', 'legenda', 'chamada'];

module.exports = {
  id: 'mkt.safety',
  camada: 'analista',
  missao: 'Revisar o rascunho de campanha pela Constituição de Comunicação antes de ir ao dono.',
  escuta: ['mkt.rascunho'],
  emite: ['proposta.campanha'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['constituicao-comunicacao', 'nao-publicar-sozinho', 'vendedor-nao-consultor', 'cor-por-extenso'],
  tempoMax: 45000,
  async disparar({ sinal, pensar }) {
    const d = sinal.dados || {};
    const c = d.campanha;
    if (!c || !Array.isArray(c.pecas)) return [];
    const corrigido = new Set();
    const alertas = new Set();
    const rev = (t) => { const r = revisarTexto(t); r.corrigido.forEach((x) => corrigido.add(x)); r.alertas.forEach((x) => alertas.add(x)); return r.texto; };
    const revisada = {};
    for (const k of CAMPOS) revisada[k] = rev(c[k] || '');
    revisada.pecas = c.pecas.map((p) => Object.assign({}, p, { texto: rev(p.texto) }));
    const r = await pensar({
      instrucao: 'Você é o revisor final (safety). Aponte problemas do texto contra estas regras: não publicar sozinho; foto real (nunca desenho); não repetir composição; "50% DE DESCONTO" exato e "ATÉ 50%" só na chamada geral; 10x sem "sem juros"; convite à loja; funcionário é vendedor; cor por extenso em português; nada de preço/estoque/prazo inventado; nada de frase motivacional vazia. Não reescreva a campanha: só liste problemas objetivos.',
      entrada: { campanha: revisada },
      schema: SCHEMA,
    });
    const problemasIA = r.ok && r.json && Array.isArray(r.json.problemas) ? r.json.problemas.map(String).slice(0, 10) : ['revisão por IA indisponível — revisar manualmente'];
    const pendencias = [...alertas, ...problemasIA];
    if (d.produtosInventadosRemovidos) pendencias.push(`${d.produtosInventadosRemovidos} produto(s) que não estavam no estoque foram removidos do rascunho`);
    return [{
      tipo: 'proposta.campanha',
      impactoRS: sinal.impactoRS,
      dados: {
        titulo: `Campanha (rascunho revisado): ${revisada.titulo || 'sem título'}`.slice(0, 190),
        descricao: 'Rascunho revisado pelo safety. NÃO é publicado nem agendado: aprovar só registra a decisão; a publicação é sua (Constituição item 13).',
        risco: pendencias.length ? 'alto' : 'medio',
        chave: d.chave ? 'rev-' + d.chave : null,
        previa: { campanha: revisada, produtos: d.produtos || [], correcoesAutomaticas: [...corrigido], pendencias, revisadoPor: 'mkt.safety' },
        acao: { nome: 'rna.registrar' },
        evidencia: (d.evidencia || []).concat(['Revisão: regras literais da docs/marketing/CONSTITUICAO-PUBLICACOES.md + IA barata']),
      },
    }];
  },
};
