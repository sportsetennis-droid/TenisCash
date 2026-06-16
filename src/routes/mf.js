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
  const { name, ref, ncm, categoryId, unit, size, color, costPrice, salePrice, minStock, stock, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
  const p = await prisma.mfProduct.create({
    data: {
      name,
      ref: ref || null,
      ncm: (ncm ? String(ncm).replace(/\D/g, '') : null) || null,
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
  const { name, ref, ncm, categoryId, unit, size, color, costPrice, salePrice, minStock, description, active } = req.body || {};
  const data = {};
  for (const [k, v] of Object.entries({ name, ref, unit, size, color, description })) if (v !== undefined) data[k] = v || null;
  if (ncm !== undefined) data.ncm = ncm ? String(ncm).replace(/\D/g, '') : null;
  if (name !== undefined) data.name = name; // nome nao pode ser null
  if (categoryId !== undefined) data.categoryId = categoryId || null;
  if (costPrice !== undefined) data.costPrice = Number(costPrice) || 0;
  if (salePrice !== undefined) data.salePrice = Number(salePrice) || 0;
  if (minStock !== undefined) data.minStock = parseInt(minStock) || 0;
  if (active !== undefined) data.active = !!active;
  await prisma.mfProduct.update({ where: { id: req.params.id }, data });
  res.json({ ok: true });
});

// Detalhe do produto + grade (variantes)
router.get('/products/:id', mfAuth, async (req, res) => {
  const p = await prisma.mfProduct.findUnique({
    where: { id: req.params.id },
    include: { category: { select: { name: true } }, variants: { where: { active: true }, orderBy: [{ color: 'asc' }, { size: 'asc' }] } },
  });
  if (!p) return res.status(404).json({ error: 'Produto nao encontrado' });
  res.json(p);
});

// =====================================================================
// GRADE / VARIANTES (tamanho x cor). Produto com grade: stock = soma das variantes.
// Produto sem variante segue usando MfProduct.stock (compativel com o que ja existe).
// =====================================================================

// Recalcula o saldo do produto = soma das variantes ativas (so se TEM grade)
async function recomputeProductStock(productId) {
  const vs = await prisma.mfProductVariant.findMany({ where: { productId, active: true }, select: { stock: true } });
  if (!vs.length) return; // sem grade: nao mexe no stock flat
  const total = vs.reduce((s, v) => s + (v.stock || 0), 0);
  await prisma.mfProduct.update({ where: { id: productId }, data: { stock: total } });
}

// Cria variante(s). Aceita {size,color,sku,stock,minStock} OU {variants:[...]}
router.post('/products/:id/variants', mfAuth, async (req, res) => {
  try {
    const prod = await prisma.mfProduct.findUnique({ where: { id: req.params.id } });
    if (!prod) return res.status(404).json({ error: 'Produto nao encontrado' });
    const rows = Array.isArray(req.body && req.body.variants) ? req.body.variants : [req.body || {}];
    let created = 0;
    for (const r of rows) {
      const size = (r.size || '').toString().trim() || null;
      const color = (r.color || '').toString().trim() || null;
      if (!size && !color) continue; // precisa de tamanho OU cor
      const initial = parseInt(r.stock) || 0;
      const v = await prisma.mfProductVariant.create({
        data: { productId: prod.id, size, color, sku: (r.sku || '').toString().trim() || null, stock: initial, minStock: parseInt(r.minStock) || 0 },
      });
      if (initial > 0) {
        await prisma.mfStockMovement.create({ data: { productId: prod.id, variantId: v.id, type: 'entrada', qty: initial, balanceAfter: initial, reason: 'estoque inicial (grade)', employeeId: req.emp.id } });
      }
      created++;
    }
    await recomputeProductStock(prod.id);
    res.json({ ok: true, created });
  } catch (err) {
    console.error('[mf/variants]', err.message);
    res.status(500).json({ error: 'Erro ao criar grade' });
  }
});

// Edita dados da variante (estoque so via movimento)
router.put('/variants/:id', mfAuth, async (req, res) => {
  const { size, color, sku, minStock, active } = req.body || {};
  const data = {};
  if (size !== undefined) data.size = (size || '').toString().trim() || null;
  if (color !== undefined) data.color = (color || '').toString().trim() || null;
  if (sku !== undefined) data.sku = (sku || '').toString().trim() || null;
  if (minStock !== undefined) data.minStock = parseInt(minStock) || 0;
  if (active !== undefined) data.active = !!active;
  const v = await prisma.mfProductVariant.update({ where: { id: req.params.id }, data });
  await recomputeProductStock(v.productId);
  res.json({ ok: true });
});

router.delete('/variants/:id', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  const v = await prisma.mfProductVariant.update({ where: { id: req.params.id }, data: { active: false, stock: 0 } });
  await recomputeProductStock(v.productId);
  res.json({ ok: true });
});

// Baixa/estorno de estoque a partir de um pedido (saida ao entregar; entrada ao estornar)
async function applyOrderStock(order, employeeId, restore) {
  for (const it of order.items) {
    if (!it.productId) continue;
    const qty = parseInt(it.qty) || 0;
    if (qty <= 0) continue;
    const type = restore ? 'entrada' : 'saida';
    const reason = (restore ? 'estorno pedido #' : 'baixa pedido #') + (order.number || '');
    if (it.variantId) {
      const v = await prisma.mfProductVariant.findUnique({ where: { id: it.variantId } });
      if (!v) continue;
      const ns = (v.stock || 0) + (restore ? qty : -qty);
      await prisma.mfStockMovement.create({ data: { productId: it.productId, variantId: it.variantId, type, qty, balanceAfter: ns, reason, employeeId, orderId: order.id } });
      await prisma.mfProductVariant.update({ where: { id: it.variantId }, data: { stock: ns } });
      await recomputeProductStock(it.productId);
    } else {
      const p = await prisma.mfProduct.findUnique({ where: { id: it.productId } });
      if (!p) continue;
      const cnt = await prisma.mfProductVariant.count({ where: { productId: it.productId, active: true } });
      if (cnt > 0) continue; // tem grade mas o item nao escolheu variante: nao mexe (evita baixa errada)
      const ns = (p.stock || 0) + (restore ? qty : -qty);
      await prisma.mfStockMovement.create({ data: { productId: it.productId, type, qty, balanceAfter: ns, reason, employeeId, orderId: order.id } });
      await prisma.mfProduct.update({ where: { id: it.productId }, data: { stock: ns } });
    }
  }
}

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
    const { productId, variantId, type, qty, reason } = req.body || {};
    const n = parseInt(qty);
    if (!productId || !['entrada', 'saida', 'ajuste'].includes(type) || !n || n <= 0) {
      return res.status(400).json({ error: 'Produto, tipo e quantidade (>0) obrigatorios' });
    }
    const prod = await prisma.mfProduct.findUnique({ where: { id: productId } });
    if (!prod) return res.status(404).json({ error: 'Produto nao encontrado' });

    // Movimento numa VARIANTE da grade
    if (variantId) {
      const v = await prisma.mfProductVariant.findUnique({ where: { id: variantId } });
      if (!v || v.productId !== productId) return res.status(400).json({ error: 'Variante invalida' });
      let ns = v.stock;
      if (type === 'entrada') ns += n; else if (type === 'saida') ns -= n; else ns = n;
      if (ns < 0) return res.status(400).json({ error: `Estoque insuficiente (atual: ${v.stock})` });
      await prisma.$transaction([
        prisma.mfStockMovement.create({ data: { productId, variantId, type, qty: n, balanceAfter: ns, reason: reason || null, employeeId: req.emp.id } }),
        prisma.mfProductVariant.update({ where: { id: variantId }, data: { stock: ns } }),
      ]);
      await recomputeProductStock(productId);
      return res.json({ ok: true, variantStock: ns });
    }

    // Produto sem grade — saldo flat. Se TEM grade, exige variante.
    const cnt = await prisma.mfProductVariant.count({ where: { productId, active: true } });
    if (cnt > 0) return res.status(400).json({ error: 'Produto tem grade. Escolha o tamanho/cor.' });
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
  const o = await prisma.mfOrder.findUnique({
    where: { id: req.params.id },
    include: { customer: true, items: true, employee: { select: { name: true } }, payments: { orderBy: { paidAt: 'desc' } } },
  });
  if (!o) return res.status(404).json({ error: 'Pedido nao encontrado' });
  const paidTotal = (o.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
  res.json({ ...o, paidTotal, saldo: Math.max(0, (o.total || 0) - paidTotal) });
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
            variantId: it.variantId || null,
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
  try {
    const { status } = req.body || {};
    if (!['orcamento', 'confirmado', 'producao', 'entregue', 'cancelado'].includes(status)) return res.status(400).json({ error: 'Status invalido' });
    const order = await prisma.mfOrder.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!order) return res.status(404).json({ error: 'Pedido nao encontrado' });
    // baixa de estoque ao ENTREGAR; estorno ao SAIR de entregue
    if (status === 'entregue' && !order.stockApplied) {
      await applyOrderStock(order, req.emp.id, false);
      await prisma.mfOrder.update({ where: { id: order.id }, data: { status, stockApplied: true } });
    } else if (order.stockApplied && status !== 'entregue') {
      await applyOrderStock(order, req.emp.id, true); // estorna o que baixou
      await prisma.mfOrder.update({ where: { id: order.id }, data: { status, stockApplied: false } });
    } else {
      await prisma.mfOrder.update({ where: { id: order.id }, data: { status } });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[mf/orders/status]', err.message);
    res.status(500).json({ error: 'Erro ao mudar status: ' + err.message });
  }
});

// =====================================================================
// PAGAMENTOS do pedido (recebimentos). saldo = total - soma(pagamentos)
// =====================================================================
const PAY_METHODS = ['dinheiro', 'pix', 'credito', 'debito', 'boleto', 'transferencia', 'prazo'];

router.post('/orders/:id/payments', mfAuth, async (req, res) => {
  try {
    const { amount, method, note, paidAt } = req.body || {};
    const val = Number(amount);
    if (!val || val <= 0) return res.status(400).json({ error: 'Valor do pagamento invalido' });
    const order = await prisma.mfOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Pedido nao encontrado' });
    await prisma.mfPayment.create({
      data: { orderId: order.id, amount: val, method: PAY_METHODS.includes(method) ? method : 'dinheiro', note: note || null, employeeId: req.emp.id, paidAt: paidAt ? new Date(paidAt) : new Date() },
    });
    const pays = await prisma.mfPayment.findMany({ where: { orderId: order.id } });
    const paidTotal = pays.reduce((s, p) => s + p.amount, 0);
    res.json({ ok: true, paidTotal, saldo: Math.max(0, (order.total || 0) - paidTotal) });
  } catch (err) {
    console.error('[mf/payments]', err.message);
    res.status(500).json({ error: 'Erro ao registrar pagamento' });
  }
});

router.delete('/payments/:id', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  await prisma.mfPayment.delete({ where: { id: req.params.id } });
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
  const now = new Date();
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const SOLD = ['confirmado', 'producao', 'entregue'];
  const [products, lowStock, customers, leadsNovos, orcamentos, pedidosAbertos, ordersMes, paysMes, finPagasMes, abertos, aPagarRows] = await Promise.all([
    prisma.mfProduct.count({ where: { active: true } }),
    prisma.mfProduct.count({ where: { active: true, stock: { lte: 0 } } }),
    prisma.mfCustomer.count({ where: { active: true } }),
    prisma.mfLead.count({ where: { status: 'novo' } }),
    prisma.mfOrder.count({ where: { status: 'orcamento' } }),
    prisma.mfOrder.count({ where: { status: { in: ['confirmado', 'producao'] } } }),
    prisma.mfOrder.findMany({ where: { status: { in: SOLD }, createdAt: { gte: mStart } }, select: { total: true } }),
    prisma.mfPayment.findMany({ where: { paidAt: { gte: mStart } }, select: { amount: true } }),
    prisma.mfFinanceEntry.findMany({ where: { status: 'pago', paidAt: { gte: mStart } }, select: { kind: true, amount: true } }),
    prisma.mfOrder.findMany({ where: { status: { in: SOLD } }, select: { total: true, payments: { select: { amount: true } } } }),
    prisma.mfFinanceEntry.findMany({ where: { kind: 'pagar', status: 'aberto' }, select: { amount: true } }),
  ]);
  const vendasMes = ordersMes.reduce((s, o) => s + (o.total || 0), 0);
  const entradas = paysMes.reduce((s, p) => s + p.amount, 0) + finPagasMes.filter((e) => e.kind === 'receber').reduce((s, e) => s + e.amount, 0);
  const saidas = finPagasMes.filter((e) => e.kind === 'pagar').reduce((s, e) => s + e.amount, 0);
  const aReceber = abertos.reduce((s, o) => s + Math.max(0, (o.total || 0) - o.payments.reduce((a, p) => a + p.amount, 0)), 0);
  const aPagar = aPagarRows.reduce((s, e) => s + e.amount, 0);
  res.json({ products, lowStock, customers, leadsNovos, orcamentos, pedidosAbertos, vendasMes, caixaMes: entradas - saidas, aReceber, aPagar });
});

// =====================================================================
// FINANCEIRO — contas a pagar/receber AVULSAS (aluguel, fornecedor, salario, imposto...).
// As vendas a receber vem dos PEDIDOS (total - pagamentos). Caixa = junta os dois.
// =====================================================================
router.get('/finance', mfAuth, async (req, res) => {
  const where = {};
  if (req.query.kind) where.kind = String(req.query.kind);
  if (req.query.status) where.status = String(req.query.status);
  const list = await prisma.mfFinanceEntry.findMany({ where, orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }], take: 400 });
  res.json(list);
});

router.post('/finance', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  const { kind, description, category, amount, dueDate, status, method } = req.body || {};
  if (!['receber', 'pagar'].includes(kind)) return res.status(400).json({ error: 'Tipo invalido (receber/pagar)' });
  if (!description) return res.status(400).json({ error: 'Descricao obrigatoria' });
  const st = ['aberto', 'pago', 'cancelado'].includes(status) ? status : 'aberto';
  const e = await prisma.mfFinanceEntry.create({
    data: {
      kind, description, category: category || null, amount: Number(amount) || 0,
      dueDate: dueDate ? new Date(dueDate) : null, status,
      paidAt: st === 'pago' ? new Date() : null, method: method || null, employeeId: req.emp.id,
    },
  });
  res.json({ id: e.id });
});

router.put('/finance/:id', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  const { description, category, amount, dueDate, status, method } = req.body || {};
  const data = {};
  if (description !== undefined) data.description = description;
  if (category !== undefined) data.category = category || null;
  if (amount !== undefined) data.amount = Number(amount) || 0;
  if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
  if (method !== undefined) data.method = method || null;
  if (status && ['aberto', 'pago', 'cancelado'].includes(status)) {
    data.status = status;
    data.paidAt = status === 'pago' ? new Date() : null;
  }
  await prisma.mfFinanceEntry.update({ where: { id: req.params.id }, data });
  res.json({ ok: true });
});

router.delete('/finance/:id', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  await prisma.mfFinanceEntry.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// =====================================================================
// RELATORIOS — faturamento, ticket, caixa, em aberto, top produtos/clientes.
// =====================================================================
function periodRange(q) {
  const to = q.to ? new Date(q.to + 'T23:59:59.999') : new Date();
  const from = q.from ? new Date(q.from + 'T00:00:00') : new Date(to.getFullYear(), to.getMonth(), 1);
  return { from, to };
}
const SOLD_STATUS = ['confirmado', 'producao', 'entregue'];

router.get('/reports/summary', mfAuth, async (req, res) => {
  const { from, to } = periodRange(req.query || {});
  const orders = await prisma.mfOrder.findMany({ where: { status: { in: SOLD_STATUS }, createdAt: { gte: from, lte: to } }, select: { total: true } });
  const faturamento = orders.reduce((s, o) => s + (o.total || 0), 0);
  const nPedidos = orders.length;
  const ticket = nPedidos ? faturamento / nPedidos : 0;
  const pays = await prisma.mfPayment.findMany({ where: { paidAt: { gte: from, lte: to } }, select: { amount: true } });
  const finPagas = await prisma.mfFinanceEntry.findMany({ where: { status: 'pago', paidAt: { gte: from, lte: to } }, select: { kind: true, amount: true } });
  const entradas = pays.reduce((s, p) => s + p.amount, 0) + finPagas.filter((e) => e.kind === 'receber').reduce((s, e) => s + e.amount, 0);
  const saidas = finPagas.filter((e) => e.kind === 'pagar').reduce((s, e) => s + e.amount, 0);
  const abertos = await prisma.mfOrder.findMany({ where: { status: { in: SOLD_STATUS } }, select: { total: true, payments: { select: { amount: true } } } });
  const aReceber = abertos.reduce((s, o) => s + Math.max(0, (o.total || 0) - o.payments.reduce((a, p) => a + p.amount, 0)), 0);
  const aPagarRows = await prisma.mfFinanceEntry.findMany({ where: { kind: 'pagar', status: 'aberto' }, select: { amount: true } });
  const aPagar = aPagarRows.reduce((s, e) => s + e.amount, 0);
  res.json({ from, to, faturamento, nPedidos, ticket, caixa: { entradas, saidas, saldo: entradas - saidas }, aReceber, aPagar });
});

router.get('/reports/top-products', mfAuth, async (req, res) => {
  const { from, to } = periodRange(req.query || {});
  const items = await prisma.mfOrderItem.findMany({
    where: { order: { status: { in: SOLD_STATUS }, createdAt: { gte: from, lte: to } } },
    select: { description: true, productId: true, qty: true, total: true },
  });
  const map = {};
  for (const it of items) {
    const k = it.productId || ('d:' + it.description);
    if (!map[k]) map[k] = { name: it.description, qty: 0, total: 0 };
    map[k].qty += it.qty || 0; map[k].total += it.total || 0;
  }
  res.json(Object.values(map).sort((a, b) => b.total - a.total).slice(0, 20));
});

router.get('/reports/top-customers', mfAuth, async (req, res) => {
  const { from, to } = periodRange(req.query || {});
  const orders = await prisma.mfOrder.findMany({
    where: { status: { in: SOLD_STATUS }, createdAt: { gte: from, lte: to }, customerId: { not: null } },
    include: { customer: { select: { name: true } } },
  });
  const map = {};
  for (const o of orders) {
    const k = o.customerId;
    if (!map[k]) map[k] = { name: (o.customer && o.customer.name) || '?', orders: 0, total: 0 };
    map[k].orders++; map[k].total += o.total || 0;
  }
  res.json(Object.values(map).sort((a, b) => b.total - a.total).slice(0, 20));
});

// =====================================================================
// FISCAL — NF-e modelo 55 pelo CNPJ da Meta Fardamentos.
// Motor: src/services/fiscalSefazDirect.mjs (ESM → import dinâmico).
// Certificado A1 (.pfx) guardado no banco (MfFiscalConfig.certB64 + senha) — o banco e o cofre.
// =====================================================================
const _fs = require('fs');
const _os = require('os');
const _path = require('path');
const { execSync } = require('child_process');

async function getFiscalConfig() {
  let c = await prisma.mfFiscalConfig.findFirst();
  if (!c) c = await prisma.mfFiscalConfig.create({ data: {} });
  return c;
}

function writeCertTemp(config) {
  if (!config.certB64 || !config.certPassword) return null;
  const dir = _path.join(_os.tmpdir(), 'mf-cert');
  _fs.mkdirSync(dir, { recursive: true });
  const p = _path.join(dir, 'metafardamentos.pfx');
  _fs.writeFileSync(p, Buffer.from(config.certB64, 'base64'));
  return { pfxPath: p, pfxSenha: config.certPassword };
}

router.get('/fiscal/config', mfAuth, async (_req, res) => {
  const c = await getFiscalConfig();
  res.json({
    ambiente: c.ambiente, crt: c.crt, csosn: c.csosn,
    cfopDentro: c.cfopDentro, cfopFora: c.cfopFora, defaultNcm: c.defaultNcm,
    nfeSerie: c.nfeSerie, nfeNextNumber: c.nfeNextNumber, enabled: c.enabled,
    certConfigured: !!(c.certB64 && c.certPassword),
    certSubject: c.certSubject, certValidUntil: c.certValidUntil,
  });
});

router.put('/fiscal/config', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  const c = await getFiscalConfig();
  const { ambiente, csosn, defaultNcm, nfeSerie, nfeNextNumber, enabled } = req.body || {};
  const data = {};
  if (ambiente && ['homologacao', 'producao'].includes(ambiente)) data.ambiente = ambiente;
  if (csosn) data.csosn = String(csosn);
  if (defaultNcm) data.defaultNcm = String(defaultNcm).replace(/\D/g, '');
  if (nfeSerie !== undefined) data.nfeSerie = parseInt(nfeSerie) || 1;
  if (nfeNextNumber !== undefined) data.nfeNextNumber = parseInt(nfeNextNumber) || 1;
  if (enabled !== undefined) data.enabled = !!enabled;
  await prisma.mfFiscalConfig.update({ where: { id: c.id }, data });
  res.json({ ok: true });
});

// Upload do certificado A1 (.pfx em base64 + senha). Valida (best-effort) e guarda.
router.post('/fiscal/cert', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  try {
    let { certB64, password } = req.body || {};
    if (!certB64 || !password) return res.status(400).json({ error: 'Certificado e senha obrigatorios' });
    certB64 = String(certB64).replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(certB64, 'base64');
    if (buf.length < 500) return res.status(400).json({ error: 'Arquivo de certificado invalido' });

    // Valida abrindo o pfx (best-effort: confirma a senha + extrai subject/validade)
    let subject = null, validUntil = null, validated = false;
    try {
      const dir = _path.join(_os.tmpdir(), 'mf-cert');
      _fs.mkdirSync(dir, { recursive: true });
      const up = _path.join(dir, 'upload.pfx');
      const cpem = _path.join(dir, 'upload.cert.pem');
      _fs.writeFileSync(up, buf);
      execSync(`openssl pkcs12 -in "${up}" -clcerts -nokeys -passin pass:${password} -legacy -out "${cpem}"`, { stdio: 'ignore' });
      const info = execSync(`openssl x509 -in "${cpem}" -noout -subject -enddate`, { encoding: 'utf8' });
      const sm = info.match(/CN\s*=\s*([^,\n/]+)/i); if (sm) subject = sm[1].trim();
      const dm = info.match(/notAfter=(.+)/); if (dm) { const d = new Date(dm[1].trim()); if (!isNaN(d)) validUntil = d; }
      validated = true;
      try { _fs.unlinkSync(up); _fs.unlinkSync(cpem); } catch {}
    } catch (e) {
      // openssl pode falhar por senha errada OU por ambiente — diferencia pela mensagem
      if (/mac verify|invalid password|password/i.test(String(e.message))) {
        return res.status(400).json({ error: 'Senha do certificado incorreta' });
      }
      // openssl indisponivel/erro de ambiente: guarda mesmo assim (a emissao valida de verdade)
    }
    const c = await getFiscalConfig();
    await prisma.mfFiscalConfig.update({ where: { id: c.id }, data: { certB64, certPassword: String(password), certSubject: subject, certValidUntil: validUntil } });
    res.json({ ok: true, validated, subject, validUntil });
  } catch (err) {
    console.error('[mf/fiscal/cert]', err.message);
    res.status(500).json({ error: 'Erro ao salvar certificado' });
  }
});

// Emite NF-e 55 pra um pedido.
router.post('/fiscal/emit/:orderId', mfAuth, async (req, res) => {
  try {
    const config = await getFiscalConfig();
    if (!config.enabled) return res.status(400).json({ error: 'Emissao fiscal desligada. Ligue em Config Fiscal.' });
    const cert = writeCertTemp(config);
    if (!cert) return res.status(400).json({ error: 'Certificado nao configurado.' });

    const order = await prisma.mfOrder.findUnique({
      where: { id: req.params.orderId },
      include: { items: { include: { product: true } }, customer: true },
    });
    if (!order) return res.status(404).json({ error: 'Pedido nao encontrado' });
    if (order.nfeStatus === 'emitida') return res.status(400).json({ error: 'Pedido ja tem NF-e (chave ' + order.nfeChave + ')' });
    if (!order.items.length) return res.status(400).json({ error: 'Pedido sem itens' });
    const cust = order.customer;
    if (!cust || !cust.doc) return res.status(400).json({ error: 'NF-e exige cliente com CPF/CNPJ. Edite o cliente e informe o documento.' });

    const company = await getCompany();
    const clean = (s) => String(s || '').replace(/\D/g, '');
    const issuer = {
      cnpj: clean(company.cnpj), companyName: company.name, fantasyName: company.tradeName,
      ie: clean(company.ie), environment: config.ambiente === 'producao' ? 'production' : 'homologation',
      crt: config.crt, csosn: config.csosn,
      street: company.street, number: company.number, neighborhood: company.neighborhood,
      city: company.city, state: company.state, zip: clean(company.zip), cityCode: company.cityCode,
      phone: clean(company.phone), nfeSerie: config.nfeSerie, nfeNextNumber: config.nfeNextNumber,
    };
    const items = order.items.map((it) => ({
      name: it.description, sku: it.product?.ref || it.productId || undefined,
      ncm: clean(it.product?.ncm) || config.defaultNcm, cfop: config.cfopDentro,
      unidade: it.product?.unit || 'UN', qty: it.qty, unitPrice: it.unitPrice,
    }));
    const customer = {
      cpfCnpj: clean(cust.doc), name: cust.name, indIEDest: '9',
      addr: {
        xLgr: cust.address || 'NAO INFORMADO', nro: 'S/N', xBairro: 'CENTRO',
        cMun: cust.cityCode || '2507507', xMun: cust.city || 'JOAO PESSOA',
        UF: cust.state || 'PB', CEP: clean(cust.cep) || '58013430',
      },
    };
    const payment = { tPag: '01', valor: order.total, modFrete: 9 };

    const { emitNFe55 } = await import('../services/fiscalSefazDirect.mjs');
    const r = await emitNFe55({ issuer, pfxPath: cert.pfxPath, pfxSenha: cert.pfxSenha, items, payment, customer, nNF: config.nfeNextNumber });

    if (r.ok) {
      const protocol = r.protocol || (String(r.rawResponse || '').match(/<nProt>(\d+)<\/nProt>/) || [])[1] || null;
      await prisma.$transaction([
        prisma.mfOrder.update({ where: { id: order.id }, data: { nfeStatus: 'emitida', nfeModelo: 55, nfeChave: r.accessKey, nfeNumero: config.nfeNextNumber, nfeProtocolo: protocol, nfeMotivo: r.motivo, nfeXml: r.xmlSigned, nfeAt: new Date() } }),
        prisma.mfFiscalConfig.update({ where: { id: config.id }, data: { nfeNextNumber: config.nfeNextNumber + 1 } }),
      ]);
      return res.json({ ok: true, chave: r.accessKey, protocolo: protocol, status: r.status, ambiente: config.ambiente });
    }
    await prisma.mfOrder.update({ where: { id: order.id }, data: { nfeStatus: 'erro', nfeMotivo: (r.status || '') + ' ' + (r.motivo || '') } });
    return res.status(400).json({ error: 'SEFAZ recusou: ' + (r.status || '') + ' — ' + (r.motivo || '') });
  } catch (err) {
    console.error('[mf/fiscal/emit]', err.message);
    res.status(500).json({ error: 'Erro ao emitir: ' + err.message });
  }
});

// DANFE (PDF) da NF-e autorizada do pedido.
router.get('/fiscal/danfe/:orderId', mfAuth, async (req, res) => {
  try {
    const order = await prisma.mfOrder.findUnique({ where: { id: req.params.orderId } });
    if (!order || !order.nfeXml || order.nfeStatus !== 'emitida') return res.status(400).json({ error: 'Pedido sem NF-e autorizada' });
    let xml = order.nfeXml;
    if (!xml.includes('<protNFe') && !xml.includes('<nfeProc') && order.nfeProtocolo && order.nfeChave) {
      const nfe = xml.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/i, '');
      const dig = (nfe.match(/<DigestValue>([^<]*)<\/DigestValue>/) || [])[1] || '';
      const dt = order.nfeAt ? new Date(order.nfeAt) : new Date();
      const dh = new Date(dt.getTime() - 3 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '-03:00');
      const cfg = await getFiscalConfig();
      const tpAmb = cfg.ambiente === 'producao' ? '1' : '2';
      const protNFe = '<protNFe versao="4.00"><infProt><tpAmb>' + tpAmb + '</tpAmb><verAplic>SVRS</verAplic><chNFe>' + order.nfeChave + '</chNFe><dhRecbto>' + dh + '</dhRecbto><nProt>' + order.nfeProtocolo + '</nProt><digVal>' + dig + '</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>';
      xml = '<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' + nfe + protNFe + '</nfeProc>';
    }
    const sped = await import('node-sped-pdf');
    const DANFe = sped.DANFe || (sped.default && sped.default.DANFe);
    const pdf = await DANFe({ xml });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="danfe-mf-' + (order.number || order.id) + '.pdf"' });
    res.send(Buffer.from(pdf));
  } catch (err) {
    console.error('[mf/fiscal/danfe]', err.message);
    res.status(500).json({ error: 'Erro ao gerar DANFE: ' + err.message });
  }
});

// Cancela a NF-e do pedido (admin/gerente).
router.post('/fiscal/cancel/:orderId', mfAuth, requireRole('admin', 'gerente'), async (req, res) => {
  try {
    const reason = (req.body && req.body.reason) || '';
    if (reason.length < 15) return res.status(400).json({ error: 'Motivo precisa ter ao menos 15 caracteres' });
    const order = await prisma.mfOrder.findUnique({ where: { id: req.params.orderId } });
    if (!order || order.nfeStatus !== 'emitida' || !order.nfeChave) return res.status(400).json({ error: 'Pedido sem NF-e pra cancelar' });
    const config = await getFiscalConfig();
    const cert = writeCertTemp(config);
    if (!cert) return res.status(400).json({ error: 'Certificado nao configurado' });
    const company = await getCompany();
    const issuer = { cnpj: String(company.cnpj || '').replace(/\D/g, ''), environment: config.ambiente === 'producao' ? 'production' : 'homologation' };
    const { cancelDocument } = await import('../services/fiscalSefazDirect.mjs');
    const r = await cancelDocument({ issuer, pfxPath: cert.pfxPath, pfxSenha: cert.pfxSenha, accessKey: order.nfeChave, protocol: order.nfeProtocolo, reason });
    if (r.ok) {
      await prisma.mfOrder.update({ where: { id: order.id }, data: { nfeStatus: 'cancelada', nfeMotivo: 'Cancelada: ' + reason } });
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'SEFAZ: ' + (r.status || '') + ' — ' + (r.motivo || '') });
  } catch (err) {
    console.error('[mf/fiscal/cancel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
