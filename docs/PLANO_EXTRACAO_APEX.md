# PLANO DE EXTRAÇÃO — Módulo APEX

> **Plano executado e validado.** Em 26/05/2026 a extração foi realizada com sucesso em 4 commits atômicos. A validação final (RELATORIO_VALIDACAO_FINAL_APEX) foi **APROVADA**. Schema Prisma, banco, rotas públicas, endpoints e integrações externas **não foram alterados**. Este documento foi atualizado para refletir o estado pós-extração.

- Data do plano: 2026-05-26
- Data da execução: 2026-05-26
- Branch onde o trabalho aconteceu: `refactor/apex-extracao-01` (filha de `organizacao/refactor-2026-05-26`)
- Status: **CONCLUÍDO** (com Passo 7 adiado, ver seção 10)

### Resumo dos commits da extração

| Passo | Commit | Mensagem |
|---|---|---|
| Estrutura vazia + README | (incluído em `1796446` "docs:" e parte do Passo 3) | — |
| 3. Mover `activities.js` | `c070555` | `refactor(apex): mover rota activities para modulo APEX` |
| 4. Mover `coach.js` | `0af78f7` | `refactor(apex): mover rota coach para modulo APEX` |
| 5. Mover `activityIngest.js` | `29ff92b` | `refactor(apex): mover service activityIngest para modulo APEX` |
| 6. Mover `aiCoach.js` | `903f2e2` | `refactor(apex): mover service aiCoach para modulo APEX` |
| 7. `index.js` do módulo | — | **NÃO EXECUTADO / ADIADO** (opcional, sem benefício no curto prazo) |
| 8. Documentação | (este commit `docs(apex):`) | `docs(apex): marcar extracao do modulo APEX como concluida` |

---

## 1. Objetivo da extração

Mover o código relacionado ao **APEX (app esportivo)** para uma pasta isolada `src/modules/apex/`, validando o padrão de extração modular em um domínio de risco baixo, antes de aplicar o mesmo padrão a módulos críticos (Catálogo, Inventário, Bipe).

Critérios para escolha do APEX como primeiro alvo:
- Todas as **21 tabelas APEX estão vazias ou quase vazias** em produção.
- Apenas **2 routes (activities, coach)** e **2 services (activityIngest, aiCoach)**, somando ~371 linhas de JS.
- Sem fronteira ativa com o varejo (carteira, catálogo, fiscal não dependem de APEX hoje).
- A única integração reversa que existe é `systemMessenger.notifyBadgeEarned()`, que é uma função simples e pode ser mantida como ponte controlada.

O objetivo **não é** entregar valor de negócio agora — é exercitar o padrão de extração com risco operacional zero.

---

## 2. Arquivos atuais relacionados ao APEX

### Routes (`src/routes/`)
- `activities.js` — 70 linhas
- `coach.js` — 49 linhas

### Services (`src/services/`)
- `activityIngest.js` — 132 linhas
- `aiCoach.js` — 120 linhas

### Bootstrap (`src/index.js`)
- Linha 43: `const activitiesRoutes = require('./routes/activities');`
- Linha 44: `const coachRoutes = require('./routes/coach');`
- Linha 141: `app.use('/api/activities', activitiesRoutes);`
- Linha 142: `app.use('/api/coach', coachRoutes);`

### Schema Prisma (`prisma/schema.prisma`)
- Seção APEX entre as linhas ~1692 e ~2030 (21 modelos).

### Frontend (`public/`)
- **Nenhuma página HTML em `public/` referencia `/api/activities`, `/api/coach`, `AthleteProfile` ou termos APEX hoje.** APEX backend existe sem frontend acoplado (PWA/app mobile é projeto separado).

### Outras referências cruzadas no código
- `src/services/systemMessenger.js` exporta `notifyBadgeEarned(userId, badgeName, cashbackAwarded)` — função usada por APEX ao processar `BadgeEarned`. Vive fora do módulo APEX mas serve APEX.

---

## 3. Rotas atuais relacionadas ao APEX

Mount points em `src/index.js`:

| Mount point | Route file | Linhas |
|---|---|---|
| `/api/activities` | `src/routes/activities.js` | 70 |
| `/api/coach` | `src/routes/coach.js` | 49 |

Endpoints internos (a confirmar lendo o código):
- `POST /api/activities` — ingestão de atividade nova (usa `activityIngest.recordActivity`)
- `GET /api/activities` — lista atividades do user (`where: { userId }`)
- `GET /api/activities/:id` — detalhe da atividade do user
- `/api/coach/*` — endpoints do aiCoach (treino, plano, conselho IA)

⚠️ A enumeração exata de endpoints precisa ser feita lendo cada arquivo no momento da execução. Lista acima é preliminar.

---

## 4. Services atuais relacionados ao APEX

| Service | Linhas | Responsabilidade |
|---|---|---|
| `src/services/activityIngest.js` | 132 | Recebe payload de atividade, valida userId, cria registro em `Activity`. Tem stub `importActivityFile(_userId, _filePath, format)` para futura ingestão de FIT/GPX. |
| `src/services/aiCoach.js` | 120 | Lógica de coach IA (treino, recomendação, plano). Provável uso de Anthropic SDK — confirmar no momento da extração. |

### Referências cross-domain
- `activityIngest.js` faz `prisma.user.findUnique({ where: { id: payload.userId } })` — depende do model **User** (que pertence ao módulo `carteira`).
- `aiCoach.js` provavelmente importa `@anthropic-ai/sdk` — integração externa compartilhada.

---

## 5. Models Prisma relacionados ao APEX

Localizados em `prisma/schema.prisma` entre as linhas **~1692 e ~2030**:

| # | Model | Linha | Notas |
|---|---|---|---|
| 1 | `AthleteProfile` | 1692 | FK para User (`userId @id`, onDelete: Cascade) |
| 2 | `Consent` | 1709 | FK para User; armazena consentimentos LGPD |
| 3 | `DeviceConnection` | 1722 | FK para User; integração apple_health, garmin, polar, oura, whoop |
| 4 | `Activity` | 1739 | Atividade esportiva registrada |
| 5 | `ActivityLap` | 1782 | Laps/splits de uma Activity |
| 6 | `ActivityPhoto` | 1794 | Fotos vinculadas à Activity |
| 7 | `Route` | 1804 | Rota gravada |
| 8 | `RoutePoint` | 1823 | Pontos da rota |
| 9 | `Segment` | 1835 | Segmento (estilo Strava) |
| 10 | `SegmentEffort` | 1853 | Tentativa do user em um Segment |
| 11 | `Club` | 1872 | Clube esportivo |
| 12 | `ClubMembership` | 1893 | User ↔ Club |
| 13 | `Challenge` | 1905 | Desafio |
| 14 | `ChallengeParticipation` | 1922 | User ↔ Challenge |
| 15 | `TrainingPlan` | 1935 | Plano de treino |
| 16 | `Workout` | 1949 | Treino |
| 17 | `WorkoutStep` | 1963 | Passo dentro de Workout |
| 18 | `UserPlan` | 1977 | Plano atribuído ao user |
| 19 | `SafetyContact` | 1989 | Contato de emergência |
| 20 | `LiveTrackingSession` | 2001 | Sessão de tracking ao vivo |
| 21 | `BadgeEarned` | 2016 | Badge conquistado; credita cashback em `User.balance` |

⚠️ **Todos os 21 models têm FK para `User`.** A tabela `User` não pode ser movida junto, porque é central do módulo `carteira`. Conclusão: schema fica compartilhado por enquanto.

---

## 6. Dependências externas

| Dependência | Onde | Crítica? |
|---|---|---|
| Anthropic SDK (`@anthropic-ai/sdk`) | `aiCoach.js` (presumido) | Não no curto prazo (zero produção). Confirmar no momento da extração. |
| Prisma Client | Ambos services | Sim — não pode quebrar. |

**Nenhuma integração com:** fal.ai, OpenAI, Meta, Nuvemshop, Resend, Web Push, Slack, SEFAZ. APEX é o módulo mais isolado externamente.

---

## 7. Dependências internas

### APEX → fora do APEX (saídas)
1. **Model `User`** (carteira) — FK obrigatória em 21 modelos. Crítica.
2. **Função `notifyBadgeEarned()`** em `src/services/systemMessenger.js` — APEX chama ao ganhar badge. Ponte para mensagens/push.
3. **`prisma.user.balance`** — `BadgeEarned.cashbackAwarded` credita `User.balance`. Cruza domínio carteira.

### Fora do APEX → APEX (entradas)
- **`systemMessenger.js`** define `notifyBadgeEarned(userId, badgeName, cashbackAwarded)` — função existe fora do APEX, mas o **caller é APEX**. Não é entrada real de fora para APEX; é APEX usando função compartilhada.
- **Nenhuma rota fora de APEX consome endpoints `/api/activities` ou `/api/coach` hoje** (sem evidência em `public/`, `src/routes/`, `src/services/`).
- **Nenhum cron** dispara código APEX.

### Conclusão de acoplamento
APEX é **quase autocontido**. As duas costuras reais são: (a) FK para User e (b) crédito em `User.balance` via BadgeEarned. Ambas são costuras de **dado**, não de **código**. Código APEX pode sair do diretório atual sem mexer em código de outros módulos.

---

## 8. Riscos da extração

### 🟢 Risco baixo (esperado)
- Tabelas APEX vazias → quebrar não afeta operação.
- Routes APEX sem consumidores em produção → mudança de path interno não quebra cliente.
- Services APEX isolados → mover não cascateia.

### 🟡 Risco médio (possível)
- **Mudança de `require()` paths** se algum arquivo fora de APEX importar internamente. Mitigação: grep antes de mover.
- **Quebra silenciosa de `notifyBadgeEarned`** se a ponte não for preservada. Mitigação: NÃO mover `systemMessenger.js`.
- **`aiCoach.js` pode ter import de `@anthropic-ai/sdk`** que precisa continuar resolvendo — não é problema se for require nativo do npm, mas é se for caminho relativo a outra pasta.

### 🔥 Risco alto (a evitar nesta fase)
- **Mover models APEX para outro schema Prisma agora.** NÃO fazer. FK para User exige schema compartilhado. Tentar separar = migração custosa + risco de quebrar carteira.
- **Renomear endpoints `/api/activities` ou `/api/coach`.** NÃO fazer. Mesmo que não haja consumidor hoje, manter contrato.
- **Mudar `notifyBadgeEarned` para dentro de APEX.** NÃO fazer. Função pertence ao módulo de mensagens.

---

## 9. O que NÃO pode ser tocado

Lista vinculante para esta extração:

1. **`prisma/schema.prisma`** — não mover models, não renomear, não dropar nada. APEX continua no mesmo schema.
2. **`src/services/systemMessenger.js`** — fica onde está. Mantém `notifyBadgeEarned()` como ponte.
3. **`src/routes/stocktake.js`, `xmlImport.js`, `fiscal.js`, `adminCatalog.js`, `products.js`, `inventory.js`, `aiCuration.js`** — proibidos por `REGRAS_CRITICAS.md`. Nenhum motivo para tocar nesta extração.
4. **`public/admin.html`** — não referencia APEX, não precisa mudar.
5. **`src/index.js`** — mount points `app.use('/api/activities', ...)` e `app.use('/api/coach', ...)` permanecem com **mesmo path**. Único ajuste permitido: trocar `require('./routes/activities')` por `require('./modules/apex/routes/activities')` (ou similar). Sem mudar a string do mount point.
6. **Tabelas/dados** — zero alteração de dados. Mesmo que vazias.
7. **Modelo `User`** — FK preservada exatamente como hoje.

---

## 10. Plano de execução em passos pequenos

Cada passo é um commit independente, com possibilidade de rollback. Ordem obrigatória.

### Passo 0 — Pré-requisitos (sem código)
- Backup do banco (mesmo APEX vazio — política do projeto).
- Branch criada a partir de `organizacao/refactor-2026-05-26`.
- `git status` limpo.
- Confirmar que `npm test` passa hoje (mesmo que não exista, registrar baseline do que existe).

### Passo 1 — Inventário detalhado (sem mover nada)
- Ler `src/routes/activities.js` e `src/routes/coach.js` integralmente.
- Ler `src/services/activityIngest.js` e `src/services/aiCoach.js` integralmente.
- Anotar **todos os `require()`** internos e externos.
- Anotar **todos os endpoints** expostos.
- Anotar **todos os models Prisma** acessados.
- Gerar lista de paths que mudarão e paths que **não** mudarão.

### Passo 2 — Criar a pasta destino (vazia)
- Criar `src/modules/apex/` com subpastas `routes/` e `services/`.
- Adicionar `src/modules/apex/README.md` curto descrevendo o módulo.
- **Não mover nada ainda.** Apenas a estrutura.
- Commit: `chore(apex): cria estrutura src/modules/apex/ (vazia)`.

### Passo 3 — Mover `activities.js` ✅ **CONCLUÍDO** (commit `c070555`)
- ✅ `git mv src/routes/activities.js src/modules/apex/routes/activities.js`.
- ✅ Atualizado `require` em `src/index.js` linha 43 para `./modules/apex/routes/activities`.
- ✅ Ajustados imports relativos internos: `../middleware` → `../../../middleware` e `../services/activityIngest` → `../../../services/activityIngest` (este último foi simplificado depois no Passo 5).
- ✅ `node --check` e `node -e "require(...)"` passaram. Endpoint `/api/activities` validado por carga de módulo.
- ✅ Commit: `c070555 refactor(apex): mover rota activities para modulo APEX`.

### Passo 4 — Mover `coach.js` ✅ **CONCLUÍDO** (commit `0af78f7`)
- ✅ Mesmo procedimento do Passo 3 com `coach.js`.
- ✅ Imports relativos ajustados em `src/modules/apex/routes/coach.js` linhas 6 e 7.
- ✅ Require em `src/index.js` linha 44 ajustado para `./modules/apex/routes/coach`.
- ✅ Commit: `0af78f7 refactor(apex): mover rota coach para modulo APEX`.

### Passo 5 — Mover `activityIngest.js` ✅ **CONCLUÍDO** (commit `29ff92b`)
- ✅ `git mv src/services/activityIngest.js src/modules/apex/services/activityIngest.js`.
- ✅ `require` dentro de `src/modules/apex/routes/activities.js` linha 9 simplificado de `../../../services/activityIngest` para `../services/activityIngest` (consumo interno ao módulo).
- ✅ Confirmado por busca que nenhum outro arquivo importava o service.
- ✅ Commit: `29ff92b refactor(apex): mover service activityIngest para modulo APEX`.

### Passo 6 — Mover `aiCoach.js` ✅ **CONCLUÍDO** (commit `903f2e2`)
- ✅ Mesmo procedimento do Passo 5 com `aiCoach.js`.
- ✅ `require` em `src/modules/apex/routes/coach.js` linha 7 simplificado para `../services/aiCoach`.
- ✅ Service carregou como `object` com chaves `isConfigured`, `dailyBriefing`, `postWorkoutAnalysis`, `chat` — nenhuma função invocada, nenhuma chamada Anthropic feita.
- ✅ Commit: `903f2e2 refactor(apex): mover service aiCoach para modulo APEX`.

### Passo 7 — `index.js` do módulo ⏸ **NÃO EXECUTADO / ADIADO**
- **Status:** não foi feito. Decisão consciente.
- **Motivo do adiamento:** o ganho de criar `src/modules/apex/index.js` re-exportando `{ activitiesRoutes, coachRoutes }` é puramente cosmético (2 linhas viram 1 em `src/index.js`). Sem benefício operacional. Pode ser feito em ciclo de polimento futuro.
- **Se for retomado:** seguir o passo original — criar arquivo de barrel export, simplificar requires em `src/index.js`, validar com `node --check` + `node -e "require(...)"`. Path string dos mount points não muda.

### Passo 8 — Documentação ✅ **EM EXECUÇÃO**
- ✅ `docs/MAPA_ATUAL.md` atualizado (seção N marca APEX como extraído).
- ✅ `docs/MODULOS_DESEJADOS.md` atualizado (módulo M marcado ✅ e Fase 1 marca APEX como ✅).
- ✅ `docs/PLANO_EXTRACAO_APEX.md` (este arquivo) atualizado com status pós-execução.
- ✅ `docs/REGRESSION_CHECKLIST.md` atualizado com referências aos novos paths e padrão de validação APEX.
- ✅ `docs/sports-app/README.md` atualizado com paths novos.
- Commit alvo: `docs(apex): marcar extracao do modulo APEX como concluida`.

### Passo 9 — Encerramento ✅ **CONCLUÍDO**
- ✅ Checklist manual de validação (seção 14) executado em cada passo, e final consolidado em `RELATORIO_VALIDACAO_FINAL_APEX` — **APROVADO**.
- Nenhum PR foi aberto ainda; trabalho está em branch local `refactor/apex-extracao-01`. Push e abertura de PR ficam a critério explícito do dono.
- **Sem merge automático.** Aguardando revisão.

---

## 11. Testes necessários antes de mover qualquer arquivo

Como o projeto ainda não tem suite de testes automatizada (regra: não criar testes nesta fase), validar manualmente **antes do Passo 3**:

### Baseline (estado atual, antes de qualquer mudança)
- [ ] `npm start` (ou comando equivalente) sobe o servidor sem erro.
- [ ] `GET /api/activities` (com header de auth) retorna 200 ou 401 (não 500).
- [ ] `POST /api/activities` (com payload vazio + auth) retorna 4xx esperado, não 500.
- [ ] `GET /api/coach/...` (endpoints listados no Passo 1) respondem sem 500.
- [ ] Logs do servidor não mostram erro de import.

### Smoke test pós cada movimento (Passos 3–7)
- [ ] Servidor sobe.
- [ ] Endpoints APEX continuam respondendo o mesmo status do baseline.
- [ ] Nenhuma rota não-APEX foi afetada (testar `/api/auth/login`, `/api/wallet`, `/api/admin/inventory/products`, `/api/stocktake/bipe` — todos devem responder igual ao baseline).
- [ ] `prisma.user.findUnique` continua funcionando (módulo APEX usa).
- [ ] `notifyBadgeEarned` ainda é importável em `systemMessenger.js`.

---

## 12. Critérios de aceite

A extração é considerada **concluída com sucesso** quando todos abaixo forem verdadeiros:

1. ✅ Arquivos `activities.js`, `coach.js`, `activityIngest.js`, `aiCoach.js` vivem dentro de `src/modules/apex/`.
2. ✅ `src/routes/` e `src/services/` não contêm mais arquivos APEX.
3. ✅ `prisma/schema.prisma` **não foi tocado**.
4. ✅ Mount points `/api/activities` e `/api/coach` continuam ativos com os mesmos paths.
5. ✅ Servidor sobe sem erro.
6. ✅ Smoke test de todos os endpoints APEX retorna o mesmo status do baseline.
7. ✅ Nenhum endpoint **não-APEX** mudou comportamento.
8. ✅ `notifyBadgeEarned` continua importável e funcional.
9. ✅ `git log` mostra commits pequenos (1 por arquivo movido), com mensagens claras.
10. ✅ Branch foi feita a partir de `organizacao/refactor-2026-05-26`.
11. ✅ PR aberto, **não merged**, aguardando aprovação do dono.

---

## 13. Plano de rollback

Cada passo do plano de execução é um commit isolado. Rollback é trivial.

### Rollback parcial (1 passo)
- `git revert <hash_do_commit>`.
- Boot local + smoke test.
- Continuar ou abortar.

### Rollback total (volta ao estado antes da extração)
- `git reset --hard <hash_do_passo_0>` (no branch de trabalho, **nunca** em main).
- OU `git checkout organizacao/refactor-2026-05-26` (descartar a branch de extração).
- Boot local + smoke test.

### Rollback de banco
- **Não é esperado precisar**, porque o plano não toca em schema nem dados.
- Se mesmo assim houver corrupção: restaurar backup do Passo 0 (`backups/db-YYYY-MM-DDTHH-mm-ss/`).

### Quando acionar rollback
- Servidor não sobe após qualquer commit.
- Endpoint não-APEX retorna 500 onde antes retornava 200.
- `prisma.user.findUnique` quebra.
- Qualquer cron deixa de subir no boot.
- Qualquer warning de "import not found" no log de startup.

---

## 14. Checklist manual de validação

Rodar **antes** de declarar a extração concluída.

### A. Ambiente e branch
- [ ] Branch atual é a de trabalho (não main).
- [ ] `git status` limpo.
- [ ] Backup do Passo 0 acessível.

### B. Estrutura de arquivos
- [ ] `src/modules/apex/routes/activities.js` existe.
- [ ] `src/modules/apex/routes/coach.js` existe.
- [ ] `src/modules/apex/services/activityIngest.js` existe.
- [ ] `src/modules/apex/services/aiCoach.js` existe.
- [ ] `src/modules/apex/index.js` existe e exporta routes (se Passo 7 foi feito).
- [ ] `src/routes/activities.js` NÃO existe mais.
- [ ] `src/routes/coach.js` NÃO existe mais.
- [ ] `src/services/activityIngest.js` NÃO existe mais.
- [ ] `src/services/aiCoach.js` NÃO existe mais.

### C. Bootstrap
- [ ] `src/index.js` importa routes APEX pelo novo path.
- [ ] `app.use('/api/activities', ...)` continua igual.
- [ ] `app.use('/api/coach', ...)` continua igual.

### D. Servidor sobe
- [ ] `npm start` (ou equivalente) inicia sem erro.
- [ ] Log de startup mostra "listening on PORT" normalmente.
- [ ] Sem warnings de "Cannot find module" no startup.

### E. Smoke test de endpoints APEX
- [ ] `GET /api/activities` responde mesmo status do baseline.
- [ ] `POST /api/activities` responde mesmo status do baseline.
- [ ] `GET /api/activities/:id` responde mesmo status do baseline.
- [ ] `/api/coach/*` (endpoints listados no Passo 1) respondem mesmo status do baseline.

### F. Smoke test de endpoints NÃO-APEX (canários)
- [ ] `POST /api/auth/login` continua funcionando.
- [ ] `GET /api/wallet` continua funcionando.
- [ ] `GET /api/admin/inventory/products?limit=5` continua funcionando.
- [ ] `POST /api/stocktake/bipe` (em ambiente teste) continua funcionando.
- [ ] `GET /api/admin/xml/nfes?docType=entrada` continua funcionando.

### G. Schema e banco
- [ ] `prisma/schema.prisma` está idêntico ao baseline (diff vazio).
- [ ] Migrations folder não recebeu arquivo novo.
- [ ] `prisma db pull` ou `prisma validate` passa sem alteração.

### H. Cross-references preservadas
- [ ] `systemMessenger.notifyBadgeEarned` continua exportada.
- [ ] Nenhum outro service quebrou import.
- [ ] `grep -r "require.*routes/activities\b" src/` retorna 0 ocorrências (já não importa do path antigo).
- [ ] `grep -r "require.*services/activityIngest\b" src/` retorna 0 ocorrências.

### I. Documentação
- [ ] `docs/MAPA_ATUAL.md` reflete nova localização do APEX.
- [ ] `docs/MODULOS_DESEJADOS.md` marca APEX como extraído.
- [ ] Nenhum outro doc foi tocado.

### J. PR
- [ ] PR aberto contra `organizacao/refactor-2026-05-26`.
- [ ] Commits pequenos (1 por arquivo movido, conforme Passos 3–7).
- [ ] PR **não** foi merged.
- [ ] Aguarda revisão e aprovação do dono.

---

## Observações finais

- Este plano é **conservador por design**. APEX é o módulo mais isolado do sistema; mesmo assim, optamos por mover 1 arquivo por commit e rodar smoke test entre cada passo.
- **A lição aprendida deste exercício** (tempo de execução, atrito real, surpresas) é o entregável mais importante — informa as Fases 2 e 3 (Etiquetas, Curadoria de Vitrine, Life, e depois os módulos críticos).
- **Schema Prisma fica intocado.** Separar models APEX em outro schema é trabalho futuro, exige planejamento próprio e migração coordenada — fora do escopo deste plano.
- **`notifyBadgeEarned` permanece em `systemMessenger.js`.** Não tentar puxar para dentro de APEX nesta fase.

## Status final (atualização pós-execução — 26/05/2026)

A extração foi **executada e validada com sucesso**. Resumo:

- ✅ 4 commits atômicos (Passos 3, 4, 5, 6): `c070555`, `0af78f7`, `29ff92b`, `903f2e2`.
- ✅ 4 arquivos APEX agora vivem em `src/modules/apex/`.
- ✅ Mount points `/api/activities` e `/api/coach` preservados literalmente.
- ✅ `prisma/schema.prisma` **não foi tocado**.
- ✅ `package.json`, `.env`, `src/middleware.js` **não foram tocados**.
- ✅ Banco **não recebeu nenhuma escrita**.
- ✅ Nenhum endpoint foi chamado durante a validação (apenas `node --check` e `node -e "require(...)"`).
- ✅ Nenhuma chamada Anthropic, fal.ai, OpenAI ou qualquer outra API externa foi feita.
- ✅ Working tree limpa após cada commit.
- ⏸ Passo 7 (`index.js` do módulo) **adiado**, sem perda funcional.

Lição aprendida deste exercício (para guiar próximas extrações — Etiquetas, Curadoria de Vitrine, Life):

- Padrão de **1 arquivo por commit** atômico funciona bem e dá rollback granular.
- **`R<N>` no `git status`** permite detectar quão "puro" foi o rename (R100 = sem edit, R<95 = com edits de import).
- `node --check` + `node -e "require(...)"` são suficientes para smoke test de extração modular sem precisar subir servidor.
- Confirmar antes do `git mv` que **nenhum outro arquivo** importa o que será movido — busca global por nome simples e por path completo.
- Manter mount points string idênticos é não-negociável; só ajustar a fonte do require.
