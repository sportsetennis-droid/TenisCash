// =====================================================================
// fiscalSefazDirect.mjs — emissão NFCe direta na SEFAZ-PB (via SVRS)
// =====================================================================
// Wrapper modular do flow que valida o que funcionou no script:
//   1) Monta XML via node-sped-nfe.Make
//   2) Assina com certificado A1
//   3) Envia SOAP via https nativo (com PEM extraído por openssl -legacy
//      pra contornar bug Node 24 + OpenSSL 3 com PFX RC2)
//   4) Retorna { ok, accessKey, protocol, status, raw, xmlSigned }
// =====================================================================

import { Make, Tools } from 'node-sped-nfe';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { buildDetPag } from './fiscalAcquirers.js';

const SVRS_URLS = {
  homologation: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
  production:   'https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
};

// Cache PEM por CNPJ pra não reextrair toda emissão
const _pemCache = new Map();

function extractPem(pfxPath, senha, cnpj) {
  if (_pemCache.has(cnpj)) return _pemCache.get(cnpj);
  const dir = path.resolve('tmp/cert');
  fs.mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, cnpj + '.cert.pem');
  const keyFile  = path.join(dir, cnpj + '.key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    execSync(`openssl pkcs12 -in "${pfxPath}" -clcerts -nokeys -passin pass:${senha} -legacy -out "${certFile}"`);
    execSync(`openssl pkcs12 -in "${pfxPath}" -nocerts -nodes -passin pass:${senha} -legacy -out "${keyFile}"`);
  }
  const clean = (file, marker) => {
    const raw = fs.readFileSync(file, 'utf8');
    const start = raw.indexOf('-----BEGIN ' + marker);
    const end   = raw.indexOf('-----END ' + marker);
    if (start < 0 || end < 0) throw new Error('PEM ' + marker + ' inválido');
    const endLine = raw.indexOf('\n', end);
    const cleaned = raw.slice(start, endLine > 0 ? endLine : undefined).trim() + '\n';
    fs.writeFileSync(file, cleaned);
    return cleaned;
  };
  const pem = { cert: clean(certFile, 'CERTIFICATE'), key: clean(keyFile, 'PRIVATE KEY') };
  _pemCache.set(cnpj, pem);
  return pem;
}

/**
 * emitNFCe — emite NFCe contra SEFAZ-PB usando o flow direto.
 *
 * @param {Object} args
 * @param {Object} args.issuer — FiscalIssuer completo (com csc, cscId, etc)
 * @param {string} args.pfxPath — caminho do PFX no servidor
 * @param {string} args.pfxSenha — senha do PFX
 * @param {Array}  args.items — [{ name, sku, ncm, cfop, unidade, qty, unitPrice }]
 * @param {Object} args.payment — { tPag, valor, acquirerKey?, tBand?, cAut?, tpIntegra? }
 * @param {Object} [args.customer] — { cpf, name } opcional
 * @param {number} [args.nNF] — número da NF (default: issuer.nfceNextNumber)
 * @returns {Promise<{ok, accessKey, protocol, status, motivo, xmlSigned, rawResponse}>}
 */
export async function emitNFCe({ issuer, pfxPath, pfxSenha, items, payment, customer, nNF }) {
  const tpAmb = issuer.environment === 'production' ? 1 : 2;
  nNF = nNF || issuer.nfceNextNumber || 1;
  const serie = issuer.nfceSerie || 1;

  // Validações básicas
  if (!issuer.csc) throw new Error('Issuer sem CSC');
  if (!items?.length) throw new Error('Sem itens');
  if (!payment) throw new Error('Sem pagamento');

  const tools = new Tools({
    mod: 65, tpAmb, UF: 'PB', versao: '4.00',
    CSC: issuer.csc, CSCid: issuer.cscId,
    timeout: 30000, CNPJ: issuer.cnpj,
  }, { pfx: pfxPath, senha: pfxSenha });

  const nfe = new Make();
  const cNF = String(Math.floor(Math.random() * 99999999)).padStart(8, '0');
  const dhEmi = (() => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
    return d.toISOString().replace(/\.\d+Z$/, '-03:00');
  })();

  nfe.tagInfNFe({ versao: '4.00', Id: null, pk_nItem: null });
  nfe.tagIde({
    cUF: 25, cNF, natOp: 'VENDA AO CONSUMIDOR',
    mod: 65, serie, nNF, dhEmi,
    tpNF: 1, idDest: 1,
    cMunFG: parseInt(issuer.cityCode || '2507507', 10),
    tpImp: 4, tpEmis: 1, cDV: null, tpAmb,
    finNFe: 1, indFinal: 1, indPres: 1, procEmi: 0, verProc: 'TenisCash/1.0',
  });
  nfe.tagEmit({
    CNPJ: issuer.cnpj, xNome: issuer.companyName,
    xFant: issuer.fantasyName || issuer.companyName,
    IE: issuer.ie, CRT: issuer.crt || 3,
  });
  const noNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''));
  nfe.tagEnderEmit(noNull({
    xLgr: issuer.street, nro: issuer.number, xCpl: issuer.complement,
    xBairro: issuer.neighborhood,
    cMun: parseInt(issuer.cityCode || '2507507', 10),
    xMun: issuer.city, UF: issuer.state,
    CEP: (issuer.zip || '').replace(/\D/g, ''),
    cPais: 1058, xPais: 'BRASIL', fone: issuer.phone,
  }));

  // Items
  let totalProd = 0, totalICMS = 0, totalPIS = 0, totalCOFINS = 0;
  const prodArr = items.map((it, idx) => {
    const qty = Number(it.qty) || 1;
    const vUnit = Number(it.unitPrice) || 0;
    const vTot = +(qty * vUnit).toFixed(2);
    totalProd += vTot;
    return {
      cProd: it.sku || it.id || ('PROD' + (idx + 1)),
      cEAN: 'SEM GTIN',
      xProd: tpAmb === 2 && idx === 0
        ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
        : (it.name || 'Produto').slice(0, 120),
      NCM: it.ncm || '64041100',
      CFOP: parseInt(it.cfop || '5102', 10),
      uCom: it.unidade || 'UN',
      qCom: qty,
      vUnCom: vUnit,
      vProd: vTot,
      cEANTrib: 'SEM GTIN',
      uTrib: it.unidade || 'UN',
      qTrib: qty,
      vUnTrib: vUnit,
      indTot: 1,
    };
  });
  await nfe.tagProd(prodArr);

  // Tributação por item (Regime Normal CRT=3 — Meta Esportes)
  items.forEach((it, idx) => {
    const qty = Number(it.qty) || 1;
    const vTot = +(qty * (Number(it.unitPrice) || 0)).toFixed(2);
    const vICMS = +(vTot * 0.20).toFixed(2);
    const vPIS = +(vTot * 0.0165).toFixed(2);
    const vCOFINS = +(vTot * 0.076).toFixed(2);
    totalICMS += vICMS; totalPIS += vPIS; totalCOFINS += vCOFINS;
    nfe.tagProdICMS(idx, { orig: 0, CST: '00', modBC: 3, vBC: vTot.toFixed(2), pICMS: '20.0000', vICMS: vICMS.toFixed(2) });
    nfe.tagProdPIS(idx, { CST: '01', vBC: vTot.toFixed(2), pPIS: '1.6500', vPIS: vPIS.toFixed(2) });
    nfe.tagProdCOFINS(idx, { CST: '01', vBC: vTot.toFixed(2), pCOFINS: '7.6000', vCOFINS: vCOFINS.toFixed(2) });
  });

  nfe.tagTotal({ ICMSTot: {
    vBC: totalProd.toFixed(2), vICMS: totalICMS.toFixed(2),
    vICMSDeson: '0.00', vFCPUFDest: '0.00', vICMSUFDest: '0.00', vICMSUFRemet: '0.00',
    vFCP: '0.00', vBCST: '0.00', vST: '0.00', vFCPST: '0.00', vFCPSTRet: '0.00',
    vProd: totalProd.toFixed(2),
    vFrete: '0.00', vSeg: '0.00', vDesc: '0.00',
    vII: '0.00', vIPI: '0.00', vIPIDevol: '0.00',
    vPIS: totalPIS.toFixed(2), vCOFINS: totalCOFINS.toFixed(2),
    vOutro: '0.00', vNF: totalProd.toFixed(2), vTotTrib: '0.00',
  }}, true);

  nfe.tagTransp({ modFrete: 9 });

  // Pagamento — usa buildDetPag pro cartão
  const detPagObj = buildDetPag({
    valor: payment.valor || totalProd,
    tPag: payment.tPag || '01',
    acquirerKey: payment.acquirerKey,
    tBand: payment.tBand,
    cAut: payment.cAut,
    tpIntegra: payment.tpIntegra || 2,
  });
  nfe.tagDetPag([detPagObj]);

  // XML
  let xml = nfe.xml();
  const chaveMatch = xml.match(/Id="NFe(\d{44})"/);
  const accessKey = chaveMatch ? chaveMatch[1] : null;

  // Assina
  const xmlSigned = await tools.xmlSign(xml);

  // SOAP envelope minificado
  const xmlInner = xmlSigned.replace(/^<\?xml[^>]*\?>\s*/, '');
  const soap =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap:Body>' +
    '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">' +
    '<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' +
    '<idLote>1</idLote><indSinc>1</indSinc>' +
    xmlInner +
    '</enviNFe></nfeDadosMsg></soap:Body></soap:Envelope>';

  // PEM extraído
  const pem = extractPem(pfxPath, pfxSenha, issuer.cnpj);

  const url = new URL(SVRS_URLS[issuer.environment === 'production' ? 'production' : 'homologation']);
  const resp = await new Promise((res, rej) => {
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      cert: pem.cert, key: pem.key,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(soap, 'utf8'),
      },
      rejectUnauthorized: false, timeout: 30000,
    }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('Timeout SEFAZ')); });
    req.write(soap); req.end();
  });

  // Parsea cStat lote + cStat protNFe
  const loteMatch = resp.body.match(/<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>/);
  const protMatch = resp.body.match(/<infProt>[\s\S]*?<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>[\s\S]*?(?:<nProt>(\d+)<\/nProt>)?[\s\S]*?<\/infProt>/);

  const loteStat = loteMatch?.[1];
  const protStat = protMatch?.[1] || loteStat;
  const motivo = protMatch?.[2] || loteMatch?.[2];
  const protocol = protMatch?.[3] || null;
  const ok = protStat === '100' || protStat === '150';

  return { ok, accessKey, protocol, status: protStat, motivo, xmlSigned, rawResponse: resp.body };
}
