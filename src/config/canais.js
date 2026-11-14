// =====================================================================
// canais.js — MAPA ÚNICO DA COMUNICAÇÃO (dono 2026-11-14)
// ---------------------------------------------------------------------
// 3 EMPRESAS, cada uma com SISTEMA PRÓPRIO (canais, CRM e robô separados):
//   st       → Sports & Tennis (central + uma loja por WhatsApp/Instagram)
//   baratao  → Baratão dos Esportes
//   metafard → Meta Fardamentos
// Uma empresa NUNCA fala pelo canal da outra, nem enxerga o CRM da outra.
// (Meta APS é saúde pública: fica FORA do CRM comercial de propósito.)
//
// Cada canal WhatsApp = 1 instância da Evolution (1 número/celular).
//   mode 'central' → número com robô (menu + IA) que já existia (9671).
//   mode 'loja'    → número de loja: a equipe atende; o sistema só cadastra o
//                    contato no CRM e pergunta o nome a quem chega pela 1ª vez.
//   mode 'robo'    → número com atendente próprio (Baratão, Meta Fardamentos).
// Números e @ vêm das bios do Instagram (lojasContato.js) e do dono.
// Campo sem fonte = null (NÃO inventar).
// =====================================================================
const { LOJAS } = require('./lojasContato');

const EMPRESAS = {
  st: { key: 'st', nome: 'Sports & Tennis', cor: '#F2561D' },
  baratao: { key: 'baratao', nome: 'Baratão dos Esportes', cor: '#D7141A' },
  metafard: { key: 'metafard', nome: 'Meta Fardamentos', cor: '#2E3192' },
};

function loja(code) { return LOJAS.find((l) => l.code === code) || {}; }

const CANAIS = [
  { instance: (process.env.EVOLUTION_INSTANCE || 'teniscash').trim(), empresa: 'st', storeCode: null,
    label: 'Sports & Tennis — Central', whatsapp: '558396713153', instagram: 'sportsetennis', mode: 'central' },
  { instance: 'bessa', empresa: 'st', storeCode: 'LOJA02', label: loja('LOJA02').titulo,
    whatsapp: loja('LOJA02').whatsapp || null, instagram: loja('LOJA02').instagram || null, mode: 'loja' },
  { instance: 'tambau', empresa: 'st', storeCode: 'LOJA05', label: loja('LOJA05').titulo,
    whatsapp: loja('LOJA05').whatsapp || null, instagram: loja('LOJA05').instagram || null, mode: 'loja' },
  { instance: 'tambia', empresa: 'st', storeCode: 'LOJA06', label: loja('LOJA06').titulo,
    whatsapp: loja('LOJA06').whatsapp || null, instagram: loja('LOJA06').instagram || null, mode: 'loja' },
  { instance: 'rainha', empresa: 'st', storeCode: 'LOJA03', label: loja('LOJA03').titulo,
    whatsapp: loja('LOJA03').whatsapp || null, instagram: loja('LOJA03').instagram || null, mode: 'loja' },
  { instance: 'manaira', empresa: 'st', storeCode: 'LOJA07', label: loja('LOJA07').titulo,
    whatsapp: loja('LOJA07').whatsapp || null, instagram: loja('LOJA07').instagram || null, mode: 'loja' },
  { instance: (process.env.BARATAO_EVOLUTION_INSTANCE || 'baratao').trim(), empresa: 'baratao', storeCode: 'LOJA01',
    label: 'Baratão dos Esportes', whatsapp: '5583998496016', instagram: 'barataodosesportes', mode: 'robo' },
  { instance: (process.env.METAFARD_EVOLUTION_INSTANCE || 'metafardamentos').trim(), empresa: 'metafard', storeCode: null,
    label: 'Meta Fardamentos', whatsapp: '558321823948', instagram: 'metafardamentos', mode: 'robo' },
];

function canalByInstance(instance) {
  const k = String(instance || '').trim();
  return CANAIS.find((c) => c.instance === k) || null;
}
function canaisDaEmpresa(empresa) { return CANAIS.filter((c) => c.empresa === empresa); }
function canalByInstagram(username) {
  const u = String(username || '').replace(/^@/, '').toLowerCase();
  return CANAIS.find((c) => c.instagram && c.instagram.toLowerCase() === u) || null;
}

module.exports = { EMPRESAS, CANAIS, canalByInstance, canaisDaEmpresa, canalByInstagram };
