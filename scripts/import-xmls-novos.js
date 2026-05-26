// =====================================================================
// Importa XMLs da pasta xmls-novos/ — qualquer arquivo .xml
// Aceita NFe (mod 55) e NFCe (mod 65).
// =====================================================================
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DIR = path.join(__dirname, '..', 'xmls-novos');

function classifyDocType(issuerCnpj, recipientCnpj, cfops, mod) {
  if (mod === '65') return 'saida'; // NFCe = venda da loja
  if (!issuerCnpj || !recipientCnpj) return 'entrada';
  const sameRoot = issuerCnpj.slice(0, 8) === recipientCnpj.slice(0, 8);
  const hasTransferCfop = cfops.some((c) => c === '5152' || c === '6152');
  if (sameRoot || hasTransferCfop) return 'transferencia';
  return 'entrada';
}

function parseNfe(xml) {
  const get = (re) => (xml.match(re) || [])[1] || null;
  const accessKey = get(/<chNFe>(\d{44})<\/chNFe>/) || get(/Id="NFe(\d{44})"/) || get(/Id="NFCe(\d{44})"/);
  const number = get(/<nNF>(\d+)<\/nNF>/);
  const series = get(/<serie>(\d+)<\/serie>/);
  const mod = get(/<mod>(\d+)<\/mod>/);
  const issuerCnpj = get(/<emit>[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/);
  const issuerName = get(/<emit>[\s\S]*?<xNome>([^<]+)<\/xNome>/);
  const recipientCnpj = get(/<dest>[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/) || get(/<dest>[\s\S]*?<CPF>(\d{11})<\/CPF>/);
  const recipientName = get(/<dest>[\s\S]*?<xNome>([^<]+)<\/xNome>/);
  const issueDateStr = get(/<dhEmi>([^<]+)<\/dhEmi>/) || get(/<dEmi>([^<]+)<\/dEmi>/);
  const totalValue = parseFloat(get(/<vNF>([\d.]+)<\/vNF>/) || '0');

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
      unit: g(/<uCom>([^<]+)<\/uCom>/),
      quantity: parseFloat(g(/<qCom>([\d.]+)<\/qCom>/) || '0'),
      unitValue: parseFloat(g(/<vUnCom>([\d.]+)<\/vUnCom>/) || '0'),
      totalValue: parseFloat(g(/<vProd>([\d.]+)<\/vProd>/) || '0'),
    };
  });

  const cfops = items.map((i) => i.cfop).filter(Boolean);
  const docType = classifyDocType(issuerCnpj, recipientCnpj, cfops, mod);

  return { accessKey, number, series, mod, issuerCnpj, issuerName, recipientCnpj, recipientName, issueDate: issueDateStr ? new Date(issueDateStr) : null, totalValue, docType, items };
}

async function ensureSupplier(cnpj, name) {
  if (!cnpj) return null;
  const exist = await prisma.supplier.findFirst({ where: { cnpj } });
  if (exist) return exist;
  return prisma.supplier.create({ data: { cnpj, companyName: name || `Fornecedor ${cnpj}`, active: true } });
}

// Walk recursivo: busca XMLs em DIR e subpastas
function walkXmls(dir) {
  const out = [];
  function recurse(d) {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) recurse(full);
      else if (name.toLowerCase().endsWith('.xml')) {
        // Filtra: NFe e procNFe SIM; EVENTO/CANC NÃO (não criam NFe nova)
        const upper = name.toUpperCase();
        if (upper.includes('EVENTO_') || upper.startsWith('CANC_') || upper.startsWith('110111_')) continue;
        out.push(full);
      }
    }
  }
  recurse(dir);
  return out;
}

(async () => {
  if (!fs.existsSync(DIR)) { console.error('Diretório não existe:', DIR); process.exit(1); }
  const files = walkXmls(DIR);
  console.log(`Encontrados ${files.length} XMLs de NFe em ${DIR} (e subpastas, ignorando eventos/cancelamentos)\n`);

  const job = await prisma.xmlImportJob.create({
    data: { name: `Import xmls-novos (${files.length} XMLs · ${new Date().toISOString().slice(0,16)})`, type: 'NFE_ENTRY', status: 'PROCESSING', totalItems: files.length },
  });

  let imported = 0, skipped = 0, errors = 0;
  const byType = { entrada: 0, transferencia: 0, saida: 0 };

  let idx = 0;
  for (const fullPath of files) {
    idx++;
    const f = path.basename(fullPath);
    if (idx % 50 === 0) process.stdout.write(`  ${idx}/${files.length}\r`);
    try {
      const xml = fs.readFileSync(fullPath, 'utf8');
      const nfe = parseNfe(xml);
      if (!nfe.accessKey) { errors++; continue; }

      const existing = await prisma.xmlFiscalDocument.findUnique({ where: { accessKey: nfe.accessKey } });
      if (existing) { skipped++; continue; }

      const supplier = await ensureSupplier(nfe.issuerCnpj, nfe.issuerName);

      const doc = await prisma.xmlFiscalDocument.create({
        data: {
          importJobId: job.id, accessKey: nfe.accessKey, number: nfe.number, series: nfe.series,
          issuerCnpj: nfe.issuerCnpj, issuerName: nfe.issuerName,
          recipientCnpj: nfe.recipientCnpj, issueDate: nfe.issueDate,
          totalValue: nfe.totalValue, docType: nfe.docType,
          supplierId: supplier?.id, status: 'imported',
        },
      });

      if (nfe.items.length) {
        await prisma.xmlFiscalItem.createMany({
          data: nfe.items.map((it) => ({
            fiscalDocumentId: doc.id,
            supplierCode: it.supplierCode, description: it.description || '(sem descrição)',
            ean: it.ean, ncm: it.ncm, cfop: it.cfop, unit: it.unit,
            quantity: it.quantity, unitValue: it.unitValue, totalValue: it.totalValue,
            matchStatus: 'pending',
          })),
          skipDuplicates: true,
        });
      }

      imported++;
      byType[nfe.docType] = (byType[nfe.docType] || 0) + 1;
    } catch (err) {
      errors++;
      console.log('  ERR', f.slice(0, 50), '·', err.message);
    }
  }

  await prisma.xmlImportJob.update({
    where: { id: job.id },
    data: { status: 'COMPLETED', processedItems: imported, completedAt: new Date(), errorMessage: errors ? `${errors} erros` : null },
  });

  console.log('\n=== RESULTADO ===');
  console.log(`Importadas: ${imported}`);
  console.log(`  → entrada (compra fornecedor): ${byType.entrada || 0}`);
  console.log(`  → transferência (matriz↔filial): ${byType.transferencia || 0}`);
  console.log(`  → saída (NFCe venda): ${byType.saida || 0}`);
  console.log(`Já existiam (puladas): ${skipped}`);
  console.log(`Erros: ${errors}`);
  console.log(`Job ID: ${job.id}`);

  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
