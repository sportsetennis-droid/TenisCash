// Cancela NFCe na SEFAZ-PB (até 24h após autorização).
// Uso: node scripts/fiscal-cancel-nfce.mjs <chave> "<motivo de 15+ chars>"

import { PrismaClient } from '@prisma/client';
import { Make, Tools } from 'node-sped-nfe';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const prisma = new PrismaClient();

const CHAVE = process.argv[2];
const MOTIVO = process.argv[3];
if (!CHAVE || CHAVE.length !== 44) { console.error('Uso: <chave 44 digitos> "<motivo 15+ chars>"'); process.exit(1); }
if (!MOTIVO || MOTIVO.length < 15) { console.error('Motivo precisa ter no mínimo 15 caracteres'); process.exit(1); }

const PFX_PATH = 'C:\\Chianca\\NFe_Emissao001\\Certificado2026.pfx';
const PFX_SENHA = '123456';

(async () => {
  const cnpj = CHAVE.slice(6, 20);
  const issuer = await prisma.fiscalIssuer.findUnique({ where: { cnpj } });
  if (!issuer) throw new Error('Issuer não cadastrado pra CNPJ ' + cnpj);

  const tools = new Tools({
    mod: 65, tpAmb: 1, UF: 'PB', versao: '4.00',
    CSC: issuer.csc, CSCid: issuer.cscId,
    timeout: 30000, CNPJ: cnpj,
  }, { pfx: PFX_PATH, senha: PFX_SENHA });

  // Busca nProt do FiscalDocument
  const doc = await prisma.fiscalDocument.findFirst({ where: { accessKey: CHAVE } });
  if (!doc?.protocol) throw new Error('Protocolo não encontrado no FiscalDocument');

  console.log('Cancelando:', CHAVE);
  console.log('Protocolo original:', doc.protocol);

  // Monta evento de cancelamento
  const cOrgao = '25'; // PB
  const dhEvento = (() => {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
    return d.toISOString().replace(/\.\d+Z$/, '-03:00');
  })();
  const idEvento = 'ID110111' + CHAVE + '01';

  // A lib espera estrutura { envEvento: { evento: { infEvento } } }
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
          cOrgao, tpAmb: 1, CNPJ: cnpj, chNFe: CHAVE,
          dhEvento, tpEvento: '110111', nSeqEvento: 1,
          verEvento: '1.00',
          detEvento: {
            '@versao': '1.00',
            descEvento: 'Cancelamento',
            nProt: doc.protocol,
            xJust: MOTIVO,
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

  // PEM
  const certDir = path.resolve('tmp/cert');
  const cert = fs.readFileSync(path.join(certDir, 'meta-esportes.cert.pem'));
  const key = fs.readFileSync(path.join(certDir, 'meta-esportes.key.pem'));

  const url = new URL('https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx');
  const resp = await new Promise((res, rej) => {
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      cert, key, headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(soap, 'utf8'),
      }, rejectUnauthorized: false, timeout: 30000,
    }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res({ status: r.statusCode, body: d })); });
    req.on('error', rej); req.write(soap); req.end();
  });
  console.log('HTTP', resp.status);
  console.log(resp.body.slice(0, 2000));
  await prisma.$disconnect();
})().catch(async e => { console.error('ERRO:', e.message); await prisma.$disconnect(); process.exit(1); });
