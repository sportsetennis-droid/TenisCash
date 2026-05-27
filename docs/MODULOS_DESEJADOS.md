# MÓDULOS DESEJADOS — TenisCash

> Proposta de organização de código.
> **Nenhum arquivo será movido, renomeado ou alterado neste documento.** Apenas direção.
> Data: 26/05/2026

---

## 1. Princípios

- **Separar bounded contexts** (Carteira ≠ Catálogo ≠ Bipe ≠ Fiscal ≠ APEX).
- **Reduzir acoplamento** entre módulos.
- **Centralizar integrações externas** em camada compartilhada.
- **Permitir extração futura** de módulos (ex: APEX virar repo próprio).
- **Manter retrocompatibilidade** durante a transição.

---

## 2. Estrutura proposta (alto nível)

```
src/
├── modules/
│   ├── carteira/         # TenisCash loyalty
│   ├── catalogo/         # Produto, Categoria, Fornecedor, Markup
│   ├── inventario/       # StoreStock, ajustes
│   ├── bipe/             # Stocktake + bipar.html
│   ├── fiscal/           # NFe, NFCe, SEFAZ
│   ├── rh/               # Vendedores, ponto, entrevistas
│   ├── vendas/           # Sale, SaleItem, Commissions
│   ├── mensagens/        # Messages, WhatsApp, Push
│   ├── marketing-ia/     # Creative gen (Flux, GPT), copy, brand profiles
│   ├── curadoria-vitrine/ # StoreCuration
│   ├── ecommerce/        # Nuvemshop, Shipping
│   ├── financeiro/       # AccountPayable, Receivable
│   ├── apex/             # App esportivo (extraível como repo)
│   └── admin/            # Usuários, permissões, auditoria
├── shared/
│   ├── prisma/           # Prisma client + migrations
│   ├── middleware/       # auth, store scope, rate limit
│   ├── utils/            # timezone, escape, format, validators
│   └── integrations/     # wrappers de APIs externas
└── index.js              # apenas boot e mount

public/
├── admin/                # admin.html quebrado por aba
├── vendedor/             # bipar.html, portal vendedor
├── cliente/              # loja.html, app cliente
└── shared/               # _product-card.js, _design-system

scripts/
├── one-shot/             # scripts antigos a serem deletados
├── ops/                  # backup, restore, deploy, health
└── data-migration/       # migrações controladas
```

---

## 3. Módulos detalhados

### A. `modules/carteira` (TenisCash)
**Responsabilidades:** login, carteira, transferências, promoções, QR, parceiros, perfil de vida.
- Routes: `auth.js`, `wallet.js`, `transfer.js`, `promo.js`, `qr.js`, `partners.js`, `life.js`
- Tabelas: User, Transaction, Promo, Partner, PartnerSale, UserLifeProfile, UserMoodCheckin, UserTrainingLog
- **Risco para extração:** 🟡 MÉDIO (User é compartilhado com vários módulos)

### B. `modules/catalogo`
**Responsabilidades:** Cadastro de produtos, categorias, fornecedores, markup, classificação IA.
- Routes: `catalog.js`, `adminCatalog.js`, `products.js`, `categories.js`, `productImages.js`, `markup.js`, `inventory.js` (parcial — só /products), `suppliers.js`, `adminClassification.js`, `aiCuration.js`
- Tabelas: Product, ProductSize, CategoryNode, Supplier, ProductLifecycle, BrandRule
- **Risco para extração:** 🔥 ALTO (é o cérebro do sistema)

### C. `modules/inventario`
**Responsabilidades:** Estoque por loja, ajustes manuais, contagem.
- Routes: parte de `inventory.js` (ajuste manual)
- Tabelas: StoreStock
- **Risco para extração:** 🔥 ALTO (real-time, vendedores ativos)

### D. `modules/bipe`
**Responsabilidades:** Bipe físico em loja, contagem por código de barras.
- Routes: `stocktake.js`
- HTMLs: `bipar.html`, `bipes.html`
- Tabelas: StocktakeBipe
- **Dependências:** ProductSize (catalogo), StoreStock (inventario)
- **Risco para extração:** 🔥 ALTO (produção, vendedores trabalhando)

### E. `modules/fiscal`
**Responsabilidades:** Importação NFe, emissão NFCe, integração SEFAZ.
- Routes: `fiscal.js`, `xmlImport.js`
- Services: `fiscalApi.js`, `fiscalAcquirers.js`, `fiscalAgentClient.js`, `fiscalDraftJob.js`, `fiscalSefazDirect.mjs`, `xmlNfeParser.js`, `nfeSizeParser.js`
- Tabelas: XmlFiscalDocument, XmlFiscalItem, FiscalIssuer, FiscalDocument, XmlImportJob, XmlExportJob, FiscalWebhookLog
- **Risco para extração:** 🔥 ALTO. Importação NFe errada contamina catálogo (já criou 1.085 + 900 Products indevidos em 26/05). Emissão NFCe (`fiscalSefazDirect.mjs`) é via cert digital e bate no SEFAZ — bug = loja sem emissão fiscal. `fiscalDraftJob` é cron que precisa rodar em `America/Fortaleza`.

### F. `modules/rh`
**Responsabilidades:** Vendedores, ponto digital, entrevistas, mood.
- Routes: `seller.js`, `sellers.js`, `sellerPortfolio.js`, `weeklyInterview.js`, `stores.js`
- Tabelas: Store, ClockIn, ClockSummary, SellerWallet, SellerClient, SellerPortfolio, SellerCustomerAssignment, CustomerInteraction, SellerTask, SellerWeeklyInterview, SellerInterviewAnswer, SellerInsight, SellerMoodLog, SellerProductFeedback, SellerTrendReport, SellerTraining
- **Risco para extração:** 🟢 BAIXO

### G. `modules/vendas`
**Responsabilidades:** Vendas, comissões.
- Tabelas: Sale (4), SaleItem (4), SaleCommission (0), BrandCommission (0)
- **Status:** Quase vazio hoje, mas é tabela de negócio. Não significa que é seguro mexer — significa que ainda não foi integrado com PDV.
- **Risco para extração:** ⚠️ **NÃO CLASSIFICAR como baixo risco sem validação adicional.** Antes de qualquer extração: confirmar com o dono se o PDV físico vai integrar com `Sale` em breve, e se sim em que prazo. Mexer agora pode forçar retrabalho assim que o PDV ligar.

### H. `modules/mensagens`
**Responsabilidades:** Messages, WhatsApp Business, Push notifications.
- Routes: `messages.js` (legado?), `messagesV2.js`, `whatsapp.js`
- Services: `messagesCron.js`, `systemMessenger.js`, `pushNotifications.js`
- Tabelas: Message, Channel, Timeline, TimelineMember, TimelinePost, Conversation, ChatMessage, Reaction, PushSubscription, Task, TaskExecution
- **Risco para extração:** 🟡 MÉDIO (3 sistemas distintos misturados — Messages v1, v2 e WhatsApp Cloud)

### I. `modules/marketing-ia`
**Responsabilidades:** Geração de criativos, copy, brand profiles, publicação em redes sociais.
- Routes: `marketing.js`, `marketingConfig.js`, `brandProfiles.js`, `ai.js`, `anthropicTools.js`, `orchestrator.js`, `recommendations.js` (⚠️ `aiCuration.js` NÃO faz parte deste módulo — ver `modules/curadoria-produto-ia` abaixo)
- Services: `compositeImage.js`, `collageImage.js`, `falAi.js`, `openaiImage.js`, `copyGenerator.js`, `marketingPrompts.js`, `marketingCron.js`, `marketingConfig.js`, `productEnrichmentAI.js`, `retailOrchestrator.js`, `visionValidator.js`, `visionBatchValidator.js`, `instagramPublisher.js`, `meta.js`, `slackNotifier.js`
- Tabelas: BrandProfile (10), ProductCreative (85), MarketingPublication, AIConversation, AIAgent, AIOrchestration, AIOrchestrationTask, AIApproval, AILog, AiRecommendation, UserRecommendation, UserAction
- **Risco para extração:** 🟡 **MÉDIO/ALTO**, NÃO baixo:
  - `marketingCron` é cron ativo — exige timezone `America/Fortaleza`.
  - `instagramPublisher` publica em rede social pública — bug = post errado ao vivo.
  - Cada chamada custa $ (Anthropic + fal.ai + OpenAI) — loop bugado queima crédito.
  - 16 services interdependentes — extração mal feita quebra geração de criativos da loja.

### J. `modules/curadoria-vitrine` (StoreCuration — visual de loja física)
**Responsabilidades:** Curadoria física da vitrine — fotos, zonas, checklist, resultado.
- Routes: `curation.js`
- Tabelas: `StoreCuration`, `StoreCurationZone`, `StoreCurationItem`, `StoreCurationChecklist`, `StoreCurationPhoto`, `StoreCurationResult`
- **Status:** Modelagem feita, **todas as tabelas vazias**, zero uso em produção.
- **Risco para extração:** 🟢 BAIXO — candidato seguro a Fase 1.

### J-bis. `modules/curadoria-produto-ia` (aiCuration — IA classifica produto)
**Responsabilidades:** Curadoria de produto via IA (classificação, nome, foto, descrição, atributos).
- Routes: `aiCuration.js`
- Services: `curationAgent.js`, `productEnrichmentAI.js` (compartilhado com marketing)
- Endpoint chave: `POST /api/admin/ai-curation/product/:id`
- **Status:** Altamente ativo — **6.170 produtos curados de 7.093**.
- **Risco para extração:** 🔥 ALTO. Mexer pode reverter estado curado, quebrar enriquecimento ou apagar `aiContext` (modelGroup, color, supplierRef).
- **⚠️ NÃO confundir com Curadoria de Vitrine.** São módulos diferentes. Curadoria de Vitrine é safe; Curadoria de Produto é crítico.

### K. `modules/ecommerce`
**Responsabilidades:** Sincronização com Nuvemshop, shipping.
- Routes: `nuvemshop.js`, `shipping.js`
- Services: `nuvemshop.js`, `nuvemshopHandlers.js`
- Tabelas: NuvemshopConnection, NuvemshopWebhookEvent, NuvemshopSyncLog, NuvemshopProductMapping, NuvemshopVariantMapping, NuvemshopOrderMapping, NuvemshopCustomerMapping
- **Risco para extração:** 🟡 MÉDIO (sync ativo com produção Nuvemshop)

### L. `modules/financeiro`
**Responsabilidades:** Contas a pagar/receber.
- Route: `financial.js`
- Tabelas: AccountPayable, AccountReceivable
- **Status:** Pouco volume, mas é financeiro.
- **Risco para extração:** ⚠️ **NÃO CLASSIFICAR como baixo risco sem validação adicional.** Antes de qualquer extração: confirmar com o dono se há lançamentos reais sendo feitos e se há fechamento contábil dependente. Toda regra que toca financeiro precisa de plano revisável (regra global do projeto).

### M. `modules/apex` (app esportivo) ✅ **EXTRAÍDO**
**Responsabilidades:** Atividades, treinos, clubes, segments, badges, coach IA.
- **Status físico:** módulo já vive em `src/modules/apex/`.
  - `src/modules/apex/README.md`
  - `src/modules/apex/routes/activities.js`
  - `src/modules/apex/routes/coach.js`
  - `src/modules/apex/services/activityIngest.js`
  - `src/modules/apex/services/aiCoach.js`
- **Commits da extração (26/05/2026):**
  - `c070555` refactor(apex): mover rota activities para modulo APEX
  - `0af78f7` refactor(apex): mover rota coach para modulo APEX
  - `29ff92b` refactor(apex): mover service activityIngest para modulo APEX
  - `903f2e2` refactor(apex): mover service aiCoach para modulo APEX
- **Validação final:** APROVADA (ver `docs/RELATORIO_VALIDACAO_FINAL_APEX` no histórico de turnos, ou se promovido a arquivo, em `docs/`).
- Mount points públicos preservados: `/api/activities` e `/api/coach` permanecem literalmente iguais ao baseline.
- Schema Prisma **não foi tocado** — os 21 modelos APEX continuam em `prisma/schema.prisma`.
- Tabelas: AthleteProfile, Consent, DeviceConnection, Activity, ActivityLap, ActivityPhoto, Route, RoutePoint, Segment, SegmentEffort, Club, ClubMembership, Challenge, ChallengeParticipation, TrainingPlan, Workout, WorkoutStep, UserPlan, SafetyContact, LiveTrackingSession, BadgeEarned — todas vazias ou quase vazias.
- **Próximo passo opcional não executado:** criação de `src/modules/apex/index.js` re-exportando routes — adiado (não obrigatório, sem benefício no curto prazo).

### N. `modules/admin`
**Responsabilidades:** Usuários, permissões, auditoria, dashboard.
- Routes: `admin.js`
- Tabelas: AdminAction
- **Risco para extração:** 🟡 MÉDIO (controla acesso de tudo)

---

## 4. Camada `shared/`

### `shared/prisma/`
- `client.js` — instância Prisma compartilhada
- `schema.prisma` — fica aqui (não dá pra quebrar fácil)
- Considerar **schemas Postgres separados** futuramente (não obrigatório agora)

### `shared/middleware/`
- `auth.js` — authMiddleware
- `adminOrManager.js` — adminMiddleware (suporta admin/superadmin/manager)
- `storeScope.js` — escopo por loja
- `rateLimit.js` — rate limit configurável

### `shared/utils/`
- `timezone.js` — `America/Fortaleza` constants
- `escape.js` — escape HTML/SQL
- `format.js` — moeda BRL, datas
- `validators.js` — CPF, CNPJ, EAN

### `shared/integrations/`
Wrappers finos pra cada integração externa:
- `anthropic.js`
- `fal.js`
- `openai.js`
- `meta.js` (FB/IG/WhatsApp)
- `nuvemshop.js`
- `resend.js`
- `slack.js`
- `webPush.js`
- `serper.js`
- `google.js`
- `brave.js`

---

## 5. Frontend (`public/`)

### Hoje
Tudo num lugar só. `admin.html` tem 10.604 linhas com TODAS as abas.

### Proposta
```
public/
├── admin/
│   ├── index.html             # esqueleto + nav
│   ├── tabs/
│   │   ├── usuarios.html
│   │   ├── vendedores.html
│   │   ├── catalogo.html
│   │   ├── estoque.html
│   │   ├── categorias.html
│   │   ├── curadoria.html
│   │   ├── fiscal.html
│   │   ├── financeiro.html
│   │   ├── marketing.html
│   │   ├── ... (etc)
│   └── shared.js              # api(), token, helpers
├── vendedor/
│   ├── bipar.html
│   ├── bipes.html
│   └── portal.html
├── cliente/
│   ├── index.html
│   └── loja.html
└── shared/
    ├── _product-card.js
    ├── _design-system.js
    ├── _design-system.css
    └── _product-search-bar.js
```

---

## 6. Scripts (`scripts/`)

### Hoje
60 arquivos misturando: importação, classificação, unificação, fix de dado, sync, exports, cleanup.

### Proposta
```
scripts/
├── one-shot/
│   ├── ARCHIVED-2025-*/   # já executados, mantidos pra histórico
│   └── *.js               # awaiting one-time execution
├── ops/
│   ├── backup-db.js
│   ├── restore-db.js
│   └── health-check.js
├── data-migration/
│   ├── 2026-05-26-modelGroup-converse.js
│   └── ...
└── README.md              # explicar cada script e seu status
```

**Cada script deve declarar:**
- Quando rodar (data, contexto)
- O que faz
- Se é destrutivo
- Como reverter

---

## 7. Ordem sugerida de extração

### Fase 1 — Sem risco produtivo (ordem segura de primeira extração)
1. ✅ **APEX** — **EXTRAÍDO em 26/05/2026** (commits `c070555`, `0af78f7`, `29ff92b`, `903f2e2`). Padrão de extração modular validado em produção sem incidente.
2. **Etiquetas** (`labels.js` + `labelGenerator.js`, isolado, sem cron, sem integração externa) ← próximo candidato natural
3. **Curadoria de Vitrine** (StoreCuration — todas as tabelas vazias, sem uso em produção)
4. **Life** (`life.js` + `UserLifeProfile`, isolado)

### Fase 2 — Risco médio (exigem instrumentação + canário)
- RH / Vendedores (`seller.js`, `sellers.js`, `sellerPortfolio.js`, `weeklyInterview.js`, `stores.js`)
- Mensagens (separar V1, V2 e WhatsApp; tratar `messagesCron`)
- E-commerce (Nuvemshop — sync ativo)
- Admin / Auth (controla acesso de tudo)
- **Marketing IA** — movido pra cá por ter `marketingCron`, `instagramPublisher` em produção, custo $ por chamada e 16 services interdependentes.

### Fase 3 — Alto risco (extração só com paralelismo + flag + rollback ensaiado)
- **Fiscal** (NFe import + NFCe SEFAZ — já contaminou catálogo 2x neste mês; cron exige timezone correto)
- **Curadoria de Produto IA** (aiCuration — 6.170 produtos curados, risco de reverter estado)
- Catálogo (`adminCatalog`, `products`, `categories`, `markup`, `productImages`)
- Inventário (StoreStock)
- **Bipe (último — máximo cuidado)**

### Não classificáveis sem validação adicional
- **Vendas (Sale, SaleItem, SaleCommission)** — tabela vazia hoje, mas é tabela de negócio. Antes de extrair: confirmar com o dono se o PDV físico vai integrar em breve.
- **Financeiro (AccountPayable, AccountReceivable)** — financeiro real. Antes de extrair: confirmar fechamento contábil + lançamentos ativos.

---

## 8. Riscos transversais

- **Schema Prisma único** — refatoração de schema é cara. Considerar manter 1 schema com seções comentadas, ao invés de quebrar.
- **`_product-card.js`** — usado em ~6 telas. Mudar assinatura quebra tudo. Manter retrocompatível.
- **Endpoint `/admin/inventory/products`** — cérebro do catálogo. Não substituir; criar novo paralelo e migrar consumidores um a um.
- **Auth** — middleware único hoje. Não duplicar lógica de checagem de role.

---

## 9. Princípios de migração

1. **Não quebrar produção.** Vendedores estão bipando agora.
2. **Paralelismo:** módulo antigo continua funcionando até o novo estar estável.
3. **Feature flag por módulo** se necessário.
4. **Reversibilidade:** todo passo deve poder ser desfeito.
5. **Documentar antes de mover.**

---

**Este documento é apenas direção. Nenhum arquivo será movido ou renomeado sem ordem explícita.**
