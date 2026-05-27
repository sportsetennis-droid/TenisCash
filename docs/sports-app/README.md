# Sports & Tennis — App esportivo (módulo APEX)

**Status:** Esqueleto. Schemas continuam em `prisma/schema.prisma`. Em 26/05/2026 o código backend do APEX foi **extraído para o módulo isolado `src/modules/apex/`** (commits `c070555`, `0af78f7`, `29ff92b`, `903f2e2`) — `activityIngest.js`, `aiCoach.js`, `activities.js`, `coach.js` agora vivem todos em `src/modules/apex/`. Mount points `/api/activities` e `/api/coach` preservados. Falta infra extra (PostGIS, ClickHouse, Kafka, S3) + apps mobile + time.

## Visão unificada

Sports & Tennis (lojas físicas + ecommerce) + TenisCash (loyalty) + agentes IA (gestão) + **APEX (app esportivo)** = um único ecossistema.

- **O cliente é o mesmo atleta.** Compra na loja, treina no app, ganha TenisCash em badges/desafios, gasta na próxima compra.
- **Mesma base de dados.** O `User` da loja é o `User` do app. `AthleteProfile`, `Activity`, `Route`, `Club`, `BadgeEarned` etc. apontam pro mesmo userId.
- **Mesma economia.** `BadgeEarned.cashbackAwarded` → soma em `User.balance` (TenisCash). Conquistas no app viram poder de compra na loja.

## Módulos

- `01-track.md` — rastreamento de atividade (corrida, ciclismo, tênis, padel, etc.)
- `02-social.md` — feed, clubes, desafios
- `03-coach.md` — coach IA (APEX COACH)
- `04-arena.md` — gamificação (XP, ligas, badges)
- `mobile/README.md` — stack mobile (iOS + watchOS + Android + Wear OS + KMP)

## Arquivos no repo TenisCash

| Onde | O quê |
|---|---|
| `prisma/schema.prisma` | Modelos APEX (Activity, Route, Segment, Club, Challenge, AthleteProfile, BadgeEarned, etc.) — **não movido**, permanece no schema único |
| `src/modules/apex/services/activityIngest.js` | Validação + ingestão de atividade |
| `src/modules/apex/services/aiCoach.js` | APEX COACH (briefing, análise pós-treino, chat) |
| `src/modules/apex/routes/activities.js` | POST/GET /api/activities |
| `src/modules/apex/routes/coach.js` | POST /api/coach/briefing, /post-workout, /chat |
| `src/modules/apex/README.md` | Descrição do módulo extraído |

> **Nota histórica:** antes de 26/05/2026 esses arquivos viviam em `src/routes/` e `src/services/`. A extração foi puramente de movimentação — sem mudança de schema, sem mudança de comportamento, sem mudança de path público. Ver `docs/PLANO_EXTRACAO_APEX.md` para o histórico completo.

## O que NÃO está em produção (sabidamente)

- Apps mobile compilados (Apple Developer + Google Play)
- ClickHouse pra streams de alta cardinalidade (GPS, HR a 1Hz)
- PostGIS pra queries geoespaciais (segmentos, heatmaps)
- Kafka/NATS pra workers downstream (segment-processor, leaderboard-updater, badge-checker)
- S3 pra payloads raw (FIT/GPX)
- Integrações Garmin/Apple HealthKit/Health Connect reais

## Roadmap

Veja `ROADMAP.md`. Estimativa Doc 1 (deep-research):

- **Fundação (M0-M3):** 8-12 pessoas, R$ 1.5-3 mi
- **MVP (M3-M6):** 15-24 pessoas, R$ 4-8 mi
- **Escala (M6-M12):** 25-40 pessoas, R$ 12-28 mi
- **Maturidade (M12-M24):** 50-90 pessoas, R$ 35-90 mi acumulado

## Loop economia loja ↔ app

```
Atleta compra tênis na loja Sports & Tennis
    ↓ ganha cashback TenisCash (já existe)
    ↓
Atleta abre app → registra corrida 10k
    ↓ ganha badge "10K Club"
    ↓ BadgeEarned.cashbackAwarded R$ 5 → User.balance += 5
    ↓
Próxima compra na loja
    ↓ usa saldo TenisCash → desconto
    ↓
Loop fechado: atleta fica preso no ecossistema
```

Esse loop é o diferencial de Sports & Tennis vs Strava/NRC — eles não têm loja física. Eles vão sempre depender de patrocínio. Nós temos canal próprio.
