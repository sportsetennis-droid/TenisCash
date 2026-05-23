# Sistema de Mensagens TenisCash — Desenho Completo

> Todos os diagramas e telas em um só lugar. Documento visual.

---

## 1. Arquitetura geral em camadas

```
┌────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   CLIENTE                                                                │
│   ─────────                                                              │
│   📱 PWA Mobile (app.html)        💻 Admin Web (admin.html)             │
│   • Cliente final                  • Vendedor + dono                     │
│   • Conversas + Timeline            • Conversas + Timeline + gestão      │
│                                                                          │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 │  HTTPS · JSON · JWT cookie
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   API EXPRESS  ( /api/messages/* )                                      │
│   ─────────                                                              │
│                                                                          │
│   ┌────────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────────┐  │
│   │ Conversas  │  │  Timelines   │  │  Upload    │  │ Notificações │  │
│   │  (DMs)     │  │  (Posts)     │  │  Mídia     │  │   (badge)    │  │
│   └─────┬──────┘  └──────┬───────┘  └─────┬──────┘  └──────┬───────┘  │
│         │                │                 │                 │           │
└─────────┼────────────────┼─────────────────┼─────────────────┼──────────┘
          │                │                 │                 │
          ▼                ▼                 ▼                 ▼
┌──────────────────────────────────┐  ┌────────────────┐  ┌──────────┐
│                                  │  │                │  │          │
│   POSTGRES (Railway)             │  │   STORAGE      │  │  CRON    │
│   ──────────                      │  │   ──────       │  │  00:00   │
│                                  │  │                │  │          │
│   Conversation                    │  │  Cloudinary    │  │ expira   │
│   ChatMessage                     │  │  fotos+áudios  │  │ posts    │
│   Timeline                        │  │                │  │ do dia   │
│   TimelineMember                  │  │                │  │ anterior │
│   TimelinePost                    │  │                │  │          │
│   User (já existe)                │  │                │  │          │
│   Store (já existe)               │  │                │  │          │
│                                  │  │                │  │          │
└──────────────────────────────────┘  └────────────────┘  └──────────┘
```

---

## 2. Mapa de navegação do app

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

## 3. Tela: Lista de Conversas

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
│                                                                 │
│                                                  [+ Nova msg]  │
└────────────────────────────────────────────────────────────────┘
```

---

## 4. Tela: Thread de Conversa

```
┌────────────────────────────────────────────────────────────────┐
│  ← Voltar       🟦 Ana Souza                          [⋮]      │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
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
│                                                                 │
├────────────────────────────────────────────────────────────────┤
│  [✍️ Escreva...                                     📷 🎤 ➤]   │
└────────────────────────────────────────────────────────────────┘

LEGENDA:
  bolha à esquerda = quem recebeu (Ana)
  bolha à direita  = quem mandou (você)
  ✓ = enviada     ✓✓ = entregue     ✓✓ azul = lida
```

---

## 5. Tela: Long-press numa mensagem (menu de ações)

```
┌────────────────────────────────────────────────────────────────┐
│  ← Voltar       🟦 Ana Souza                          [⋮]      │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│                            ┌─────────────────────────────┐    │
│                            │ Tudo, e você?               │    │
│                            │                       13:43 │    │
│                            └─────────────────────────────┘    │
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
│            │                              │                     │
│            └──────────────────────────────┘                     │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

---

## 6. Tela: Timeline "Como está o dia hoje?"

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

---

## 7. Tela: Criar Timeline Privada

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
│                                                                 │
│   [ Cancelar ]                            [ Criar timeline ]    │
└────────────────────────────────────────────────────────────────┘
```

---

## 8. Banco de dados — diagrama

```
                ┌────────────────────────┐
                │       User             │
                │  ────                  │
                │  id (PK)               │
                │  phone (unique)        │
                │  name                  │
                │  username (unique)     │  ← novo
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

---

## 9. Fluxo: enviar mensagem

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

---

## 10. Fluxo: postar na timeline

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

---

## 11. Fluxo: apagar mensagem em conversa

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

---

## 12. Fluxo: criar timeline privada e convidar

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

## 13. Job 00:00 — reset diário

```
                           00:00 (timezone Brasília)
                                  │
                                  ▼
                       ┌─────────────────────────┐
                       │  node-cron dispara       │
                       │  scheduled task          │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────────────────┐
                       │  Query no PostgreSQL                 │
                       │  ─────                                │
                       │  UPDATE TimelinePost                  │
                       │  SET expiredAt = NOW()                │
                       │  WHERE expiredAt IS NULL              │
                       │    AND createdAt < hoje 00:00         │
                       └────────────┬─────────────────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────────────────┐
                       │  Posts agora têm expiredAt ≠ null    │
                       │  Continuam no banco                   │
                       │  Mas a UI filtra ─────────►           │
                       │  WHERE expiredAt IS NULL              │
                       │  → não aparecem mais                  │
                       └─────────────────────────────────────┘


       Visão temporal:
       ───────────────

       quinta 21:00         quinta 23:59           sexta 00:00          sexta 09:00
            │                     │                      │                    │
            ▼                     ▼                      ▼                    ▼
       posta na timeline     última chance de         CRON RODA          abre o app
       "Família"             editar/apagar           ─────────►          vê timeline VAZIA
            │                                        expiredAt           começa novo dia
            │                                        seta em todos
            ▼                                        os posts de ontem


   Importante: se o cron falhar/atrasar, a UI ainda filtra por
              createdAt >= 00:00 hoje. Garante visual correto.
```

---

## 14. Sistema de Notificações in-app

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

---

## 15. Pipeline de upload de mídia

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
                         ▼                       │                       │
                    insere url no                 │                       │
                    body do POST                  │                       │
                    seguinte                      │                       │
```

---

## 16. Linha do tempo de um dia inteiro de uso

```

   06:00  ●  Cron já zerou tudo às 00:00.
          │  Carlos sai correr.
          │
   07:30  ●  Carlos abre app, posta foto + texto
          │  na timeline "Família".
          │  "Treino de 5km concluído!"
          │
   08:00  ●  Mãe acorda, abre app.
          │  Vê bolinha azul em "Família".
          │  Clica. Lê o post.
          │  Vai em Conversas, manda DM:
          │  "Que orgulho de você."
          │
   09:14  ●  Vendedor Bessa manda DM pro Carlos:
          │  "Chegou Asics que você queria,
          │   reservei na 41."
          │
   12:00  ●  Carlos almoça, vê notif.
          │  Responde "Vou aí às 17h."
          │
   14:30  ●  Ana posta na pública:
          │  "Bessa cheia, bom sinal."
          │
   17:30  ●  Carlos vai na Bessa, compra o Asics.
          │  Sistema dispara automaticamente:
          │  msg da loja em Conversas:
          │  "Você ganhou R$ 47 em TenisCash"
          │
   18:00  ●  Carlos posta na pública: foto do tênis.
          │  3 conhecidos veem, 1 manda DM pedindo
          │  link do produto.
          │
   23:50  ●  Carlos rola a timeline antes de dormir.
          │  Vê tudo o que pessoal postou hoje.
          │
   00:00  ●  Cron dispara.
          │  Todos os posts de quinta agora têm
          │  expiredAt setado.
          │  Tela mostra vazio quando alguém abrir.
          │  Conversas continuam intactas.
          │
   01:00  ●  Pessoa em outro fuso (PB é GMT-3) abre.
          │  Vê só posts da próxima madrugada (zero).
          │  Conversas com mãe, vendedor, Ana = lá.
```

---

## 17. Quem pode fazer o quê (matriz)

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

## 18. Plano de fases (visual)

```
   ┌─────────────────────────────────────────────────────────────────┐
   │ FASE 1 — BACKEND                                       5 dias    │
   │ ──────                                                            │
   │                                                                   │
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
   │                                                                   │
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
   │                                                                   │
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
   │                                                                   │
   │  □ Testes com vendedores Sports & Tennis                          │
   │  □ Iteração baseada em feedback                                   │
   │  □ Logs e monitoramento                                           │
   └─────────────────────────────────────────────────────────────────┘

   ════════════════════════════════════════════════════════════
   Total: ~14 dias úteis pra fase 1 completa
   ════════════════════════════════════════════════════════════
```

---

## 19. Localização nos arquivos do projeto

```
   TenisCash/
   │
   ├── prisma/
   │   └── schema.prisma  ◄── adicionar Timeline, TimelineMember,
   │                          TimelinePost, Conversation, ChatMessage
   │
   ├── src/
   │   ├── routes/
   │   │   └── messages-v2.js  ◄── nova rota (não substitui a antiga)
   │   │
   │   └── services/
   │       ├── messagesNotifier.js  ◄── cálculo de unread
   │       └── messagesCron.js       ◄── job 00:00
   │
   ├── public/
   │   ├── admin.html        ◄── tab "Mensagens v2" novo aqui
   │   ├── app.html          ◄── (NOVO) PWA cliente
   │   │
   │   └── mensagens/        ◄── (NOVO) frontend mensagens
   │       ├── conversas.js
   │       ├── timeline.js
   │       ├── composer.js
   │       ├── upload.js
   │       └── styles.css
   │
   └── docs/
       ├── MENSAGENS-SISTEMA.md      ◄── visão de produto
       ├── MENSAGENS-ARQUITETURA.md  ◄── técnico detalhado
       ├── MENSAGENS-PESQUISA.md     ◄── briefing pra research
       └── MENSAGENS-DESENHO.md      ◄── ESTE documento (visual)
```

---

## 20. Resumo executivo em uma página

```
   ┌───────────────────────────────────────────────────────────────┐
   │                                                                 │
   │   TENISCASH MENSAGENS                                          │
   │   ─────────────────────                                         │
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
