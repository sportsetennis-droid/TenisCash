# APEX SPORT — Arquitetura Técnica

## Stack recomendado (do Doc 1 — deep-research)

### Frontend
- **iOS / watchOS** — Swift nativo (UI sensível ao watchOS)
- **Android / Wear OS** — Kotlin nativo
- **Compartilhamento de domínio** — Kotlin Multiplatform (KMP)
- **Web / PWA** — Next.js + Tailwind (canal de alcance, não principal)

### Backend
- **API Gateway / BFF** — Node.js (NestJS) ou Go
- **Domínios principais** (microsserviços):
  - identity & consent
  - activity-ingest
  - activity-core
  - routes-geo
  - segments-ranking
  - social-feed
  - clubs-challenges
  - training-coach
  - billing
  - notifications
  - safety-live
  - partner-connectors

### Storage
- **Postgres + PostGIS** — OLTP + queries geoespaciais
- **ClickHouse ou TimescaleDB** — séries temporais + analytics
- **Redis** — cache, fan-out, leaderboards quentes
- **Kafka ou NATS** — event streaming
- **S3 / R2** — FIT/GPX/Parquet imutável
- **CDN** — Cloudflare ou CloudFront (mapas, mídia)

### IA / ML
- **Anthropic Claude** — coach conversacional, vision (validar fotos de atividade)
- **TensorFlow Lite** — on-device inference (HAR — Human Activity Recognition)
- **PyTorch + custom LSTM** — predição de performance, anomaly detection

### Observabilidade
- **OpenTelemetry** — métricas + traces + logs
- **Grafana + Loki + Tempo** — visualização

### CI/CD
- **GitHub Actions** — build/test
- **Argo CD** — GitOps
- **Argo Rollouts** — canary + blue/green

## Modelo de dados core (PostGIS)

Vide `prisma/schema.prisma`.

```
USER ─┬─ ATHLETE_PROFILE
      ├─ DEVICE_CONNECTION (Apple Health, Health Connect, Garmin, etc.)
      ├─ ACTIVITY ──┬─ ACTIVITY_SAMPLE (alta cardinalidade → ClickHouse)
      │             ├─ ACTIVITY_LAP
      │             └─ ACTIVITY_PHOTO
      ├─ ROUTE ───── ROUTE_POINT
      ├─ SEGMENT_EFFORT
      ├─ CLUB_MEMBERSHIP
      ├─ CHALLENGE_PARTICIPATION
      └─ TRAINING_PLAN
```

## Privacidade (LGPD/GDPR — não opcional)

- Consentimento granular reversível por tipo de dado
- Zona residencial **escondida por padrão**
- Visibilidade default = `FOLLOWERS_ONLY` (não público)
- Heatmaps só com dados agregados, de-identificados, com mínimo de multidão
- Live tracking com links **expiráveis** e **revogáveis**
- Direito de portabilidade + deleção total
- Registro de transferências internacionais (ANPD Res. 19/2024)
- Dados de saúde = categoria especial pelo GDPR

## Integrações prioritárias

| Integração | Modo | Prioridade |
|---|---|---|
| Apple HealthKit + Watch | HealthKit + workout sessions | 🔴 alta |
| Android Health Connect | permissions + records | 🔴 alta |
| Garmin | Activity/Training/Health API | 🔴 alta |
| BLE | Core Bluetooth / Android BLE | 🔴 alta |
| ANT+ | Android profiles | 🟡 média |
| Mapbox / Google Maps | tiles, search, routes | 🔴 alta |
| Apple Pay / Google Pay | digital goods billing | 🔴 alta |
| Stripe / Mercado Pago | web billing | 🟡 média |

## Decisões fundamentais

1. **Phone-first, watch-augmented** — não fazer watch-first (limita público inicial)
2. **Nativo + KMP** — não React Native pra superfícies sensíveis (background location, BLE)
3. **PostGIS + ClickHouse** — não tentar resolver tudo com Postgres puro
4. **Sem NFT/Web3 no MVP** — App Store/Google Play restrições, baixa retenção comprovada
5. **Coach IA modular** — começar com features ML específicas (classificação, predição, recomendação), não chatbot universal
6. **Skills de fitness não substituem médico** — sempre rotular insights, não diagnósticos
