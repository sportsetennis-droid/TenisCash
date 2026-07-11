const assert = require('assert');
const { parseNfeXml } = require('../src/services/xmlNfeParser');

const xml = `<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe${'1'.repeat(44)}">
<ide><nNF>1</nNF><serie>1</serie><dhEmi>2026-07-11T08:00:00-03:00</dhEmi></ide>
<emit><CNPJ>11111111000111</CNPJ><xNome>Fornecedor</xNome></emit><dest><CNPJ>22222222000122</CNPJ></dest>
<det nItem="1"><prod><cProd>A</cProd><xProd>Tenis</xProd><NCM>64041100</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>1</qCom><vUnCom>100</vUnCom><vProd>100</vProd></prod><imposto>
<ICMS><ICMS00><CST>00</CST><vBC>100</vBC><vICMS>20</vICMS><vFCP>2</vFCP><vICMSUFDest>3</vICMSUFDest></ICMS00></ICMS>
<IPI><IPITrib><vIPI>5</vIPI></IPITrib></IPI><PIS><PISAliq><CST>01</CST><vBC>80</vBC><vPIS>1.32</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>01</CST><vBC>80</vBC><vCOFINS>6.08</vCOFINS></COFINSAliq></COFINS>
</imposto></det><total><ICMSTot><vNF>100</vNF><vICMS>20</vICMS><vST>4</vST><vFCP>2</vFCP><vFCPST>1</vFCPST><vICMSUFDest>3</vICMSUFDest><vIPI>5</vIPI><vPIS>1.32</vPIS><vCOFINS>6.08</vCOFINS></ICMSTot></total>
</infNFe></NFe></nfeProc>`;

(async () => {
  const parsed = await parseNfeXml(xml);
  assert.deepStrictEqual(
    { icms: parsed.icmsValue, st: parsed.icmsStValue, fcp: parsed.fcpValue, fcpSt: parsed.fcpStValue, difal: parsed.difalDestValue, pis: parsed.pisValue, cofins: parsed.cofinsValue },
    { icms: 20, st: 4, fcp: 2, fcpSt: 1, difal: 3, pis: 1.32, cofins: 6.08 },
  );
  assert.deepStrictEqual(
    { icmsBase: parsed.items[0].icmsBase, pisCst: parsed.items[0].pisCst, pisBase: parsed.items[0].pisBase, cofinsCst: parsed.items[0].cofinsCst, cofinsBase: parsed.items[0].cofinsBase },
    { icmsBase: 100, pisCst: '01', pisBase: 80, cofinsCst: '01', cofinsBase: 80 },
  );
  console.log('xmlNfeParser tax fields: OK');
})().catch((err) => { console.error(err); process.exit(1); });
