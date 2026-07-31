// Investigação automática de solicitações abertas pelo vendedor.
// O vendedor recebe apenas um retorno operacional; detalhes da apuração ficam
// nos campos internos e no painel administrativo.

const { prisma } = require('../middleware');

const GENERIC_ACK = 'Recebemos seu relato. Vamos investigar para resolver.';
const DOUGLAS_ESCALATION = 'Não consegui resolver automaticamente. Por favor, avise Douglas para que ele possa concluir a solução.';
const RESOLVED_ACK = 'A solicitação foi analisada e tratada. Se o problema continuar, registre uma nova ocorrência com o que ainda está acontecendo.';

function normalized(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractIdentifiers(text) {
  return [...new Set((String(text || '').match(/[a-z0-9][a-z0-9_-]{3,}/gi) || [])
    .map((value) => value.trim())
    .filter((value) => /\d/.test(value) || /[_-]/.test(value))
    .slice(0, 12))];
}

async function findExactProduct(text) {
  const identifiers = extractIdentifiers(text);
  if (!identifiers.length) return null;
  const compact = identifiers.map(normalized);
  const products = await prisma.product.findMany({
    where: {
      OR: [
        ...identifiers.flatMap((value) => [
          { sku: { contains: value, mode: 'insensitive' } },
          { internalBarcode: { contains: value, mode: 'insensitive' } },
          { sizes: { some: { barcode: { contains: value, mode: 'insensitive' } } } },
        ]),
      ],
    },
    select: { id: true, sku: true, internalBarcode: true, name: true, brand: true, active: true },
    take: 20,
  });
  return products.find((product) => {
    const fields = [product.sku, product.internalBarcode, product.name, product.brand].map(normalized);
    return compact.some((code) => fields.some((field) => field === code || field.includes(code)));
  }) || null;
}

async function findDouglasRecipient(storeId, sellerId) {
  const base = { active: true, id: { not: sellerId }, role: { in: ['admin', 'superadmin', 'manager', 'store'] } };
  const douglas = await prisma.user.findFirst({
    where: { ...base, name: { contains: 'douglas', mode: 'insensitive' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  if (douglas) return douglas;
  return prisma.user.findFirst({
    where: storeId ? { ...base, OR: [{ role: { in: ['admin', 'superadmin', 'manager'] } }, { storeId }, { storeIds: { has: storeId } }] } : base,
    orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true },
  });
}

async function sendMessage({ fromId, toId, title, content, status = 'unread' }) {
  if (!fromId || !toId || fromId === toId) return null;
  return prisma.message.create({ data: { fromId, toId, type: 'request', title, content, status } });
}

async function investigate(requestId) {
  const request = await prisma.sellerInternalRequest.findUnique({
    where: { id: String(requestId) },
    include: { seller: { select: { id: true, name: true } }, store: { select: { id: true, name: true } } },
  });
  if (!request) return null;

  const genericResponse = request.sellerResponse || GENERIC_ACK;
  await prisma.sellerInternalRequest.update({
    where: { id: request.id },
    data: { investigationStatus: 'INVESTIGATING', sellerResponse: genericResponse },
  });

  let result = { status: 'NEEDS_DOUGLAS', summary: 'A solicitação precisa de análise humana; não houve evidência suficiente para uma correção automática.', response: DOUGLAS_ESCALATION };
  if (request.category === 'PRODUCT') {
    const product = await findExactProduct(`${request.title} ${request.description}`);
    const text = normalized(`${request.title} ${request.description}`);
    const reportsMissingRegistration = /(nao cadastrad|nao registrad|sem cadastro|nao aparece|nao localizado|nao consta)/.test(text);
    if (product && reportsMissingRegistration) {
      result = {
        status: 'RESOLVED',
        summary: `Produto localizado no catálogo: ${product.brand} ${product.name} (SKU ${product.sku}). A apuração confirmou que o cadastro já existe; nenhum dado foi inventado ou alterado.`,
        response: RESOLVED_ACK,
      };
    } else if (product) {
      result = {
        status: 'NEEDS_DOUGLAS',
        summary: `Produto localizado no catálogo: ${product.brand} ${product.name} (SKU ${product.sku}), mas o relato descreve um problema além de cadastro. Nenhuma alteração foi feita automaticamente.`,
        response: DOUGLAS_ESCALATION,
      };
    } else {
      result = {
        status: 'NEEDS_DOUGLAS',
        summary: 'Não foi encontrado um produto com identificador confiável no catálogo. Não foi criado ou alterado nenhum cadastro automaticamente para evitar inventar dados.',
        response: DOUGLAS_ESCALATION,
      };
    }
  }

  const recipient = await findDouglasRecipient(request.storeId, request.sellerId);
  const updated = await prisma.sellerInternalRequest.update({
    where: { id: request.id },
    data: {
      status: result.status === 'RESOLVED' ? 'RESOLVED' : 'IN_PROGRESS',
      investigationStatus: result.status,
      investigationSummary: result.summary,
      sellerResponse: result.response,
      investigatedAt: new Date(),
      sellerNotifiedAt: recipient ? new Date() : null,
    },
  });

  if (recipient) {
    await sendMessage({
      fromId: request.sellerId,
      toId: recipient.id,
      title: result.status === 'RESOLVED' ? `Solicitação tratada — ${request.title}` : `Atenção de Douglas — ${request.title}`,
      content: `${request.seller.name} registrou: ${request.description}\n\nInvestigação interna: ${result.summary}`,
    }).catch((error) => console.error('[seller-request-investigator] aviso interno:', error.message));
    await sendMessage({
      fromId: recipient.id,
      toId: request.sellerId,
      title: `Atualização da solicitação — ${request.title}`,
      content: result.response,
      status: result.status === 'RESOLVED' ? 'approved' : 'replied',
    }).catch((error) => console.error('[seller-request-investigator] retorno vendedor:', error.message));
  }
  return updated;
}

module.exports = { GENERIC_ACK, DOUGLAS_ESCALATION, RESOLVED_ACK, investigate };
