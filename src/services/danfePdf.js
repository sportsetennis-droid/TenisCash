// =====================================================================
// danfePdf.js — gera o PDF da DANFE (NFC-e/NFe) a partir do XML autorizado.
// Extraído da rota /documents/:id/danfe pra ser reusável (rota pública /nota
// e envio no WhatsApp). Usa node-sped-pdf (DANFCe p/ modelo 65, DANFe p/ 55).
// =====================================================================

let _spedPdf = null;
async function getSpedPdf() {
  if (!_spedPdf) _spedPdf = await import('node-sped-pdf');
  return _spedPdf;
}

// Envolve a NFe assinada num nfeProc com o protNFe (protocolo do banco), senão a
// DANFE imprime "Protocolo 000000000000000". Só afeta a impressão, não o XML SEFAZ.
function buildNfeProcForDanfe(signedXml, doc) {
  try {
    if (!signedXml || signedXml.includes('<protNFe') || signedXml.includes('<nfeProc')) return signedXml;
    if (!doc || !doc.protocol || !doc.accessKey) return signedXml;
    const nfe = signedXml.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/i, '');
    const dig = (nfe.match(/<DigestValue>([^<]*)<\/DigestValue>/) || [])[1] || '';
    const tpAmb = (doc.issuer && doc.issuer.environment === 'production') ? '1' : '2';
    const dt = doc.createdAt ? new Date(doc.createdAt) : new Date();
    const dhRecbto = new Date(dt.getTime() - 3 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '-03:00');
    const protNFe = '<protNFe versao="4.00"><infProt><tpAmb>' + tpAmb + '</tpAmb><verAplic>SVRS</verAplic><chNFe>' + doc.accessKey + '</chNFe><dhRecbto>' + dhRecbto + '</dhRecbto><nProt>' + doc.protocol + '</nProt><digVal>' + dig + '</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>';
    return '<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' + nfe + protNFe + '</nfeProc>';
  } catch (e) { return signedXml; }
}

// doc precisa ter xmlContent + issuer (include). Retorna Buffer do PDF.
async function buildDanfePdf(doc) {
  if (!doc || !doc.xmlContent) throw new Error('Documento sem XML');
  const { DANFCe, DANFe } = await getSpedPdf();
  const fn = doc.docType === 'NFCE' ? DANFCe : DANFe;
  let renderXml = doc.xmlContent;
  const razao = doc.issuer && doc.issuer.companyName, fant = doc.issuer && doc.issuer.fantasyName;
  if (razao && fant && fant !== razao && renderXml.includes('<xNome>' + razao + '</xNome>')) {
    renderXml = renderXml.replace('<xNome>' + razao + '</xNome>', '<xNome>' + fant + '</xNome>');
  }
  renderXml = buildNfeProcForDanfe(renderXml, doc);
  const pdf = await fn({ xml: renderXml });
  return Buffer.from(pdf);
}

module.exports = { buildDanfePdf, buildNfeProcForDanfe };
