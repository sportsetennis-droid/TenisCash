// =====================================================================
// PAGAMENTO UNIFICADO — infoprodutos
// ---------------------------------------------------------------------
// Decide o trilho de recebimento:
//   • on_platform  → Asaas: S&T recebe e faz SPLIT (produtor + afiliado),
//                    retém take rate; comprador pode ganhar cashback.
//   • off_platform → Pix do próprio produtor (services/pix.js). Funciona
//                    HOJE sem PSP; comissão de afiliado fica "pending"
//                    (saque manual via Payout). Cashback/take rate = 0.
//
// O trilho é on_platform SOMENTE se o PSP estiver ligado (ASAAS_API_KEY)
// E o produtor tiver walletId (recebedor KYC). Senão cai em off_platform.
// =====================================================================

const pix = require('./pix');
const asaas = require('./psp/asaas');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Rateio do valor pago entre plataforma, afiliado, produtor e cashback.
// Regras: take rate sai do bruto; comissão do afiliado é % sobre o bruto;
// cashback do comprador sai da fatia da plataforma (não onera o produtor).
function computeSplit({ amount, platformFeePct = 0, affiliateCommissionPct = 0, cashbackPct = 0, hasAffiliate = false }) {
  const gross = round2(amount);
  const platformFee = round2(gross * (platformFeePct / 100));
  const affiliateAmount = hasAffiliate ? round2(gross * (affiliateCommissionPct / 100)) : 0;
  const cashbackAmount = round2(gross * (cashbackPct / 100));
  // produtor leva o que sobra depois de taxa e comissão
  const producerAmount = round2(gross - platformFee - affiliateAmount);
  return { gross, platformFee, affiliateAmount, cashbackAmount, producerAmount };
}

function decideMode(professional) {
  const on = asaas.isEnabled() && !!(professional && professional.asaasWalletId);
  return on ? 'on_platform' : 'off_platform';
}

function dueDateStr(daysAhead = 3) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Gera a cobrança de uma venda de infoproduto.
 * @returns {Promise<object>} campos pra gravar na DigitalSale
 */
async function createSaleCharge({ product, professional, sale, affiliate, buyer, method = 'pix', installments = 1 }) {
  const mode = decideMode(professional);
  const split = computeSplit({
    amount: sale.amount,
    platformFeePct: mode === 'on_platform' ? product.platformFeePct : 0,
    affiliateCommissionPct: affiliate ? (affiliate.commissionPct || product.affiliateCommissionPct) : 0,
    cashbackPct: mode === 'on_platform' ? product.cashbackPct : 0,
    hasAffiliate: !!affiliate,
  });

  const out = {
    settlementMode: mode,
    method,
    installments: Math.max(1, Number(installments) || 1),
    producerAmount: split.producerAmount,
    affiliateAmount: split.affiliateAmount,
    platformFee: split.platformFee,
    cashbackAmount: split.cashbackAmount,
    status: 'waiting_payment',
    pixPayload: null,
    pixQrUrl: null,
    pspProvider: null,
    pspChargeId: null,
    pspInvoiceUrl: null,
    dueDate: new Date(Date.now() + 3 * 86400000),
  };

  if (mode === 'on_platform') {
    // ---- Trilho Asaas (split ao vivo) ----
    const billingMap = { pix: 'PIX', card: 'CREDIT_CARD', boleto: 'BOLETO' };
    const customer = await asaas.ensureCustomer({
      name: buyer.name,
      email: buyer.email,
      phone: buyer.phone,
      externalReference: buyer.email || buyer.phone || sale.id,
    });
    const splitArr = [{ walletId: professional.asaasWalletId, fixedValue: split.producerAmount }];
    if (affiliate && affiliate.asaasWalletId && split.affiliateAmount > 0) {
      splitArr.push({ walletId: affiliate.asaasWalletId, fixedValue: split.affiliateAmount });
    }
    const payment = await asaas.createPayment({
      customerId: customer.id,
      billingType: billingMap[method] || 'PIX',
      value: split.gross,
      dueDate: dueDateStr(3),
      description: product.title,
      externalReference: sale.id,
      installmentCount: method === 'card' ? installments : undefined,
      split: splitArr,
    });
    out.pspProvider = 'asaas';
    out.pspChargeId = payment.id;
    out.pspInvoiceUrl = payment.invoiceUrl || null;
    if ((billingMap[method] || 'PIX') === 'PIX') {
      try {
        const qr = await asaas.getPixQr(payment.id);
        out.pixPayload = qr.payload || null;
        out.pixQrUrl = qr.encodedImage ? 'data:image/png;base64,' + qr.encodedImage : null;
      } catch (_) {}
    }
    return out;
  }

  // ---- Trilho off-platform (Pix do produtor) ----
  // TODO(asaas): quando ASAAS_API_KEY + walletId do produtor existirem,
  // este ramo deixa de ser usado e o split entra automático acima.
  if (professional && professional.pixKey) {
    out.pixPayload = pix.buildPixPayload({
      pixKey: professional.pixKey,
      merchantName: professional.displayName,
      merchantCity: professional.city || 'BRASIL',
      amount: split.gross,
      txid: sale.publicToken,
    });
    out.pixQrUrl = await pix.buildPixQrDataUrl(out.pixPayload);
  }
  return out;
}

module.exports = { computeSplit, decideMode, createSaleCharge, round2 };
