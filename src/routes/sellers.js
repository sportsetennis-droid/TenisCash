const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();

function allowedSearchRoles(req, res, next) {
  if (!['seller', 'admin', 'superadmin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
}

router.get('/search', authMiddleware, allowedSearchRoles, async (req, res) => {
  try {
    const raw = String(req.query.q || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (raw.length < 2 && digits.length < 2) {
      return res.json({ sellers: [] });
    }

    const or = [];
    if (raw.length >= 2) {
      or.push({ name: { contains: raw, mode: 'insensitive' } });
      or.push({ email: { contains: raw, mode: 'insensitive' } });
      or.push({ phone: { contains: raw } });
    }
    if (digits.length >= 2) {
      or.push({ phone: { contains: digits } });
    }

    const users = await prisma.user.findMany({
      where: {
        id: { not: req.userId },
        active: true,
        role: { in: ['seller', 'admin', 'superadmin'] },
        OR: or,
      },
      take: 10,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        phone: true,
        store: { select: { name: true, code: true } },
      },
    });

    const sellers = users.map((u) => ({
      id: u.id,
      name: u.name,
      phone: u.phone,
      store: u.store ? { name: u.store.name, code: u.store.code } : null,
    }));

    res.json({ sellers });
  } catch (err) {
    console.error('Erro sellers/search:', err);
    res.status(500).json({ error: 'Erro ao buscar' });
  }
});

module.exports = router;
