# REGRAS_CRITICAS.md

Documento de regras invioláveis do projeto TenisCash.
Toda decisão de código, refatoração, integração ou script deve respeitar estas regras.
Qualquer descumprimento exige autorização explícita do dono (Douglas Bernardo) registrada em conversa.

Data: 2026-05-26
Branch de trabalho: `organizacao/refactor-2026-05-26`

---

## 1. Regras gerais (válidas para QUALQUER módulo)

Estas 6 regras foram declaradas pelo dono e têm prioridade absoluta sobre qualquer outro critério técnico:

1. **Nenhuma atualização pode remover comportamento existente sem autorização explícita.**
   - Refator não é desculpa para apagar feature.
   - Se uma rota, função, página, parâmetro ou efeito colateral existe hoje, ele continua existindo até o dono autorizar a remoção em conversa.
   - "Não estava sendo usado" não é justificativa suficiente. Verificar dados reais antes.

2. **Nenhuma alteração estrutural pode mudar regra de negócio.**
   - Mover arquivo, renomear função, extrair módulo, trocar ORM, mudar arquitetura: tudo deve preservar 100% do comportamento de negócio observável.
   - Se durante uma mudança estrutural surgir a tentação de "corrigir" uma regra de negócio, pare. Documente em separado. Peça autorização.

3. **Nenhuma mudança pode apagar dados sem regra documentada.**
   - Nada de `DELETE` em produção sem regra escrita neste documento ou em outro `.md` do `docs/`.
   - "Soft delete" (`active = false`, `deletedAt = now()`) é o padrão. Hard delete só com autorização explícita.
   - Scripts de limpeza precisam ter `--dry-run` por padrão e exigir `--apply` para executar.

4. **Integrações externas não podem corromper dados internos.**
   - Anthropic, fal.ai, OpenAI, Meta, Nuvemshop, Resend, Web Push, Slack, Asaas, focusNFe, Mercos, BlingAPI: nenhuma resposta dessas APIs pode escrever direto em tabelas críticas sem validação local primeiro.
   - Tabelas críticas: `Product`, `ProductSize`, `StoreStock`, `Sale`, `SaleItem`, `XmlFiscalDoc`, `XmlFiscalItem`, `Customer`, `User`.
   - Resposta de IA usada para `markup`, `price`, `categoria` ou `descricao` precisa passar por log + revisão antes de gravar em produção.

5. **Scripts destrutivos não podem rodar sem confirmação explícita.**
   - `scripts/` tem 60 arquivos. Vários mexem em dados (consolidate-products, dedup-bipes, fix-products, normalize-modelGroup, etc).
   - Padrão obrigatório: `node scripts/X.js` → DRY RUN. `node scripts/X.js --apply` → executa.
   - Scripts antigos sem essa proteção precisam ser revisados antes de rodar de novo.

6. **Mudanças no banco exigem migração documentada e plano de reversão.**
   - Toda alteração de schema (add column, drop column, rename, change type, new index, new table) precisa:
     - migração Prisma versionada em `prisma/migrations/`
     - SQL de reversão documentado (ou comando `prisma migrate resolve`)
     - backup do banco antes de aplicar em produção
     - mensagem no commit explicando o impacto
   - `prisma db push` em produção é proibido. Sempre `prisma migrate deploy`.

---

## 2. Regras específicas do negócio (Sports & Tennis)

Estas regras refletem realidades operacionais da rede e foram quebradas no passado. Não podem ser quebradas de novo.

### 2.1. NFe de transferência ≠ NFe de entrada

- NFe com CFOP de transferência (5152, 6152, 5409, 6409, 5151) **NUNCA** pode contar como compra/entrada de estoque.
- NFe de transferência **NUNCA** cria registro novo em `Product`.
- NFe de transferência só movimenta `StoreStock` entre lojas.
- Se um item da transferência não tem `Product` cadastrado, ele fica pendente em `XmlFiscalItem` aguardando vínculo manual. **Não cria Product automaticamente.**

### 2.2. Bipe nunca pode ser perdido

- Toda leitura de código de barras em `/bipar` precisa garantir entrega ao servidor.
- Falha de rede no `enviarBipe()` precisa enfileirar retry em `localStorage` e tentar de novo até ter resposta do servidor.
- Bipe não pode ser registrado localmente como "não encontrado" se a causa real foi falha de rede.
- Estados aceitáveis no front: `encontrado` / `nao_encontrado` (resposta real do servidor) / `pendente_rede` (aguardando retry).
- Estado proibido: `not_found` quando o servidor nunca respondeu.

### 2.3. Markup e preço

- Mudança de `markup` ou `price` em `Product` ou `ProductSize` exige ordem explícita do dono.
- Nenhum agente, IA ou script pode alterar preço sozinho.
- Resposta de pricing-margin-agent é sugestão, não ação. Aplicação requer humano.

### 2.4. Mensagem ao cliente

- Nenhum sistema pode enviar mensagem (WhatsApp, e-mail, SMS, push) ao cliente final sem aprovação humana.
- Exceção: `crm-whatsapp-agent` em modo rascunho (gera mas não envia).
- Push notification, e-mail Resend, WhatsApp via integração: todos exigem revisão antes do envio em massa.

### 2.5. Desconto e cupom

- Descontos acima de 15% exigem validação do `pricing-margin-agent` antes de aplicar.
- Cupons promocionais com vigência ativa em produção exigem registro em log com timestamp + responsável.

### 2.6. Conteúdo de marketing

- Qualquer publicação automática em redes sociais, site, Nuvemshop, blog ou anúncio precisa passar pelo `safety-agent` antes de ir ao ar.
- IA pode gerar conteúdo. IA não pode publicar.

### 2.7. Unificação de produtos (cards do catálogo)

- Chave de unificação: `(brand, modelGroup, name_base, color)`.
- **Gênero NÃO entra na chave de unificação.** Cores diferentes do mesmo modelo podem ter linhas masculina/feminina diferentes e devem aparecer como variantes de cor do mesmo card visual quando aplicável.
- O que NUNCA pode juntar: tamanhos do MESMO modelo+cor em cards separados.
- `modelGroup` deve seguir o padrão por marca (Converse=CK0004, ASICS=8 chars, PUMA=6 dígitos, etc).
- SKU é dos `ProductSize`, NÃO do card. Card é REF + DESC + COR.

### 2.8. Segredos e credenciais

- `.env` **NUNCA** pode ser commitado. Está em `.gitignore`.
- Tokens (Anthropic, fal.ai, OpenAI, Meta, Nuvemshop, Resend, Asaas, focusNFe, Mercos, BlingAPI, Web Push VAPID, Slack): apenas em variáveis de ambiente.
- Logs não podem imprimir `DATABASE_URL`, `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`.
- Backups do banco vão para `backups/` que também está no `.gitignore`.

### 2.9. Roles e permissões

- Roles reais no schema `User.role` (default `"user"`): `user`, `seller`, `admin`, `superadmin`, `partner`, `manager`.
- `user` — cliente final / dono de carteira TenisCash. Vê só os próprios dados.
- `seller` — vendedor de loja. Vê só dados da própria loja (`storeId`).
- `admin` — acesso geral ao painel.
- `superadmin` — acesso geral + operações sensíveis (mudança de role, etc).
- `partner` — parceiro do programa de parceiros.
- `manager` — adicionado em 26/05/2026. Equivale a admin nas checagens de acesso, mas `storeId = null` (vê todas as lojas).
- Mudança de role exige `superadmin`.
- **Não usar** `cliente` ou `vendedor` como nome de role — esses valores não existem no schema. São `user` e `seller`.

### 2.10. Lojas

- **6 lojas** físicas/lógicas no grupo, todas sob CNPJ raiz `44.052.617`:
  - **LOJA01** Baratão dos Esportes — CNPJ `44.052.617/0001-26` (outra empresa do grupo, NÃO é Sports & Tennis)
  - **LOJA02** Sports & Tennis Bessa — CNPJ `44.052.617/0002-07` (João Pessoa)
  - **LOJA03** Sports & Tennis Rainha da Borborema — CNPJ `44.052.617/0003-98` (Campina Grande)
  - **LOJA04** Sports & Tennis Ecommerce — CNPJ `44.052.617/0004-79`
  - **LOJA05** Sports & Tennis Tambaú — CNPJ `44.052.617/0005-50` (João Pessoa)
  - **LOJA06** Sports & Tennis Tambiá — CNPJ `44.052.617/0006-30` (João Pessoa)
- `StoreStock` é por `(productSizeId, storeId)`.
- Transferências entre lojas movimentam `StoreStock`, **não criam Product**.
- **NUNCA misturar Baratão (LOJA01) com Sports & Tennis (LOJA02–LOJA06)** em relatórios, contadores, sync Nuvemshop ou anúncios. Empresas distintas.
- A loja destino de uma NFe é determinada pelo `recipientCnpj` → `FiscalIssuer.cnpj` → `Store.fiscalIssuerId`. Nunca por código de loja inventado.

---

## 3. Áreas de risco identificadas no diagnóstico (MAPA_ATUAL.md)

### Risco ALTO — proibido mexer sem plano revisado

- `src/services/bipe.service.js` — lógica de upsert StoreStock + match por barcode
- `src/services/nfe-importer.service.js` — diferenciação entrada vs transferência
- `src/routes/stocktake.js` — endpoint POST /api/stocktake/bipe (entrada principal)
- `public/bipar.html` — fluxo offline-tolerant com retry queue
- `prisma/schema.prisma` — 114 modelos, migrações destrutivas proibidas

### Risco MÉDIO — exige PR revisado

- `public/admin.html` (monolítico, 10.604 linhas) — extração por aba precisa preservar event handlers
- `src/services/anthropic.service.js` — uso em creatives, classification, modelGroup
- `src/services/fal.service.js` — geração de imagem; custo por chamada
- `src/routes/sales.js` — Sale + SaleItem + StoreStock decremento atômico
- `src/services/nuvemshop.service.js` — sync bidirecional risco de overwrite

### Risco BAIXO — refator livre com testes

- `src/services/email.service.js` — wrapper Resend
- `src/routes/apex.js` — endpoints do app esportivo APEX (isolado)
- `src/routes/financial.js` — relatórios read-only
- `scripts/one-shot/*` — scripts já executados, marcar como deprecated
- `public/etiquetas.html` — gerador de etiquetas (isolado)

---

## 4. Hipóteses ainda não confirmadas

Estas são suspeitas levantadas no diagnóstico. NÃO TRATAR COMO VERDADE até confirmar com dados.

1. Hipótese: bipes perdidos hoje (340 da LOJA03) **foram** consequência exclusiva do bug do `catch { bipes.push({found:false}) }` e da ausência de retry queue.
   - Falta confirmar: análise dos logs do servidor por janela de horário, comparação com timestamps locais.

2. Hipótese: fallback de NFe (commit bc8207d) gerou matches falsos hoje.
   - Falta confirmar: listar `StocktakeBipe` criados entre 22:00 e 23:00 com `productId` recém-criado via NFe.

3. Hipótese: existem grupos de Products que ainda são o mesmo modelo+cor em cards separados por tamanho.
   - Falta confirmar: rodar `scripts/consolidate-products-by-model.js` em dry-run, contar grupos.

4. Hipótese: tabelas com 0 linhas (52% das tabelas) são features mortas e podem ser dropadas.
   - Falta confirmar: ler código e ver se há rota que escreve nelas; mortas vs nunca-usadas-ainda são coisas diferentes.

5. Hipótese: integrações Mercos, BlingAPI, Asaas estão ativas em produção.
   - Falta confirmar: ler `.env.example`, logs recentes, último uso de cada uma.

---

## 5. Módulos sugeridos (referência, não obrigação)

Ver `docs/MODULOS_DESEJADOS.md` para proposta completa. Resumo:

- `src/modules/{carteira, catalogo, inventario, bipe, fiscal, rh, vendas, mensagens, marketing-ia, curadoria-vitrine, ecommerce, financeiro, apex, admin}`
- `src/shared/{prisma, middleware, utils, integrations}`
- `public/{admin, vendedor, cliente, shared}`
- `scripts/{one-shot, ops, data-migration}`

Extração obedece as fases:
- Fase 1 (risco baixo): APEX, Curadoria, Financeiro, Marketing, Vendas
- Fase 2 (risco médio): RH, Mensagens, Fiscal, E-commerce, Admin
- Fase 3 (risco alto): Catálogo, Inventário, Bipe

Nenhuma extração começa sem `REGRESSION_CHECKLIST.md` validado para o módulo correspondente.

---

## 6. Procedimento padrão antes de QUALQUER mudança

1. Ler `MAPA_ATUAL.md` para entender o que existe.
2. Ler `MODULOS_DESEJADOS.md` para entender o destino.
3. Ler este documento (`REGRAS_CRITICAS.md`) e identificar quais regras se aplicam.
4. Ler `REGRESSION_CHECKLIST.md` e listar quais fluxos precisam ser testados.
5. Fazer backup do banco (`scripts/backup-db.js` ou equivalente).
6. Criar branch a partir de `organizacao/refactor-2026-05-26` (ou main).
7. Mudança mínima possível. Um módulo por vez. Um PR por vez.
8. Rodar checklist de regressão antes do merge.
9. Deploy gradual (1 loja primeiro se for bipe/estoque).
10. Monitorar por 24h antes de considerar concluído.

---

## 7. O que NÃO está autorizado neste ciclo de refator

- Mover arquivos.
- Renomear arquivos.
- Alterar rotas.
- Alterar schema do banco.
- Alterar comportamento.
- Criar testes (vem depois).
- Refatorar código.

Este ciclo atual é **somente documentação**. Os arquivos `MAPA_ATUAL.md`, `MODULOS_DESEJADOS.md`, `REGRAS_CRITICAS.md` e `REGRESSION_CHECKLIST.md` são entregáveis. Nenhum `.js`, `.html`, `.prisma` é tocado.
