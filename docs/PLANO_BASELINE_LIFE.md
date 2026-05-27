# PLANO + BASELINE — Módulo Life (avaliação S0/S1/S2)

> Avaliação de elegibilidade do módulo **Life** para extração em modo turbo. **Conclusão antecipada: S1 — não extrair nesta fase.** Apenas documentar.

Data: 2026-05-26
Branch: `refactor/curadoria-vitrine-extracao-01`
HEAD: `7dd5477`

---

## 1. Arquivos relacionados

| Arquivo | Linhas | Status |
|---|---|---|
| `src/routes/life.js` | **240** | route principal, mount `/api/life` |
| `src/ai/recommendations/possibility-engine.service.js` | (não medido — não é arquivo do route, é dependência) | importado pelo `life.js` |
| `src/ai/agents/life-assessor.agent.js` | (não medido) | importado pelo `possibility-engine.service.js` |
| `src/ai/agents/agent.registry.js` | — | também importa `life-assessor.agent` (cruza com sistema de agentes IA) |

**Conclusão:** Life **não é 1-2 arquivos isolados**. A cadeia de dependências atravessa o subsistema de IA (`src/ai/...`).

## 2. Mount point

```
src/index.js:22:   const lifeRoutes = require('./routes/life');
src/index.js:121:  app.use('/api/life', lifeRoutes);
```

## 3. Models Prisma acessados

`life.js` toca **4 tabelas** (não 1):

- `UserLifeProfile` (modelo principal, linha 811 do schema)
- `UserMoodCheckin` (check-ins de humor)
- `UserTrainingLog` (log de treinos)
- `UserAction` (ações recomendadas pelo agente)

## 4. Importadores

```
src/index.js:22                                        → routes/life
src/ai/agents/agent.registry.js:14                     → ai/agents/life-assessor.agent
src/ai/recommendations/possibility-engine.service.js:15 → ai/agents/life-assessor.agent
src/routes/life.js                                     → ai/recommendations/possibility-engine.service
```

Cadeia: `routes/life` → `possibility-engine.service` → `life-assessor.agent` → `agent.registry` (rede de agentes IA do projeto).

## 5. Endpoints (11 total)

| Linha | Método | Path | Escreve banco? | Chama IA? |
|---|---|---|---|---|
| 28 | POST | `/profile` | sim (UserLifeProfile upsert) | não |
| 71 | GET | `/profile` | não | não |
| 82 | POST | `/checkin` | sim (UserMoodCheckin) | não |
| 102 | GET | `/checkins` | não | não |
| 118 | POST | `/possibilities` (com `possibilityLimiter`) | sim | **SIM — chama `generatePossibilities` que invoca life-assessor agent → Anthropic** |
| 135 | POST | `/training-log` | sim | não |
| 158 | GET | `/training-logs` | não | não |
| 174 | GET | `/recommendations` | não | não |
| 186 | GET | `/actions` | não | não |
| 202 | POST | `/actions/:id/approve` | sim (UserAction update) | não |
| 223 | POST | `/actions/:id/cancel` | sim | não |

## 6. Sinalizadores críticos

- ✅ Tem endpoint que **escreve no banco** (vários).
- ✅ Tem endpoint que **chama API externa** (Anthropic via life-assessor agent em `POST /possibilities`).
- ✅ Tem **rate limit explícito** (`possibilityLimiter`) — sinal de uso real OU proteção contra custo.
- ✅ **Mais de 2 arquivos** principais (route + 2 arquivos na cadeia IA).
- ❌ Sem cron explícito (a verificar — não foi grep'ado).
- ❌ Sem dependência declarada de Product/StoreStock/fiscal.
- ❓ Volume em produção: **não confirmado** (não rodamos query por regra). Hipótese conservadora: pode estar em uso por algum cliente que assinou o agente.

## 7. Classificação

### S0 — Turbo Seguro? **NÃO.**
- Falha em "até 2 arquivos principais".
- Falha em "sem integração externa" (Anthropic via agente).
- Falha em "não exige endpoint para validar" — `POST /possibilities` é o coração do módulo e custa $ pra testar.

### S1 — Controlado? **SIM.**
- Endpoints que escrevem em produção.
- Mais de 2 arquivos.
- Integração externa.
- **Decisão por regra:** "Não extrair automaticamente. Apenas planejar e documentar."

### S2 — Bloqueado? **Borderline.**
- Toca a rede de agentes IA (`src/ai/agents/`).
- Integra Anthropic.
- Se entrar em S2, fica congelado. Razoável manter em S1 com nota de que extração futura precisa também extrair o subsistema `src/ai/`, o que é projeto separado.

## 8. Recomendação

**NÃO EXTRAIR AGORA.**

Razões:

1. A cadeia de dependências atravessa `src/ai/` — extrair só `life.js` deixaria o módulo dependente de paths externos quebradiços (`../../../ai/recommendations/possibility-engine.service`).
2. `POST /possibilities` é endpoint pago (Anthropic). Validação técnica via `require()` é segura (só carga estática), mas qualquer smoke funcional custa.
3. O ganho da extração é cosmético — Life funciona como tá.
4. Prioridade real do projeto está em outras alavancas (Bipe, Fiscal, Catálogo) que **dão receita** — Life é nice-to-have.

### Quando reavaliar

Reavaliar Life para extração quando:
- O subsistema `src/ai/` for atacado em projeto próprio (extrair `src/ai/agents/` + `src/ai/recommendations/` para `src/modules/ai-platform/`).
- OU se houver decisão de derrubar Life (UserLifeProfile não está em uso real — verificar via query antes).

## 9. Atestado

- ✅ Nenhum arquivo de Life foi tocado neste turno.
- ✅ Nenhuma chamada Anthropic foi feita.
- ✅ Nenhuma escrita no banco.
- ✅ Apenas leitura via grep e leitura de arquivos.
- ✅ Sem alteração de código.

**Module Life permanece como está. Decisão registrada. Próximo ciclo fica congelado em `docs/AREAS_CRITICAS_CONGELADAS.md`.**
