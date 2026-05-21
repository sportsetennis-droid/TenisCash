# APEX Social — Pesquisa de viabilidade, custo e decisão de investimento

**Data:** 2026-05-21
**Solicitante:** Douglas Bernardo
**Pergunta original:** "Se eu fosse fazer uma rede social estilo Instagram para a Sports & Tennis para fazer as pessoas se direcionar a uma rede social onde crianças, jovens e adultos praticam esportes, sonham em ser atletas, relatam seus dias, seus treinos, incentivam, registram tudo, junto ao app que acumula alimentação, treino, dieta, pode registrar sua dieta, suplemento, tipo de treino, série e tudo isso já está disponível para vc postar junto com sua foto do seu dia, e ainda poder tbm compartilhar em outras redes."

Documento complementar a `02-social.md` (que define modelo de dados) e `ARCHITECTURE.md`.

---

## 1. Diagnóstico — o que você descreveu já é o APEX

A pergunta descreve, em outras palavras, a tese do APEX que já está no schema do banco. Não é projeto novo — é ativação da camada social que está faltando.

### Estado atual da fundação técnica (auditoria do codebase)

| Camada | Estado | Detalhe |
|---|---|---|
| Tracking esportivo (Activity, Route, Segment, Lap) | ✅ Pronto | 14 tabelas Prisma + rotas `/api/activities` + ingest service |
| Perfil de atleta | ✅ Pronto | `AthleteProfile` com username, goals, experience, privacy |
| Gamificação (badges, XP, cashback) | ✅ Pronto | `BadgeEarned.cashbackAwarded` integrado ao User.balance |
| Clubes + desafios | ✅ Schema pronto | `Club`, `ClubMembership`, `Challenge`, `ChallengeParticipation` |
| AI Coach | ✅ Pronto | `src/services/aiCoach.js` + rotas `/api/coach` |
| Live tracking | ✅ Schema pronto | `LiveTrackingSession` + shareToken |
| Plano de treino + workout | ✅ Schema pronto | `TrainingPlan`, `Workout`, `UserPlan` |
| Conta + cashback | ✅ Produção | `User.balance`, `Transaction`, `Sale` |
| Integrações Meta/IG/WhatsApp | ✅ Produção | `src/services/instagram.js`, `meta.js`, WhatsApp Cloud API |
| **Feed social (Post, Like, Comment, Follow)** | ❌ **ZERO** | Tabelas não existem, rotas não existem |
| **Storage cloud de mídia** | ⚠️ Parcial | multer instalado, mas sem S3/R2/CDN |
| **App mobile nativo** | ❌ ZERO | Apenas PWA do admin |
| **Push notifications** | ❌ ZERO | Sem FCM/APNs |
| **Moderação CSAM/NSFW** | ❌ ZERO | Crítico pra rede social |
| **Compliance ECA Digital (menores)** | ❌ ZERO | Lei 15.211/2025 vigente desde 03/2026 |

**Veredito:** ~60% da fundação está pronta. Faltam: camada social, storage cloud, app nativo, push, moderação, compliance.

---

## 2. Decisão estratégica

### Faz sentido construir? Sim, com 3 condições inegociáveis

#### Condição 1 — Idade mínima 16+ no dia 1

- **ECA Digital (Lei 15.211/2025)** em vigor desde 03/2026
- Menores de 16 só podem usar rede social com **conta vinculada a responsável legal verificado**
- Verificação de idade confiável é obrigatória
- Multa: até 10% do faturamento ou R$ 50M por infração
- **LGPD art. 14**: dados de menores exigem consentimento específico do responsável
- **ECA Digital art. 25**: proibido tratar dados de menores pra publicidade direcionada

**Decisão:** lançar 16+ apenas. Modo "responsável legal" pra 13-15 anos só num momento 2, com fluxo dedicado, KYC do responsável e tooling de moderação parental. **A pergunta original mencionou "crianças" — NÃO ENTRE NESSE MERCADO no MVP.**

#### Condição 2 — Não construir "rede social estilo Instagram"

Construa **rede social esportiva com loop de varejo**. Cada interação social precisa apontar de volta pra atividade/badge/cashback/loja. Cada post tem "ganhe badge X" e "use seu cashback aqui" embutido. Sem isso, vira clone de Strava e perde.

#### Condição 3 — Reconhecer onde está o moat

**Não tente vencer Strava no jogo deles.** Strava começou em 2009, levou 5 anos pra 10M usuários, recebeu Sequoia em 2014, atingiu valuation USD 1,5B em 2020. Você não tem capital nem tempo pra essa luta global.

**Moat real e único do APEX no Brasil:**

1. 4 lojas físicas em João Pessoa/PB (Bessa, Tambaú, Rainha da Borborema, Tambiá)
2. Cashback real conversível em produto na loja (TenisCash)
3. WhatsApp ativo com base de clientes
4. Comunidade local PB já em construção via Instagram @sportsetennis
5. Loop fechado: compra → atividade → badge → cashback → compra

Nenhum concorrente global (Strava, NRC, Adidas Running, Garmin Connect) tem canal de venda próprio. Esse loop é defensável e replicação por player global é zero.

---

## 3. "Você (Claude) faz tudo?" — escopo realista

| O que IA faz sozinha | O que precisa de humano |
|---|---|
| Schema Prisma (Post, Like, Comment, Follow, Notification, Block, Report) | Decisão de produto: feed cronológico vs algorítmico, regras de ranking |
| Migrations + seed data | Design visual UI/UX do app |
| Rotas backend (Node + Prisma + Express): feed, post, engage, follow, search, share | Build do app nativo (React Native ou Flutter) — devs |
| Integração com `Activity`, `BadgeEarned`, `User.balance` existentes | QA + beta com atletas reais |
| Cross-post Instagram/WhatsApp (Meta Graph já conectado) | Políticas de moderação humana complementar |
| Documento de arquitetura, custo, roadmap | Captação de signups, marketing de lançamento |
| Painel admin de moderação | Atendimento, denúncias, suporte |
| Wiring de Cloudflare R2 + Stream | Compras de equipamento (BLE, GPS) se for entrar em watch |
| Testes automatizados (Jest) | Compliance jurídico final (advogado especialista) |

**Resumo honesto:** posso entregar todo o backend social, schema, migrations, integrações e documentação. O app mobile precisa de **1 dev sênior** (RN ou Flutter) por 4-5 meses, ou agência. Design UI/UX precisa de designer. Compliance precisa de advogado.

---

## 4. Stack técnica recomendada

### Backend (já existente, expandir)
- Node.js + Express + Prisma + PostgreSQL (Railway) — **mantém**
- Adicionar: Redis (cache de feed + sessions) — só quando passar de 10k MAU
- Adicionar: BullMQ (workers de notificação, transcoding, moderação)

### Storage de mídia
- **Cloudflare R2** pra fotos (não cobra egress, vs S3 cobra USD 0,09/GB)
- **Cloudflare Stream** pra vídeo curto (60s max, padrão Strava/NRC)
- Custo: USD 1/1.000 min armazenados + USD 5/1.000 min entregues
- **Não usar S3 + CloudFront** pra MVP — egress da AWS sangra

### Mobile
- **Curto prazo (mês 1-6):** PWA existente (admin) NÃO serve — não tem BLE, HealthKit decente, GPS background. Construir **React Native** cross-platform.
  - Custo: USD 60-100k agência ou R$ 80-150k freelancer sênior BR (4-5 meses)
- **Médio prazo (mês 12+):** módulos nativos KMP (Kotlin Multiplatform) pra watch + BLE + HealthKit, conforme `ARCHITECTURE.md`
- **Flutter:** alternativa válida (cold-start 721ms vs RN 1.613ms, melhor bateria), mas ecossistema RN tem mais devs no Brasil

### Feed scaling — limites práticos
- Postgres direto + índices = aguenta tranquilo **até 50k MAU**
- Materialized views pra hot feed = aguenta 100k MAU
- Redis Streams (fanout-on-write) só >50k MAU
- Kafka só >500k MAU

### Push notifications
- FCM (Android) + APNs (iOS) — gratuito até volume gigante
- SNS/OneSignal pra orquestrar quando crescer

### Moderação CSAM/NSFW
- **Hive AI** — USD 3 por 1.000 imagens (~R$ 15/mil)
- **PhotoDNA Microsoft** — gratuito, requer aplicação
- **Thorn** — parceria via Hive
- Obrigatório reporte ao NCMEC (EUA) ou SaferNet (BR) quando detectado

---

## 5. Custo mensal de infra — 3 cenários

USD 1 = R$ 5,00. Margem ±30%.

| Item | MVP (1k MAU, 5k fotos/mês, 500 vídeos) | Crescimento (10k MAU, 50k fotos, 5k vídeos) | Escala (100k MAU) |
|---|---|---|---|
| Backend (Railway/Render) | R$ 100 | R$ 800 | R$ 4.500 |
| Postgres managed | R$ 80 | R$ 600 | R$ 3.500 |
| Redis | R$ 0 | R$ 150 | R$ 900 |
| Storage (R2/S3) | R$ 30 | R$ 250 | R$ 2.200 |
| CDN/Stream (Cloudflare) | R$ 80 | R$ 700 | R$ 6.500 |
| Transcoding vídeo | R$ 50 | R$ 400 | R$ 3.800 |
| Push (FCM/APNs) | R$ 0 | R$ 0 | R$ 300 |
| Moderação CSAM/NSFW (Hive) | R$ 80 | R$ 750 | R$ 7.000 |
| Observability (Sentry/Datadog) | R$ 50 | R$ 400 | R$ 2.500 |
| **TOTAL MENSAL** | **~R$ 470** | **~R$ 4.050** | **~R$ 31.200** |

---

## 6. Custo de build (one-time)

| Item | Custo |
|---|---|
| Backend social + schema + integrações (IA + revisão) | **R$ 0** (incluso no projeto) |
| Design UI/UX completo (Figma + design system) | **R$ 15-30k** |
| App mobile React Native cross-platform (4-5 meses, 1 sênior) | **R$ 80-150k** |
| Compliance jurídico (LGPD + ECA Digital + termos + privacy) | **R$ 5-10k** |
| QA + beta + ajustes | **R$ 10-15k** |
| Marketing de lançamento local PB | **R$ 10-20k** |
| **TOTAL BUILD INICIAL** | **R$ 120-225k** |

---

## 7. Cronograma — 5 a 6 meses do zero ao público

| Fase | Prazo | Entregável | Responsável |
|---|---|---|---|
| 1. Spec técnica + schema social | Semana 1 | Migration Prisma + ADRs | IA |
| 2. Backend social MVP | Semanas 2-5 | API: post, feed, like, comment, follow, notification | IA |
| 3. Storage Cloudflare R2 + Stream | Semana 6 | Upload + delivery funcionando | IA |
| 4. Design UI/UX | Semanas 3-6 (paralelo) | Figma completo do app | Designer |
| 5. App mobile React Native | Semanas 7-22 | iOS + Android com feed, post, perfil, atividade, badge, share | Dev mobile |
| 6. Compliance + termos + LGPD | Semanas 5-6 (paralelo) | Privacy, termos, fluxo de consent | Advogado |
| 7. Moderação Hive + admin | Semanas 18-19 | CSAM scan + painel admin | IA |
| 8. Beta fechado 200 atletas PB | Semanas 20-23 | Feedback + ajustes | Time + atletas |
| 9. Launch público | Semana 24 | Marketing local (lojas + IG + WhatsApp) | Marketing |

---

## 8. Riscos e mitigações

| Risco | Probabilidade | Mitigação |
|---|---|---|
| ECA Digital — multa por menor sem responsável | Alta se aceitar <16 | Idade mínima 16+ dia 1; verificação confiável |
| Crescimento social estagnar (efeito de rede falha) | Média | Lançar com clubes locais PB ativados via WhatsApp; co-criação com 200 atletas beta |
| Custo de infra explode com vídeo | Média | Cloudflare R2 (sem egress) + limite 60s/vídeo |
| CSAM/conteúdo abusivo | Inevitável | Hive AI + denúncia + moderação humana paga |
| Concorrência Strava/NRC | Baixa no nicho local | Diferencial = loja+cashback+comunidade, não tech |
| Build estourar prazo/orçamento | Alta com agência ruim | Freelance sênior BR via indicação; milestones quinzenais; contrato com penalidade |
| App rejeitado em store (Apple/Google) | Média | Compliance jurídico antes de submeter; revisar guidelines |
| LGPD — vazamento de dados de atividade GPS | Baixa | Criptografia at-rest; opt-in granular; audit trail |
| Dependência de Meta API quebrar (IG/WhatsApp) | Média | Fallback de share manual via deep-link nativo |

---

## 9. KPIs de sucesso (12 meses pós-launch)

| KPI | Alvo ano 1 | Benchmark |
|---|---|---|
| Retenção D30 | 35% | Strava ~40% (mercado maduro) |
| **% atletas APEX → comprador em loja física** | **25%** | **KPI único — ninguém mais tem** |
| Ticket médio loja: usuário APEX vs não-APEX | +30% | — |
| Receita TenisCash Premium | R$ 600k/ano (5k assinantes × R$ 9,90/mês × 12) | — |
| CAC payback | <6 meses | Via WhatsApp + lojas (canais zerados de custo) |
| NPS atletas | >50 | Strava ~45 |
| DAU/MAU ratio | >25% | Strava ~30% |
| % atividades com post social | >40% | Strava ~50% |

---

## 10. Break-even

5.000 atletas pagam APEX Premium a R$ 9,90/mês:
- Receita: R$ 49.500/mês
- Custo infra (cenário Crescimento, 10k MAU): R$ 4.050/mês
- **Margem operacional infra: 92%**

Cobre infra até 50k MAU **e** gera R$ 45k/mês de margem antes de pessoal/marketing.

---

## 11. Decisão pendente — o que falta confirmar antes de start

1. **Orçamento de build disponível** — R$ 120-225k é viável?
2. **Modelo de contratação mobile** — freelance BR vs agência cross-platform?
3. **Idade mínima** — 16+ apenas (recomendado) vs criar fluxo de responsável legal pra 13-15 (complexo, custo +R$ 20k)?
4. **Modelo de monetização do APEX Premium** — R$ 9,90/mês fixo? Cashback extra? Sem premium e tudo grátis com upsell na loja?
5. **Estratégia de launch** — soft launch beta fechado PB (200 atletas) → expansão regional → nacional? Ou direto nacional?

---

## Referências

- Strava Wikipedia: <https://en.wikipedia.org/wiki/Strava>
- Strava Business Breakdown — Contrary Research: <https://research.contrary.com/company/strava>
- Strava System Design: <https://www.systemdesignhandbook.com/guides/design-strava/>
- Cost to Build Fitness App — Topflight: <https://topflightapps.com/ideas/fitness-app-development-cost/>
- React Native vs Flutter 2025 — Blott: <https://www.blott.com/blog/post/react-native-vs-flutter-which-saves-more-development-time>
- Mux vs S3 pricing: <https://www.mux.com/blog/mux-is-cheaper-than-s3>
- Cloudinary Pricing: <https://cloudinary.com/pricing>
- Media Storage Comparison 2026: <https://leanopstech.com/blog/media-storage-serverless-cost-comparison-2026/>
- CloudFront Pricing 2026: <https://go-cloud.io/amazon-cloudfront-pricing/>
- Postgres as Cache/Queue: <https://www.freecodecamp.org/news/how-to-use-postgresql-as-a-cache-queue-and-search-engine/>
- Hive CSAM Detection API: <https://thehive.ai/apis/csam-detection>
- Hive Pricing: <https://thehive.ai/pricing>
- ECA Digital — Agência Brasil: <https://agenciabrasil.ebc.com.br/politica/noticia/2026-03/eca-digital-comeca-valer-nesta-terca-confira-principais-pontos>
- LGPD Crianças — Serpro: <https://www.serpro.gov.br/lgpd/noticias/criancas-adolescentes-lgpd-lei-geral-protecao-de-dados-pessoais>
- Nike Run Club Community — social.plus: <https://www.social.plus/blog/community-story-nike-run-club>

---

**Documento gerado pela Central IA Sports & Tennis a pedido de Douglas Bernardo.**
Complementa: `02-social.md` (modelo de dados), `ARCHITECTURE.md` (arquitetura), `ROADMAP.md` (fases).
