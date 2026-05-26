# RELATORIO_DE_VALIDACAO_DOS_DOCS

Validação dos 4 documentos criados (`MAPA_ATUAL.md`, `MODULOS_DESEJADOS.md`, `REGRAS_CRITICAS.md`, `REGRESSION_CHECKLIST.md`) contra o código real.

- Sem alterar código.
- Sem mover/renomear arquivos.
- Sem mexer em rotas ou banco.
- Somente leitura + relatório.

Data: 2026-05-26
Branch: `organizacao/refactor-2026-05-26`

---

## Confirmado

Itens dos docs que **batem 1:1** com o código atual:

### Estrutura física
- **44 arquivos em `src/routes/`** — confirmado por `ls`. (activities, admin, adminCatalog, adminClassification, ai, aiCuration, anthropicTools, auth, brandProfiles, campaigns, catalog, categories, coach, curation, financial, fiscal, inventory, labels, life, marketing, marketingConfig, markup, messages, messagesV2, nuvemshop, orchestrator, partners, productImages, products, promo, qr, recommendations, seller, sellerPortfolio, sellers, shipping, stocktake, stores, suppliers, transfer, wallet, weeklyInterview, whatsapp, xmlImport).
- **48 arquivos em `src/services/`** — confirmado.
- **60 entradas em `scripts/`** — confirmado (inclui 1 .md de prompt + 59 .js/.mjs).
- **13 HTMLs em `public/`** — confirmado.
- **114 `model` em `prisma/schema.prisma`** — confirmado por `grep -c "^model "`.
- **44 mount points `/api/...` em `src/index.js`** — confirmado (admin, auth, wallet, transfer, promos, qr, seller, stores, messages, sellers, catalog, ai, admin/catalog, admin/ai, life, admin/labels, admin/fiscal, admin/curation, seller/portfolio, seller/interview, admin/xml, admin/recommendations, admin/financial, admin/suppliers, admin/categories, admin/campaigns, admin/inventory, admin/product-images, admin/markup, admin/products, admin/ai-curation, admin/anthropic-tools, admin/orchestrator, admin/classification, activities, coach, whatsapp, stocktake, messages-v2, marketing, marketing-config, brand-profiles, nuvemshop (raiz `/api`), shipping, partners (raiz `/api`)).
- **`public/admin.html` monolítico** — confirmado.
- **`prisma/schema.prisma` único com 114 modelos cruzados** — confirmado.

### Modelos críticos do schema
- `Store`, `StoreStock`, `Sale`, `XmlFiscalDocument`, `FiscalIssuer`, `StocktakeBipe`, `Product`, `ProductSize`, `User`, `Transaction`, `Promo`, `Partner`, `Channel`, `Campaign`, `BrandProfile`, `ProductCreative`, `AthleteProfile`, `Activity`, `BadgeEarned` — todos existem.
- Campo `XmlFiscalDocument.docType` com valores `entrada | saida | transferencia` — confirmado.
- `Store.fiscalIssuerId`, `Store.fiscalAgentUrl`, `Store.fiscalAgentEnabled`, `Store.dna`, `Store.mall` — confirmados.

### Roles
- `User.role` com default `"user"` e valores documentados no próprio schema: `user, seller, admin, superadmin, partner` — confirmado.
- `manager` adicionado em código (admin.js promove para `manager` com `storeId: null`) — confirmado.

### Bipe + StoreStock
- `POST /api/stocktake/bipe` faz upsert em StoreStock — confirmado.
- `StocktakeBipe` registra cada bipe — confirmado.
- Existe fallback em `src/routes/stocktake.js` linha ~104: "FALLBACK: se nao acha ProductSize mas o ean existe em XmlFiscalItem" — confirmado **presente e ativo** no código.

### Integrações externas
- Anthropic, fal.ai, OpenAI, Brave, Google Custom Search, Serper, Meta (FB/IG), WhatsApp Cloud API, Nuvemshop, Resend, Web Push, Slack, SEFAZ NFe — todos têm arquivos de serviço ou chaves env correspondentes nos services listados.

### Risco e acoplamento (achados consistentes)
- `admin.html` 10.604 linhas — confirmado.
- `stocktake.js` mistura bipe + criação automática de ProductSize + upsert estoque — confirmado.
- `adminCatalog.js` mistura CRUD + form-options + NFe summary + variantes de cor — confirmado.
- 52% das tabelas vazias (APEX, Campaign, StoreCuration, Timeline, etc) — consistente com sumário.
- `Sale = 4 linhas`, `SaleCommission = 0` — confirma que vendas no banco TenisCash são quase inativas.

### Hierarquia de produto (REF + DESC + COR vs SKU)
- `Product.sku` (referência) — confirmado.
- `ProductSize.barcode` (SKU/EAN do tamanho) — confirmado.
- `aiContext` em `Product` usado para `color`, `modelGroup`, `supplierRef` — consistente com `CLAUDE.md` e scripts.

---

## Hipóteses

Pontos nos docs marcados como **plausíveis mas ainda não confirmados** por evidência direta:

1. **APEX está arquivado ou pausado** — todas as 21 tabelas estão vazias. Hipótese plausível mas não confirmada. Pode ser feature em planejamento ativo (Douglas mencionou app PWA + iOS/Android KMP).
2. **Quantos scripts em `scripts/` são one-shot já executados** — 60 arquivos, vários com nomes parecidos (`unify-by-supplier-ref`, `unify-products-batch`, `consolidate-products-by-model`, `cleanup-meta-esportes-duplicates`, `deactivate-meta-esportes-duplicates`). Sem rodar `git log` por arquivo dá pra saber quais já cumpriram função, mas não foi feito.
3. **`messages` vs `messagesV2`** — V1 ainda em uso ou pode ser depreciado. Ambos têm route + serviços. Não confirmado quem chama V1.
4. **`index_4.html` e `index_fixed.html`** — arquivos antigos. Não confirmado se ainda têm rota servindo.
5. **`Sale = 4 linhas` implica PDV não integrado** — pode ser que PDV físico opere fora do TenisCash; pode ser que vendas reais sejam registradas em outra tabela; pode ser que o PDV ainda esteja sendo construído. Hipótese plausível, não confirmada.
6. **3 cron jobs ativos** (`messagesCron`, `marketingCron`, `fiscalDraftJob`) — confirmado pela existência dos arquivos, mas **não foi confirmado se rodam com timezone `America/Fortaleza` (regra do CLAUDE.md).** Risco real de drift UTC.
7. **`/admin/inventory/products` é "cérebro do catálogo"** — afirmação no MAPA_ATUAL. Plausível pelos consumidores (Estoque + Categoria + Curadoria), mas a contagem exata de quem consome esse endpoint não foi grep-validada.
8. **`_product-card.js` usado em 6 telas** — afirmação razoável (admin, marketing, curadoria, loja, bipes, p/:id), mas não grepado nesta validação.

---

## Correções necessárias

Itens **incorretos ou desatualizados** nos docs criados — precisam ser corrigidos antes de servirem como referência canônica:

### `REGRAS_CRITICAS.md`

1. **Lojas erradas — são 6, não 4.**
   - O doc diz: "LOJA01, LOJA02, LOJA03 (Campina Grande), LOJA04. Quatro lojas físicas."
   - Realidade (CLAUDE.md + Store count = 6 linhas no banco):
     - LOJA01 Baratão dos Esportes (CNPJ 0001-26)
     - LOJA02 Sports & Tennis Bessa (0002-07)
     - LOJA03 Sports & Tennis Rainha da Borborema (0003-98) — Campina Grande
     - LOJA04 Sports & Tennis Ecommerce (0004-79)
     - LOJA05 Sports & Tennis Tambaú (0005-50)
     - LOJA06 Sports & Tennis Tambiá (0006-30)
   - Baratão (LOJA01) é outra empresa do grupo, NÃO Sports & Tennis. A regra "NUNCA misturar Baratão com Bessa" está faltando.

2. **Roles erradas.**
   - O doc diz: "Roles existentes: `superadmin`, `admin`, `manager`, `vendedor`, `cliente`."
   - Realidade (schema + código):
     - `user` (não `cliente`)
     - `seller` (não `vendedor`)
     - `admin`
     - `superadmin`
     - `partner` (faltou no doc)
     - `manager` (adicionado 26/05/2026, ainda não aparece no enum default mas é usado em código)

### `MAPA_ATUAL.md`

3. **Fallback de NFe está LIGADO, não desligado.**
   - O doc diz: "ProductSize | adminCatalog.js, stocktake.js (fallback NFe — **desligado em 26/05**), inventory.js, scripts"
   - Realidade: o fallback `stocktake.js` linha 104 está ativo agora — busca `XmlFiscalItem` por EAN e cria ProductSize. Foi desligado em commit 082281d, mas o revert (cdb59ed) re-habilitou. Estado atual: ATIVO.

### `MODULOS_DESEJADOS.md` (e tom geral)

4. **Pode dar a impressão de que extração de módulos é "agora" sem que existam testes** — o doc precisa deixar mais explícito que extração só começa depois de instrumentação mínima (logs + métricas + smoke test do checklist), senão risco real de bipe perdido se Bipe sair pra módulo em Fase 3 sem rede de segurança.

### Em todos os docs

5. **Falta marcar que `fallback de NFe` é regra ativa de bipe** (não bug). É comportamento desejado (CLAUDE.md "Regra de ouro"). Não tratar como código a remover na refatoração.
6. **Falta `aiContext.modelGroup`** explicado como hub de unificação. Foi mencionado em passing, mas o CLAUDE.md tem 27 padrões de marca (Converse CK0004, ASICS 8-char, PUMA 6-dig, ADIDAS `[A-Z]{2}[0-9]{4}`, etc) — central pra qualquer trabalho em catálogo.

---

## Riscos subestimados

Áreas onde o doc atual **classifica como menor risco do que realmente é**:

1. **Marketing IA (Fase 1) — risco real = MÉDIO/ALTO, não baixo.**
   - Marketing tem 13 services (`copyGenerator`, `compositeImage`, `collageImage`, `falAi`, `openaiImage`, `marketingPrompts`, `marketingCron`, `productEnrichmentAI`, `curationAgent`, `visionValidator`, `visionBatchValidator`, `instagramPublisher`, `meta`).
   - `marketingCron` roda em produção. Mexer aqui pode parar criativos.
   - `instagramPublisher` faz POST em rede social → quebrar = imagem errada publicada.
   - Custo monetário (Anthropic + fal.ai + OpenAI) por chamada — bug = R$ queimado.

2. **Vendas (Fase 1) — risco real = MÉDIO.**
   - `Sale` só tem 4 linhas hoje, mas as `routes/wallet.js` e `routes/transfer.js` movimentam `Transaction` (53 linhas). Carteira de cliente é dinheiro real.
   - Se o PDV for ligado depois, mexer no módulo agora cria débito técnico imediato.

3. **Fiscal (Fase 2) — risco real = ALTO.**
   - Importar NFe errada contamina catálogo + estoque. Já aconteceu (Claude criou 1.085 + 900 Products de transferência indevidamente).
   - `fiscalSefazDirect.mjs` emite NFCe direto ao SEFAZ. Bug = não emissão fiscal em loja.
   - `fiscalDraftJob` é cron. Sem timezone `America/Fortaleza` pode disparar fora de hora.
   - Fiscal deveria ser **Fase 3**, não Fase 2.

4. **Cron jobs (médio risco no MAPA) — realidade é ALTO se timezone errado.**
   - Regra CLAUDE.md: Railway é UTC, Paraíba é UTC-3. Sem `{ timezone: 'America/Fortaleza' }` no `cron.schedule`, jobs disparam 3h atrasados. Não foi auditado se os 3 crons cumprem essa regra.

5. **Curadoria de vitrine (StoreCuration) vs Curadoria de produto (aiCuration) — confusão de nome.**
   - O doc tratou ambos como "Curadoria". São coisas diferentes:
     - `curation.js` + tabelas `StoreCuration*` (vazias) = curadoria visual de loja (foto/checklist da vitrine).
     - `aiCuration.js` + `/api/admin/ai-curation/product/:id` = curadoria de produto via IA (6.170 produtos curados).
   - A segunda é altamente ativa e mexer nela quebra catálogo. Não pode entrar em Fase 1.

---

## Riscos superestimados

Áreas onde o doc atual **classifica como maior risco do que realmente é** (mas ainda exigem cuidado):

1. **APEX (classificado como BAIXO, mas tratado com cautela) — risco real BAIXÍSSIMO.**
   - 21 tabelas vazias. Zero registros. Zero produção.
   - `activityIngest` e `aiCoach` rodam mas sem dados. Mexer = zero impacto operacional.
   - É o **candidato ideal** para primeira extração de módulo.

2. **Etiquetas (BAIXO no MAPA) — confirmado baixo.**
   - `labels.js` + `labelGenerator.js` + tabelas `LabelTemplate/Batch/Item/PrintLog` isoladas.
   - Consumido por 1 botão no admin.html.
   - Pode ser extraído sem risco.

3. **`brand-profiles` route — superestimado como "marketing IA".**
   - É CRUD simples de `BrandProfile` (10 linhas).
   - Risco isolado, baixo.

4. **`life.js` (UserLifeProfile) — não recebeu atenção mas é safe.**
   - 1 tabela, 1 route, isolada.
   - Candidata fácil pra extração.

---

## Candidato mais seguro para primeira extração

**Ordem recomendada (mais seguro → menos seguro):**

### 1ª opção (mais segura): `APEX`
- Routes: `activities.js`, `coach.js`
- Services: `activityIngest.js`, `aiCoach.js`
- Tabelas: `AthleteProfile`, `Consent`, `DeviceConnection`, `Activity`, `ActivityLap`, `ActivityPhoto`, `Route`, `RoutePoint`, `Segment`, `SegmentEffort`, `Club`, `ClubMembership`, `Challenge`, `ChallengeParticipation`, `TrainingPlan`, `Workout`, `WorkoutStep`, `UserPlan`, `SafetyContact`, `LiveTrackingSession`, `BadgeEarned` (todas vazias).
- Por que: zero produção, zero risco operacional. Permite validar o padrão de extração modular sem expor o varejo a falha.

### 2ª opção: `Etiquetas`
- Route: `labels.js`
- Service: `labelGenerator.js`
- Tabelas: `LabelTemplate`, `LabelBatch`, `LabelItem`, `LabelPrintLog`
- Por que: isolado, consumido por um único botão, sem cron, sem integração externa.

### 3ª opção: `Curadoria de vitrine` (StoreCuration, NÃO aiCuration)
- Route: `curation.js`
- Tabelas: `StoreCuration*` (todas vazias)
- Por que: zero dado em produção. Permite criar shape do módulo antes de ele ser usado.

### 4ª opção: `Life` (UserLifeProfile)
- Route: `life.js`
- Tabela: `UserLifeProfile`
- Por que: feature de cliente final, baixo tráfego, isolado.

**Estas 4 áreas formam a Fase 1 segura.** Não tocar Marketing IA, Vendas, Curadoria de Produto, Financeiro nesta fase.

---

## O que ainda não deve ser tocado

Lista de áreas com **proibição de mudança estrutural** neste ciclo:

### 🔥 PROIBIDO MEXER (sem plano explícito + backup + canário em 1 loja)

1. **`src/routes/stocktake.js`** — fluxo de bipe + StoreStock real-time + fallback NFe ativo. Já causou perda de 340 bipes em 26/05.
2. **`src/routes/xmlImport.js` + `src/services/xmlNfeParser.js` + `nfeSizeParser.js`** — importação fiscal. Bug = catálogo poluído (já aconteceu 2x este mês, 1.590 Products deletados).
3. **`src/routes/fiscal.js` + `src/services/fiscalSefazDirect.mjs` + `fiscalAgentClient.js`** — emissão fiscal. Bug = NFCe não emitida em loja física.
4. **`public/admin.html`** — 10.604 linhas com event listeners cruzados. Extrair fragmentos exige inventário de selectors + handlers + APIs consumidas.
5. **`src/routes/adminCatalog.js`** — CRUD do catálogo. Quebrar = qualquer aba (estoque, categoria, curadoria) trava.
6. **`src/routes/products.js` + `src/routes/inventory.js`** — endpoints altamente consumidos pelos cards de admin.
7. **`src/routes/aiCuration.js`** — 6.170 produtos curados. Refator pode reverter estado curado.
8. **`prisma/schema.prisma`** — 114 modelos com relações cruzadas. Migração destrutiva (drop column, rename) proibida.
9. **`src/services/nuvemshop.js` + `nuvemshopHandlers.js`** — sync bidirecional Nuvemshop. Bug = produto desaparece do e-commerce ou preço sobrescrito.
10. **`src/services/marketingCron.js`** + `instagramPublisher.js` — cron que publica em rede social. Bug = post errado público.
11. **Crons em `src/index.js`** — bootstrap dos 3 jobs (messages, marketing, fiscal draft). Mexer no bootstrap quebra todos juntos.
12. **`_product-card.js` (no admin.html)** — usado em ~6 telas. Mudar assinatura quebra cadeia.

### 🟡 EVITAR neste ciclo (mas pode planejar Fase 2/3)

13. **`src/routes/sellers.js` + `sellerPortfolio.js` + `weeklyInterview.js`** — fluxo RH ativo. Vendedores estão no sistema.
14. **`src/routes/wallet.js` + `transfer.js` + `promo.js` + `partners.js`** — TenisCash carteira. Dinheiro do cliente.
15. **`src/services/messagesCron.js`** + `systemMessenger.js` — fila de mensagens. Pausar = clientes não recebem aviso.
16. **`src/services/marketingPrompts.js` + `productEnrichmentAI.js` + `curationAgent.js`** — IA de catálogo. Bug = enriquecimento errado.

### ✅ Pode tocar (com checklist mínimo)

17. APEX (activities, coach), Etiquetas (labels), Curadoria de vitrine (curation/StoreCuration), Life (life).

---

## Observações finais

- Os 4 docs criados são **um bom mapa de partida**, mas têm falhas pontuais corrigíveis (lojas, roles, estado do fallback NFe).
- **Não confundir Curadoria de vitrine (StoreCuration, vazio) com Curadoria de produto IA (aiCuration, ativo).** O segundo NÃO pode entrar em Fase 1.
- **Fiscal precisa subir para Fase 3.** Está em Fase 2 no doc — risco real de quebrar emissão fiscal.
- **Marketing precisa subir para Fase 2 ou 3.** Não Fase 1 — tem cron, integrações externas, custo monetário por chamada.
- Antes de qualquer extração, instrumentar com logs + métrica (StoreStock antes/depois, contagem de bipes, contagem de criativos publicados).
- A primeira extração proposta (APEX) serve **principalmente para validar o padrão de módulo**, não para entregar valor de negócio.

Este relatório é **apenas observação**. Nenhum arquivo de código foi alterado, movido, renomeado, refatorado ou testado. Nenhuma mudança no banco. Os 4 docs originais permanecem como estão até decisão explícita do dono sobre as correções.
