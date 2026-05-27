# ÁREAS CRÍTICAS CONGELADAS — Fora do ciclo de modularização turbo

> Documento vinculante. Lista as áreas do sistema TenisCash que **não serão modularizadas** no ciclo turbo (Fase 1). Inclui motivo do bloqueio, arquivos envolvidos, risco e pré-condição para futuro descongelamento.

Data: 2026-05-26
Branch: `refactor/curadoria-vitrine-extracao-01`
Ciclo: Modularização Turbo Fase 1

---

## Por que existem áreas congeladas

A Fase 1 do refator modular focou em **módulos isolados, de risco operacional baixíssimo** (APEX, Etiquetas, Curadoria de Vitrine). Esses três são treino de padrão; não dão receita nem reduzem risco.

As áreas listadas abaixo **são exatamente o oposto**: tocam fluxo operacional real, dão alavanca de venda, ou já causaram incidente. Mexer nelas em modo turbo seria irresponsável. Cada uma exige plano dedicado, baseline próprio, canário em loja real e monitoramento pós-deploy.

---

## 1. Bipe / Estoque / Contagem

**Arquivos:**
- `src/routes/stocktake.js` (POST /api/stocktake/bipe e companheiros)
- `public/bipar.html` (UI mobile com retry queue em localStorage)
- `public/bipes.html` (admin de bipes)
- Modelos: `StocktakeBipe`, `StoreStock`

**Risco:**
- 26/05/2026 perdeu 340 bipes da LOJA03 (de 512 físicos chegaram só 172 ao servidor).
- Fallback NFe ativo em `stocktake.js:104` foi desligado e religado 2x este mês.
- `StoreStock.upsert` é real-time — bug = estoque divergente entre lojas = venda errada futura.

**Pré-condição para descongelar:**
- Plano dedicado com instrumentação de log estruturado (latência, retry count, resultado por bipe).
- Dashboard de saúde por loja.
- Teste de carga com rede simulada.
- Canário em LOJA03 por 7 dias antes de liberar pras outras.

---

## 2. Catálogo / Produtos

**Arquivos:**
- `src/routes/adminCatalog.js`
- `src/routes/products.js`
- `src/routes/categories.js`
- `src/routes/productImages.js`
- `src/routes/markup.js`
- `src/routes/suppliers.js`
- `src/routes/adminClassification.js`
- `_product-card.js` (dentro de `admin.html` e ~6 outras telas)
- Modelos: `Product`, `ProductSize`, `CategoryNode`, `Supplier`, `BrandRule`, `ProductLifecycle`

**Risco:**
- Cérebro do sistema. 5.187 produtos ativos hoje.
- `_product-card.js` usado em 6 telas distintas — mudar assinatura quebra cadeia.
- Endpoint `/admin/inventory/products` é consumido por Estoque, Categoria, Curadoria, scripts.
- Refator semântico (consolidação de cards duplicados) é trabalho de catálogo, não de modularização — escopo separado.

**Pré-condição para descongelar:**
- Não modularizar antes de consolidar cards duplicados (script `consolidate-products-by-model.js`).
- Não modularizar antes de fechar curadoria IA (rodar nos ~923 produtos crus restantes).
- Plano específico de catálogo com canário por marca.

---

## 3. Inventário

**Arquivos:**
- `src/routes/inventory.js` (cérebro do catálogo, endpoint `/admin/inventory/products`)
- Modelos: `StoreStock`

**Risco:**
- Endpoint consumido por múltiplas abas do admin e scripts.
- StoreStock real-time, decremento por venda futura.

**Pré-condição para descongelar:**
- Resolver Bipe antes (StoreStock confiável é pré-requisito).
- Plano separado.

---

## 4. Fiscal / NFe / NFCe / SEFAZ

**Arquivos:**
- `src/routes/fiscal.js`
- `src/routes/xmlImport.js`
- `src/services/fiscalApi.js`
- `src/services/fiscalAcquirers.js`
- `src/services/fiscalAgentClient.js`
- `src/services/fiscalDraftJob.js` (cron)
- `src/services/fiscalSefazDirect.mjs`
- `src/services/xmlNfeParser.js`
- `src/services/nfeSizeParser.js`
- Modelos: `XmlFiscalDocument`, `XmlFiscalItem`, `FiscalIssuer`, `FiscalDocument`

**Risco:**
- 2 incidentes este mês: 1.085 + 900 Products criados de NFe transferência indevidamente.
- Quebra de emissão NFCe = loja física sem cupom fiscal.
- `fiscalDraftJob` é cron — sem timezone `America/Fortaleza` dispara fora de hora.
- Certificado digital envolvido na emissão SEFAZ.

**Pré-condição para descongelar:**
- Função-fortaleza `classifyAndPersistNFe` codada antes (invariante de transferência).
- Dry-run endpoint validado.
- Plano específico de fiscal.

---

## 5. Schema Prisma

**Arquivo:**
- `prisma/schema.prisma` (114 modelos, 2.475 linhas)

**Risco:**
- Mudança destrutiva (drop column, rename, change type) afeta produção imediatamente.
- Migrações Prisma exigem `prisma migrate deploy` + janela de manutenção.
- 52% das tabelas vazias mas FKs cruzadas inviabilizam separação simples.

**Pré-condição para descongelar:**
- Nenhuma alteração de schema neste ciclo turbo.
- Separação em schemas múltiplos é projeto próprio fora desta linha de trabalho.

---

## 6. `public/admin.html`

**Arquivo:**
- `public/admin.html` (10.604 linhas, monolítico)

**Risco:**
- Concentra TODA a UI admin: dashboard, usuários, vendedores, catálogo, estoque, fiscal, financeiro, marketing, etiquetas, curadoria, bipes etc.
- Event handlers cruzados entre abas.
- Mudar assinatura de função utilitária quebra múltiplas abas silenciosamente.

**Pré-condição para descongelar:**
- Projeto dedicado de 2-4 semanas com dev sênior.
- Quebra por aba, com canário por feature.
- Não fazer em modo turbo.

---

## 7. Crons em produção

**Arquivos:**
- `src/services/marketingCron.js`
- `src/services/messagesCron.js`
- `src/services/fiscalDraftJob.js`
- Bootstrap em `src/index.js`

**Risco:**
- `marketingCron` publica em Instagram automaticamente.
- `messagesCron` envia mensagens ao cliente.
- `fiscalDraftJob` gera draft de NFe.
- Sem timezone `America/Fortaleza` dispara 3h fora.

**Pré-condição para descongelar:**
- Auditoria de timezone em todos os crons.
- Plano dedicado.

---

## 8. Scripts destrutivos

**Pasta:**
- `scripts/` (60 arquivos)

**Risco:**
- Nomes parecidos (`unify-by-supplier-ref` vs `unify-products-batch` vs `consolidate-products-by-model`).
- Vários sem flag `--dry-run` padrão.
- Possibilidade de hard delete de dados em produção.

**Pré-condição para descongelar:**
- Padronização de flag `--dry-run` como padrão.
- README por script declarando o que faz, se é destrutivo, como reverter.

---

## 9. Nuvemshop sync

**Arquivos:**
- `src/routes/nuvemshop.js`
- `src/services/nuvemshop.js`
- `src/services/nuvemshopHandlers.js`
- Modelos: `NuvemshopConnection`, `NuvemshopProductMapping`, etc.

**Risco:**
- Sync bidirecional ativo com produção Nuvemshop.
- Bug = produto somem do e-commerce ou preço sobrescrito.

**Pré-condição para descongelar:**
- Resolver consolidação de catálogo antes (sync de catálogo poluído polui Nuvemshop).
- Plano dedicado.

---

## 10. Marketing IA (com cron e publicação ao vivo)

**Arquivos:**
- `src/routes/marketing.js`
- `src/services/marketingCron.js`
- `src/services/instagramPublisher.js`
- 13+ services de IA (compositeImage, collageImage, falAi, openaiImage, etc.)

**Risco:**
- `marketingCron` publica em rede social pública.
- Cada chamada custa $ (Anthropic + fal.ai + OpenAI).
- 16 services interdependentes — extração mal feita quebra criativos da loja.

**Pré-condição para descongelar:**
- Plano dedicado.
- Smoke funcional em staging com chave de teste.

---

## 11. Curadoria de Produto IA (aiCuration)

**Arquivos:**
- `src/routes/aiCuration.js`
- `src/services/curationAgent.js`
- `scripts/run-curation-all.js`
- Modelos afetados: `Product.aiContext`, `ProductCreative`

**Risco:**
- 6.170 produtos curados de 7.093 (~87% do catálogo).
- Bug em refator pode reverter estado curado = trabalho perdido.
- Confunde com Curadoria de Vitrine (já extraída) — distinguir por path completo.

**Pré-condição para descongelar:**
- Plano dedicado.
- Snapshot completo de `Product.aiContext` antes.
- Canário em 10 produtos, validar visualmente.

---

## 12. Integrações externas em geral

**Não tocar via modularização turbo:**
- Anthropic (`@anthropic-ai/sdk`)
- fal.ai (`@fal-ai/client`)
- OpenAI
- Meta API (FB/IG/WhatsApp)
- Nuvemshop OAuth
- Resend (e-mail)
- Web Push (VAPID)
- Slack webhook
- SEFAZ (node-sped-nfe)
- Brave / Serper / Google Search

**Pré-condição para descongelar:**
- Camada `src/shared/integrations/` planejada, mas sem timeline definida.
- Plano próprio.

---

## 13. Module Life

**Arquivos:**
- `src/routes/life.js`
- `src/ai/recommendations/possibility-engine.service.js`
- `src/ai/agents/life-assessor.agent.js`
- `src/ai/agents/agent.registry.js`
- Modelos: `UserLifeProfile`, `UserMoodCheckin`, `UserTrainingLog`, `UserAction`

**Risco / Motivo:**
- Cadeia de dependência atravessa subsistema de IA (`src/ai/`).
- `POST /possibilities` chama Anthropic via agente.
- 11 endpoints, vários escrevem em banco.
- Classificado como **S1** em `docs/PLANO_BASELINE_LIFE.md` — não elegível para turbo.

**Pré-condição para descongelar:**
- Extração conjunta com `src/ai/agents/` e `src/ai/recommendations/`.
- Projeto próprio de extração da plataforma de IA.

---

# Regras para IAs futuras

Este bloco é vinculante para qualquer assistente IA que vier trabalhar no projeto TenisCash.

## 1. Nenhuma IA pode alterar área congelada sem plano separado.

Toda alteração em qualquer arquivo listado nas seções 1-13 deste documento exige:
- Plano dedicado em `docs/PLANO_<MODULO>.md`.
- Baseline pré-mudança em `docs/BASELINE_<MODULO>.md`.
- Autorização explícita do dono em conversa.
- Branch dedicada `refactor/<modulo>-<descricao>` ou `feat/<modulo>-<descricao>`.

## 2. Nenhuma IA pode alterar `prisma/schema.prisma` sem migração documentada e rollback.

- Migração Prisma versionada em `prisma/migrations/`.
- SQL de reversão documentado.
- Backup do banco antes de aplicar em produção.
- `prisma db push` em produção é proibido — sempre `prisma migrate deploy`.

## 3. Nenhuma IA pode chamar endpoint destrutivo durante refatoração.

Endpoints destrutivos incluem (não exaustivo):
- Qualquer `POST`, `PUT`, `DELETE` em produção.
- `POST /api/admin/xml/import`
- `POST /api/admin/labels/batches/...` e variantes
- `POST /api/admin/curation/...` e variantes
- `POST /api/admin/inventory/adjust`
- `POST /api/stocktake/bipe`
- Qualquer endpoint de transferência, venda ou ajuste de carteira.

Validação técnica de extração usa exclusivamente `node --check` + `node -e "require(...)"`. **Nunca chamar endpoint para validar.**

## 4. Nenhuma IA pode rodar script destrutivo durante refatoração.

Scripts em `scripts/` que escrevem em banco (`consolidate-*`, `unify-*`, `deactivate-*`, `cleanup-*`, `delete-*`, `apply-*`, `sync-*`, `push-*`, `match-*`, `create-products-*`) **não podem** ser executados como parte de uma refatoração — só como ação isolada, com autorização explícita do dono e plano de reversão.

## 5. Nenhuma IA pode chamar API externa durante refatoração.

Refator de código **não justifica** chamada Anthropic, fal.ai, OpenAI, Meta, Nuvemshop, SEFAZ, Resend, Slack, Brave, Serper, Google. Se a refatoração exige validação funcional desses serviços, isso fica em fase separada com autorização explícita.

## 6. Nenhuma IA pode mexer em Product / ProductSize / StoreStock / fiscal sem autorização explícita.

Essas 4 áreas são onde o sistema dói quando quebra. Toda mudança aqui exige:
- Plano dedicado.
- Backup do banco.
- Canário em 1 loja.
- Monitoramento de 24h pós-deploy.

## 7. Nenhuma IA pode fazer `git push`, `git merge`, `git rebase` ou `git reset --hard` em produção sem autorização explícita.

Branches de refator ficam locais até revisão. Push exige ordem direta do dono.

## 8. Nenhuma IA pode tocar em `public/admin.html` (10.604 linhas) sem plano completo.

Extração de aba do admin é projeto de dev sênior, não de refator turbo.

## 9. Nenhuma IA pode tocar em `_product-card.js` sem mapear os 6+ consumidores.

Mudar assinatura sem mapear = quebrar silenciosamente.

## 10. Nenhuma IA pode confundir Curadoria de Vitrine com Curadoria de Produto IA.

São módulos diferentes:
- **Vitrine** = `src/modules/curadoria-vitrine/` (extraído, 0 produção)
- **Produto IA** = `src/routes/aiCuration.js` + `src/services/curationAgent.js` (CONGELADO, 6.170 em produção)

Diferenciar pelo prefixo `ai` no path. Dupla checagem em cada comando.

---

**Este documento é vinculante. Tocar em área congelada sem seguir as pré-condições é violação direta das regras do projeto e pode causar perda de dado em produção.**
