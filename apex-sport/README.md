# APEX SPORT — Plataforma esportiva global

**Status:** Esqueleto / fundação. Código existe, falta infra + time + capital pra rodar de verdade.

## Visão

Super-app esportivo concorrendo com Strava, Nike Run Club, Adidas Running, WHOOP. Plataforma phone-first + watch-augmented, com 10 módulos: tracking, social, coach IA, gamificação, nutrição, sono, saúde mental, rotas, marketplace e Web3 (opcional / fase tardia).

**Filosofia adotada:** Doc 1 (deep-research) — minimalismo no MVP, foco em retenção. Adiamos NFT/AR/VR pra fase 3+.

## Estrutura

```
apex-sport/
├── README.md              ← este arquivo
├── ARCHITECTURE.md        ← arquitetura técnica
├── ROADMAP.md             ← roadmap 24 meses
├── prisma/                ← schemas Postgres + PostGIS (preparado)
├── backend/               ← serviços Node + Python (estrutura)
│   ├── services/
│   ├── routes/
│   └── workers/
├── mobile/                ← React Native (estrutura)
│   ├── src/
│   └── package.json
└── docs/                  ← especificações por módulo
    ├── 01-track.md
    ├── 02-social.md
    ├── 03-coach.md
    ├── 04-arena.md
    └── ...
```

## O que NÃO está implementado (sabidamente)

- Conexão com banco de dados real (precisa de cluster próprio, não o do TenisCash)
- Apps mobile compilados (precisa Apple Developer + Google Play accounts)
- ML pipelines em produção
- Web3 / Smart contracts (intencionalmente fora do MVP)
- Mapbox/Garmin/Strava integrations reais

## O que ESTÁ aqui

- Schemas Prisma com tabelas core (User, Activity, Route, Segment, Club, Challenge)
- Estrutura de pastas backend organizada por domínio
- Estrutura de pastas mobile React Native
- Documentação por módulo com decisões arquiteturais
- Roadmap realista 24 meses
- Custos estimados

## Como ativar isso de verdade

Vide `ROADMAP.md`. Estimativa Doc 1 (deep-research):
- MVP: 6 meses, 15-24 pessoas, R$ 4-8 mi
- Escala inicial: 12 meses, 25-40 pessoas, R$ 12-28 mi
- Horizonte 24m: 50-90 pessoas, R$ 35-90 mi
