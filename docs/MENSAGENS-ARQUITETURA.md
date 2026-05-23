# Arquitetura — Sistema de Mensagens TenisCash

> Documento técnico. Define como o sistema vai ser construído.
> Documentos relacionados: `MENSAGENS-SISTEMA.md` (descrição do produto), `MENSAGENS-PESQUISA.md` (briefing de pesquisa).

---

## 1. Visão em camadas

```
┌─────────────────────────────────────────────────────────────┐
│  Cliente (PWA mobile + Admin web)                            │
│  HTML/CSS/JS vanilla + componentes reutilizáveis             │
└────────────────────────────────────┬────────────────────────┘
                                     │ HTTPS
                                     │ JSON
┌────────────────────────────────────┴────────────────────────┐
│  API Layer  (Node.js + Express)                              │
│  - Auth (JWT cookie)                                         │
│  - Routes /api/messages/*                                    │
│  - Validação + autorização                                   │
└──────┬──────────────────────────────────────────┬───────────┘
       │                                          │
       ▼                                          ▼
┌──────────────────┐                  ┌──────────────────────┐
│ Banco PostgreSQL  │                  │  Storage de Mídia    │
│ (Railway)         │                  │  (Cloudinary ou      │
│ via Prisma ORM    │                  │   Railway Volume)    │
└──────────────────┘                  └──────────────────────┘
       ▲
       │
┌──────┴───────────┐
│  Cron Job        │
│  (00:00 diário)  │
│  Marca expiração │
│  da timeline     │
└──────────────────┘
```

Tecnologias base já em uso no TenisCash:
- Node.js + Express
- Prisma + PostgreSQL (Railway)
- HTML/CSS/JS vanilla (sem React, sem build complexo)
- JWT em cookie HttpOnly pra auth
- Deploy automático via Railway no `git push origin main`

---

## 2. Banco de Dados — Schema

### 2.1 Tabelas novas

```prisma
// ===========================================================
// MENSAGENS — TIMELINE ("Como está o dia hoje?")
// ===========================================================

model Timeline {
  id            String   @id @default(cuid())
  name          String                              // "Geral", "Família", "Time Bessa"
  isPublic      Boolean  @default(false)            // true só pra UMA timeline global do sistema
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
  lastReadAt    DateTime @default(now())            // pra calcular badge "não lido"
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
  expiredAt     DateTime?                           // setado pelo cron 00:00 do dia seguinte

  timeline      Timeline @relation(fields: [timelineId], references: [id])
  author        User     @relation("timelinePostsAuthored", fields: [authorId], references: [id])

  @@index([timelineId, createdAt])                  // listar posts de uma timeline em ordem
  @@index([expiredAt])                              // cron buscar posts não expirados
}

// ===========================================================
// MENSAGENS — CONVERSAS (DMs e Loja)
// ===========================================================

model Conversation {
  id            String   @id @default(cuid())
  type          String                              // "dm" | "loja"
  // Pra DM: userAId é sempre o menor lexicograficamente, userBId o maior (constraint única)
  userAId       String?
  userBId       String?
  // Pra Loja: storeId + clientUserId
  storeId       String?
  clientUserId  String?
  lastMessageAt DateTime @default(now())
  createdAt     DateTime @default(now())

  userA         User?    @relation("conversationsAsUserA", fields: [userAId], references: [id])
  userB         User?    @relation("conversationsAsUserB", fields: [userBId], references: [id])
  store         Store?   @relation("conversationsForStore", fields: [storeId], references: [id])
  clientUser    User?    @relation("conversationsAsClient", fields: [clientUserId], references: [id])
  messages      ChatMessage[]

  @@unique([userAId, userBId])                      // 1 conversa DM por par
  @@unique([storeId, clientUserId])                 // 1 conversa loja por cliente
  @@index([lastMessageAt])
}

model ChatMessage {
  id                       String   @id @default(cuid())
  conversationId           String
  senderId                 String                   // FK User (ou User-representante-da-loja)
  senderType               String   @default("user") // "user" | "store" | "system"
  content                  String?
  mediaType                String?                  // "photo" | "audio" | null
  mediaUrl                 String?
  mediaDuration            Int?
  // Cartão de produto inline (recurso futuro de comércio no chat)
  productCardId            String?                  // FK Product
  readAt                   DateTime?                // quando o destinatário leu
  editedAt                 DateTime?
  // Soft delete em 3 dimensões — nenhum é hard delete
  deletedForSenderAt       DateTime?                // remetente apagou pro lado dele
  deletedForRecipientAt    DateTime?                // destinatário apagou pro lado dele
  deletedForBothAt         DateTime?                // remetente apagou pros dois (até 2h)
  createdAt                DateTime @default(now())

  conversation             Conversation @relation(fields: [conversationId], references: [id])
  sender                   User         @relation("chatMessagesSent", fields: [senderId], references: [id])
  productCard              Product?     @relation("chatMessageProducts", fields: [productCardId], references: [id])

  @@index([conversationId, createdAt])
  @@index([senderId, createdAt])
  @@index([readAt])
}

// ===========================================================
// COMPLEMENTOS NO User existente
// ===========================================================
// Adicionar ao model User:
//   username      String?  @unique   // handle público pra ser convidado
```

### 2.2 Regras de integridade

- **Timeline pública** é única no sistema: row com `isPublic = true` (não permite criar outra). Todos os Users são membros implícitos — não há row em TimelineMember pra timeline pública.
- **Conversation DM**: a query garante `userAId < userBId` pra evitar dupla criação.
- **Conversation Loja**: par único `(storeId, clientUserId)`.
- **ChatMessage nunca é deletada do banco.** Apenas marca timestamps de soft-delete. Auditoria recupera tudo.
- **TimelinePost** após o `expiredAt` ser setado: invisível na UI, mas continua no banco. Limpeza posterior via cron semanal opcional (remover posts com `expiredAt < NOW() - 30 dias`) só se houver pressão de storage.

---

## 3. API REST — Endpoints

Base: `/api/messages`

### 3.1 Conversas

```
GET    /api/messages/conversations
       Lista as conversas do user logado (DM + Loja), ordenado por lastMessageAt DESC
       Filtros opcionais: ?unread=1
       Retorna: [{ id, type, otherParty, lastMessage, unreadCount }, ...]

POST   /api/messages/conversations
       Cria conversa nova
       Body: { type: 'dm', toUserId } ou { type: 'loja', toStoreId }
       Idempotente — se já existe, retorna a existente

GET    /api/messages/conversations/:id/messages
       Lista mensagens de uma conversa
       Filtros: ?limit=50&cursor=msgId&direction=before|after
       Retorna mensagens não deletadas pro user logado

POST   /api/messages/conversations/:id/messages
       Envia mensagem nova
       Body: { content?, mediaUrl?, mediaType?, productCardId? }
       Atualiza lastMessageAt na Conversation

PATCH  /api/messages/messages/:id
       Edita mensagem (só remetente, sem janela de tempo)
       Body: { content }

DELETE /api/messages/messages/:id
       Apaga mensagem
       Body: { scope: 'me' | 'both' }
       Backend valida: 'both' só se senderId == userId AND createdAt > NOW() - 2h
       Aplica timestamps no soft-delete apropriado

PATCH  /api/messages/conversations/:id/read
       Marca toda a conversa como lida pelo user logado
       Atualiza readAt nas mensagens não lidas
```

### 3.2 Timeline

```
GET    /api/messages/timelines
       Lista timelines do user (pública + as privadas que ele participa)
       Retorna: [{ id, name, isPublic, memberCount, hasUnread, lastPostAt }, ...]

POST   /api/messages/timelines
       Cria timeline privada nova
       Body: { name, inviteUserIds: [...] }
       Retorna a timeline criada + membros adicionados

POST   /api/messages/timelines/:id/members
       Adiciona membro à timeline privada (só o creator)
       Body: { userId } ou { phone } ou { username }

DELETE /api/messages/timelines/:id/members/:userId
       Remove membro (creator pode remover qualquer; member só pode remover a si mesmo)

GET    /api/messages/timelines/:id/posts
       Lista posts da timeline (já filtrados: hoje only, não expirados, não deletados)
       Default: posts com createdAt >= 00:00 hoje AND expiredAt IS NULL AND deletedAt IS NULL
       Marca lastReadAt do membro no momento da chamada

POST   /api/messages/timelines/:id/posts
       Cria post novo
       Body: { content?, mediaUrl?, mediaType?, mediaDuration? }

PATCH  /api/messages/posts/:id
       Edita post (só autor, só até 00:00, só se !expiredAt)
       Body: { content?, mediaUrl? }
       Atualiza editedAt

DELETE /api/messages/posts/:id
       Apaga post (só autor, só até 00:00)
       Marca deletedAt
```

### 3.3 Mídia (upload)

```
POST   /api/messages/upload
       Multipart form: file=<binary>
       Backend: comprime se foto (max 1080p), valida codec (opus/webm pra áudio)
       Sobe pro storage (Cloudinary ou Railway Volume)
       Retorna: { url, mediaType, duration? }
```

### 3.4 Notificações in-app

```
GET    /api/messages/notifications/summary
       Conta tudo o que o user tem de não lido
       Retorna: {
         unreadConversations: 3,
         unreadTimelines: [{ timelineId, name, unreadCount }],
         totalUnread: 5
       }
       Front polla esse endpoint a cada N segundos pra atualizar badge
```

### 3.5 Convites (busca de pessoas pra timeline)

```
GET    /api/messages/people/search
       Busca usuários pra convidar
       Query: ?q=<texto>&type=phone|username|name
       Retorna: [{ userId, name, username, phone }, ...]
       Restringe pro próprio contexto (vendedores veem clientes da própria loja, etc)
```

---

## 4. Frontend

### 4.1 Estrutura de arquivos

```
public/
├── admin.html                                    (admin existente, ganha tab Mensagens v2)
├── app.html                                      (app cliente PWA — onde mora o sistema novo)
└── mensagens/
    ├── styles.css
    ├── timeline.js
    ├── conversas.js
    ├── upload.js
    └── notifications.js
```

### 4.2 Componentes principais

**Container principal** (`app.html`)
- Header com 2 abas: 💬 Conversas (n) | 📓 Como está o dia hoje? (n)
- Conteúdo abaixo: o que tiver selecionado

**Lista de Conversas** (`conversas.js`)
- Lista vertical de cards (avatar, nome, prévia, horário, badge não lidas)
- Clica → entra na thread

**Thread de Conversa**
- Header: avatar + nome + status (online/offline opcional)
- Bolhas direita/esquerda
- Rodapé: input texto + botões 📷 🎤
- Long-press numa mensagem → menu: Editar, Apagar pra mim, Apagar pros dois (se aplicável)

**Lista de Timelines**
- Sub-abas: 🌍 Geral, Família, Time Bessa, ➕ Nova
- Clica numa sub-aba → carrega os posts daquela timeline

**Feed da Timeline**
- Lista vertical de posts (autor + horário + conteúdo + mídia)
- Cada post tem ✏️ editar e 🗑️ apagar (se for do user logado)
- Rodapé fixo: composer com texto + foto + áudio
- Aviso "Tudo aqui some às 00:00"

**Composer de Post / Mensagem**
- Input texto
- Botão 📷: abre câmera ou galeria
- Botão 🎤: segura pra gravar (MediaRecorder API), solta pra enviar
- Preview da mídia antes de mandar

**Modal de Criar Timeline Privada**
- Campo: nome da timeline
- Busca pessoas: input de telefone/username/nome → resultados em tempo real
- Lista de pessoas adicionadas (chips removíveis)
- Botão "Criar"

### 4.3 Estados e dados no front

- Estado mantido em memória (variáveis no JS) + reidratação via REST a cada navegação
- Não usa framework reativo — é simples o suficiente pra vanilla JS
- Polling de notificações: `setInterval` a cada 15 segundos chamando `/notifications/summary`
- Cache local (localStorage) só pra última timeline aberta + último cursor de paginação

---

## 5. Storage de Mídia

### 5.1 Opções

**Cloudinary** (recomendado pra fotos)
- Comprime automático, gera thumbnails
- CDN global
- Lifecycle policy (apagar mídia X dias após upload)
- Custo: free tier cobre os primeiros milhares; depois ~$0,10/GB/mês

**Railway Volume** (alternativa pra áudio)
- Volume persistente já existente no projeto
- Sem custo extra
- Sem CDN global (latência fora do Brasil pior)

**Recomendação:** Cloudinary pra ambos. Custo previsível e CDN matar latência.

### 5.2 Pipeline de upload

```
Cliente → POST /api/messages/upload (multipart)
         ↓
Backend recebe binário
         ↓
Comprime/valida:
  - Foto: limita 1080p, JPEG quality 80, max 500KB
  - Áudio: codec opus, max 120 segundos
         ↓
Sobe pro Cloudinary (signed upload)
         ↓
Retorna { url, mediaType, duration }
         ↓
Cliente usa essa URL no POST de post/mensagem
```

### 5.3 Lifecycle

- **Mídia de Conversa**: persiste pra sempre (auditoria)
- **Mídia de TimelinePost**: 30 dias após `expiredAt`, job semanal opcional remove arquivo (banco mantém URL morta — isso é OK porque o post também sumiu)

---

## 6. Notificações in-app

Sem push do sistema operacional. Tudo dentro do app.

### 6.1 Mecânica

**Polling**: front consulta `/api/messages/notifications/summary` a cada 15 segundos quando o app está aberto.

**WebSocket (futuro)**: substituir o polling por WebSocket bidirecional. Servidor avisa cliente em tempo real. Não é fase 1.

### 6.2 Visual

- Badge numérico nas abas (💬 Conversas (3))
- Círculo azul ao lado do nome de timelines com posts não lidos
- Sininho no topo do app com contador total

### 6.3 Lógica de "não lido"

**Conversas:**
```
unreadCount = count(ChatMessage WHERE conversationId = X
                                 AND senderId != userId
                                 AND readAt IS NULL)
```

**Timelines:**
```
hasUnread = exists(TimelinePost WHERE timelineId = X
                                AND createdAt > timelineMember.lastReadAt
                                AND authorId != userId)
```

Quando o user abre a timeline, atualiza `lastReadAt = NOW()`.

---

## 7. Job diário — Reset 00:00

### 7.1 O que faz

Todo dia às 00:00 (timezone America/Sao_Paulo), um job:

```sql
UPDATE "TimelinePost"
SET "expiredAt" = NOW()
WHERE "expiredAt" IS NULL
  AND "createdAt" < DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Sao_Paulo');
```

### 7.2 Implementação

Opções:
- **`node-cron`** no servidor Express (simples; risco se servidor estiver dormindo)
- **Cron externo** (Railway tem add-on de cron) chamando endpoint `/api/internal/cron/expire-posts` autenticado por token
- **PostgreSQL `pg_cron`** (extensão; mais robusto, mas requer setup)

Recomendação: começar com `node-cron` no Express. Migrar depois se necessário.

### 7.3 Filtro de UI

Toda query que lista posts tem o filtro fixo:

```sql
WHERE expiredAt IS NULL
  AND deletedAt IS NULL
  AND createdAt >= DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Sao_Paulo')
```

Garante que mesmo se o cron atrasar, posts de ontem não aparecem.

---

## 8. Auditoria e LGPD

### 8.1 Princípio

Nenhuma mensagem é hard-deletada. Tudo fica no banco com timestamps de soft-delete.

### 8.2 Acessos especiais

Endpoint admin protegido (`adminMiddleware`):

```
GET /api/admin/messages/audit?userId=X&dateFrom=...&dateTo=...
    Retorna TODAS as mensagens (mesmo deletadas) de um user, num intervalo.
    Pra suporte, jurídico, fiscal.
    Cada acesso gera AdminAction (registra quem viu o quê e quando).
```

### 8.3 LGPD — direito ao esquecimento

Cliente pode solicitar exclusão dos dados pessoais. Procedimento:
- Lojista admin recebe o pedido
- Endpoint admin `DELETE /api/admin/users/:id/lgpd-erase` anonimiza os dados:
  - User.name → "Cliente Excluído"
  - User.phone → null
  - User.cpf → null
  - Posts e mensagens ficam, mas com sender mascarado
- Mensagens reais ficam no banco pra auditoria fiscal (obrigação legal varejo)
- Registro em AdminAction

---

## 9. Performance e escala

### 9.1 Estimativas iniciais

- 6.000 usuários ativos
- 0,5 post por usuário/dia em média = 3.000 posts/dia
- 3 conversas iniciadas por usuário/semana = 18.000 conversas/semana, ~5 msgs cada = 90.000 mensagens/semana
- Tudo cabe folgadinho em Postgres com índices certos

### 9.2 Hot path — listagem da timeline

Query mais frequente: listar posts da timeline pública (geral) do dia atual.

```sql
SELECT * FROM "TimelinePost"
WHERE "timelineId" = '<public_timeline_id>'
  AND "expiredAt" IS NULL
  AND "deletedAt" IS NULL
  AND "createdAt" >= DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Sao_Paulo')
ORDER BY "createdAt" DESC
LIMIT 50;
```

Com índice `(timelineId, createdAt)` essa query é instantânea mesmo com milhões de rows.

### 9.3 Possíveis gargalos futuros

- **Polling de notificações**: 6.000 usuários × 4 polls/min = 24.000 req/min. Caching agressivo na rota `/summary` resolve.
- **Upload de mídia simultâneo**: depende de Cloudinary (free tier limita uploads/segundo).
- **Storage**: cada áudio 30s ~= 200KB. 1.000 posts com áudio/dia = 200MB/dia. Cloudinary free aguenta meses.

---

## 10. Plano de implementação faseada

### Fase 1 — Backend (5 dias úteis)
1. Migration Prisma: 5 tabelas novas (Timeline, TimelineMember, TimelinePost, Conversation, ChatMessage)
2. Routes `/api/messages/conversations/*`
3. Routes `/api/messages/timelines/*`
4. Routes `/api/messages/upload`
5. Job cron 00:00 (`node-cron` + endpoint protegido)
6. Endpoint `/notifications/summary`
7. Testes end-to-end com curl

### Fase 2 — Frontend admin (3 dias úteis)
8. Tab "Mensagens v2" no `admin.html`
9. Lista de conversas + thread
10. Timeline pública (geral)
11. Criar timeline privada + convidar membros
12. Composer (texto, foto, áudio)
13. Polling de notificações

### Fase 3 — App cliente PWA (4 dias úteis)
14. Página `app.html` (mobile-first)
15. Mesmas telas adaptadas
16. Service Worker (offline básico)
17. MediaRecorder pra áudio (testar iOS Safari)

### Fase 4 — Ajustes e testes (2 dias úteis)
18. Auditoria, logs, monitoramento
19. Testes com usuários reais (vendedores Sports & Tennis)
20. Iteração baseada em feedback

**Total estimado:** 14 dias úteis pra entregar fase completa.

---

## 11. Decisões em aberto (precisam ser tomadas antes da implementação)

| Decisão | Opções | Recomendação |
|---------|--------|--------------|
| Storage de mídia | Cloudinary / Railway Volume / S3 | Cloudinary |
| Frequência de polling | 5s / 15s / 30s | 15s (balanço carga/UX) |
| Hard delete pós-30 dias | Sim / Não | Não — manter eternamente, custo é baixo |
| Username único | Auto-gerado / Escolhido pelo user | Escolhido (UX, identidade) |
| Limite de membros por timeline privada | Ilimitado / 50 / 100 | Ilimitado por enquanto, monitorar |
| Limite de tamanho de áudio | 30s / 60s / 120s | 60s |
| Pode editar DM depois de enviar? | Sim / Não | Sim, sem limite (com indicador "editada") |
| Posts editados mostram histórico? | Sim / Não | Não — só indicador (simplifica) |

---

## 12. Riscos técnicos identificados

| Risco | Mitigação |
|-------|-----------|
| Cron pode falhar (servidor dormindo) | Filtro de UI sempre aplicado (não confia 100% no cron) |
| Polling sobrecarregar | Caching agressivo no `/summary`; migrar pra WebSocket se necessário |
| MediaRecorder não funcionar bem em iOS | Fallback pra upload de áudio gravado externamente |
| Cliente perder conexão durante upload | Retry com idempotency key |
| Storage atingir limite free | Monitorar; migrar mídia antiga pra storage mais barato |
| LGPD: usuário pedir exclusão | Endpoint de anonimização (não hard-delete) |
| Spam/abuso (cliente postando lixo) | Rate limit por user no POST de posts (max 20/hora?) |
| Mensagem maliciosa entre clientes | Botão "denunciar" na mensagem, admin revê |

---

## 13. Tecnologias e libraries

Já em uso no TenisCash (reutilizar):
- Express + Prisma + PostgreSQL
- JWT + cookie-parser
- multer (upload multipart)
- bcrypt (hash de PIN, já existe)

Novas a adicionar:
- `node-cron` — job 00:00
- `cloudinary` (SDK Node) — se for esse storage escolhido
- `sharp` (já tem) — compressão de imagem
- `fluent-ffmpeg` (opcional) — validação de áudio

Frontend:
- Vanilla JS — sem framework
- MediaRecorder API (nativa browser)
- IntersectionObserver pra lazy loading de imagens

---

## 14. Estrutura de arquivos no repositório

```
TenisCash/
├── prisma/
│   └── schema.prisma                              (adicionar models acima)
├── src/
│   └── routes/
│       └── messages-v2.js                         (toda a API nova)
├── src/
│   └── services/
│       ├── messagesNotifier.js                    (cálculo de unread counts)
│       └── messagesCron.js                        (job 00:00)
├── public/
│   ├── admin.html                                 (tab Mensagens v2 substitui antigo)
│   └── mensagens/                                 (frontend de mensagens)
│       ├── conversas.js
│       ├── timeline.js
│       ├── composer.js
│       ├── upload.js
│       └── styles.css
└── docs/
    ├── MENSAGENS-SISTEMA.md                       (descrição do produto)
    ├── MENSAGENS-ARQUITETURA.md                   (este documento)
    └── MENSAGENS-PESQUISA.md                      (briefing de pesquisa)
```

---

## 15. Próximo passo

Aprovação da arquitetura pelo dono.

Após aprovação:
1. Migration Prisma rodada em ambiente Railway
2. Routes criadas em `src/routes/messages-v2.js`
3. Frontend admin testado em `https://teniscash.com.br/admin.html`
4. PWA cliente em `https://teniscash.com.br/app.html`

Implementação começa só após aprovação.
