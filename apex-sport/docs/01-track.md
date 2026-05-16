# APEX TRACK — Rastreamento de Atividades

## Escopo MVP

Modalidades suportadas no MVP (não 100+):

- Corrida (outdoor + esteira)
- Caminhada
- Ciclismo (road + indoor)
- Trilha
- Treino indoor / força
- Yoga / pilates

Outras modalidades entram em fase 2-3.

## Estrutura da atividade

```typescript
interface Activity {
  id: string;
  userId: string;
  sportType: SportType;
  startedAt: Date;
  elapsedTimeS: number;
  movingTimeS: number;
  distanceM: number;
  elevationGainM: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgPace?: number;
  calories?: number;
  trainingLoad?: number;
  summaryPolyline: string;  // simplificada
  visibility: 'public' | 'followers' | 'clubs' | 'private';
  deviceSource: string;     // phone | apple_watch | garmin_xxx
  // privacy
  startPrivacyRadiusM: number;
  endPrivacyRadiusM: number;
}
```

## Streams (alta cardinalidade — vai pra ClickHouse)

```typescript
interface ActivitySample {
  activityId: string;
  ts: Date;
  lat?: number;
  lon?: number;
  altitudeM?: number;
  heartRate?: number;
  cadence?: number;
  power?: number;          // watts (ciclismo)
  speed?: number;          // m/s
}
```

Postgres tem só o sumário; ClickHouse guarda 1 ponto/segundo durante a atividade.

## Captura

### iOS (workoutSession)
- `HKWorkoutSession` configurado pra esporte específico
- `HKLiveWorkoutBuilder` pra coletar amostras em tempo real
- `CLLocationManager` em background pra GPS
- HRV calculada via `HKQuantityTypeIdentifierHeartRateVariabilitySDNN`

### Android (Health Connect + Foreground Service)
- Foreground service rodando enquanto atividade ativa
- `FusedLocationProviderClient` em high accuracy
- `BluetoothLeScanner` pros sensores BLE
- Escreve dados pro Health Connect (sessões, métricas, rotas)

## Validações server-side

Quando atividade chega no `/v1/activities`:

1. **Auth** — userId bate com token
2. **Coerência temporal** — startedAt < endedAt, dentro de janela razoável
3. **Velocidade plausível** — por esporte (RUN máx 7m/s, RIDE máx 25m/s)
4. **HR plausível** — entre 30 e 220 bpm
5. **Distância coerente** — somatório de samples ≈ distance declarada (margem 5%)
6. **GPS jumps** — detecta teleportes (velocidade entre 2 samples impossível)

Se válido → marca `processingState: 'processing'`, dispara evento → workers processam.

## Workers downstream

- **segment-processor** — descobre quais segmentos foram percorridos (map matching)
- **leaderboard-updater** — atualiza rankings
- **challenge-progress** — incrementa contadores de desafio
- **achievement-checker** — verifica badges desbloqueados
- **ml-feature-pipeline** — gera features pro coach IA

## Privacidade aplicada

- Antes de publicar polyline pública: aplica privacy radius (start + end)
- Heatmap só recebe contribuição se `visibility == public` AND `heatmapOptIn == true`
- Live tracking: link expirável + revogável
- Friend-only e private NUNCA entram em heatmap nem aparecem pra estranhos

## Pra implementar de verdade

1. `mobile/ios/ApexSport/ActivityRecorder.swift` — HKWorkoutSession setup
2. `mobile/android/app/.../ActivityRecorderService.kt` — foreground service
3. `apex-sport/backend/routes/activities.js` — POST/GET endpoints
4. `apex-sport/backend/workers/activityProcessor.js` — Kafka consumer
5. ClickHouse cluster (1.5 vCPU + 4GB RAM mínimo pra teste)
