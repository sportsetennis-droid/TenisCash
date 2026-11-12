// =====================================================================
// lojasContato.js — contatos PÚBLICOS das lojas Sports & Tennis (WhatsApp).
// FONTE: bio do Instagram de cada loja (lido em 2026-11-12) + ordem do dono.
// NOMES OFICIAIS (dono 2026-11-12): Praia do Bessa · Praia de Tambaú · Tambiá ·
// Rainha da Borborema (NUNCA chamar de "Campina Grande") · Praia de Manaíra.
// NÃO inventar: campo que a fonte não traz fica null e não aparece pro cliente.
// O Baratão fica FORA (outra empresa, outro atendimento — ordem do dono).
// =====================================================================

const SITE = 'https://www.sportsetennis.com.br';
const INSTAGRAM_GERAL = 'sportsetennis';

// Contato direto do dono (confirmado por ele em 2026-11-12). Apresentação:
// cargo ANTES do nome ("Founder & CEO") — ordem do dono.
const CEO = {
  titulo: 'Founder & CEO',
  nome: 'Douglas Bernardo',
  whatsapp: '5583987633161',
};

// code = Store.code no banco. aliases = como a loja aparece no estoque/conversa.
const LOJAS = [
  {
    code: 'LOJA02', nome: 'Praia do Bessa', titulo: 'Sports & Tennis Praia do Bessa',
    local: 'Parahyba Mall • Bessa', cidade: 'João Pessoa',
    whatsapp: '5583998742310', instagram: 'sportsetennisbessa',
    aliases: ['bessa', 'parahyba', 'parahyba mall'],
  },
  {
    code: 'LOJA05', nome: 'Praia de Tambaú', titulo: 'Sports & Tennis Praia de Tambaú',
    local: 'Pirâmide Shopping Tambaú', cidade: 'João Pessoa',
    whatsapp: '5583989042285', instagram: 'sportsetennistambau',
    aliases: ['tambau', 'piramide'],
  },
  {
    code: 'LOJA06', nome: 'Tambiá', titulo: 'Sports & Tennis Tambiá',
    local: 'Shopping Tambiá', cidade: 'João Pessoa',
    whatsapp: '5583998679818', instagram: 'sportsetennistambia',
    aliases: ['tambia'],
  },
  {
    code: 'LOJA03', nome: 'Rainha da Borborema', titulo: 'Sports & Tennis Rainha da Borborema',
    local: 'Complexo K', cidade: 'Campina Grande',
    whatsapp: '5583996765276', instagram: 'sportsetenniscg',
    aliases: ['campina', 'rainha', 'borborema', 'complexo k', 'cg'],
  },
  {
    code: 'LOJA07', nome: 'Praia de Manaíra', titulo: 'Sports & Tennis Praia de Manaíra',
    local: 'Liv Mall', cidade: 'João Pessoa',
    whatsapp: null, // a bio do Instagram não traz WhatsApp
    instagram: 'sportsetennismanaira',
    aliases: ['manaira', 'liv mall', 'liv'],
  },
  // Loja online: não aparece na lista de lojas físicas (hidden), mas existe pra
  // troca/garantia/lead de quem comprou pelo site (vai pra escala da LOJA04 ou pro grupo).
  {
    code: 'LOJA04', nome: 'Loja online', titulo: 'Sports & Tennis — loja online', hidden: true,
    local: 'Site', cidade: 'João Pessoa', whatsapp: null, instagram: null,
    aliases: ['online', 'site', 'internet', 'nuvemshop', 'ecommerce'],
  },
];

function normTxt(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Acha a loja por nome/apelido ("Tambau", "Rainha da Borborema", "LOJA05"...)
function findLoja(q) {
  const t = normTxt(q);
  if (!t) return null;
  return LOJAS.find(l => normTxt(l.code) === t || normTxt(l.nome) === t) ||
    LOJAS.find(l => l.aliases.some(a => new RegExp('\\b' + a + '\\b').test(t))) || null;
}

function mapsLink(loja) {
  const q = 'Sports & Tennis ' + loja.local.replace(/•/g, ' ') + ' ' + loja.cidade;
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q.replace(/\s+/g, ' ').trim());
}

function fmtPhone(d) {
  const s = String(d || '').replace(/\D/g, '').replace(/^55/, '');
  if (s.length === 11) return '(' + s.slice(0, 2) + ') ' + s.slice(2, 7) + '-' + s.slice(7);
  if (s.length === 10) return '(' + s.slice(0, 2) + ') ' + s.slice(2, 6) + '-' + s.slice(6);
  return s;
}

module.exports = { SITE, INSTAGRAM_GERAL, CEO, LOJAS, findLoja, mapsLink, fmtPhone, normTxt };
