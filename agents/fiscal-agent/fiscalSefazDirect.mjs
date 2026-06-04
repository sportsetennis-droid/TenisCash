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
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import forge from 'node-forge';
import pem from 'pem';
import { buildDetPag } from './fiscalAcquirers.js';

const SVRS_URLS = {
  homologation: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
  production:   'https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
};

// NFe modelo 55 — SEFAZ-PB autoriza diretamente (não via SVRS)
const NFE_PB_URLS = {
  homologation: 'https://nfehom.sefaz.pb.gov.br/nfews/v2/services/NFeAutorizacao4',
  production:   'https://nfe.sefaz.pb.gov.br/nfews/v2/services/NFeAutorizacao4',
};

// URLs de Recepção de Evento (cancelamento, carta de correção)
const EVENT_URLS = {
  // NFCe modelo 65 — SVRS
  nfce_homologation: 'https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
  nfce_production:   'https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
  // NFe modelo 55 — SEFAZ-PB
  nfe_homologation: 'https://nfehom.sefaz.pb.gov.br/nfews/v2/services/RecepcaoEvento4',
  nfe_production:   'https://nfe.sefaz.pb.gov.br/nfews/v2/services/RecepcaoEvento4',
};

// Cache PEM por CNPJ pra não reextrair toda emissão
const _pemCache = new Map();

// Extrai { cert, key } em PEM de um PFX usando node-forge — SEM openssl no PATH.
// node-forge lida com PKCS12 legado (RC2/3DES) que o OpenSSL 3 do Node bloqueia.
function _forgePfxToPem(pfxInput, senha) {
  const der = Buffer.isBuffer(pfxInput) ? pfxInput.toString('latin1') : fs.readFileSync(pfxInput, 'latin1');
  const p12Asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha || '');
  // Chave privada
  let keyBags = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]) || [];
  if (!keyBags.length) keyBags = (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]) || [];
  const privKey = keyBags[0] && keyBags[0].key;
  // Certificado FOLHA = o que casa com a chave. PFX ICP-Brasil traz a cadeia de
  // CAs junto (Raiz, SERPRO, etc); pegar certBags[0] cego pode pegar uma CA, e aí
  // o cert nao casa com a chave -> TLS client-auth falha -> a SVRS reseta a conexao.
  const certBags = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]) || [];
  let leaf = null;
  if (privKey && privKey.n) {
    leaf = certBags.find((cb) => cb.cert && cb.cert.publicKey && cb.cert.publicKey.n && cb.cert.publicKey.n.equals(privKey.n));
  }
  const leafCert = (leaf && leaf.cert) || (certBags[0] && certBags[0].cert);
  const certPem = leafCert ? forge.pki.certificateToPem(leafCert) : null;
  const keyPem = privKey ? forge.pki.privateKeyToPem(privKey) : null;
  if (!certPem || !keyPem) throw new Error('Falha ao extrair cert/key do PFX via node-forge');
  return { cert: certPem, key: keyPem };
}

// ---------------------------------------------------------------------
// PATCH CRÍTICO: node-sped-nfe (tools.xmlSign) carrega o certificado via o
// pacote `pem`, que chama o binário openssl do sistema por child_process.
// A loja NÃO tem openssl no PATH -> pem.readPkcs12 trava (o callback nunca
// retorna) e congela o agente single-thread. Interceptamos readPkcs12 pra
// extrair cert/key com node-forge (puro JS). Mantém toda a assinatura/QR
// Code da lib intactos; só troca a parte que dependia de openssl.
// ---------------------------------------------------------------------
if (pem && typeof pem.readPkcs12 === 'function' && !pem.__forgePatched) {
  pem.__forgePatched = true;
  pem.readPkcs12 = function (pfxInput, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : (options || {});
    try {
      const senha = opts.p12Password || opts.password || '';
      const { cert, key } = _forgePfxToPem(pfxInput, senha);
      // node-sped-nfe espera { key, cert, pem } (publicCert = .pem)
      process.nextTick(() => cb(null, { key, cert, pem: cert, ca: [] }));
    } catch (e) {
      process.nextTick(() => cb(e));
    }
  };
}

function extractPem(pfxPath, senha, cnpj) {
  if (_pemCache.has(cnpj)) return _pemCache.get(cnpj);
  const out = _forgePfxToPem(pfxPath, senha);
  _pemCache.set(cnpj, out);
  return out;
}

function _delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// POST SOAP pra SEFAZ/SVRS com TLS 1.2 + renegociacao legada + RETRY.
// Por que retry: a 1a conexao "fria" com a SVRS as vezes cai (ECONNRESET na
// renegociacao TLS que ela usa pra pedir o cert do cliente). A retentativa
// reaproveita a sessao TLS ja cacheada no processo e passa. SEFAZ tambem e
// instavel por natureza, entao retry e padrao de mercado.
// Seguranca: reenviar a MESMA chave de acesso -> a SEFAZ detecta duplicidade
// (cStat 539) e devolve a autorizacao existente; NAO duplica a nota. Alem disso
// o reset aqui acontece no estabelecimento da conexao (antes da SEFAZ processar
// o lote), entao reenviar e seguro.
function _sefazPost(url, soap, pem, attempts = 4) {
  const once = () => new Promise((res, rej) => {
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      cert: pem.cert, key: pem.key,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(soap, 'utf8'),
      },
      rejectUnauthorized: false, timeout: 30000,
      minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', // SVRS reseta TLS 1.3
      secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
        | crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION, // SVRS renegocia p/ pedir cert
    }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('Timeout SEFAZ')); });
    req.write(soap); req.end();
  });
  return (async () => {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await once();
        if (r.status >= 500 && i < attempts - 1) { lastErr = new Error('HTTP ' + r.status); await _delay(400 * (i + 1)); continue; }
        return r;
      } catch (e) {
        lastErr = e;
        const code = e.code || '';
        const retryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN'].includes(code)
          || /socket hang up|reset|timeout|renegotiat/i.test(e.message || '');
        if (!retryable || i === attempts - 1) throw e;
        await _delay(400 * (i + 1));
      }
    }
    throw lastErr;
  })();
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
  const resp = await _sefazPost(url, soap, pem);

  // Parsea cStat lote + cStat protNFe
  const loteMatch = resp.body.match(/<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>/);
  const protMatch = resp.body.match(/<infProt>[\s\S]*?<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>[\s\S]*?(?:<nProt>(\d+)<\/nProt>)?[\s\S]*?<\/infProt>/);

  const loteStat = loteMatch?.[1];
  const protStat = protMatch?.[1] || loteStat;
  const motivo = protMatch?.[2] || loteMatch?.[2];
  const protocol = (resp.body.match(/<nProt>(\d+)<\/nProt>/) || [])[1] || protMatch?.[3] || null;
  const ok = protStat === '100' || protStat === '150';

  return { ok, accessKey, protocol, status: protStat, motivo, xmlSigned, rawResponse: resp.body };
}

/**
 * consultarNFe — consulta a situação de uma NFCe/NFe na SEFAZ pela chave.
 * Retorna o protocolo de autorização (nProt), necessário pra cancelar.
 * consSitNFe NÃO precisa de assinatura (só TLS com o certificado).
 */
export async function consultarNFe({ issuer, pfxPath, pfxSenha, accessKey }) {
  if (!accessKey || accessKey.length !== 44) throw new Error('Chave deve ter 44 dígitos');
  const mod = parseInt(accessKey.slice(20, 22), 10);
  const tpAmb = issuer.environment === 'production' ? 1 : 2;
  const soap =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap:Body>' +
    '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">' +
    '<consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' +
    '<tpAmb>' + tpAmb + '</tpAmb><xServ>CONSULTAR</xServ><chNFe>' + accessKey + '</chNFe>' +
    '</consSitNFe></nfeDadosMsg></soap:Body></soap:Envelope>';
  const pem = extractPem(pfxPath, pfxSenha, issuer.cnpj);
  const CONSULTA_URLS = {
    nfce_production: 'https://nfce.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    nfce_homologation: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    nfe_production: 'https://nfe.sefaz.pb.gov.br/nfews/v2/services/NFeConsultaProtocolo4',
    nfe_homologation: 'https://nfehom.sefaz.pb.gov.br/nfews/v2/services/NFeConsultaProtocolo4',
  };
  const urlKey = (mod === 65 ? 'nfce_' : 'nfe_') + (tpAmb === 1 ? 'production' : 'homologation');
  const url = new URL(CONSULTA_URLS[urlKey]);
  const resp = await _sefazPost(url, soap, pem);
  const cStat = (resp.body.match(/<cStat>(\d+)<\/cStat>/) || [])[1] || null;
  const motivo = (resp.body.match(/<xMotivo>([^<]+)<\/xMotivo>/) || [])[1] || null;
  const protocol = (resp.body.match(/<nProt>(\d+)<\/nProt>/) || [])[1] || null;
  // cStat 100 = autorizada (cancelável); 101/151/135 = já cancelada; 110/301/302 = denegada
  return { ok: cStat === '100', status: cStat, motivo, protocol, accessKey, rawResponse: resp.body };
}

/**
 * cancelDocument — cancela NFCe (modelo 65) ou NFe (modelo 55) na SEFAZ.
 * Detecta automaticamente o modelo pela chave de acesso (chars 20-21).
 * Roteia pra SVRS (65) ou SEFAZ-PB direto (55).
 *
 * @param {Object} args
 * @param {Object} args.issuer — FiscalIssuer (precisa environment)
 * @param {string} args.pfxPath / args.pfxSenha
 * @param {string} args.accessKey — chave 44 dígitos
 * @param {string} args.protocol — protocolo de autorização original
 * @param {string} args.reason — justificativa (mín 15, máx 255 chars)
 * @param {number} [args.nSeqEvento=1]
 */
export async function cancelDocument({ issuer, pfxPath, pfxSenha, accessKey, protocol, reason, nSeqEvento }) {
  if (!accessKey || accessKey.length !== 44) throw new Error('Chave de acesso deve ter 44 dígitos');
  if (!protocol) throw new Error('Protocolo de autorização obrigatório');
  if (!reason || reason.length < 15) throw new Error('Motivo precisa ter no mínimo 15 caracteres');
  if (reason.length > 255) reason = reason.slice(0, 255);

  // Modelo está nos chars 20-21 da chave (mod=55 ou 65)
  const mod = parseInt(accessKey.slice(20, 22), 10);
  if (mod !== 55 && mod !== 65) throw new Error('Modelo inválido na chave: ' + mod);

  const cnpj = accessKey.slice(6, 20);
  const tpAmb = issuer.environment === 'production' ? 1 : 2;
  const seq = nSeqEvento || 1;

  // CSC só é necessário pra NFCe; pra NFe modelo 55 não usa
  const toolsCfg = { mod, tpAmb, UF: 'PB', versao: '4.00', timeout: 30000, CNPJ: cnpj };
  if (mod === 65) {
    if (!issuer.csc) throw new Error('Issuer sem CSC (necessário pra NFCe)');
    toolsCfg.CSC = issuer.csc;
    toolsCfg.CSCid = issuer.cscId;
  }
  const tools = new Tools(toolsCfg, { pfx: pfxPath, senha: pfxSenha });

  const cOrgao = '25'; // PB
  const dhEvento = (() => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
    return d.toISOString().replace(/\.\d+Z$/, '-03:00');
  })();
  const idEvento = 'ID110111' + accessKey + String(seq).padStart(2, '0');

  const envEventoObj = {
    envEvento: {
      '@xmlns': 'http://www.portalfiscal.inf.br/nfe',
      '@versao': '1.00',
      idLote: '1',
      evento: {
        '@xmlns': 'http://www.portalfiscal.inf.br/nfe',
        '@versao': '1.00',
        infEvento: {
          '@Id': idEvento,
          cOrgao, tpAmb, CNPJ: cnpj, chNFe: accessKey,
          dhEvento, tpEvento: '110111', nSeqEvento: seq,
          verEvento: '1.00',
          detEvento: {
            '@versao': '1.00',
            descEvento: 'Cancelamento',
            nProt: protocol,
            xJust: reason,
          },
        },
      },
    },
  };

  const xmlEvento = await tools.json2xml(envEventoObj);
  const xmlSigned = await tools.xmlSign(xmlEvento, { tag: 'infEvento' });
  const inner = xmlSigned.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
  const soap =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap:Body>' +
    '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">' +
    inner +
    '</nfeDadosMsg></soap:Body></soap:Envelope>';

  const pem = extractPem(pfxPath, pfxSenha, cnpj);

  // Roteia URL por modelo + ambiente
  const urlKey = (mod === 65 ? 'nfce_' : 'nfe_') + (tpAmb === 1 ? 'production' : 'homologation');
  const url = new URL(EVENT_URLS[urlKey]);
  const resp = await _sefazPost(url, soap, pem);

  // Parsea retorno do evento
  const retMatch = resp.body.match(/<retEvento[\s\S]*?<infEvento>[\s\S]*?<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>[\s\S]*?(?:<nProt>(\d+)<\/nProt>)?/);
  const loteMatch = resp.body.match(/<retEnvEvento[\s\S]*?<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>/);
  const cStat = retMatch?.[1] || loteMatch?.[1];
  const motivo = retMatch?.[2] || loteMatch?.[2];
  const cancelProtocol = retMatch?.[3] || null;
  // 135 = evento registrado e vinculado, 136 = vinculação não encontrada (mas registrado),
  // 155 = cancelamento homologado fora do prazo
  const ok = cStat === '135' || cStat === '136' || cStat === '155';

  return { ok, cancelProtocol, status: cStat, motivo, xmlSigned, rawResponse: resp.body };
}

/**
 * sendCorrectionLetter — envia Carta de Correção Eletrônica (CCe).
 * Permite corrigir dados não-monetários da NFe (endereço, descrição de
 * produto, natureza da operação, etc) até 30 dias após emissão.
 *
 * Limites SEFAZ (NÃO pode usar pra corrigir):
 *  - Valores (vProd, vNF, base cálculo, alíquotas)
 *  - CNPJ/CPF do emitente/destinatário
 *  - Data, série, número
 *  - CFOP (porque muda tributação)
 *
 * @param {Object} args
 * @param {Object} args.issuer — FiscalIssuer (environment, csc se NFCe)
 * @param {string} args.pfxPath / args.pfxSenha
 * @param {string} args.accessKey — chave 44 dígitos
 * @param {string} args.correction — texto da correção (15-1000 chars)
 * @param {number} [args.nSeqEvento=1] — sequencial (máx 20 CCe por NFe)
 */
export async function sendCorrectionLetter({ issuer, pfxPath, pfxSenha, accessKey, correction, nSeqEvento }) {
  if (!accessKey || accessKey.length !== 44) throw new Error('Chave deve ter 44 dígitos');
  if (!correction || correction.length < 15) throw new Error('Correção precisa ter no mínimo 15 caracteres');
  if (correction.length > 1000) correction = correction.slice(0, 1000);

  const mod = parseInt(accessKey.slice(20, 22), 10);
  if (mod !== 55 && mod !== 65) throw new Error('Modelo inválido na chave: ' + mod);
  if (mod === 65) throw new Error('CCe não permitida pra NFCe (modelo 65) — apenas NFe');

  const cnpj = accessKey.slice(6, 20);
  const tpAmb = issuer.environment === 'production' ? 1 : 2;
  const seq = nSeqEvento || 1;
  if (seq > 20) throw new Error('Máximo 20 CCe por NFe (sequencial atual: ' + seq + ')');

  const tools = new Tools({
    mod: 55, tpAmb, UF: 'PB', versao: '4.00',
    timeout: 30000, CNPJ: cnpj,
  }, { pfx: pfxPath, senha: pfxSenha });

  const cOrgao = '25';
  const dhEvento = (() => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
    return d.toISOString().replace(/\.\d+Z$/, '-03:00');
  })();
  const idEvento = 'ID110110' + accessKey + String(seq).padStart(2, '0');

  const envEventoObj = {
    envEvento: {
      '@xmlns': 'http://www.portalfiscal.inf.br/nfe',
      '@versao': '1.00',
      idLote: '1',
      evento: {
        '@xmlns': 'http://www.portalfiscal.inf.br/nfe',
        '@versao': '1.00',
        infEvento: {
          '@Id': idEvento,
          cOrgao, tpAmb, CNPJ: cnpj, chNFe: accessKey,
          dhEvento, tpEvento: '110110', nSeqEvento: seq,
          verEvento: '1.00',
          detEvento: {
            '@versao': '1.00',
            descEvento: 'Carta de Correcao',
            xCorrecao: correction,
            xCondUso: 'A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.',
          },
        },
      },
    },
  };

  const xmlEvento = await tools.json2xml(envEventoObj);
  const xmlSigned = await tools.xmlSign(xmlEvento, { tag: 'infEvento' });
  const inner = xmlSigned.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
  const soap =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap:Body>' +
    '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">' +
    inner +
    '</nfeDadosMsg></soap:Body></soap:Envelope>';

  const pem = extractPem(pfxPath, pfxSenha, cnpj);
  const urlKey = 'nfe_' + (tpAmb === 1 ? 'production' : 'homologation');
  const url = new URL(EVENT_URLS[urlKey]);
  const resp = await _sefazPost(url, soap, pem);

  const retMatch = resp.body.match(/<retEvento[\s\S]*?<infEvento>[\s\S]*?<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>[\s\S]*?(?:<nProt>(\d+)<\/nProt>)?/);
  const loteMatch = resp.body.match(/<retEnvEvento[\s\S]*?<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>/);
  const cStat = retMatch?.[1] || loteMatch?.[1];
  const motivo = retMatch?.[2] || loteMatch?.[2];
  const correctionProtocol = retMatch?.[3] || null;
  const ok = cStat === '135' || cStat === '136';

  return { ok, correctionProtocol, status: cStat, motivo, nSeqEvento: seq, xmlSigned, rawResponse: resp.body };
}

/**
 * emitNFe55 — emite NFe modelo 55 (B2C/B2B com destinatário identificado)
 * direto na SEFAZ-PB. Útil pra vendas Nuvemshop, escolas, clubes.
 *
 * Diferenças vs NFCe (modelo 65):
 * - mod=55, sem CSC/QR Code
 * - Exige tagDest com CPF/CNPJ + endereço completo
 * - URL é SEFAZ-PB direto (não SVRS)
 * - tpImp=1 (retrato A4), indPres=2 (operação não-presencial pela internet)
 *
 * @param {Object} args
 * @param {Object} args.issuer — FiscalIssuer completo
 * @param {string} args.pfxPath / args.pfxSenha
 * @param {Array}  args.items
 * @param {Object} args.payment — { tPag, valor, acquirerKey?, tBand?, cAut?, tpIntegra? }
 * @param {Object} args.customer — { tipo:'F'|'J', cpfCnpj, name, email?, addr?:{xLgr,nro,xBairro,cMun,xMun,UF,CEP}, ie?, indIEDest? }
 * @param {number} [args.nNF]
 * @param {string} [args.natOp] — natureza da operação (default: 'VENDA DE MERCADORIA')
 */
export async function emitNFe55({ issuer, pfxPath, pfxSenha, items, payment, customer, nNF, natOp }) {
  const tpAmb = issuer.environment === 'production' ? 1 : 2;
  nNF = nNF || issuer.nfeNextNumber || 1;
  const serie = issuer.nfeSerie || 1;

  if (!items?.length) throw new Error('Sem itens');
  if (!payment) throw new Error('Sem pagamento');
  if (!customer || !customer.cpfCnpj) throw new Error('NFe 55 exige destinatário com CPF/CNPJ');

  const tools = new Tools({
    mod: 55, tpAmb, UF: 'PB', versao: '4.00',
    timeout: 30000, CNPJ: issuer.cnpj,
  }, { pfx: pfxPath, senha: pfxSenha });

  const nfe = new Make();
  const cNF = String(Math.floor(Math.random() * 99999999)).padStart(8, '0');
  const dhEmi = (() => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
    return d.toISOString().replace(/\.\d+Z$/, '-03:00');
  })();

  // Destinatário UF — afeta CFOP (5102 dentro estado, 6102 fora)
  const destUF = (customer.addr?.UF || 'PB').toUpperCase();
  const isInterstate = destUF !== 'PB';
  const defaultCFOP = isInterstate ? '6102' : '5102';

  nfe.tagInfNFe({ versao: '4.00', Id: null, pk_nItem: null });
  nfe.tagIde({
    cUF: 25, cNF, natOp: natOp || 'VENDA DE MERCADORIA',
    mod: 55, serie, nNF, dhEmi,
    tpNF: 1,
    idDest: isInterstate ? 2 : 1, // 1=mesma UF, 2=interestadual
    cMunFG: parseInt(issuer.cityCode || '2507507', 10),
    tpImp: 1, // 1=retrato A4
    tpEmis: 1, cDV: null, tpAmb,
    finNFe: 1, indFinal: 1,
    indPres: customer.indPres || 2, // 2=operação não-presencial pela internet (Nuvemshop)
    procEmi: 0, verProc: 'TenisCash/1.0',
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

  // DESTINATÁRIO (obrigatório em mod 55)
  const cpfCnpjClean = String(customer.cpfCnpj).replace(/\D/g, '');
  const isCNPJ = cpfCnpjClean.length === 14;
  const destTag = noNull({
    [isCNPJ ? 'CNPJ' : 'CPF']: cpfCnpjClean,
    xNome: tpAmb === 2 ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
                       : (customer.name || (isCNPJ ? 'CONSUMIDOR FINAL' : 'CONSUMIDOR FINAL')).slice(0, 60),
    // 1=ICMS contribuinte, 2=isento, 9=não contribuinte
    indIEDest: customer.indIEDest || (isCNPJ && customer.ie ? '1' : '9'),
    IE: isCNPJ && customer.ie ? String(customer.ie).replace(/\D/g, '') : null,
    email: customer.email || null,
  });
  nfe.tagDest(destTag);

  // Endereço do destinatário
  if (customer.addr) {
    nfe.tagEnderDest(noNull({
      xLgr: customer.addr.xLgr || customer.addr.street,
      nro: customer.addr.nro || customer.addr.number || 'S/N',
      xCpl: customer.addr.xCpl || customer.addr.complement,
      xBairro: customer.addr.xBairro || customer.addr.neighborhood || 'CENTRO',
      cMun: parseInt(customer.addr.cMun || customer.addr.cityCode || '2507507', 10),
      xMun: customer.addr.xMun || customer.addr.city,
      UF: destUF,
      CEP: String(customer.addr.CEP || customer.addr.zip || '').replace(/\D/g, ''),
      cPais: 1058, xPais: 'BRASIL',
      fone: customer.addr.fone || customer.phone,
    }));
  }

  // Itens — totaliza
  let totalProd = 0, totalICMS = 0, totalPIS = 0, totalCOFINS = 0;
  const prodArr = items.map((it, idx) => {
    const qty = Number(it.qty) || 1;
    const vUnit = Number(it.unitPrice) || 0;
    const vTot = +(qty * vUnit).toFixed(2);
    totalProd += vTot;
    return {
      cProd: it.sku || it.id || ('PROD' + (idx + 1)),
      cEAN: it.ean || 'SEM GTIN',
      xProd: tpAmb === 2 && idx === 0
        ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'
        : (it.name || 'Produto').slice(0, 120),
      NCM: it.ncm || '64041100',
      CFOP: parseInt(it.cfop || defaultCFOP, 10),
      uCom: it.unidade || 'UN',
      qCom: qty,
      vUnCom: vUnit,
      vProd: vTot,
      cEANTrib: it.ean || 'SEM GTIN',
      uTrib: it.unidade || 'UN',
      qTrib: qty,
      vUnTrib: vUnit,
      indTot: 1,
    };
  });
  await nfe.tagProd(prodArr);

  // Tributação por item (CRT=3 Regime Normal — Meta Esportes)
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

  // Transporte — frete por conta do destinatário/terceiro (modFrete=9 = sem ocorrência)
  // Em e-commerce Nuvemshop, modFrete=2 (por conta destinatário) é mais correto
  nfe.tagTransp({ modFrete: payment.modFrete != null ? payment.modFrete : 2 });

  // Pagamento — pode ser dinheiro/pix/cartão (mesmo helper)
  const detPagObj = buildDetPag({
    valor: payment.valor || totalProd,
    tPag: payment.tPag || '01',
    acquirerKey: payment.acquirerKey,
    tBand: payment.tBand,
    cAut: payment.cAut,
    tpIntegra: payment.tpIntegra,
  });
  nfe.tagDetPag([detPagObj]);

  // Pedido / referência opcional
  if (payment.xPed || payment.nuvemshopOrderId) {
    nfe.tagInfAdic({
      infCpl: (payment.xPed ? ('Pedido: ' + payment.xPed + '. ') : '') +
              (payment.nuvemshopOrderId ? ('Nuvemshop ID: ' + payment.nuvemshopOrderId) : ''),
    });
  }

  let xml = nfe.xml();
  const chaveMatch = xml.match(/Id="NFe(\d{44})"/);
  const accessKey = chaveMatch ? chaveMatch[1] : null;

  const xmlSigned = await tools.xmlSign(xml);
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

  const pem = extractPem(pfxPath, pfxSenha, issuer.cnpj);
  const url = new URL(NFE_PB_URLS[issuer.environment === 'production' ? 'production' : 'homologation']);
  const resp = await _sefazPost(url, soap, pem);

  const loteMatch = resp.body.match(/<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>/);
  const protMatch = resp.body.match(/<infProt>[\s\S]*?<cStat>(\d+)<\/cStat>[\s\S]*?<xMotivo>([^<]+)<\/xMotivo>[\s\S]*?(?:<nProt>(\d+)<\/nProt>)?[\s\S]*?<\/infProt>/);

  const loteStat = loteMatch?.[1];
  const protStat = protMatch?.[1] || loteStat;
  const motivo = protMatch?.[2] || loteMatch?.[2];
  const protocol = (resp.body.match(/<nProt>(\d+)<\/nProt>/) || [])[1] || protMatch?.[3] || null;
  const ok = protStat === '100' || protStat === '150';

  return { ok, accessKey, protocol, status: protStat, motivo, xmlSigned, rawResponse: resp.body };
}
