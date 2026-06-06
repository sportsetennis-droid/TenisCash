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
- **REGRA INQUEBRÁVEL — Nuvemshop:** só sobe produto pro Nuvemshop classificado nas **4** (Categoria + Sub + Modalidade + Especialidade). Sem as 4, NÃO sobe (nem cria, nem atualiza). Enforced em `pushProductToNuvemshop` (skip se incompleto).

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

## REGRA PERMANENTE — USAR A MÁQUINA (disco local) antes de dizer "não existe"

Antes de concluir que um arquivo/NFe/dado "não está" ou "não existe", **SEMPRE varrer o disco da máquina** (C:/Users/sport), não só o banco. NÃO confiar só no banco nem em uma pasta única.

- Pastas-chave de NFe: `~/Downloads`, `~/Documents`, `~/Desktop`, `~/OneDrive`, `C:/Users/sport/TenisCash/tmp`.
- NFe = `*.xml` (e `.XML`) com `<infNFe>`. O nome do arquivo costuma ser a **chave de acesso de 44 dígitos**; dígitos 3–6 = `AAMM` da emissão (ex: `…26 03…` = mar/2026).
- Cruzar a chave com `XmlFiscalDocument.accessKey` pra saber se já foi importado.
- Só afirmar "faltam" / "não existe" **DEPOIS** de varrer o disco e cruzar com o banco. Buscar em TODAS as pastas-chave, não só uma.

**Erro 04/06/2026 (origem desta regra):** afirmei "não tem XML de 2026 em disco" tendo checado só `tmp/`. Os XMLs de 2026 estavam em `~/Downloads` o tempo todo. O dono: "eu quero que vc coloque como regra usar a maquina."

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
- Sessão 03/06/2026: Claude confundiu o DESTINATÁRIO (Baratão) com o FORNECEDOR e descartou mercadoria REAL (bolas Reebok compradas da SPORTCOM). Owner pegou: "bola reebok não está nas NFe de compra?". Corrigido.

### ⚠️⚠️ REGRA PERMANENTE — TRANSFERÊNCIA SE DESCARTA (dono: "o que é transferência descarta, não vou mais repetir isso")

**1. Produto SÓ-transferência = DESCARTA na hora.** Se um Product está ativo e a ÚNICA origem fiscal dele é transferência (tem item `docType='transferencia'` e NENHUM item `docType='entrada'`), ele é espúrio → `active=false` + zera `ProductSize.stock` + `StoreStock`. Não pergunta, não espera.
   - Critério: `active=true AND EXISTS(item transferencia) AND NOT EXISTS(item entrada)`.
   - Quando a NFe de ENTRADA real chegar, o produto nasce certo.

**2. FORNECEDOR = EMISSOR da entrada (`issuerCnpj`), NUNCA o destinatário (`recipientCnpj`).** O destinatário é quem COMPROU (loja do grupo, ex Baratão 44052617*). O fornecedor é quem VENDEU (emissor da NFe de entrada). NUNCA gravar `aiContext.supplierCnpj` = CNPJ do grupo `44052617*`. Se estiver assim, está ERRADO → corrigir pro emissor real da entrada.

**3. CNPJ do grupo `44052617*` (Baratão/Bessa/Rainha/Tambaú/Tambiá/Ecom) NUNCA é fornecedor.** São lojas próprias. Aparecer como `supplierCnpj` = bug de import a corrigir, não é transferência a manter.

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

- **CONVERSE** ✅: ref `[CK|CT|CO][0000][0000]` (10 chars). modelGroup = primeiros 6 chars (CK0004). 106 refs em 58 modelos.
- **SKECHERS** ✅: ref `LETRAS-NUMS-COR-TAM` (ex: `GTW-129627-ORG-34`). modelGroup = primeiros 2 segmentos (`GTW-129627`). 265 cards em 27 modelos.
- **MIZUNO** ✅: ref `NUM-COR-TAM` (ex: `101060060-ROSA46-35`). modelGroup = 1º segmento numérico (`101060060`). 298 cards em 30 modelos.
- **FIBER** ✅: ref `XXX-NNNN-VER-TAM` (ex: `SFBMUL-0104-V2-44/45/46`). modelGroup = primeiros 2 segmentos (`SFBMUL-0104`). 129 cards em 32 modelos.
- **ASICS** ✅: ref `MODELO COR+TAM` separado por espaço (ex: `1011B958 403039`). modelGroup = parte antes do espaço (`1011B958`). 480 cards em 89 modelos.
- **PUMA** ✅: ref `MODELO   COR+TAM` separado por múltiplos espaços (ex: `687979   018PEQ`). modelGroup = primeiros 4-8 dígitos antes do espaço (`687979`). 305 cards em 102 modelos.
- **Caju Brasil** ✅: ref `NNN.NNN+NNNNN+tam-letra` (ex: `017.00701068P`). modelGroup = primeiros 7 chars (`017.007`). 510 cards em 146 modelos.
- **REEBOK** ✅: ref `9-digits + M/W + 5-letras-cor + 2-dig-tam` (ex: `100209958WCRAVD38`). modelGroup = primeiros 10 chars (`100209958W`). 128 cards em 23 modelos. (79 pulados em formato variado tipo `RUH4D333169U`.)
- **ADIDAS** ✅: codigo curto `[A-Z]{2}[0-9]{4}` (ex: `DP3219`, `JG5856`). Quando ref é EAN, extrai do NOME (formato "REF: XXXXXX - ..."). modelGroup = esse codigo. 700 cards em 179 modelos. (166 pulados sem codigo visível.)
- **KAPPA** ⚠️ parcial: múltiplos padrões. `KP+7dig+3dig+tam` ou `KPCA+2dig+6dig+tam` ou `KP+digits+J+digits`. modelGroup = parte fixa antes do código de cor+tam. 138/351 cards cobertos em 23 modelos. Outros 213 cards têm formatos não cobertos.
- **FILA** ✅: ref `F[N]L[N]-DESC` no NOME (ex: `F11L01791-CASACO...`). 96 cards em 47 modelos.
- **UMBRO** ✅: ref `U[N]FB[N]-DESC` no NOME (ex: `U01FB00419-CHUTEIRA...`). 128 cards em 65 modelos.
- **BOTAFOGO** ✅: ref `EKPB+6dig+cor+tam` (ex: `EKPB471902044P`). modelGroup = primeiros 10 chars. 76 cards em 20 modelos.
- **Alto Giro** ✅: 2-3 primeiras palavras do nome (sem extrair da ref numérica). 150 cards em 37 modelos.
- **DIADORA** ✅: extrai `DFSC056` ou `DFAR020` do nome. 138 cards em 13 modelos.
- **SPALDING** ✅: ref `XXX[N]+digits` (ex: `DRIS2502IN.42`). modelGroup = primeiras 3-4 letras + 3-5 dígitos. 138 cards em 25 modelos.
- **SPEEDO** ✅: ref `SPO+N.N-N.tam` (ex: `SPO02.02-04.36`). modelGroup = primeiros 4-5 chars (`SPO02`, `SPO120`). 155 cards em 12 modelos.
- **EVOKE** ✅: ref `MODELO COR` ou `EVK XX YY` (ex: `AVALANCHE A13`, `EVK 30 BRC01`). 176 cards em 61 modelos.
- **PROGNE** ✅: ref `LP905184GG` ou `62501M`. modelGroup = primeiros 4-6 chars. 173 cards em 44 modelos.
- **ARMY** ✅: extrai do nome antes de `Tamanho:` (ex: "Calca Athleisure Armybr"). 168 cards em 16 modelos.
- **TOPPER** ✅: extrai `TP06140003` do nome. 34 cards em 34 modelos.
- **SALOMON** ✅: extrai modelo do nome (`X ULTRA 5 MID`, `GENESIS`). 71 cards em 12 modelos.
- **LUPO** ✅: ref `NNNNN-NNNNNNNNNN` (ex: `02170-0880460900`). modelGroup = primeiro segmento (5 dígitos). 215 cards em 42 modelos.
- **VOLLO** ✅: ref `VN200-3`, `VP1053`. modelGroup = primeiros 3-5 chars. 53 cards em 40 modelos.
- **HIDROLIGHT** ✅: ref `H93_2`, `EL16_3`. modelGroup = parte alfanum antes do `_`. 96 cards em 50 modelos.
- **Let's Gym** ✅: ref `2628AZ`, `2143BVDV`. modelGroup = primeiros 4 dígitos. 83 cards em 31 modelos.
- **Hope Resort** ✅: ref `HF332240VHD000G`. modelGroup = primeiros 8 chars (`HF332240`). 72 cards em 24 modelos.
- **NIKE / Body for Sure**: refs muito curtas (NIKE = 6 dígitos, BfS = 5 dígitos) sem decomposição visível. Cada ref provavelmente já é 1 produto único.

Quando o agrupamento por modelo for implementado, salvar em `aiContext.modelGroup` (string normalizada do modelo) e usar pra:
- Mostrar "também disponível em outras cores" no card
- Agrupar relatórios por modelo
- Curadoria/foto: 1 sessão cobre todas as variantes
- Cross-selling no PDV

### Fluxo conceitual completo do card (regra)

**Estrutura do card:**
- **Nome** = MODELO (ex: "Chuck Taylor All Star") — vem de `Product.name`
- **Marca** = criadora (ex: "Converse") — vem de `Product.brand`
- **Referência** = código do fornecedor pra essa cor (ex: `CK00040001`) — vem de `Product.sku` ou `aiContext.supplierRef`
- **Cor** = vem de `aiContext.color`
- **REF + COR mudam por variação**; nome+marca não.

**Miniaturas de outras cores (estilo On Running):**
Card mostra fileira de variantes (outros Products com mesma `aiContext.modelGroup`).
Ao clicar numa miniatura → recarrega info do card principal pra mostrar dados da cor clicada (SKU, tamanhos, loja). NÃO abre modal nem navega — substitui inline.

**SKU (código do tamanho) vem AUTOMATICAMENTE de duas fontes:**

1. **NFe de entrada** (XmlFiscalItem): a NFe traz `ean` (= SKU) + `description` (que contém o tamanho, ex: "TENIS X CHUCK TAYLOR 38"). Ao importar NFe, vincular ProductSize com `barcode=ean` e `size` extraído da description.

2. **Bipe**: vendedor escaneia código de barras numa loja. O sistema:
   - Busca ProductSize pelo `barcode=ean`
   - Se acha → atrela bipe a esse ProductSize, **estoque dessa Size na loja onde foi bipada**
   - **Se NÃO acha mas o ean existe em XmlFiscalItem** → cria ProductSize automaticamente (lê tamanho da description da NFe, productId da NFe, barcode=ean)
   - O bipe SEMPRE traz `storeId` (loja onde escaneou) → loja física do estoque

**Regra de ouro:** ao bipar, o sistema **sabe automaticamente** (1) qual produto é (via ean), (2) qual tamanho é (via NFe description), (3) qual loja é (via bipe.storeId). Vendedor não precisa preencher nada.

### ⚠️ REGRA INQUEBRÁVEL — Modelo de Estoque: COMPRADO (total) vs LOCALIZAÇÃO (bipe)

**Decisão do dono (2026-06-02), substitui o modelo "espelho" anterior:**

- **`ProductSize.stock` = COMPRADO.** É o TOTAL que a empresa tem daquele tamanho, vindo da **NFe de entrada** (compra de fornecedor). É um número FIXO. Só muda quando entra/sai NFe (compra ou venda). **NUNCA** é recalculado a partir do StoreStock.
- **`StoreStock` = LOCALIZAÇÃO.** Diz **em que loja** está cada unidade (via bipe/contagem). É PARCIAL — vai enchendo conforme as lojas bipam. `gap = comprado − Σ StoreStock` = "ainda não localizado / falta bipar".
- **Os dois DIVERGEM de propósito.** `ProductSize.stock` (comprado) ≠ `Σ StoreStock` (localizado) é o ESTADO NORMAL durante a contagem. Isso NÃO é bug, NÃO é divergência pra "consertar".

**PROIBIDO (corrompe o total comprado — Claude já fez isso e o dono barrou):**
- ❌ `recalcSizeStock()` / `ProductSize.stock = Σ StoreStock` em QUALQUER fluxo de bipe/ajuste/contagem.
- ❌ Tratar `ProductSize.stock` como "espelho" do StoreStock.
- ❌ Deployar `src/services/stockSync.js` ou os edits que adicionam recalc no bipe/apply-to-stock (ficam fora de propósito).

O bipe e o ajuste por loja mexem **só no StoreStock**. O comprado (`ProductSize.stock`) fica intocado.

### Bipe em tempo real (real-time)

**Cada bipe = +1 unidade NA HORA no StoreStock (LOCALIZAÇÃO).** NÃO soma no total comprado. Sem fluxo de "aplicar depois".

- `POST /api/stocktake/bipe` faz `prisma.storeStock.upsert({ ..., increment: 1 })` imediatamente
- **NÃO chama `recalcSizeStock`** — o total comprado (`ProductSize.stock`) NÃO pode ser mexido pelo bipe
- Marca `StocktakeBipe.applied = true` na criação
- Card do produto mostra a localização atualizada em segundos

**Regra de uso (dono confirmou):** vendedor bipa **UMA vez** cada unidade física. Se aparecer mais bipes da mesma SKU que a quantidade comprada na NFe → erro de bipagem detectável visualmente (card mostra comprado X vs bipado Y).

**Comparação visual no card** (já implementado em `/products/:id/nfe-summary`):
- COMPRADO (NFe entrada) vs BIPADO (StocktakeBipe contado) vs VENDIDO vs ESTOQUE
- Se BIPADO > COMPRADO → bipagem duplicada, dono identifica olhando

Não há "desfazer bipe" automático. Se erro for detectado, dono deleta o bipe manual em `/bipes.html` e ajusta StoreStock manual.

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

## REGRA PERMANENTE — Curadoria de FOTO precisa da COR (card = REF + cor)

A foto é **por CARD** (Product = referência + cor), nunca por tamanho. O curador (`src/services/curationAgent.js` → `curateProduct`) busca a imagem usando `aiContext.color`. **Se a cor estiver vazia, o Vision recebe "Cor declarada: (qualquer)"** (`src/services/visionValidator.js`, ~linha 63) e **NÃO penaliza cor errada** → entra foto do colorway errado.

**Regra:** antes de puxar foto, garantir `aiContext.color` preenchido. No curador, exigir `minScore >= 8` quando há cor (escala Vision: 8-9 = produto certo + cor certa/quase; **5-7 = modelo certo mas COR ERRADA** → rejeita; minScore default 4 deixa passar cor errada).

**De onde vem a cor:**
- **ADIDAS**: o código de **referência (REF) JÁ É o colorway**. Cada artigo (IE3100, JP9198, JC9555…) tem 1 página adidas com a cor exata. Buscar `marca + REF` na web → o título traz a cor (ex "DURAMO RC2 - Amarelo", "Samba ADV - Core Black/White/Gum"). Extrair daí.
- **HOKA / REEBOK / marcas sem REF no nome**: a cor sai do **`supplierCode` (cProd) da NFe**, que é o código de artigo `ESTILO+COR+TAMANHO` (ex HOKA `1162011CBLL44` = estilo 1162011 + cor CBLL + tam 44). MÉTODO VALIDADO (HOKA, 06/06/2026):
  1. **Agrupar/unificar por ESTILO+COR** (cProd sem os 2 dígitos finais): `1162011CBLL` = 1 card. Cada cProd = 1 colorway = 1 card. NUNCA juntar por foto (revendedor usa a mesma foto pra cores diferentes → junta errado).
  2. **Tamanho real** = 2 dígitos finais do cProd (39,40,41…). **Gênero** = pelo nº do estilo (ex Clifton 10 masc=1162030, fem=1162031; Mach 7 masc=1171904, fem=1171938).
  3. **Cor**: decodificar o código na web (WebSearch, ferramenta minha = grátis): "HOKA [modelo] [cProd]" → ex CBLL=Cobalt Blue/Ultramarine, PTYG=Putty/Grout, FYZ=Frost/Neon Yuzu, SLSSN=Sea Glass/Neon Flame, WWH=White/White, STLC=Stardust/Electric Cobalt, FCT=Frost/Citrus, FNK=Frost/Pink Twilight, FSTS=Frost/Solar Flare, EQB=Electric Aqua/Black.
  4. **Foto OFICIAL pelo cProd exato** (WebFetch numa loja com a URL do código exato: runningxpert/beckshoes/animasportiva deram URL direta). Conferir CADA foto **olhando** (download + Read) — fontes às vezes devolvem o colorway errado.
  - **Erro 06/06/2026 (origem):** unifiquei HOKA por foto de revendedor → juntei cores+gêneros diferentes (Clifton 10 = 3 colorways num card só; Mach 7 = 2) e chutei cores erradas (Bondi 9 = Azul Cobalto, eu pus "Branco/Cinza"; Mach 7 = Frost claro, eu pus "Preto"). Dono: "vixe como ta errado". Refeito pelo cProd da NFe: 30 cards bagunçados → 11 corretos, foto oficial verificada. Scripts: `scripts/rebuild-hoka.js`.

**Erro 04/06/2026 (origem):** puxei 161 fotos dos produtos de 2026 SEM cor (0/163 tinham cor). Cor errada (JP9198 Duramo era amarelo, peguei branco/preto; JC9555 era camiseta preta, peguei conjunto verde infantil). Dono: "a porra da cor vc ta levando em consideração?". Corrigido derivando cor do REF + Vision score>=8. Final: **100/163 com cor, 150/163 com foto cor-validada, 13 sem foto** (preferir sem foto a cor errada).

**Endpoint temporário fora de /api/admin:** pra rodar curador server-side por curl sem JWT (chaves Serper/Vision só no servidor), a rota tem que ficar **FORA de `/api/admin`** — o `adminRoutes` montado em `/api/admin` (index.js ~linha 120) tem `authMiddleware` blanket que sombreia TUDO sob esse prefixo, mesmo rotas registradas depois. Usar `app.post('/api/_xxx', handler)` antes dos mounts + guard `?g=`. Remover após uso.

## REGRA PERMANENTE — Bipes órfãos voltam quando a NFe de entrada chega

Bipe `StocktakeBipe.found=false` = barcode não casou com `ProductSize.barcode` NEM `XmlFiscalItem.ean` **na hora do bipe**. Quando a NFe de entrada do produto é importada depois (traz o EAN), esses bipes ficam **recuperáveis**.

Reconciliar com `scripts/match-bipes-com-xml.js --apply`: cruza barcode↔ean, cria/vincula ProductSize (tamanho lido da descrição da NFe) **DENTRO do card existente** (nunca card novo) e marca `found=true`. **NÃO mexe em StoreStock** (localização fica pro "aplicar" do dono em bipes.html). Sempre rodar `scripts/_bipes_backup.js` antes.

04/06/2026: importadas NFes de 2026 → cruzei os 7.012 bipes órfãos: 2.147 viraram found=true (740 ProductSize criados + 442 vinculados). 346 eram especificamente de 2026 (73 produtos). Origem da regra: dono perguntou "vc já conferiu se os bips nao achados podem ser destes?".

## MÉTODO PERMANENTE — Limpeza/unificação de marca pelo CÓDIGO da NFe (o "modo de agir pra não errar")

**Quando usar:** marca com cards fragmentados, cor errada/vazia, tamanhos faltando, ou cards que "nasceram do bipe" (só têm os tamanhos bipados). Aplicado: HOKA (06/06/2026: 30 cards bagunçados → 12 certos), Reebok (23 colorways limpos).

**A FONTE DA VERDADE é a NFe de ENTRADA, NUNCA a foto/cor de revendedor.** O `XmlFiscalItem.supplierCode` (cProd) é o código de artigo = `ESTILO + (GÊNERO) + COR + TAMANHO`. Dele sai TUDO:
- **Referência (1 card)** = supplierCode SEM os 2 dígitos finais (o tamanho). Cada código distinto = 1 colorway = 1 card.
- **Tamanho real** = os 2 dígitos finais (calçado 33–48). Half size = `.5`.
- **Gênero** = letra M/W no código OU nº do estilo (HOKA: Clifton 10 masc=1162030, fem=1162031; Reebok: `100xxxxxxx[M/W]`).
- **Cor** = decodificar o código de cor na web (WebSearch/WebFetch = ferramenta MINHA = grátis pro dono). Ex HOKA CBLL=Cobalt Blue, PTYG=Putty/Grout; Reebok ROYCZ/ROYAZ etc → buscar "Reebok [modelo] [artigo]".

**Passo a passo:** (1) diagnosticar a NFe entrada da marca, agrupar por (código−tamanho), ver fragmentação + tamanhos sem ProductSize. (2) decodificar cada cor na web pelo artigo. (3) montar mapa CÓDIGO→{modelo,cor,gênero,modalidade,tier}. (4) script de sync (modelo `sync-hoka-nfe.js`/`sync-reebok-nfe.js`): 1 card/código, tamanho real, cor+gênero+classificação, cria tamanhos faltando (comprado=qtd NFe), desativa cards antigos esvaziados — **backup antes, DRY-RUN antes de --apply**. (5) foto OFICIAL por código (WebFetch retailer com a URL do código exato; HOKA=runningxpert/beckshoes/animasportiva, Reebok=novelship — reebok.com bloqueia; artigo BR às vezes só na loja → equipe fotografa). **CONFERIR cada foto baixando + Read (eu OLHO).** Salvar base64 no banco.

**AS 6 REGRAS ANTI-ERRO (cada uma = erro que cometi e o dono pegou):**
1. ❌ **NUNCA unificar por FOTO.** Revendedor usa a mesma foto pra cores diferentes → junta colorways/gêneros errados (erro HOKA: Clifton 10 = 3 cores + 2 gêneros num card só). ✅ Unificar SÓ pelo código da NFe.
2. ❌ **NUNCA chutar cor de foto de revendedor** (erro: Bondi 9 era Azul Cobalto, pus "Branco/Cinza"; Mach 7 era Frost claro, pus "Preto"). ✅ Cor sai do código, decodificada na web.
3. ❌ **NUNCA assumir que o card tem todos os tamanhos.** Card nascido do bipe só tem os tamanhos bipados — os comprados-não-bipados somem. ✅ Sincronizar da NFe (`create-missing-nfe-sizes.js` recuperou 406 tam/790 un em 06/06).
4. ❌ **Tamanho: não chutar do código se não for plausível** (ia botar "90"/"88"). ✅ Só 33–48 ou P–GG; senão placeholder `T-<EAN>`, nunca número errado.
5. ❌ **Bipe found=true NÃO conta se applied=false** (não entra no StoreStock). ✅ Aplicar (`apply-found-bipes.js`: 2.910 bipes/507 produtos em 06/06). Mexe SÓ no localizado, nunca no comprado.
6. ❌ **NÃO fazer metade nem hedge** (dono: "eu nao entendo pq vc cogita fazer metade"). ✅ Terminar a marca INTEIRA. Se um pedaço estiver REALMENTE travado (foto de artigo BR sem fonte web), rotear certo (equipe na conferência / curador pago) — explicar, não "pular".

**Disciplina sempre:** backup antes de escrever · dry-run antes de --apply · transação por item · CONFERIR olhando · respeitar regras inquebráveis (comprado=NFe e NUNCA recalc do StoreStock; transferência NUNCA cria card).

**Scripts reutilizáveis:** `sync-hoka-nfe.js` · `sync-reebok-nfe.js` (sync por código) · `rebuild-hoka.js` · `create-missing-nfe-sizes.js` (tamanhos faltando) · `apply-found-bipes.js` (aplica bipes reconhecidos) · `unify-by-reference.js` (unifica por REF:/cProd, catálogo todo).
