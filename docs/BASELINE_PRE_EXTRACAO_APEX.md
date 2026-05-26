# BASELINE PRÉ-EXTRAÇÃO — Módulo APEX

> Estado capturado **antes** de qualquer movimento de arquivo. Tudo aqui é leitura. Nenhum endpoint que escreve em banco foi chamado. Nenhum endpoint que custa $ (Anthropic / fal.ai) foi chamado.
>
> Este documento serve como **referência de comparação** depois da extração. Tudo que está aqui deve estar idêntico depois (exceto os 4 arquivos APEX que vão mudar de pasta, e as 2 linhas de `require` em `src/index.js`).

Data da captura: 2026-05-26

---

## 1. Branch atual

```
organizacao/refactor-2026-05-26
```

## 2. Commit atual (HEAD)

```
69bcfe95fd2c4a24f1ab2bf9980ac705aa605d79
```

Últimos 5 commits da branch:

```
69bcfe9 chore: ignora pasta backups/ (dump de banco local)
cdb59ed Revert "revert(bipe): DESLIGA fallback NFe que estava causando matches errados"
082281d revert(bipe): DESLIGA fallback NFe que estava causando matches errados
4443358 fix(bipar): fila de retry localStorage — bipes nao se perdem mais por rede
934b4d3 fix(bipar): defesas MUITO afrouxadas (LOJA03 leitor quebrado)
```

## 3. Estado do `git status` antes da extração

```
?? docs/MAPA_ATUAL.md
?? docs/MODULOS_DESEJADOS.md
?? docs/PLANO_EXTRACAO_APEX.md
?? docs/REGRAS_CRITICAS.md
?? docs/REGRESSION_CHECKLIST.md
?? docs/RELATORIO_DE_VALIDACAO_DOS_DOCS.md
```

Observação: os 6 arquivos `docs/*.md` ainda não foram commitados. A árvore de código (`src/`, `public/`, `prisma/`, `scripts/`, `package.json`) está **limpa em relação ao HEAD** — nenhum arquivo modificado, nenhum arquivo deletado, nenhum arquivo movido.

## 4. Scripts disponíveis no `package.json`

```json
"scripts": {
  "start":       "node src/index.js",
  "dev":         "node src/index.js",
  "db:push":     "npx prisma db push",
  "db:generate": "npx prisma generate",
  "db:seed":     "node src/seed.js"
}
```

Observações:
- `start` e `dev` rodam **o mesmo comando**. Não há nodemon/hot-reload.
- Não existe `test`. Validação é manual (smoke test).
- `db:push` é proibido em produção (regra do projeto). Não rodar no baseline.

## 5. Comando correto para subir o servidor local

```bash
cd /c/Users/sport/TenisCash
npm start
```

ou diretamente:

```bash
cd /c/Users/sport/TenisCash
node src/index.js
```

Pré-requisitos (assumidos, **não** validados aqui):
- `.env` com `DATABASE_URL` apontando para o banco local/staging (NÃO produção).
- `ANTHROPIC_API_KEY` configurada se for testar `/api/coach/briefing|post-workout|chat` (não vamos testar no baseline).
- Porta livre (definida em `.env`).

## 6. Rotas APEX atuais

### 6.1. `/api/activities` (mount em `src/index.js` linha 141)

| Método | Path | Auth | Escreve banco? | Custo externo |
|---|---|---|---|---|
| `POST` | `/api/activities` | `authMiddleware` | **SIM** — cria `Activity` | Não |
| `GET` | `/api/activities` | `authMiddleware` | Não | Não |
| `GET` | `/api/activities/:id` | `authMiddleware` | Não | Não |

### 6.2. `/api/coach` (mount em `src/index.js` linha 142)

`router.use(authMiddleware)` aplicado ao router inteiro — todos os endpoints exigem auth.

| Método | Path | Auth | Escreve banco? | Custo externo |
|---|---|---|---|---|
| `GET` | `/api/coach/status` | sim | Não | Não (só checa `ANTHROPIC_API_KEY`) |
| `POST` | `/api/coach/briefing` | sim | Não | **SIM** — chamada Anthropic |
| `POST` | `/api/coach/post-workout` | sim | Não | **SIM** — chamada Anthropic |
| `POST` | `/api/coach/chat` | sim | Não | **SIM** — chamada Anthropic |

## 7. Métodos HTTP existentes em `activities.js` e `coach.js`

### `src/routes/activities.js` (70 linhas)

```
POST   /        → ingest.ingestActivity(payload, streams) → prisma.activity.create
GET    /        → prisma.activity.findMany({ where: { userId } })
GET    /:id     → prisma.activity.findFirst({ where: { id, userId }, include: laps, photos })
```

### `src/routes/coach.js` (49 linhas)

```
GET    /status        → coach.isConfigured()
POST   /briefing      → coach.dailyBriefing(req.body)
POST   /post-workout  → coach.postWorkoutAnalysis(req.body)
POST   /chat          → coach.chat(req.body)
```

## 8. Endpoints **seguros** para smoke test (sem alteração de dados, sem $)

Estes podem ser chamados no baseline e re-chamados após a extração para comparar:

| Endpoint | Auth | Resposta esperada (sem token) | Resposta esperada (com token user comum) |
|---|---|---|---|
| `GET /api/activities` | sim | `401 não autenticado` | `200 { activities: [] }` (User sem atividades hoje — todas tabelas APEX vazias) |
| `GET /api/activities/:id` (id inexistente) | sim | `401 não autenticado` | `404 não encontrada` |
| `GET /api/coach/status` | sim | `401 não autenticado` | `200 { configured: true|false }` (depende de `ANTHROPIC_API_KEY` no env) |

Recomendação: usar **um token de user real** (não admin) que **não tenha atividades** — assim o smoke test não revela dados e não cria dados.

## 9. Endpoints que **NÃO devem** ser chamados (criam/alteram dados OU custam $)

| Endpoint | Por quê não chamar |
|---|---|
| `POST /api/activities` | Cria registro em `Activity` (e roda update para `processingState='done'`). |
| `POST /api/coach/briefing` | Faz chamada paga ao Anthropic. |
| `POST /api/coach/post-workout` | Faz chamada paga ao Anthropic. |
| `POST /api/coach/chat` | Faz chamada paga ao Anthropic. |

Nenhum desses 4 endpoints será chamado **nem no baseline, nem no smoke test pós-extração**. Como APEX tem todas as tabelas vazias hoje, não há "antes/depois" de dados — comparação é exclusivamente sobre **status HTTP** e **boot do servidor**.

## 10. Lista de imports atuais

### `src/routes/activities.js`
```js
const express = require('express');
const { authMiddleware } = require('../middleware');
const ingest = require('../services/activityIngest');
const { PrismaClient } = require('@prisma/client');
```

### `src/routes/coach.js`
```js
const express = require('express');
const { authMiddleware } = require('../middleware');
const coach = require('../services/aiCoach');
```

### `src/services/activityIngest.js`
```js
const { PrismaClient } = require('@prisma/client');
```

### `src/services/aiCoach.js`
```js
const Anthropic = require('@anthropic-ai/sdk');
```

Observações importantes para o plano de extração:
- `activities.js` linha 8 e `coach.js` linha 6 fazem `require('../middleware')`. Quando esses arquivos forem para `src/modules/apex/routes/`, o path relativo precisa virar `require('../../../middleware')` (sobe 3 níveis para `src/middleware.js`). Esta é a **única mudança real de import necessária** dentro dos arquivos movidos.
- `activities.js` linha 9 faz `require('../services/activityIngest')`. Após mover ambos, vira `require('../services/activityIngest')` apenas se a estrutura espelhar `modules/apex/routes` → `modules/apex/services`. Confirmar antes do passo 5 do plano.
- `coach.js` linha 7 faz `require('../services/aiCoach')`. Mesma observação.
- `activityIngest.js` e `aiCoach.js` só importam pacotes npm (`@prisma/client`, `@anthropic-ai/sdk`) — **zero requires relativos**, então não há nada a alterar dentro desses dois arquivos.

## 11. Confirmação dos mount points atuais em `src/index.js`

```
src/index.js:43:  const activitiesRoutes = require('./routes/activities');
src/index.js:44:  const coachRoutes      = require('./routes/coach');
src/index.js:141: app.use('/api/activities', activitiesRoutes);
src/index.js:142: app.use('/api/coach',      coachRoutes);
```

Linhas 141 e 142 (`app.use(...)`) **NÃO podem mudar** — o path do mount continua exatamente `/api/activities` e `/api/coach`. Apenas as linhas 43 e 44 (`require(...)`) podem ser ajustadas para apontar para o novo path interno.

## 12. Arquivos que precisarão mudar na primeira execução real (com `git mv`)

### Movidos (4 arquivos)
| De | Para |
|---|---|
| `src/routes/activities.js` | `src/modules/apex/routes/activities.js` |
| `src/routes/coach.js` | `src/modules/apex/routes/coach.js` |
| `src/services/activityIngest.js` | `src/modules/apex/services/activityIngest.js` |
| `src/services/aiCoach.js` | `src/modules/apex/services/aiCoach.js` |

### Editados (mínimo)
| Arquivo | Mudança |
|---|---|
| `src/index.js` (linha 43) | `require('./routes/activities')` → `require('./modules/apex/routes/activities')` (ou `./modules/apex` se Passo 7 do plano for feito) |
| `src/index.js` (linha 44) | `require('./routes/coach')` → `require('./modules/apex/routes/coach')` |
| `src/modules/apex/routes/activities.js` (linha 8) | `require('../middleware')` → `require('../../../middleware')` |
| `src/modules/apex/routes/activities.js` (linha 9) | `require('../services/activityIngest')` → caminho relativo novo (confirmar) |
| `src/modules/apex/routes/coach.js` (linha 6) | `require('../middleware')` → `require('../../../middleware')` |
| `src/modules/apex/routes/coach.js` (linha 7) | `require('../services/aiCoach')` → caminho relativo novo (confirmar) |

### Criados (estrutura)
- Diretório `src/modules/apex/`
- Diretório `src/modules/apex/routes/`
- Diretório `src/modules/apex/services/`
- Opcional: `src/modules/apex/index.js` (re-export)
- Opcional: `src/modules/apex/README.md`

### Tocados em comum (`docs/`)
- `docs/MAPA_ATUAL.md` (marcar APEX como extraído)
- `docs/MODULOS_DESEJADOS.md` (marcar APEX como extraído)

### Inalterado (proibido tocar)
- `prisma/schema.prisma`
- `src/middleware.js`
- `src/services/systemMessenger.js`
- `src/routes/stocktake.js`, `xmlImport.js`, `fiscal.js`, `adminCatalog.js`, `products.js`, `inventory.js`, `aiCuration.js`
- `public/admin.html` e demais HTMLs
- `package.json`
- `.env`, `.gitignore`

## 13. Endpoints canários NÃO-APEX para testar antes e depois (sem escrita em banco)

Lista de GETs que devem responder **idêntico** antes e depois da extração. Selecionados para serem read-only e cobrir os módulos críticos:

| Endpoint | Função do canário |
|---|---|
| `GET /api/auth/me` (ou equivalente que retorne o user logado) | Valida auth middleware compartilhado. |
| `GET /api/wallet` | Valida carteira (módulo carteira). |
| `GET /api/catalog` (público) | Valida catálogo público. |
| `GET /api/admin/inventory/products?limit=5` | Valida cérebro do catálogo (usuário admin). |
| `GET /api/admin/xml/nfes?docType=entrada&limit=5` | Valida importação NFe (read-only). |
| `GET /api/admin/xml/nfes?docType=transferencia&limit=5` | Valida segregação entrada vs transferência. |
| `GET /api/admin/xml/nfes/stats` | Valida endpoint usado pela tab NFE Geral. |
| `GET /api/stores` | Valida listagem de lojas (LOJA01–LOJA06). |
| `GET /api/admin/categories` | Valida CategoryNode. |
| `GET /api/admin/suppliers` | Valida Supplier. |

⚠️ Endpoints que **NÃO** devem ser usados como canário (escrevem):
- `POST /api/stocktake/bipe` — escreve `StocktakeBipe` + upsert `StoreStock`.
- `POST /api/admin/xml/import` — escreve `XmlFiscalDocument/Item`.
- `POST /api/admin/inventory/adjust` — escreve `StoreStock`.
- Qualquer endpoint de `/api/wallet/transfer`, `/api/promos/redeem`, etc.

## 14. Checklist de comparação antes/depois

Cada item deve responder **idêntico** no estado pré-extração (este baseline) e no estado pós-extração. Diferença em qualquer item = motivo para rollback.

### A. Estrutura física
- [ ] `src/routes/activities.js` **existe** antes; **não existe** depois.
- [ ] `src/routes/coach.js` **existe** antes; **não existe** depois.
- [ ] `src/services/activityIngest.js` **existe** antes; **não existe** depois.
- [ ] `src/services/aiCoach.js` **existe** antes; **não existe** depois.
- [ ] `src/modules/apex/...` **não existe** antes; **existe** depois.
- [ ] `prisma/schema.prisma` **idêntico** (diff vazio).
- [ ] `src/middleware.js` **idêntico**.
- [ ] `src/services/systemMessenger.js` **idêntico**.
- [ ] `src/index.js` **só** com linhas 43 e 44 alteradas (paths de require). Resto idêntico.
- [ ] `package.json` **idêntico**.

### B. Boot do servidor
- [ ] `npm start` sobe sem erro, antes e depois.
- [ ] Log de startup mostra "listening on PORT" antes e depois.
- [ ] Sem warnings de "Cannot find module" depois.

### C. Status HTTP dos endpoints APEX (com mesmo token)
- [ ] `GET /api/activities` retorna o mesmo status antes e depois.
- [ ] `GET /api/coach/status` retorna o mesmo status e o mesmo `configured: true|false`.
- [ ] (Não chamar POSTs.)

### D. Status HTTP dos canários não-APEX (com mesmo token)
- [ ] `GET /api/auth/me` — mesmo status, mesmo payload de id.
- [ ] `GET /api/wallet` — mesmo status, mesmo saldo.
- [ ] `GET /api/catalog` — mesmo status, mesma contagem aproximada.
- [ ] `GET /api/admin/inventory/products?limit=5` — mesmo status, mesma lista de 5 ids.
- [ ] `GET /api/admin/xml/nfes?docType=entrada&limit=5` — mesmo status, mesmas 5 NFes.
- [ ] `GET /api/admin/xml/nfes?docType=transferencia&limit=5` — mesmo status, mesmas 5 NFes.
- [ ] `GET /api/admin/xml/nfes/stats` — mesmos números (entrada vs transferencia).
- [ ] `GET /api/stores` — 6 lojas, mesmos ids.
- [ ] `GET /api/admin/categories` — mesma contagem.
- [ ] `GET /api/admin/suppliers` — mesma contagem.

### E. Contagens de banco (read-only, com `prisma.X.count()` ou query manual)
- [ ] `Product.count()` igual.
- [ ] `ProductSize.count()` igual.
- [ ] `StoreStock.count()` igual.
- [ ] `StocktakeBipe.count()` igual.
- [ ] `XmlFiscalDocument.count()` igual.
- [ ] `XmlFiscalItem.count()` igual.
- [ ] `User.count()` igual.
- [ ] `Activity.count()` igual (esperado 0 nos dois lados).
- [ ] `AthleteProfile.count()` igual (esperado 0).
- [ ] `BadgeEarned.count()` igual (esperado 0).

### F. Cross-references preservadas
- [ ] `grep -r "require.*routes/activities\b" src/` retorna **apenas** a linha 43 de `src/index.js` no estado *depois* (apontando pro novo path).
- [ ] `grep -r "require.*routes/coach\b" src/` retorna **apenas** a linha 44 de `src/index.js` no estado *depois*.
- [ ] `grep -r "require.*services/activityIngest\b" src/` retorna **apenas** a linha 9 de `src/modules/apex/routes/activities.js`.
- [ ] `grep -r "require.*services/aiCoach\b" src/` retorna **apenas** a linha 7 de `src/modules/apex/routes/coach.js`.
- [ ] `systemMessenger.notifyBadgeEarned` continua exportada e importável.

### G. Git
- [ ] Branch atual continua sendo `organizacao/refactor-2026-05-26` (ou uma branch filha dela).
- [ ] HEAD anterior ao Passo 0 = `69bcfe95fd2c4a24f1ab2bf9980ac705aa605d79` (registrado neste baseline).
- [ ] `git log` mostra 1 commit por arquivo movido (commits pequenos, conforme plano).
- [ ] PR aberto, **não merged**.

---

## Observações finais

- Este baseline é **estático** — captura o estado em 26/05/2026. Se a branch avançar antes da extração, gerar novo baseline com novo HEAD.
- Nenhum endpoint POST foi chamado. Nenhuma chamada Anthropic foi feita. Nenhuma escrita em banco.
- A extração do APEX **não está autorizada** por este documento — ele apenas captura o ponto de partida.
- Para autorizar execução, o dono precisa dizer "executar Passo 0 do plano de extração APEX" (ou equivalente explícito).

**Nenhum arquivo de código foi alterado. Nenhum diretório foi criado. Apenas leitura.**
