# BASELINE PRÉ-EXTRAÇÃO — Módulo Etiquetas

> Estado capturado **antes** de qualquer movimento de arquivo. Tudo aqui é leitura. Nenhum endpoint foi chamado. Nenhuma escrita em banco. Nenhuma chamada externa.
>
> Este documento serve como **referência de comparação** depois da extração. Tudo que está aqui deve estar idêntico depois (exceto os 2 arquivos Etiquetas que vão mudar de pasta, e a linha 23 de `src/index.js`).

Data da captura: 2026-05-26

---

## 1. Branch atual

```
refactor/apex-extracao-01
```

## 2. Commit atual (HEAD)

```
46d5296bd3f55092f58fe477507e26d380b4523a
```

Últimos 5 commits desta branch:

```
46d5296 (HEAD -> refactor/apex-extracao-01)  docs(labels): criar plano de extracao do modulo etiquetas
c0aaa03                                       docs(apex): marcar extracao do modulo APEX como concluida
903f2e2                                       refactor(apex): mover service aiCoach para modulo APEX
29ff92b                                       refactor(apex): mover service activityIngest para modulo APEX
0af78f7                                       refactor(apex): mover rota coach para modulo APEX
```

## 3. Estado do `git status` antes da extração

```
(vazio)
```

Working tree **limpa**: zero arquivos modificados, staged ou untracked.
Ponto de partida ideal para iniciar a próxima extração modular.

## 4. Confirmação do plano existente

`docs/PLANO_EXTRACAO_ETIQUETAS.md` está commitado em `46d5296` (HEAD).

Tamanho: **436 linhas**.

Cobre objetivo, dependências, riscos, plano em 7 passos atômicos, critérios de aceite e checklist de validação. Este baseline é o complemento factual do plano — capturando hashes, contagens e contratos atuais.

## 5. Arquivos atuais relacionados

| Arquivo | Linhas | Última modificação relevante |
|---|---|---|
| `src/routes/labels.js` | **301** | (último commit pré-APEX que tocou) |
| `src/services/labelGenerator.js` | **433** | (último commit pré-APEX que tocou) |

Total: **734 linhas** a serem reposicionadas em 2 commits atômicos (Passos 3 e 4 do plano).

## 6. Mount point atual em `src/index.js`

```
src/index.js:122:  app.use('/api/admin/labels', labelsRoutes);
```

**Mount string público:** `/api/admin/labels`.

Este string **NÃO pode mudar** durante a extração. Todo o `admin.html` (aba Etiquetas) consome a API pelo caminho exato `/api/admin/labels/...` via `fetch()`. Mudar quebra a UI silenciosamente.

## 7. Linha atual do require em `src/index.js` que importa `labels.js`

```
src/index.js:23:  const labelsRoutes = require('./routes/labels');
```

Esta é a **única** linha que será alterada em `src/index.js` durante o Passo 3. O destino esperado: `require('./modules/labels/routes/labels')`.

A linha 122 (mount point) permanece literal.

## 8. Métodos e endpoints existentes em `src/routes/labels.js`

8 endpoints, todos atrás de `authMiddleware` + `adminMiddleware` aplicados via `router.use(...)` no topo do arquivo (linhas 10-11):

| # | Linha | Método | Path completo | Função |
|---|---|---|---|---|
| 1 | 55 | `GET` | `/api/admin/labels/templates` | Lista LabelTemplates; chama `ensureDefaultTemplates()` que **cria/atualiza** templates default |
| 2 | 66 | `POST` | `/api/admin/labels/batches` | Cria LabelBatch + LabelItems nested |
| 3 | 102 | `GET` | `/api/admin/labels/batches` | Lista lotes recentes (read-only puro) |
| 4 | 117 | `GET` | `/api/admin/labels/batches/:id` | Detalhe de lote (read-only puro) |
| 5 | 132 | `GET` | `/api/admin/labels/batches/:id/pdf` | Gera PDF + **atualiza** `status = 'GENERATED'` |
| 6 | 209 | `POST` | `/api/admin/labels/batches/:id/print` | Cria LabelPrintLog + atualiza `status = 'PRINTED'` |
| 7 | 232 | `DELETE` | `/api/admin/labels/batches/:id` | Hard delete de LabelBatch (cascateia em LabelItem + LabelPrintLog) |
| 8 | 246 | `POST` | `/api/admin/labels/batches/quick` | Cria LabelBatch + LabelItems a partir de productIds/selections |

## 9. Classificação dos endpoints

| # | Endpoint | Read-only real? | Escreve no banco? | Gera PDF? | Altera status? | Perigoso para smoke test? |
|---|---|:---:|:---:|:---:|:---:|:---:|
| 1 | `GET /templates` | ❌ | ✅ (cria/atualiza LabelTemplate na 1ª chamada ou se layout S&T não bate) | ❌ | ❌ | ⚠️ **SIM** |
| 2 | `POST /batches` | ❌ | ✅ (cria LabelBatch + N LabelItems) | ❌ | ❌ | ⚠️ **SIM** |
| 3 | `GET /batches` | ✅ | ❌ | ❌ | ❌ | 🟢 baixo |
| 4 | `GET /batches/:id` | ✅ | ❌ | ❌ | ❌ | 🟢 baixo |
| 5 | `GET /batches/:id/pdf` | ❌ | ✅ (`status='GENERATED'` + leitura de Product) | ✅ | ✅ | ⚠️ **SIM** |
| 6 | `POST /batches/:id/print` | ❌ | ✅ (cria LabelPrintLog + `status='PRINTED'`) | ❌ | ✅ | ⚠️ **SIM** |
| 7 | `DELETE /batches/:id` | ❌ | ✅ (hard delete cascateado) | ❌ | — | ⚠️ **SIM (destrutivo)** |
| 8 | `POST /batches/quick` | ❌ | ✅ (cria LabelBatch + LabelItems) | ❌ | ❌ | ⚠️ **SIM** |

Resultado: **6 dos 8 endpoints escrevem no banco**. Apenas 2 GETs (`/batches` e `/batches/:id`) são read-only puros. Os outros 6 são write-side ou têm efeito colateral.

## 10. Confirmação explícita das anomalias

- ✅ **`GET /templates` ESCREVE no banco** via `ensureDefaultTemplates()` (linhas 14-53 de `labels.js`). Cria registros em `LabelTemplate` na primeira chamada. Mesmo em chamadas subsequentes, se um template S&T (130mm) está com `showQRCode=false`, o handler corrige para `showQRCode=true` + `showBarcode=false` (`prisma.labelTemplate.update`).

- ✅ **`GET /batches/:id/pdf` ATUALIZA status para `'GENERATED'`** em `prisma.labelBatch.update({ where: { id: batch.id }, data: { status: 'GENERATED' } })` (linhas 192-195 de `labels.js`). Cada chamada de PDF muda o estado do lote.

- ✅ **Portanto, NENHUM endpoint será usado como smoke test técnico nesta fase.** A validação técnica da extração se restringe a:
  - `node --check`
  - `node -e "require(...)"` (carga estática de módulo)
  - boot do servidor com `npm start` apenas para confirmar startup, sem bater em endpoint nenhum.

Smoke test funcional via HTTP só será executado **depois** de autorização explícita do dono, em ambiente de staging, e seguindo o roteiro da seção 13.b do plano.

## 11. Imports atuais

### `src/routes/labels.js` (linhas 5-7)
```js
const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const { generateLabelsPDF, defaultTemplates } = require('../services/labelGenerator');
```

### `src/services/labelGenerator.js` (linhas 11-13)
```js
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { Buffer } = require('buffer');
```

Observações para o plano de extração:
- `labels.js` linha 6 importa `authMiddleware`, `adminMiddleware` E **`prisma` instance** de `../middleware`. Após o Passo 3, o relativo precisa virar `require('../../../middleware')` (sobe 3 níveis a partir de `src/modules/labels/routes/`).
- `labels.js` linha 7 importa o service. No Passo 3, o relativo será temporariamente `require('../../../services/labelGenerator')`; no Passo 4 será simplificado para `require('../services/labelGenerator')` (interno ao módulo).
- `labelGenerator.js` só importa pacotes npm — **zero requires relativos**, então o rename do Passo 4 sai como `R100` (sem edit interno).
- Acesso ao Prisma em `labels.js` é via **instância compartilhada** exportada de `middleware.js`, **não** `new PrismaClient()` local. (Diferente do APEX `activities.js` que instanciava localmente.)

## 12. Dependências npm usadas

Dependências externas referenciadas direta ou indiretamente pelos arquivos do escopo:

| Pacote | Onde | Tipo |
|---|---|---|
| `express` | `labels.js` (router) | Web framework |
| `pdfkit` | `labelGenerator.js` (linha 11) | Geração de PDF |
| `qrcode` | `labelGenerator.js` (linha 12) | Geração de QR codes |
| `buffer` | `labelGenerator.js` (linha 13) | Node built-in |
| `@prisma/client` | indireto via `middleware.js` | ORM (instância compartilhada) |

**Zero integração de rede externa.** Sem Anthropic, fal.ai, OpenAI, Meta, Nuvemshop, Resend, Web Push, Slack, SEFAZ. Etiquetas é completamente offline-friendly do ponto de vista do servidor.

Versões fixadas em `package.json`:
- `pdfkit: ^0.15.2`
- `qrcode: ^1.5.4`
- `@prisma/client: ^5.20.0`
- `express: ^4.21.0`

## 13. Checagens seguras permitidas

Todas read-only ou load-only. Nenhuma chama endpoint, nenhuma escreve no banco, nenhuma chama API externa.

```bash
node --check src/routes/labels.js
node --check src/services/labelGenerator.js
node -e "require('pdfkit'); require('qrcode'); console.log('deps ok')"
node -e "const r = require('./src/routes/labels'); console.log('labels route loaded:', typeof r)"
node -e "const s = require('./src/services/labelGenerator'); console.log('labelGenerator loaded:', typeof s)"
```

Resposta esperada após a extração:
- `node --check` → `OK` (sem saída de erro)
- `require('./src/modules/labels/routes/labels')` → `function` (Express router)
- `require('./src/modules/labels/services/labelGenerator')` → `object` com chaves `generateLabelsPDF,defaultTemplates`
- `require('pdfkit'); require('qrcode')` → carrega sem erro, imprime `deps ok`

Esses comandos são os únicos autorizados na **validação técnica** da extração. Smoke funcional de HTTP fica para o momento autorizado.

## 14. Confirmação de que esses requires não chamam endpoint e não geram PDF automaticamente

Análise do top-level dos 2 arquivos:

### `src/routes/labels.js` (top-level)
- Define função `ensureDefaultTemplates()` mas **não a chama** no top-level. Ela só roda quando o handler `GET /templates` é invocado.
- Define `router.get(...)`, `router.post(...)` etc., mas **não dispara nenhum handler** — apenas registra as rotas no `express.Router()`.
- Exporta `module.exports = router`.

**Conclusão:** carregar via `require('./src/routes/labels')` cria um `Router` Express vazio, **não roda nenhum handler, não chama Prisma, não cria nada no banco**.

### `src/services/labelGenerator.js` (top-level)
- Define funções `defaultTemplates`, `fmtBRL`, `mm`, `drawFakeBarcode`, `drawQR`, `drawLabelHorizontal`, `drawLabelContent`, `generateLabelsPDF`. **Nenhuma é chamada no top-level.**
- Constantes `MM_TO_PT` definidas.
- Exporta `module.exports = { generateLabelsPDF, defaultTemplates }`.

**Conclusão:** carregar via `require('./src/services/labelGenerator')` instancia o módulo, **não gera PDF, não cria QR code, não toca em arquivo nenhum**.

Para gerar um PDF de fato seria necessário chamar explicitamente `generateLabelsPDF({...})` com objeto template + items — o que **não está autorizado** nesta fase.

## 15. Quem importa `labels.js` e `labelGenerator.js`

Resultado de `grep -rnE "(require\(['\"][^'\"]*labels\b|require\(['\"][^'\"]*labelGenerator\b)" src/ public/ scripts/`:

```
src/index.js:23                   const labelsRoutes = require('./routes/labels');
src/routes/labels.js:7            const { generateLabelsPDF, defaultTemplates } = require('../services/labelGenerator');
```

**Exatamente 2 importadores:**
- `src/index.js:23` — único consumidor da route. Linha que será ajustada no Passo 3.
- `src/routes/labels.js:7` — único consumidor do service. Linha que será ajustada nos Passos 3 (caminho intermediário longo) e 4 (caminho interno final).

**Nenhum outro arquivo em `src/`, `public/` ou `scripts/`** faz `require` ou `import` de `labels` ou `labelGenerator`.

Frontend (`public/admin.html`, aba Etiquetas) consome o módulo **apenas via HTTP fetch** em `/api/admin/labels/...` — sem dependência direta de código JS do servidor. Logo, `admin.html` não precisa ser tocado pela extração; basta o mount string público permanecer literal.

## 16. Arquivos que provavelmente mudarão na execução real (com `git mv`)

### Movidos (2 arquivos)
| De | Para |
|---|---|
| `src/routes/labels.js` | `src/modules/labels/routes/labels.js` |
| `src/services/labelGenerator.js` | `src/modules/labels/services/labelGenerator.js` |

### Editados (mínimo)
| Arquivo | Mudança |
|---|---|
| `src/index.js` (linha 23) | `require('./routes/labels')` → `require('./modules/labels/routes/labels')` |
| `src/modules/labels/routes/labels.js` (linha 6) | `require('../middleware')` → `require('../../../middleware')` |
| `src/modules/labels/routes/labels.js` (linha 7) | Passo 3 intermediário: `require('../../../services/labelGenerator')`. Passo 4 final: `require('../services/labelGenerator')` |

### Criados (estrutura)
- Diretório `src/modules/labels/`
- Diretório `src/modules/labels/routes/`
- Diretório `src/modules/labels/services/`
- Arquivo `src/modules/labels/README.md`

### Tocados em docs/
- `docs/MAPA_ATUAL.md` (marcar Etiquetas como extraído)
- `docs/MODULOS_DESEJADOS.md` (marcar Etiquetas como ✅ + atualizar Fase 1)
- `docs/PLANO_EXTRACAO_ETIQUETAS.md` (Passo 6 — adicionar hashes dos commits + status final)
- `docs/REGRESSION_CHECKLIST.md` se houver menção a paths antigos de Etiquetas (a verificar)

## 17. Arquivos que NÃO podem ser tocados (proibido)

- `prisma/schema.prisma` — não mover models, não renomear, não dropar nada. Os 4 modelos `Label*` continuam onde estão.
- `src/middleware.js` — permanece com seus exports atuais (`authMiddleware`, `adminMiddleware`, `prisma`).
- `public/admin.html` — aba Etiquetas não é tocada. Contrato HTTP preservado.
- `package.json` — sem mudança de dep.
- `.env`, `.gitignore` — intocados.
- `scripts/` — sem mudança.
- `src/routes/stocktake.js`, `xmlImport.js`, `fiscal.js`, `adminCatalog.js`, `products.js`, `inventory.js`, `aiCuration.js` — proibidos por `REGRAS_CRITICAS.md`.
- `src/modules/apex/...` — extração anterior, intocada.
- Demais routes e services em `src/`.

## 18. Checklist de comparação antes/depois

Cada item deve responder **idêntico** no estado pré-extração (este baseline) e no estado pós-extração. Diferença em qualquer item = motivo para rollback.

### A. Estrutura física
- [ ] `src/routes/labels.js` **existe** antes; **não existe** depois.
- [ ] `src/services/labelGenerator.js` **existe** antes; **não existe** depois.
- [ ] `src/modules/labels/` **não existe** antes; **existe** depois (com `README.md`, `routes/labels.js`, `services/labelGenerator.js`).
- [ ] `prisma/schema.prisma` **idêntico** (diff vazio).
- [ ] `src/middleware.js` **idêntico**.
- [ ] `public/admin.html` **idêntico**.
- [ ] `package.json` **idêntico**.
- [ ] `src/index.js` **apenas a linha 23 alterada**; linha 122 (mount) e demais linhas idênticas.

### B. Mount string
- [ ] `grep -nE "app\.use\(['\"]\/api\/admin\/labels['\"]" src/index.js` retorna a linha 122 com **string literal idêntica** ao baseline.

### C. Boot do servidor
- [ ] `npm start` sobe sem erro, antes e depois.
- [ ] Log de startup mostra "listening on PORT" antes e depois.
- [ ] Sem warnings de "Cannot find module" depois.

### D. Carga de módulo
- [ ] `node --check src/index.js` → OK antes e depois.
- [ ] `node --check <path da route>` → OK (path antigo no baseline, path novo depois).
- [ ] `node --check <path do service>` → OK (path antigo no baseline, path novo depois).
- [ ] `require(<route>)` retorna `function` antes e depois.
- [ ] `require(<service>)` retorna `object` com chaves `generateLabelsPDF,defaultTemplates` antes e depois.
- [ ] `require('pdfkit')` e `require('qrcode')` carregam sem erro antes e depois.

### E. Banco (read-only)
- [ ] Snapshot antes: `count(LabelTemplate)`, `count(LabelBatch)`, `count(LabelItem)`, `count(LabelPrintLog)`.
- [ ] Snapshot depois: **igual** ao snapshot antes (a extração não pode mexer em dados).
- [ ] Snapshot antes/depois: `Product.count()` igual.

### F. Endpoints **não chamados** (atestado lógico)
- [ ] Nenhum dos 8 endpoints `/api/admin/labels/...` foi chamado antes nem depois durante a validação técnica.
- [ ] Nenhum PDF foi gerado durante a validação.
- [ ] Nenhuma escrita em banco foi feita durante a validação.

### G. Cross-references preservadas
- [ ] `grep -r "require.*routes/labels\b" src/` antes: retorna 1 linha (`src/index.js:23`). Depois: retorna 1 linha apontando para `./modules/labels/routes/labels`.
- [ ] `grep -r "require.*services/labelGenerator\b" src/` antes: retorna 1 linha (`src/routes/labels.js:7`). Depois: retorna 1 linha dentro de `src/modules/labels/routes/labels.js` com path interno simplificado.
- [ ] Nenhum outro arquivo passa a importar labels ou labelGenerator durante a extração.

### H. Canários não-Etiquetas (depois da extração, opcional)
- [ ] Rotas APEX (`/api/activities`, `/api/coach`) continuam respondendo igual.
- [ ] `GET /api/auth/me` continua funcionando.
- [ ] `GET /api/admin/inventory/products?limit=5` continua funcionando.

### I. Git
- [ ] Branch é a de trabalho (não main).
- [ ] HEAD antes do Passo 0 = `46d5296` (registrado neste baseline).
- [ ] `git log` depois mostra 1 commit `chore(labels):` + 2 commits `refactor(labels):` + 1 commit `docs(labels):` = **4 commits** atômicos.
- [ ] PR aberto, **não merged**.

---

## Observações finais

- Este baseline é **estático** — captura o estado em 26/05/2026 no commit `46d5296`. Se a branch avançar antes da extração, gerar novo baseline com novo HEAD.
- Nenhum endpoint foi chamado neste turno. Nenhuma chamada Anthropic ou outra API externa. Nenhuma escrita em banco. Nenhum PDF gerado.
- A extração das Etiquetas **não está autorizada** por este documento — ele apenas captura o ponto de partida.
- Para autorizar execução, o dono precisa dizer "executar Passo 0 do plano de extração Etiquetas" (ou equivalente explícito).

**Nenhum arquivo de código foi alterado. Nenhum diretório foi criado. Apenas leitura.**
