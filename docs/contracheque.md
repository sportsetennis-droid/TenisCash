# Contracheque digital — como funciona

Módulo de folha do varejo Sports & Tennis, criado em 16/11/2026 a pedido do dono. Ele **não é um sistema paralelo**. Lê o Ponto Digital, a Agenda, as vendas e o cadastro do funcionário que o TenisCash já tem.

- **Funcionário:** `/meu-pagamento.html`. Também tem atalho "Meu pagamento" no app do vendedor.
- **Fechamento:** `/folha.html`. Também tem card "Folha / Contracheque" no admin.

## 1. De onde vem cada informação

| Informação | Fonte no TenisCash | Observação |
|---|---|---|
| Funcionário (nome, telefone, loja) | `User` (role `seller`/`manager`) | É a mesma conta de vendedor que já existe. |
| Contrato (tipo, admissão, salário, jornada, CBO, sindicato) | `PayrollEmployeeProfile` (novo) | Só o dono grava. Sem cadastro, o contracheque fica bloqueado com a pendência "Cadastro de contrato". |
| Empresa / CNPJ / estabelecimento | `FiscalIssuer` via `profile.issuerId` ou `Store.fiscalIssuerId` | |
| Batidas de ponto | `ClockIn` (entrada, início e fim do intervalo, saída) | Nunca é alterado. Correção aprovada vira batida nova com `source='correcao'`. |
| Escala 12x36 | `SellerMonthlyShift` da escala mensal publicada | |
| Folga / férias | `AgendaActivity` (tipo `folga`/`ferias` do funcionário) e `PayrollDayMark` | |
| Feriados | `PayrollHoliday` (nacionais 2026, pela lei) e `AgendaActivity` tipo `feriado` | Feriados estaduais e municipais o dono cadastra, com a fonte. |
| Vendas | `Sale` + `SaleItem` do vendedor no mês, de todas as lojas | |
| Comissão | `PayrollCommissionRule` (faixas, itens especiais, vigência) | |
| Adiantamentos, vales, passagens, domingo pago, compras, descontos | `PayrollEntry` | |
| Atestado, abono, falta confirmada, folga compensatória | `PayrollDayMark` | |
| INSS, IRRF, FGTS, VT, salário mínimo, salário-família, hora extra, adicional noturno, domingo e feriado | `PayrollParam`, com vigência, origem e documento | |

As vendas entram assim:

- **Confirmada (`completed`):** entra na comissão.
- **Pendente (`pending`, `pending_payment`):** fica de fora até confirmar e aparece como comissão provisória.
- **Cancelada (`canceled`, `cancelled`):** nunca entra.

## 2. Parâmetros legais semeados (conferidos na fonte)

Os itens com status **pendente de validação** não são usados no cálculo. Eles viram pendência "Pendente de validação do departamento pessoal".

| Chave | Valor | Fonte |
|---|---|---|
| INSS_EMPREGADO 2026 | 7,5% até R$ 1.621,00<br>9% até R$ 2.902,84<br>12% até R$ 4.354,27<br>14% até R$ 8.475,55 (teto) | Portaria Interministerial MPS/MF nº 13/2026 |
| IRRF_MENSAL | isento até R$ 2.428,80<br>7,5% até R$ 2.826,65 (dedução R$ 182,16)<br>15% até R$ 3.751,05 (dedução R$ 394,16)<br>22,5% até R$ 4.664,68 (dedução R$ 675,49)<br>27,5% acima (dedução R$ 908,73)<br>dependente R$ 189,59<br>simplificado R$ 607,20 | Tabela vigente desde 05/2025, mantida em 2026 |
| IRRF_REDUTOR | zera o imposto até R$ 5.000,00<br>de R$ 5.000,01 a R$ 7.350,00 reduz R$ 978,62 − 0,133145 × rendimento | Lei 15.270/2025 |
| SALARIO_MINIMO | R$ 1.621,00 | Decreto 12.797/2025 |
| FGTS | 8% (aprendiz 2%) | Lei 8.036/1990 |
| VALE_TRANSPORTE | até 6% do salário-base, limitado ao custo entregue | Lei 7.418/1985 |
| HORA_EXTRA | 50% | Mínimo da CF, art. 7º, XVI. A convenção pode subir. |
| ADICIONAL_NOTURNO | 20%, das 22h às 5h, hora de 52min30s | CLT art. 73 |
| SALARIO_FAMILIA | R$ 67,54 por cota até R$ 1.980,38 | Portaria nº 13/2026 |
| DOMINGO_TRABALHADO / FERIADO_TRABALHADO | valor fixo por dia + folga compensatória | Decisão do dono em 16/11/2026. **Pendente:** o valor em R$ ainda não foi informado. |

**Regra de comissão vigente (dono, 16/11/2026), a partir de 01/11/2026:**

- Até R$ 20.000,00 em vendas no mês: 1%.
- Acima de R$ 20.000,00: 2% sobre o total.
- Se as vendas de camisas Sports & Tennis passarem de R$ 5.000,00, só esses itens recebem 4%. Os demais ficam na alíquota geral.

"Camisas S&T" são os itens da marca Sports & Tennis com categoria Roupa/Vestuário, a mesma definição que o ranking usa.

**Pendente com o dono:**

- O valor do domingo e do feriado.
- A convenção coletiva do comércio de João Pessoa e Campina Grande: piso, percentuais e regras de domingo e feriado.
- Os feriados estaduais e municipais de 2026.
- A regra de comissão para competências anteriores a 11/2026, se for fechar meses antigos.

## 3. Regras de cálculo (critérios de aceitação)

1. **Domingo trabalhado** fica fora das 44 horas semanais. Aparece em "Domingos e feriados" com valor devido, valor já pago e folga compensatória.
2. **Feriado** reduz a carga da semana e não gera abono. Feriado trabalhado é pago à parte, uma vez só.
3. **Falta de ponto** vira pendência ("sem ponto — não é falta"). Só desconta quando houver `FALTA_CONFIRMADA`. A falta confirmada também tira o DSR da semana (Lei 605/49).
4. **Marcação incompleta** (entrada sem saída, intervalo sem retorno) vira pendência que bloqueia o fechamento. O sistema nunca inventa horário.
5. **Folga compensatória** só conta quando está marcada e ligada ao domingo ou feriado que compensa. Um dia sem ponto não é folga.
6. **Atestado e abono** completam o dia até a carga prevista e nunca geram saldo negativo.
7. **12x36**: hora extra só sobre o que passar do plantão contratado. A apuração não é semanal nem usa "acima de 8h".
8. **Aprendiz**: usa a carga do contrato e FGTS de 2%. Sem contrato de aprendizagem informado, fica bloqueado.
9. **Sem registro**: não desconta INSS, não calcula IRRF nem FGTS como empregado e mantém o alerta de regularização.
10. **Mensalista**: recebe salário cheio. Em admissão ou desligamento no mês, recebe proporcional, salário ÷ 30 × dias de vínculo. Não perde salário por falta de ponto.
11. **Horista**: horas × valor + DSR.
12. **Comissão** usa o valor líquido da venda, com o desconto rateado por item. Venda cancelada nunca fica no valor final. Comissão e horas extras geram DSR.
13. **Adiantamento** entra uma vez só, por id. Passagem e vale-transporte são benefícios. O desconto de VT é de no máximo 6% do salário-base e só com opção de VT. Compra na loja, empréstimo, pensão e outros descontos só entram com autorização registrada.
14. **Domingo ou feriado pago antes do fechamento** aparece como provento devido e como desconto "pago antecipadamente". Sobra só a diferença. Se o valor do dia ainda não está cadastrado, nada é descontado.

Testes:

- `npm run test:payroll`: 41 casos do motor.
- `npm run test:payroll-http`: 16 etapas ponta a ponta com Postgres.

## 4. Fluxo de fechamento

```
EM ANDAMENTO (prévia, não gravada)
  → Revisar  → COM PENDÊNCIAS | EM CONFERÊNCIA   (grava snapshot + cálculo)
  → Aprovar (dono)  → APROVADO
  → Fechar (dono)   → FECHADO   (congela dados, gera e SALVA o PDF, avisa no WhatsApp)
  → Registrar pagamento (dono, com comprovante) → PAGO
  → Reabrir (dono, com motivo) → a versão fechada vira REABERTO e nasce a versão seguinte
       → quando a nova fecha, a anterior vira CORRIGIDO (preservada)
  → Cancelar: só rascunho, com motivo
```

- **Fechar só depois do fim da competência.** Se o ponto, as vendas ou os lançamentos mudaram depois da conferência, o fechamento é recusado e pede nova revisão. O hash dos dados de entrada é conferido.
- **O fechado é congelado.** `Payslip.snapshot` guarda os dados de entrada, `Payslip.result` o cálculo e `PayslipFile` o PDF com sha256.
  - `GET /api/payroll/admin/payslips/:id/recompute` refaz o cálculo a partir do snapshot e confirma que dá o mesmo resultado.
  - Competência fechada não aceita lançamento, marcação nem correção de ponto sem reabrir.
- **A ciência do funcionário** (`PayslipAcknowledgment`) **não prova pagamento**. O pagamento exige comprovante (`paymentRef`).

## 5. WhatsApp (dono, 16/11/2026: automático + prévia semanal)

- **Ao fechar:** manda o PDF ao funcionário pelo Evolution. O link é assinado e vale 30 dias (`/api/payroll/file/<token>`). Se o envio do documento falhar, manda texto com o link.
- **Prévia semanal:** toda segunda às 09:07 (Fortaleza), só para funcionário com cadastro de contrato ativo e telefone. A mensagem deixa claro que é **prévia** e não é o oficial.
- **Desligar:** `PAYROLL_WHATSAPP=off` no Railway.
- Cada envio fica na auditoria (`WHATSAPP_SENT`, `WHATSAPP_FAILED`, `WHATSAPP_PREVIEW_SENT`).

## 6. Segurança e LGPD

- **Funcionário:** só vê os próprios dados. Um id de outro funcionário devolve 404.
- **Gerente:** só funcionários da própria loja.
- **Admin:** vê tudo.
- **Dono** (titular em `Config`, ver `finOwner.js`): é o único que fecha, reabre, cancela, paga, altera contrato, parâmetros, feriados e regras, e vê a auditoria.
- **Correção de ponto:** ninguém aprova a própria.
- **CPF e dados bancários:** criptografados com AES-256-GCM (`PAYROLL_DATA_KEY`, recomendado configurar no Railway). Só os 4 últimos dígitos do CPF ficam em claro, para a máscara.
- **Auditoria** (`PayrollAuditLog`): criação e alteração, revisão, aprovação, fechamento, reabertura, cancelamento, pagamento, visualização (funcionário e admin), exportação PDF/CSV/JSON, download pelo link assinado, ciência e envios de WhatsApp.
- **Verificação pública** (QR do PDF): `/contracheque/verificar/<código>`. Mostra empresa, iniciais, competência, versão, situação e o hash do PDF. Nenhum valor aparece.
- **Retenção:** contracheques e PDFs **não são apagados** pelo sistema. A guarda legal de documentos trabalhistas/FGTS é longa (FGTS 5 anos para cobrança; eSocial e CLT exigem guarda). Anexos de correção de ponto ficam no pedido.

## 7. Mapa das estruturas pedidas → tabelas

| Pedido | Implementação |
|---|---|
| PayrollPeriod / EmployeePayroll / PayslipVersion | `Payslip` (funcionário + competência + tipo + versão + situação) |
| PayrollItem / TimeSummary / WeeklyTimeSummary / SpecialDay / CommissionSummary | `Payslip.result`: `items`, `time.days`, `time.weeks`, `specialDays` e `commission` congelados |
| PayrollRule / PayrollRuleVersion | `PayrollParam` (vigência + origem) |
| CommissionRule | `PayrollCommissionRule` (versão + `previousId`) |
| CompensatoryDayOff | `PayrollDayMark` kind `FOLGA_COMPENSATORIA` + `refDate` |
| PayrollAdvance / PayrollDeduction / PayrollBenefit | `PayrollEntry` (kind) |
| PayrollPayment | `Payslip.paidAt` / `paymentRef` / `paidById` |
| PayrollEvidence | `Payslip.snapshot` + `PayrollClockCorrection.attachment` |
| PayslipFile | `PayslipFile` (PDF + sha256) |
| PayslipAcknowledgment / PayrollDispute / PayrollAuditLog | tabelas com o mesmo nome |

O SQL fica em `prisma/migrations/20261116_payroll/migration.sql` e é aplicado no boot por `src/services/payroll/schema.js`, porque o deploy não roda `prisma db push`.

## 8. Arquivos

- `src/services/payroll/`: `calendar`, `legal`, `params`, `time`, `commission`, `engine` (motor puro), `service` (banco e fluxo), `pdf`, `notify` (WhatsApp), `crypto`, `schema`.
- `src/routes/payroll.js`: API `/api/payroll`.
- `public/meu-pagamento.html` e `public/folha.html`.
- `scripts/test-payroll-engine.js`, `scripts/test-payroll-http.cjs` e `scripts/payroll-dev-server.cjs` (servidor local de teste, só com banco descartável).

## 9. Limitações conhecidas (não inventadas pelo sistema)

- **Troca e devolução:** o PDV registra a troca como venda nova e não reduz a venda original. Por isso a comissão não desconta automaticamente a devolução. Precisa de ajuste manual por lançamento até a troca passar a marcar a venda original.
- **Convenção coletiva:** piso, percentual de hora extra maior que 50% e regras de domingo e feriado da CCT do comércio de João Pessoa e Campina Grande ainda não foram cadastrados. O dono ou o contador cadastra em Parâmetros, com a fonte.
- **Rescisão** não está implementada. Férias e 13º têm o cálculo pronto no motor (`computeSpecialPayslip`), mas a tela e o fechamento atuais tratam a folha mensal.
