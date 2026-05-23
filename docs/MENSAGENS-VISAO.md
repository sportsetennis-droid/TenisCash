# MENSAGENS TENISCASH — Visão do Produto

> Documento de design ANTES de codar. Aprovação do dono é obrigatória pra evoluir.

## Filosofia

O WhatsApp deu trabalho excessivo (Cloud API gated por Meta, restrições de SMB, dependência de terceiros). Vamos construir interno — dados nossos, regras nossas, sem intermediário.

Princípios:
- **Não copiar WhatsApp.** Fazer melhor pelo contexto do TenisCash.
- **Reduzir ruído.** Acabar com grupo lotado, like performático, scroll infinito.
- **Presente importa.** O hoje vale mais que o passado.
- **Pessoa, não público.** Quem se importa procura. Sem métrica de validação.

## Estrutura — 2 espaços

### 📓 "Como está o dia hoje?" — TIMELINE

**Conceito:** diário compartilhado que zera todo dia. Você escreve seu dia, lê o dia dos outros.

- **Tipos:**
  - 1 timeline **pública** (geral, todos os usuários TenisCash veem)
  - N timelines **privadas** (você cria quantas quiser; convida por telefone, nome ou username)
- **Conteúdo do post:** texto, foto, áudio
- **Editar e apagar:** livre até 00:00
- **00:00 ZERA tudo, pra todos.** O ontem morreu. Sem arquivo, sem volta.
- **Sem like, sem comentário, sem reaction visual.**
- **Reação = abrir Conversas e mandar mensagem direta.** A pessoa pôs algo que te tocou? Você fala com ela.

**Notificação:** quando alguém posta numa timeline que você participa, fica "não lido" tipo email. Abre a timeline, marca como lido. Sem badge de quantas reações o post teve.

### 💬 "Conversas" — MENSAGENS DIRETAS (DMs)

**Conceito:** memória. Onde as relações persistem.

- **Entre 2 pessoas** (cliente ↔ cliente, cliente ↔ vendedor)
- **Cliente ↔ Loja** (oficial: reserva, cashback, atendimento)
- **Conteúdo:** texto, foto, áudio
- **Toda mensagem é importante.** Sem nível, sem prioridade.
- **Sistema NUNCA apaga.**
- **Usuário pode apagar:**
  - Até 2h após enviar: apaga **pros dois** (some na tela dos dois)
  - Depois de 2h: apaga **só pro seu lado** (o outro continua vendo)
  - Cliente ↔ Loja segue a mesma regra
- **No banco, NUNCA é hard-delete.** Soft-delete com flag pra auditoria — em caso de auditoria fiscal, jurídica ou suporte, dado preservado.

## Notificações

- Notificação **dentro do nosso sistema apenas** (badge, sino, contadores)
- **Não** dispara push OS do celular (sem dependência de Apple/Google Push)
- Usuário decide quando abre o app

## Convite pra timeline privada

3 jeitos:
1. **Telefone** (o usuário já está cadastrado pelo phone)
2. **Nome salvo** (busca por nome no diretório TenisCash)
3. **Username** (handle único @nome — campo novo no User)

Convidado recebe notif interna "Carlos te chamou pra timeline Família". Aceita → entra. Recusa → fica fora.

## Arquitetura do banco

### Tabelas novas

```
Timeline
├── id
├── name                "Família", "Time Bessa", etc
├── isPublic            (true só pra UMA timeline global)
├── createdById         FK User
├── createdAt
└── deletedAt           (soft delete da timeline inteira)

TimelineMember
├── timelineId          FK Timeline
├── userId              FK User
├── joinedAt
├── lastReadAt          (badge "não lido" calcula contra createdAt do último post)
└── leftAt

TimelinePost
├── id
├── timelineId          FK Timeline
├── authorId            FK User
├── content             texto (Text)
├── mediaType           text | photo | audio
├── mediaUrl            URL (S3/Railway Storage)
├── editedAt            (última edição)
├── deletedAt           (soft delete pelo autor)
├── expiredAt           (00:00 do dia seguinte — job cron marca)
├── createdAt
└── @@index(timelineId, createdAt)

Conversation
├── id
├── type                dm | loja
├── userAId             FK User (sempre menor)
├── userBId             FK User (sempre maior)  — pra dm
├── storeId             FK Store — pra loja
├── lastMessageAt
└── @@unique(userAId, userBId) — uma conversa por par

ChatMessage
├── id
├── conversationId      FK Conversation
├── senderId            FK User
├── content             texto
├── mediaType           text | photo | audio
├── mediaUrl
├── editedAt
├── deletedForSenderAt
├── deletedForRecipientAt
├── deletedForBothAt    (quando apaga "pros dois" dentro de 2h)
├── readAt              quando o destinatário leu
├── createdAt
└── @@index(conversationId, createdAt)
```

### Job diário 00:00

```sql
UPDATE "TimelinePost"
SET "expiredAt" = NOW()
WHERE "expiredAt" IS NULL
  AND "createdAt" < DATE_TRUNC('day', NOW());
```

Posts continuam no banco (auditoria) mas a UI filtra:
```
WHERE expiredAt IS NULL
  AND deletedAt IS NULL
  AND createdAt >= '00:00 do dia atual'
```

### Apagar DM — lógica

```
Se autor clicar "apagar":
  Se (now - createdAt) < 2h:
    SET deletedForBothAt = now()
    (some pros 2 na UI)
  Senão:
    SET deletedForSenderAt = now()
    (some só pro autor)

Se destinatário clicar "apagar":
  Sempre: SET deletedForRecipientAt = now()
  (some só pro destinatário)

UI filtra:
  Se sou autor: hide se deletedForSenderAt OR deletedForBothAt
  Se sou destinatário: hide se deletedForRecipientAt OR deletedForBothAt
```

Mensagem **nunca sai do banco**.

## Telas (fase 1)

### Topo do app — abas
```
[💬 Conversas (3 não lidas)]  [📓 Como está o dia hoje? (1 nova)]
```

### Tela "Como está o dia hoje?"
- Sub-abas: 🌍 Geral · 👨‍👩‍👧 Família · 🏃 Time Bessa · ➕ Criar nova
- Lista de posts cronológica (mais recente em cima)
- Campo de escrever no rodapé
- Botões: 📷 foto · 🎤 áudio
- Indicador "Tudo aqui some às 00:00"

### Tela "Conversas"
- Lista de conversas (DM e Loja juntas)
- Última msg + horário + badge não lido
- Clica → abre thread
- Thread tem: input texto, botão foto, botão gravar áudio

### Tela "Criar timeline privada"
- Nome (ex: "Família")
- Busca de pessoas: 📞 telefone · @username · 👤 nome no diretório
- Adiciona membros
- Pronto

## Mídia — armazenamento

- **Foto:** upload comprimido (max 1080p), guarda em Railway Volume ou Cloudinary
- **Áudio:** grava no browser via MediaRecorder, codec opus/webm, max 2min
- **Mídia da timeline:** quando 00:00 marca expiredAt, foto/áudio ficam no storage mas não são acessíveis publicamente. Cron semanal pode purgar mídia de posts > 30 dias expirados.
- **Mídia das conversas:** persiste pra sempre (auditoria)

## Fora do escopo da fase 1

- Reply quote (citar mensagem específica)
- Forward (encaminhar)
- Voice/video call
- Stories sumindo em 24h (já tem o conceito de timeline diária)
- Group chat tradicional (substituído pela timeline privada)
- Reactions visíveis (substituído por "reagir = mandar DM")
- Status online / typing
- Push OS do celular

Tudo isso pode entrar em fases futuras conforme uso real.

## Métricas pra validar se vicia

- **DAU** (daily active users) — meta: 60% dos clientes TenisCash abrem por dia
- **Posts/dia médios** — meta: 0.5 post por usuário/dia
- **Streak médio** — meta: 7 dias seguidos abertos
- **Conversas/semana** — meta: 3 conversas iniciadas por usuário/semana
- **% de notificações que viram abertura** — meta: 80%

## Decisões aprovadas pelo dono (registradas)

| Decisão | Valor |
|---------|-------|
| Nome da timeline | "Como está o dia hoje?" |
| Quantidade de timelines privadas por usuário | Ilimitada |
| Editar/apagar post da timeline | Livre até 00:00 |
| Apagar DM dentro de 2h | Some pros dois |
| Apagar DM depois de 2h | Some só pro seu lado |
| Cliente apaga msg da loja | Pode (do lado dele) |
| Hard delete no banco | Nunca (auditoria 100%) |
| Convidar membro timeline privada | Telefone, nome salvo, username |
| Tipos de mídia em post | Texto, foto, áudio |
| Tipos de mídia em DM | Texto, foto, áudio |
| Push do celular OS | NÃO (notif só interna) |

---

## Plano de execução (após aprovação)

**Fase 1A — Backend (2-3 dias)**
1. Migration schema (Timeline, TimelineMember, TimelinePost, Conversation, ChatMessage)
2. Endpoints REST: /api/messages/timelines, /timelines/:id/posts, /conversations, /conversations/:id/messages
3. Job cron diário 00:00 (expiredAt em TimelinePost)
4. Upload de mídia (multer + storage)

**Fase 1B — Frontend admin/web (2-3 dias)**
5. Tela "Como está o dia hoje?" (lista + criar post)
6. Tela "Conversas" (lista + thread)
7. Criar timeline privada (modal + convite)
8. Editor de post (texto + foto + áudio)

**Fase 1C — App cliente PWA (2-3 dias)**
9. Mesmas telas adaptadas pro PWA mobile
10. Notificação interna (sino + badge)

**Total estimado:** ~7-10 dias úteis pra entregar fase 1 completa, com testes.

---

## Status

⏳ **Aguardando aprovação do dono** pra começar Fase 1A.

Aprovar / corrigir / pausar.
