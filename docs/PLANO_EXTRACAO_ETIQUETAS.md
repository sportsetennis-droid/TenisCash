# PLANO DE EXTRAÇÃO — Módulo Etiquetas

> **Plano executado e validado.** Em 26/05/2026 a extração foi realizada com sucesso em 3 commits atômicos. A validação final (`RELATORIO_VALIDACAO_FINAL_LABELS`) foi **APROVADA**. Schema Prisma, banco, mount point público, endpoints, PDFs e integrações externas **não foram alterados ou executados**. Este documento foi atualizado para refletir o estado pós-extração.

- Data do plano: 2026-05-26
- Data da execução: 2026-05-26
- Branch onde o trabalho aconteceu: `refactor/labels-extracao-01` (derivada de `refactor/apex-extracao-01` no commit `46d5296`)
- Status: **CONCLUÍDO** (com Passo 5 adiado, ver seção 12)
- Precedente: extração APEX concluída em 26/05/2026 (commits `c070555`, `0af78f7`, `29ff92b`, `903f2e2`, `c0aaa03`). Mesmo padrão foi aplicado.

### Tabela mestra de commits da extração

| Passo | Commit | Mensagem |
|---|---|---|
| 0. Sanity check (deps `pdfkit`/`qrcode`, importadores, status limpo) | — | (`RELATORIO_SANITY_PRE_LABELS` no histórico de turnos) |
| 2. Criar estrutura `src/modules/labels/` + README | `7dc6bd0` | `chore(labels): criar estrutura inicial do modulo` |
| 3. Mover `labels.js` | `b580c25` | `refactor(labels): mover route labels para modulo Etiquetas` |
| 4. Mover `labelGenerator.js` | `659bef3` | `refactor(labels): mover service labelGenerator para modulo Etiquetas` |
| 5. `index.js` do módulo | — | **NÃO EXECUTADO / ADIADO** (opcional, sem benefício no curto prazo — mesma decisão do APEX) |
| 6. Documentação | (este commit `docs(labels):`) | `docs(labels): marcar extracao do modulo Etiquetas como concluida` |
| 7. Validação final | — | `RELATORIO_VALIDACAO_FINAL_LABELS` — **APROVADO** |

### Atestado pós-execução

- ✅ Mount point `/api/admin/labels` permaneceu literalmente idêntico (linha 122 de `src/index.js`).
- ✅ Schema Prisma **não foi tocado** — os 4 modelos `Label*` (linhas ~903 a ~995) continuam no schema único.
- ✅ Banco **não recebeu nenhuma escrita** durante a extração.
- ✅ Nenhum endpoint público foi chamado durante a validação (especialmente `GET /templates` e `GET /batches/:id/pdf`, que escrevem).
- ✅ Nenhum PDF foi gerado (`generateLabelsPDF` não invocada).
- ✅ Nenhuma chamada externa (Anthropic, fal.ai, etc.) — Etiquetas não tem integração de rede de qualquer forma.
- ✅ `npm start` não foi executado durante a validação.
- ✅ `package.json`, `.env`, `src/middleware.js`, `public/admin.html` permanecem intocados.

---

## 1. Objetivo da extração

Mover o código backend do módulo **Etiquetas** para uma pasta isolada `src/modules/labels/`, replicando o padrão validado na extração APEX:

- 1 arquivo por commit atômico.
- `git mv` para preservar histórico.
- Apenas imports relativos ajustados — zero mudança de comportamento.
- Mount points string permanecem literalmente iguais (`/api/admin/labels`).
- Schema Prisma **não é tocado**.
- Nenhum endpoint chamado durante validação (especialmente porque alguns GETs escrevem — ver seção 10).
- Nenhuma chamada externa (não há, módulo é puramente local).

O ganho é reforçar a separação por bounded context e treinar o padrão em um módulo um pouco maior que APEX (734 linhas vs 371). Sem ganho funcional imediato — etiquetas continuam funcionando exatamente como hoje.

---

## 2. Arquivos atuais relacionados a Etiquetas

### Routes (`src/routes/`)
- `labels.js` — **301 linhas**

### Services (`src/services/`)
- `labelGenerator.js` — **433 linhas**

### Bootstrap (`src/index.js`)
- Linha 23: `const labelsRoutes = require('./routes/labels');`
- Linha 122: `app.use('/api/admin/labels', labelsRoutes);`

### Schema Prisma (`prisma/schema.prisma`)
- 4 modelos entre as linhas ~903 e ~995:
  - `LabelTemplate` (linha 903)
  - `LabelBatch` (linha 936)
  - `LabelItem` (linha 956)
  - `LabelPrintLog` (linha 974)

### Frontend
- **Não existe `public/etiquetas.html`.** A UI de etiquetas vive dentro de `public/admin.html` na aba "Etiquetas" (várias linhas a partir da ~266 e seção em ~939).
- A UI consome a API exclusivamente via `fetch('/api/admin/labels/...')` — **não há `<script src>` ou import direto** do código backend. O acoplamento é só pelo contrato HTTP.

### Outras referências cruzadas no código
- **Nenhuma.** `labels.js` é importado apenas por `src/index.js`. `labelGenerator.js` é importado apenas por `labels.js`. Confirmado via grep global em `src/`, `public/`, `scripts/`.

Total estimado de código a mover: **~734 linhas de JS** (2 arquivos) + criação de `src/modules/labels/README.md`.

---

## 3. Rotas atuais relacionadas

Mount point em `src/index.js` linha 122:

```
app.use('/api/admin/labels', labelsRoutes);
```

Todos os endpoints exigem `authMiddleware` + `adminMiddleware` (aplicados no `router.use(...)` no topo do arquivo).

| Método | Path | Escreve banco? | Custo externo |
|---|---|---|---|
| `GET` | `/api/admin/labels/templates` | **SIM** — `ensureDefaultTemplates()` cria `LabelTemplate` se não existir (idempotente, mas escreve na primeira vez ou se mudou layout S&T) | Não |
| `GET` | `/api/admin/labels/batches` | Não | Não |
| `GET` | `/api/admin/labels/batches/:id` | Não | Não |
| `POST` | `/api/admin/labels/batches` | **SIM** — cria `LabelBatch` + `LabelItem`s | Não |
| `GET` | `/api/admin/labels/batches/:id/pdf` | **SIM** — `update({ status: 'GENERATED' })` + lê `Product` p/ enriquecer | Não |
| `POST` | `/api/admin/labels/batches/:id/print` | **SIM** — cria `LabelPrintLog` + `update({ status: 'PRINTED' })` | Não |
| `DELETE` | `/api/admin/labels/batches/:id` | **SIM** — hard delete de `LabelBatch` (cascateia em `LabelItem`, `LabelPrintLog`) | Não |
| `POST` | `/api/admin/labels/batches/quick` | **SIM** — lê `Product`s + cria `LabelBatch` + `LabelItem`s | Não |

⚠️ **ATENÇÃO crítica:** ao contrário do APEX, **GETs em Etiquetas podem escrever no banco** (`templates` e `batches/:id/pdf`). Isso elimina a possibilidade de smoke test "GET-only safe" durante a extração. Validação deve se basear em `node --check` + `node -e "require(...)"` **somente** — não bater em endpoint nenhum, nem GET.

---

## 4. Services atuais relacionados

| Service | Linhas | Responsabilidade |
|---|---|---|
| `src/services/labelGenerator.js` | 433 | Geração de PDF de etiquetas via `pdfkit`. Inclui `defaultTemplates()`, layouts (A4 5×13, 3×10, 2×5, 2×2; térmica 40×30, 50×30, 60×40, 100×50), layout especial S&T 130mm × 14-27mm com fundo laranja `#E5571E` + QR code, formatação BRL, render assíncrono de QR via `qrcode`. |

### Referências cross-domain do service
- **`@prisma/client`**: NÃO importa. Service é stateless de DB — recebe dados via parâmetro e devolve Buffer PDF. (Diferente do APEX onde `activityIngest.js` faz query no User.)
- **`pdfkit`**: npm package.
- **`qrcode`**: npm package.
- **`buffer`**: built-in Node.

---

## 5. Mount points em `src/index.js`

Linha 23: `const labelsRoutes = require('./routes/labels');`
Linha 122: `app.use('/api/admin/labels', labelsRoutes);`

**Mount point string `/api/admin/labels` é o contrato público — NÃO PODE MUDAR.** Apenas a linha 23 (`require(...)`) será ajustada para apontar para o novo path interno.

---

## 6. Dependências internas

### Etiquetas → fora de Etiquetas (saídas)

1. **`src/middleware.js`** — `authMiddleware`, `adminMiddleware` E **`prisma`** são importados na linha 6 de `labels.js`:
   ```js
   const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
   ```
   Diferente do APEX: aqui o `PrismaClient` é a instância compartilhada exportada de `middleware.js`, não `new PrismaClient()` local. Mais conservador, e correto.

2. **`Product`** (módulo `catalogo`) — lido em:
   - `GET /batches/:id/pdf` (linha 143): `prisma.product.findMany({ where: { id: { in: productIds } } })` para enriquecer items com nome, marca, preço, `aiContext`.
   - `POST /batches/quick` (linhas 255, 270): leitura por `productIds` para popular `LabelItem`s.

3. **Tabelas Labels:** `LabelTemplate`, `LabelBatch`, `LabelItem`, `LabelPrintLog` — todas em `prisma/schema.prisma` no schema único.

### Fora de Etiquetas → Etiquetas (entradas)

- **`src/index.js`** linhas 23 + 122 — único consumidor backend.
- **`public/admin.html`** aba Etiquetas — consome via `fetch('/api/admin/labels/...')`. Sem dependência de código JS do servidor; depende apenas do contrato HTTP.
- **Nenhum cron** dispara código Etiquetas.
- **Nenhuma rota fora de Etiquetas** chama código deste módulo.

### Conclusão de acoplamento

Etiquetas é **quase autocontido**, igual ao APEX. As costuras reais são:
- `authMiddleware` + `adminMiddleware` + `prisma` instance via `../middleware` (compartilhados, **não mover**).
- Leitura da tabela `Product` (módulo `catalogo`) — dependência de **dado**, não de código.
- Frontend `admin.html` via HTTP contract.

---

## 7. Dependências externas

| Dependência | Onde | Crítica? |
|---|---|---|
| `pdfkit` (npm) | `labelGenerator.js` | Sim — sem PDF, sem etiqueta. Mas é puramente local, sem network. |
| `qrcode` (npm) | `labelGenerator.js` | Necessária pra QR codes do layout S&T. Local. |
| `buffer` (Node built-in) | `labelGenerator.js` | Sempre disponível. |
| `@prisma/client` | indireto via `middleware` | Compartilhado. |
| `express` | `labels.js` | Compartilhado. |

**Nenhuma integração de rede:** zero requests a Anthropic, fal.ai, OpenAI, Meta, Nuvemshop, Resend, Slack, SEFAZ. Etiquetas é totalmente offline-friendly do ponto de vista do servidor.

---

## 8. Tabelas / models Prisma usados

Localizados em `prisma/schema.prisma`:

| # | Model | Linha | Usado em (route) |
|---|---|---|---|
| 1 | `LabelTemplate` | 903 | `GET /templates`, `POST /batches`, `GET /batches/:id/pdf`, `POST /batches/quick` |
| 2 | `LabelBatch` | 936 | todos os endpoints de `/batches/...` |
| 3 | `LabelItem` | 956 | criado via nested em `LabelBatch.items.create` |
| 4 | `LabelPrintLog` | 974 | `POST /batches/:id/print` |
| 5 | `Product` | (não-labels, módulo catalogo) | leitura em `GET /batches/:id/pdf` e `POST /batches/quick` |

Todos os 4 modelos `Label*` permanecem **dentro do schema único**. Como APEX, separar models para schema próprio é trabalho futuro fora deste plano.

Há FKs entre os modelos Label*:
- `LabelBatch.templateId` → `LabelTemplate.id`
- `LabelItem.labelBatchId` → `LabelBatch.id` (cascade delete)
- `LabelPrintLog.labelBatchId` → `LabelBatch.id` (cascade delete)
- `LabelBatch.createdById`, `LabelBatch.storeId`, `LabelItem.productId`, `LabelPrintLog.printedById` — FKs implícitas via String (não há relação Prisma declarada para User, Store, Product nesses campos).

---

## 9. Quem importa ou chama `labels.js` e `labelGenerator.js`

Resultado de `grep -rnE "(require\(['\"][^'\"]*labels\b|require\(['\"][^'\"]*labelGenerator\b)" src/ public/ scripts/`:

```
src/index.js:23                  const labelsRoutes = require('./routes/labels');
src/routes/labels.js:7           const { generateLabelsPDF, defaultTemplates } = require('../services/labelGenerator');
```

**Exatamente 2 importadores:**
- `src/index.js` importa a route. Único consumidor no boot.
- `labels.js` importa o service. Único consumidor do service.

**Nenhum** outro arquivo em `src/`, `public/` ou `scripts/` faz `require` ou `import` de `labels` ou `labelGenerator`. Confirmação dupla via grep global.

Frontend (`public/admin.html`) referencia `/api/admin/labels/...` em fetch — não é import de código JS, é contrato HTTP. Não precisa mudar.

---

## 10. Riscos da extração

### 🟢 Risco baixo (esperado)
- Estrutura modular paralela à do APEX, que já foi extraído com sucesso.
- Zero cron, zero integração externa de rede.
- Único importador da route é `src/index.js`. Único importador do service é a route.
- `mount point` é literal e preservável.

### 🟡 Risco médio (atenção)
- **GETs que escrevem.** Diferente do APEX. Ao validar a extração, **não chamar endpoint nenhum** — usar somente `node --check` + `node -e "require(...)"`. Bater em `GET /templates` cria `LabelTemplate`s; bater em `GET /batches/:id/pdf` muda status. Smoke test via HTTP só pode ser feito **depois** do dono autorizar, e em ambiente staging.
- **Etiquetas é uma feature em uso real.** Diferente do APEX que tem todas as tabelas vazias, etiquetas é usada operacionalmente (vendedores imprimem). Quebrar = vendedores não imprimem.
- **Dependência de leitura do `Product`.** O service de PDF lê `aiContext` do Product. Refator do `Product` em paralelo pode quebrar geração de etiqueta. Risco transversal — não introduzido por esta extração, mas relevante registrar.
- **2 dependências npm (`pdfkit`, `qrcode`).** Se `package.json` ou `node_modules` estiver corrompido em staging, o `require` falha. Validar com `node -e "require('pdfkit')"` antes de prosseguir.

### 🔥 Risco alto (a evitar nesta fase)
- **Mover models Labels para outro schema Prisma agora.** NÃO fazer. FK implícita para `Product`/`User`/`Store` exige schema compartilhado.
- **Renomear endpoints.** NÃO fazer. `admin.html` quebra silenciosamente.
- **Ajustar comportamento "GETs que escrevem".** Tentação é grande (deveriam ser POST), mas refator semântico **não pertence** a esta extração — só movimento físico. Fica registrado para ciclo futuro.
- **Mexer em `admin.html`** para "limpar" a aba etiquetas. Fora de escopo absoluto.

---

## 11. O que NÃO pode ser tocado

Lista vinculante para esta extração:

1. **`prisma/schema.prisma`** — não mover models, não renomear, não dropar nada. Os 4 modelos `Label*` continuam onde estão.
2. **`src/middleware.js`** — permanece. `authMiddleware`, `adminMiddleware` e `prisma` continuam exportados daqui.
3. **`public/admin.html`** — aba Etiquetas não é tocada. Contrato HTTP preservado.
4. **`src/routes/stocktake.js`, `xmlImport.js`, `fiscal.js`, `adminCatalog.js`, `products.js`, `inventory.js`, `aiCuration.js`** — proibidos por `REGRAS_CRITICAS.md`. Sem motivo para tocar nesta extração.
5. **`src/index.js`** — único ajuste permitido: trocar `require('./routes/labels')` na linha 23 por `require('./modules/labels/routes/labels')` (ou similar). Linha 122 (mount point string) permanece **literal**.
6. **Behavior dos endpoints** — incluindo o fato de que `GET /templates` cria rows e `GET /batches/:id/pdf` muda status. Comportamento "bagunçado" mas preservado. Não há refator semântico.
7. **Dados/tabelas** — zero alteração. Banco intocado.
8. **`package.json`, `.env`, `.gitignore`** — intocados.
9. **`src/modules/apex/...`** — intocado. Extração anterior não é afetada.
10. **Todos os outros routes/services não-Etiquetas.**

---

## 12. Plano de execução em passos pequenos

Cada passo é um commit atômico independente. Ordem obrigatória.

### Passo 0 — Pré-requisitos (sem código)
- Backup do banco (política do projeto, mesmo Etiquetas tendo dados — pra rollback de segurança).
- Branch criada a partir de `refactor/apex-extracao-01` (HEAD com APEX já extraído + docs atualizados) — ou de `organizacao/refactor-2026-05-26` se o trabalho APEX foi mergeado. Decisão do dono.
- `git status` limpo.
- Validar que `node -e "require('pdfkit'); require('qrcode')"` retorna sem erro (sanity check de deps).

### Passo 1 — Inventário detalhado (sem mover nada)
- Ler `src/routes/labels.js` e `src/services/labelGenerator.js` integralmente.
- Anotar todos os `require()` internos e externos.
- Anotar todos os 8 endpoints expostos + qual escreve no banco.
- Anotar todos os models Prisma acessados.
- Gerar lista de paths que mudarão e paths que **não** mudarão.

### Passo 2 — Criar a pasta destino (vazia) ✅ **CONCLUÍDO** (commit `7dc6bd0`)
- Criar `src/modules/labels/` com subpastas `routes/` e `services/`.
- Adicionar `src/modules/labels/README.md` descrevendo o módulo (objetivo, arquivos, mount, schema-fica-fora, etc.).
- **Não mover nada ainda.** Apenas estrutura + README.
- Commit: `chore(labels): cria estrutura src/modules/labels/ (vazia) + README`.

### Passo 3 — Mover `labels.js` ✅ **CONCLUÍDO** (commit `b580c25`)
- `git mv src/routes/labels.js src/modules/labels/routes/labels.js`.
- Atualizar `require` em `src/index.js` linha 23 para `./modules/labels/routes/labels`.
- Atualizar imports relativos dentro do arquivo movido:
  - Linha 6: `require('../middleware')` → `require('../../../middleware')`
  - Linha 7: `require('../services/labelGenerator')` → `require('../../../services/labelGenerator')` (caminho ainda aponta para o local antigo, será simplificado no Passo 4)
- `node --check` em `src/index.js` e no arquivo movido.
- `node -e "const r = require('./src/modules/labels/routes/labels'); console.log(typeof r)"` deve retornar `function` (Express router).
- Commit: `refactor(labels): mover rota labels para modulo Labels`.

### Passo 4 — Mover `labelGenerator.js` ✅ **CONCLUÍDO** (commit `659bef3`)
- `git mv src/services/labelGenerator.js src/modules/labels/services/labelGenerator.js`.
- Atualizar `require` dentro de `src/modules/labels/routes/labels.js` linha 7: `require('../../../services/labelGenerator')` → `require('../services/labelGenerator')` (caminho interno simplificado).
- `labelGenerator.js` não tem `require` relativo interno (só `pdfkit`, `qrcode`, `buffer`) — confirmar com `grep -nE "require\(['\"]\.\.?/" src/services/labelGenerator.js`.
- `node --check` em ambos os arquivos.
- `node -e "const s = require('./src/modules/labels/services/labelGenerator'); console.log(typeof s, Object.keys(s).join(','))"` deve retornar `object`, com chaves `generateLabelsPDF,defaultTemplates`.
- `node -e "const r = require('./src/modules/labels/routes/labels'); console.log(typeof r)"` deve continuar retornando `function`.
- Commit: `refactor(labels): mover service labelGenerator para modulo Labels`.

### Passo 5 — `index.js` do módulo (opcional) ⏸ **NÃO EXECUTADO / ADIADO**

**Motivo do adiamento:** ganho puramente cosmético (1 linha em `src/index.js`). Sem benefício operacional. Mesma decisão tomada na extração APEX. Pode ser retomado em ciclo de polimento futuro.
- Decisão do dono. Pode ser adiado como foi no APEX.
- Se executado: criar `src/modules/labels/index.js` exportando `{ labelsRoutes }`, simplificar `src/index.js` linha 23.
- Commit: `refactor(labels): expõe routes via modules/labels/index.js`.

### Passo 6 — Documentação ✅ **EM EXECUÇÃO** (este commit `docs(labels):`)
- Atualizar `docs/MAPA_ATUAL.md` (apontar nova localização do módulo Etiquetas).
- Atualizar `docs/MODULOS_DESEJADOS.md` (marcar Etiquetas como ✓ extraído + atualizar Fase 1).
- Atualizar `docs/PLANO_EXTRACAO_ETIQUETAS.md` (este arquivo) com status pós-execução e hashes dos commits.
- Atualizar `docs/REGRESSION_CHECKLIST.md` se mencionar paths antigos de Etiquetas.
- Commit: `docs(labels): marcar extracao do modulo Etiquetas como concluida`.

### Passo 7 — Encerramento ✅ **CONCLUÍDO** (`RELATORIO_VALIDACAO_FINAL_LABELS` aprovado)
- Rodar checklist manual de validação (seção 16).
- Gerar `RELATORIO_VALIDACAO_FINAL_LABELS` (formato igual ao do APEX).
- Abrir PR (ou aguardar autorização). **Não fazer merge automático.**

---

## 13. Testes seguros antes/depois

⚠️ **Importante:** Etiquetas tem GETs que escrevem. **Não chamar endpoint nenhum** — nem GET — durante a validação técnica da extração. Validação se restringe a:

### Antes da extração (Baseline)
- [ ] `git status` limpo.
- [ ] `npm start` sobe sem erro (em ambiente local, **não em produção**). Observar log de startup; não bater em endpoint.
- [ ] Encerrar o servidor logo após boot OK.
- [ ] Snapshot dos hashes git de `src/routes/labels.js`, `src/services/labelGenerator.js`, `src/index.js`, `prisma/schema.prisma`, `package.json`, `src/middleware.js`.
- [ ] Snapshot de contagens read-only: `SELECT count(*) FROM "LabelTemplate"`, `LabelBatch`, `LabelItem`, `LabelPrintLog`. Documentar.

### Smoke test técnico após cada movimentação (Passos 3 e 4)
- [ ] `node --check` em todos os arquivos do escopo.
- [ ] `node -e "require(...)"` para cada arquivo movido + para `src/index.js` (carregando o módulo principal sem subir servidor).
- [ ] Confirmar que `node -e "require('./src/modules/labels/routes/labels')"` retorna `function`.
- [ ] Confirmar que `node -e "require('./src/modules/labels/services/labelGenerator')"` retorna `object` com chaves `generateLabelsPDF,defaultTemplates`.
- [ ] `npm start` sobe sem erro de "Cannot find module" — desligar imediatamente.

### Smoke test funcional **somente** depois de autorização explícita do dono
- [ ] Em **staging**, gerar 1 lote de etiquetas com 1 produto, baixar PDF, validar visualmente que o layout S&T sai correto.
- [ ] Em **staging**, validar contagem de `LabelTemplate` (deve ser igual ou maior — ensureDefaultTemplates é idempotente).
- [ ] Em **staging**, criar um lote-teste e marcar como impresso. Em seguida deletar para limpar o teste.
- [ ] Comparar `count(LabelBatch)` antes/depois — não deve haver crescimento espontâneo.

### Canários não-Etiquetas (depois da extração, opcional)
- [ ] `GET /api/auth/me` continua funcionando.
- [ ] `GET /api/admin/inventory/products?limit=5` continua funcionando.
- [ ] `/api/activities`, `/api/coach` (rotas APEX) continuam respondendo igual ao baseline.

---

## 14. Critérios de aceite

A extração é considerada **concluída com sucesso** quando todos abaixo forem verdadeiros:

1. ✅ Arquivos `labels.js` e `labelGenerator.js` vivem dentro de `src/modules/labels/`.
2. ✅ `src/routes/` não contém mais `labels.js`.
3. ✅ `src/services/` não contém mais `labelGenerator.js`.
4. ✅ `prisma/schema.prisma` **não foi tocado**.
5. ✅ `package.json`, `.env`, `src/middleware.js` **não foram tocados**.
6. ✅ Mount point `/api/admin/labels` continua ativo com string idêntica em `src/index.js`.
7. ✅ Servidor sobe sem erro (`npm start` em local, sem chamar endpoint).
8. ✅ `node --check` e `node -e "require(...)"` passam em todos os arquivos do escopo.
9. ✅ Nenhum endpoint **não-Etiquetas** mudou comportamento (apenas inferido pelo fato de só `src/index.js` linha 23 e os 2 arquivos do módulo serem alterados).
10. ✅ `git log` mostra commits pequenos (1 por arquivo movido), com mensagens claras.
11. ✅ Branch criada a partir do estado correto (refactor/apex-extracao-01 ou organizacao/refactor-2026-05-26).
12. ✅ PR aberto, **não merged**, aguardando aprovação do dono.
13. ✅ Documentação atualizada no Passo 6.
14. ✅ Relatório final `RELATORIO_VALIDACAO_FINAL_LABELS` aprovado.

---

## 15. Plano de rollback

Cada passo é um commit isolado. Rollback é trivial.

### Rollback parcial (1 passo)
- `git revert <hash_do_commit>`.
- Boot local com `node --check` para confirmar.

### Rollback total (volta ao estado antes da extração)
- `git reset --hard <hash_do_Passo_0>` (no branch de trabalho, **nunca em main**).
- OU `git checkout <branch_anterior>` e descartar a branch de extração.

### Rollback de banco
- **Não esperado precisar.** Plano não toca em schema nem em dados (zero `prisma.X.create/update/delete` durante extração).
- Se o smoke test funcional pós-extração criou lotes-teste, deletar manualmente pelo `id` registrado.

### Quando acionar rollback
- Servidor não sobe após qualquer commit.
- Endpoint Etiquetas retorna 500 onde antes retornava 200 (só verificável quando o dono autorizar smoke funcional).
- `node -e "require(...)"` falha em qualquer arquivo do escopo.
- Qualquer warning de "Cannot find module" no startup.
- Algum outro módulo (APEX, catálogo, etc.) deixa de funcionar.

---

## 16. Checklist manual de validação

Rodar **antes** de declarar a extração concluída.

### A. Ambiente e branch
- [ ] Branch atual é a de trabalho (não `main`, não `origin/main`).
- [ ] `git status --short -uall` limpo.
- [ ] HEAD do branch pai registrado (para rollback se preciso).
- [ ] Backup do banco do Passo 0 acessível.

### B. Estrutura de arquivos
- [ ] `src/modules/labels/README.md` existe.
- [ ] `src/modules/labels/routes/labels.js` existe.
- [ ] `src/modules/labels/services/labelGenerator.js` existe.
- [ ] `src/routes/labels.js` **NÃO** existe.
- [ ] `src/services/labelGenerator.js` **NÃO** existe.

### C. Bootstrap
- [ ] `src/index.js` linha 23 importa `./modules/labels/routes/labels`.
- [ ] `src/index.js` linha 122 continua exatamente `app.use('/api/admin/labels', labelsRoutes);`.
- [ ] Nenhuma outra linha de `src/index.js` foi alterada.

### D. Sintaxe e carga
- [ ] `node --check src/index.js` → OK.
- [ ] `node --check src/modules/labels/routes/labels.js` → OK.
- [ ] `node --check src/modules/labels/services/labelGenerator.js` → OK.
- [ ] `node -e "const r = require('./src/modules/labels/routes/labels'); console.log(typeof r)"` → `function`.
- [ ] `node -e "const s = require('./src/modules/labels/services/labelGenerator'); console.log(typeof s, Object.keys(s).join(','))"` → `object generateLabelsPDF,defaultTemplates`.
- [ ] `npm start` sobe e mostra "listening on PORT"; encerrar com Ctrl+C imediatamente. **Não bater em endpoint.**

### E. Schema e banco
- [ ] `prisma/schema.prisma` idêntico ao baseline (`git diff <hash_pre_extracao> -- prisma/schema.prisma` vazio).
- [ ] `prisma/migrations/` sem arquivo novo.
- [ ] `prisma validate` passa sem mudança.
- [ ] Snapshot de contagens das 4 tabelas Label igual ao baseline (sem crescimento espontâneo da extração).

### F. Cross-references preservadas
- [ ] `grep -r "require.*routes/labels\b" src/` retorna **0** ocorrências no caminho antigo (`./routes/labels` sem `modules/labels`).
- [ ] `grep -r "require.*services/labelGenerator\b" src/` retorna **0** ocorrências no caminho antigo.
- [ ] `src/middleware.js` continua exportando `authMiddleware`, `adminMiddleware`, `prisma`.

### G. Documentação
- [ ] `docs/MAPA_ATUAL.md` reflete nova localização.
- [ ] `docs/MODULOS_DESEJADOS.md` marca Etiquetas como ✅ extraído.
- [ ] `docs/PLANO_EXTRACAO_ETIQUETAS.md` (este arquivo) atualizado com hashes dos commits.
- [ ] `docs/REGRESSION_CHECKLIST.md` atualizado se necessário.
- [ ] Nenhum outro doc foi alterado fora do escopo.

### H. Git
- [ ] `git log` mostra commits pequenos (1 por arquivo movido + 1 de docs).
- [ ] Branch foi feita a partir do estado correto.
- [ ] PR aberto, **não merged**.

### I. Funcional (somente com autorização)
- [ ] Smoke funcional em staging (gerar 1 PDF, validar layout S&T, deletar lote-teste).
- [ ] APEX continua funcionando (cruzar com `RELATORIO_VALIDACAO_FINAL_APEX`).

---

## Observações finais

- **Etiquetas é um módulo um pouco maior que APEX (734 vs 371 linhas)**, mas estruturalmente igual: 1 route + 1 service + 4 modelos Prisma que ficam no schema único.
- **Risco real é menor que aparenta:** o módulo é puramente local (sem chamada externa), sem cron, sem subscription. A única costura semântica que merece atenção é a leitura de `Product` no service.
- **GETs que escrevem** são a única peculiaridade operacional. Durante a extração, **não chamar endpoint** — confiar em `node --check` + `node -e "require(...)"` igual ao APEX.
- Padrão validado em APEX deve render bem aqui. Estimativa: 3 commits de código (`chore` da estrutura, `refactor` da route, `refactor` do service) + 1 commit de docs = **4 commits totais**, todos individualmente revertíveis.

**Este documento é apenas planejamento. Nenhum arquivo foi movido, renomeado ou alterado. Nenhum código foi tocado. Nenhum endpoint foi chamado. Nenhuma execução está autorizada.**
