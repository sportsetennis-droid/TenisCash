# MAPA ATUAL — TenisCash

> Diagnóstico **somente leitura**, sem qualquer alteração de código, rotas, banco ou comportamento.
> Data: 26/05/2026 · Branch: `organizacao/refactor-2026-05-26`

---

## 1. Dimensão do sistema (fatos observados)

| Camada | Quantidade | Linhas |
|---|---|---|
| `src/routes/*.js` | 44 arquivos | 16.618 |
| `src/services/*.js` | 48 arquivos | 8.599 |
| `public/*.html` | 13 arquivos | — |
| `public/admin.html` (sozinho) | 1 arquivo | **10.604** |
| `scripts/*.js` | 60 arquivos | — |
| `prisma/schema.prisma` | 1 arquivo | 2.475 (**114 models**) |
| Vars de ambiente (integrações externas) | 28 chaves | — |

**Mount points em `src/index.js`:** ~44 prefixos (`/api/...`).

---

## 2. Funcionalidades existentes (agrupadas)

### A. Carteira / TenisCash (loyalty)
- Routes: `auth.js`, `wallet.js`, `transfer.js`, `promo.js`, `qr.js`, `partners.js`, `life.js`
- Tabelas: `User`, `Transaction`, `Promo`, `Partner`, `PartnerSale`, `UserLifeProfile`

### B. Catálogo de produtos
- Routes: `catalog.js`, `adminCatalog.js`, `products.js`, `categories.js`, `productImages.js`, `markup.js`, `inventory.js`, `suppliers.js`, `adminClassification.js`, `aiCuration.js`
- Tabelas: `Product` (8.173), `ProductSize` (11.082), `CategoryNode` (137), `Supplier` (88), `ProductLifecycle`, `BrandRule`

### C. Bipe / Contagem física
- Routes: `stocktake.js`
- HTMLs: `bipar.html`, `bipes.html`
- Tabelas: `StocktakeBipe` (2.846), `StoreStock` (9.196)

### D. NFe / Fiscal
- Routes: `fiscal.js`, `xmlImport.js`
- Services: `fiscalApi.js`, `fiscalAcquirers.js`, `fiscalAgentClient.js`, `fiscalDraftJob.js`, `fiscalSefazDirect.mjs`, `xmlNfeParser.js`, `nfeSizeParser.js`
- Tabelas: `XmlFiscalDocument` (623), `XmlFiscalItem` (17.794), `FiscalIssuer` (6), `FiscalDocument` (9), `XmlImportJob`, `XmlExportJob`, `FiscalWebhookLog`

### E. Vendedores / Lojas / RH
- Routes: `seller.js`, `sellers.js`, `sellerPortfolio.js`, `weeklyInterview.js`, `stores.js`
- Tabelas: `Store` (6), `ClockIn`, `ClockSummary`, `SellerWallet`, `SellerClient`, `SellerPortfolio`, `SellerCustomerAssignment`, `CustomerInteraction`, `SellerTask`, `SellerWeeklyInterview`, `SellerInterviewAnswer`, `SellerInsight`, `SellerMoodLog`, `SellerProductFeedback`, `SellerTrendReport`, `SellerTraining`

### F. Vendas / Comissões
- Tabelas: `Sale` (4), `SaleItem` (4), `SaleCommission` (0), `BrandCommission` (0)
- **Pouco código ativo — possivelmente dependente de integração futura**

### G. Mensagens / WhatsApp
- Routes: `messages.js`, `messagesV2.js`, `whatsapp.js`
- Services: `messagesCron.js`, `systemMessenger.js`
- Tabelas: `Message`, `Channel`, `Timeline`, `TimelineMember`, `TimelinePost`, `Conversation`, `ChatMessage`, `Reaction`, `PushSubscription`, `Task`, `TaskExecution`

### H. IA / Marketing
- Routes: `marketing.js`, `marketingConfig.js`, `brandProfiles.js`, `ai.js`, `aiCuration.js`, `anthropicTools.js`, `orchestrator.js`, `recommendations.js`
- Services: `compositeImage.js`, `collageImage.js`, `falAi.js`, `openaiImage.js`, `copyGenerator.js`, `marketingPrompts.js`, `marketingCron.js`, `marketingConfig.js`, `productEnrichmentAI.js`, `curationAgent.js`, `retailOrchestrator.js`, `visionValidator.js`, `visionBatchValidator.js`, `instagramPublisher.js`, `meta.js`, `slackNotifier.js`
- Tabelas: `BrandProfile` (10), `ProductCreative` (85), `MarketingPublication`, `AIConversation`, `AIAgent`, `AIOrchestration`, `AIOrchestrationTask`, `AIApproval`, `AILog`, `AiRecommendation`, `UserRecommendation`, `UserAction`

### I. Etiquetas / Impressão — **EXTRAÍDO** para `src/modules/labels/`
- **Status:** módulo extraído com sucesso em 26/05/2026. Três commits atômicos: `7dc6bd0` (estrutura inicial), `b580c25` (route), `659bef3` (service). Validação final aprovada (`RELATORIO_VALIDACAO_FINAL_LABELS`).
- Route (em `src/modules/labels/routes/`): `labels.js`
- Service (em `src/modules/labels/services/`): `labelGenerator.js`
- README do módulo: `src/modules/labels/README.md`
- Mount point público preservado: `/api/admin/labels`
- Tabelas (continuam em `prisma/schema.prisma`, não foram movidas): `LabelTemplate`, `LabelBatch`, `LabelItem`, `LabelPrintLog`

### J. Curadoria de vitrine (StoreCuration)
- Route: `curation.js`
- Tabelas: `StoreCuration`, `StoreCurationZone`, `StoreCurationItem`, `StoreCurationChecklist`, `StoreCurationPhoto`, `StoreCurationResult` (todas vazias)

### K. Campanhas
- Route: `campaigns.js`
- Tabelas: `Campaign` (0), `CampaignCustomer` (0), `CampaignProduct` (0)

### L. Nuvemshop / E-commerce
- Routes: `nuvemshop.js`, `shipping.js`
- Services: `nuvemshop.js`, `nuvemshopHandlers.js`
- Tabelas: `NuvemshopConnection`, `NuvemshopWebhookEvent`, `NuvemshopSyncLog`, `NuvemshopProductMapping`, `NuvemshopVariantMapping`, `NuvemshopOrderMapping`, `NuvemshopCustomerMapping`

### M. Financeiro
- Route: `financial.js`
- Tabelas: `AccountPayable`, `AccountReceivable`

### N. APEX (app esportivo — **EXTRAÍDO** para `src/modules/apex/`)
- **Status:** módulo extraído com sucesso em 26/05/2026. Quatro commits atômicos: `c070555`, `0af78f7`, `29ff92b`, `903f2e2`. Validação final aprovada (ver `docs/PLANO_EXTRACAO_APEX.md`).
- Routes (em `src/modules/apex/routes/`): `activities.js`, `coach.js`
- Services (em `src/modules/apex/services/`): `activityIngest.js`, `aiCoach.js`
- README do módulo: `src/modules/apex/README.md`
- Mount points públicos preservados: `/api/activities`, `/api/coach`
- Tabelas (continuam em `prisma/schema.prisma`, não foram movidas): `AthleteProfile`, `Consent`, `DeviceConnection`, `Activity`, `ActivityLap`, `ActivityPhoto`, `Route`, `RoutePoint`, `Segment`, `SegmentEffort`, `Club`, `ClubMembership`, `Challenge`, `ChallengeParticipation`, `TrainingPlan`, `Workout`, `WorkoutStep`, `UserPlan`, `SafetyContact`, `LiveTrackingSession`, `BadgeEarned` (todas vazias ou quase vazias)

### O. Admin / Auth / Permissões
- Routes: `admin.js`, `auth.js`
- Middleware: `src/middleware.js` (authMiddleware, adminMiddleware, storeScope)
- Tabelas: `AdminAction`

---

## 3. Endpoints (mount points em `src/index.js`)

```
/api/auth                /api/wallet                /api/transfer
/api/promos              /api/admin                 /api/qr
/api/seller              /api/stores                /api/messages
/api/sellers             /api/catalog               /api/ai
/api/admin/catalog       /api/admin/ai              /api/life
/api/admin/labels        /api/admin/fiscal          /api/admin/curation
/api/seller/portfolio    /api/seller/interview      /api/admin/xml
/api/admin/recommendations    /api/admin/financial
/api/admin/suppliers     /api/admin/categories      /api/admin/campaigns
/api/admin/inventory     /api/admin/product-images  /api/admin/markup
/api/admin/products      /api/admin/ai-curation     /api/admin/anthropic-tools
/api/admin/orchestrator  /api/admin/classification
/api/activities          /api/coach                 /api/whatsapp
/api/stocktake           /api/messages-v2           /api/marketing
/api/marketing-config    /api/brand-profiles
/api (nuvemshop, partners)    /api/shipping
```

---

## 4. Tabelas do banco (114 models)

### Com volume (uso ativo)
- `Product` (8.173), `ProductSize` (11.082), `StoreStock` (9.196)
- `StocktakeBipe` (2.846), `XmlFiscalItem` (17.794), `XmlFiscalDocument` (623)
- `CategoryNode` (137), `Supplier` (88), `User` (43), `Transaction` (53)
- `ProductCreative` (85), `BrandProfile` (10), `Store` (6), `FiscalIssuer` (6), `Config` (3)
- `Sale` (4), `SaleItem` (4), `FiscalDocument` (9)

### Vazias ou quase vazias (modelagem feita antes do uso)
~60 tabelas: SaleCommission, BrandCommission, Campaign*, Partner*, ProductLifecycle, StoreCuration*, **todo o módulo APEX** (Athlete*, Activity*, Route*, Segment*, Club*, Challenge*, TrainingPlan, Workout, BadgeEarned), Timeline/Conversation/ChatMessage, AIOrchestration/AIAgent/AIApproval/AILog, Quiz/QuizQuestion/QuizAttempt, Task/TaskExecution, MarketingPublication, Channel, BrandRule.

**Fato:** 52% das tabelas estão vazias.

---

## 5. Funções que ALTERAM dados (críticas)

40 dos 44 routes fazem `prisma.*.create/update/delete`. Concentração:

| Tabela | Alterada por | Nível de risco |
|---|---|---|
| `StoreStock` | `stocktake.js` (bipe upsert), `inventory.js` (ajuste manual), `nuvemshopHandlers.js` (sync), múltiplos scripts | 🔥 ALTO — dado de estoque |
| `Product` | `adminCatalog.js`, `products.js`, `aiCuration.js`, `inventory.js`, `xmlImport.js`, scripts (`unify-*`, `consolidate-*`, `auto-classify-*`) | 🔥 ALTO |
| `ProductSize` | `adminCatalog.js`, `stocktake.js` (**fallback NFe LIGADO**, linha ~104), `inventory.js`, scripts | 🔥 ALTO |
| `XmlFiscalItem.productId` | scripts (`match-bipes-com-xml`, `create-products-from-nfe-pending`, `consolidate-*`) | 🔥 ALTO |
| `User.role` | `admin.js` (assign/remove seller/manager) | 🟡 MÉDIO |
| `StocktakeBipe` | `stocktake.js` | 🟡 MÉDIO |
| `Transaction` | `wallet.js`, `transfer.js`, `promo.js` | 🟡 MÉDIO |
| `CategoryNode` | `categories.js` | 🟢 BAIXO |
| `BrandProfile` | `brandProfiles.js`, `marketingConfig.js` | 🟢 BAIXO |

---

## 6. Integrações externas (28 envs)

| Serviço | Variáveis observadas | Onde |
|---|---|---|
| Anthropic (Claude) | ANTHROPIC_API_KEY, AI_MODEL, AI_VISION_MODEL, AI_*_MODEL | `copyGenerator`, `visionValidator`, `productEnrichmentAI`, `curationAgent`, orchestrator |
| fal.ai (Flux) | FAL_KEY | `falAi`, `compositeImage`, `collageImage` |
| OpenAI | OPENAI_API_KEY | `openaiImage` |
| Brave Search | BRAVE_API_KEY | `braveImageSearch` |
| Google Custom Search | GOOGLE_API_KEY, GOOGLE_CSE_ID | `googleImageSearch` |
| Serper | SERPER_API_KEY | `serperWebSearch`, `serperImageSearch` |
| Meta (FB/IG) | META_USER_TOKEN, META_PAGE_TOKEN, META_IG_*, META_BUSINESS_ID, META_AD_ACCOUNT_ID | `meta`, `instagram`, `instagramPublisher` |
| WhatsApp Cloud API | META_WHATSAPP_*, WHATSAPP_* | `whatsapp` route |
| Nuvemshop | NUVEMSHOP_CLIENT_ID/SECRET/BASE_URL/REDIRECT_URI | `nuvemshop`, `nuvemshopHandlers` |
| Resend (email) | RESEND_API_KEY | `emailer` |
| Web push | VAPID_SUBJECT | `pushNotifications` |
| Slack | SLACK_WEBHOOK_URL | `slackNotifier` |
| SEFAZ NFe | cert digital (não env) | `fiscalSefazDirect`, `node-sped-nfe` |

---

## 7. Partes misturadas (acoplamentos)

### 7.1. `public/admin.html` — 10.604 linhas em 1 arquivo
Concentra TODA a UI admin: dashboard, usuários, vendedores, gerentes, ponto digital, mensagens, catálogo, estoque, categorias, curadoria, fiscal, financeiro, fornecedores, marketing (iframe), bipes, etiquetas, etc. Sem separação por feature.

### 7.2. `src/routes/stocktake.js`
Mistura: registrar bipe + criar ProductSize automático via fallback NFe (linha ~104, **ATIVO**) + upsert StoreStock + auditoria.

**Histórico do fallback NFe:**
- Adicionado para resolver caso de barcode novo que aparece no bipe mas ainda não tem ProductSize cadastrado, embora exista em `XmlFiscalItem`.
- Foi desligado em 26/05 (commit `082281d`) por suspeita de gerar matches falsos.
- Em seguida, o revert (commit `cdb59ed`) re-habilitou o fallback. **Estado atual: LIGADO.**
- Por mexer em `ProductSize` automaticamente sem ordem humana, **mantém risco 🔥 ALTO** apesar de ser regra desejada (ver CLAUDE.md "Regra de ouro").

### 7.3. `src/routes/adminCatalog.js`
Mistura: CRUD produto + form-options + NFe summary + color variants + items de curadoria.

### 7.4. `prisma/schema.prisma` — 114 modelos juntos
APEX, TenisCash, Catálogo, Fiscal, RH, IA em 1 arquivo. 52% das tabelas vazias.

### 7.5. `src/index.js`
44 imports + 44 `app.use()`. Lógica do `/p/:id` com 260+ linhas de HTML inline misturada no bootstrap.

### 7.6. Scripts soltos (`scripts/` — 60 arquivos)
Operações destrutivas sem padrão (unify, consolidate, deactivate, cleanup, sync). Nomes parecidos (`unify-by-supplier-ref`, `unify-products-batch`, `consolidate-products-by-model`).

### 7.7. Listas hardcoded duplicadas
Modalidade/Especialidade tinham listas fixas em 3 lugares (Estoque, Categoria, form-options) — substituídas por busca dinâmica em 26/05, mas evidencia padrão.

---

## 8. Áreas por risco

### 🔥 ALTO RISCO ao mexer
1. **Bipe / StoreStock** — fluxo real-time, vendedores trabalhando. Já tivemos bipes perdidos em 26/05.
2. **Fallback NFe em `stocktake.js` (~linha 104) — ATIVO.** Cria `ProductSize` automaticamente quando o EAN bipado existe em `XmlFiscalItem`. Mexer aqui sem mapeamento prévio pode gerar matches errados ou impedir registro de bipe novo.
3. **`_product-card.js`** — usado em ~6 telas (admin, marketing, curadoria, loja, bipes, p/:id). Mudar assinatura quebra tudo.
4. **Endpoint `/admin/inventory/products`** — usado por Estoque + Categoria + Curadoria + scripts. Cérebro do catálogo.
5. **Schema Prisma** — 114 tabelas com relações cruzadas. Mudar é caro.

### 🟡 MÉDIO RISCO
5. **Auth e roles** — middleware único hoje. 16 arquivos verificam role manualmente. Manager foi adicionado em 26/05.
6. **Cron jobs** — 3 crons bootados em `src/index.js` (messages, marketing, fiscal draft).
7. **Variáveis de ambiente** — 28 chaves sem catálogo central.
8. **Scripts antigos** — alguns podem ainda esperar execução.

### 🟢 BAIXO RISCO
9. **APEX module** — tabelas vazias, sem produção. **Código já extraído** para `src/modules/apex/` (26/05/2026). Risco de mexer continua baixo, mas a movimentação física já foi feita.
10. **Marketing IA** — relativamente isolado.
11. **Curadoria de vitrine** (StoreCuration) — vazio.
12. **Fiscal NFCe direto SEFAZ** — `.mjs` separado.

---

## 9. Hipóteses que precisam ser confirmadas

- [ ] **Sales/Comissões inativas** — Por que `Sale` tem só 4 registros? Está integrado com PDV físico ou tudo manual? Não toquei aqui.
- [ ] **APEX é prioridade?** — 21 tabelas vazias. Ainda em planejamento ou foi arquivado?
- [ ] **Campaign / StoreCuration** — Modelagem existe mas zero uso. Manter, completar ou remover?
- [ ] **Quantos scripts em `scripts/` são one-shot já executados** e poderiam ir pro arquivo morto?
- [ ] **Há padronização desejada de naming** (camelCase nos routes, snake_case nos scripts misturado)?
- [ ] **`messages` vs `messagesV2`** — versão 1 ainda em uso ou pode ser depreciada?
- [ ] **`index_4.html` e `index_fixed.html`** — arquivos antigos. Ainda servem ou são lixo?
- [ ] **Quão crítico é manter `/p/:id` no `src/index.js`?** (atualmente embutido no bootstrap)

---

## 10. Resumo executivo

- ~36k linhas só em `routes/services/admin.html`.
- 114 tabelas no Prisma; 52% vazias.
- Concentração crítica: `admin.html` (10.604 linhas), `stocktake.js`, `adminCatalog.js`.
- Sem isolamento por bounded context — features acumuladas em arquivos únicos.
- Áreas mais sensíveis (estoque/bipe/catálogo) são justamente as mais usadas em produção.
- Boas oportunidades de começar por módulos isolados antes de tocar no que vive em produção.

**Este documento é apenas observação. Nada foi alterado.**
