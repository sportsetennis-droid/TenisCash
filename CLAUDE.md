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

## REGRA PERMANENTE — Mobile-first em TUDO que cliente/vendedor usa

99% do tráfego das telas voltadas pra **cliente, vendedor em loja, ou uso operacional fora do escritório** vem de celular. NUNCA construir tela com split-layout desktop-first pra esse público — sempre mobile-first.

**Tipo de tela → regra:**

| Tela | Padrão |
|------|--------|
| Admin / backoffice (`/admin.html`) | Desktop-first OK (uso em mesa) |
| Vendedor em loja (bipar, contagem, ponto, chat) | **Mobile-first obrigatório** |
| Cliente final (loja, app, chat, perfil) | **Mobile-first obrigatório** |
| Páginas públicas (políticas, login) | Mobile-first |

**Padrão técnico do mobile-first PWA:**
- `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`
- `padding-top: env(safe-area-inset-top)` + `padding-bottom: env(safe-area-inset-bottom)` no body (iPhone notch)
- Container principal `max-width: 480px; margin: 0 auto` (centralizado)
- `<meta name="apple-mobile-web-app-capable" content="yes">` + `manifest.json` linkado (instalável)
- Botões com `min-height: 44px` (touch target Apple HIG)
- Bottom nav fixo (não top tabs) — polegar alcança fácil
- Modais como bottom-sheet (não centro da tela)
- Long-press em items pra menu de ação (não hover)
- Em desktop (`@media (min-width: 900px)`): renderizar como "frame de celular" centralizado com sombra — não esticar pra ocupar tela cheia

**Verificação antes de declarar pronto:**
1. Abrir no DevTools → modo responsive → iPhone 13 (390px)
2. Testar com polegar (não mouse) — botões alcançáveis?
3. Bottom nav não cobre conteúdo?
4. Modal não escapa da viewport?
5. Input não fica escondido atrás do teclado virtual?

Aprendi isso depois de fazer `/mensagens.html` com split-layout 340px+thread e o dono ter que avisar "vc tem que se ligar que as pessoas vao acessar mobile".

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

### ⚠️ REGRA RÍGIDA — Transferência NÃO cria Product

**Claude já errou aqui DUAS vezes. Atenção:**

1. **NFe de TRANSFERÊNCIA NÃO cria Product novo no catálogo.** Nunca. Mesmo que o EAN não exista.
2. **Só NFe de ENTRADA (compra de fornecedor) cria Product.**

**Por quê:**
- Transferência matriz→loja significa que o produto JÁ existia (foi comprado em alguma NFe de entrada original)
- Se não tem Product no catálogo é porque **falta a NFe de entrada original** (não foi importada ou é produção própria sem nota de compra)
- Criar Product a partir de transferência **mascara o problema** (faz parecer que o produto tem origem na própria empresa) e **bagunça o catálogo** (cria duplicatas quando a NFe de entrada original chegar)

**Comportamento correto da transferência:**
- A transferência **APARECE NO CARD** de um produto que **JÁ EXISTE** (na seção laranja "🔄 Transferências" do card)
- Se o Product não existe → a transferência fica como `XmlFiscalItem` órfão (`productId=null`), esperando a NFe de entrada original chegar
- Quando a NFe de entrada chegar (com EAN), o vínculo é feito automaticamente e a transferência passa a aparecer no card

**Quando rodar `scripts/create-products-from-nfe-pending.js`:** o script DEVE filtrar `WHERE docType = 'entrada'` no findMany de XmlFiscalItem pendentes. NUNCA processar `docType = 'transferencia'`.

**Histórico de erros:**
- Sessão 26/05/2026: Claude criou 1.085 Products a partir de transferência. Reverteu.
- Sessão 26/05/2026 (depois): Claude tentou criar mais 900 Products de transferência (NFes sem EAN). Owner barrou.
- Total: 1.590 Products deletados depois de re-leitura da regra.

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

## REGRA PERMANENTE — Estrutura do Card de Produto (REF + DESC + COR vs SKU)

**1 CARD = 1 modelo único.** Chave de unificação: **REFERÊNCIA + DESCRIÇÃO + COR**.

**SKU é dos TAMANHOS, NÃO do card.** Cada tamanho dentro do card tem seu próprio SKU/código de barras.

### Mapeamento conceito → schema

| Conceito (linguagem do dono) | Tabela / Campo |
|---|---|
| **CARD** (1 modelo+cor) | `Product` |
| **REFERÊNCIA** do modelo | `Product.sku` (legado: nome do campo é confuso, mas é referência) |
| **DESCRIÇÃO** do modelo | `Product.name` |
| **COR** do modelo | `aiContext.color` (string livre, ex: "Branco/Marinho") |
| **REF do fornecedor** (cód externo) | `aiContext.supplierRef` |
| **SKU** de cada tamanho | `ProductSize.barcode` (EAN/código único por tamanho) |
| Estoque por tamanho | `ProductSize.stock` ou `StoreStock` |

### Exemplo

```
CARD: Tênis Converse Chuck Taylor All Star Side Zip
  REF: CK09090001
  COR: Azul Escuro/Laranja/Branco
  ├─ Tam 38 → SKU 7908341493884
  ├─ Tam 39 → SKU 7908341493891
  ├─ Tam 40 → SKU 7908341493907
  ...
```

Se o dono tem 12 pares fisicos do mesmo modelo+cor:
- **1 CARD único** no catálogo
- Pares se distribuem em **N ProductSize** (1 por tamanho)
- Pares do mesmo tamanho compartilham o mesmo SKU (mesmo código de barras)

### Regra de unificação

Quando criar/importar produto, agrupar por (REF + DESC normalizada + COR). NUNCA criar 1 Product por tamanho separadamente. Tamanho vira ProductSize dentro do Product.

### UI rules

- **NUNCA** chamar `Product.sku` de "SKU" no admin (confunde). Usar **"REFERÊNCIA DO FORNECEDOR"** ou **"REF"**.
- O label "SKU" pode ser usado SÓ pra `ProductSize.barcode` (cód do tamanho).
- Modal de edição de produto: campos **REFERÊNCIA + DESCRIÇÃO + COR** no bloco "Identificação do Modelo".
- Card visual: mostrar `REF: XXX` + `🎨 cor` (não mostrar "SKU XXX" no topo do card).

### Histórico

- 26/05/2026: Claude criava 1 Product por tamanho via NFe (errado). Owner corrigiu: "SKU é por tamanho, não por card". Refatorou UI + card visual.

### Hierarquia conceitual de 3 níveis (modelo > variante-cor > tamanho)

Acima do CARD (variante de cor) existe um nível superior: **MODELO**.

```
MODELO (ex: "Converse Chuck Taylor All Star")
  ├─ VARIANTE COR 1 ("Branco/Marinho")  → REF CK09090001 → 1 CARD
  │   ├─ Tam 38 → SKU 7908...884
  │   └─ Tam 39 → SKU 7908...891
  ├─ VARIANTE COR 2 ("Preto/Vermelho")  → REF CK09090002 → 1 CARD
  └─ VARIANTE COR 3 ("Rosa/Cru")         → REF CK09090003 → 1 CARD
```

**Regra**: cada marca tem padrão diferente pra identificar variação de cor do mesmo modelo. Algumas usam padrão na referência (CK0909XXXX), outras na descrição, outras só no nome do fornecedor. **Tem que estudar marca por marca pra traçar o perfil de cada uma**.

Padrões observados:

- **CONVERSE** ✅ confirmado: ref no formato `[CK|CT|CO][0000][0000]` (10 chars).
  - Primeiros 6 chars = MODELO (ex: `CK0004`, `CT0419`, `CO0639`)
  - Últimos 4 chars = variação de cor (ex: `0001`, `0002`, `0006`, `0007` — não são sequenciais, são códigos fixos de cor do fornecedor)
  - Cards com mesma `modelGroup` (primeiros 6 chars) são o mesmo modelo em cores diferentes
  - 106 refs Converse no formato letra+número distribuídas em 58 modelos
  - Outros 106 cards têm ref puramente numérica (`120953`, etc) — código interno do PDV. Esses são DUPLICATAS dos 106 letra+número (nome contém a ref oficial)
- **FIBER**: ref estruturada `CATEGORIA-MODELO-COR-TAMANHO` (ex: `CALBFBR-ALLBLACK-G`) — a estudar
- **Maioria das marcas**: `Product.sku` atual é `XXXX-EAN` (prefixo PDV + código de barras de UM tamanho) — não é ref real do modelo
- Outras: documentar conforme forem analisadas

Quando o agrupamento por modelo for implementado, salvar em `aiContext.modelGroup` (string normalizada do modelo) e usar pra:
- Mostrar "também disponível em outras cores" no card
- Agrupar relatórios por modelo
- Curadoria/foto: 1 sessão cobre todas as variantes
- Cross-selling no PDV

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
