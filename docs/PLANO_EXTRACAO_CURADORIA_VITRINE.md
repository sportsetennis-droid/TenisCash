# PLANO DE EXTRAÇÃO — Módulo Curadoria de Vitrine

> **Plano em modo DESIGN.** Documento descreve **como** a extração deveria ser feita se autorizada. **Não autoriza execução.** Nenhum arquivo será movido, renomeado ou alterado sem ordem explícita do dono em conversa.

- Data: 2026-05-26
- Branch alvo de trabalho: a definir (sugestão: `refactor/curadoria-vitrine-extracao-01`, derivada de `refactor/labels-extracao-01` ou de `organizacao/refactor-2026-05-26` conforme decisão do dono).
- Status: **CONCLUÍDO em 26/05/2026** — commit único `48525d9 refactor(curadoria-vitrine): extrair modulo` (modo turbo)

### Atestado pós-execução

- ✅ Mount `/api/admin/curation` literalmente preservado (linha 124 de `src/index.js`).
- ✅ Mount irmão `/api/admin/ai-curation` (linha 137) intocado.
- ✅ `src/routes/aiCuration.js` e `src/services/curationAgent.js` **NÃO foram tocados** (commits anteriores `3cc22fe` e `c0ef3dd` preservados como último commit).
- ✅ `prisma/schema.prisma` intocado.
- ✅ `package.json`, `.env`, `src/middleware.js`, `public/admin.html` intocados.
- ✅ `src/modules/apex/` e `src/modules/labels/` (extrações anteriores) intocados.
- ✅ Nenhum endpoint chamado, nenhum PDF gerado, nenhuma escrita em banco, nenhuma chamada externa.
- ✅ Working tree limpa após o commit.
- Precedentes:
  - APEX extraído em 26/05/2026 (commits `c070555`, `0af78f7`, `29ff92b`, `903f2e2`, `c0aaa03`).
  - Etiquetas extraído em 26/05/2026 (commits `7dc6bd0`, `b580c25`, `659bef3`, `77e7513`).
  - Mesmo padrão será aplicado aqui.

---

## 1. Objetivo da extração

Mover o código backend do módulo **Curadoria de Vitrine** para uma pasta isolada `src/modules/curadoria-vitrine/`, replicando o padrão validado em APEX e Etiquetas:

- 1 arquivo por commit atômico (neste caso só há 1 arquivo de código + README do módulo).
- `git mv` para preservar histórico.
- Apenas imports relativos ajustados — zero mudança de comportamento.
- Mount point string permanece literalmente igual (`/api/admin/curation`).
- Schema Prisma **não é tocado** — os 6 modelos `StoreCuration*` continuam no schema único.
- Nenhum endpoint chamado durante validação.
- Nenhuma chamada externa (não há).

O ganho é completar a Fase 1 (módulos de baixo risco) e reforçar a separação por bounded context. **Risco operacional praticamente zero** porque todas as 6 tabelas estão vazias hoje — Curadoria de Vitrine ainda não foi usada em produção.

---

## 2. Escopo: somente Curadoria de Vitrine

⚠️ **Este plano é EXCLUSIVAMENTE para o módulo `StoreCuration*` (Curadoria de Vitrine — montagem visual da loja física).**

**NÃO inclui** o módulo de **Curadoria de Produto IA** (`aiCuration`), que é coisa **completamente diferente**:

| | Curadoria de Vitrine (este plano) | Curadoria de Produto IA (NÃO tocar) |
|---|---|---|
| Route | `src/routes/curation.js` | `src/routes/aiCuration.js` |
| Mount point | `/api/admin/curation` | `/api/admin/ai-curation` |
| Service auxiliar | (nenhum) | `src/services/curationAgent.js` |
| Modelos | `StoreCuration`, `StoreCurationZone`, `StoreCurationItem`, `StoreCurationChecklist`, `StoreCurationPhoto`, `StoreCurationResult` | `Product.aiContext`, `ProductCreative`, etc. |
| Volume hoje | **0 linhas** (todas as 6 tabelas vazias) | **6.170 produtos curados** de 7.093 |
| Risco operacional | 🟢 BAIXÍSSIMO | 🔥 ALTO |
| Status nesta extração | **EM ESCOPO** | **FORA DE ESCOPO — não mover, não renomear, não tocar** |

Confirmar antes de qualquer comando que o alvo é `routes/curation.js`, **NÃO** `routes/aiCuration.js`.

---

## 3. Arquivos atuais relacionados à Curadoria de Vitrine

### Route (`src/routes/`)
- `curation.js` — **362 linhas**

### Service (`src/services/`)
- **Nenhum.** Curadoria de Vitrine **não tem service auxiliar próprio**. Toda a lógica vive no route handler.
- Os imports do route são apenas `express` e `../middleware` (que traz `authMiddleware`, `adminMiddleware`, `prisma`).

### Bootstrap (`src/index.js`)
- Linha 25: `const curationRoutes = require('./routes/curation');`
- Linha 124: `app.use('/api/admin/curation', curationRoutes);`

### Schema Prisma (`prisma/schema.prisma`)
- 6 modelos entre as linhas ~992 e ~1100:
  - `StoreCuration` (992)
  - `StoreCurationZone` (1016)
  - `StoreCurationItem` (1032)
  - `StoreCurationChecklist` (1055)
  - `StoreCurationPhoto` (1072)
  - `StoreCurationResult` (1087)

### Frontend
- `public/admin.html` tem (provavelmente) uma aba Curadoria que consome via `fetch('/api/admin/curation/...')`. O acoplamento é só pelo contrato HTTP — não há `<script src>` ou import direto.

### Outras referências cruzadas
- **Nenhuma.** `curation.js` é importado apenas por `src/index.js`. Não há service auxiliar; não há cross-import.

Total estimado de código a mover: **~362 linhas de JS** (1 arquivo) + criação de `src/modules/curadoria-vitrine/README.md`.

---

## 4. Rotas atuais relacionadas

Mount point em `src/index.js` linha 124:

```
app.use('/api/admin/curation', curationRoutes);
```

Todos os endpoints exigem `authMiddleware` + `adminMiddleware` (aplicados via `router.use(...)` no topo do arquivo, linhas 9-10).

**20 endpoints** em `curation.js`:

| # | Linha | Método | Path completo |
|---|---|---|---|
| 1 | 13 | `GET` | `/api/admin/curation/zones` |
| 2 | 27 | `POST` | `/api/admin/curation/zones` |
| 3 | 41 | `PUT` | `/api/admin/curation/zones/:id` |
| 4 | 53 | `DELETE` | `/api/admin/curation/zones/:id` |
| 5 | 63 | `GET` | `/api/admin/curation/` (lista de curadorias) |
| 6 | 84 | `GET` | `/api/admin/curation/:id` |
| 7 | 102 | `POST` | `/api/admin/curation/` (cria curadoria) |
| 8 | 143 | `PUT` | `/api/admin/curation/:id` |
| 9 | 158 | `DELETE` | `/api/admin/curation/:id` |
| 10 | 168 | `POST` | `/api/admin/curation/:id/items` |
| 11 | 192 | `PUT` | `/api/admin/curation/:id/items/:itemId` |
| 12 | 204 | `DELETE` | `/api/admin/curation/:id/items/:itemId` |
| 13 | 214 | `POST` | `/api/admin/curation/:id/checklist` |
| 14 | 231 | `PUT` | `/api/admin/curation/:id/checklist/:taskId` |
| 15 | 245 | `DELETE` | `/api/admin/curation/:id/checklist/:taskId` |
| 16 | 255 | `POST` | `/api/admin/curation/:id/photos` |
| 17 | 274 | `DELETE` | `/api/admin/curation/:id/photos/:photoId` |
| 18 | 284 | `PUT` | `/api/admin/curation/:id/result` |
| 19 | 301 | `GET` | `/api/admin/curation/:id/suggestions` |

(O número 20 é o `router.use(...)` do middleware no topo; conta total real é 19 endpoints + middleware.)

**Classificação de operação:**
- **GETs puros** (read-only): zones list, curation list, curation detail, suggestions.
- **POST/PUT/DELETE**: todos escrevem em `StoreCuration*` (ou em `Product` se for o caso — checar `/suggestions`).
- **`/suggestions`** (linha 301): lê `Product` (cross-domain) — não escreve nada. Read-only puro.

**Nenhum endpoint gera PDF.**
**Nenhum endpoint chama API externa** (Anthropic, fal.ai, etc.).
**Nenhum endpoint envia mensagem ou e-mail.**

---

## 5. Services atuais relacionados

**Nenhum service específico.** Toda a lógica está no próprio `routes/curation.js`. Diferente de Etiquetas (que tinha `labelGenerator.js`) e APEX (que tinha `activityIngest.js` + `aiCoach.js`).

A extração é mais simples por isso: só 1 arquivo de código a mover.

---

## 6. Mount points em `src/index.js`

Linha 25: `const curationRoutes = require('./routes/curation');`
Linha 124: `app.use('/api/admin/curation', curationRoutes);`

**Mount string `/api/admin/curation` é o contrato público — NÃO PODE MUDAR.** Apenas a linha 25 (`require(...)`) será ajustada para apontar para o novo path interno.

---

## 7. Tabelas / models Prisma usados

Localizados em `prisma/schema.prisma`:

| # | Model | Linha | Uso em curation.js |
|---|---|---|---|
| 1 | `StoreCuration` | 992 | curadoria-raiz (uma por loja por evento de curadoria) |
| 2 | `StoreCurationZone` | 1016 | zonas físicas da loja (vitrine, manequim, prateleira A, etc.) |
| 3 | `StoreCurationItem` | 1032 | produto curado dentro de uma zona |
| 4 | `StoreCurationChecklist` | 1055 | tarefas a executar (limpar, reabastecer, conferir preço…) |
| 5 | `StoreCurationPhoto` | 1072 | fotos antes/depois de cada zona |
| 6 | `StoreCurationResult` | 1087 | resultado consolidado (score, observações, próximos passos) |

Cross-domain:
- `Product` (catalogo) — lido apenas no endpoint `/suggestions` (linhas 309, 325, 341) para sugerir produtos antigos, em promo e featured. **Leitura apenas**.

Todos os 6 modelos `StoreCuration*` permanecem **dentro do schema único**. Como APEX e Etiquetas, separar models para schema próprio é trabalho futuro fora deste plano.

---

## 8. Estado atual das tabelas (volume)

Conforme `docs/MAPA_ATUAL.md`:

```
StoreCuration*, [...] — todas vazias (modelagem feita antes do uso)
```

**Zero produção.** Nenhuma linha em qualquer das 6 tabelas. Significa:

- Quebrar a extração **não afeta nenhuma operação real** das lojas.
- Não há snapshot pré/pós a preservar.
- Nenhum vendedor, gerente ou administrador depende destes endpoints hoje.
- Maior margem de manobra que APEX (vazias mas com integração futura planejada) ou Etiquetas (em uso real diário).

Este é provavelmente o **módulo mais seguro de toda a Fase 1** para extração.

---

## 9. Quem importa ou chama a rota de Curadoria de Vitrine

Resultado de `grep -rnE "(require\(['\"][^'\"]*routes/curation\b|curationRoutes\s*=\s*require)" src/ public/ scripts/`:

```
src/index.js:25:  const curationRoutes = require('./routes/curation');
```

**Exatamente 1 importador**, no bootstrap. Nenhum outro arquivo em `src/`, `public/` ou `scripts/` importa o `curation.js`.

Frontend (`public/admin.html`) referencia `/api/admin/curation/...` em `fetch()` — não é import de código JS, é contrato HTTP. Não precisa mudar.

Importante: a busca foi feita com `\b` (word boundary) para garantir que o resultado **não captura** `aiCuration` (que tem prefix diferente: `require('./routes/aiCuration')`). Confirmação dupla via grep negativo.

---

## 10. Dependências internas

### Curadoria de Vitrine → fora do módulo (saídas)

1. **`src/middleware.js`** — `authMiddleware`, `adminMiddleware` E **`prisma`** instance importados na linha 6 de `curation.js`:
   ```js
   const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
   ```
   Mesmo padrão de Etiquetas (instância compartilhada de Prisma, **não** `new PrismaClient()` local).

2. **`Product`** (módulo `catalogo`) — lido em `GET /:id/suggestions` para popular sugestões. Read-only puro, não escreve em `Product`.

3. **`Store`** — referenciado indiretamente via `storeId` em `StoreCuration` e `StoreCurationZone`. Sem FK declarada Prisma, só String. Sem leitura direta da tabela `Store` no route.

### Fora de Curadoria de Vitrine → módulo (entradas)

- **`src/index.js`** linhas 25 + 124 — único consumidor backend.
- **`public/admin.html`** consome via `fetch('/api/admin/curation/...')` — sem dependência de código JS do servidor; depende apenas do contrato HTTP.
- **Nenhum cron** dispara código de Curadoria de Vitrine.
- **Nenhuma rota fora do módulo** chama código de Curadoria de Vitrine.

### Conclusão de acoplamento

Curadoria de Vitrine é **autocontido**, com 2 costuras de **dado** (não de código):
- `authMiddleware` + `adminMiddleware` + `prisma` instance via `../middleware` (compartilhados, **não mover**).
- Leitura da tabela `Product` (módulo `catalogo`) — só no endpoint `/suggestions`.

---

## 11. Dependências externas

| Dependência | Onde | Crítica? |
|---|---|---|
| `express` | `curation.js` | Compartilhado. |
| `@prisma/client` | indireto via `middleware` | Compartilhado. |

**Nenhuma outra dependência npm.** Sem `pdfkit`, sem `qrcode`, sem `pdfkit`, sem `multer` (uploads de foto presumivelmente são gerenciados pelo frontend → resource URL guardada como string).

**Nenhuma integração de rede externa.** Sem Anthropic, fal.ai, OpenAI, Meta, Nuvemshop, Resend, Web Push, Slack, SEFAZ.

Curadoria de Vitrine é, em deps externas, ainda mais leve que Etiquetas — usa só `express` + Prisma.

---

## 12. Riscos da extração

### 🟢 Risco baixíssimo (esperado)
- Todas as 6 tabelas vazias. Zero produção.
- Apenas 1 arquivo de código a mover (sem service auxiliar).
- 1 único importador (`src/index.js:25`).
- Nenhuma integração externa.
- Nenhum cron, nenhum job, nenhum webhook.
- Padrão de extração já validado 2 vezes (APEX, Etiquetas).

### 🟡 Risco médio (atenção pontual)
- **Confusão com `aiCuration`.** Risco operacional do humano que executar — confundir os dois e mover/tocar o módulo errado. Mitigação: dupla checagem antes de cada comando (validar com `\b` e com path completo `routes/curation` vs `routes/aiCuration`).
- **Dependência de leitura do `Product`** em `/suggestions`. Refator do `Product` em paralelo pode quebrar suggestions. Risco transversal — não introduzido por esta extração, mas relevante registrar.
- **`public/admin.html` provavelmente tem aba Curadoria** consumindo via fetch. Se algum dia for tocada nessa aba, deve preservar o path `/api/admin/curation/...`. (Esta extração não toca em admin.html.)

### 🔥 Risco alto (a evitar nesta fase)
- **Renomear `routes/curation.js` para nome menos confuso** (ex: `routes/storeCuration.js`). NÃO fazer — só movimentação de pasta, sem renomear arquivo.
- **Mover models `StoreCuration*` para outro schema Prisma.** NÃO fazer. Schema único permanece.
- **Renomear endpoints `/api/admin/curation` para `/api/admin/store-curation`** (clareza vs aiCuration). NÃO fazer — refator semântico fora de escopo.
- **Tocar em `aiCuration.js` ou `curationAgent.js` por engano.** ZERO tolerância. Esse módulo tem 6.170 produtos curados em produção.

---

## 13. O que NÃO pode ser tocado

Lista vinculante para esta extração:

1. **`prisma/schema.prisma`** — não mover models, não renomear, não dropar nada. Os 6 modelos `StoreCuration*` continuam onde estão.
2. **`src/middleware.js`** — permanece. `authMiddleware`, `adminMiddleware` e `prisma` continuam exportados daqui.
3. **`public/admin.html`** — aba Curadoria (se existir) não é tocada. Contrato HTTP preservado.
4. **`src/routes/aiCuration.js`** — **FORA DE ESCOPO ABSOLUTO.** Módulo diferente, 6.170 produtos em produção.
5. **`src/services/curationAgent.js`** — **FORA DE ESCOPO ABSOLUTO.** Service de Curadoria de Produto IA.
6. **`src/routes/stocktake.js`, `xmlImport.js`, `fiscal.js`, `adminCatalog.js`, `products.js`, `inventory.js`** — proibidos por `REGRAS_CRITICAS.md`.
7. **`src/index.js`** — único ajuste permitido: trocar `require('./routes/curation')` na linha 25 por `require('./modules/curadoria-vitrine/routes/curation')` (ou similar). Linha 124 (mount point string) permanece **literal**.
8. **Behavior dos endpoints** — preservado 100%.
9. **Dados/tabelas** — zero alteração (irrelevante, estão vazias, mas registrar).
10. **`package.json`, `.env`, `.gitignore`** — intocados.
11. **`src/modules/apex/...`**, **`src/modules/labels/...`** — extrações anteriores intocadas.
12. **Todos os outros routes/services não-relacionados.**
13. **`Product`, `ProductSize`, `StoreStock`, `Sale`** — não tocados (este módulo só lê `Product` no `/suggestions`, e essa leitura permanece exatamente igual).
14. **`_product-card.js`** — não tocado.

---

## 14. Diferença explícita: Curadoria de Vitrine ≠ Curadoria de Produto IA

Repetindo para evitar confusão durante a execução:

### Curadoria de Vitrine (este plano)
- **O que é:** ferramenta para o gerente da loja montar a vitrine física — escolher zonas, escolher produtos para cada zona, fazer checklist de tarefas, subir fotos antes/depois, registrar resultado.
- **Quem usa:** gerentes de loja física, em loja, periodicamente.
- **Volume:** 0 (tabelas vazias).
- **Route:** `src/routes/curation.js`
- **Mount:** `/api/admin/curation`
- **Modelos:** `StoreCuration*` (6 tabelas).
- **Risco:** baixíssimo. Mexer não afeta nada em produção.

### Curadoria de Produto IA (FORA DE ESCOPO — NÃO TOCAR)
- **O que é:** pipeline de IA que classifica produtos, gera nome canônico, sugere foto, define cor/marca/modelo, popula `aiContext`. Usa Anthropic + busca de imagem.
- **Quem usa:** admin/superadmin, em massa, para enriquecer o catálogo.
- **Volume:** 6.170 produtos curados de 7.093 (≈87% do catálogo).
- **Route:** `src/routes/aiCuration.js`
- **Service:** `src/services/curationAgent.js`
- **Mount:** `/api/admin/ai-curation`
- **Modelos afetados:** `Product.aiContext`, `Product.name`, `ProductCreative`, etc.
- **Risco:** ALTO. Mexer pode reverter estado curado de 6.170 produtos = trabalho real perdido.

**Toda vez que rodar um comando, conferir o path completo:** `routes/curation.js` ≠ `routes/aiCuration.js`. Diferença de 1 prefixo (`ai`) faz a diferença entre baixo risco e alto risco.

---

## 15. Plano de execução em passos pequenos

Cada passo é um commit atômico independente. Ordem obrigatória.

### Passo 0 — Pré-requisitos (sem código)
- Backup do banco (política do projeto, mesmo com tabelas vazias).
- Branch criada a partir de `refactor/labels-extracao-01` (HEAD com APEX + Etiquetas extraídos + docs atualizados), ou de `organizacao/refactor-2026-05-26` conforme decisão do dono.
- `git status` limpo.
- **Confirmar via grep que `routes/curation.js` é o alvo (e NÃO `routes/aiCuration.js`):**
  ```bash
  grep -nE "routes/curation\b" src/index.js
  grep -nE "routes/aiCuration\b" src/index.js
  ```
  Verificar que retornam linhas distintas (25 e 40, respectivamente).

### Passo 1 — Inventário detalhado (sem mover nada)
- Ler `src/routes/curation.js` integralmente (362 linhas).
- Anotar todos os `require()` internos e externos.
- Anotar todos os 19 endpoints expostos + qual escreve no banco.
- Anotar todos os models Prisma acessados.
- Confirmar **dupla checagem** que `aiCuration.js` NÃO está na lista.
- Gerar lista de paths que mudarão e paths que **não** mudarão.

### Passo 2 — Criar a pasta destino (vazia)
- Criar `src/modules/curadoria-vitrine/` com subpasta `routes/`.
- **Não criar `services/`** — Curadoria de Vitrine não tem service auxiliar.
- Adicionar `src/modules/curadoria-vitrine/README.md` descrevendo o módulo (objetivo, arquivo a mover, mount, schema-fica-fora, distinção explícita vs aiCuration, etc.).
- **Não mover nada ainda.** Apenas estrutura + README.
- Commit: `chore(curadoria-vitrine): cria estrutura src/modules/curadoria-vitrine/ + README`.

### Passo 3 — Mover `curation.js`
- `git mv src/routes/curation.js src/modules/curadoria-vitrine/routes/curation.js`.
- Atualizar `require` em `src/index.js` linha 25 para `./modules/curadoria-vitrine/routes/curation`.
- Atualizar import relativo dentro do arquivo movido:
  - Linha 6: `require('../middleware')` → `require('../../../middleware')`.
- `node --check` em `src/index.js` e no arquivo movido.
- `node -e "const r = require('./src/modules/curadoria-vitrine/routes/curation'); console.log(typeof r)"` deve retornar `function` (Express router).
- Commit: `refactor(curadoria-vitrine): mover route curation para modulo Curadoria de Vitrine`.

### Passo 4 — `index.js` do módulo (opcional, mas recomendado)
- Decisão do dono. Pode ser adiado como foi no APEX e em Etiquetas.
- Se executado: criar `src/modules/curadoria-vitrine/index.js` exportando `{ curationRoutes }`, simplificar `src/index.js` linha 25.
- Commit: `refactor(curadoria-vitrine): expõe routes via modules/curadoria-vitrine/index.js`.

### Passo 5 — Documentação
- Atualizar `docs/MAPA_ATUAL.md` (apontar nova localização do módulo).
- Atualizar `docs/MODULOS_DESEJADOS.md` (marcar Curadoria de Vitrine como ✓ extraído + atualizar Fase 1; próximo candidato passa a ser **Life**).
- Atualizar `docs/PLANO_EXTRACAO_CURADORIA_VITRINE.md` (este arquivo) com status pós-execução e hashes dos commits.
- Atualizar `docs/REGRESSION_CHECKLIST.md` com padrão de validação segura para mudanças futuras em Curadoria de Vitrine.
- Commit: `docs(curadoria-vitrine): marcar extracao do modulo Curadoria de Vitrine como concluida`.

### Passo 6 — Encerramento
- Rodar checklist manual de validação (seção 19).
- Gerar `RELATORIO_VALIDACAO_FINAL_CURADORIA_VITRINE`.
- Abrir PR (ou aguardar autorização). **Não fazer merge automático.**

---

## 16. Testes seguros antes/depois

⚠️ **Padrão:** mesmo de APEX e Etiquetas. Validação técnica restrita a `node --check` + `node -e "require(...)"`, sem chamar endpoint.

### Antes da extração (Baseline)
- [ ] `git status` limpo.
- [ ] Confirmação dupla de que `curation.js` ≠ `aiCuration.js` via grep.
- [ ] `npm start` sobe sem erro local; encerrar imediatamente, não bater em endpoint.
- [ ] Snapshot read-only: `count(*)` de `StoreCuration`, `StoreCurationZone`, `StoreCurationItem`, `StoreCurationChecklist`, `StoreCurationPhoto`, `StoreCurationResult`. Esperado: tudo zero. Confirmar.

### Smoke test técnico após movimentação (Passo 3)
- [ ] `node --check src/index.js`
- [ ] `node --check src/modules/curadoria-vitrine/routes/curation.js`
- [ ] `node -e "const r = require('./src/modules/curadoria-vitrine/routes/curation'); console.log(typeof r)"` retorna `function`.
- [ ] `npm start` sobe sem erro de "Cannot find module" — desligar imediatamente. **Não bater em endpoint.**

### Smoke test funcional (somente depois de autorização)
- Como as tabelas estão vazias, o smoke funcional é menos crítico. Mas se quiser confirmar:
- [ ] Em **staging**, criar 1 `StoreCurationZone` via API, listar, deletar. Confirmar contagem volta a zero.
- [ ] **Não** criar dados em produção.

### Canários não-Curadoria-de-Vitrine (depois da extração, opcional)
- [ ] `GET /api/auth/me` continua funcionando.
- [ ] `GET /api/admin/inventory/products?limit=5` continua funcionando.
- [ ] `GET /api/admin/ai-curation/...` continua funcionando (módulo "irmão" não afetado).
- [ ] Rotas APEX (`/api/activities`, `/api/coach`) e Etiquetas (`/api/admin/labels/...`) continuam respondendo igual ao baseline.

---

## 17. Critérios de aceite

A extração é considerada **concluída com sucesso** quando todos abaixo forem verdadeiros:

1. ✅ Arquivo `curation.js` vive dentro de `src/modules/curadoria-vitrine/routes/`.
2. ✅ `src/routes/` não contém mais `curation.js`.
3. ✅ `src/routes/aiCuration.js` continua **intocado** no local original.
4. ✅ `src/services/curationAgent.js` continua **intocado** no local original.
5. ✅ `prisma/schema.prisma` **não foi tocado**.
6. ✅ `package.json`, `.env`, `src/middleware.js` **não foram tocados**.
7. ✅ Mount point `/api/admin/curation` continua ativo com string idêntica em `src/index.js`.
8. ✅ Mount point `/api/admin/ai-curation` continua ativo e inalterado.
9. ✅ Servidor sobe sem erro (`npm start` em local, sem chamar endpoint).
10. ✅ `node --check` e `node -e "require(...)"` passam em todos os arquivos do escopo.
11. ✅ Nenhum endpoint **não-Curadoria-de-Vitrine** mudou comportamento.
12. ✅ `git log` mostra commits pequenos (1 chore + 1 refactor + 1 docs).
13. ✅ Branch criada a partir do estado correto.
14. ✅ PR aberto, **não merged**, aguardando aprovação.
15. ✅ Documentação atualizada no Passo 5.
16. ✅ Relatório final `RELATORIO_VALIDACAO_FINAL_CURADORIA_VITRINE` aprovado.

---

## 18. Plano de rollback

Cada passo é um commit isolado. Rollback é trivial.

### Rollback parcial (1 passo)
- `git revert <hash_do_commit>`.
- `node --check` no arquivo afetado para confirmar.

### Rollback total
- `git reset --hard <hash_do_Passo_0>` (no branch de trabalho, **nunca em main**).
- OU `git checkout <branch_anterior>` e descartar a branch de extração.

### Rollback de banco
- **Não esperado precisar.** Plano não toca em schema nem em dados (tabelas vazias, mas mesmo se houvesse dado, extração não escreve).

### Quando acionar rollback
- Servidor não sobe após qualquer commit.
- `node -e "require(...)"` falha em qualquer arquivo do escopo.
- Qualquer warning de "Cannot find module" no startup.
- **Algum endpoint de `aiCuration` ou APEX ou Etiquetas parou de funcionar** (sinal de que mexemos em algo que não devia).
- `src/services/curationAgent.js` aparecer como modificado em `git status` (sinal claro de erro humano — esse arquivo não deve ser tocado).

---

## 19. Checklist manual de validação

Rodar **antes** de declarar a extração concluída.

### A. Ambiente e branch
- [ ] Branch atual é a de trabalho (não `main`).
- [ ] `git status --short -uall` limpo.
- [ ] HEAD do branch pai registrado.
- [ ] Backup do banco do Passo 0 acessível.
- [ ] **Dupla confirmação:** o alvo é `curation`, não `aiCuration`. Verificado via grep.

### B. Estrutura de arquivos
- [ ] `src/modules/curadoria-vitrine/README.md` existe.
- [ ] `src/modules/curadoria-vitrine/routes/curation.js` existe.
- [ ] `src/routes/curation.js` **NÃO** existe.
- [ ] `src/routes/aiCuration.js` **continua existindo** no path original.
- [ ] `src/services/curationAgent.js` **continua existindo** no path original.

### C. Bootstrap
- [ ] `src/index.js` linha 25 importa `./modules/curadoria-vitrine/routes/curation`.
- [ ] `src/index.js` linha 40 continua importando `./routes/aiCuration` (inalterado).
- [ ] `src/index.js` linha 124 continua exatamente `app.use('/api/admin/curation', curationRoutes);`.
- [ ] `src/index.js` linha 137 continua exatamente `app.use('/api/admin/ai-curation', aiCurationRoutes);`.
- [ ] Nenhuma outra linha de `src/index.js` foi alterada.

### D. Sintaxe e carga
- [ ] `node --check src/index.js` → OK.
- [ ] `node --check src/modules/curadoria-vitrine/routes/curation.js` → OK.
- [ ] `node --check src/routes/aiCuration.js` → OK (sem mudança, mas confirmar não quebrou).
- [ ] `node --check src/services/curationAgent.js` → OK.
- [ ] `node -e "const r = require('./src/modules/curadoria-vitrine/routes/curation'); console.log(typeof r)"` → `function`.
- [ ] `node -e "const r = require('./src/routes/aiCuration'); console.log(typeof r)"` → `function` (módulo irmão não afetado).
- [ ] `npm start` sobe e mostra "listening on PORT"; encerrar imediatamente. **Não bater em endpoint.**

### E. Schema e banco
- [ ] `prisma/schema.prisma` idêntico ao baseline (`git diff <hash_pre_extracao> -- prisma/schema.prisma` vazio).
- [ ] Snapshot de `count(*)` das 6 tabelas `StoreCuration*` igual ao baseline (esperado: todas zero).
- [ ] `Product.count()` igual ao baseline.

### F. Cross-references preservadas
- [ ] `grep -r "require.*routes/curation\b" src/` retorna **1** ocorrência: a do `src/index.js` apontando pra `./modules/curadoria-vitrine/routes/curation`.
- [ ] `grep -r "require.*routes/aiCuration\b" src/` retorna **1** ocorrência: a do `src/index.js` apontando pra `./routes/aiCuration` (inalterado).
- [ ] Confirmar que nenhum outro arquivo passa a importar `curation` ou `aiCuration` durante a extração.

### G. Documentação
- [ ] `docs/MAPA_ATUAL.md` reflete nova localização.
- [ ] `docs/MODULOS_DESEJADOS.md` marca Curadoria de Vitrine como ✅ extraído + atualiza Fase 1 (Life vira próximo candidato).
- [ ] `docs/PLANO_EXTRACAO_CURADORIA_VITRINE.md` (este arquivo) atualizado com hashes dos commits.
- [ ] `docs/REGRESSION_CHECKLIST.md` atualizado com padrão de validação segura para Curadoria de Vitrine.
- [ ] Nenhum outro doc foi alterado fora do escopo.

### H. Git
- [ ] `git log` mostra commits pequenos: 1 `chore` + 1 `refactor` + 1 `docs`.
- [ ] Branch foi feita a partir do estado correto.
- [ ] PR aberto, **não merged**.

### I. Negativo (o que NÃO deve aparecer)
- [ ] `git show --name-only <commits_da_extracao>` **não** lista `src/routes/aiCuration.js`.
- [ ] `git show --name-only <commits_da_extracao>` **não** lista `src/services/curationAgent.js`.
- [ ] `git show --name-only <commits_da_extracao>` **não** lista `prisma/schema.prisma`.
- [ ] `git show --name-only <commits_da_extracao>` **não** lista nenhum arquivo em `src/routes/` exceto a entrada do rename de `curation.js`.

---

## Observações finais

- **Curadoria de Vitrine é o módulo mais leve da Fase 1**: 1 arquivo, 362 linhas, sem service, sem cron, sem deps npm pesadas, sem integração externa, 0 linhas em produção.
- **A maior fonte de risco é humana**: confundir `curation.js` com `aiCuration.js`. Mitigação: dupla checagem em cada comando, e atestado explícito no checklist (seções 13, 14, 19.I) de que o módulo irmão permanece intocado.
- Padrão validado em APEX e Etiquetas deve render ainda mais fácil aqui. Estimativa: **3 commits totais** (`chore` da estrutura, `refactor` da route, `docs` da finalização), todos individualmente revertíveis.
- Após esta extração, completa-se a Fase 1 dos módulos vazios/baixíssimo risco. Próximo da fila: **Life** (`life.js` + `UserLifeProfile`) — também isolado, também simples.

**Este documento é apenas planejamento. Nenhum arquivo foi movido, renomeado ou alterado. Nenhum código foi tocado. Nenhum endpoint foi chamado. Nenhuma execução está autorizada.**
