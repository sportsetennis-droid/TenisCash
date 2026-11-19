// =====================================================================
// nuvem.correcao — ANALISTA (ia-barata; usa IA só pra redigir caso fora
// do padrão). Missão única: transformar um problema da Nuvemshop em UMA
// correção pronta pra o dono aprovar (proposta.nuvem), com prévia e evidência.
//   nuvem.incompleto  → despublicar (foto/descrição/classificação faltando)
//   nuvem.divergente  → ressincronizar o estoque físico (só estoque)
//   nuvem.ghost       → remover o card-fantasma (forte) | conferir à mão (médio)
// Nada acontece sem o "sim" do dono; a ação revalida as regras ao executar.
// Nunca propõe mudar preço.
// =====================================================================

const ROTULO = { foto: 'foto', descricao: 'descrição', classificacao: 'classificação (Categoria/Sub/Modalidade/Especialidade)' };

function nomeDe(d) {
  const p = d.produto || d.ghost || {};
  return [p.marca, p.nome].filter(Boolean).join(' ') || d.productId || d.ghostId;
}

function incompleto(d) {
  const falta = (d.falta || []).filter((f) => ROTULO[f]);
  if (!d.productId || !d.nuvemshopProductId || !falta.length) return null;
  const txt = falta.map((f) => ROTULO[f]).join(' + ');
  return {
    tipo: 'proposta.nuvem',
    dados: {
      chave: 'nuvem:despublicar:' + d.productId,
      titulo: 'Despublicar da Nuvemshop: ' + nomeDe(d) + ' (falta ' + txt + ')',
      descricao: 'Produto está publicado na loja online sem ' + txt + '. Regra inquebrável: a vitrine só mostra produto com foto, descrição e as 4 classificações. '
        + 'Despublicar oculta na loja (reversível) e NÃO apaga o card, o comprado nem o estoque.',
      risco: 'medio',
      acao: { nome: 'nuvem.despublicar', args: { productId: d.productId, nuvemshopProductId: d.nuvemshopProductId, falta } },
      previa: { produto: d.produto || null, nuvemshopProductId: d.nuvemshopProductId, muda: 'published: true → false na Nuvemshop', falta, classificacoesFaltando: d.classificacoesFaltando || undefined },
      evidencia: d.evidencia && d.evidencia.length ? d.evidencia : ['sinal nuvem.incompleto: falta ' + txt],
    },
  };
}

function divergente(d) {
  if (!d.productId || !d.nuvemshopProductId) return null;
  return {
    tipo: 'proposta.nuvem',
    dados: {
      chave: 'nuvem:ressincronizar:' + d.productId,
      titulo: 'Ressincronizar estoque na Nuvemshop: ' + nomeDe(d),
      descricao: 'O estoque registrado como publicado não bate com o estoque físico (Σ StoreStock das lojas que valem pra loja online). '
        + 'Ressincronizar manda SÓ o estoque físico (tamanho zerado = esgotado); não mexe em preço, foto nem descrição. '
        + (d.dadoFaltante && d.dadoFaltante.length ? 'Atenção: o estoque publicado não estava gravado localmente — a divergência veio só da falta de variante.' : ''),
      risco: 'baixo',
      acao: { nome: 'nuvem.ressincronizar-estoque', args: { productId: d.productId, nuvemshopProductId: d.nuvemshopProductId } },
      previa: { produto: d.produto || null, diferencas: d.diferencas || [], estoqueFisico: d.estoqueFisico, estoquePublicadoRegistrado: d.estoquePublicadoRegistrado || null },
      evidencia: d.evidencia && d.evidencia.length ? d.evidencia : ['sinal nuvem.divergente'],
    },
  };
}

function ghost(d) {
  if (!d.ghostId) return null;
  const forte = d.confianca === 'forte' && d.curadoId && d.nuvemshopProductId;
  if (!forte && d.confianca !== 'media') return null;
  return {
    tipo: 'proposta.nuvem',
    dados: {
      chave: 'nuvem:ghost:' + d.ghostId,
      titulo: (forte ? 'Remover card-fantasma: ' : 'Conferir possível card-fantasma: ') + nomeDe(d),
      descricao: forte
        ? 'O webhook product/created ecoou o push e criou um card cru (source=nuvemshop) no mesmo NS#' + d.nuvemshopProductId + ' do card curado. '
          + 'Remover = desativar o fantasma e apagar SÓ os mappings dele; o card curado continua mapeado e a loja Nuvemshop não muda.'
        : 'Card cru vindo da Nuvemshop com 1 tamanho e sem classificação, cujo código de barras já pertence a outro card. Conferir à mão antes de mexer (não há NS# duplicado que prove o eco).',
      risco: 'medio',
      acao: forte
        ? { nome: 'nuvem.remover-fantasma', args: { ghostId: d.ghostId, curadoId: d.curadoId, nuvemshopProductId: d.nuvemshopProductId } }
        : { nome: 'rna.registrar', args: {} },
      previa: { fantasma: d.ghost || null, curado: d.curado || { id: d.curadoId }, nuvemshopProductId: d.nuvemshopProductId || null, confianca: d.confianca },
      evidencia: d.evidencia && d.evidencia.length ? d.evidencia : ['sinal nuvem.ghost'],
    },
  };
}

module.exports = {
  id: 'nuvem.correcao',
  camada: 'analista',
  missao: 'Montar a correção pronta para aprovar de um problema da Nuvemshop (despublicar, remover fantasma ou ressincronizar).',
  escuta: ['nuvem.incompleto', 'nuvem.divergente', 'nuvem.ghost'],
  emite: ['proposta.nuvem'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['nuvemshop-foto-descricao', 'nuvemshop-4-classificacoes', 'nuvemshop-estoque-fisico', 'nuvemshop-ghost-webhook'],
  tempoMax: 30000,
  async disparar({ sinal, pensar }) {
    const d = sinal.dados || {};
    const porRegra = sinal.tipo === 'nuvem.incompleto' ? incompleto(d)
      : sinal.tipo === 'nuvem.divergente' ? divergente(d)
        : sinal.tipo === 'nuvem.ghost' ? ghost(d) : null;
    if (porRegra) return [porRegra];

    // Caso fora do padrão: só registra pra pessoa decidir. IA (se houver) apenas redige o texto
    // a partir da evidência — nunca escolhe ação nem inventa dado.
    const evidencia = Array.isArray(d.evidencia) && d.evidencia.length ? d.evidencia : null;
    if (!evidencia) return [{ tipo: 'dado-faltante', dados: { chave: 'correcao:' + sinal.id, motivo: 'sinal ' + sinal.tipo + ' sem evidência para propor correção' } }];
    let titulo = 'Conferir na Nuvemshop: ' + nomeDe(d);
    let descricao = 'Caso fora do padrão (' + sinal.tipo + '). Conferir à mão.';
    if (pensar) {
      const r = await pensar({
        instrucao: 'Redija título (até 90 caracteres) e descrição curta para o dono conferir este problema da Nuvemshop. Use SÓ a evidência. JSON {titulo, descricao}.',
        entrada: { tipo: sinal.tipo, evidencia, produto: d.produto || null },
        schema: { type: 'object', properties: { titulo: { type: 'string' }, descricao: { type: 'string' } }, required: ['titulo', 'descricao'] },
        maxTokens: 300,
      }).catch(() => null);
      if (r && r.ok && r.json && r.json.titulo) { titulo = String(r.json.titulo).slice(0, 120); descricao = String(r.json.descricao || descricao).slice(0, 1000); }
    }
    return [{ tipo: 'proposta.nuvem', dados: { chave: 'nuvem:conferir:' + (d.chave || sinal.id), titulo, descricao, risco: 'medio', acao: { nome: 'rna.registrar', args: {} }, previa: { sinal: sinal.tipo, dados: d }, evidencia } }];
  },
};
