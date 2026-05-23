# Sports & Tennis — Ecossistema unificado (TenisCash + APEX)

## Identidade do projeto

Ecossistema único composto por:

1. **Rede de varejo Sports & Tennis** — 4 lojas físicas em João Pessoa/PB (Bessa, Tambaú, Rainha da Borborema, Tambiá) + ecommerce Nuvemshop. Dono: Douglas Bernardo.
2. **TenisCash (loyalty)** — cashback, programa de parceiros, carteira do cliente.
3. **Central IA (18 agentes + 6 skills)** — gestão operacional do varejo (estoque, preço, marketing, vendas, WhatsApp, conteúdo, etc.). Entrada via `retail-orchestrator`.
4. **APEX (app esportivo)** — rastreamento de atividade, coach IA, social, gamificação. Concorrente direto de Strava/NRC/Adidas Running, com diferencial: loja física + cashback real.

**TUDO É UM SÓ PROJETO.** Mesmo banco, mesmo backend, mesmo User. O cliente da loja é o atleta do app é o membro do TenisCash. Compra na loja → ganha cashback. Treina no app → ganha badge → recebe cashback. Volta na loja → usa cashback. Loop fechado.

Plataforma técnica: Node.js + Express + Prisma + PostgreSQL (Railway), CommonJS, Anthropic SDK. Frontend admin em vanilla HTML/JS em `public/admin.html`. App cliente em PWA (curto prazo) → iOS/watchOS + Android/Wear OS nativos via KMP (médio prazo). Integração com Nuvemshop OAuth, Meta API, WhatsApp Business (em migração pra Cloud API).

## Regras globais — NUNCA VIOLAR

- NUNCA enviar mensagem ao cliente sem aprovação humana (exceto `crm-whatsapp-agent` em modo rascunho)
- NUNCA aprovar descontos > 15% sem `pricing-margin-agent` validar
- NUNCA publicar conteúdo de marketing sem `safety-agent` revisar
- NUNCA aplicar markup ou mudar preço de produto sem ordem explícita do dono
- SEMPRE registrar ação com timestamp + agente responsável
- SEMPRE usar dados REAIS (banco TenisCash, não simulados)
- NUNCA committar `.env`, tokens, secrets — `.env` está no `.gitignore`

## Hierarquia de agentes

```
retail-orchestrator (entrada de TODA demanda)
├── Comerciais
│   ├── stock-agent
│   ├── pricing-margin-agent
│   ├── marketing-agent
│   ├── sales-agent
│   ├── crm-whatsapp-agent
│   ├── ecommerce-agent
│   ├── product-content-agent
│   ├── visual-merchandising-agent
│   ├── buying-supplier-agent
│   ├── live-commerce-agent
│   └── customer-experience-agent
├── Operações
│   ├── store-operations-agent
│   ├── finance-agent
│   ├── benchmark-posthoc-agent
│   └── design-brief-agent
├── Estratégia
│   └── life-assessor-agent
├── Conformidade
│   ├── legal-compliance-agent
│   └── safety-agent (revisa TODOS outputs finais)
```

## Skills disponíveis

- `daily-retail-command` — plano executável do dia
- `stock-action-plan` — transforma estoque em ação
- `campaign-generator` — campanhas completas
- `pricing-governance` — governança de preço
- `whatsapp-sales-playbook` — scripts WhatsApp
- `weekly-benchmark` — comparações da semana
- `import-nfe-supplier` — importar XMLs de NF-e (já existe)

## Contexto de negócio

- Mix: tênis esportivo, calçados, roupas técnicas, acessórios
- Clientes: atletas amadores, clubes, escolas, consumidor final
- Canais: lojas físicas (Bessa, Tambaú, Rainha da Borborema, Tambiá), Baratão dos Esportes (outra empresa), WhatsApp, Instagram (@sportsetennis 5.866 seguidores), Nuvemshop, **app APEX (em construção)**
- KPI prioritário varejo: margem bruta, giro de estoque, NPS, ticket médio, conversão online
- KPI prioritário APEX (futuro): DAU, retenção D7/D30, conversão premium, tempo médio de atividade/semana, **% atletas APEX que viram compradores na loja** (loop fechado)

## Loop econômico unificado

```
COMPRA NA LOJA → TenisCash creditado em User.balance
                 ↓
ABRE APP APEX → registra atividade (Activity)
                 ↓
DESBLOQUEIA BADGE (BadgeEarned)
                 ↓
BadgeEarned.cashbackAwarded → User.balance += valor
                 ↓
PRÓXIMA COMPRA → usa TenisCash → desconto
                 ↓
LOOP FECHADO → retenção crescente, dependência do ecossistema
```

Esse loop é o diferencial vs Strava/NRC. Eles dependem de patrocínio. Nós temos canal de venda próprio.

## Sistemas conectados

- **Banco**: PostgreSQL Railway. Tabelas relevantes:
  - Varejo: `Product`, `ProductSize`, `Supplier`, `NuvemshopProductMapping`, `User`, `Sale`, `Partner`, `Transaction`, `Campaign`, etc.
  - APEX (app esportivo): `AthleteProfile`, `Activity`, `ActivityLap`, `ActivityPhoto`, `Route`, `Segment`, `SegmentEffort`, `Club`, `ClubMembership`, `Challenge`, `ChallengeParticipation`, `TrainingPlan`, `Workout`, `UserPlan`, `BadgeEarned`, `LiveTrackingSession`, `SafetyContact`, `DeviceConnection`, `Consent`.
- **Nuvemshop**: OAuth ativa, push/pull funcionando. Loja: `sportstennis2.lojavirtualnuvem.com.br`
- **Meta**: Page Sports & Tennis, Instagram @sportsetennis, WhatsApp +55 83 9671-3153, Business Manager 31915792481369241, Ad Account act_750101118074129
- **IA**: Anthropic Claude (vision + texto), Serper (Google search), Brave (alt search)
- **Curadoria**: Agente curador opera via `/admin/ai-curation/product/:id` — 6.170 produtos curados de 7.093
- **APEX backend**: serviços em `src/services/activityIngest.js` e `src/services/aiCoach.js`; rotas em `src/routes/activities.js` e `src/routes/coach.js`.
- **APEX infra futura (não em produção)**: PostGIS, ClickHouse (streams 1Hz), Kafka (event bus), S3 (FIT/GPX), apps mobile nativos.

## Cadência diária recomendada

- 08:30 — Briefing matinal (`retail-orchestrator` aciona workflow "Segunda de manhã")
- 11:30 — Pulso de meio-dia
- 15:30 — Intervenção (se vendas <60% até 15h)
- 18:30 — Ajuste de campanha
- 21:30 — Diagnóstico final + plano de amanhã
- Semanal — `weekly-benchmark`, revisão estoque, plano de markdown

## Contrato de output (TODA resposta operacional)

```
## Diagnóstico
## Decisão
## Plano de ação
## Agentes acionados
## Dados necessários
## Riscos/controles
## Impacto esperado (KPI)
```

## Princípios operacionais

- Toda recomendação conecta a uma alavanca: receita / margem / giro / conversão / tráfego / retenção / controle / risco
- Sempre distinguir: FATO / SUPOSIÇÃO / DADO FALTANTE / AÇÃO RECOMENDADA
- Prefira outputs estruturados (tabelas, checklists, JSON)
- Pergunte por dado faltante SÓ se essencial; senão proceda com suposição marcada
- Resposta mínima útil pra urgência; análise detalhada pra estratégia
- Mudanças em dados/preço/estoque/cliente/conteúdo: PRODUZA plano revisável antes de executar (exceto se autorizado direto)

## Autorização total do dono

O dono autorizou execução direta de qualquer ação operacional. NÃO peça permissão pra:
- Rodar scripts que modificam banco de produção
- Commitar e pushar pro main
- Disparar endpoints administrativos
- Importar NF-es, sincronizar Nuvemshop, atualizar markups

EXCEÇÃO: ações que afetam preço, cliente final ou contas financeiras precisam de **plano revisável apresentado primeiro**.

## Estilo de comunicação

- Direto, sem enrolação
- PT-BR informal (gestor é o público)
- Use tabelas pra comparações
- Use código quando relevante
- Sem jargão técnico desnecessário
- Sem emojis excessivos

## REGRA PERMANENTE — Timezone em jobs cron e queries SQL

Railway roda servidor em **UTC por padrão**. Sports & Tennis fica em João Pessoa/PB.

**Sempre que houver job agendado (node-cron, cron.schedule, etc) ou query que dependa de "hoje/ontem/início do dia":**

1. **No node-cron** — passar timezone explícito:
   ```js
   cron.schedule('0 0 * * *', job, { timezone: 'America/Fortaleza' });
   ```
   SEM timezone, `0 0 * * *` roda às 00:00 UTC = 21:00 horário de Paraíba.

2. **Em queries SQL** que comparam datas — usar `AT TIME ZONE`:
   ```sql
   AND "createdAt" >= DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')
   ```

3. **Timezone correto pra Paraíba é `America/Fortaleza`** (UTC-3 fixo, sem horário de verão). NÃO usar `America/Sao_Paulo` — historicamente SP teve DST até 2019, pode dar drift em comparações antigas.

Sempre validar com a query `SELECT NOW(), NOW() AT TIME ZONE 'America/Fortaleza';` antes de declarar pronto.

## REGRA PERMANENTE — Testar TUDO que for entregue (NUNCA QUEBRAR)

Antes de declarar pronto qualquer feature/correção:
1. **TESTAR no ambiente real** (preview/admin/site público) com cenários básicos
2. Em UI: testar com foco, digitação, click em cada campo. Não confiar em "parece que funciona"
3. Em backend: testar com curl/script o endpoint criado, NÃO só confiar no deploy ok
4. Em fluxos com input+listeners: testar interação entre eles (typing + focus + click)
5. Bugs que aparecem ao usuário em 30s de uso são MEUS — devia ter testado antes
6. Se não der pra testar (depende de hardware do dono tipo leitor USB), avisar explicitamente: "testei via teclado, leitor USB precisa testar você"

Padrão de comunicação:
- "Pronto, testado X, Y, Z" — só depois de fato ter testado
- "Pronto, falta testar X com você" — quando não consegui testar tudo
- NUNCA "funciona" sem ter validado

## REGRA PERMANENTE — NFe (Classificação Entrada vs Transferência)

**Entrada e Transferência NUNCA podem ficar juntas em nenhuma contagem, contador ou cálculo.**

### Critério de classificação (`XmlFiscalDocument.docType`)

Uma NFe é classificada como `transferencia` se:
1. **CNPJ raiz iguais** — primeiros 8 dígitos do `issuerCnpj` == primeiros 8 dígitos do `recipientCnpj` (mesmo grupo empresarial, ex Meta Esportes matriz↔filial)
2. **OU** contém pelo menos um item com `cfop` = `5152` ou `6152` (transferência interna)

Caso contrário, é `entrada` (compra de fornecedor real).

### O que cada tipo significa no estoque

- **`entrada`** — compra de mercadoria de fornecedor. **CONTA como compra** (adiciona ao estoque, gera custo, alimenta `costPrice` médio, contabiliza para apuração de custo).
- **`transferencia`** — movimento interno entre lojas do mesmo grupo. **NÃO conta como compra**. Não pode aumentar custo médio, não pode aparecer em "total comprado", não pode ser somado a contadores de NFes de fornecedor.
- **`saida`** — venda emitida (NFe própria). Saída de estoque, registrada em `FiscalDocument` (não `XmlFiscalDocument`).

### Loja destino da NFe = CNPJ (NÃO CRIAR COLUNA NOVA)

A loja destino de uma NFe é determinada **automaticamente** pelo `recipientCnpj`, que casa com `FiscalIssuer.cnpj` → vinculado à `Store` via `Store.fiscalIssuerId`.

**CNPJs do grupo Meta Esportes (cada loja tem o seu, NUNCA misturar entre lojas):**

| Loja | CNPJ destinatário |
|------|-------------------|
| **LOJA01** Baratão dos Esportes | 44.052.617/0001-26 |
| **LOJA02** Sports & Tennis Bessa | 44.052.617/0002-07 |
| **LOJA03** Sports & Tennis Rainha da Borborema | 44.052.617/0003-98 |
| **LOJA04** Sports & Tennis Ecommerce | 44.052.617/0004-79 |
| **LOJA05** Sports & Tennis Tambaú | 44.052.617/0005-50 |
| **LOJA06** Sports & Tennis Tambiá | 44.052.617/0006-30 |

**REGRA**: NFe com `recipientCnpj` = 44052617000207 vai EXCLUSIVAMENTE pra Bessa. NUNCA misturar com Baratão (CNPJ 0001-26) nem com outras filiais. O agrupamento é exato pelo CNPJ do destinatário, não por código de loja.

### Card no admin

Tab **NFE GERAL** (`tab-nfegeral`) — mostra obrigatoriamente em colunas separadas:
- **ENTRADA** (verde) — compras de fornecedor
- **TRANSFERÊNCIA** (laranja) — movimento entre lojas

Endpoint backend: `GET /api/admin/xml/nfes/stats` retorna `byType` agrupado por `docType`.

### Onde foi aplicado

- Schema: `XmlFiscalDocument.docType` (string: `entrada | transferencia | saida`)
- Script de import: `scripts/import-nfe-zip-2025.js` classifica no momento da importação
- Endpoint: `GET /api/admin/xml/nfes?docType=entrada` ou `docType=transferencia`
- UI: `public/admin.html` → tab "NFE Geral"

### CFOPs identificados no banco (referência)

- `5152`, `6152` — Transferência de mercadoria
- `6101`, `6102`, `6105`, `6106` — Compra interestadual (entrada)
- `5101`, `5102` — Compra estadual (entrada)
- `2202` — Devolução de venda (entrada, mas com tratamento especial)

## REGRA PERMANENTE — WhatsApp Business app (NUNCA QUEBRAR)

NUNCA sugerir "Excluir minha conta" no WhatsApp Business app sem:
1. Backup completo confirmado pelo dono (foto perfil, descrição, catálogo, etiquetas, conversas via "Configurações → Conversas → Backup")
2. Validação prévia via Graph API de que existe caminho de re-registration ativo na Cloud API pra este número
3. Confirmação que a empresa NÃO usa o app móvel pra atendimento (caso use, planejar janela de manutenção)

Quando o owner do business é o mesmo do app Meta (caso TenisCash CRM + Sports & Tennis):
- Embedded Signup Coexistence retorna "não pode integrar clientes no momento" (Meta self-onboarding bloqueado)
- `/register` retorna "Register endpoint is not available for SMB businesses" enquanto número está em SMB
- Apagar a conta SMB pode disparar deleção em cascata da WABA inteira E acionar review automático que vira REJECTED

Caminho seguro pra mover SMB → Cloud API SEM perdas:
- Chip novo dedicado pra Cloud API (zero risco no número existente)
- OU contratar BSP (Wati, 360Dialog, Chakra) que já é Tech Provider verificado
