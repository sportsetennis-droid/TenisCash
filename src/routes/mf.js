// =====================================================================
// META FARDAMENTOS — API do sistema proprio (ERP/CRM/Estoque/Categoria/Ponto)
// Montado em /api/mf. EMPRESA SEPARADA da S&T — usa SO tabelas Mf* (isolado).
// Auth proprio de funcionario (JWT scoped mf:true), NUNCA o User da S&T.
// =====================================================================

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { prisma } = require('../middleware');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'teniscash-dev-secret';
const TZ = 'America/Fortaleza';

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function signToken(emp) {
  return jwt.sign({ mf: true, id: emp.id, role: emp.role, name: emp.name }, JWT_SECRET, { expiresIn: '30d' });
}

function dayStr(d = new Date()) {
  // YYYY-MM-DD no fuso de Joao Pessoa (en-CA = ISO-like)
  return new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
}

async function mfAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Nao autenticado' });
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !payload.mf || !payload.id) return res.status(401).json({ error: 'Token invalido' });
    const emp = await prisma.mfEmployee.findUnique({ where: { id: payload.id } });
    if (!emp || !emp.active) return res.status(401).json({ error: 'Funcionario inativo' });
    req.emp = emp;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessao expirada' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.emp || !roles.includes(req.emp.role)) return res.status(403).json({ error: 'Sem permissao' });
    next();
  };
}

const isManager = (req) => req.emp && (req.emp.role === 'admin' || req.emp.role === 'gerente');

async function getCompany() {
  let c = await prisma.mfCompany.findFirst();
  if (!c) c = await prisma.mfCompany.create({ data: {} }); // defaults: META FARDAMENTOS LTDA + CNPJ/IE
  return c;
}

// =====================================================================
// AUTH / SETUP
// =====================================================================

// Estado: precisa criar o primeiro admin?
router.get('/auth/status', async (_req, res) => {
  const count = await prisma.mfEmployee.count();
  res.json({ setup: count === 0 });
});

// Primeiro acesso: cria o admin inicial (SO se nao existir nenhum funcionario)
router.post('/auth/setup', async (req, res) => {
  try {
    const count = await prisma.mfEmployee.count();
    if (count > 0) return res.status(400).json({ error: 'Sistema ja inicializado. Use o login.' });
    const { name, username, pin } = req.body || {};
    if (!name || !username || !pin) return res.status(400).json({ error: 'Nome, usuario e PIN sao obrigatorios' });
    if (String(pin).length < 4) return res.status(400).json({ error: 'PIN deve ter ao menos 4 digitos' });
    await getCompany();
    const emp = await prisma.mfEmployee.create({
      data: { name, username: String(username).toLowerCase().trim(), pinHash: bcrypt.hashSync(String(pin), 8), role: 'admin' },
    });
    res.json({ token: signToken(emp), employee: { id: emp.id, name: emp.name, role: emp.role } });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'Usuario ja existe' });
    console.error('[mf/setup]', err.message);
    res.status(500).json({ error: 'Erro ao inicializar' });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { username, pin } = req.body || {};
    if (!username || !pin) return res.status(400).json({ error: 'Usuario e PIN obrigatorios' });
    const emp = await prisma.mfEmployee.findUnique({ where: { username: String(username).toLowerCase().trim() } });
    if (!emp || !emp.active || !bcrypt.compareSync(String(pin), emp.pinHash)) {
      return res.status(401).json({ error: 'Usuario ou PIN incorreto' });
    }
    res.json({ token: signToken(emp), employee: { id: emp.id, name: emp.name, role: emp.role } });
  } catch (err) {
    console.error('[mf/login]', err.message);
    res.status(500).json({ error: 'Erro no login' });
  }
});

router.get('/me', mfAuth, async (req, res) => {
  res.json({ id: req.emp.id, name: req.emp.name, username: req.emp.username, role: req.emp.role });
});

// =====================================================================
// EMPRESA
// =====================================================================
router.get('/company', mfAuth, async (_req, res) => res.json(await getCompany()));

router.put('/company', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  const c = await getCompany();
  const { tradeName, name, cnpj, ie, phone, email, address, city, state } = req.body || {};
  const upd = await prisma.mfCompany.update({
    where: { id: c.id },
    data: { tradeName, name, cnpj, ie, phone, email, address, city, state },
  });
  res.json(upd);
});

// =====================================================================
// FUNCIONARIOS (admin/gerente gerencia)
// =====================================================================
router.get('/employees', mfAuth, async (_req, res) => {
  const list = await prisma.mfEmployee.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, username: true, role: true, phone: true, cpf: true, active: true, hireDate: true, baseSalary: true },
  });
  res.json(list);
});

router.post('/employees', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  try {
    const { name, username, pin, role, phone, cpf, baseSalary, hireDate } = req.body || {};
    if (!name || !username || !pin) return res.status(400).json({ error: 'Nome, usuario e PIN obrigatorios' });
    const emp = await prisma.mfEmployee.create({
      data: {
        name,
        username: String(username).toLowerCase().trim(),
        pinHash: bcrypt.hashSync(String(pin), 8),
        role: ['admin', 'gerente', 'funcionario'].includes(role) ? role : 'funcionario',
        phone: phone || null,
        cpf: cpf || null,
        baseSalary: baseSalary ? Number(baseSalary) : null,
        hireDate: hireDate ? new Date(hireDate) : null,
      },
    });
    res.json({ id: emp.id });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'Usuario ja existe' });
    res.status(500).json({ error: 'Erro ao criar funcionario' });
  }
});

router.put('/employees/:id', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  try {
    const { name, role, phone, cpf, baseSalary, hireDate, active, pin } = req.body || {};
    const data = {};
    if (name !== undefined) data.name = name;
    if (role && ['admin', 'gerente', 'funcionario'].includes(role)) data.role = role;
    if (phone !== undefined) data.phone = phone || null;
    if (cpf !== undefined) data.cpf = cpf || null;
    if (baseSalary !== undefined) data.baseSalary = baseSalary ? Number(baseSalary) : null;
    if (hireDate !== undefined) data.hireDate = hireDate ? new Date(hireDate) : null;
    if (active !== undefined) data.active = !!active;
    if (pin) data.pinHash = bcrypt.hashSync(String(pin), 8);
    await prisma.mfEmployee.update({ where: { id: req.params.id }, data });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar' });
  }
});

// =====================================================================
// CATEGORIAS
// =====================================================================
router.get('/categories', mfAuth, async (_req, res) => {
  const list = await prisma.mfCategory.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true } } },
  });
  res.json(list.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, active: c.active, products: c._count.products })));
});

router.post('/categories', mfAuth, async (req, res) => {
  const { name, parentId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  const c = await prisma.mfCategory.create({ data: { name, parentId: parentId || null } });
  res.json(c);
});

router.put('/categories/:id', mfAuth, async (req, res) => {
  const { name, active } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = name;
  if (active !== undefined) data.active = !!active;
  await prisma.mfCategory.update({ where: { id: req.params.id }, data });
  res.json({ ok: true });
});

router.delete('/categories/:id', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  const n = await prisma.mfProduct.count({ where: { categoryId: req.params.id } });
  if (n > 0) return res.status(400).json({ error: `Categoria tem ${n} produto(s). Mova-os antes.` });
  await prisma.mfCategory.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// =====================================================================
// PRODUTOS
// =====================================================================
router.get('/products', mfAuth, async (req, res) => {
  const { q, categoryId, low } = req.query || {};
  const where = { active: true };
  if (categoryId) where.categoryId = String(categoryId);
  if (q) where.OR = [{ name: { contains: String(q), mode: 'insensitive' } }, { ref: { contains: String(q), mode: 'insensitive' } }];
  let list = await prisma.mfProduct.findMany({ where, orderBy: { name: 'asc' }, include: { category: { select: { name: true } } } });
  if (low === '1') list = list.filter((p) => p.stock <= p.minStock);
  res.json(list);
});

router.post('/products', mfAuth, async (req, res) => {
  const { name, ref, categoryId, unit, size, color, costPrice, salePrice, minStock, stock, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  const p = await prisma.mfProduct.create({
    data: {
      name,
      ref: ref || null,
      categoryId: categoryId || null,
      unit: unit || 'un',
      size: size || null,
      color: color || null,
      costPrice: Number(costPrice) || 0,
      salePrice: Number(salePrice) || 0,
      minStock: parseInt(minStock) || 0,
      stock: 0,
      description: description || null,
    },
  });
  // estoque inicial (se informado) entra como movimento de entrada (rastreavel)
  const initial = parseInt(stock) || 0;
  if (initial > 0) {
    await prisma.$transaction([
      prisma.mfStockMovement.create({ data: { productId: p.id, type: 'entrada', qty: initial, balanceAfter: initial, reason: 'estoque inicial', employeeId: req.emp.id } }),
      prisma.mfProduct.update({ where: { id: p.id }, data: { stock: initial } }),
    ]);
  }
  res.json({ id: p.id });
});

router.put('/products/:id', mfAuth, async (req, res) => {
  const { name, ref, categoryId, unit, size, color, costPrice, salePrice, minStock, description, active } = req.body || {};
  const data = {};
  for (const [k, v] of Object.entries({ name, ref, unit, size, color, description })) if (v !== undefined) data[k] = v || null;
  if (name !== undefined) data.name = name; // nome nao pode ser null
  if (categoryId !== undefined) data.categoryId = categoryId || null;
  if (costPrice !== undefined) data.costPrice = Number(costPrice) || 0;
  if (salePrice !== undefined) data.salePrice = Number(salePrice) || 0;
  if (minStock !== undefined) data.minStock = parseInt(minStock) || 0;
  if (active !== undefined) data.active = !!active;
  await prisma.mfProduct.update({ where: { id: req.params.id }, data });
  res.json({ ok: true });
});

// =====================================================================
// ESTOQUE — movimentacoes (entrada/saida/ajuste). Mexe no saldo do produto.
// =====================================================================
router.get('/stock/movements', mfAuth, async (req, res) => {
  const where = {};
  if (req.query.productId) where.productId = String(req.query.productId);
  const list = await prisma.mfStockMovement.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { product: { select: { name: true } }, employee: { select: { name: true } } },
  });
  res.json(list);
});

router.post('/stock/movements', mfAuth, async (req, res) => {
  try {
    const { productId, type, qty, reason } = req.body || {};
    const n = parseInt(qty);
    if (!productId || !['entrada', 'saida', 'ajuste'].includes(type) || !n || n <= 0) {
      return res.status(400).json({ error: 'Produto, tipo e quantidade (>0) obrigatorios' });
    }
    const prod = await prisma.mfProduct.findUnique({ where: { id: productId } });
    if (!prod) return res.status(404).json({ error: 'Produto nao encontrado' });
    let newStock = prod.stock;
    if (type === 'entrada') newStock += n;
    else if (type === 'saida') newStock -= n;
    else if (type === 'ajuste') newStock = n; // ajuste = define o saldo absoluto
    if (newStock < 0) return res.status(400).json({ error: `Estoque insuficiente (atual: ${prod.stock})` });
    await prisma.$transaction([
      prisma.mfStockMovement.create({ data: { productId, type, qty: n, balanceAfter: newStock, reason: reason || null, employeeId: req.emp.id } }),
      prisma.mfProduct.update({ where: { id: productId }, data: { stock: newStock } }),
    ]);
    res.json({ ok: true, stock: newStock });
  } catch (err) {
    console.error('[mf/stock]', err.message);
    res.status(500).json({ error: 'Erro ao movimentar estoque' });
  }
});

// =====================================================================
// CLIENTES (CRM)
// =====================================================================
router.get('/customers', mfAuth, async (req, res) => {
  const where = { active: true };
  if (req.query.q) where.OR = [{ name: { contains: String(req.query.q), mode: 'insensitive' } }, { doc: { contains: String(req.query.q) } }];
  const list = await prisma.mfCustomer.findMany({ where, orderBy: { name: 'asc' }, include: { _count: { select: { orders: true } } } });
  res.json(list);
});

router.post('/customers', mfAuth, async (req, res) => {
  const { name, type, doc, segment, phone, email, address, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  const c = await prisma.mfCustomer.create({
    data: { name, type: type === 'pf' ? 'pf' : 'pj', doc: doc || null, segment: segment || null, phone: phone || null, email: email || null, address: address || null, notes: notes || null },
  });
  res.json({ id: c.id });
});

router.put('/customers/:id', mfAuth, async (req, res) => {
  const { name, type, doc, segment, phone, email, address, notes, active } = req.body || {};
  const data = {};
  for (const [k, v] of Object.entries({ name, doc, segment, phone, email, address, notes })) if (v !== undefined) data[k] = v || null;
  if (name !== undefined) data.name = name;
  if (type !== undefined) data.type = type === 'pf' ? 'pf' : 'pj';
  if (active !== undefined) data.active = !!active;
  await prisma.mfCustomer.update({ where: { id: req.params.id }, data });
  res.json({ ok: true });
});

// =====================================================================
// LEADS (CRM) — recebe tambem os leads do atendente de WhatsApp
// =====================================================================
router.get('/leads', mfAuth, async (req, res) => {
  const where = {};
  if (req.query.status) where.status = String(req.query.status);
  const list = await prisma.mfLead.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300, include: { customer: { select: { name: true } } } });
  res.json(list);
});

router.post('/leads', mfAuth, async (req, res) => {
  const { name, phone, segment, tipoFardamento, quantidade, personalizacao, resumo, source } = req.body || {};
  const l = await prisma.mfLead.create({
    data: { name: name || null, phone: phone || null, segment: segment || null, tipoFardamento: tipoFardamento || null, quantidade: quantidade || null, personalizacao: personalizacao || null, resumo: resumo || null, source: source || 'manual' },
  });
  res.json({ id: l.id });
});

router.put('/leads/:id', mfAuth, async (req, res) => {
  const { status, customerId, name, phone, resumo } = req.body || {};
  const data = {};
  if (status && ['novo', 'contatado', 'orcamento', 'fechado', 'perdido'].includes(status)) data.status = status;
  if (customerId !== undefined) data.customerId = customerId || null;
  if (name !== undefined) data.name = name || null;
  if (phone !== undefined) data.phone = phone || null;
  if (resumo !== undefined) data.resumo = resumo || null;
  await prisma.mfLead.update({ where: { id: req.params.id }, data });
  res.json({ ok: true });
});

// Converte um lead em cliente (CRM)
router.post('/leads/:id/convert', mfAuth, async (req, res) => {
  const lead = await prisma.mfLead.findUnique({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' });
  if (lead.customerId) return res.json({ customerId: lead.customerId });
  const cust = await prisma.mfCustomer.create({
    data: { name: lead.name || 'Cliente WhatsApp', type: 'pj', segment: lead.segment || null, phone: lead.phone || null, notes: lead.resumo || null },
  });
  await prisma.mfLead.update({ where: { id: lead.id }, data: { customerId: cust.id, status: 'contatado' } });
  res.json({ customerId: cust.id });
});

// =====================================================================
// PEDIDOS / ORCAMENTOS (ERP)
// =====================================================================
router.get('/orders', mfAuth, async (req, res) => {
  const where = {};
  if (req.query.status) where.status = String(req.query.status);
  const list = await prisma.mfOrder.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { customer: { select: { name: true } }, _count: { select: { items: true } } },
  });
  res.json(list);
});

router.get('/orders/:id', mfAuth, async (req, res) => {
  const o = await prisma.mfOrder.findUnique({ where: { id: req.params.id }, include: { customer: true, items: true, employee: { select: { name: true } } } });
  if (!o) return res.status(404).json({ error: 'Pedido nao encontrado' });
  res.json(o);
});

router.post('/orders', mfAuth, async (req, res) => {
  try {
    const { customerId, status, notes, items } = req.body || {};
    const lines = Array.isArray(items) ? items : [];
    const total = lines.reduce((s, it) => s + (Number(it.unitPrice) || 0) * (parseInt(it.qty) || 0), 0);
    const last = await prisma.mfOrder.findFirst({ orderBy: { number: 'desc' }, select: { number: true } });
    const number = (last?.number || 0) + 1;
    const o = await prisma.mfOrder.create({
      data: {
        number,
        customerId: customerId || null,
        status: ['orcamento', 'confirmado', 'producao', 'entregue', 'cancelado'].includes(status) ? status : 'orcamento',
        notes: notes || null,
        total,
        employeeId: req.emp.id,
        items: {
          create: lines.map((it) => ({
            productId: it.productId || null,
            description: it.description || 'Item',
            qty: parseInt(it.qty) || 1,
            unitPrice: Number(it.unitPrice) || 0,
            total: (Number(it.unitPrice) || 0) * (parseInt(it.qty) || 1),
          })),
        },
      },
    });
    res.json({ id: o.id, number: o.number });
  } catch (err) {
    console.error('[mf/orders]', err.message);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  }
});

router.put('/orders/:id/status', mfAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!['orcamento', 'confirmado', 'producao', 'entregue', 'cancelado'].includes(status)) return res.status(400).json({ error: 'Status invalido' });
  await prisma.mfOrder.update({ where: { id: req.params.id }, data: { status } });
  res.json({ ok: true });
});

// =====================================================================
// PONTO (bater ponto)
// =====================================================================
const PUNCH_KINDS = ['in', 'break_in', 'break_out', 'out'];

router.post('/ponto', mfAuth, async (req, res) => {
  try {
    const { kind, lat, lng } = req.body || {};
    if (!PUNCH_KINDS.includes(kind)) return res.status(400).json({ error: 'Tipo de batida invalido' });
    const entry = await prisma.mfTimeEntry.create({
      data: { employeeId: req.emp.id, kind, day: dayStr(), lat: lat ? Number(lat) : null, lng: lng ? Number(lng) : null },
    });
    res.json({ ok: true, at: entry.at, kind: entry.kind });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao bater ponto' });
  }
});

// Ponto de hoje do funcionario logado
router.get('/ponto/today', mfAuth, async (req, res) => {
  const list = await prisma.mfTimeEntry.findMany({ where: { employeeId: req.emp.id, day: dayStr() }, orderBy: { at: 'asc' } });
  res.json({ day: dayStr(), entries: list });
});

// Historico (proprio funcionario; gerente/admin pode ver de todos via ?employeeId=)
router.get('/ponto/history', mfAuth, async (req, res) => {
  const employeeId = (isManager(req) && req.query.employeeId) ? String(req.query.employeeId) : req.emp.id;
  const list = await prisma.mfTimeEntry.findMany({ where: { employeeId }, orderBy: { at: 'desc' }, take: 300, include: { employee: { select: { name: true } } } });
  res.json(list);
});

// Espelho do dia de TODOS (gerente/admin) — quem ja bateu hoje
router.get('/ponto/board', mfAuth, requireRole('admin', 'gerente'), async (_req, res) => {
  const day = dayStr();
  const entries = await prisma.mfTimeEntry.findMany({ where: { day }, orderBy: { at: 'asc' }, include: { employee: { select: { name: true } } } });
  const byEmp = {};
  for (const e of entries) {
    const k = e.employeeId;
    if (!byEmp[k]) byEmp[k] = { name: e.employee?.name || '?', punches: [] };
    byEmp[k].punches.push({ kind: e.kind, at: e.at });
  }
  res.json({ day, employees: Object.values(byEmp) });
});

// =====================================================================
// DASHBOARD
// =====================================================================
router.get('/dashboard', mfAuth, async (_req, res) => {
  const [products, lowStock, customers, leadsNovos, orcamentos, pedidosAbertos] = await Promise.all([
    prisma.mfProduct.count({ where: { active: true } }),
    prisma.mfProduct.count({ where: { active: true, stock: { lte: 0 } } }),
    prisma.mfCustomer.count({ where: { active: true } }),
    prisma.mfLead.count({ where: { status: 'novo' } }),
    prisma.mfOrder.count({ where: { status: 'orcamento' } }),
    prisma.mfOrder.count({ where: { status: { in: ['confirmado', 'producao'] } } }),
  ]);
  res.json({ products, lowStock, customers, leadsNovos, orcamentos, pedidosAbertos });
});

module.exports = router;
