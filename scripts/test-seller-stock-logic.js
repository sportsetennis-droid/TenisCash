const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.STOCK_LOGIC_TEST_PORT || '3125';
const BASE_URL = process.env.STOCK_LOGIC_BASE_URL || `http://127.0.0.1:${PORT}/api`;
const SHOULD_SPAWN = !process.env.STOCK_LOGIC_BASE_URL;

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line) || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
    if (name && !process.env[name]) process.env[name] = value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 30000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
      lastError = new Error(`health status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(750);
  }
  throw lastError || new Error('health timeout');
}

function startServer() {
  if (!SHOULD_SPAWN) return null;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT,
    DISABLE_STARTUP_JOBS: '1',
    RESEND_API_KEY: process.env.RESEND_API_KEY || 'dummy-for-stock-logic-test',
  };
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString(); });
  child.stderr.on('data', (chunk) => { err += chunk.toString(); });
  child.getLogs = () => ({ out, err });
  return child;
}

function stopServer(child) {
  if (!child || child.killed) return;
  child.kill();
}

function containsAll(text, terms) {
  return terms.every((term) => text.includes(term));
}

function containsNone(text, terms) {
  return terms.every((term) => !text.includes(term));
}

async function getSellerTokens(prisma, count) {
  const sellers = await prisma.user.findMany({
    where: {
      active: true,
      role: { in: ['seller', 'manager'] },
      storeId: { not: null },
    },
    select: { id: true, role: true, name: true },
    take: Math.max(count, 12),
  });
  if (!sellers.length) throw new Error('Nenhum vendedor ativo com loja para testar');
  const secret = process.env.JWT_SECRET || 'teniscash-secret-change-in-production';
  return sellers.map((seller) => jwt.sign(
    { userId: seller.id, role: seller.role },
    secret,
    { expiresIn: '15m' },
  ));
}

function stockLogicCases() {
  return [
    {
      name: 'pedido generico pede produto',
      message: 'vc pode procurar um produto no estoque',
      requireNoStockObject: true,
      must: ['Me diga o produto', 'tamanho'],
    },
    {
      name: 'produto tamanho explicito sem saldo por loja',
      message: 'takumi numero 42',
      requireStockObject: true,
      must: ['Nao encontrei saldo por loja', 'Tamanho 42: cadastrado', 'Estoque geral sem loja vinculada'],
    },
    {
      name: 'produto tamanho curto sem palavras de estoque',
      message: 'takumi 42',
      requireStockObject: true,
      must: ['Tamanho 42: cadastrado', 'Estoque geral sem loja vinculada'],
    },
    {
      name: 'produto tamanho curto perguntando loja',
      message: 'takumi 42 em qual loja',
      requireStockObject: true,
      must: ['Tamanho 42: cadastrado', 'Estoque geral sem loja vinculada'],
    },
    {
      name: 'produto tamanho com loja antes',
      message: 'em qual loja tem takumi 42',
      requireStockObject: true,
      must: ['Tamanho 42: cadastrado', 'Estoque geral sem loja vinculada'],
    },
    {
      name: 'modelo numerico nao traz outro modelo',
      message: 'boston 12 numero 41',
      requireStockObject: true,
      must: ['O que eu li no cadastro', 'Tamanho 41: cadastrado', 'Tamanho nao identificado'],
      mustNot: ['BOSTON 13'],
    },
    {
      name: 'modelo numerico curto nao traz outro modelo',
      message: 'boston 12 41',
      requireStockObject: true,
      must: ['Tamanho 41: cadastrado', 'Tamanho nao identificado'],
      mustNot: ['BOSTON 13'],
    },
    {
      name: 'qual loja com modelo numerico curto',
      message: 'qual loja tem boston 12 41',
      requireStockObject: true,
      must: ['Tamanho 41: cadastrado', 'Tamanho nao identificado'],
      mustNot: ['BOSTON 13'],
    },
    {
      name: 'listar tamanhos lidos',
      message: 'quais tamanhos do boston 12',
      requireStockObject: true,
      must: ['Tamanhos lidos', 'Tamanhos cadastrados sem saldo'],
      mustNot: ['BOSTON 13'],
    },
    {
      name: 'tamanho pedido nao existe na grade',
      message: 'drive rc numero 36',
      requireStockObject: true,
      must: ['Tamanho 36: nao aparece', 'Tamanho nao identificado'],
    },
    {
      name: 'tamanho real com saldo por loja',
      message: 'TENIS FILA RACER SPEEDZONE numero 40',
      requireStockObject: true,
      must: ['Consultei o estoque real', 'Tamanho 40:', 'LOJA'],
    },
    {
      name: 'tamanho real curto com saldo por loja',
      message: 'fila racer speedzone 40',
      requireStockObject: true,
      must: ['Consultei o estoque real', 'Tamanho 40:', 'LOJA'],
    },
    {
      name: 'produto inexistente com tamanho ainda usa estoque deterministico',
      message: 'xyzproduto 42',
      requireStockObject: true,
      must: ['nao localizei estoque registrado'],
    },
  ];
}

async function runCase(testCase, token) {
  const res = await fetch(`${BASE_URL}/seller/agent/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message: testCase.message }),
  });
  const data = await res.json().catch(() => ({}));
  const reply = data.reply || JSON.stringify(data);
  const checks = [['status 200', res.status === 200]];
  if (testCase.requireStockObject) checks.push(['tem stock object', !!data.stock]);
  if (testCase.requireNoStockObject) checks.push(['sem consulta stock', data.stock === null]);
  if (testCase.must) checks.push(['contem esperados', containsAll(reply, testCase.must)]);
  if (testCase.mustNot) checks.push(['nao contem proibidos', containsNone(reply, testCase.mustNot)]);
  return {
    ok: checks.every(([, pass]) => pass),
    checks,
    reply,
    conversationId: data.conversationId || null,
  };
}

async function cleanupConversations(prisma, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return;
  await prisma.aIConversation.deleteMany({ where: { id: { in: uniqueIds } } });
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL nao configurada. Configure .env ou STOCK_LOGIC_BASE_URL para rodar o teste de estoque.');
  }
  const prisma = new PrismaClient();
  const child = startServer();
  const createdConversationIds = [];
  try {
    await waitForHealth();
    const cases = stockLogicCases();
    const tokens = await getSellerTokens(prisma, cases.length);
    let failures = 0;
    for (let i = 0; i < cases.length; i += 1) {
      const testCase = cases[i];
      const result = await runCase(testCase, tokens[i % tokens.length]);
      if (result.conversationId) createdConversationIds.push(result.conversationId);
      if (!result.ok) failures += 1;
      console.log(`\n${result.ok ? 'PASS' : 'FAIL'} :: ${testCase.name}`);
      console.log(`msg: ${testCase.message}`);
      console.log(`checks: ${result.checks.map(([label, pass]) => `${pass ? 'ok' : 'bad'} ${label}`).join(' | ')}`);
      console.log(`reply: ${result.reply.slice(0, 900).replace(/\n/g, ' / ')}`);
    }
    if (failures) throw new Error(`seller stock logic failures: ${failures}`);
    console.log(`\nALL_PASS seller stock logic (${cases.length} cases)`);
  } finally {
    await cleanupConversations(prisma, createdConversationIds).catch((err) => {
      console.warn(`WARN cleanup failed: ${err.message}`);
    });
    await prisma.$disconnect();
    stopServer(child);
    if (child) {
      const logs = child.getLogs();
      if (logs.err.trim()) console.error(logs.err.trim());
    }
  }
}

main().catch((err) => {
  console.error(`TEST_ERROR: ${err.message}`);
  process.exit(1);
});
