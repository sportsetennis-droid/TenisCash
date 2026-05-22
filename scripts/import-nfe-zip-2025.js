// =====================================================================
// Importa NFes do ZIP NFE_XML_*.zip (2025) já descompactado em tmp/nfe-import-2025/
//
// REGRA DE CLASSIFICAÇÃO (ver CLAUDE.md):
// - Se CNPJ raiz (8 prim. dígitos) emissor == destinatário → docType='transferencia'
// - Se CFOP do item contém 5152 ou 6152 → docType='transferencia'
// - Caso contrário → docType='entrada'
//
// O accessKey é @unique → duplicatas são ignoradas (não erro).
// =====================================================================

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DIR = path.join(__dirname, '..', 'tmp', 'nfe-import-2025');

function classifyDocType(issuerCnpj, recipientCnpj, cfops) {
  if (!issuerCnpj || !recipientCnpj) return 'entrada';
  const sameRoot = issuerCnpj.slice(0, 8) === recipientCnpj.slice(0, 8);
  const hasTransferCfop = cfops.some((c) => c === '5152' || c === '6152');
  if (sameRoot || hasTransferCfop) return 'transferencia';
  return 'entrada';
}

function parseNfe(xml) {
  const get = (re) => (xml.match(re) || [])[1] || null;
  const accessKey = get(/<chNFe>(\d{44})<\/chNFe>/) || get(/Id="NFe(\d{44})"/);
  const number = get(/<nNF>(\d+)<\/nNF>/);
  const series = get(/<serie>(\d+)<\/serie>/);
  const issuerCnpj = get(/<emit>[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/);
  const issuerName = get(/<emit>[\s\S]*?<xNome>([^<]+)<\/xNome>/);
  const recipientCnpj = get(/<dest>[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/);
  const recipientName = get(/<dest>[\s\S]*?<xNome>([^<]+)<\/xNome>/);
  const issueDateStr = get(/<dhEmi>([^<]+)<\/dhEmi>/) || get(/<dEmi>([^<]+)<\/dEmi>/);
  const totalValue = parseFloat(get(/<vNF>([\d.]+)<\/vNF>/) || '0');
  const icmsValue = parseFloat(get(/<vICMS>([\d.]+)<\/vICMS>/) || '0');
  const ipiValue = parseFloat(get(/<vIPI>([\d.]+)<\/vIPI>/) || '0');
  const pisValue = parseFloat(get(/<vPIS>([\d.]+)<\/vPIS>/) || '0');
  const cofinsValue = parseFloat(get(/<vCOFINS>([\d.]+)<\/vCOFINS>/) || '0');

  // Items
  const detMatches = [...xml.matchAll(/<det\s+nItem="(\d+)">([\s\S]*?)<\/det>/g)];
  const items = detMatches.map(([_, nItem, body]) => {
    const g = (re) => (body.match(re) || [])[1] || null;
    return {
      nItem: parseInt(nItem, 10),
      supplierCode: g(/<cProd>([^<]+)<\/cProd>/),
      description: g(/<xProd>([^<]+)<\/xProd>/),
      ean: g(/<cEAN>([^<]+)<\/cEAN>/),
      ncm: g(/<NCM>([^<]+)<\/NCM>/),
      cfop: g(/<CFOP>([^<]+)<\/CFOP>/),
      cst: g(/<CST>([^<]+)<\/CST>/),
      unit: g(/<uCom>([^<]+)<\/uCom>/),
      quantity: parseFloat(g(/<qCom>([\d.]+)<\/qCom>/) || '0'),
      unitValue: parseFloat(g(/<vUnCom>([\d.]+)<\/vUnCom>/) || '0'),
      totalValue: parseFloat(g(/<vProd>([\d.]+)<\/vProd>/) || '0'),
    };
  });

  const cfops = items.map((i) => i.cfop).filter(Boolean);
  const docType = classifyDocType(issuerCnpj, recipientCnpj, cfops);

  return {
    accessKey,
    number,
    series,
    issuerCnpj,
    issuerName,
    recipientCnpj,
    recipientName,
    issueDate: issueDateStr ? new Date(issueDateStr) : null,
    totalValue,
    icmsValue,
    ipiValue,
    pisValue,
    cofinsValue,
    docType,
    items,
  };
}

async function ensureSupplier(cnpj, name) {
  if (!cnpj) return null;
  const exist = await prisma.supplier.findFirst({ where: { cnpj } });
  if (exist) return exist;
  return prisma.supplier.create({
    data: { cnpj, companyName: name || `Fornecedor ${cnpj}`, active: true },
  });
}

(async () => {
  if (!fs.existsSync(DIR)) {
    console.error('Diretório não existe:', DIR);
    process.exit(1);
  }
  const files = fs.readdirSync(DIR).filter((f) => f.startsWith('NFE_') && f.endsWith('.xml'));
  console.log(`Encontrados ${files.length} NFes pra processar...`);

  const job = await prisma.xmlImportJob.create({
    data: {
      name: `Import ZIP 2025-12-09 (${files.length} NFes)`,
      type: 'NFE_ENTRY',
      status: 'PROCESSING',
      totalItems: files.length,
    },
  });

  let imported = 0, skipped = 0, errors = 0;
  let countEntrada = 0, countTransferencia = 0;

  for (const f of files) {
    try {
      const xml = fs.readFileSync(path.join(DIR, f), 'utf8');
      const nfe = parseNfe(xml);
      if (!nfe.accessKey) {
        errors++;
        continue;
      }

      const existing = await prisma.xmlFiscalDocument.findUnique({ where: { accessKey: nfe.accessKey } });
      if (existing) {
        skipped++;
        continue;
      }

      const supplier = await ensureSupplier(nfe.issuerCnpj, nfe.issuerName);

      const doc = await prisma.xmlFiscalDocument.create({
        data: {
          importJobId: job.id,
          accessKey: nfe.accessKey,
          number: nfe.number,
          series: nfe.series,
          issuerCnpj: nfe.issuerCnpj,
          issuerName: nfe.issuerName,
          recipientCnpj: nfe.recipientCnpj,
          recipientName: nfe.recipientName,
          issueDate: nfe.issueDate,
          totalValue: nfe.totalValue,
          icmsValue: nfe.icmsValue,
          ipiValue: nfe.ipiValue,
          pisValue: nfe.pisValue,
          cofinsValue: nfe.cofinsValue,
          docType: nfe.docType,
          supplierId: supplier?.id,
          status: 'imported',
        },
      });

      // Items
      if (nfe.items.length) {
        await prisma.xmlFiscalItem.createMany({
          data: nfe.items.map((it) => ({
            documentId: doc.id,
            nItem: it.nItem,
            supplierCode: it.supplierCode,
            description: it.description,
            ean: it.ean,
            ncm: it.ncm,
            cfop: it.cfop,
            cst: it.cst,
            unit: it.unit,
            quantity: it.quantity,
            unitValue: it.unitValue,
            totalValue: it.totalValue,
            matchStatus: 'pending',
          })),
          skipDuplicates: true,
        });
      }

      imported++;
      if (nfe.docType === 'entrada') countEntrada++;
      else countTransferencia++;

      if (imported % 50 === 0) console.log(`  ... ${imported}/${files.length} importadas`);
    } catch (err) {
      errors++;
      console.error('  ERR', f, err.message);
    }
  }

  await prisma.xmlImportJob.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED',
      processedItems: imported,
      completedAt: new Date(),
      errorMessage: errors ? `${errors} erros` : null,
    },
  });

  console.log('\n=== RESULTADO ===');
  console.log(`Total processadas: ${files.length}`);
  console.log(`Importadas: ${imported}`);
  console.log(`  → entrada: ${countEntrada}`);
  console.log(`  → transferencia: ${countTransferencia}`);
  console.log(`Já existiam (skip): ${skipped}`);
  console.log(`Erros: ${errors}`);
  console.log(`Job ID: ${job.id}`);

  await prisma.$disconnect();
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
