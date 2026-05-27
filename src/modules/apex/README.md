# Módulo APEX — esqueleto

> Estrutura vazia. Nenhum arquivo do código atual foi movido. Esta pasta existe apenas como **destino futuro** da extração planejada em `docs/PLANO_EXTRACAO_APEX.md`.

## Objetivo do módulo

Agrupar em um único bounded context o código relacionado ao **APEX SPORT** — app esportivo do ecossistema Sports & Tennis + TenisCash. APEX cobre: ingestão de atividade física vinda do app mobile (RUN, RIDE, SWIM, TENNIS, etc.), coach IA conversacional, perfil de atleta, badges com cashback, segments/leaderboards, clubes e desafios.

A escolha do APEX como **primeiro módulo a ser extraído** foi feita porque:

- Todas as 21 tabelas APEX estão vazias em produção (zero impacto operacional).
- Apenas 2 routes e 2 services, totalizando ~371 linhas de JS.
- Sem frontend acoplado no `public/` atual.
- Sem cron, sem job, sem integração de fora pra dentro.
- Serve como **exercício do padrão de extração modular** antes de aplicar a mesma técnica a módulos críticos (Catálogo, Inventário, Bipe).

## Arquivos que serão movidos futuramente

Quando a execução real for autorizada (ainda não foi), os arquivos abaixo devem migrar para esta pasta com `git mv`:

| De (hoje) | Para (futuro) |
|---|---|
| `src/routes/activities.js` | `src/modules/apex/routes/activities.js` |
| `src/routes/coach.js` | `src/modules/apex/routes/coach.js` |
| `src/services/activityIngest.js` | `src/modules/apex/services/activityIngest.js` |
| `src/services/aiCoach.js` | `src/modules/apex/services/aiCoach.js` |

Tamanhos (baseline):
- `activities.js` — 70 linhas
- `coach.js` — 49 linhas
- `activityIngest.js` — 132 linhas
- `aiCoach.js` — 120 linhas

Total estimado: **~371 linhas de JS** a serem reposicionadas.

## Rotas que devem permanecer com os mesmos paths

A extração **não muda o contrato HTTP**. Os mount points em `src/index.js` continuam exatamente:

```
app.use('/api/activities', activitiesRoutes);
app.use('/api/coach',      coachRoutes);
```

Endpoints públicos APEX inalterados:

- `POST /api/activities` — ingestão de atividade (autenticado)
- `GET  /api/activities` — lista atividades do usuário
- `GET  /api/activities/:id` — detalhe de atividade
- `GET  /api/coach/status` — checa se Anthropic está configurado
- `POST /api/coach/briefing` — briefing diário (Anthropic)
- `POST /api/coach/post-workout` — análise pós-treino (Anthropic)
- `POST /api/coach/chat` — chat conversacional (Anthropic)

**Renomear path, mudar método HTTP ou alterar shape de payload está proibido nesta extração.**

## Restrição: não tocar `prisma/schema.prisma`

Os 21 models APEX (linhas ~1692 a ~2030 de `prisma/schema.prisma`) ficam **onde estão** — no schema único, junto com os models de Carteira, Catálogo, Fiscal, RH e demais módulos.

Motivos:

- Todos os models APEX têm FK para `User`, que pertence ao módulo `carteira`. Separar schema agora exigiria duplicar/sincronizar a tabela `User`, o que é custoso e arriscado.
- `BadgeEarned.cashbackAwarded` credita `User.balance` — operação atômica que não pode atravessar fronteira de schema sem transação distribuída.
- O ganho de separar schema agora é puramente cosmético; o custo é real.

Separar o schema APEX em arquivo próprio (`prisma/apex.prisma` ou banco dedicado) é trabalho futuro, com plano próprio. **Fora do escopo deste módulo nesta fase.**

## Dependência futura de `authMiddleware` e Prisma

Após a movimentação dos arquivos, esta pasta dependerá de:

- **`src/middleware.js`** — `authMiddleware` é usado por `activities.js` e `coach.js`. Permanece no caminho atual. Os imports dentro dos arquivos movidos passarão a fazer `require('../../../middleware')` (sobem 3 níveis a partir de `src/modules/apex/routes/`).
- **`@prisma/client`** — `activities.js` e `activityIngest.js` instanciam `new PrismaClient()`. Continua via pacote npm; sem mudança.
- **`@anthropic-ai/sdk`** — `aiCoach.js` importa o SDK Anthropic. Continua via pacote npm; sem mudança.
- **`src/services/systemMessenger.js`** — quando o loop de badges for ligado, APEX chamará `notifyBadgeEarned()` daqui. `systemMessenger.js` **permanece fora do módulo APEX**, pois pertence ao domínio de mensagens. APEX é apenas consumidor.

## Referências

- **Plano completo de extração:** [`docs/PLANO_EXTRACAO_APEX.md`](../../../docs/PLANO_EXTRACAO_APEX.md)
- **Baseline pré-extração (estado atual capturado):** [`docs/BASELINE_PRE_EXTRACAO_APEX.md`](../../../docs/BASELINE_PRE_EXTRACAO_APEX.md)
- **Regras críticas do projeto (vinculantes):** [`docs/REGRAS_CRITICAS.md`](../../../docs/REGRAS_CRITICAS.md)
- **Checklist de regressão obrigatório:** [`docs/REGRESSION_CHECKLIST.md`](../../../docs/REGRESSION_CHECKLIST.md)

---

**Estado atual desta pasta:** apenas estrutura vazia. Nenhum código foi movido para cá. Nenhum import foi alterado. Nenhum endpoint foi tocado. Execução real da extração depende de autorização explícita do dono.
