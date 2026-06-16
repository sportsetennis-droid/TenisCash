// Patch ADITIVO do schema p/ o pacote MF: variantes (grade tam/cor) + pagamento
// + financeiro + baixa de estoque. UTF-8 safe (le normalizando, escreve utf8 LF).
// NAO toca em nenhum modelo de fora; so 3 modelos novos + back-relations Mf*.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'prisma', 'schema.prisma');
let s = fs.readFileSync(file, 'latin1'); // le bruto; normaliza abaixo
// se tiver acento mojibake nao importa: so mexemos em blocos ASCII puros
s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');

function apply(label, from, to) {
  if (!s.includes(from)) throw new Error('ANCHOR NAO ACHADO: ' + label);
  if (s.includes(to) && !from.includes(to)) {
    console.log('  (ja aplicado) ' + label);
    return;
  }
  s = s.replace(from, to);
  console.log('  ok ' + label);
}

// 1) MfProduct: back-relation variants
apply('MfProduct.variants',
  '  movements  MfStockMovement[]\n  orderItems MfOrderItem[]\n\n  @@index([categoryId])',
  '  movements  MfStockMovement[]\n  orderItems MfOrderItem[]\n  variants   MfProductVariant[]\n\n  @@index([categoryId])'
);

// 2) MfStockMovement: variantId scalar
apply('MfStockMovement.variantId',
  '  productId    String\n  product      MfProduct   @relation(fields: [productId], references: [id])\n  type         String // entrada | saida | ajuste',
  '  productId    String\n  product      MfProduct   @relation(fields: [productId], references: [id])\n  variantId    String? // se mexeu numa variante (grade)\n  type         String // entrada | saida | ajuste'
);

// 3) MfOrder: stockApplied + back-relation payments
apply('MfOrder.stockApplied+payments',
  '  nfeAt        DateTime?\n\n  items MfOrderItem[]\n\n  @@index([status, createdAt])',
  '  nfeAt        DateTime?\n  stockApplied Boolean   @default(false) // baixa de estoque ja aplicada (entregue)\n\n  items    MfOrderItem[]\n  payments MfPayment[]\n\n  @@index([status, createdAt])'
);

// 4) MfOrderItem: variantId scalar
apply('MfOrderItem.variantId',
  '  productId   String?\n  product     MfProduct? @relation(fields: [productId], references: [id])\n  description String // texto livre (item sob medida) ou nome do produto',
  '  productId   String?\n  product     MfProduct? @relation(fields: [productId], references: [id])\n  variantId   String? // variante (grade tam/cor) escolhida\n  description String // texto livre (item sob medida) ou nome do produto'
);

// 5) Modelos novos — append no fim (ordem nao importa pro Prisma)
const NEW = `

// ============================================================
// PACOTE MF — grade (variantes), pagamento e financeiro (2026-06-16)
// Aditivo: produto sem variante segue usando MfProduct.stock (compativel).
// ============================================================

model MfProductVariant {
  id        String    @id @default(uuid())
  productId String
  product   MfProduct @relation(fields: [productId], references: [id], onDelete: Cascade)
  size      String? // PP P M G GG EXG ... ou numerico
  color     String?
  sku       String? // codigo de barras / SKU da variante
  stock     Int       @default(0)
  minStock  Int       @default(0)
  active    Boolean   @default(true)
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([productId])
}

model MfPayment {
  id         String   @id @default(uuid())
  orderId    String
  order      MfOrder  @relation(fields: [orderId], references: [id], onDelete: Cascade)
  amount     Float
  method     String   @default("dinheiro") // dinheiro|pix|credito|debito|boleto|transferencia|prazo
  paidAt     DateTime @default(now())
  note       String?
  employeeId String?
  createdAt  DateTime @default(now())

  @@index([orderId])
  @@index([paidAt])
}

model MfFinanceEntry {
  id          String    @id @default(uuid())
  kind        String // receber | pagar
  description String
  category    String? // aluguel|fornecedor|salario|imposto|venda|servico|outro
  amount      Float     @default(0)
  dueDate     DateTime?
  status      String    @default("aberto") // aberto | pago | cancelado
  paidAt      DateTime?
  method      String?
  orderId     String?
  customerId  String?
  employeeId  String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@index([kind, status])
  @@index([status, dueDate])
}
`;

if (s.includes('model MfProductVariant')) {
  console.log('  (ja aplicado) modelos novos');
} else {
  s = s.replace(/\s*$/, '\n') + NEW;
  console.log('  ok modelos novos');
}

fs.writeFileSync(file, s, 'utf8');
console.log('schema.prisma patch OK');
