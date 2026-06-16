// =====================================================================
// ncmRobot.js — Robô que mantém o NCM dos produtos sempre válido.
// =====================================================================
// Varre o catálogo ATIVO. Para cada produto cujo NCM está vazio, mal
// formatado, ou não existe mais na tabela oficial da SEFAZ, busca o NCM
// que o FORNECEDOR declarou na NFe de ENTRADA (XmlFiscalItem) e grava no
// produto — SE esse NCM for válido. Nunca inventa: se a nota de compra
// também não tem NCM válido, deixa como está e reporta pra conferência.
//
// Roda 1x ao dia (e ~3 min após o boot). Idempotente: só toca em produto
// com NCM inválido e só grava um NCM válido, então converge e para.
// Tabela oficial embutida em src/data/ncm-validos.json (offline; gerada
// por scripts/_gen_ncm_table.js). Sem a tabela, o robô NÃO grava nada.
// =====================================================================

const fs = require('node:fs');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

let _valid = null;
function validSet() {
  if (_valid) return _valid;
  _valid = new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ncm-validos.json'), 'utf8'));
    for (const c of arr) _valid.add(String(c));
  } catch (e) {
    console.error('[ncmRobot] tabela NCM nao carregada (nao vai gravar nada):', e.message);
  }
  return _valid;
}

const clean = v => String(v == null ? '' : v).replace(/\D/g, '');
// NCM ok = 8 dígitos E presente na tabela oficial (se a tabela carregou).
function ncmOk(v) {
  const c = clean(v);
  if (c.length !== 8) return false;
  const set = validSet();
  return set.size === 0 ? true : set.has(c); // tabela ausente = não derruba venda
}

let _lastReport = null;

async function runNcmRobot({ apply = true } = {}) {
  const started = Date.now();
  const valid = validSet();
  const tabelaOk = valid.size > 0;

  const prods = await prisma.product.findMany({ where: { active: true }, select: { id: true, name: true, ncm: true } });
  const fixed = [];
  const unresolved = [];

  // Só os produtos com NCM inválido/ausente
  const ruins = prods.filter(p => !ncmOk(p.ncm));
  if (!tabelaOk) {
    for (const p of ruins) unresolved.push({ id: p.id, name: p.name, ncm: clean(p.ncm) || null, motivo: 'tabela NCM ausente' });
  } else if (ruins.length) {
    // 1 consulta (em lotes) p/ pegar o NCM da NFe de entrada de TODOS de uma vez (sem N+1)
    const ids = ruins.map(p => p.id);
    const entradaNcm = new Map(); // productId -> primeiro NCM válido da entrada
    for (let i = 0; i < ids.length; i += 500) {
      const its = await prisma.xmlFiscalItem.findMany({ where: { productId: { in: ids.slice(i, i + 500) } }, select: { productId: true, ncm: true } });
      for (const it of its) {
        if (entradaNcm.has(it.productId)) continue;
        const c = clean(it.ncm);
        if (c.length === 8 && valid.has(c)) entradaNcm.set(it.productId, c);
      }
    }
    // grava (em lote) os que têm NCM válido na entrada
    const seenItem = new Set((await prisma.xmlFiscalItem.findMany({ where: { productId: { in: ids } }, select: { productId: true }, distinct: ['productId'] })).map(x => x.productId));
    for (const p of ruins) {
      const novo = entradaNcm.get(p.id);
      if (novo && novo !== clean(p.ncm)) {
        if (apply) await prisma.product.update({ where: { id: p.id }, data: { ncm: novo } });
        fixed.push({ id: p.id, name: p.name, de: clean(p.ncm) || null, para: novo });
      } else {
        unresolved.push({
          id: p.id, name: p.name, ncm: clean(p.ncm) || null,
          motivo: !seenItem.has(p.id) ? 'sem NFe de entrada' : (novo ? 'entrada tem o mesmo NCM invalido' : 'NFe de entrada sem NCM valido'),
        });
      }
    }
  }

  _lastReport = {
    at: new Date().toISOString(), apply, tabelaOk,
    totalAtivos: prods.length, comNcmInvalido: fixed.length + unresolved.length,
    corrigidos: fixed.length, pendentes: unresolved.length,
    fixed, unresolved, ms: Date.now() - started,
  };
  console.log('[ncmRobot]', apply ? 'APLICADO' : 'dry-run',
    '— ativos', prods.length, '| invalidos', fixed.length + unresolved.length,
    '| corrigidos', fixed.length, '| pendentes', unresolved.length, '|', (_lastReport.ms / 1000).toFixed(1) + 's');
  return _lastReport;
}

function lastReport() { return _lastReport; }

let _interval = null;
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 1x por dia
function startNcmRobot() {
  if (_interval) return;
  console.log('[ncmRobot] agendado: 1x/dia (preenche NCM faltante/invalido pela NFe de entrada)');
  setTimeout(() => {
    runNcmRobot({ apply: true }).catch(e => console.error('[ncmRobot] first run:', e.message));
    _interval = setInterval(() => runNcmRobot({ apply: true }).catch(e => console.error('[ncmRobot] interval:', e.message)), INTERVAL_MS);
  }, 3 * 60 * 1000); // 3 min após boot
}
function stopNcmRobot() { if (_interval) { clearInterval(_interval); _interval = null; } }

module.exports = { runNcmRobot, startNcmRobot, stopNcmRobot, lastReport, ncmOk };
