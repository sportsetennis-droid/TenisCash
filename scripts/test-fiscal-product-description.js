'use strict';

// Sem certificado, banco ou emissão: Make real monta o XML; xmlSign é interrompido.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseStringPromise } = require('xml2js');
const { normalizeFiscalProductName } = require('../src/services/fiscalText');
const { buildDetPag } = require('../src/services/fiscalAcquirers');
const agentClient = require('../src/services/fiscalAgentClient');

const root = path.resolve(__dirname, '..');
const rejectedName = 'TENIS NK REVOLUTION 8 FEMININO SU25 - BLACK/WHITE-IRON GREY — HJ8485-001';
const correctedName = 'TENIS NK REVOLUTION 8 FEMININO SU25 - BLACK/WHITE-IRON GREY - HJ8485-001';
const cases = [
  [rejectedName, correctedName],
  ['  Tênis\tAÇÃO\r\nNº\u00a038  ', 'Tênis AÇÃO Nº 38'],
  ['Te\u0302nis Ac\u0327a\u0303o', 'Tênis Ação'],
  ['Camisa “Sports & Tennis” — infantil…', 'Camisa "Sports & Tennis" - infantil...'],
  ['Tênis D’Ávila – Nº 38', "Tênis D'Ávila - Nº 38"],
  ['Sports & Tennis <Infantil>', 'Sports & Tennis <Infantil>'],
  ['👟 Tênis\u200b Nike\u0000 38\u009f', 'Tênis Nike 38'],
  ['A'.repeat(119) + ' B', 'A'.repeat(119)],
  ['A'.repeat(130), 'A'.repeat(120)],
  ['A', 'A'],
];
const invalidNames = [undefined, null, '', ' \t\r\n ', '\u0000👟\u200b', {}];

// Restrições obtidas do XSD distribuído com a mesma biblioteca do emissor.
const schemaDir = path.join(root, 'node_modules/node-sped-nfe/schemas/PL_010b_V1.30');
const basicSchema = fs.readFileSync(path.join(schemaDir, 'tiposBasico_v4.00.xsd'), 'utf8');
const layoutSchema = fs.readFileSync(path.join(schemaDir, 'leiauteNFe_v4.00.xsd'), 'utf8');
const stringDefinition = basicSchema.match(/<xs:simpleType name="TString">([\s\S]*?)<\/xs:simpleType>/)[1];
const pattern = new RegExp('^(?:' + stringDefinition.match(/<xs:pattern value="([^"]+)"/)[1] + ')$', 'u');
const prodDefinition = layoutSchema.match(/<xs:element name="xProd">([\s\S]*?)<\/xs:element>/)[1];
const maxLength = Number(prodDefinition.match(/<xs:maxLength value="(\d+)"/)[1]);
const minLength = Number(prodDefinition.match(/<xs:minLength value="(\d+)"/)[1]);
assert.equal(pattern.test(rejectedName), false, 'Reproduz rejeição do travessão do produto');

function assertXProd(value) {
  assert.equal(pattern.test(value), true, 'xProd precisa obedecer TString do XSD');
  assert.ok(value.length >= minLength && value.length <= maxLength);
}

function loadEmitter(relativeFile, Make) {
  const source = fs.readFileSync(path.join(root, relativeFile), 'utf8')
    .replace(/^import .+;\r?\n/gm, '')
    .replace(/^export async function /gm, 'async function ');
  const beforeSigning = new Error('TEST_STOP_BEFORE_SIGNING');
  let xml = null;
  class Tools {
    async xmlSign(value) { xml = value; throw beforeSigning; }
  }
  const forbidden = () => { throw new Error('Teste tentou acessar certificado ou rede'); };
  const context = {
    Make, Tools, normalizeFiscalProductName, buildDetPag, pem: {}, forge: {},
    fs: new Proxy({}, { get: () => forbidden }), path, https: { request: forbidden },
    execSync: forbidden, process, Buffer, console,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.testExports = { emitNFCe, emitNFe55, normalizeFiscalProductName };', context, { filename: relativeFile });
  return {
    ...context.testExports,
    async unsignedXml(method, payload) {
      xml = null;
      await assert.rejects(context.testExports[method](payload), error => error === beforeSigning);
      assert.ok(xml, 'XML deve estar pronto antes do bloqueio de assinatura');
      return parseStringPromise(xml, { explicitArray: false, trim: false });
    },
  };
}

function payload(name, environment = 'production') {
  return {
    issuer: {
      environment, cnpj: '11111111000191', companyName: 'EMPRESA DE TESTE',
      fantasyName: 'TESTE', ie: '123456789', crt: 3,
      street: 'RUA TESTE', number: '1', neighborhood: 'CENTRO',
      cityCode: '2507507', city: 'JOAO PESSOA', state: 'PB', zip: '58000000',
      csc: 'TEST_ONLY', cscId: '1',
    },
    items: [{ name, sku: 'HJ8485-001', ncm: '64041100', qty: 1, unitPrice: 403.2 }],
    payment: { tPag: '01', valor: 403.2 },
    customer: { cpfCnpj: '11111111111', name: 'CONSUMIDOR DE TESTE' },
    nNF: 1,
  };
}

async function main() {
  for (const [input, expected] of cases) {
    assert.equal(normalizeFiscalProductName(input), expected);
    assertXProd(expected);
    assert.equal(normalizeFiscalProductName(expected), expected, 'Normalização idempotente');
  }
  for (const value of invalidNames) {
    assert.throws(() => normalizeFiscalProductName(value), { code: 'FISCAL_PRODUCT_DESCRIPTION_INVALID' });
  }

  const { Make } = await import('node-sped-nfe');
  for (const file of ['src/services/fiscalSefazDirect.mjs', 'agents/fiscal-agent/fiscalSefazDirect.mjs']) {
    const emitter = loadEmitter(file, Make);
    // Verifica paridade do normalizador embarcado sem criar dependência nova no agente.
    for (const [input, expected] of cases) assert.equal(emitter.normalizeFiscalProductName(input), expected, file);
    for (const value of invalidNames) {
      assert.throws(() => emitter.normalizeFiscalProductName(value), { code: 'FISCAL_PRODUCT_DESCRIPTION_INVALID' });
    }
    for (const method of ['emitNFCe', 'emitNFe55']) {
      for (const [input, expected] of cases) {
        const args = payload(input);
        const before = JSON.stringify(args);
        const result = await emitter.unsignedXml(method, args);
        const { prod } = result.NFe.infNFe.det;
        assert.equal(prod.xProd, expected, file + ' ' + method);
        assertXProd(prod.xProd);
        assert.equal(prod.cProd, 'HJ8485-001');
        assert.equal(prod.qCom, '1.0000');
        assert.equal(prod.vProd, '403.20');
        assert.equal(result.NFe.infNFe.total.ICMSTot.vNF, '403.20');
        assert.equal(JSON.stringify(args), before, 'Dados de origem não podem mudar');
      }
      const result = await emitter.unsignedXml(method, payload(rejectedName, 'homologation'));
      assert.equal(result.NFe.infNFe.det.prod.xProd, 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL');
      const multiple = payload(rejectedName);
      multiple.items.push({ name: 'Camisa — ação', sku: 'CAMISA-TESTE', qty: 2, unitPrice: 13.91 });
      multiple.payment.valor = 431.02;
      const multipleBefore = JSON.stringify(multiple);
      const several = (await emitter.unsignedXml(method, multiple)).NFe.infNFe;
      assert.deepEqual(several.det.map(det => [det.prod.cProd, det.prod.xProd, det.prod.qCom, det.prod.vProd]), [
        ['HJ8485-001', correctedName, '1.0000', '403.20'],
        ['CAMISA-TESTE', 'Camisa - ação', '2.0000', '27.82'],
      ], 'Ordem, quantidade e valor de cada item permanecem iguais');
      assert.equal(several.total.ICMSTot.vNF, '431.02');
      assert.equal(JSON.stringify(multiple), multipleBefore);
      const args = payload(' \n ');
      await assert.rejects(emitter[method](args), { code: 'FISCAL_PRODUCT_DESCRIPTION_INVALID' });
    }
  }

  // O central envia nomes válidos inclusive para agentes já instalados/antigos.
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, payload: JSON.parse(options.body) });
    return { ok: true, text: async () => JSON.stringify({ ok: true, status: '100' }) };
  };
  try {
    const store = { code: 'TEST_ONLY', fiscalAgentEnabled: true, fiscalAgentUrl: 'https://test.invalid', fiscalAgentToken: 'TEST_ONLY' };
    for (const method of ['emitNFCe', 'emitNFe55']) {
      const args = payload(rejectedName);
      args.items.push({ name: 'Camisa — ação', sku: 'CAMISA-TESTE', qty: 2, unitPrice: 13.91 });
      args.payment.valor = 431.02;
      // Sem consumidor para que a cobertura foque o payload, sem descoberta de agentes.
      delete args.customer;
      const before = JSON.stringify(args);
      await agentClient[method](store, args);
      assert.equal(requests.at(-1).payload.items[0].name, correctedName);
      assert.deepEqual(requests.at(-1).payload, { ...args, items: [
        { ...args.items[0], name: correctedName },
        { ...args.items[1], name: 'Camisa - ação' },
      ] });
      assert.equal(JSON.stringify(args), before);
      const callsBefore = requests.length;
      await assert.rejects(agentClient[method](store, payload(' ')), { code: 'FISCAL_PRODUCT_DESCRIPTION_INVALID' });
      assert.equal(requests.length, callsBefore, 'Descrição inválida bloqueia antes de qualquer requisição');
    }
    const cancelPayload = { reason: 'Motivo — teste sem emissão' };
    await agentClient.cancel(store, cancelPayload);
    assert.deepEqual(requests.at(-1).payload, cancelPayload, 'Cancelamentos não são modificados');
  } finally {
    global.fetch = originalFetch;
  }
  console.log('OK: xProd conforme XSD, XML real dos quatro emissores, homologação e payload para agentes antigos; sem rede/certificado/banco.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
