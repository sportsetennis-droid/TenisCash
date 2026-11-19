// Importador de XML de NF-e (mesma lógica do upload do admin) — usado pelo
// upload manual (POST /api/admin/xml/nfe/import) e pela distribuição automática
// da SEFAZ (nfeDistribuicao.js). Só registra o documento e os itens e tenta casar
// com produto existente: NÃO cria card (isso é o "aplicar" do admin), e a
// classificação entrada × transferência segue a regra do CLAUDE.md.
const { parseNfeXml } = require('./xmlNfeParser');

async function importNfeXml(prisma, xml, { fileName = 'nfe.xml', userId = null } = {}) {
    const parsed = await parseNfeXml(xml);

    // Cria job de importação
    const job = await prisma.xmlImportJob.create({
      data: {
        name: fileName,
        type: 'NFE_ENTRY',
        status: 'PROCESSING',
        uploadedById: userId,
        originalFileName: fileName,
        totalItems: parsed.items.length,
      },
    });

    // Cria/atualiza fornecedor
    let supplier = null;
    if (parsed.issuerCnpj) {
      supplier = await prisma.supplier.findUnique({ where: { cnpj: parsed.issuerCnpj } });
      if (!supplier) {
        supplier = await prisma.supplier.create({
          data: {
            companyName: parsed.issuerName || ('CNPJ ' + parsed.issuerCnpj),
            cnpj: parsed.issuerCnpj,
            notes: 'Importado via NF-e ' + (parsed.number || ''),
          },
        });
      }
    }

    // Cria documento fiscal
    let document;
    try {
      document = await prisma.xmlFiscalDocument.create({
        data: {
          importJobId: job.id,
          accessKey: parsed.accessKey || null,
          number: parsed.number || null,
          series: parsed.series || null,
          issuerCnpj: parsed.issuerCnpj || null,
          issuerName: parsed.issuerName || null,
          recipientCnpj: parsed.recipientCnpj || null,
          issueDate: parsed.issueDate ? new Date(parsed.issueDate) : null,
          totalValue: parsed.totalValue,
          icmsValue: parsed.icmsValue,
          icmsStValue: parsed.icmsStValue,
          fcpValue: parsed.fcpValue,
          fcpStValue: parsed.fcpStValue,
          difalDestValue: parsed.difalDestValue,
          ipiValue: parsed.ipiValue,
          pisValue: parsed.pisValue,
          cofinsValue: parsed.cofinsValue,
          cbsValue: parsed.cbsValue,
          ibsValue: parsed.ibsValue,
          supplierId: supplier?.id || null,
          status: 'imported',
        },
      });
    } catch (err) {
      // Pode ter conflito de chave única (accessKey duplicada)
      await prisma.xmlImportJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', errorMessage: 'XML já importado (chave de acesso duplicada)' },
      });
      return { duplicate: true, detail: err.message, jobId: job.id };
    }

    // Tenta match com produtos existentes (por EAN ou supplierCode → SKU)
    const itemsToCreate = [];
    let matched = 0;
    let newProductsHint = 0;

    for (const item of parsed.items) {
      let productId = null;
      let matchStatus = 'pending';
      if (item.ean) {
        const p = await prisma.product.findFirst({ where: { sku: item.ean } });
        if (p) { productId = p.id; matchStatus = 'matched'; matched++; }
      }
      if (!productId && item.supplierCode) {
        const p = await prisma.product.findFirst({ where: { sku: item.supplierCode } });
        if (p) { productId = p.id; matchStatus = 'matched'; matched++; }
      }
      if (!productId) {
        matchStatus = 'new_product';
        newProductsHint++;
      }
      itemsToCreate.push({
        fiscalDocumentId: document.id,
        productId,
        supplierCode: item.supplierCode,
        description: item.description,
        ean: item.ean,
        ncm: item.ncm,
        cfop: item.cfop,
        cst: item.cst,
        unit: item.unit,
        quantity: item.quantity,
        unitValue: item.unitValue,
        totalValue: item.totalValue,
        icmsBase: item.icmsBase,
        icmsValue: item.icmsValue,
        icmsStValue: item.icmsStValue,
        fcpValue: item.fcpValue,
        fcpStValue: item.fcpStValue,
        difalDestValue: item.difalDestValue,
        ipiValue: item.ipiValue,
        pisCst: item.pisCst,
        pisBase: item.pisBase,
        pisValue: item.pisValue,
        cofinsCst: item.cofinsCst,
        cofinsBase: item.cofinsBase,
        cofinsValue: item.cofinsValue,
        cbsValue: item.cbsValue,
        ibsValue: item.ibsValue,
        matchStatus,
      });
    }
    if (itemsToCreate.length) {
      await prisma.xmlFiscalItem.createMany({ data: itemsToCreate });
    }

    await prisma.xmlImportJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        processedItems: itemsToCreate.length,
        completedAt: new Date(),
      },
    });

    await prisma.xmlFiscalDocument.update({
      where: { id: document.id },
      // Regra do CLAUDE.md: entrada × transferência (CNPJ raiz igual ou CFOP 5152/6152) gravada na importação.
      data: { status: matched === itemsToCreate.length ? 'matched' : 'partial', ...(document.docType ? {} : (() => { const c = require('../ai/rede/neuronios/_comum-estoque').classificarNfe(document, parsed.items || []); return c.docType ? { docType: c.docType } : {}; })()) },
    });
    require('../ai/rede/ganchos').nfeImportada(document.id);

    return {
      duplicate: false,
      ok: true,
      jobId: job.id,
      documentId: document.id,
      supplierId: supplier?.id || null,
      totals: parsed,
      itemsCount: itemsToCreate.length,
      matched,
      newProductsHint,
    };
}

module.exports = { importNfeXml };
