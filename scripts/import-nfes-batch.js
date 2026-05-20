// =====================================================================
// import-nfes-batch.js — importa XMLs pro banco (XmlFiscalDocument)
// =====================================================================
// Lê todos XMLs de N pastas, classifica como entrada/saida/transferencia
// e grava em XmlFiscalDocument + XmlFiscalItem. Cria Supplier
// automaticamente pra cada CNPJ emissor que não existe.
//
// Idempotente: ignora NFes já importadas (por accessKey).
//
// Uso:
//   node scripts/import-nfes-batch.js \
//        --dirs C:/tmp/nfe-recount/matriz,C:/tmp/nfe-recount/filial02 \
//        --root-cnpj 44052617
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split('\n').forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));
const DIRS = (args.dirs || 'C:/tmp/nfe-recount/matriz,C:/tmp/nfe-recount/filial02').split(',');
const ROOT = args['root-cnpj'] || '44052617';

function walk(d) {
  const out = [];
  function rec(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) rec(p);
      else if (/\.xml$/i.test(p)) out.push(p);
    }
  }
  rec(d);
  return out;
}

function ex(s, tag) {
  if (!s) return null;
  const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

function classify(emit, dest) {
  if (!emit || !dest) return null;
  if (emit.startsWith(ROOT) && dest.startsWith(ROOT)) return 'transferencia';
  if (dest.startsWith(ROOT)) return 'entrada';   // compra
  if (emit.startsWith(ROOT)) return 'saida';     // venda
  return null;
}

(async () => {
  const files = DIRS.flatMap(walk);
  console.log('XMLs encontrados:', files.length);
  console.log('Raiz Meta:', ROOT, '(matriz + filiais)');

  // Pre-cache: chaves de acesso já importadas
  const existing = await prisma.xmlFiscalDocument.findMany({ select: { accessKey: true } });
  const existingKeys = new Set(existing.map(e => e.accessKey).filter(Boolean));
  console.log('Já importadas no banco:', existingKeys.size);

  // Pre-cache: suppliers por cnpj
  const suppliers = await prisma.supplier.findMany({ select: { id: true, cnpj: true, companyName: true } });
  const supByCnpj = Object.fromEntries(suppliers.filter(s => s.cnpj).map(s => [s.cnpj, s]));

  // Cria job de import
  const job = await prisma.xmlImportJob.create({
    data: { source: 'batch-recount', totalFiles: files.length, status: 'processing' },
  }).catch(() => null);
  const jobId = job?.id;

  let ok = 0, skipped = 0, errors = 0, newSuppliers = 0, items = 0;
  const typeStats = { entrada: 0, saida: 0, transferencia: 0, unknown: 0 };

  for (const f of files) {
    let xml;
    try { xml = fs.readFileSync(f, 'utf8'); } catch { skipped++; continue; }
    if (!xml.includes('<infNFe') && !xml.includes('<NFe') && !xml.includes('<nfeProc')) { skipped++; continue; }
    if (xml.includes('<procEventoNFe') || xml.includes('<envEvento') || xml.includes('<eventoNFe')) { skipped++; continue; }
    try {
      const emitMatch = xml.match(/<emit>[\s\S]*?<CNPJ>(\d+)<\/CNPJ>/);
      const destMatch = xml.match(/<dest>[\s\S]*?<CNPJ>(\d+)<\/CNPJ>/);
      const emitCnpj = emitMatch?.[1];
      const destCnpj = destMatch?.[1];
      if (!emitCnpj || !destCnpj) { skipped++; continue; }

      const emitName = ex(ex(xml, 'emit') || '', 'xNome');
      const destName = ex(ex(xml, 'dest') || '', 'xNome');
      const ideBlock = ex(xml, 'ide') || '';
      const number = ex(ideBlock, 'nNF');
      const series = ex(ideBlock, 'serie');
      const dhEmiRaw = ex(ideBlock, 'dhEmi') || ex(ideBlock, 'dEmi');
      const issueDate = dhEmiRaw ? new Date(dhEmiRaw) : null;
      // accessKey: na infNFe Id="NFe<chave 44>"
      const keyMatch = xml.match(/Id="NFe(\d{44})"/);
      const accessKey = keyMatch?.[1];
      if (!accessKey) { skipped++; continue; }
      if (existingKeys.has(accessKey)) { skipped++; continue; }

      const totalMatch = xml.match(/<total>[\s\S]*?<vNF>([\d.]+)<\/vNF>/);
      const totalValue = totalMatch ? parseFloat(totalMatch[1]) : null;

      const docType = classify(emitCnpj, destCnpj) || 'unknown';
      typeStats[docType] = (typeStats[docType] || 0) + 1;

      // Auto-cria fornecedor se for entrada e emissor não existe
      let supplierId = null;
      if (docType === 'entrada') {
        if (supByCnpj[emitCnpj]) {
          supplierId = supByCnpj[emitCnpj].id;
        } else {
          const newSup = await prisma.supplier.create({
            data: { cnpj: emitCnpj, companyName: emitName || `Fornecedor ${emitCnpj}`, active: true },
          }).catch(() => null);
          if (newSup) {
            supplierId = newSup.id;
            supByCnpj[emitCnpj] = newSup;
            newSuppliers++;
          }
        }
      }

      // Cria o documento
      const doc = await prisma.xmlFiscalDocument.create({
        data: {
          importJobId: jobId, accessKey, number, series,
          issuerCnpj: emitCnpj, issuerName: emitName,
          recipientCnpj: destCnpj, recipientName: destName,
          issueDate, totalValue,
          supplierId, docType,
          status: 'imported',
        },
      });

      // Cria items
      const detRe = /<det[^>]*>([\s\S]*?)<\/det>/g;
      let dm;
      const itemsData = [];
      while ((dm = detRe.exec(xml)) !== null) {
        const det = dm[1];
        const prod = ex(det, 'prod') || '';
        itemsData.push({
          fiscalDocumentId: doc.id,
          supplierCode: ex(prod, 'cProd'),
          description: (ex(prod, 'xProd') || '').slice(0, 500),
          ean: ex(prod, 'cEAN'),
          ncm: ex(prod, 'NCM'),
          cfop: ex(prod, 'CFOP'),
          unit: ex(prod, 'uCom'),
          quantity: parseFloat(ex(prod, 'qCom') || '0'),
          unitValue: parseFloat(ex(prod, 'vUnCom') || '0'),
          totalValue: parseFloat(ex(prod, 'vProd') || '0'),
        });
      }
      if (itemsData.length) {
        await prisma.xmlFiscalItem.createMany({ data: itemsData });
        items += itemsData.length;
      }

      existingKeys.add(accessKey);
      ok++;
      if (ok % 50 === 0) console.log(`  ${ok}/${files.length}... type:${docType} ${emitName?.slice(0,30) || emitCnpj}`);
    } catch (e) {
      errors++;
      if (errors <= 3) console.error('  ERR:', path.basename(f), e.message);
    }
  }

  if (jobId) {
    await prisma.xmlImportJob.update({
      where: { id: jobId },
      data: { status: 'completed', processedFiles: ok, totalFiles: files.length },
    }).catch(() => {});
  }

  console.log('\n=== Resumo ===');
  console.log('  Importadas:        ', ok);
  console.log('  Skipped:           ', skipped);
  console.log('  Erros:             ', errors);
  console.log('  Items totais:      ', items);
  console.log('  Suppliers criados: ', newSuppliers);
  console.log('  Por tipo:');
  Object.entries(typeStats).forEach(([k, v]) => console.log('    ' + k + ': ' + v));

  await prisma.$disconnect();
})().catch(async (e) => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
