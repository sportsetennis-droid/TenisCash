// Importa NFes da pasta tmp/nfe-loja02/ — descarta transferência,
// importa apenas entrada (compra de fornecedor real).
// recipientCnpj fica gravado em cada XmlFiscalDocument → a loja é
// resolvida via Store.fiscalIssuer.cnpj == recipientCnpj.
// Reusa parser/classifier do script genérico.

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DIR = path.join(__dirname, '..', 'tmp', 'nfe-loja02');

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
  return { accessKey, number, series, issuerCnpj, issuerName, recipientCnpj, recipientName, issueDate: issueDateStr ? new Date(issueDateStr) : null, totalValue, icmsValue, ipiValue, pisValue, cofinsValue, docType, items };
}

async function ensureSupplier(cnpj, name) {
  if (!cnpj) return null;
  const exist = await prisma.supplier.findFirst({ where: { cnpj } });
  if (exist) return exist;
  return prisma.supplier.create({ data: { cnpj, companyName: name || `Fornecedor ${cnpj}`, active: true } });
}

(async () => {
  if (!fs.existsSync(DIR)) { console.error('Pasta nao existe:', DIR); process.exit(1); }
  const files = fs.readdirSync(DIR).filter((f) => f.startsWith('NFE_') && f.endsWith('.xml'));
  console.log(`Encontradas ${files.length} NFes no ZIP`);

  let importedEntrada = 0, skippedTransfer = 0, skippedExisting = 0, errors = 0;
  const job = await prisma.xmlImportJob.create({
    data: { name: `Loja02 Bessa — ZIP ${new Date().toISOString().slice(0,10)}`, type: 'NFE_ENTRY', status: 'PROCESSING', totalItems: files.length },
  });

  for (const f of files) {
    try {
      const xml = fs.readFileSync(path.join(DIR, f), 'utf8');
      const nfe = parseNfe(xml);
      if (!nfe.accessKey) { errors++; continue; }

      // DESCARTA transferência
      if (nfe.docType === 'transferencia') { skippedTransfer++; continue; }

      // Já existe?
      const existing = await prisma.xmlFiscalDocument.findUnique({ where: { accessKey: nfe.accessKey } });
      if (existing) { skippedExisting++; continue; }

      const supplier = await ensureSupplier(nfe.issuerCnpj, nfe.issuerName);

      const doc = await prisma.xmlFiscalDocument.create({
        data: {
          importJobId: job.id,
          accessKey: nfe.accessKey,
          number: nfe.number, series: nfe.series,
          issuerCnpj: nfe.issuerCnpj, issuerName: nfe.issuerName,
          recipientCnpj: nfe.recipientCnpj, recipientName: nfe.recipientName,
          issueDate: nfe.issueDate, totalValue: nfe.totalValue,
          icmsValue: nfe.icmsValue, ipiValue: nfe.ipiValue, pisValue: nfe.pisValue, cofinsValue: nfe.cofinsValue,
          docType: nfe.docType, supplierId: supplier?.id, status: 'imported',
        },
      });

      if (nfe.items.length) {
        await prisma.xmlFiscalItem.createMany({
          data: nfe.items.map((it) => ({
            documentId: doc.id, nItem: it.nItem, supplierCode: it.supplierCode,
            description: it.description, ean: it.ean, ncm: it.ncm, cfop: it.cfop, cst: it.cst,
            unit: it.unit, quantity: it.quantity, unitValue: it.unitValue, totalValue: it.totalValue,
            matchStatus: 'pending',
          })),
          skipDuplicates: true,
        });
      }
      importedEntrada++;
    } catch (err) {
      errors++;
      console.error(' ERR', f, err.message);
    }
  }

  await prisma.xmlImportJob.update({
    where: { id: job.id },
    data: { status: 'COMPLETED', processedItems: importedEntrada, completedAt: new Date(), errorMessage: errors ? `${errors} erros` : null },
  });

  console.log('\n=== RESULTADO ===');
  console.log(`Total no ZIP: ${files.length}`);
  console.log(`Importadas (entrada): ${importedEntrada}`);
  console.log(`Descartadas (transferencia): ${skippedTransfer}`);
  console.log(`Ja existiam (skip): ${skippedExisting}`);
  console.log(`Erros: ${errors}`);
  console.log(`Job ID: ${job.id}`);

  await prisma.$disconnect();
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
