// =====================================================================
// conteudo.descricao — ANALISTA (ia-barata)
// Missão única: redigir a descrição de um card publicado SEM descrição,
// usando SÓ dados reais do card (marca, nome/modelo, cor, classificação,
// materiais/características se existirem). Nada inventado: a IA só redige;
// o texto passa por uma trava anti-chute (número, cor ou tamanho que não
// está no card = texto recusado) e, sem IA, sai um modelo fixo dos dados.
// Proposta pro dono; ao aprovar, grava só se o card ainda estiver sem descrição.
// =====================================================================
const { contextOf } = require('../../../../services/nuvemshopEligibility');

const CORES = ['preto', 'preta', 'branco', 'branca', 'azul', 'vermelho', 'vermelha', 'verde', 'amarelo', 'amarela', 'rosa', 'cinza', 'marinho', 'bege', 'roxo', 'roxa', 'lilas', 'laranja', 'marrom', 'dourado', 'dourada', 'prata', 'prateado', 'grafite', 'caramelo', 'vinho', 'nude', 'coral', 'creme', 'gelo', 'chumbo', 'mostarda', 'turquesa', 'fucsia', 'violeta', 'oliva', 'multicolorido', 'colorido', 'off white', 'bordo', 'cru', 'areia', 'salmao'];
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const texto = (v) => (v == null ? '' : String(v).trim());

function dadosDoCard(p) {
  const ctx = contextOf(p);
  const c = ctx.classification || {};
  const materiais = [ctx.materiais, ctx.materials, ctx.material].find((x) => x && (typeof x === 'string' ? x.trim() : Array.isArray(x) && x.length));
  const caracteristicas = Array.isArray(p.features) ? p.features.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8) : null;
  const d = {
    marca: texto(p.brand) || null,
    nome: texto(p.name) || null,
    cor: texto(ctx.color) || null,
    categoria: texto(p.category) || null,
    subcategoria: texto(p.subcategory) || null,
    modalidade: texto(c.modality) || null,
    genero: texto(c.gender) || null,
    materiais: materiais ? (Array.isArray(materiais) ? materiais.join(', ') : materiais) : null,
    caracteristicas: caracteristicas && caracteristicas.length ? caracteristicas : null,
  };
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v));
}

// Anti-chute: tudo que é verificável no texto tem que estar nos dados do card.
function chutes(textoGerado, dados) {
  const fonte = semAcento(JSON.stringify(dados));
  const t = semAcento(textoGerado);
  const problemas = [];
  for (const n of t.match(/\d+(?:[.,]\d+)?/g) || []) if (!fonte.includes(n)) problemas.push('número ' + n + ' não está no card');
  for (const cor of CORES) if (new RegExp('\\b' + cor + '\\b').test(t) && !fonte.includes(cor)) problemas.push('cor "' + cor + '" não está no card');
  if (/\b(tamanho|numeracao|tam\.)\b/.test(t) && !/tamanho|numeracao/.test(fonte)) problemas.push('cita tamanho');
  if (/r\$|\bpreco\b|desconto|promoc/.test(t)) problemas.push('cita preço/desconto');
  return problemas;
}

function modelo(d) {
  const partes = [`${d.nome}${d.marca && !semAcento(d.nome).includes(semAcento(d.marca)) ? ' ' + d.marca : ''}`];
  if (d.cor) partes.push(`na cor ${d.cor}`);
  let s = partes.join(', ') + '.';
  if (d.modalidade) s += ` Indicado para ${d.modalidade}.`;
  if (d.materiais) s += ` Materiais: ${d.materiais}.`;
  if (d.caracteristicas) s += ` Características: ${d.caracteristicas.join('; ')}.`;
  return s;
}

module.exports = {
  id: 'conteudo.descricao',
  camada: 'analista',
  missao: 'Redigir a descrição de um card sem descrição usando só os dados reais do card.',
  escuta: ['nuvem.incompleto', 'marca.cadastro-incompleto'],
  emite: ['proposta.descricao'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['nunca-inventar-dado', 'cor-por-extenso-portugues'],
  tempoMax: 30000,
  async disparar({ sinal, ler, pensar }) {
    const d = sinal.dados || {};
    if (!(d.falta || []).includes('descricao') || !d.productId) return [];
    const p = await ler.product.findUnique({
      where: { id: d.productId },
      select: { id: true, sku: true, name: true, brand: true, category: true, subcategory: true, aiContext: true, features: true, longDescription: true, shortDescription: true },
    });
    if (!p) return [];
    if (texto(p.longDescription) || texto(p.shortDescription)) return []; // já tem: nada a propor
    const dados = dadosDoCard(p);
    if (!dados.nome || !dados.marca) {
      return [{ tipo: 'dado-faltante', dados: { chave: 'descricao:' + p.id, productId: p.id, campos: ['nome', 'marca'].filter((k) => !dados[k]), motivo: 'sem nome/marca no card não há descrição sem inventar' } }];
    }

    let textoFinal = null; let origem = 'modelo-fixo'; let recusado = null;
    if (pensar) {
      const r = await pensar({
        instrucao: 'Escreva a descrição de produto para a loja online (2 a 4 frases, português do Brasil, tom de loja esportiva). '
          + 'Use EXCLUSIVAMENTE os campos da entrada. Não cite tamanho, preço, desconto, tecnologia, material ou benefício que não esteja na entrada. '
          + 'Cor exatamente como está (por extenso). Responda JSON {"texto": "..."}.',
        entrada: dados,
        schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
        maxTokens: 500,
      }).catch(() => null);
      const t = r && r.ok && r.json && texto(r.json.texto);
      if (t) {
        const ps = chutes(t, dados);
        if (ps.length) recusado = ps; else { textoFinal = t.slice(0, 1500); origem = 'ia-barata'; }
      }
    }
    if (!textoFinal) textoFinal = modelo(dados);

    return [{
      tipo: 'proposta.descricao',
      dados: {
        chave: 'descricao:' + p.id,
        titulo: 'Descrição para ' + [dados.marca, dados.nome].join(' ').slice(0, 150),
        descricao: (sinal.tipo === 'marca.cadastro-incompleto' ? 'Card com estoque nas lojas do site, fora da Nuvemshop por falta de descrição (pedido do gerente da marca).' : 'Card publicado sem descrição.') + ' Texto montado só com os dados do card' + (recusado ? ' (texto da IA recusado pela trava anti-chute: ' + recusado.join('; ') + ')' : '') + '. Ao aprovar, grava só se o card continuar sem descrição.',
        risco: 'baixo',
        acao: { nome: 'nuvem.aplicar-descricao', args: { productId: p.id, texto: textoFinal } },
        previa: { productId: p.id, sku: p.sku, campo: 'longDescription', de: null, para: textoFinal, origem },
        evidencia: Object.keys(dados).map((k) => k + ' = ' + (Array.isArray(dados[k]) ? dados[k].join('; ') : dados[k]) + ' (card ' + p.id + ')'),
      },
    }];
  },
};
