// crm.rascunho-whatsapp — analista (IA barata)
// Recebe uma lista de clientes (segmento de reativação OU atletas sem CPF)
// e monta o RASCUNHO da mensagem de WhatsApp. NUNCA envia: vira
// proposta.whatsapp; só depois do "sim" do dono a ação enfileira o texto
// APROVADO, exatamente igual. Texto segue a Constituição de Comunicação.
const { hash, reais, revisarTexto } = require('../../regras/comercial');

const SCHEMA = { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] };
const MAX_DEST = 200;

const INSTRUCAO = [
  'Escreva UMA mensagem de WhatsApp curta (até 450 caracteres) da Sports & Tennis para o cliente.',
  'Comece com "Oi, {nome}!" — use exatamente o marcador {nome}, ele é trocado pelo primeiro nome depois.',
  'Estrutura que vende: gancho concreto + benefício + convite para ir à loja. Sem frase motivacional.',
  'Proibido: inventar preço, desconto, percentual, prazo, estoque ou "últimas unidades"; "sem juros"; "consultor" (é vendedor); "consulte seu tamanho" como chamada; pedir CPF, senha ou dados pessoais pelo WhatsApp.',
  'Cor sempre por extenso. Emoji só 🧡 (no máximo 1). Termine convidando a passar na loja Sports & Tennis.',
].join(' ');

module.exports = {
  id: 'crm.rascunho-whatsapp',
  camada: 'analista',
  missao: 'Montar o rascunho da mensagem de WhatsApp para uma lista de clientes, sem nunca enviar.',
  escuta: ['crm.lista'],
  emite: ['proposta.whatsapp'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['whatsapp-so-rascunho', 'constituicao-comunicacao', 'vendedor-nao-consultor', 'lgpd-sem-pii-no-sinal'],
  tempoMax: 45000,
  async disparar({ sinal, pensar }) {
    const d = sinal.dados || {};
    const clientes = (d.clientes || []).filter((c) => c && c.userId).slice(0, MAX_DEST);
    if (!clientes.length) return [];
    const semCpf = d.motivo === 'sem-cpf';
    const contexto = semCpf
      ? { objetivo: 'avisar o atleta que a medalha/resultado do torneio dele está esperando e ele precisa completar o cadastro NO APP Club (não pelo WhatsApp) para receber', torneio: d.torneio && d.torneio.nome }
      : { objetivo: 'trazer de volta à loja cliente que sumiu e/ou tem cashback TenisCash parado para usar', marca: d.segmento && d.segmento.marca, esporte: d.segmento && d.segmento.esporte, gancho: d.gancho, temCashbackParado: (d.saldoParadoRS || 0) > 0 };
    const r = await pensar({ instrucao: INSTRUCAO, entrada: contexto, schema: SCHEMA });
    if (!r.ok || !r.json || !r.json.texto) return [];
    const rev = revisarTexto(r.json.texto);
    let texto = rev.texto.slice(0, 600);
    if (!/\{nome\}/.test(texto)) texto = 'Oi, {nome}! ' + texto;
    const userIds = clientes.map((c) => c.userId);
    const alvo = semCpf ? `atletas sem CPF — ${(d.torneio && d.torneio.nome) || 'torneio'}` : `reativação — ${(d.segmento && d.segmento.marca) || 'sem marca'}${d.segmento && d.segmento.esporte ? ' / ' + d.segmento.esporte : ''}`;
    return [{
      tipo: 'proposta.whatsapp',
      impactoRS: sinal.impactoRS,
      dados: {
        titulo: `WhatsApp (rascunho) · ${alvo} · ${userIds.length} cliente(s)`,
        descricao: 'RASCUNHO. Nada é enviado sem a sua aprovação. Aprovar enfileira exatamente este texto para os clientes listados (com consentimento LGPD).',
        risco: rev.alertas.length ? 'alto' : 'medio',
        chave: 'wa-' + (d.chave || hash(userIds.join(',')).slice(0, 16)),
        previa: { texto, destinatarios: userIds.length, correcoesAutomaticas: rev.corrigido, alertas: rev.alertas, saldoParadoRS: d.saldoParadoRS ? reais(d.saldoParadoRS) : null },
        acao: { nome: 'crm.whatsapp-aprovado', args: { userIds, texto, textoHash: hash(texto) } },
        evidencia: (d.evidencia || []).concat([`Lista vinda de ${sinal.origem} (${d.chave || sinal.id})`]),
      },
    }];
  },
};
