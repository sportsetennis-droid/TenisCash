# APEX SPORT Mobile

## Stack recomendado (Doc 1 — deep-research)

**Recomendação:** apps NATIVOS com KMP pra compartilhar domínio.

- **iOS + watchOS**: Swift + SwiftUI
- **Android + Wear OS**: Kotlin + Jetpack Compose
- **Compartilhamento**: Kotlin Multiplatform (KMP) pra domínio business logic
- **Web/PWA**: Next.js (alcance, não principal)

**NÃO recomendado:** React Native como superfície principal — limita acesso a background location, BLE, workout sessions com a profundidade necessária.

## Estrutura sugerida

```
mobile/
├── ios/
│   ├── ApexSport/                 # main app
│   ├── ApexSportWatch/            # watchOS companion
│   └── ApexSportTests/
├── android/
│   ├── app/                       # main app
│   ├── wear/                      # Wear OS
│   └── tests/
├── shared/                        # Kotlin Multiplatform
│   ├── domain/                    # entidades, use cases
│   ├── data/                      # repositórios, network, persistence
│   └── presentation/              # ViewModels (compartilhados onde possível)
└── web/                           # Next.js PWA
```

## Funcionalidades MVP do mobile

1. **Auth** — OAuth (Apple, Google) + email/password com PKCE
2. **Onboarding** — objetivos, esporte favorito, conexão wearable
3. **Activity recording** — GPS + sensores BLE + HealthKit/Health Connect
4. **Activity history** — feed pessoal + métricas
5. **Social feed** — atividades de amigos/clubes
6. **Clubes** — descoberta, adesão, ranking
7. **Profile** — bio, foto, estatísticas
8. **Settings** — privacidade granular (zona residencial, visibilidade default)
9. **Live tracking** — compartilhar link expirável durante atividade
10. **Premium subscription** — paywall + IAP

## Integrações nativas obrigatórias

- **iOS**: HealthKit, Core Bluetooth, CLLocationManager, Activity Rings, Live Activities, WatchConnectivity
- **Android**: Health Connect, BluetoothLeScanner, FusedLocationProviderClient, foreground service pra tracking
- **watchOS**: HKWorkoutSession (sensors em alta frequência, background)
- **Wear OS**: HealthServicesClient pra exercise sessions

## Background tracking — pontos críticos

- iOS: `Location updates` background mode + `Workout processing` background mode
- Android: foreground service com `ACCESS_FINE_LOCATION` + `BACKGROUND_LOCATION` (a partir de Android 10)
- Notificação visível obrigatória enquanto rastreia

## Pra criar de verdade

1. Apple Developer Program (USD 99/ano)
2. Google Play Console (USD 25 uma vez)
3. Certificados e provisioning profiles
4. Time mobile: 1 iOS lead + 1 Android lead + 1 KMP shared + 1 designer + 1 QA
5. CI/CD: Fastlane + Bitrise/Codemagic
6. Crash reporting: Sentry, Firebase Crashlytics

**Custo estimado time mobile no MVP:** 4 pessoas × 6 meses × R$ 25k/mês = R$ 600k
