# APEX (módulo esportivo) — Arquitetura Técnica

## Stack adotado

### Backend (UNIFICADO ao TenisCash)
- **Node.js + Express + Prisma + PostgreSQL** — mesmo cluster atual (Railway)
- **Modelos APEX** vivem no `prisma/schema.prisma` principal
- **Serviços APEX** vivem em `src/services/` (activityIngest.js, aiCoach.js)
- **Rotas APEX** vivem em `src/routes/` (activities.js, coach.js)

### Infraestrutura adicional (FUTURO)
- **PostGIS** — extensão Postgres pra queries geoespaciais (segmentos, heatmaps, rotas)
- **ClickHouse ou TimescaleDB** — séries temporais (samples GPS/HR a 1Hz)
- **Redis** — cache + leaderboards quentes
- **Kafka ou NATS** — event streaming (activity.created → workers downstream)
- **S3 / R2** — payloads imutáveis (FIT/GPX/raw)
- **CDN** — Cloudflare ou CloudFront (tiles, mídia)

### Mobile (FUTURO)
- **iOS + watchOS** — Swift + SwiftUI
- **Android + Wear OS** — Kotlin + Jetpack Compose
- **Domínio compartilhado** — Kotlin Multiplatform (KMP)
- **Web/PWA** — Next.js (canal de alcance, não principal)

**NÃO usar:** React Native como superfície principal. Limita background location, BLE, workout sessions.

### IA / ML
- **Anthropic Claude** — coach conversacional (já configurado), vision (já configurado)
- **TensorFlow Lite** — on-device HAR (Human Activity Recognition)
- **PyTorch + LSTM** — predição de performance, anomaly detection

### Observabilidade
- **OpenTelemetry** — métricas + traces + logs
- **Grafana + Loki + Tempo** — visualização

## Modelo de dados (Postgres principal)

Tudo no `prisma/schema.prisma` do TenisCash. Convivendo com Product, Sale, User, etc.

```
USER (loja + atleta, mesmo registro)
├─ AthleteProfile (1:1, dados esportivos)
├─ Consent (LGPD granular)
├─ DeviceConnection (Garmin, HealthKit, Health Connect)
├─ Activity ──┬─ ActivityLap
│             ├─ ActivityPhoto
│             ├─ SegmentEffort → Segment
│             └─ LiveTrackingSession
├─ Route ───── RoutePoint
├─ ClubMembership → Club
├─ ChallengeParticipation → Challenge
├─ UserPlan → TrainingPlan → Workout → WorkoutStep
├─ SafetyContact
└─ BadgeEarned (com cashbackAwarded → loop com User.balance)
```

## Privacidade (LGPD)

- Consentimento granular reversível por tipo de dado (tabela `Consent`)
- Zona residencial **escondida por padrão** (`startPrivacyRadiusM`, `endPrivacyRadiusM` em Activity)
- Visibilidade default = `followers` (não público)
- Heatmaps só com dados agregados, de-identificados, com mínimo de multidão
- Live tracking com links **expiráveis** e **revogáveis** (`LiveTrackingSession.shareTokenHash`)
- Direito de portabilidade + deleção total (já existe estrutura de delete em User)
- Dados de saúde = categoria especial pelo GDPR — exige consentimento explícito

## Integrações prioritárias

| Integração | Modo | Prioridade |
|---|---|---|
| Apple HealthKit + Watch | HealthKit + workout sessions | 🔴 alta |
| Android Health Connect | permissions + records | 🔴 alta |
| Garmin Connect | Activity/Training/Health API | 🔴 alta |
| BLE | Core Bluetooth / Android BLE | 🔴 alta |
| Mapbox / Google Maps | tiles, search, routes | 🔴 alta |
| Apple Pay / Google Pay | digital goods billing | 🔴 alta |
| Stripe / Mercado Pago | web billing | 🟡 média |

## Decisões fundamentais

1. **Unificado ao TenisCash** — não é app separado. Mesmo backend, mesmo banco, mesmo User. O cliente da loja é o atleta do app.
2. **Phone-first, watch-augmented** — não fazer watch-first (limita público inicial)
3. **Nativo + KMP** — não React Native pra superfícies sensíveis
4. **PostGIS + ClickHouse vão entrar quando precisar** — começa simples com Postgres puro
5. **Sem NFT/Web3 no MVP** — App Store/Google Play restrições, baixa retenção comprovada
6. **Coach IA modular** — features ML específicas, não chatbot universal
7. **Loop economia loja↔app** — badge no app credita TenisCash que vira desconto na loja
