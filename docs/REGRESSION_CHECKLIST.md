# REGRESSION_CHECKLIST.md

Lista de fluxos críticos que precisam ser testados **antes** e **depois** de qualquer alteração no TenisCash.

Toda mudança em produção (refator, integração, fix, feature) deve marcar como `OK` ou `FALHA` cada item relevante ao módulo afetado.

Mudança que toca múltiplos módulos exige passar pelos checklists de todos eles.

Data: 2026-05-26
Branch de trabalho: `organizacao/refactor-2026-05-26`

---

## Como usar

1. Antes da mudança: rodar o checklist e marcar o estado atual (`baseline`).
2. Aplicar a mudança em ambiente de staging ou em uma loja-piloto.
3. Repetir o checklist: cada item precisa ter o mesmo resultado do baseline (ou melhor).
4. Se qualquer item regredir: rollback imediato.
5. Anexar resultado ao PR/commit.

Convenção:
- `[ ]` = não testado
- `[OK]` = funcionou conforme esperado
- `[FALHA]` = comportamento divergiu do baseline
- `[N/A]` = não aplicável a este módulo

---

## 1. Fluxo: Login e autenticação

- [ ] Login como `superadmin` carrega painel completo (4 lojas, todas as abas).
- [ ] Login como `admin` carrega painel completo.
- [ ] Login como `manager` carrega painel de todas as lojas (igual admin, sem permissão de superadmin).
- [ ] Login como `vendedor` carrega apenas dados da loja do usuário (`storeId`).
- [ ] Login como `cliente` carrega apenas dados da carteira do próprio cliente.
- [ ] Sessão expira no tempo configurado.
- [ ] Logout limpa cookies e redireciona para login.
- [ ] Tentativa de acesso a rota sem permissão retorna 403, não 500.

---

## 2. Fluxo: Bipe (leitura de código de barras)

Este é o fluxo mais crítico do sistema. Testar em LOJA01, LOJA02, LOJA03, LOJA04, LOJA05 e LOJA06.

- [ ] Abrir `/bipar.html` com usuário vendedor (`role = seller`).
- [ ] Bipar código que existe → card mostra estado `encontrado ✓`.
- [ ] Bipar código que NÃO existe em ProductSize **mas existe em XmlFiscalItem (NFe entrada)** → fallback de `stocktake.js` (linha ~104) cria `ProductSize` e retorna `encontrado ✓`.
- [ ] Bipar código que NÃO existe em ProductSize **nem em XmlFiscalItem** → card mostra estado `nao_encontrado ✗`.
- [ ] Bipar código que existe SÓ em `XmlFiscalItem` de **transferência** (docType=transferencia) → fallback **NÃO** cria Product nem ProductSize. Card mostra `nao_encontrado ✗` ou pendente humano (confirmar comportamento desejado).
- [ ] Desligar Wi-Fi, bipar 5 códigos → cards mostram `pendente_rede ⏳`.
- [ ] Religar Wi-Fi → fila de retry processa automaticamente, cards atualizam para estado real.
- [ ] Bipar 10 códigos seguidos rápido → todos vão ao servidor (verificar contagem no admin).
- [ ] Recarregar a página com bipes pendentes em fila → fila é preservada no `localStorage` e re-tentada.
- [ ] Contagem `total / encontrados / nao_achados` no painel admin bate com o que foi bipado.
- [ ] Bipe duplicado (mesmo código no mesmo dia) é tratado conforme regra (sobrescrever ou ignorar — confirmar com dono qual é a regra desejada).
- [ ] `StoreStock` da loja é incrementado apenas em bipes `encontrado` confirmados pelo servidor.
- [ ] **Estado atual do fallback NFe é LIGADO.** Confirmar via leitura de `src/routes/stocktake.js` linha ~104 antes de qualquer deploy que mexa em bipe. Se foi desligado por engano, é regressão crítica.

---

## 3. Fluxo: Importação de NFe

Este é o segundo fluxo mais crítico. Quebrá-lo significa contaminar estoque com dados falsos.

- [ ] Upload de XML de NFe de **entrada** (CFOP 1102, 2102, etc) → cria registros em `XmlFiscalDoc` e `XmlFiscalItem`.
- [ ] NFe de entrada com produto novo (barcode inexistente) → pode criar `Product` se autorizado (verificar regra atual).
- [ ] Upload de XML de NFe de **transferência** (CFOP 5152, 6152, 5409, 6409, 5151) → **NÃO** cria `Product`.
- [ ] NFe de transferência movimenta `StoreStock` da loja origem para loja destino.
- [ ] NFe de transferência com item sem `Product` cadastrado fica pendente em `XmlFiscalItem`, aguardando vínculo manual.
- [ ] Item de NFe com `cEAN` válido vincula em `Product` existente via barcode.
- [ ] Item de NFe sem `cEAN` (`cEAN = "SEM GTIN"`) NÃO faz match automático.
- [ ] Reimportar a mesma NFe (mesma chave) é idempotente — não duplica estoque.

---

## 4. Fluxo: Catálogo (Products e ProductSize)

- [ ] Listar produtos ativos em `/admin#estoque` carrega em < 5s.
- [ ] Filtros funcionam: marca, categoria, bipados, loja.
- [ ] Card mostra: imagem, REF, descrição, cor, marca, modelGroup.
- [ ] Cores diferentes do mesmo modelo aparecem como cards separados (variantes de cor).
- [ ] Tamanhos do mesmo modelo+cor NÃO aparecem como cards separados.
- [ ] Editar `markup` ou `price` exige autorização do dono (verificar lock UI).
- [ ] Soft delete de produto (`active = false`) remove dos cards mas preserva histórico em `Sale`, `XmlFiscalItem`, `StocktakeBipe`.
- [ ] Hard delete de produto **não** está exposto na UI (só via script com `--apply`).

---

## 5. Fluxo: Curadoria

Há **duas curadorias diferentes** no sistema. Validar separadamente.

### 5.a. Curadoria de Produto (aiCuration — IA classifica/enriquece o produto)

- Endpoint: `POST /api/admin/ai-curation/product/:id`
- Tabelas afetadas: `Product.aiContext`, `Product.name`, `ProductCreative`.
- Volume atual: **6.170 produtos curados de 7.093**. Mexer pode reverter trabalho real já feito.

Checklist:
- [ ] Curar 1 produto não-curado retorna `aiContext` populado (modelGroup, color, supplierRef quando aplicável).
- [ ] Curar 1 produto já-curado **não apaga** dados anteriores (atualiza/preserva).
- [ ] Curadoria respeita permissão por role (`seller` não cura; `manager`, `admin`, `superadmin` curam).
- [ ] Card visual mostra estado curado (campo `aiContext` presente).
- [ ] Falha no Anthropic/fal.ai não corrompe `Product` — produto continua acessível.
- [ ] Custo da chamada IA é logado.

### 5.b. Curadoria de Vitrine (StoreCuration — montagem física da vitrine)

- Route: `curation.js`
- Tabelas: `StoreCuration`, `StoreCurationZone`, `StoreCurationItem`, `StoreCurationChecklist`, `StoreCurationPhoto`, `StoreCurationResult` (todas vazias hoje).

Checklist:
- [ ] Aba Curadoria (vitrine) carrega cards com mesmos filtros de Estoque e Categoria.
- [ ] Filtro por loja funciona.
- [ ] Card de Curadoria mostra estoque mas NÃO mostra dados de NFe/transferência.
- [ ] Criar uma StoreCuration registra zonas, itens e checklist.
- [ ] Subir foto persiste em `StoreCurationPhoto`.
- [ ] Resultado de curadoria persiste em `StoreCurationResult`.

**⚠️ Curadoria de Produto e Curadoria de Vitrine são fluxos DIFERENTES.** Refator de um não pode ser feito misturado com o outro.

---

## 6. Fluxo: Geração de criativos (IA)

- [ ] Gerar criativo via `anthropic.service.js` retorna texto válido.
- [ ] Gerar imagem via `fal.service.js` retorna URL acessível.
- [ ] Criativo de Sports & Tennis usa logo correta e branding correto.
- [ ] Criativo de Meta Fardamentos usa logo correta de Meta Fardamentos (não Sports & Tennis).
- [ ] Criativo de Meta Esportes / Baratão dos Esportes usa branding correto.
- [ ] Preço aparece na imagem quando solicitado.
- [ ] Logo aparece na imagem quando configurada.
- [ ] Descrição de WhatsApp/Instagram usa a marca correta (não vaza marca de outro projeto).
- [ ] Custo da geração é registrado em log (Anthropic + fal.ai).

---

## 7. Fluxo: Venda (POS)

- [ ] Registrar venda gera `Sale` + N x `SaleItem`.
- [ ] Cada `SaleItem` decrementa `StoreStock` da loja do vendedor.
- [ ] Venda com cliente vinculado credita cashback na `Wallet` (se aplicável).
- [ ] Venda anônima (sem cliente) é registrada normalmente.
- [ ] Cancelamento de venda estorna `StoreStock` e `Wallet`.
- [ ] Desconto acima de 15% bloqueia até `pricing-margin-agent` validar (ou exige aprovação manual).
- [ ] Comissão do vendedor é calculada conforme regra vigente.

---

## 8. Fluxo: Carteira (cashback)

- [ ] Cliente acessa `/cliente` e vê saldo correto.
- [ ] Compra credita cashback conforme regra de markup.
- [ ] Resgate de cashback debita saldo e não permite saldo negativo.
- [ ] Histórico de transações da carteira é completo e ordenado.
- [ ] Notificação ao cliente sobre crédito/débito respeita regra: nenhuma mensagem sem aprovação humana (exceto rascunho).

---

## 9. Fluxo: APEX (app esportivo) — módulo extraído

**Status:** APEX foi extraído para `src/modules/apex/` em 26/05/2026 (commits `c070555`, `0af78f7`, `29ff92b`, `903f2e2`). Validação final APROVADA.

Localização atual dos arquivos (referência):
- `src/modules/apex/README.md`
- `src/modules/apex/routes/activities.js` — montado em `/api/activities` (path inalterado)
- `src/modules/apex/routes/coach.js` — montado em `/api/coach` (path inalterado)
- `src/modules/apex/services/activityIngest.js`
- `src/modules/apex/services/aiCoach.js`

### 9.a. Checklist operacional (mesmo de antes)

- [ ] Login no APEX funciona.
- [ ] Listagem de eventos esportivos carrega.
- [ ] Inscrição em torneio persiste em `Tournament` / `Participation`.
- [ ] Push notification (Web Push) chega ao dispositivo cadastrado.
- [ ] Endpoints REST do APEX respondem em < 2s.

### 9.b. Padrão de validação segura para mudanças futuras no APEX

Toda mudança que toque um dos 4 arquivos APEX (ou o `src/modules/apex/README.md`) deve passar pelos seguintes checks **sem chamar endpoint, sem rodar servidor, sem chamada externa**:

- [ ] `git status --short -uall` limpo antes de começar.
- [ ] Grep global por importadores do arquivo afetado — confirmar que só o esperado existe (`src/`, `public/`, `scripts/`, `docs/`).
- [ ] `node --check src/modules/apex/routes/activities.js`
- [ ] `node --check src/modules/apex/routes/coach.js`
- [ ] `node --check src/modules/apex/services/activityIngest.js`
- [ ] `node --check src/modules/apex/services/aiCoach.js`
- [ ] `node --check src/index.js`
- [ ] `node -e "const r = require('./src/modules/apex/routes/activities'); console.log(typeof r)"` retorna `function`.
- [ ] `node -e "const r = require('./src/modules/apex/routes/coach'); console.log(typeof r)"` retorna `function`.
- [ ] `node -e "const s = require('./src/modules/apex/services/activityIngest'); console.log(typeof s)"` retorna `object` com chaves `ingestActivity, importActivityFile, VALID_SPORTS`.
- [ ] `node -e "const s = require('./src/modules/apex/services/aiCoach'); console.log(typeof s)"` retorna `object` com chaves `isConfigured, dailyBriefing, postWorkoutAnalysis, chat`.
- [ ] **Nenhuma das funções acima foi chamada** — apenas carga estática de módulo.
- [ ] **Nenhuma chamada Anthropic** foi disparada (verificar lendo o código alterado; `new Anthropic(...)` deve continuar dentro das funções, nunca no top-level).
- [ ] **Nenhuma query Prisma** foi executada (PrismaClient pode ser instanciado, mas não pode ser chamado).
- [ ] `npm start` **não** foi executado.
- [ ] `src/index.js` linhas 43-44 (requires) e 141-142 (mount points) inalteradas, a menos que a mudança proposta seja explicitamente nelas — e mesmo nesse caso, mount points string permanecem literais (`'/api/activities'` e `'/api/coach'`).
- [ ] `prisma/schema.prisma`, `package.json`, `.env`, `src/middleware.js`, `docs/`, `public/`, `scripts/` permanecem intocados pela mudança (validar com `git show --name-only <commit>`).

---

## 10. Fluxo: E-commerce (Nuvemshop)

- [ ] Sync de produto Sports & Tennis ↔ Nuvemshop não sobrescreve preço local sem ordem.
- [ ] Sync de estoque respeita `StoreStock` por loja (qual loja exposta no e-commerce — confirmar regra).
- [ ] Pedido novo na Nuvemshop entra como `Sale` no TenisCash.
- [ ] Cancelamento de pedido na Nuvemshop estorna `StoreStock` no TenisCash.

---

## 11. Fluxo: Etiquetas e impressão

- [ ] Gerar etiqueta de produto no admin abre PDF/print dialog.
- [ ] Etiqueta contém: barcode, REF, descrição, tamanho, preço.
- [ ] Impressão em lote por seleção funciona.

---

## 12. Fluxo: Mensagens e notificações

- [ ] E-mail transacional (Resend) é enviado em eventos previstos (boas-vindas, recibo, etc).
- [ ] Web Push só é enviado a usuários com `subscription` ativa.
- [ ] WhatsApp em modo rascunho gera mensagem mas NÃO envia automaticamente.
- [ ] Slack webhook (se configurado) recebe alertas operacionais.

---

## 13. Fluxo: Financeiro / Relatórios

- [ ] Dashboard de vendas por loja carrega valores corretos.
- [ ] Relatório de comissão por vendedor carrega valores corretos.
- [ ] Exportação CSV/Excel funciona sem cortar linhas.
- [ ] Filtro de data respeita timezone do Brasil (America/Recife).

---

## 14. Fluxo: Backup e restore

- [ ] Backup manual via script gera dump completo em `backups/db-YYYY-MM-DDTHH-mm-ss/`.
- [ ] Backup inclui todas as 114 tabelas.
- [ ] Restore em ambiente staging funciona e gera contagens iguais.
- [ ] `backups/` está em `.gitignore` e NÃO sobe pro Git.

---

## 15. Fluxo: Segurança e segredos

- [ ] `.env` NÃO aparece em `git status` como rastreado.
- [ ] Logs não imprimem `DATABASE_URL`, tokens, API keys.
- [ ] Endpoints sensíveis (admin, vendedor) exigem auth.
- [ ] CORS configurado para domínios permitidos.
- [ ] Rate limiting ativo nos endpoints públicos (`/bipar`, login).

---

## 16. Fluxo: Scripts destrutivos

Antes de rodar qualquer script de `scripts/`:

- [ ] Script tem flag `--dry-run` (padrão) e `--apply` (executa).
- [ ] DRY RUN é rodado primeiro e revisado.
- [ ] Backup do banco foi feito antes do `--apply`.
- [ ] Resultado do `--apply` é comparado com o esperado do DRY RUN.
- [ ] Rollback documentado caso resultado divirja.

---

## 17. Crons e timezone

Railway roda em UTC; o negócio opera em João Pessoa/PB (UTC-3). Sem timezone explícito, crons disparam 3h fora do esperado.

Crons conhecidos:
- `src/services/messagesCron.js`
- `src/services/marketingCron.js`
- `src/services/fiscalDraftJob.js`

Checklist:
- [ ] Cada `cron.schedule(...)` passa `{ timezone: 'America/Fortaleza' }` no terceiro argumento.
- [ ] **Não usar `America/Sao_Paulo`** (historicamente teve DST até 2019, pode dar drift). Usar `America/Fortaleza` (UTC-3 fixo).
- [ ] Queries SQL que comparam "hoje/ontem/início do dia" usam `AT TIME ZONE 'America/Fortaleza'`.
- [ ] `SELECT NOW(), NOW() AT TIME ZONE 'America/Fortaleza';` retorna offset esperado em ambiente staging.
- [ ] Após deploy, validar primeira execução do cron pelo log timestamp: deve disparar no horário Paraíba, não UTC.
- [ ] Adicionar/mudar cron sem timezone explícito é **regressão crítica** — bloquear PR.

---

## 18. Performance

- [ ] `/admin#estoque` com 5.000+ produtos carrega em < 5s.
- [ ] `/bipar` aceita 1 bipe por segundo sem travar UI.
- [ ] Importação de NFe com 100 itens leva < 30s.
- [ ] Geração de criativo IA leva < 60s.

---

## 19. Integridade referencial

- [ ] Nenhum `SaleItem` órfão (sem `Sale` pai).
- [ ] Nenhum `StoreStock` órfão (sem `ProductSize` pai).
- [ ] Nenhum `StocktakeBipe` apontando para `productId` ou `productSizeId` que não existe.
- [ ] Nenhum `XmlFiscalItem` apontando para `productId` que não existe.
- [ ] Foreign keys do schema Prisma estão respeitadas.

---

## 20. Pós-deploy (24h de monitoramento)

Após qualquer deploy em produção:

- [ ] Logs do servidor não mostram aumento de 5xx.
- [ ] Logs do Prisma não mostram erros de constraint.
- [ ] Métricas de bipe por loja batem com o esperado (sem queda anômala).
- [ ] Contagem de NFes importadas no dia bate com a contagem de XMLs enviados.
- [ ] Vendas registradas no dia batem com fechamento de caixa de cada loja.
- [ ] Nenhuma reclamação operacional de vendedor/manager via WhatsApp/Slack.

---

## 21. Por módulo (quando aplicável)

Quando uma mudança afetar um módulo específico de `MODULOS_DESEJADOS.md`, rodar os checks correspondentes:

- **carteira** → seções 1, 8, 19
- **catalogo** → seções 1, 4, 5, 19
- **inventario** → seções 1, 4, 19
- **bipe** → seções 1, 2, 19, 20
- **fiscal** → seções 1, 3, 17, 19
- **rh** → seção 1
- **vendas** → seções 1, 7, 19, 20
- **mensagens** → seções 1, 12, 17
- **marketing-ia** → seções 1, 6, 17
- **curadoria-produto (aiCuration)** → seções 1, 4, 5.a
- **curadoria-vitrine (StoreCuration)** → seções 1, 4, 5.b
- **ecommerce** → seções 1, 10
- **financeiro** → seções 1, 13
- **apex** → seções 1, 9
- **admin** → seção 1

---

## 22. Áreas que NÃO podem ser tocadas neste ciclo

Lista oficial de áreas **bloqueadas para refator/extração** enquanto a documentação atual estiver vigente. Mexer aqui exige autorização explícita do dono + plano revisável.

- `src/routes/stocktake.js` — bipe + StoreStock real-time + fallback NFe ativo.
- `src/routes/xmlImport.js` — importação fiscal (já contaminou catálogo 2x este mês).
- `src/routes/fiscal.js` + `src/services/fiscal*.{js,mjs}` — emissão NFCe via SEFAZ.
- `public/admin.html` — 10.604 linhas com handlers cruzados.
- `src/routes/adminCatalog.js` — CRUD do catálogo.
- `src/routes/products.js` — endpoint altamente consumido.
- `src/routes/inventory.js` — endpoint cérebro do catálogo.
- `src/routes/aiCuration.js` — 6.170 produtos curados; reverter = trabalho perdido.
- `prisma/schema.prisma` — 114 modelos cruzados; nenhuma migração destrutiva.
- `src/services/nuvemshop.js` + `nuvemshopHandlers.js` — sync Nuvemshop bidirecional.
- `src/services/marketingCron.js` — cron que publica em rede social.
- Bootstrap de crons em `src/index.js` — mexer aqui quebra todos os crons.
- `_product-card.js` (dentro de `admin.html` e telas correlatas) — usado em ~6 telas.

---

## Resumo de obrigação

- Mudança que toca **bipe, NFe, schema, preço ou cliente final**: passar pelo checklist **inteiro**.
- Mudança que toca apenas **um módulo isolado**: passar pelas seções 1, do módulo correspondente, 17 (se houver cron) e 19.
- Mudança puramente cosmética em CSS/HTML estático: passar apenas pelas seções 1 e 18.
- Toda mudança que adicione ou altere `cron.schedule` ou query temporal: obrigatório passar pela seção 17 (timezone).
- Toda mudança que toque `stocktake.js` ou importação de NFe: obrigatório validar fallback NFe ligado (seção 2, último item).

Quem rodou o checklist registra: nome, data, commit hash, resultado.
