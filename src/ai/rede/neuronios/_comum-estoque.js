// =====================================================================
// RNA — utilidades compartilhadas pelos neurônios de NF-e, Estoque, Bipe
// e Compras. NÃO é neurônio (fica na raiz de neuronios/, o registro só
// carrega arquivos dentro de neuronios/<dominio>/).
// Aqui moram as REGRAS DURAS do CLAUDE.md que mais de um neurônio usa:
//  - "SEM GTIN" nunca é código e nunca entra em soma;
//  - transferência (CNPJ raiz igual ou CFOP 5152/6152) não é compra;
//  - fornecedor = EMISSOR da entrada, nunca o grupo 44052617;
//  - tamanho só se for literal e plausível; Adidas só pela caixa.
// =====================================================================
const barcodePolicy = require('../../../../public/scanner-barcode-policy');

const GRUPO_RAIZ = '44052617';
const CFOP_TRANSF = new Set(['5152', '6152']);
const DIA = 24 * 3600 * 1000;

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const raizCnpj = (c) => { const d = soDigitos(c); return d.length >= 8 ? d.slice(0, 8) : null; };
const ehGrupo = (c) => raizCnpj(c) === GRUPO_RAIZ;
const cfopTransf = (cfop) => CFOP_TRANSF.has(soDigitos(cfop));

// Classificação da NF-e (regra do CLAUDE.md): transferência = CNPJ raiz igual OU CFOP 5152/6152.
function classificarNfe(doc, itens = []) {
  const ri = raizCnpj(doc.issuerCnpj), rr = raizCnpj(doc.recipientCnpj);
  const motivos = [];
  if (ri && rr && ri === rr) motivos.push('CNPJ raiz igual (' + ri + ')');
  const cfops = [...new Set(itens.filter((i) => cfopTransf(i.cfop)).map((i) => soDigitos(i.cfop)))];
  if (cfops.length) motivos.push('CFOP de transferência ' + cfops.join('/'));
  if (motivos.length) return { docType: 'transferencia', motivos };
  // Emitida pelo grupo para fora do grupo = saída nossa, nunca compra.
  if (ri === GRUPO_RAIZ && rr && rr !== GRUPO_RAIZ) return { docType: 'saida', motivos: ['emitente é do grupo ' + GRUPO_RAIZ] };
  if (!ri || !rr) return { docType: null, motivos: ['CNPJ do emitente ou do destinatário ausente'] };
  return { docType: 'entrada', motivos: ['emitente ' + ri + ' fora do grupo, sem CFOP de transferência'] };
}
// É compra de fornecedor? docType gravado E cálculo têm que concordar; sem docType, vale o cálculo.
function docEhEntrada(doc, itens = []) {
  if (!doc) return false;
  const calc = classificarNfe(doc, itens).docType;
  if (doc.docType) return doc.docType === 'entrada' && (!calc || calc === 'entrada');
  return calc === 'entrada';
}
// Filtro Prisma amplo (entrada gravada ou ainda sem docType) — SEMPRE refinar com docEhEntrada.
const WHERE_DOC_ENTRADA = { OR: [{ docType: 'entrada' }, { docType: null }] };
const SEL_DOC = { docType: true, issuerCnpj: true, recipientCnpj: true };

// "SEM GTIN" (e qualquer coisa que não é código de leitura) NUNCA é barcode.
function semGtin(code) {
  const c = String(code || '').trim();
  if (!c || /SEM\s*GTIN/i.test(c)) return true;
  return !barcodePolicy.isScanCode(c);
}
const variantes = (code) => (semGtin(code) ? [] : barcodePolicy.variants(code));
const identidade = (code) => barcodePolicy.identity(code);

// Tamanho placeholder = ainda sem número confirmado (T-<EAN>, '?', vazio).
const placeholder = (s) => !s || s === '?' || /^T-/i.test(String(s));
const ehAdidas = (...txt) => txt.some((t) => /adidas|alpar/i.test(String(t || '')));

// Tamanho plausível (mesma régua do bipe manual): 15–50 (com .5), letras de roupa, idades 2A–16A, Único.
function tamanhoPlausivel(s) {
  const t = String(s || '').trim().toUpperCase().replace(',', '.');
  if (!t) return false;
  if (/^\d{2}(\.5)?$/.test(t)) { const n = Number(t); return n >= 15 && n <= 50; }
  if (/^(PP|P|M|G|GG|XG|XGG|EG|EGG|XS|S|L|XL|XXL|XXXL|U|UN|UNICO|ÚNICO)$/.test(t)) return true;
  const a = t.match(/^(\d{1,2})A$/); if (a) { const n = Number(a[1]); return n >= 2 && n <= 16; }
  return false;
}

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const tokens = (s) => semAcento(s).split(/[^A-Z0-9.,]+/).filter(Boolean);

// O tamanho está ESCRITO na descrição como valor único (não faixa "38/43")?
function tamanhoNaDescricao(xProd, tam) {
  const t = semAcento(tam).replace(',', '.');
  const txt = semAcento(xProd).replace(/(\d),(\d)/g, '$1.$2');
  const esc = t.replace('.', '\\.');
  if (new RegExp('(^|[^0-9A-Z.])' + esc + '\\s*[/-]\\s*[0-9A-Z]').test(txt)) return false; // "38/43", "P/GG"
  if (new RegExp('[0-9A-Z]\\s*[/-]\\s*' + esc + '($|[^0-9A-Z.])').test(txt)) return false;
  return tokens(txt).some((x) => x.replace(/[.,]$/, '') === t);
}
// O tamanho é o SUFIXO do cProd, separado por letra/separador (não um número corrido).
function tamanhoNoCprod(cProd, tam) {
  const c = semAcento(cProd).trim();
  const t = semAcento(tam).replace(',', '.');
  if (!c || !c.endsWith(t) || c.length <= t.length) return false;
  const antes = c[c.length - t.length - 1];
  return !/[0-9]/.test(antes);
}

// Código de barras mais confiável de uma linha da NF-e (ou null se SEM GTIN).
const eanDoItem = (it) => (it && !semGtin(it.ean) ? String(it.ean).trim() : null);

async function lojaPorCodigo(ler, code) {
  if (!code) return null;
  return ler.store.findUnique({ where: { code: String(code) }, select: { id: true, code: true, name: true } });
}
async function mapaLojas(ler) {
  const ls = await ler.store.findMany({ select: { id: true, code: true, name: true } });
  return { porId: new Map(ls.map((l) => [l.id, l])), porCodigo: new Map(ls.map((l) => [l.code, l])) };
}

// COMPRADO por código = Σ qCom das NF-e de ENTRADA daquele EAN (variantes),
// sem transferência e SEM "SEM GTIN" (que soma ~79 mil e explode tudo).
async function compradoPorCodigo(ler, barcode) {
  const vs = variantes(barcode);
  if (!vs.length) return { quantidade: 0, itens: [] };
  const itens = await ler.xmlFiscalItem.findMany({
    where: { ean: { in: vs }, fiscalDocument: WHERE_DOC_ENTRADA },
    select: { id: true, quantity: true, unitValue: true, totalValue: true, cfop: true, supplierCode: true, description: true, productId: true, fiscalDocumentId: true, fiscalDocument: { select: SEL_DOC } },
  });
  const validos = itens.filter((i) => !cfopTransf(i.cfop) && docEhEntrada(i.fiscalDocument, [i]));
  return { quantidade: validos.reduce((s, i) => s + (Number(i.quantity) || 0), 0), itens: validos };
}

// Vendas concluídas por tamanho (productSizeId) nos últimos `dias`; opcional por loja.
async function vendasPorTamanho(ler, sizeIds, { dias = 90, storeId = null, agora = new Date() } = {}) {
  const ids = [...new Set(sizeIds.filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await ler.saleItem.findMany({
    where: { productSizeId: { in: ids }, sale: { status: 'completed', createdAt: { gte: new Date(agora.getTime() - dias * DIA) }, ...(storeId ? { storeId } : {}) } },
    select: { productSizeId: true, quantity: true },
  });
  for (const r of rows) out.set(r.productSizeId, (out.get(r.productSizeId) || 0) + (Number(r.quantity) || 0));
  return out;
}

// Fornecedor = EMISSOR da NF-e de ENTRADA mais recente com algum código do card. Nunca o grupo.
async function fornecedorDoProduto(ler, product) {
  const barcodes = (product.sizes || []).map((s) => s.barcode).filter((b) => !semGtin(b));
  const vs = [...new Set(barcodes.flatMap((b) => variantes(b)))];
  const ors = [{ productId: product.id }];
  if (vs.length) ors.push({ ean: { in: vs } });
  const itens = await ler.xmlFiscalItem.findMany({
    where: { OR: ors, fiscalDocument: WHERE_DOC_ENTRADA },
    select: { cfop: true, fiscalDocument: { select: { accessKey: true, issuerCnpj: true, issuerName: true, issueDate: true, docType: true, recipientCnpj: true } } },
    take: 200,
  });
  const validos = itens.filter((i) => !cfopTransf(i.cfop) && docEhEntrada(i.fiscalDocument, [i]) && i.fiscalDocument.issuerCnpj && !ehGrupo(i.fiscalDocument.issuerCnpj));
  validos.sort((a, b) => (b.fiscalDocument.issueDate ? b.fiscalDocument.issueDate.getTime() : 0) - (a.fiscalDocument.issueDate ? a.fiscalDocument.issueDate.getTime() : 0));
  const d = validos[0] && validos[0].fiscalDocument;
  if (!d) return null;
  const sup = await ler.supplier.findFirst({ where: { cnpj: { in: [d.issuerCnpj, soDigitos(d.issuerCnpj)] } }, select: { id: true, companyName: true, paymentDeadline: true } }).catch(() => null);
  return { cnpj: soDigitos(d.issuerCnpj), nome: (sup && sup.companyName) || d.issuerName || null, supplierId: sup ? sup.id : null, ultimaNfe: d.accessKey, ultimaEntrada: d.issueDate };
}

async function seguirConsolidacao(ler, p) {
  let atual = p; const vistos = new Set();
  for (let i = 0; atual && i < 6; i++) {
    if (vistos.has(atual.id)) return p; vistos.add(atual.id);
    if (atual.active) return atual;
    const prox = atual.aiContext && atual.aiContext.consolidatedInto;
    if (!prox) return atual; // inativo sem destino: é ele mesmo (reativar é decisão humana)
    const n = await ler.product.findUnique({ where: { id: String(prox) }, select: { id: true, sku: true, name: true, brand: true, active: true, aiContext: true } });
    if (!n) return atual;
    atual = n;
  }
  return atual;
}

async function buscarCardExistente(ler, item, ean) {
  const achados = new Map();
  const sel = 'id, sku, name, brand, active, "aiContext"';
  if (ean) {
    const id = identidade(ean);
    if (id.length >= 8) {
      const rows = await ler.$queryRawUnsafe(`SELECT ${sel} FROM "Product" WHERE position($1 in sku) > 0 LIMIT 5`, id);
      for (const r of rows) achados.set(r.id, Object.assign(r, { como: 'EAN no sku' }));
    }
  }
  const cprod = String(item.supplierCode || '').trim();
  if (cprod.length >= 5) {
    const rows = await ler.$queryRawUnsafe(`SELECT ${sel} FROM "Product" WHERE length(sku) >= 5 AND left($1, length(sku)) = sku ORDER BY length(sku) DESC LIMIT 5`, cprod);
    if (rows.length) {
      const maior = rows[0].sku.length; // sku-âncora: só o MAIOR prefixo vale
      for (const r of rows.filter((x) => x.sku.length === maior)) if (!achados.has(r.id)) achados.set(r.id, Object.assign(r, { como: 'sku é prefixo do cProd' }));
    }
    const irmaos = await ler.xmlFiscalItem.findMany({
      where: { supplierCode: cprod, productId: { not: null }, id: { not: item.id }, fiscalDocument: WHERE_DOC_ENTRADA },
      select: { productId: true, cfop: true, fiscalDocument: { select: SEL_DOC } }, take: 20,
    });
    for (const x of irmaos) {
      if (cfopTransf(x.cfop) || !docEhEntrada(x.fiscalDocument, [x])) continue;
      if (achados.has(x.productId)) continue;
      const p = await ler.product.findUnique({ where: { id: x.productId }, select: { id: true, sku: true, name: true, brand: true, active: true, aiContext: true } });
      if (p) achados.set(p.id, Object.assign(p, { como: 'mesmo cProd já ligado em outra NF-e' }));
    }
  }
  const canon = new Map();
  for (const p of achados.values()) {
    const k = await seguirConsolidacao(ler, p);
    if (!canon.has(k.id)) canon.set(k.id, { id: k.id, sku: k.sku, name: k.name, brand: k.brand, active: k.active, como: p.como });
  }
  return [...canon.values()];
}

async function codigoConhecido(ler, ean) {
  const vs = variantes(ean);
  if (!vs.length) return false;
  if (await ler.productSize.findFirst({ where: { barcode: { in: vs } }, select: { id: true } })) return true;
  const alias = await ler.$queryRawUnsafe(`SELECT id FROM "Product" WHERE jsonb_exists(COALESCE("aiContext"->'scannerBarcodeAliases', '{}'::jsonb), $1) LIMIT 1`, identidade(ean));
  return alias.length > 0;
}

// Tamanho LITERAL de uma linha da NF-e só por regra: o mesmo valor tem que estar
// no fim do cProd E escrito na descrição. Qualquer dúvida → null (placeholder).
function tamanhoLiteralRegra(cProd, xProd) {
  const toks = semAcento(xProd).replace(/(\d),(\d)/g, '$1.$2').split(/[^A-Z0-9.]+/).filter(Boolean);
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i].replace(/\.$/, '');
    if (tamanhoPlausivel(t) && tamanhoNoCprod(cProd, t) && tamanhoNaDescricao(xProd, t)) return t;
  }
  return null;
}

const dadoFaltante = (chave, campo, motivo, extra = {}) => ({ tipo: 'dado-faltante', forca: 0.6, dados: Object.assign({ chave, campo, motivo }, extra) });
const diaISO = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10); // dia em Fortaleza

module.exports = {
  GRUPO_RAIZ, DIA, soDigitos, raizCnpj, ehGrupo, cfopTransf, classificarNfe, docEhEntrada, WHERE_DOC_ENTRADA, SEL_DOC, semGtin, variantes, identidade, placeholder, ehAdidas,
  tamanhoPlausivel, tamanhoNaDescricao, tamanhoNoCprod, semAcento, eanDoItem, lojaPorCodigo, mapaLojas,
  compradoPorCodigo, vendasPorTamanho, buscarCardExistente, seguirConsolidacao, codigoConhecido, tamanhoLiteralRegra, fornecedorDoProduto, dadoFaltante, diaISO,
};
