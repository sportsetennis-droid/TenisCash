# Sistema de Mensagens TenisCash — Documento Completo

> Documento único consolidado: produto + desenho + arquitetura + pesquisa.
> Pronto pra copiar, apresentar a pesquisadores, consultorias, time técnico.

---

## SUMÁRIO

1. Visão geral
2. Contexto e motivação
3. Filosofia do produto
4. Conceito proposto
5. Mapa de navegação
6. Telas detalhadas
7. Banco de dados
8. Fluxos completos
9. Job diário e notificações
10. Mídia e storage
11. Permissões
12. Integração com o resto do TenisCash
13. Diferenças vs WhatsApp
14. Plano de implementação
15. Perguntas em aberto pra pesquisa
16. Riscos identificados
17. Tecnologias
18. Status

---

## 1. VISÃO GERAL

Uma plataforma de comunicação dentro do app TenisCash, construída para substituir o uso de WhatsApp no relacionamento entre a Sports & Tennis (lojas, vendedores), os clientes e os clientes entre si.

O sistema tem **dois espaços diferentes** que coexistem na mesma tela inicial:

- **Conversas** — onde mensagens entre duas pessoas vivem e ficam guardadas
- **Como está o dia hoje?** — onde cada pessoa compartilha seu dia em texto, foto ou áudio. Tudo o que é postado aqui some à meia-noite

Esses dois espaços nunca se misturam. **Conversa é memória, timeline é presente.**

---

## 2. CONTEXTO E MOTIVAÇÃO

Sports & Tennis é uma rede varejista esportiva em João Pessoa/PB com:
- 4 lojas físicas (Bessa, Tambaú, Rainha da Borborema, Tambiá)
- 1 ecommerce Nuvemshop
- Programa de loyalty TenisCash (cashback)
- App esportivo APEX (rastreamento de atividade física + comunidade) — em construção

A empresa tentou implementar atendimento via WhatsApp Business / Cloud API e enfrentou bloqueios estruturais:
- Dependência da Meta como intermediário
- Restrições para empresas SMB sem Business Solution Provider
- Perda de histórico ao tentar migrar entre planos
- Ausência de controle total dos dados de cliente

A decisão estratégica foi construir um sistema próprio de mensagens dentro do TenisCash — controle total dos dados, sem dependência de terceiros, e principalmente: liberdade pra desenhar uma experiência que **WhatsApp não tem**.

---

## 3. FILOSOFIA DO PRODUTO

> WhatsApp resolveu "como mandar mensagem". Mas o ato de se comunicar moderno tá saturado de pressão social, ruído de grupo, métricas de validação pública e ansiedade.
>
> O que humanos querem em 2026 não é mais "outro app de chat". É um espaço pra existir sem performar.

Princípios:
- **Não copiar WhatsApp.** Fazer melhor pelo contexto do TenisCash.
- **Reduzir ruído.** Acabar com grupo lotado, like performático, scroll infinito.
- **Presente importa.** O hoje vale mais que o passado.
- **Pessoa, não público.** Quem se importa procura. Sem métrica de validação.

A hipótese é que a próxima geração de comunicação social terá duas características que apps atuais não combinam bem:

1. **Memória individual preservada** (relações 1-a-1 que persistem com peso)
2. **Memória social efêmera** (presença coletiva sem culto à imagem nem ao histórico)

---

## 4. CONCEITO PROPOSTO

### 4.1 Conversas (memória individual)

Mensagens diretas entre pessoas, ou entre pessoa e loja. Persistem indefinidamente no banco (auditoria 100%).

- Toda mensagem é importante (sem níveis de prioridade)
- Sistema nunca deleta
- Usuário tem agência sobre o que ele vê
- Apagar pros dois é permitido apenas dentro de 2 horas — depois disso, cada um só apaga pro próprio lado
- Lojas conversam com clientes pelos mesmos canais que pessoas conversam entre si (sem distinção visual brutal)

### 4.2 Como está o dia hoje? (memória coletiva efêmera)

Espaço de timeline com dois subtipos:

- **Pública**: aberta a todos os usuários da plataforma
- **Privadas**: ilimitadas. Cada usuário cria quantas quiser; convida quem quiser por telefone, nome cadastrado ou username

Regras fundamentais:
- Posts somem para todos às 00:00 do dia seguinte (zero arquivo público)
- Sem like, sem comentário, sem reaction visual
- Reação só pode acontecer numa forma: abrir Conversas e mandar mensagem direta
- Conteúdo: texto, foto, áudio
- Editar e apagar livre até 00:00

Consequência psicológica esperada:
- Quem posta não é avaliado em público (sem métricas de validação)
- Quem se importa investe esforço deliberado (mandar DM)
- Acaba a economia de curtidas performáticas
- Vira diário coletivo da plataforma

---

## 5. MAPA DE NAVEGAÇÃO

```
                            ┌──────────────────┐
                            │   LOGIN          │
                            │   (telefone+PIN) │
                            └────────┬─────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │   HOME do TC     │
                            │  (dashboard)     │
                            └────────┬─────────┘
                                     │
                                     ▼
                ┌──────────────────────────────────────┐
                │   MENSAGENS  (header com 2 abas)     │
                │                                       │
                │   [💬 Conversas]  [📓 Hoje]          │
                └────────────┬─────────────┬───────────┘
                             │             │
                ┌────────────┘             └─────────────┐
                ▼                                         ▼
   ┌──────────────────────┐              ┌──────────────────────────┐
   │  LISTA CONVERSAS     │              │  TIMELINES (sub-abas)    │
   │                       │              │                           │
   │  • Ana   • 1 nova    │              │  [🌍 Geral]              │
   │  • Loja Bessa        │              │  [👨‍👩‍👧 Família •]         │
   │  • João Silva        │              │  [🏃 Time Bessa]         │
   │                       │              │  [➕ criar nova]          │
   └────────┬─────────────┘              └────────────┬──────────────┘
            │                                          │
            ▼                                          ▼
   ┌──────────────────────┐              ┌──────────────────────────┐
   │  THREAD (conversa)   │              │  FEED da TIMELINE        │
   │                       │              │                           │
   │  bolha bolha bolha    │              │  Post Carlos · 09:14     │
   │  bolha bolha bolha    │              │  Post Ana · 14:30        │
   │  ────────────────     │              │  Post Você · 18:00       │
   │  [texto] 📷 🎤        │              │  ─────────────────       │
   └──────────────────────┘              │  ✍️ [composer]            │
                                          │  ⏰ some às 00:00         │
                                          └──────────────────────────┘
```

---

## 6. TELAS DETALHADAS

### 6.1 Lista de Conversas

```
┌────────────────────────────────────────────────────────────────┐
│  TenisCash                                              [☰]   │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [💬 Conversas (3)]   [📓 Como está o dia hoje? (2)]          │
│   ▔▔▔▔▔▔▔▔▔▔▔▔                                                 │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  🟦 Ana Souza                                  ontem 14:30│ │
│  │     "Bora correr sábado?"                       🔴 1 nova │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  🏪 Sports & Tennis Bessa                      hoje 09:00 │ │
│  │     "Sua reserva expira amanhã"                 🔴 1 nova │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  🟦 João Silva (vendedor)                      hoje 12:14 │ │
│  │     "Reservei o tênis na sua medida"            🔴 1 nova │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  🟦 Mãe                                        hoje 11:30 │ │
│  │     "Bolo no forno, vem aqui depois"                      │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│                                                  [+ Nova msg]  │
└────────────────────────────────────────────────────────────────┘
```

### 6.2 Thread de Conversa

```
┌────────────────────────────────────────────────────────────────┐
│  ← Voltar       🟦 Ana Souza                          [⋮]      │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│     ┌─────────────────────────────┐                            │
│     │ Oi! Tudo bem?                │                            │
│     │                        13:42 │                            │
│     └─────────────────────────────┘                            │
│                                                                 │
│                            ┌─────────────────────────────┐    │
│                            │ Tudo, e você?               │    │
│                            │                       13:43 │    │
│                            └─────────────────────────────┘    │
│                                                                 │
│     ┌─────────────────────────────┐                            │
│     │ Bora correr sábado?         │                            │
│     │ Saída 06:00 do Cabo Branco  │                            │
│     │                        14:30 │                            │
│     └─────────────────────────────┘                            │
│                                                                 │
│     ┌─────────────────────────────┐                            │
│     │ [🎤 áudio 0:42 ▶]            │                            │
│     │                        14:31 │                            │
│     └─────────────────────────────┘                            │
│                                                                 │
│                            ┌─────────────────────────────┐    │
│                            │ Topo! Tô lá ✓               │    │
│                            │                  14:45 ✓✓ 🔵│    │
│                            └─────────────────────────────┘    │
│                                                                 │
├────────────────────────────────────────────────────────────────┤
│  [✍️ Escreva...                                     📷 🎤 ➤]   │
└────────────────────────────────────────────────────────────────┘

LEGENDA:
  bolha à esquerda = quem recebeu
  bolha à direita  = quem mandou
  ✓ = enviada     ✓✓ = entregue     ✓✓ azul = lida
```

### 6.3 Long-press numa mensagem

```
┌────────────────────────────────────────────────────────────────┐
│  ← Voltar       🟦 Ana Souza                          [⋮]      │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│     ┌─────────────────────────────┐                            │
│     │ Bora correr sábado?         │  ◄─ long-press             │
│     │                        14:30 │     selecionada            │
│     └─────────────────────────────┘                            │
│                                                                 │
│            ┌─────────────────────────┐                         │
│            │  ✏️  Editar              │                         │
│            │  🗑️  Apagar pra mim      │                         │
│            │  💬  Responder           │                         │
│            └─────────────────────────┘                         │
│                                                                 │
│              ┌─────────────────────────────┐                   │
│  (própria)   │ Tô lá! ✓                    │  ◄─ long-press    │
│              │                        14:45 │                   │
│              └─────────────────────────────┘                   │
│                                                                 │
│            ┌─────────────────────────────┐                     │
│            │  ✏️  Editar                  │                     │
│            │  🗑️  Apagar pra mim          │                     │
│            │  🗑️🗑️ Apagar pros dois        │ ← só se < 2h       │
│            └──────────────────────────────┘                     │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 6.4 Timeline "Como está o dia hoje?"

```
┌────────────────────────────────────────────────────────────────┐
│  TenisCash                                              [☰]   │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [💬 Conversas]   [📓 Como está o dia hoje? (2)]              │
│                    ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔                   │
│                                                                 │
│  Quinta · 22 de maio                                            │
│                                                                 │
│  ┌──────┬──────────┬───────────────┬──────┐                    │
│  │ 🌍 Geral │ Família 🔵 │ Time Bessa │  + criar  │              │
│  │  ▔▔▔▔   │            │              │              │          │
│  └──────┴──────────┴───────────────┴──────┘                    │
│                                                                 │
│  ╔═══════════════════════════════════════════════════════════╗ │
│  ║  Carlos Mendes · 09:14                              [···] ║ │
│  ║  ────────────                                              ║ │
│  ║  Treino de hoje foi pesado. Mas terminei a corrida de 5km ║ │
│  ║  que tava devendo há semanas. Obrigado a Deus por mais um ║ │
│  ║  dia.                                                      ║ │
│  ║                                                            ║ │
│  ║  📷 [foto da corrida no Cabo Branco]                      ║ │
│  ╚═══════════════════════════════════════════════════════════╝ │
│                                                                 │
│  ╔═══════════════════════════════════════════════════════════╗ │
│  ║  Ana Souza · 14:30                                         ║ │
│  ║  ────────────                                              ║ │
│  ║  Bessa cheia hoje. Bom sinal de fim de semana chegando.   ║ │
│  ╚═══════════════════════════════════════════════════════════╝ │
│                                                                 │
│  ╔═══════════════════════════════════════════════════════════╗ │
│  ║  Você · 18:00                            [✏️ editar] [🗑️]  ║ │
│  ║  ────────────                                              ║ │
│  ║  [🎤 áudio 0:23 ▶]                                         ║ │
│  ╚═══════════════════════════════════════════════════════════╝ │
│                                                                 │
├────────────────────────────────────────────────────────────────┤
│  ✍️ O que você quer compartilhar do seu dia?                   │
│                                                       📷 🎤 ➤  │
├────────────────────────────────────────────────────────────────┤
│  ⏰ Tudo aqui some às 00:00                                     │
└────────────────────────────────────────────────────────────────┘

OBSERVE:
  • Sem botão de like
  • Sem campo de comentário
  • Sem contador de visualizações
  • Edit/delete só nos seus próprios posts
```

### 6.5 Criar Timeline Privada

```
┌────────────────────────────────────────────────────────────────┐
│  ← Voltar       Criar nova timeline                            │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  NOME DA TIMELINE                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Família                                                  │ │
│  └──────────────────────────────────────────────────────────┘ │
│  Como você quer chamar este círculo                            │
│                                                                 │
│  ────────────────────────────────────────────────────────       │
│                                                                 │
│  CONVIDAR PESSOAS                                               │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  🔍 Buscar por nome, telefone ou @username...             │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Resultados:                                                    │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │  👤  Carlos Mendes      @carlos      83 9999-1234   [+] │ │
│   │  👤  Ana Souza          @ana_sz       83 9888-5678   [+] │ │
│   └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  Pessoas adicionadas (3):                                       │
│   ╔══════════════════════════════════════════════════════════╗ │
│   ║  • Mãe (Tereza)             ✕ remover                     ║ │
│   ║  • Pai (José)               ✕ remover                     ║ │
│   ║  • Irmã (Patrícia)          ✕ remover                     ║ │
│   ╚══════════════════════════════════════════════════════════╝ │
│                                                                 │
│   [ Cancelar ]                            [ Criar timeline ]    │
└────────────────────────────────────────────────────────────────┘
```

---

## 7. BANCO DE DADOS

### 7.1 Diagrama de tabelas

```
                ┌────────────────────────┐
                │       User             │
                │  ────                  │
                │  id (PK)               │
                │  phone (unique)        │
                │  name                  │
                │  username (unique)     │  ← novo campo
                │  role                  │
                └─────┬──────────┬────┬──┘
                      │          │    │
       ┌──────────────┘          │    │
       │ creator                  │    │ author
       ▼                           │    ▼
┌──────────────┐                  │  ┌──────────────────┐
│  Timeline    │                  │  │  TimelinePost     │
│  ────        │                  │  │  ────             │
│  id (PK)     │◄─────────────────┼──┤  id (PK)          │
│  name        │   1:N            │  │  timelineId (FK)  │
│  isPublic    │                  │  │  authorId (FK)    │
│  createdById │                  │  │  content          │
│  deletedAt   │                  │  │  mediaType        │
└──────┬───────┘                  │  │  mediaUrl         │
       │                          │  │  editedAt         │
       │ 1:N                      │  │  deletedAt        │
       ▼                          │  │  expiredAt   ←─── cron 00:00
┌──────────────────┐              │  │  createdAt        │
│ TimelineMember   │              │  └───────────────────┘
│  ────            │              │
│  id (PK)         │              │
│  timelineId (FK) │              │
│  userId (FK)─────┼──────────────┘
│  lastReadAt      │  N:M
│  joinedAt        │  (User pode estar em várias)
│  leftAt          │  (Timeline tem vários membros)
└──────────────────┘


               ┌──────────────────────┐
               │   Conversation       │
               │   ────                │
       ┌──────►│   id (PK)             │◄──────┐
       │       │   type (dm | loja)    │       │
       │       │   userAId (FK)        │       │
       │       │   userBId (FK)        │       │
       │       │   storeId (FK)        │       │
       │       │   clientUserId (FK)   │       │
       │       │   lastMessageAt       │       │
       │       └──────────┬───────────┘        │
       │                  │ 1:N                 │
       │                  ▼                     │
   ┌───┴────┐    ┌──────────────────────────┐  │
   │ User   │    │   ChatMessage            │  │
   │ (já    │    │   ────                    │  │
   │ existe)│    │   id (PK)                 │  │
   └───┬────┘    │   conversationId (FK)     │  │
       │         │   senderId (FK)───────────┼──┘
       │         │   senderType (user|store) │
       │         │   content                  │
       │         │   mediaType / mediaUrl     │
       │         │   productCardId (FK)─────────► Product (já existe)
       │         │   readAt                   │
       │         │   editedAt                 │
       │         │   deletedForSenderAt       │
       │         │   deletedForRecipientAt    │
       │         │   deletedForBothAt         │
       │         │   createdAt                │
       │         └────────────────────────────┘
       │                                       
   ┌───┴────┐
   │ Store  │ ◄─── pra conversas com loja
   │ (já    │
   │ existe)│
   └────────┘
```

### 7.2 Schema Prisma completo

```prisma
model Timeline {
  id            String   @id @default(cuid())
  name          String                              // "Geral", "Família", "Time Bessa"
  isPublic      Boolean  @default(false)            // true só pra UMA timeline global
  createdById   String?  // FK User — null pra timeline pública do sistema
  createdAt     DateTime @default(now())
  deletedAt     DateTime?

  createdBy     User?                @relation("timelinesCreated", fields: [createdById], references: [id])
  members       TimelineMember[]
  posts         TimelinePost[]

  @@index([isPublic])
  @@index([createdById])
}

model TimelineMember {
  id            String   @id @default(cuid())
  timelineId    String
  userId        String
  joinedAt      DateTime @default(now())
  lastReadAt    DateTime @default(now())            // pra badge "não lido"
  leftAt        DateTime?
  role          String   @default("member")         // "creator" | "member"

  timeline      Timeline @relation(fields: [timelineId], references: [id])
  user          User     @relation("timelineMemberships", fields: [userId], references: [id])

  @@unique([timelineId, userId])
  @@index([userId, leftAt])
}

model TimelinePost {
  id            String   @id @default(cuid())
  timelineId    String
  authorId      String
  content       String?                             // texto (pode ser null se for só mídia)
  mediaType     String?                             // "photo" | "audio" | null
  mediaUrl      String?                             // URL no storage
  mediaDuration Int?                                // duração em segundos (áudio)
  createdAt     DateTime @default(now())
  editedAt      DateTime?
  deletedAt     DateTime?                           // soft delete pelo autor antes da meia-noite
  expiredAt     DateTime?                           // setado pelo cron 00:00

  timeline      Timeline @relation(fields: [timelineId], references: [id])
  author        User     @relation("timelinePostsAuthored", fields: [authorId], references: [id])

  @@index([timelineId, createdAt])
  @@index([expiredAt])
}

model Conversation {
  id            String   @id @default(cuid())
  type          String                              // "dm" | "loja"
  userAId       String?
  userBId       String?
  storeId       String?
  clientUserId  String?
  lastMessageAt DateTime @default(now())
  createdAt     DateTime @default(now())

  userA         User?    @relation("conversationsAsUserA", fields: [userAId], references: [id])
  userB         User?    @relation("conversationsAsUserB", fields: [userBId], references: [id])
  store         Store?   @relation("conversationsForStore", fields: [storeId], references: [id])
  clientUser    User?    @relation("conversationsAsClient", fields: [clientUserId], references: [id])
  messages      ChatMessage[]

  @@unique([userAId, userBId])
  @@unique([storeId, clientUserId])
  @@index([lastMessageAt])
}

model ChatMessage {
  id                       String   @id @default(cuid())
  conversationId           String
  senderId                 String
  senderType               String   @default("user") // "user" | "store" | "system"
  content                  String?
  mediaType                String?
  mediaUrl                 String?
  mediaDuration            Int?
  productCardId            String?                  // FK Product (recurso futuro)
  readAt                   DateTime?
  editedAt                 DateTime?
  deletedForSenderAt       DateTime?
  deletedForRecipientAt    DateTime?
  deletedForBothAt         DateTime?                // quando apaga "pros dois" dentro de 2h
  createdAt                DateTime @default(now())

  conversation             Conversation @relation(fields: [conversationId], references: [id])
  sender                   User         @relation("chatMessagesSent", fields: [senderId], references: [id])
  productCard              Product?     @relation("chatMessageProducts", fields: [productCardId], references: [id])

  @@index([conversationId, createdAt])
  @@index([senderId, createdAt])
  @@index([readAt])
}
```

### 7.3 Regras de integridade

- **Timeline pública** é única no sistema: row com `isPublic = true`. Todos os Users são membros implícitos — não há row em TimelineMember pra ela.
- **Conversation DM**: query garante `userAId < userBId` pra evitar dupla criação
- **Conversation Loja**: par único `(storeId, clientUserId)`
- **ChatMessage nunca é deletada do banco.** Apenas marca timestamps de soft-delete
- **TimelinePost** após `expiredAt` ser setado: invisível na UI, mas continua no banco

---

## 8. FLUXOS COMPLETOS

### 8.1 Enviar mensagem em conversa

```
   USUÁRIO                  FRONTEND                BACKEND               BANCO
   ───────                  ────────                ───────              ─────

   digita texto                 │                       │                    │
   clica ➤      ──────────────► │                       │                    │
                                │                       │                    │
                                │ POST                  │                    │
                                │ /conversations/X/     │                    │
                                │   messages            │                    │
                                │ { content }           │                    │
                                │ ─────────────────────►│                    │
                                │                       │                    │
                                │                       │ valida auth        │
                                │                       │ valida X é minha   │
                                │                       │                    │
                                │                       │ INSERT ChatMessage │
                                │                       │ ──────────────────►│
                                │                       │                    │
                                │                       │ UPDATE Conv.       │
                                │                       │ lastMessageAt      │
                                │                       │ ──────────────────►│
                                │                       │                    │
                                │ ◄─────────────────────│ { msgId, ts }      │
                                │ atualiza UI           │                    │
                                │ (otimista)            │                    │
                                ▼                       │                    │
                          bolha aparece                  │                    │
                          com ✓                          │                    │
                                                         │                    │
                                                         ▼                    │
                                                   PUSH p/ destinatário        │
                                                   (via polling no             │
                                                    /notifications/summary)    │
```

### 8.2 Postar na timeline

```
   ┌─────────────────────────────────────────────────────────────┐
   │  1. Usuário escreve no composer da timeline "Família"        │
   │     "Hoje foi corrida de 5km, terminei!"                     │
   │     + clica em 📷 e seleciona foto                            │
   └────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  2. Frontend faz UPLOAD da foto primeiro                     │
   │     POST /api/messages/upload (multipart)                    │
   │     ◄─── recebe { url, mediaType: 'photo' }                  │
   └────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  3. Frontend manda o POST com tudo                           │
   │     POST /api/messages/timelines/<familia-id>/posts          │
   │     { content: "Hoje foi corrida...",                        │
   │       mediaType: "photo",                                    │
   │       mediaUrl: "https://cloudinary.com/..." }               │
   └────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  4. Backend valida:                                          │
   │     • Usuário é membro da timeline "Família"? ✓              │
   │     • Não está vetado / spam rate ok? ✓                      │
   │  Cria row em TimelinePost com createdAt = now()              │
   └────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  5. Backend retorna { postId, post } pra frontend            │
   │     Frontend insere o card no topo da timeline               │
   └─────────────────────────────────────────────────────────────┘

   ──── enquanto isso, em outro device ────

   ┌─────────────────────────────────────────────────────────────┐
   │  Outro membro da família tem o app aberto                    │
   │  A cada 15s, o front chama /notifications/summary            │
   │  ────► recebe { unreadTimelines: [{familia, 1}] }            │
   │  ────► aba "Família" ganha bolinha azul ●                    │
   └─────────────────────────────────────────────────────────────┘
```

### 8.3 Apagar mensagem em conversa

```
   Cenário A: mensagem enviada HÁ MENOS de 2 horas
   ─────────────────────────────────────────────────

   long-press na mensagem que você enviou
              │
              ▼
   ┌─────────────────────────────────┐
   │  ✏️  Editar                       │
   │  🗑️  Apagar pra mim               │
   │  🗑️🗑️ Apagar pros dois            │  ◄── disponível
   └─────────────────────────────────┘
              │
              │ clica "pros dois"
              ▼
   DELETE /messages/<msgId>
   { scope: 'both' }
              │
              ▼
   Backend valida:
   • É minha mensagem? ✓
   • createdAt > NOW() - 2h? ✓
   ► UPDATE deletedForBothAt = NOW()
              │
              ▼
   Mensagem some pros 2 lados


   Cenário B: mensagem enviada HÁ MAIS de 2 horas
   ───────────────────────────────────────────────

   long-press
        │
        ▼
   ┌─────────────────────────────────┐
   │  ✏️  Editar                       │
   │  🗑️  Apagar pra mim               │
   │  🗑️🗑️ Apagar pros dois            │  ◄── desabilitada
   │       (passaram 2h, só pode      │       (cinza)
   │        apagar pro seu lado)      │
   └─────────────────────────────────┘
        │
        │ clica "pra mim"
        ▼
   DELETE /messages/<msgId>
   { scope: 'me' }
        │
        ▼
   ► UPDATE deletedForSenderAt = NOW()
        │
        ▼
   Mensagem some só pra mim
   (o outro continua vendo)


   ─── EM TODOS OS CASOS: no banco a row permanece ───
       Soft-delete por timestamp. Auditoria 100%.
```

### 8.4 Criar timeline privada e convidar

```
   1. Usuário clica "+ Criar nova"
            │
            ▼
   2. Modal abre, digita nome "Família"
            │
            ▼
   3. Busca pessoa por nome/telefone/@username
            │
            │ POST /api/messages/people/search?q=carlos
            ▼
   4. Backend busca em User onde:
      • name ILIKE '%carlos%'
      • OR phone = '83...'
      • OR username = 'carlos'
            │
            ▼
   5. Retorna lista de usuários
            │
            ▼
   6. Usuário clica [+] em cada pessoa pra adicionar
      → vira chip embaixo
            │
            ▼
   7. Clica "Criar timeline"
            │
            │ POST /api/messages/timelines
            │ { name: "Família",
            │   inviteUserIds: [u1, u2, u3] }
            ▼
   8. Backend:
      • Cria row em Timeline (isPublic=false, createdById=me)
      • Cria N rows em TimelineMember (creator + convidados)
            │
            ▼
   9. Cada convidado recebe notificação interna
      "Carlos te incluiu na timeline 'Família'"
            │
            ▼
  10. Convidado abre o app, vê a nova timeline na lista
      Pode postar livremente nela
```

---

## 9. JOB DIÁRIO E NOTIFICAÇÕES

### 9.1 Reset 00:00

```
                           00:00 (timezone America/Fortaleza)
                                  │
                                  ▼
                       ┌─────────────────────────────────────┐
                       │  node-cron dispara                    │
                       │                                       │
                       │  cron.schedule('0 0 * * *', job, {    │
                       │    timezone: 'America/Fortaleza'      │
                       │  });                                  │
                       │                                       │
                       │  ⚠️ ATENÇÃO: Railway roda em UTC.     │
                       │  Sem timezone explícito no            │
                       │  node-cron, '0 0 * * *' dispara às    │
                       │  21:00 horário de PB.                 │
                       │  Paraíba é UTC-3 FIXO (sem DST) →     │
                       │  usar America/Fortaleza.              │
                       └────────────┬─────────────────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────────────────┐
                       │  Query no PostgreSQL                  │
                       │                                       │
                       │  UPDATE "TimelinePost"                │
                       │  SET "expiredAt" = NOW()              │
                       │  WHERE "expiredAt" IS NULL            │
                       │    AND "createdAt" <                  │
                       │      DATE_TRUNC('day',                │
                       │        NOW() AT TIME ZONE             │
                       │        'America/Fortaleza');          │
                       └────────────┬─────────────────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────────────────┐
                       │  Posts agora têm expiredAt ≠ null    │
                       │  Continuam no banco                   │
                       │  Mas a UI filtra ─────────►           │
                       │  WHERE expiredAt IS NULL              │
                       │  → não aparecem mais                  │
                       │                                       │
                       │  Filtro de UI também respeita TZ:     │
                       │  AND "createdAt" >=                   │
                       │    DATE_TRUNC('day',                  │
                       │      NOW() AT TIME ZONE               │
                       │      'America/Fortaleza')             │
                       └─────────────────────────────────────┘


       Visão temporal:

       quinta 21:00         quinta 23:59           sexta 00:00          sexta 09:00
            │                     │                      │                    │
            ▼                     ▼                      ▼                    ▼
       posta na timeline     última chance de         CRON RODA          abre o app
       "Família"             editar/apagar           ─────────►          vê timeline VAZIA
            │                                        expiredAt           começa novo dia
            ▼                                        seta em todos
                                                     os posts de ontem


   Importante: se o cron falhar/atrasar, a UI ainda filtra por
              createdAt >= 00:00 hoje. Garante visual correto.
```

### 9.2 Notificações in-app

```
                 [Front polla a cada 15s]
                          │
                          ▼
              GET /notifications/summary
                          │
                          ▼
   ┌──────────────────────────────────────────────────────┐
   │  Backend conta:                                        │
   │                                                        │
   │  unreadConversations =                                 │
   │    SELECT COUNT(DISTINCT conversationId)               │
   │    FROM ChatMessage                                    │
   │    WHERE (sou destinatário)                            │
   │      AND readAt IS NULL                                │
   │      AND deletedForRecipientAt IS NULL                 │
   │                                                        │
   │  unreadTimelines =                                     │
   │    pra cada Timeline onde eu sou Member,               │
   │    conta posts em que createdAt > meu lastReadAt       │
   │                                                        │
   └──────────────────┬───────────────────────────────────┘
                      │
                      ▼
   Retorna:
   {
     totalUnread: 5,
     unreadConversations: 3,
     unreadTimelines: [
       { timelineId: 'fam', name: 'Família', unreadCount: 2 }
     ]
   }
                      │
                      ▼
   Front atualiza:
   ┌──────────────────────────────────────────────────────┐
   │  [💬 Conversas (3)]   [📓 Hoje (2)]                  │
   │                                                        │
   │  Subnavegação:                                         │
   │  [🌍 Geral]  [Família •]  [Time Bessa]                │
   │              ↑                                          │
   │              bolinha azul porque tem post não lido     │
   └──────────────────────────────────────────────────────┘
```

**Sem push do sistema operacional.** Tudo dentro do app. Polling a cada 15s. WebSocket pode substituir em fase futura.

---

## 10. MÍDIA E STORAGE

### 10.1 Pipeline de upload

```
   USER                FRONT                  BACKEND                CLOUDINARY
   ────                ─────                  ───────                ──────────

   tira foto             │                       │                       │
   ou seleciona ────────►│                       │                       │
   da galeria            │                       │                       │
                         │ POST /upload          │                       │
                         │ multipart             │                       │
                         │ file=<binary>         │                       │
                         │ ─────────────────────►│                       │
                         │                       │                       │
                         │                       │ valida tamanho        │
                         │                       │ comprime se foto      │
                         │                       │ (sharp: max 1080p)    │
                         │                       │                       │
                         │                       │ upload signed         │
                         │                       │ ─────────────────────►│
                         │                       │                       │
                         │                       │ ◄─────────────────────│
                         │                       │  { url, publicId }    │
                         │                       │                       │
                         │ ◄─────────────────────│                       │
                         │  { url, mediaType }   │                       │
                         │                       │                       │
                         │ usa essa URL no       │                       │
                         │ POST do post/msg      │                       │
```

### 10.2 Lifecycle

- **Mídia de Conversa**: persiste pra sempre (auditoria)
- **Mídia de TimelinePost**: 30 dias após `expiredAt`, job semanal opcional remove arquivo
- **Recomendação:** Cloudinary (free tier cobre milhares de uploads; CDN global; lifecycle automático)

### 10.3 Limites

- Foto: max 1080p, JPEG quality 80, max 500KB após compressão
- Áudio: codec opus, max 60s

---

## 11. PERMISSÕES

```
                                ┌────────┬────────┬────────┬────────┐
                                │Cliente │Vendedor│ Loja   │ Admin  │
                                │        │        │(sistema)│        │
   ┌────────────────────────────┼────────┼────────┼────────┼────────┤
   │ Mandar DM pra outra pessoa │   ✓    │   ✓    │   —    │   ✓    │
   │ Mandar DM em nome da loja  │   —    │   ✓    │   ✓    │   ✓    │
   │ Receber DM da loja         │   ✓    │   —    │   —    │   —    │
   │ Postar timeline pública    │   ✓    │   ✓    │   ✓    │   ✓    │
   │ Postar timeline privada    │   ✓    │   ✓    │   —    │   ✓    │
   │ Criar timeline privada     │   ✓    │   ✓    │   —    │   ✓    │
   │ Editar próprio post        │   ✓    │   ✓    │   ✓    │   ✓    │
   │ Apagar próprio post        │   ✓    │   ✓    │   ✓    │   ✓    │
   │ Apagar post de outro       │   —    │   —    │   —    │   ✓    │
   │ Apagar msg pra mim         │   ✓    │   ✓    │   —    │   ✓    │
   │ Apagar msg pros dois (<2h) │   ✓    │   ✓    │   ✓    │   ✓    │
   │ Convidar pra timeline      │   ✓    │   ✓    │   —    │   ✓    │
   │ Mandar foto                │   ✓    │   ✓    │   ✓    │   ✓    │
   │ Mandar áudio               │   ✓    │   ✓    │   ✓    │   ✓    │
   │ Auditar tudo (incl deletado)│   —    │   —    │   —    │   ✓    │
   └────────────────────────────┴────────┴────────┴────────┴────────┘
```

---

## 12. INTEGRAÇÃO COM O RESTO DO TENISCASH

### 12.1 Cashback
Cliente ganha cashback (compra na loja, treino no APEX, badge desbloqueado) → mensagem da loja aparece em Conversas:
"Sports & Tennis Bessa: você ganhou R$ 12,40 em TenisCash pela compra de hoje"

### 12.2 Reservas
Vendedor reservou par na medida do cliente → mensagem em Conversas com botão "Confirmar reserva" embutido. Cliente confirma direto.

### 12.3 Lojas postam novidades
Cada loja pode postar na timeline pública. "Chegou Asics novo, dá uma passada". Quem se interessar abre Conversas com vendedor.

### 12.4 APEX (app esportivo)
Cliente completa treino no APEX → post automático na timeline privada que ele escolheu (Família, Time de Corrida). Compartilha o feito sem ele precisar escrever.

### 12.5 Comércio dentro da conversa
Vendedor manda **card de produto no DM** — foto, preço, tamanhos disponíveis na loja certa. Cliente toca → botão de reservar, perguntar disponibilidade, abrir no ecommerce.

---

## 13. DIFERENÇAS vs WHATSAPP

| Aspecto | WhatsApp | TenisCash Mensagens |
|---------|----------|---------------------|
| Onde os dados ficam | Servidores da Meta | Banco do TenisCash |
| Quem controla o número | Meta | A própria empresa |
| Grupos | Existem, até 1024 pessoas | Não existem — existem timelines privadas (sem chat ativo) |
| Like/Reaction | Tem emoji rápido em status | Não tem — reação é DM |
| Posts duram | Para sempre (status 24h) | Timeline some 00:00 |
| Histórico | Pode perder se trocar de celular | Sempre preservado no banco |
| Mídia | Pode comprimir, viraliza fácil | Controlado, dentro da Sports & Tennis |
| Integração com loja física | Nenhuma | Total — cashback, reserva, APEX, ecommerce |

---

## 14. PLANO DE IMPLEMENTAÇÃO

```
   ┌─────────────────────────────────────────────────────────────────┐
   │ FASE 1 — BACKEND                                       5 dias    │
   │ ──────                                                            │
   │  □ Migration Prisma (5 modelos novos)                            │
   │  □ Routes /conversations                                          │
   │  □ Routes /timelines                                              │
   │  □ Routes /upload (mídia)                                         │
   │  □ Job cron 00:00                                                 │
   │  □ Routes /notifications/summary                                  │
   │  □ Testes com curl                                                │
   └─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ FASE 2 — FRONTEND ADMIN                                3 dias    │
   │ ──────                                                            │
   │  □ Tab "Mensagens v2" em admin.html                              │
   │  □ Lista de conversas + thread                                    │
   │  □ Timeline (geral + privadas)                                    │
   │  □ Composer (texto + foto + áudio)                                │
   │  □ Notificações (polling)                                         │
   └─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ FASE 3 — APP CLIENTE PWA                               4 dias    │
   │ ──────                                                            │
   │  □ Página app.html mobile-first                                   │
   │  □ Telas adaptadas (responsivo)                                   │
   │  □ Service Worker (offline básico)                                │
   │  □ MediaRecorder pra áudio                                        │
   └─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ FASE 4 — TESTES E AJUSTES                              2 dias    │
   │ ──────                                                            │
   │  □ Testes com vendedores Sports & Tennis                          │
   │  □ Iteração baseada em feedback                                   │
   │  □ Logs e monitoramento                                           │
   └─────────────────────────────────────────────────────────────────┘

   ════════════════════════════════════════════════════════════
   Total: ~14 dias úteis pra fase 1 completa
   ════════════════════════════════════════════════════════════
```

---

## 15. PERGUNTAS EM ABERTO PRA PESQUISA

### 15.1 Comportamento humano
- O que motiva uma pessoa a postar sem feedback público?
- A ausência total de métricas de validação reduz ansiedade e aumenta autenticidade, ou reduz engajamento ao ponto de ninguém postar?
- O reset diário é libertador ou frustrante?
- Quantos círculos íntimos uma pessoa consegue manter ativamente? (Dunbar's number: 5 / 15 / 50 / 150)

### 15.2 Casos de uso prováveis
Quais tipos de conteúdo as pessoas postariam num espaço sem curtida? Hipóteses: desabafos, agradecimentos religiosos, marcos pessoais, observações cotidianas, declarações de afeto, relatos de exercício.

Pesquisar:
- Diários físicos populares no Brasil (5 minutos, gratidão)
- Apps de journaling (Day One, Reflectly)
- Comunidades religiosas
- Validar se o público da Sports & Tennis (varejo esportivo, classe B/C, 18-45, Paraíba) usa journaling ou tem rejeição cultural

### 15.3 Substituição de grupos
WhatsApp tem mais de 50 grupos por usuário ativo em média no Brasil.
- Timeline privada (sem chat ativo, só posts) substitui grupos pra fins sociais?
- Pra fins funcionais (combinar encontro, organizar evento), o que substitui?
- Como evitar que vire o "grupo da família" reformatado?

### 15.4 Economia da plataforma
- Sem ads e sem assinatura, qual é o modelo? Subsídio do varejo?
- Como medir sucesso sem vanity metrics (likes)? Propostas:
  - Retenção (D7, D30)
  - Streak médio de dias ativos
  - Conversas iniciadas após post na timeline (mede se reação genuína acontece)
  - NPS / Satisfação subjetiva

### 15.5 Referências comparativas

Apps que tentaram caminhos similares — estudar profundamente:

- **Path** (2010-2018): rede social limitada a 50 amigos, sem algoritmo. Fracassou comercialmente — modelo de negócio inviável, mas formato amado pelos usuários.
- **Snapchat**: pioneiro do efêmero. Aplicou em msgs individuais, não em timeline coletiva.
- **BeReal**: tentou romper performance com foto cândida 1x/dia. Cresceu rápido, perdeu tração — dificuldade de retenção sem mecanismo de validação.
- **Locket**: widget no celular com foto do parceiro/amigo. Íntimo, sem feed.
- **Instagram Close Friends**: lista única, posts efêmeros.
- **Vibras / Marco Polo**: vídeos curtos entre amigos. Não conseguiu escalar.
- **Vent / Sanvello**: apps de saúde mental com posts anônimos sem reação pública.

Questões específicas:
- Por que Path falhou apesar do produto ser amado?
- Por que BeReal não reteve apesar de viralizar?
- O que Snapchat fez certo em manter usuários em modelo efêmero?

---

## 16. RISCOS IDENTIFICADOS

| Risco | Mitigação |
|-------|-----------|
| Ninguém postar (sem dopamina de like) | Cashback diário só por abrir? Onboarding com semeio de conteúdo |
| Timeline pública vira deserto | Loja/vendedores semeiam posts iniciais |
| Privacidade (timeline privada com 200 pessoas vira grupo 2.0) | Limite considerado a posteriori se necessário |
| Cron pode falhar (servidor dormindo) | Filtro de UI sempre aplicado |
| Polling sobrecarregar | Caching agressivo; migrar pra WebSocket se necessário |
| MediaRecorder não funcionar bem em iOS | Fallback pra upload de áudio externo |
| LGPD: pedido de exclusão | Endpoint de anonimização (não hard-delete) |
| Spam/abuso | Rate limit por user no POST de posts |
| Mensagem maliciosa entre clientes | Botão "denunciar", admin revê |
| Dependência tóxica (alguém posta dor diariamente sem retorno) | Detecção heurística + intervenção humana |

---

## 17. TECNOLOGIAS

### Já em uso no TenisCash (reutilizar)
- Node.js + Express + Prisma + PostgreSQL (Railway)
- JWT em cookie HttpOnly
- multer (upload multipart)
- bcrypt (hash de PIN, já existe)
- sharp (compressão de imagem, já existe)

### Novas a adicionar
- `node-cron` — job 00:00
- `cloudinary` (SDK Node) — storage de mídia
- `fluent-ffmpeg` (opcional) — validação de áudio

### Frontend
- Vanilla JS (sem framework, sem build complexo)
- MediaRecorder API (nativa do browser)
- IntersectionObserver pra lazy loading de imagens

---

## 18. STATUS

### Decisões aprovadas pelo dono (Douglas Bernardo, Sports & Tennis)

| Decisão | Valor |
|---------|-------|
| Construir interno (não usar WhatsApp API) | ✓ |
| Nome da timeline | "Como está o dia hoje?" |
| Quantidade de timelines privadas | Ilimitada |
| Editar/apagar post da timeline | Livre até 00:00 |
| Apagar DM dentro de 2h | Some pros dois |
| Apagar DM depois de 2h | Some só pro próprio lado |
| Cliente apaga msg da loja | Pode (do lado dele) |
| Hard delete no banco | Nunca (auditoria 100%) |
| Convidar membro timeline privada | Telefone, nome salvo, username |
| Tipos de mídia em post | Texto, foto, áudio |
| Tipos de mídia em DM | Texto, foto, áudio |
| Push do celular OS | Não (notificação só interna) |

### Pendências
- Validação qualitativa do conceito com clientes reais
- Modelagem psicológica dos riscos (dependência, espiral negativa)
- Estudo comparativo aprofundado de Path / BeReal / Snapchat
- Análise jurídica LGPD
- Aprovação final pra iniciar implementação

### Próximo passo
Aprovação da arquitetura. Implementação começa após aprovação.

---

## RESUMO EXECUTIVO EM 1 PÁGINA

```
   ┌───────────────────────────────────────────────────────────────┐
   │                                                                 │
   │   TENISCASH MENSAGENS                                          │
   │                                                                 │
   │   2 espaços:                                                    │
   │                                                                 │
   │   💬 Conversas               📓 Como está o dia hoje?           │
   │      (memória)                  (presente)                      │
   │                                                                 │
   │   • DM pessoa↔pessoa         • Timeline pública (todos)         │
   │   • DM pessoa↔loja           • Timelines privadas (ilim)        │
   │   • Texto, foto, áudio        • Texto, foto, áudio              │
   │   • Persiste pra sempre       • Some às 00:00                   │
   │   • Apaga 2h pros dois        • Edit/delete livre até 00h       │
   │   • Apaga sempre pro meu      • Sem like, sem comentário        │
   │     lado                       • Reagir = abrir DM              │
   │                                                                 │
   │   ════════════════════════════════════════════════════════     │
   │                                                                 │
   │   Tecnologias: Node + Express + Prisma + Postgres + Cloudinary │
   │   Notificação: polling 15s (sem push OS)                       │
   │   Cron: 00:00 zera timeline (banco preserva pra auditoria)     │
   │                                                                 │
   │   ════════════════════════════════════════════════════════     │
   │                                                                 │
   │   Implementação: ~14 dias úteis em 4 fases                     │
   │                                                                 │
   │   Diferenciais vs WhatsApp:                                    │
   │   ✓ Dados nossos (sem Meta)                                    │
   │   ✓ Integrado a cashback, reserva, APEX, loja                  │
   │   ✓ Sem grupo lotado                                           │
   │   ✓ Sem like performático                                      │
   │   ✓ Reset diário libera expressão                              │
   │                                                                 │
   └───────────────────────────────────────────────────────────────┘
```
