// mkt.campanha — especialista (IA forte)
// Monta o RASCUNHO de campanha (conceito, peças, legenda, chamada) a partir
// de produtos REAIS (candidatos do dia ou estoque físico da loja do objetivo).
// Não propõe direto: emite mkt.rascunho → mkt.safety revisa a Constituição
// de Comunicação → proposta.campanha. Nunca publica nem agenda.
const { revisarTexto } = require('../../regras/comercial');

const SCHEMA = {
  type: 'object',
  properties: {
    titulo: { type: 'string' },
    conceito: { type: 'string' },
    gancho: { type: 'string' },
    pecas: { type: 'array', items: { type: 'object', properties: { formato: { type: 'string', enum: ['carrossel', 'story', 'reel'] }, texto: { type: 'string' }, productIds: { type: 'array', items: { type: 'string' } } }, required: ['formato', 'texto'] } },
    legenda: { type: 'string' },
    chamada: { type: 'string' },
  },
  required: ['titulo', 'conceito', 'pecas', 'legenda', 'chamada'],
};
const INSTRUCAO = [
  'Crie uma campanha de varejo esportivo da Sports & Tennis (João Pessoa e Campina Grande) usando SÓ os produtos da entrada (cite pelo productId).',
  'Comunicação que vende: produto real + gancho + benefício + chamada com a loja. Nada de frase motivacional.',
  'Proibido: inventar preço, desconto, percentual, prazo, estoque ou brinde; "sem juros"; "consultor" (é vendedor); "imagem ilustrativa"; "consulte seu tamanho" como chamada principal.',
  'Cor sempre por extenso e em português. Identidade: preto, laranja e branco; emoji só 🧡.',
  'Máximo 3 peças (carrossel com produtos diferentes rende mais que reel). Nomes das lojas: "Sports & Tennis Praia do Bessa", "Sports & Tennis Praia de Tambaú", "Sports & Tennis Tambiá", "Sports & Tennis Praia de Manaíra", "Sports & Tennis Rainha da Borborema".',
].join(' ');

async function produtosDaLoja(ler, loja) {
  const rows = await ler.$queryRaw`
    SELECT p.id, p.name, p.brand, p.price, SUM(ss.stock)::int AS fisico
    FROM "StoreStock" ss JOIN "ProductSize" ps ON ps.id = ss."productSizeId" JOIN "Product" p ON p.id = ps."productId" JOIN "Store" s ON s.id = ss."storeId"
    WHERE s.code = ${loja} AND ss.stock > 0 AND p.active = true AND p.price > 0 AND p."imageUrl" IS NOT NULL AND p."imageUrl" <> ''
    GROUP BY p.id, p.name, p.brand, p.price ORDER BY fisico DESC LIMIT 10`;
  return rows.map((r) => ({ productId: r.id, nome: r.name, marca: r.brand, preco: Number(r.price), fisico: Number(r.fisico), loja }));
}

module.exports = {
  id: 'mkt.campanha',
  camada: 'especialista',
  missao: 'Montar o rascunho de uma campanha de marketing com produtos reais em estoque.',
  escuta: ['relogio.objetivo', 'mkt.candidatos'],
  emite: ['mkt.rascunho'],
  limiar: 0,
  custo: { tipo: 'ia-forte' },
  permissao: 'ler',
  regras: ['constituicao-comunicacao', 'nao-publicar-sozinho', 'dados-reais'],
  tempoMax: 90000,
  async disparar({ sinal, ler, pensar, objetivo }) {
    const d = sinal.dados || {};
    let produtos;
    if (sinal.tipo === 'relogio.objetivo') {
      const reg = (objetivo && objetivo.regiao) || d.regiao || [];
      if (!reg.some((r) => r === 'mkt.*' || r.startsWith('mkt.'))) return []; // objetivo sem marketing na região
      const loja = (objetivo && objetivo.loja) || sinal.loja;
      if (!loja) return [{ tipo: 'dado-faltante', dados: { motivo: 'objetivo de marketing sem loja definida', objetivoId: sinal.objetivoId } }];
      produtos = await produtosDaLoja(ler, loja);
    } else {
      produtos = (d.candidatos || []).slice(0, 8);
    }
    if (!produtos.length) return [];
    const r = await pensar({
      instrucao: INSTRUCAO,
      entrada: { objetivo: objetivo ? objetivo.texto : null, produtos: produtos.map((p) => ({ productId: p.productId, nome: p.nome, marca: p.marca, preco: p.preco, pecasNaLoja: p.fisico, loja: p.loja })) },
      schema: SCHEMA,
    });
    if (!r.ok || !r.json || !Array.isArray(r.json.pecas)) return [];
    const validos = new Set(produtos.map((p) => p.productId));
    const c = r.json;
    const pecas = c.pecas.slice(0, 3).map((p) => ({ formato: p.formato, texto: String(p.texto || ''), productIds: (p.productIds || []).filter((id) => validos.has(id)) }));
    const usados = [...new Set(pecas.flatMap((p) => p.productIds))];
    const fora = c.pecas.flatMap((p) => p.productIds || []).filter((id) => !validos.has(id));
    return [{
      tipo: 'mkt.rascunho',
      forca: 0.9,
      dados: {
        campanha: { titulo: String(c.titulo || ''), conceito: String(c.conceito || ''), gancho: String(c.gancho || ''), pecas, legenda: String(c.legenda || ''), chamada: String(c.chamada || '') },
        produtos: produtos.filter((p) => usados.includes(p.productId)),
        origem: sinal.tipo,
        produtosInventadosRemovidos: fora.length,
        chave: `campanha-${d.chave || sinal.objetivoId || sinal.id}`,
        evidencia: [
          sinal.tipo === 'relogio.objetivo' ? `Objetivo ${sinal.objetivoId}: estoque físico (StoreStock) da ${produtos[0].loja}` : `Candidatos do dia (${d.chave || sinal.id}): estoque físico alto + foto + margem`,
          `Produtos citados: ${usados.length} (todos da lista real)${fora.length ? `; ${fora.length} id(s) inventado(s) descartado(s)` : ''}`,
        ],
        preRevisao: revisarTexto([c.titulo, c.gancho, c.legenda, c.chamada].concat(pecas.map((p) => p.texto)).join('\n')).alertas,
      },
    }];
  },
};
