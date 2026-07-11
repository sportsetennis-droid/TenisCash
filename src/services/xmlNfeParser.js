// =====================================================================
// XML NF-e Parser — lê XML de NF-e brasileira (modelo 55) e extrai
// fornecedor, totais fiscais e itens.
// =====================================================================
// Nota: parser básico para campos mais comuns. Para produção fiscal séria,
// usar biblioteca dedicada (node-nfe, etc.). Aqui foca em capturar
// EAN, NCM, CFOP, CST, descrição, qty, valores.

const xml2js = require('xml2js');

const parser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  mergeAttrs: true,
  trim: true,
});

function num(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function pickInfNFe(xmlObj) {
  // Estruturas possíveis: nfeProc.NFe.infNFe | NFe.infNFe | infNFe
  if (xmlObj?.nfeProc?.NFe?.infNFe) return xmlObj.nfeProc.NFe.infNFe;
  if (xmlObj?.NFe?.infNFe) return xmlObj.NFe.infNFe;
  if (xmlObj?.infNFe) return xmlObj.infNFe;
  return null;
}

function parseAccessKey(infNFe) {
  if (!infNFe?.Id) return null;
  const id = String(infNFe.Id);
  // Formato: "NFe" + 44 dígitos
  return id.startsWith('NFe') ? id.slice(3) : id;
}

async function parseNfeXml(xmlBuffer) {
  const xml = typeof xmlBuffer === 'string' ? xmlBuffer : xmlBuffer.toString('utf8');
  const parsed = await parser.parseStringPromise(xml);
  const infNFe = pickInfNFe(parsed);
  if (!infNFe) throw new Error('XML não parece ser NF-e válida (infNFe não encontrado)');

  const ide = infNFe.ide || {};
  const emit = infNFe.emit || {};
  const dest = infNFe.dest || {};
  const total = infNFe.total?.ICMSTot || {};
  const ibsCbsTotal = infNFe.total?.IBSCBSTot || {};

  const detItems = Array.isArray(infNFe.det) ? infNFe.det : (infNFe.det ? [infNFe.det] : []);
  const items = detItems.map((d) => {
    const prod = d.prod || {};
    const imposto = d.imposto || {};
    const icms = imposto.ICMS ? Object.values(imposto.ICMS)[0] || {} : {};
    const ipi = imposto.IPI?.IPITrib || {};
    const pis = imposto.PIS ? Object.values(imposto.PIS)[0] || {} : {};
    const cofins = imposto.COFINS ? Object.values(imposto.COFINS)[0] || {} : {};
    const ibsCbs = imposto.IBSCBS?.gIBSCBS || imposto.IBSCBS || {};
    return {
      supplierCode: prod.cProd || null,
      description: prod.xProd || '',
      ean: prod.cEAN && prod.cEAN !== 'SEM GTIN' ? prod.cEAN : null,
      ncm: prod.NCM || null,
      cfop: prod.CFOP || null,
      cst: icms.CST || icms.CSOSN || null,
      unit: prod.uCom || null,
      quantity: num(prod.qCom),
      unitValue: num(prod.vUnCom),
      totalValue: num(prod.vProd),
      icmsBase: num(icms.vBC),
      icmsValue: num(icms.vICMS),
      icmsStValue: num(icms.vICMSST || icms.vICMSSTRet),
      fcpValue: num(icms.vFCP),
      fcpStValue: num(icms.vFCPST || icms.vFCPSTRet),
      difalDestValue: num(icms.vICMSUFDest),
      ipiValue: num(ipi.vIPI),
      pisCst: pis.CST || null,
      pisBase: num(pis.vBC),
      pisValue: num(pis.vPIS),
      cofinsCst: cofins.CST || null,
      cofinsBase: num(cofins.vBC),
      cofinsValue: num(cofins.vCOFINS),
      cbsValue: num(ibsCbs.vCBS),
      ibsValue: num(ibsCbs.vIBS),
    };
  });

  return {
    accessKey: parseAccessKey(infNFe),
    number: ide.nNF || null,
    series: ide.serie || null,
    issueDate: ide.dhEmi || ide.dEmi || null,
    issuerCnpj: emit.CNPJ || null,
    issuerName: emit.xNome || null,
    recipientCnpj: dest.CNPJ || dest.CPF || null,
    totalValue: num(total.vNF),
    icmsValue: num(total.vICMS),
    icmsStValue: num(total.vST),
    fcpValue: num(total.vFCP),
    fcpStValue: num(total.vFCPST || total.vFCPSTRet),
    difalDestValue: num(total.vICMSUFDest),
    ipiValue: num(total.vIPI),
    pisValue: num(total.vPIS),
    cofinsValue: num(total.vCOFINS),
    cbsValue: num(ibsCbsTotal.vCBS),
    ibsValue: num(ibsCbsTotal.vIBS),
    items,
  };
}

module.exports = { parseNfeXml };
