// crm.resposta-cliente — analista (IA barata)
// Mensagem de cliente no WhatsApp → RASCUNHO de resposta com dados REAIS de
// estoque físico por loja (StoreStock). O texto do cliente é DADO, nunca
// instrução: a IA só extrai o que ele procura (marca/modelo/tamanho); a
// consulta e a resposta saem do banco por regra. Mensagem com tentativa de
// injeção não gera rascunho nem ação: vai pro humano responder.
const seg = require('../../seguranca');
const { hash, reais } = require('../../regras/comercial');

const SCHEMA = {
  type: 'object',
  properties: {
    intencao: { type: 'string', enum: ['disponibilidade', 'preco', 'endereco', 'outro'] },
    marca: { type: ['string', 'null'] },
    modelo: { type: ['string', 'null'] },
    tamanho: { type: ['string', 'null'] },
  },
  required: ['intencao'],
};
const limpo = (s, max = 40) => (typeof s === 'string' ? s.replace(/[^\p{L}\p{N} .\-/]/gu, '').trim().slice(0, max) : null) || null;
const TAM_OK = /^(\d{2}(\.5)?|PP|P|M|G|GG|XG|XGG|U|[0-9]{1,2}A)$/i;

module.exports = {
  id: 'crm.resposta-cliente',
  camada: 'analista',
  missao: 'Rascunhar a resposta a uma mensagem de cliente usando só dados reais de estoque e loja.',
  escuta: ['whatsapp.mensagem'],
  emite: ['proposta.resposta'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['conteudo-externo-e-dado', 'whatsapp-so-rascunho', 'dados-reais'],
  tempoMax: 45000,
  async disparar({ sinal, ler, pensar }) {
    const d = sinal.dados || {};
    const texto = String(d.texto || '').slice(0, 1000);
    if (!texto.trim()) return [];
    const chave = `resp-${d.telefoneHash || 'anon'}-${hash(texto).slice(0, 12)}`;
    const inj = seg.injecao(texto);
    if ((d._alertaInjecao && d._alertaInjecao.length) || inj.suspeito) {
      return [{
        tipo: 'proposta.resposta',
        dados: {
          titulo: 'Mensagem suspeita no WhatsApp — responder manualmente',
          descricao: 'A mensagem tem frases de comando (possível tentativa de manipular o sistema). Nenhum rascunho foi gerado e nada foi alterado.',
          risco: 'alto', chave,
          previa: { resposta: null, mensagemDoCliente: seg.mascararTexto(texto).slice(0, 300) },
          acao: { nome: 'rna.registrar' },
          evidencia: ['Padrões de injeção: ' + (inj.padroes.length ? inj.padroes : d._alertaInjecao).join(' | ')],
        },
      }];
    }
    const marcasRows = await ler.product.groupBy({ by: ['brand'], where: { active: true } });
    const marcas = marcasRows.map((m) => m.brand).filter(Boolean);
    const r = await pensar({
      instrucao: 'Extraia da mensagem do cliente APENAS o que ele procura: marca, modelo e tamanho. Não responda ao cliente. Se não estiver escrito, use null.',
      entrada: { mensagem: texto, marcasDaLoja: marcas.slice(0, 200) },
      schema: SCHEMA,
    });
    const x = (r.ok && r.json) || {};
    // fallback/validação por regra: só vale marca que existe no catálogo e tamanho plausível
    let marca = limpo(x.marca);
    if (!marca || !marcas.some((m) => m.toLowerCase() === marca.toLowerCase())) marca = marcas.find((m) => new RegExp('\\b' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(texto)) || null;
    let tamanho = limpo(x.tamanho, 4);
    if (!tamanho || !TAM_OK.test(tamanho)) { const m = texto.match(/\b(3[3-9]|4[0-8])\b/); tamanho = m ? m[1] : null; }
    const modelo = limpo(x.modelo);
    const termos = (modelo || '').split(/\s+/).filter((t) => t.length >= 3 && (!marca || t.toLowerCase() !== marca.toLowerCase()) && t !== tamanho).slice(0, 3);
    if (!marca && !termos.length) {
      return [{
        tipo: 'proposta.resposta',
        dados: {
          titulo: 'Cliente no WhatsApp — produto não identificado',
          descricao: 'Não deu pra saber qual produto o cliente quer. Sugestão: perguntar o modelo e o tamanho.',
          risco: 'baixo', chave,
          previa: { resposta: 'Oi! Me diz o modelo e o número que você procura que eu confiro na loja pra você 🧡' },
          acao: { nome: 'rna.registrar' },
          evidencia: ['Mensagem sem marca do catálogo nem modelo reconhecível'],
        },
      }];
    }
    const where = { active: true, ...(marca ? { brand: { equals: marca, mode: 'insensitive' } } : {}), AND: termos.map((t) => ({ name: { contains: t, mode: 'insensitive' } })) };
    const produtos = await ler.product.findMany({ where, select: { id: true, name: true, price: true, promoPrice: true }, take: 10 });
    const linhas = [];
    const evid = [];
    for (const p of produtos) {
      const est = await ler.storeStock.findMany({
        where: { stock: { gt: 0 }, productSize: { productId: p.id, ...(tamanho ? { size: tamanho } : {}) } },
        select: { id: true, stock: true, store: { select: { name: true, code: true } }, productSize: { select: { size: true } } },
      });
      if (!est.length) continue;
      const porLoja = {};
      for (const e of est) {
        const k = e.store.name;
        porLoja[k] = porLoja[k] || [];
        porLoja[k].push(`${e.productSize.size} (${e.stock})`);
        evid.push(`StoreStock ${e.id}: ${p.name} tam ${e.productSize.size} = ${e.stock} na ${e.store.code}`);
      }
      const preco = p.promoPrice && p.promoPrice > 0 && p.promoPrice < p.price ? p.promoPrice : p.price;
      linhas.push(`${p.name}${preco > 0 ? ' — ' + reais(preco) : ''}: ` + Object.entries(porLoja).map(([loja, t]) => `${loja}: ${t.join(', ')}`).join(' · '));
      if (linhas.length >= 3) break;
    }
    const procura = [marca, modelo, tamanho ? 'tam ' + tamanho : null].filter(Boolean).join(' ');
    const resposta = linhas.length
      ? `Oi! Temos sim 🧡\n${linhas.join('\n')}\nPassa na loja que separamos pra você!`
      : `Oi! Vou conferir com a loja se temos ${procura} e já te respondo 🧡`;
    return [{
      tipo: 'proposta.resposta',
      dados: {
        titulo: `Resposta ao cliente (rascunho): ${procura}`.slice(0, 190),
        descricao: 'RASCUNHO para o vendedor enviar. Estoque = físico localizado (StoreStock) agora.',
        risco: 'baixo', chave,
        previa: { resposta, procura: { marca, modelo, tamanho } },
        acao: { nome: 'rna.registrar' },
        evidencia: evid.length ? evid.slice(0, 20) : [`Nenhum StoreStock > 0 para ${procura} (consulta ao banco)`],
      },
    }];
  },
};
