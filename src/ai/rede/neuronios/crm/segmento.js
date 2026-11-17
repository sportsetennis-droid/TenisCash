// crm.segmento — analista (IA barata)
// Recebe a lista de clientes a reativar e separa em SEGMENTOS por marca,
// esporte e tamanho, a partir das COMPRAS REAIS (SaleItem) e do CRM esportivo
// do próprio cliente (User.sportsPractice / shoeSize). A segmentação é regra;
// a IA só prioriza e dá o gancho de cada segmento (vê contagens, nunca ids).
const { revisarTexto } = require('../../regras/comercial');

const SCHEMA = {
  type: 'object',
  properties: { segmentos: { type: 'array', items: { type: 'object', properties: { chave: { type: 'string' }, prioridade: { type: 'integer' }, gancho: { type: 'string' } }, required: ['chave', 'gancho'] } } },
  required: ['segmentos'],
};
const MAX_SEG = 5;
const moda = (arr) => { const c = {}; for (const x of arr) if (x) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null; };
const ehCalcado = (cat) => /t[eê]nis|cal[cç]ad|chuteira|sapat|sand[aá]lia|chinelo/i.test(cat || '');
const esporte = (s) => { const t = String(s || '').split(/[,;/]/)[0].trim(); return t ? t.toLowerCase() : null; };

module.exports = {
  id: 'crm.segmento',
  camada: 'analista',
  missao: 'Separar os clientes a reativar em segmentos por esporte, marca e tamanho com base em compras reais.',
  escuta: ['crm.reativar'],
  emite: ['crm.lista'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'ler',
  regras: ['lgpd-sem-pii-no-sinal', 'dados-reais'],
  tempoMax: 45000,
  async disparar({ sinal, ler, pensar }) {
    const d = sinal.dados || {};
    const clientes = (d.clientes || []).filter((c) => c && c.userId);
    if (!clientes.length) return [];
    const ids = clientes.map((c) => c.userId);
    const itens = await ler.saleItem.findMany({
      where: { sale: { customerUserId: { in: ids } } },
      select: { brand: true, category: true, size: true, sale: { select: { customerUserId: true } } },
      take: 20000,
    });
    const perfis = await ler.user.findMany({ where: { id: { in: ids } }, select: { id: true, sportsPractice: true, shoeSize: true } });
    const perfil = new Map(perfis.map((p) => [p.id, p]));
    const porCliente = new Map();
    for (const i of itens) {
      const uid = i.sale.customerUserId;
      if (!porCliente.has(uid)) porCliente.set(uid, []);
      porCliente.get(uid).push(i);
    }
    // regra: segmento = marca mais comprada + esporte declarado; tamanho = o mais comprado em calçado
    const segs = new Map();
    for (const c of clientes) {
      const compras = porCliente.get(c.userId) || [];
      const p = perfil.get(c.userId) || {};
      const marca = moda(compras.map((i) => i.brand));
      const esp = esporte(p.sportsPractice);
      const tam = moda(compras.filter((i) => ehCalcado(i.category)).map((i) => i.size)) || (p.shoeSize ? String(p.shoeSize) : null);
      const chave = `${marca || 'sem-historico'}|${esp || 'sem-esporte'}`;
      if (!segs.has(chave)) segs.set(chave, { chave, marca, esporte: esp, tamanhos: {}, clientes: [], saldo: 0, origem: compras.length ? 'compras' : 'cadastro' });
      const s = segs.get(chave);
      s.clientes.push({ userId: c.userId, motivo: c.motivo || 'reativar' });
      s.saldo += Number(c.saldo || 0);
      if (tam) s.tamanhos[tam] = (s.tamanhos[tam] || 0) + 1;
    }
    let lista = [...segs.values()].sort((a, b) => b.clientes.length - a.clientes.length || b.saldo - a.saldo);
    // IA: prioriza e escreve o gancho (vê só contagens agregadas)
    const r = await pensar({
      instrucao: `Para cada segmento dê prioridade (1 = mais urgente) e um gancho comercial curto (motivo concreto para o cliente voltar à loja: produto da marca, esporte, cashback a usar). Não invente preço, desconto nem prazo. Máximo ${MAX_SEG} segmentos.`,
      entrada: { segmentos: lista.map((s) => ({ chave: s.chave, marca: s.marca, esporte: s.esporte, clientes: s.clientes.length, cashbackParadoRS: Math.round(s.saldo), tamanhosMaisComprados: s.tamanhos })) },
      schema: SCHEMA,
    });
    const ia = new Map(r.ok && r.json && Array.isArray(r.json.segmentos) ? r.json.segmentos.map((x) => [x.chave, x]) : []);
    if (ia.size) lista.sort((a, b) => ((ia.get(a.chave) || {}).prioridade || 99) - ((ia.get(b.chave) || {}).prioridade || 99));
    lista = lista.slice(0, MAX_SEG);
    return lista.map((s) => ({
      tipo: 'crm.lista',
      forca: 0.8,
      impactoRS: Math.round(s.saldo),
      dados: {
        motivo: 'reativar',
        segmento: { marca: s.marca, esporte: s.esporte, tamanhos: s.tamanhos, origem: s.origem },
        gancho: ia.get(s.chave) ? revisarTexto(ia.get(s.chave).gancho).texto : null,
        clientes: s.clientes,
        saldoParadoRS: Math.round(s.saldo * 100) / 100,
        chave: `lista-${d.semana || ''}-${s.chave}`,
        evidencia: [
          `${s.clientes.length} cliente(s) do sinal crm.reativar (${d.chave || sinal.id})`,
          s.origem === 'compras' ? `Marca ${s.marca} = a mais comprada por eles (SaleItem)` : 'Sem histórico de compra: segmento pelo cadastro (User)',
          s.esporte ? `Esporte declarado no cadastro (User.sportsPractice): ${s.esporte}` : 'Esporte não declarado',
        ],
      },
    }));
  },
};
