// =====================================================================
// Resgate de TenisCash na loja Nuvemshop (cashback -> desconto)
// =====================================================================
// O checkout da Nuvemshop é fechado: não dá pra abater saldo de loyalty
// externo direto no botão de pagar. Solução suportada pela NS: gerar um
// CUPOM PESSOAL (percentual, com teto em R$ = saldo do cliente) e o
// cliente aplica no campo "cupom" do checkout. Quando o pedido é pago,
// o webhook debita o saldo pelo valor realmente descontado.
//
// Regras (definidas pelo dono):
//  - Teto padrão = 10% do carrinho (config `teniscash_redeem_max_pct`).
//  - 1 cupom por compra: ou Creation, ou TenisCash (não acumula).
//  - Toda compra ainda gera cashback (tratado no webhook de pedido).
// =====================================================================

const express = require('express');
const crypto = require('crypto');
const { prisma, authMiddleware } = require('../middleware');
const ns = require('../services/nuvemshop');

const router = express.Router();

const DEFAULT_REDEEM_PCT = 10;
const STORE_URL = process.env.NUVEMSHOP_STORE_URL || 'https://www.sportsetennis.com.br';

async function getNsConnection() {
  try { return await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } }); }
  catch { return null; }
}

async function getRedeemPct() {
  try {
    const row = await prisma.config.findUnique({ where: { key: 'teniscash_redeem_max_pct' } });
    const v = row ? parseFloat(row.value) : NaN;
    if (Number.isFinite(v) && v > 0 && v <= 100) return v;
  } catch { /* usa default */ }
  return DEFAULT_REDEEM_PCT;
}

// Gera um código pessoal único (ex: TC7H3K9Q) que não colida com cupom
// de Creation (Partner.couponCode) nem com outro resgate.
async function generateUniqueCode() {
  for (let i = 0; i < 8; i++) {
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
    const code = ('TC' + rand).slice(0, 12);
    const [dupR, dupP] = await Promise.all([
      prisma.cashbackRedemption.findUnique({ where: { couponCode: code } }),
      prisma.partner.findUnique({ where: { couponCode: code } }),
    ]);
    if (!dupR && !dupP) return code;
  }
  throw new Error('Não consegui gerar um código único de cupom');
}

// Desativa/apaga o cupom de um resgate na NS (best-effort).
async function killNsCoupon(redemption) {
  if (!redemption?.nsCouponId) return;
  const conn = await getNsConnection();
  if (!conn) return;
  try { await ns.deleteCoupon(conn, redemption.nsCouponId); }
  catch (err) {
    try { await ns.setCouponValid(conn, redemption.nsCouponId, false); } catch { /* desiste */ }
    console.warn('[redeem] falha apagar cupom NS:', redemption.couponCode, err.message);
  }
}

// Devolve o saldo RESERVADO (hold) de um resgate pendente e marca como cancelado.
// Usado quando o cliente cancela o cupom, ou quando geramos um novo (o antigo
// some e o saldo volta). Idempotente por status (só mexe em 'pending').
async function releaseRedemptionHold(redemption) {
  const amt = Number(redemption.maxAmount) || 0;
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.cashbackRedemption.findUnique({ where: { id: redemption.id }, select: { status: true } });
    if (!fresh || fresh.status !== 'pending') return; // já tratado
    if (amt > 0) {
      const u = await tx.user.update({
        where: { id: redemption.userId },
        data: { balance: { increment: amt } },
      });
      await tx.transaction.create({
        data: {
          type: 'cashback_redeem_hold_release',
          amount: amt,
          description: `Devolução de TenisCash reservado (cupom ${redemption.couponCode} não usado)`,
          receiverId: redemption.userId,
          balanceAfter: u.balance,
          metadata: JSON.stringify({ redemptionId: redemption.id, couponCode: redemption.couponCode, wallet: 'balance', hold: 'release' }),
        },
      });
    }
    await tx.cashbackRedemption.update({ where: { id: redemption.id }, data: { status: 'cancelled' } });
  });
}

// ---------------------------------------------------------------------
// GET — resgate pendente atual do cliente (se houver)
// ---------------------------------------------------------------------
router.get('/teniscash/store-coupon', authMiddleware, async (req, res) => {
  try {
    const [user, pending, pct] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.userId }, select: { balance: true } }),
      prisma.cashbackRedemption.findFirst({ where: { userId: req.userId, status: 'pending' }, orderBy: { createdAt: 'desc' } }),
      getRedeemPct(),
    ]);
    res.json({
      balance: user?.balance || 0,
      maxPct: pct,
      storeUrl: STORE_URL,
      pending: pending ? {
        couponCode: pending.couponCode,
        pct: pending.pct,
        maxAmount: pending.maxAmount,
        createdAt: pending.createdAt,
      } : null,
    });
  } catch (err) {
    console.error('GET /teniscash/store-coupon', err);
    res.status(500).json({ error: 'Erro ao carregar resgate' });
  }
});

// ---------------------------------------------------------------------
// POST — gera (ou regenera) o cupom pessoal de TenisCash
// ---------------------------------------------------------------------
router.post('/teniscash/store-coupon', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, balance: true } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const conn = await getNsConnection();
    if (!conn) return res.status(503).json({ error: 'Loja Nuvemshop indisponível no momento. Tente mais tarde.' });

    // Cancela resgate pendente anterior e DEVOLVE o saldo que estava reservado nele
    // (o cliente pode estar pedindo um valor diferente; o saldo do cupom antigo volta).
    const olds = await prisma.cashbackRedemption.findMany({ where: { userId: user.id, status: 'pending' } });
    for (const old of olds) {
      await killNsCoupon(old);
      await releaseRedemptionHold(old);
    }

    // Saldo REAL disponível depois de devolver holds anteriores.
    const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { balance: true } });
    const available = Number(fresh?.balance) || 0;
    if (available <= 0) {
      return res.status(400).json({ error: 'Você não tem saldo TenisCash pra usar.' });
    }

    const pct = await getRedeemPct();
    // Valor que o cliente QUER usar (opcional). Default = saldo todo.
    // Nunca passa do saldo. O checkout ainda limita ao pct do carrinho.
    let requested = parseFloat(req.body && req.body.amount);
    if (!Number.isFinite(requested) || requested <= 0) requested = available;
    const maxAmount = Number(Math.min(requested, available).toFixed(2)); // teto em R$ (= valor reservado)

    const couponCode = await generateUniqueCode();

    // Cria o cupom na NS
    let nsCouponId = null;
    try {
      const created = await ns.createRedemptionCoupon(conn, { code: couponCode, pct, maxAmount });
      nsCouponId = created && created.id != null ? String(created.id) : null;
    } catch (err) {
      console.error('[redeem] falha criar cupom NS:', err.message);
      return res.status(502).json({ error: 'Não consegui criar o cupom na loja. Tente novamente.' });
    }

    // RESERVA o saldo na hora: balance -= maxAmount + transação de hold + cria o resgate.
    // Se a loja não usar o cupom, o saldo volta (DELETE / regenerar / pedido não pago).
    let redemption;
    let newBalance = available;
    try {
      redemption = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: user.id },
          data: { balance: { decrement: maxAmount } },
        });
        newBalance = u.balance;
        const r = await tx.cashbackRedemption.create({
          data: { userId: user.id, couponCode, nsCouponId, pct, maxAmount, status: 'pending' },
        });
        await tx.transaction.create({
          data: {
            type: 'cashback_redeem_hold',
            amount: maxAmount,
            description: `TenisCash reservado para o cupom ${couponCode}`,
            senderId: user.id,
            balanceAfter: u.balance,
            metadata: JSON.stringify({ redemptionId: r.id, couponCode, wallet: 'balance', hold: 'reserve' }),
          },
        });
        return r;
      });
    } catch (err) {
      console.error('[redeem] falha reservar saldo:', err.message);
      // desfaz o cupom órfão na NS
      try { if (nsCouponId) await ns.deleteCoupon(conn, nsCouponId); } catch { /* best-effort */ }
      return res.status(500).json({ error: 'Erro ao reservar saldo de TenisCash' });
    }

    res.json({
      ok: true,
      couponCode: redemption.couponCode,
      pct: redemption.pct,
      maxAmount: redemption.maxAmount,
      balance: newBalance, // saldo JÁ com o valor reservado descontado
      storeUrl: STORE_URL,
      // Atalho: link da loja com o cupom já pré-aplicado no carrinho
      storeUrlWithCoupon: `${STORE_URL}/?coupon=${encodeURIComponent(redemption.couponCode)}`,
    });
  } catch (err) {
    console.error('POST /teniscash/store-coupon', err);
    res.status(500).json({ error: 'Erro ao gerar cupom de TenisCash' });
  }
});

// ---------------------------------------------------------------------
// DELETE — cancela o resgate pendente
// ---------------------------------------------------------------------
router.delete('/teniscash/store-coupon', authMiddleware, async (req, res) => {
  try {
    const olds = await prisma.cashbackRedemption.findMany({ where: { userId: req.userId, status: 'pending' } });
    for (const old of olds) {
      await killNsCoupon(old);
      await releaseRedemptionHold(old); // devolve o saldo reservado
    }
    const fresh = await prisma.user.findUnique({ where: { id: req.userId }, select: { balance: true } });
    res.json({ ok: true, cancelled: olds.length, balance: Number(fresh?.balance) || 0 });
  } catch (err) {
    console.error('DELETE /teniscash/store-coupon', err);
    res.status(500).json({ error: 'Erro ao cancelar cupom' });
  }
});

module.exports = router;
