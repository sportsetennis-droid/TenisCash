// =====================================================================
// RNA — ações de ESTOQUE/NF-e executadas SÓ depois do "sim" do dono.
// Cada ação REVALIDA as regras duras no momento de gravar (nunca confia
// no neurônio): transferência não é compra nem cria card; "SEM GTIN" não é
// código nem entra em soma; nunca cria card; nunca mexe no estoque físico
// (StoreStock) nem recalcula comprado de StoreStock; Adidas só pela caixa;
// tamanho só literal e plausível, senão placeholder T-<EAN>.
// =====================================================================
const c = require('../neuronios/_comum-estoque');

function erro(msg) { return Object.assign(new Error(msg), { status: 409 }); }

async function itensDeEntrada(tx, itemIds) {
  const itens = await tx.xmlFiscalItem.findMany({ where: { id: { in: itemIds } }, include: { fiscalDocument: { select: { docType: true, accessKey: true, issuerCnpj: true, recipientCnpj: true } } } });
  if (itens.length !== itemIds.length) throw erro('item da NF-e não encontrado');
  for (const it of itens) {
    const doc = it.fiscalDocument;
    if (c.cfopTransf(it.cfop)) throw erro(`item ${it.id} tem CFOP de transferência ${it.cfop}`);
    if (!c.docEhEntrada(doc, [it])) throw erro(`NF-e ${doc.accessKey} não é de entrada (gravada: ${doc.docType || '-'}, regra: ${c.classificarNfe(doc, [it]).docType}) — transferência não liga card`);
  }
  return itens;
}

module.exports = (registrar) => {
  registrar('estoque.ligar-item-nfe', {
    descricao: 'Liga itens de NF-e de ENTRADA a um card que JÁ existe (só XmlFiscalItem.productId). Não cria card, tamanho nem estoque.',
    async executar(args, { db }) {
      const itemIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : [];
      if (!itemIds.length || !args.productId) throw erro('faltam itemIds/productId');
      return db.$transaction(async (tx) => {
        const p = await tx.product.findUnique({ where: { id: String(args.productId) }, select: { id: true, sku: true, active: true } });
        if (!p) throw erro('card não existe (a rede nunca cria card)');
        const itens = await itensDeEntrada(tx, itemIds);
        const outro = itens.find((i) => i.productId && i.productId !== p.id);
        if (outro) throw erro(`item ${outro.id} já está ligado a outro card (${outro.productId}) — conferir antes`);
        const r = await tx.xmlFiscalItem.updateMany({ where: { id: { in: itemIds }, productId: null }, data: { productId: p.id, matchStatus: 'matched' } });
        return { ok: true, ligados: r.count, productId: p.id, sku: p.sku, cardAtivo: p.active };
      });
    },
  });

  registrar('estoque.vincular-codigo', {
    descricao: 'Cadastra o código (EAN da NF-e de entrada) como tamanho num card existente — tamanho literal ou placeholder T-<EAN> — e/ou religa o bipe. Comprado = Σ qCom das entradas; não mexe em StoreStock.',
    async executar(args, { db }) {
      const barcode = String(args.barcode || '').trim();
      if (c.semGtin(barcode)) throw erro(`"${barcode}" não é código válido ("SEM GTIN" nunca vira código)`);
      const vs = c.variantes(barcode);
      return db.$transaction(async (tx) => {
        let ps;
        let criado = false;
        if (args.productSizeId) {
          // modo religar: o tamanho já existe com esse código
          ps = await tx.productSize.findUnique({ where: { id: String(args.productSizeId) }, include: { product: { select: { id: true, name: true, brand: true } } } });
          if (!ps) throw erro('tamanho não existe');
          if (!vs.includes(String(ps.barcode || ''))) {
            const al = await tx.product.findUnique({ where: { id: ps.productId }, select: { aiContext: true } });
            const a = al && al.aiContext && al.aiContext.scannerBarcodeAliases && al.aiContext.scannerBarcodeAliases[c.identidade(barcode)];
            if (!a || a.size !== ps.size) throw erro('o código não pertence a esse tamanho');
          }
        } else {
          const p = await tx.product.findUnique({ where: { id: String(args.productId || '') }, select: { id: true, name: true, brand: true, sizes: { select: { id: true, size: true, barcode: true } } } });
          if (!p) throw erro('card não existe (a rede nunca cria card)');
          const dono = await tx.productSize.findFirst({ where: { barcode: { in: vs } }, select: { id: true, productId: true, size: true } });
          if (dono) throw erro(`código já pertence ao tamanho ${dono.size} do card ${dono.productId} — nada a fazer`);
          const itemIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : [];
          if (!itemIds.length) throw erro('sem item de NF-e de entrada como prova');
          const itens = await itensDeEntrada(tx, itemIds);
          if (itens.some((i) => !vs.includes(String(i.ean || '').trim()))) throw erro('item da NF-e com outro código');
          // tamanho: só literal e plausível, nunca Adidas (caixa decide)
          let size = args.size ? String(args.size).trim().toUpperCase() : null;
          if (size && (c.ehAdidas(p.brand) || !c.tamanhoPlausivel(size) || !itens.every((i) => c.tamanhoNaDescricao(i.description, size) || c.tamanhoNoCprod(i.supplierCode, size)))) size = null;
          const tamanho = size || 'T-' + barcode;
          const existente = p.sizes.find((s) => s.size === tamanho);
          // COMPRADO = Σ qCom das NF-e de ENTRADA do código (sem transferência, sem SEM GTIN)
          const todas = await tx.xmlFiscalItem.findMany({ where: { ean: { in: vs }, fiscalDocument: c.WHERE_DOC_ENTRADA }, select: { quantity: true, cfop: true, fiscalDocument: { select: c.SEL_DOC } } });
          const comprado = Math.round(todas.filter((i) => !c.cfopTransf(i.cfop) && c.docEhEntrada(i.fiscalDocument, [i])).reduce((s, i) => s + (Number(i.quantity) || 0), 0));
          if (existente) {
            if (existente.barcode && !vs.includes(existente.barcode)) throw erro(`o tamanho ${tamanho} já tem outro código (${existente.barcode}) — conferir na caixa`);
            ps = await tx.productSize.update({ where: { id: existente.id }, data: { barcode, stock: comprado }, include: { product: { select: { id: true, name: true, brand: true } } } });
          } else {
            ps = await tx.productSize.create({ data: { productId: p.id, size: tamanho, barcode, stock: comprado }, include: { product: { select: { id: true, name: true, brand: true } } } });
            criado = true;
          }
          await tx.xmlFiscalItem.updateMany({ where: { id: { in: itemIds }, productId: null }, data: { productId: p.id, matchStatus: 'matched' } });
        }
        let bipe = null;
        if (args.bipeId) {
          const b = await tx.stocktakeBipe.findUnique({ where: { id: String(args.bipeId) } });
          if (b && !b.found && !b.excludedAt && vs.includes(String(b.barcode).trim())) {
            bipe = await tx.stocktakeBipe.update({ where: { id: b.id }, data: { found: true, productId: ps.product.id, productSizeId: ps.id, productName: ps.product.name, productSize: ps.size, productBrand: ps.product.brand } });
          }
        }
        return { ok: true, productSizeId: ps.id, tamanho: ps.size, comprado: ps.stock, criado, bipeReligado: !!bipe };
      });
    },
  });
};
