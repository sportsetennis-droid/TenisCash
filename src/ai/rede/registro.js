// =====================================================================
// RNA — registro dos neurônios (mini agentes)
// Carrega todo arquivo em src/ai/rede/neuronios/<dominio>/<nome>.js e
// valida o contrato. Índice: tipo de sinal → neurônios que escutam.
// =====================================================================
const fs = require('fs');
const path = require('path');

const CAMADAS = ['detector', 'analista', 'especialista', 'atuador'];
const CUSTO = { regra: 0, 'ia-barata': 1, 'ia-forte': 2 };
const PERMISSOES = ['ler', 'propor', 'agir'];

function validar(n, arquivo) {
  const erros = [];
  if (!n || typeof n !== 'object') return ['não exporta objeto'];
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(n.id || '')) erros.push('id inválido (use dominio.nome)');
  if (!CAMADAS.includes(n.camada)) erros.push('camada inválida');
  if (!n.missao || n.missao.length < 10) erros.push('missão vazia');
  if (!Array.isArray(n.escuta) || !n.escuta.length) erros.push('escuta vazia');
  if (!Array.isArray(n.emite)) erros.push('emite ausente');
  if (!n.custo || !(n.custo.tipo in CUSTO)) erros.push('custo.tipo inválido');
  if (!PERMISSOES.includes(n.permissao)) erros.push('permissão inválida');
  if (typeof n.disparar !== 'function') erros.push('disparar() ausente');
  if (n.camada === 'detector' && n.custo && n.custo.tipo !== 'regra') erros.push('detector tem que ser regra (custo zero)');
  return erros.map((e) => `${arquivo}: ${e}`);
}

function carregar(dir = path.join(__dirname, 'neuronios')) {
  const neuronios = new Map();
  const erros = [];
  if (!fs.existsSync(dir)) return { neuronios, erros, indice: new Map() };
  for (const dominio of fs.readdirSync(dir)) {
    const d = path.join(dir, dominio);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
      const arq = path.join(d, f);
      let n;
      try { n = require(arq); } catch (e) { erros.push(`${dominio}/${f}: falhou ao carregar: ${e.message}`); continue; }
      const es = validar(n, `${dominio}/${f}`);
      if (es.length) { erros.push(...es); continue; }
      if (neuronios.has(n.id)) { erros.push(`${dominio}/${f}: id duplicado ${n.id}`); continue; }
      neuronios.set(n.id, Object.assign({ limiar: 0, tempoMax: 20000, regras: [] }, n));
    }
  }
  return { neuronios, erros, indice: indexar(neuronios) };
}

function indexar(neuronios) {
  const indice = new Map(); // tipo exato ou prefixo 'nfe.*'
  for (const n of neuronios.values()) for (const t of n.escuta) {
    if (!indice.has(t)) indice.set(t, []);
    indice.get(t).push(n.id);
  }
  return indice;
}

function quemEscuta(indice, tipo) {
  const ids = new Set(indice.get(tipo) || []);
  const partes = tipo.split('.');
  for (let i = partes.length - 1; i > 0; i--) for (const id of indice.get(partes.slice(0, i).join('.') + '.*') || []) ids.add(id);
  return [...ids];
}

module.exports = { carregar, validar, indexar, quemEscuta, CUSTO, CAMADAS };
