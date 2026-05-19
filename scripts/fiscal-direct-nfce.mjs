// =====================================================================
// fiscal-direct-nfce.mjs
// Emite NFCe DIRETO na SEFAZ via SVRS (SEFAZ Virtual Rio Grande do Sul)
// que atende PB. Usa node-sped-nfe pra montar XML + assinar e https
// nativo pra enviar (a lib tem bug de TLS com Node 24+OpenSSL 3).
//
// Uso: node scripts/fiscal-direct-nfce.mjs [--prod]
// =====================================================================

import { PrismaClient } from '@prisma/client';
import { Make, Tools } from 'node-sped-nfe';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const prisma = new PrismaClient();

const PROD = process.argv.includes('--prod');
const TP_AMB = PROD ? 1 : 2;
const CNPJ_EMITENTE = '44052617000126';
const PFX_PATH = 'C:\\Chianca\\NFe_Emissao001\\Certificado2026.pfx';
const PFX_SENHA = '123456';

const SVRS_URL = PROD
  ? 'https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx'
  : 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx';

async function main() {
  const issuer = await prisma.fiscalIssuer.findUnique({ where: { cnpj: CNPJ_EMITENTE } });
  if (!issuer) throw new Error('Issuer Meta Esportes não cadastrado');

  const produto = await prisma.product.findFirst({
    where: { active: true, ncm: { not: null }, price: { gt: 0 } },
    select: { id: true, sku: true, name: true, ncm: true, cfop: true, price: true, unidade: true },
  });
  if (!produto) throw new Error('Sem produto com NCM');

  console.log('\n=== NFCe DIRETO SEFAZ-PB (SVRS) ===');
  console.log('Empresa:', issuer.companyName);
  console.log('Ambiente:', PROD ? 'PRODUÇÃO ⚠' : 'Homologação');
  console.log('URL SEFAZ:', SVRS_URL);
  console.log('Produto:', produto.name.slice(0, 60), '| R$', produto.price.toFixed(2));

  // Setup Tools
  const tools = new Tools({
    mod: 65,
    tpAmb: TP_AMB,
    UF: 'PB',
    versao: '4.00',
    CSC: issuer.csc,
    CSCid: issuer.cscId,
    timeout: 30000,
    CNPJ: issuer.cnpj,
  }, { pfx: PFX_PATH, senha: PFX_SENHA });

  // Monta XML
  const nfe = new Make();
  const nNF = issuer.nfceNextNumber || 1;
  const cNF = String(Math.floor(Math.random() * 99999999)).padStart(8, '0');

  nfe.tagInfNFe({ versao: '4.00', Id: null, pk_nItem: null });
  nfe.tagIde({
    cUF: 25, cNF, natOp: 'VENDA AO CONSUMIDOR',
    mod: 65, serie: issuer.nfceSerie || 1, nNF,
    dhEmi: (() => {
      const d = new Date(Date.now() - 3 * 60 * 60 * 1000); // UTC-3
      return d.toISOString().replace(/\.\d+Z$/, '-03:00');
    })(),
    tpNF: 1, idDest: 1,
    cMunFG: parseInt(issuer.cityCode || '2507507', 10),
    tpImp: 4, tpEmis: 1, cDV: null, tpAmb: TP_AMB,
    finNFe: 1, indFinal: 1, indPres: 1, procEmi: 0, verProc: '1.0.0',
  });
  nfe.tagEmit({
    CNPJ: issuer.cnpj, xNome: issuer.companyName,
    xFant: issuer.fantasyName || issuer.companyName,
    IE: issuer.ie, CRT: issuer.crt || 3,
  });
  // Omite null/undefined pra não gerar <tag/> vazio que viola XSD
  const noNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));
  nfe.tagEnderEmit(noNull({
    xLgr: issuer.street, nro: issuer.number,
    xCpl: issuer.complement,
    xBairro: issuer.neighborhood,
    cMun: parseInt(issuer.cityCode || '2507507', 10),
    xMun: issuer.city, UF: issuer.state,
    CEP: (issuer.zip || '').replace(/\D/g, ''),
    cPais: 1058, xPais: 'BRASIL',
    fone: issuer.phone,
  }));
  const valorTotal = +produto.price.toFixed(2);
  await nfe.tagProd([{
    cProd: produto.sku, cEAN: 'SEM GTIN',
    xProd: PROD ? produto.name.slice(0, 120) : 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL',
    NCM: produto.ncm, CFOP: produto.cfop || '5102',
    uCom: produto.unidade || 'UN', qCom: 1, vUnCom: produto.price, vProd: valorTotal,
    cEANTrib: 'SEM GTIN', uTrib: produto.unidade || 'UN', qTrib: 1, vUnTrib: produto.price, indTot: 1,
  }]);
  const vICMS = +(valorTotal * 0.20).toFixed(2);
  // Alíquotas com 4 casas decimais (formato XSD SEFAZ)
  nfe.tagProdICMS(0, { orig: 0, CST: '00', modBC: 3, vBC: valorTotal.toFixed(2), pICMS: '20.0000', vICMS: vICMS.toFixed(2) });
  nfe.tagProdPIS(0, { CST: '01', vBC: valorTotal.toFixed(2), pPIS: '1.6500', vPIS: (valorTotal * 0.0165).toFixed(2) });
  nfe.tagProdCOFINS(0, { CST: '01', vBC: valorTotal.toFixed(2), pCOFINS: '7.6000', vCOFINS: (valorTotal * 0.076).toFixed(2) });
  // Força total com valores corretos (bypass bug da lib que soma vBC dobrado)
  const vPIS = +(valorTotal * 0.0165).toFixed(2);
  const vCOFINS = +(valorTotal * 0.076).toFixed(2);
  nfe.tagTotal({ ICMSTot: {
    vBC: valorTotal.toFixed(2),
    vICMS: vICMS.toFixed(2),
    vICMSDeson: '0.00',
    vFCPUFDest: '0.00', vICMSUFDest: '0.00', vICMSUFRemet: '0.00',
    vFCP: '0.00', vBCST: '0.00', vST: '0.00',
    vFCPST: '0.00', vFCPSTRet: '0.00',
    vProd: valorTotal.toFixed(2),
    vFrete: '0.00', vSeg: '0.00', vDesc: '0.00',
    vII: '0.00', vIPI: '0.00', vIPIDevol: '0.00',
    vPIS: vPIS.toFixed(2), vCOFINS: vCOFINS.toFixed(2),
    vOutro: '0.00',
    vNF: valorTotal.toFixed(2),
    vTotTrib: '0.00',
  }}, true);
  // transp é obrigatório no XSD NFe 4.00, antes de pag
  nfe.tagTransp({ modFrete: 9 }); // 9=Sem ocorrência de transporte
  nfe.tagDetPag([{ tPag: '01', vPag: valorTotal.toFixed(2) }]);

  let xml = nfe.xml();
  const chaveMatch = xml.match(/Id="NFe(\d{44})"/);
  const chave = chaveMatch ? chaveMatch[1] : null;
  console.log('\n✓ XML montado | Chave:', chave);

  const tmpDir = path.resolve('tmp/nfce');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'nfce-' + nNF + '-raw.xml'), xml);

  console.log('• Assinando...');
  const xmlSigned = await tools.xmlSign(xml);
  fs.writeFileSync(path.join(tmpDir, 'nfce-' + nNF + '-signed.xml'), xmlSigned);
  console.log('  ✓ Assinado');

  // SOAP envelope manual — SEM whitespace entre tags (regra SEFAZ cStat 588)
  const xmlInner = xmlSigned.replace(/^<\?xml[^>]*\?>\s*/, '');
  const soapEnvelope =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap:Body>' +
    '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">' +
    '<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' +
    '<idLote>1</idLote><indSinc>1</indSinc>' +
    xmlInner +
    '</enviNFe></nfeDadosMsg></soap:Body></soap:Envelope>';

  fs.writeFileSync(path.join(tmpDir, 'nfce-' + nNF + '-soap.xml'), soapEnvelope);

  // Envia via https nativo. Node 24 + OpenSSL 3 rejeita PFX RC2 legacy,
  // então pré-extraímos PEM via openssl -legacy uma vez (cache em tmp/cert/).
  const certDir = path.resolve('tmp/cert');
  fs.mkdirSync(certDir, { recursive: true });
  const certPath = path.join(certDir, 'meta-esportes.cert.pem');
  const keyPath = path.join(certDir, 'meta-esportes.key.pem');
  // Sempre regenera (rápido, garante limpeza)
  console.log('• Extraindo PEM do PFX (openssl -legacy)...');
  const { execSync } = await import('node:child_process');
  execSync(`openssl pkcs12 -in "${PFX_PATH}" -clcerts -nokeys -passin pass:${PFX_SENHA} -legacy -out "${certPath}"`);
  execSync(`openssl pkcs12 -in "${PFX_PATH}" -nocerts -nodes -passin pass:${PFX_SENHA} -legacy -out "${keyPath}"`);
  // Limpa Bag Attributes — mantém só o bloco PEM
  const cleanPem = (file, beginMarker) => {
    const raw = fs.readFileSync(file, 'utf8');
    const start = raw.indexOf('-----BEGIN ' + beginMarker);
    const end = raw.indexOf('-----END ' + beginMarker);
    if (start < 0 || end < 0) throw new Error('PEM ' + beginMarker + ' não encontrado em ' + file);
    const endLine = raw.indexOf('\n', end);
    const cleaned = raw.slice(start, endLine > 0 ? endLine : undefined).trim() + '\n';
    fs.writeFileSync(file, cleaned);
    return cleaned;
  };
  const cert = cleanPem(certPath, 'CERTIFICATE');
  const key = cleanPem(keyPath, 'PRIVATE KEY');
  console.log('  ✓ PEM limpo (cert', cert.length, 'b | key', key.length, 'b)');

  console.log('• Enviando pra SEFAZ (https nativo com PEM)...');
  const url = new URL(SVRS_URL);

  const resp = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      cert,
      key,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(soapEnvelope, 'utf8'),
      },
      timeout: 30000,
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(soapEnvelope);
    req.end();
  });

  fs.writeFileSync(path.join(tmpDir, 'nfce-' + nNF + '-response.xml'), resp.body);
  console.log('\n📡 HTTP', resp.status);
  console.log('Resposta SEFAZ:\n' + resp.body.slice(0, 2500));

  // Status SEFAZ
  const cStatM = resp.body.match(/<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>/);
  if (cStatM) {
    const [, cStat, xMotivo] = cStatM;
    console.log('\n📋 cStat:', cStat, '|', xMotivo);
    if (cStat === '100' || cStat === '104') {
      console.log('🎉 NFCe AUTORIZADA!');
      const prot = resp.body.match(/<nProt>(\d+)<\/nProt>/);
      if (prot) console.log('   Protocolo:', prot[1]);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\nERRO:', err?.message || err);
  console.error('Stack:', err?.stack || '(string)');
  await prisma.$disconnect();
  process.exit(1);
});
