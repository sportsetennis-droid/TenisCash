// Patch ADITIVO: modulo de PRODUCAO (facao) + remuneracao por pessoa.
// MfProductionOrder (OS) + MfProductionStage (etapas modelagem/corte/costura/
// estamparia/embalagem, cada uma com responsavel + ponto start/done + valor).
// MfEmployee ganha payType/pieceRate p/ calcular custo x resultado por pessoa.
// UTF-8 safe. Nao toca em nada de fora dos Mf*.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'prisma', 'schema.prisma');
let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');

function apply(label, from, to) {
  if (s.includes(to.split('\n')[1] || to)) { /* heuristica fraca; usa guarda abaixo */ }
  if (!s.includes(from)) throw new Error('ANCHOR NAO ACHADO: ' + label);
  s = s.replace(from, to);
  console.log('  ok ' + label);
}

// 1) MfEmployee: payType + pieceRate
if (s.includes('payType')) {
  console.log('  (ja aplicado) MfEmployee.payType');
} else {
  apply('MfEmployee.payType+pieceRate',
    '  baseSalary Float?\n  hireDate   DateTime?',
    '  baseSalary Float? // salario mensal (quando mensal/misto)\n  payType    String    @default("mensal") // mensal | peca | misto\n  pieceRate  Float? // R$ por peca que a pessoa RECEBE (quando peca/misto)\n  hireDate   DateTime?'
  );
}

// 2) Modelos novos de producao
const NEW = `

// ============================================================
// PRODUCAO (facao) — OS + etapas + remuneracao/resultado por pessoa (2026-06-16)
// ============================================================

model MfProductionOrder {
  id           String              @id @default(uuid())
  number       Int                 @default(0) // nº amigavel da OS
  title        String // o que vai produzir
  productId    String? // produto do catalogo (opcional)
  orderId      String? // pedido vinculado (opcional)
  customerId   String?
  qty          Int                 @default(0) // peças totais
  status       String              @default("aberta") // aberta | producao | concluida | cancelada
  dueDate      DateTime?
  materialCost Float               @default(0) // despesa de material/insumo da OS
  notes        String?             @db.Text
  employeeId   String? // quem abriu
  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt

  stages MfProductionStage[]

  @@index([status, createdAt])
}

model MfProductionStage {
  id                String            @id @default(uuid())
  productionOrderId String
  productionOrder   MfProductionOrder @relation(fields: [productionOrderId], references: [id], onDelete: Cascade)
  stage             String // modelagem | corte | costura | estamparia | embalagem
  seq               Int               @default(0)
  assigneeId        String? // quem faz (MfEmployee.id)
  status            String            @default("pendente") // pendente | fazendo | feito
  qty               Int               @default(0) // peças desta etapa
  unitValue         Float             @default(0) // R$/peça = valor da mao de obra desta etapa
  startedAt         DateTime? // bateu ponto: comecou
  doneAt            DateTime? // bateu ponto: terminou
  createdAt         DateTime          @default(now())

  @@index([productionOrderId])
  @@index([assigneeId, doneAt])
}
`;

if (s.includes('model MfProductionOrder')) {
  console.log('  (ja aplicado) modelos producao');
} else {
  s = s.replace(/\s*$/, '\n') + NEW;
  console.log('  ok modelos producao');
}

fs.writeFileSync(file, s, 'utf8');
console.log('schema producao patch OK');
