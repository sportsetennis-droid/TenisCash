# BASELINE PRÉ-EXTRAÇÃO — Módulo Curadoria de Vitrine

> Estado capturado **antes** de qualquer movimento de arquivo. Tudo aqui é leitura. Nenhum endpoint foi chamado. Nenhuma escrita em banco. Nenhuma chamada externa.
>
> Este documento serve como **referência de comparação** depois da extração. Tudo que está aqui deve estar idêntico depois (exceto o 1 arquivo `curation.js` que vai mudar de pasta e a linha 25 de `src/index.js`).

Data da captura: 2026-05-26

---

## 1. Estado Git

### Branch atual
```
refactor/curadoria-vitrine-extracao-01
```

### Commit atual (HEAD)
```
cdc531c9c66722249d1334d7d425feabbcd27153
```

### `git status` antes da extração
```
(vazio)
```

Working tree **limpa**: zero arquivos modificados, staged ou untracked.
Ponto de partida ideal para iniciar a próxima extração modular.

### Confirmação do plano commitado

`docs/PLANO_EXTRACAO_CURADORIA_VITRINE.md` está commitado em `cdc531c` (HEAD).

Tamanho: **522 linhas**.

Últimos 3 commits desta branch:
```
cdc531c (HEAD -> refactor/curadoria-vitrine-extracao-01)  docs(curadoria-vitrine): criar plano de extracao
77e7513 (refactor/labels-extracao-01)                      docs(labels): marcar extracao do modulo Etiquetas como concluida
659bef3                                                     refactor(labels): mover service labelGenerator para modulo Etiquetas
```

A branch tem o plano de extração já no histórico, pronta para receber o baseline (este arquivo) como segundo commit.

---

## 2. Escopo confirmado

### Dentro do escopo (a ser movido)

| Arquivo | Linhas | Status |
|---|---|---|
| `src/routes/curation.js` | **362** | será movido para `src/modules/curadoria-vitrine/routes/curation.js` |

**Não há service auxiliar.** Curadoria de Vitrine é o módulo mais leve — só 1 arquivo de código, sem nenhum `service/*` correspondente.

### FORA do escopo (intocados)

| Arquivo | Linhas | Status |
|---|---|---|
| `src/routes/aiCuration.js` | 250 | módulo Curadoria de **Produto IA**, NÃO TOCAR |
| `src/services/curationAgent.js` | 281 | service de Curadoria de **Produto IA**, NÃO TOCAR |

Tamanhos verificados via `wc -l`. Existência confirmada via `[ -e ]`.

**Confirmação dupla via grep:**

```
src/index.js:25:  const curationRoutes  = require('./routes/curation');     ← alvo
src/index.js:40:  const aiCurationRoutes = require('./routes/aiCuration');  ← FORA DE ESCOPO
```

Distinção visível pelo prefixo `ai`. Comando `\b` em grep garante captura precisa de um vs outro.

---

## 3. Mount point atual

### `/api/admin/curation` (alvo desta extração)

Em `src/index.js`:
```
linha 25:   const curationRoutes = require('./routes/curation');
linha 124:  app.use('/api/admin/curation', curationRoutes);
```

**Linha 25** é a única que será alterada no Passo 3 (require path).
**Linha 124** (mount string) permanece **literal** — `/api/admin/curation`.

### `/api/admin/ai-curation` (mount irmão — NÃO PODE SER TOCADO)

Em `src/index.js`:
```
linha 40:   const aiCurationRoutes = require('./routes/aiCuration');
linha 137:  app.use('/api/admin/ai-curation', aiCurationRoutes);
```

**Nenhuma das duas linhas pode ser modificada por esta extração.** O módulo Curadoria de Produto IA é completamente separado e tem 6.170 produtos curados em produção.

---

## 4. Endpoints atuais (`src/routes/curation.js`)

Todos atrás de `authMiddleware` + `adminMiddleware` aplicados via `router.use(...)` no topo do arquivo (linhas 9-10).

| # | Linha | Método | Path | Classificação |
|---|---|---|---|---|
| 1 | 13 | `GET` | `/zones` | **read-only real** (lista zonas, opcionalmente por `storeId`) |
| 2 | 27 | `POST` | `/zones` | **cria dados** (`StoreCurationZone.create`) |
| 3 | 41 | `PUT` | `/zones/:id` | **altera dados** (`StoreCurationZone.update`) |
| 4 | 53 | `DELETE` | `/zones/:id` | **apaga dados** (`StoreCurationZone.delete`) |
| 5 | 63 | `GET` | `/` | **read-only real** (lista curadorias) |
| 6 | 84 | `GET` | `/:id` | **read-only real** (detalhe de curadoria com nested) |
| 7 | 102 | `POST` | `/` | **cria dados** (`StoreCuration.create` + checklist) |
| 8 | 143 | `PUT` | `/:id` | **altera dados** (`StoreCuration.update`) |
| 9 | 158 | `DELETE` | `/:id` | **apaga dados** (cascateia em items, checklist, photos, result) |
| 10 | 168 | `POST` | `/:id/items` | **cria dados** (`StoreCurationItem.create`) |
| 11 | 192 | `PUT` | `/:id/items/:itemId` | **altera dados** |
| 12 | 204 | `DELETE` | `/:id/items/:itemId` | **apaga dados** |
| 13 | 214 | `POST` | `/:id/checklist` | **cria dados** (`StoreCurationChecklist.create`) |
| 14 | 231 | `PUT` | `/:id/checklist/:taskId` | **altera dados** |
| 15 | 245 | `DELETE` | `/:id/checklist/:taskId` | **apaga dados** |
| 16 | 255 | `POST` | `/:id/photos` | **upload/foto** (registra `StoreCurationPhoto`; o upload físico é gerenciado fora) |
| 17 | 274 | `DELETE` | `/:id/photos/:photoId` | **apaga dados** |
| 18 | 284 | `PUT` | `/:id/result` | **checklist/result** (upsert `StoreCurationResult`) |
| 19 | 301 | `GET` | `/:id/suggestions` | **suggestions com leitura cruzada de `Product`** (sem escrita; lê `Product` para sugerir produtos antigos, em promo, featured) |

**Resumo:**
- 4 GETs (todos read-only puros).
- 1 GET com **leitura cruzada de `Product`** (`/suggestions`).
- 14 endpoints que escrevem (`POST`, `PUT`, `DELETE`).
- **Zero gera PDF.**
- **Zero chama API externa.**
- **Zero envia mensagem/email/push.**

Diferente de Etiquetas, **nenhum GET aqui escreve** (em Etiquetas, `GET /templates` e `GET /batches/:id/pdf` escrevem). Smoke test de GETs read-only seria seguro — mas mantemos o padrão: **nenhum endpoint chamado durante validação técnica.**

---

## 5. Banco / Prisma

### Models relacionados (em `prisma/schema.prisma`)

| # | Model | Linha aproximada |
|---|---|---|
| 1 | `StoreCuration` | 992 |
| 2 | `StoreCurationZone` | 1016 |
| 3 | `StoreCurationItem` | 1032 |
| 4 | `StoreCurationChecklist` | 1055 |
| 5 | `StoreCurationPhoto` | 1072 |
| 6 | `StoreCurationResult` | 1087 |

FKs internas declaradas (verificadas em leitura prévia do schema):
- `StoreCurationItem.curationId → StoreCuration` (onDelete: Cascade)
- `StoreCurationItem.zoneId → StoreCurationZone` (onDelete: SetNull)
- `StoreCurationChecklist.curationId → StoreCuration` (Cascade)
- `StoreCurationPhoto.curationId → StoreCuration` (Cascade)
- `StoreCurationPhoto.zoneId → StoreCurationZone` (SetNull)
- `StoreCurationResult.curationId → StoreCuration` (1-1)

FK implícita (apenas String, sem relação Prisma declarada):
- `StoreCuration.storeId` e `StoreCurationZone.storeId` apontam para `Store.id`.

### Estado atual das 6 tabelas

`docs/MAPA_ATUAL.md` linha 129 declara explicitamente:
```
~60 tabelas vazias: [...] StoreCuration*, [...]
```

E a seção `### J. Curadoria de vitrine (StoreCuration)`:
```
- Tabelas: StoreCuration, StoreCurationZone, StoreCurationItem, StoreCurationChecklist, StoreCurationPhoto, StoreCurationResult (todas vazias)
```

**Hipótese aceita como verdadeira:** todas as 6 tabelas estão com `count(*) = 0`.

**Não confirmamos via query** (regra do baseline: sem escrever no banco; uma query `count` é leitura, mas ainda assim mantemos o princípio de não tocar o banco durante o baseline). Se for desejável verificar antes do Passo 0 da execução real, rodar manualmente em staging:

```sql
SELECT 'StoreCuration' as tbl, count(*) FROM "StoreCuration"
UNION ALL SELECT 'StoreCurationZone',     count(*) FROM "StoreCurationZone"
UNION ALL SELECT 'StoreCurationItem',     count(*) FROM "StoreCurationItem"
UNION ALL SELECT 'StoreCurationChecklist',count(*) FROM "StoreCurationChecklist"
UNION ALL SELECT 'StoreCurationPhoto',    count(*) FROM "StoreCurationPhoto"
UNION ALL SELECT 'StoreCurationResult',   count(*) FROM "StoreCurationResult";
```

(Comando informativo, **não autorizado** pelo baseline.)

---

## 6. Imports atuais de `src/routes/curation.js`

### Topo do arquivo (linhas 1-10)
```js
// =====================================================================
// Routes: /api/admin/curation — Curadoria Exposta por loja
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);
```

### Lista canônica de imports
- `express` (pacote npm, sem path relativo).
- `../middleware` → `src/middleware.js`, traz `{ authMiddleware, adminMiddleware, prisma }`.

### Confirmações
- ✅ `express` presente.
- ✅ `../middleware` presente.
- ✅ **Apenas 1 require relativo** (`../middleware`). Confirmado por `grep -nE "require\(['\"]\.\.?/"`.
- ✅ **Nenhum require de outro arquivo do projeto** (nenhum `../services/...`, nenhum `../routes/...`, nenhum `./...`).

Isso significa que ao mover `curation.js` para `src/modules/curadoria-vitrine/routes/`, **a única edição interna necessária** é trocar `../middleware` por `../../../middleware` (sobe 3 níveis).

---

## 7. Dependências externas

Verificadas via leitura do arquivo:

| Integração | Usada? |
|---|---|
| Anthropic (`@anthropic-ai/sdk`) | ❌ não |
| OpenAI | ❌ não |
| fal.ai | ❌ não |
| Meta (FB/IG/WhatsApp) | ❌ não |
| Nuvemshop | ❌ não |
| Resend | ❌ não |
| Web Push (VAPID) | ❌ não |
| Slack | ❌ não |
| SEFAZ (NFe) | ❌ não |
| Brave/Serper/Google Search | ❌ não |
| Qualquer API externa | ❌ não |

**Zero integração de rede.** Curadoria de Vitrine é puramente local — `express` + Prisma compartilhado via `middleware.js`. Sem dependências npm extras (sem `pdfkit`, sem `qrcode`, sem `multer` no route — upload físico de foto fica fora deste arquivo).

---

## 8. Importadores atuais (grep global)

Resultado de `grep -rnE "(require\(['\"][^'\"]*routes/curation\b|require\(['\"][^'\"]*routes/aiCuration\b|require\(['\"][^'\"]*services/curationAgent\b|curationRoutes\s*=\s*require|aiCurationRoutes\s*=\s*require)" src/ public/ scripts/`:

```
src/index.js:25:                const curationRoutes = require('./routes/curation');
src/index.js:40:                const aiCurationRoutes = require('./routes/aiCuration');
src/routes/aiCuration.js:11:    const { curateProduct } = require('../services/curationAgent');
scripts/run-curation-all.js:26: const { curateProduct } = require('../src/services/curationAgent');
```

### Classificação

| Linha | Classificação |
|---|---|
| `src/index.js:25` (curation) | ✅ **esperada** — único importador da Curadoria de Vitrine. Será ajustada no Passo 3. |
| `src/index.js:40` (aiCuration) | 🟡 **fora de escopo** — módulo irmão. **NÃO PODE SER TOCADA.** Permanece exatamente como está. |
| `src/routes/aiCuration.js:11` (curationAgent) | 🟡 **fora de escopo** — wiring interno do ecossistema Curadoria de Produto IA. NÃO TOCAR. |
| `scripts/run-curation-all.js:26` (curationAgent) | 🟡 **fora de escopo** — script de massa que processa o catálogo via aiCuration. NÃO TOCAR. |

**Riscos:** zero. Nenhuma ocorrência classificada como risco ou erro.

**Importadores da rota `curation` (vitrine):** **exatamente 1** (`src/index.js:25`). Caminho seguro para movimentação.

---

## 9. Diferença obrigatória entre módulos

### Curadoria de Vitrine — DENTRO do escopo (este plano)

| Item | Valor |
|---|---|
| Route | `src/routes/curation.js` (362 linhas) |
| Service auxiliar | **nenhum** |
| Modelos Prisma | `StoreCuration`, `StoreCurationZone`, `StoreCurationItem`, `StoreCurationChecklist`, `StoreCurationPhoto`, `StoreCurationResult` |
| Mount string | `/api/admin/curation` |
| Volume em produção | **0** (todas tabelas vazias) |
| Endpoints | 19 (4 GETs read-only, 14 writes, 1 GET com leitura cruzada de Product) |
| Risco operacional | 🟢 **BAIXÍSSIMO** — mexer não afeta nada em produção |
| Status | **EM ESCOPO** |

### Curadoria de Produto IA — FORA do escopo (não tocar)

| Item | Valor |
|---|---|
| Route | `src/routes/aiCuration.js` (250 linhas) |
| Service auxiliar | `src/services/curationAgent.js` (281 linhas) |
| Modelos afetados | `Product.aiContext`, `ProductCreative`, etc. |
| Mount string | `/api/admin/ai-curation` |
| Volume em produção | **6.170 produtos curados** (de 7.093 = ~87% do catálogo) |
| Outros consumidores | `scripts/run-curation-all.js` |
| Risco operacional | 🔥 **ALTO** — mexer pode reverter trabalho real |
| Status | **FORA DE ESCOPO ABSOLUTO** |

**Regra prática:** todo comando de movimentação ou edição deve passar por dupla checagem do path completo: `routes/curation.js` ≠ `routes/aiCuration.js` (difere pelo prefixo `ai`).

---

## 10. Checagens seguras permitidas

Todas read-only ou load-only. Nenhuma chama endpoint, nenhuma escreve no banco, nenhuma chama API externa.

```bash
# 1. Sintaxe do arquivo do escopo
node --check src/routes/curation.js

# 2. Carga estática da route (apenas resolve o módulo, não invoca handler)
node -e "const r = require('./src/routes/curation'); console.log('curation route loaded:', typeof r)"

# 3. Sintaxe + carga dos módulos irmãos (validar que não quebraram)
node --check src/routes/aiCuration.js
node --check src/services/curationAgent.js

# 4. Grep / busca de imports
grep -rnE "require.*routes/curation\b"        src/ public/ scripts/
grep -rnE "require.*routes/aiCuration\b"      src/ public/ scripts/
grep -rnE "require.*services/curationAgent\b" src/ public/ scripts/

# 5. Estado Git
git status --short -uall
git diff --name-status
git diff --stat
git show --name-only <commit>

# 6. Checagem de existência de arquivos
[ -e src/routes/curation.js ]
[ -e src/modules/curadoria-vitrine/routes/curation.js ]
[ -e src/routes/aiCuration.js ]
[ -e src/services/curationAgent.js ]
```

Resposta esperada após a extração:
- `node --check` → `OK` (sem saída de erro)
- `require('./src/modules/curadoria-vitrine/routes/curation')` → `function` (Express router)
- `require('./src/routes/aiCuration')` → `function` (módulo irmão inalterado)
- `require('./src/services/curationAgent')` → `object` (idem)

**Não usar endpoints nesta fase.** Mesmo que GETs read-only fossem seguros aqui (diferente de Etiquetas), o padrão dos módulos anteriores foi não chamar endpoint, e mantemos coerência.

---

## 11. Arquivos que provavelmente mudarão na execução real (com `git mv`)

### Movidos (1 arquivo)
| De | Para |
|---|---|
| `src/routes/curation.js` | `src/modules/curadoria-vitrine/routes/curation.js` |

### Editados (mínimo)
| Arquivo | Mudança |
|---|---|
| `src/index.js` (linha 25) | `require('./routes/curation')` → `require('./modules/curadoria-vitrine/routes/curation')` |
| `src/modules/curadoria-vitrine/routes/curation.js` (linha 6) | `require('../middleware')` → `require('../../../middleware')` |

### Criados (estrutura)
- Diretório `src/modules/curadoria-vitrine/`
- Diretório `src/modules/curadoria-vitrine/routes/`
- **NÃO** criar `src/modules/curadoria-vitrine/services/` — não há service auxiliar
- Arquivo `src/modules/curadoria-vitrine/README.md`

### Tocados em docs/
- `docs/MAPA_ATUAL.md` (marcar Curadoria de Vitrine como ✅ extraído)
- `docs/MODULOS_DESEJADOS.md` (marcar Curadoria de Vitrine como ✅ + Life vira próximo candidato natural)
- `docs/PLANO_EXTRACAO_CURADORIA_VITRINE.md` (status pós-execução + hashes dos commits)
- `docs/REGRESSION_CHECKLIST.md` (padrão de validação segura para mudanças futuras em Curadoria de Vitrine)

---

## 12. Arquivos proibidos (NÃO tocar)

### Específicos do "irmão" Curadoria de Produto IA
- `src/routes/aiCuration.js`
- `src/services/curationAgent.js`
- `scripts/run-curation-all.js` (consumidor de `curationAgent`)

### Infra compartilhada
- `prisma/schema.prisma`
- `src/middleware.js`
- `public/admin.html`
- `package.json`
- `.env`
- `.gitignore`
- `scripts/` (todo o diretório — não tocar)

### Extrações anteriores
- `src/modules/apex/` (toda a árvore)
- `src/modules/labels/` (toda a árvore)

### Módulos críticos por `REGRAS_CRITICAS.md`
- `src/routes/adminCatalog.js`
- `src/routes/products.js`
- `src/routes/inventory.js`
- `src/routes/stocktake.js`
- `src/routes/xmlImport.js`
- `src/routes/fiscal.js`

### Frontends e assets compartilhados
- `_product-card.js` (dentro de `admin.html` e outras telas)

---

## 13. Checklist de comparação antes/depois

Cada item deve responder **idêntico** no estado pré-extração (este baseline) e no estado pós-extração. Diferença em qualquer item = motivo para rollback.

### A. Mount points
- [ ] `grep -nE "app\.use\(['\"]\/api\/admin\/curation['\"]" src/index.js` retorna linha 124 com string **literalmente idêntica** ao baseline.
- [ ] `grep -nE "app\.use\(['\"]\/api\/admin\/ai-curation['\"]" src/index.js` retorna linha 137 com string **literalmente idêntica** ao baseline (módulo irmão).

### B. Estrutura de arquivos
- [ ] `src/routes/curation.js` existe antes; **não existe** depois.
- [ ] `src/modules/curadoria-vitrine/` não existe antes; existe depois (com `README.md` e `routes/curation.js`).
- [ ] `src/routes/aiCuration.js` **continua existindo** no path original (antes e depois).
- [ ] `src/services/curationAgent.js` **continua existindo** no path original (antes e depois).

### C. Carga de módulo (require sem chamar handler)
- [ ] `node --check` passa em `src/index.js`, antes e depois.
- [ ] `node --check` passa no path antigo da route antes; no path novo depois.
- [ ] `require(<route>)` retorna `function` antes (path antigo) e depois (path novo).
- [ ] `require('./src/routes/aiCuration')` retorna `function` antes e depois (não afetado).
- [ ] `require('./src/services/curationAgent')` retorna `object` antes e depois (não afetado).

### D. Nenhum endpoint chamado / nenhuma escrita
- [ ] Nenhum dos 19 endpoints `/api/admin/curation/...` foi exercitado antes ou depois durante a validação técnica.
- [ ] Nenhum endpoint `/api/admin/ai-curation/...` foi exercitado durante a validação.
- [ ] Nenhuma escrita em banco. Contagens das 6 tabelas `StoreCuration*` permanecem zero. `Product` permanece inalterado em count e `aiContext` (nenhuma operação de aiCuration realizada).

### E. Nenhum arquivo de Curadoria de Produto IA alterado
- [ ] `git show --name-only <commits_da_extracao>` **não** lista `src/routes/aiCuration.js`.
- [ ] `git show --name-only <commits_da_extracao>` **não** lista `src/services/curationAgent.js`.
- [ ] `git show --name-only <commits_da_extracao>` **não** lista `scripts/run-curation-all.js`.

### F. Nenhum schema alterado
- [ ] `git diff <hash_pre_extracao> -- prisma/schema.prisma` vazio.
- [ ] `prisma/migrations/` sem arquivo novo.

### G. Nenhum arquivo fora do escopo alterado
- [ ] `git show --name-only <commits_da_extracao>` lista **somente**:
  - `src/index.js`
  - `src/routes/curation.js → src/modules/curadoria-vitrine/routes/curation.js` (rename)
  - `src/modules/curadoria-vitrine/README.md`
- [ ] `git diff <hash_pre_extracao> --` em outros caminhos retorna vazio.

### H. Cross-references finais
- [ ] `grep -r "require.*routes/curation\b" src/` antes: retorna 1 linha (`src/index.js:25` → `./routes/curation`). Depois: retorna 1 linha (`src/index.js:25` → `./modules/curadoria-vitrine/routes/curation`).
- [ ] `grep -r "require.*routes/aiCuration\b" src/` antes e depois: retorna 1 linha idêntica (`src/index.js:40` → `./routes/aiCuration`).
- [ ] `grep -r "require.*services/curationAgent\b" src/ scripts/` antes e depois: retorna 2 linhas idênticas.

### I. Git
- [ ] Branch é `refactor/curadoria-vitrine-extracao-01` (ou descendente direta).
- [ ] HEAD antes do Passo 0 = `cdc531c` (registrado neste baseline).
- [ ] `git log` depois mostra 1 `chore(curadoria-vitrine):` + 1 `refactor(curadoria-vitrine):` + 1 `docs(curadoria-vitrine):` = **3 commits** atômicos.
- [ ] PR aberto, **não merged**.

---

## Observações finais

- Este baseline é **estático** — captura o estado em 26/05/2026 no commit `cdc531c`. Se a branch avançar antes da extração, gerar novo baseline com novo HEAD.
- Nenhum endpoint foi chamado neste turno. Nenhuma chamada externa. Nenhuma escrita em banco. Nenhum arquivo de código alterado.
- A extração de Curadoria de Vitrine **não está autorizada** por este documento — ele apenas captura o ponto de partida.
- Para autorizar execução, o dono precisa dizer "executar Passo 0 do plano de extração Curadoria de Vitrine" (ou equivalente explícito).
- **Maior atenção operacional:** dupla checagem em cada comando para não confundir `curation.js` (alvo) com `aiCuration.js` (fora de escopo). Erro de digitação de 2 letras pode acidentalmente tocar um módulo crítico em produção.

**Nenhum arquivo de código foi alterado. Nenhum diretório foi criado. Apenas leitura.**
