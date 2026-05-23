# Briefing de Pesquisa — Plataforma de Mensagens TenisCash

## Contexto

Sports & Tennis é uma rede varejista esportiva em João Pessoa/PB com 4 lojas físicas, ecommerce Nuvemshop e programa de loyalty TenisCash (cashback). Aproximadamente 6.000 clientes ativos no app cliente (PWA em construção, com integração futura ao app esportivo APEX — rastreamento de atividade física + comunidade).

A empresa tentou implementar atendimento via WhatsApp Business / Cloud API e enfrentou bloqueios estruturais: dependência da Meta como intermediário, restrições para empresas SMB sem Business Solution Provider, perda de histórico ao tentar migrar entre planos, ausência de controle total dos dados de cliente.

A decisão estratégica foi construir um sistema próprio de mensagens dentro do TenisCash — controle total dos dados, sem dependência de terceiros, e principalmente: liberdade pra desenhar uma experiência que **WhatsApp não tem**.

---

## Insight central

> **WhatsApp resolveu "como mandar mensagem". Mas o ato de se comunicar moderno tá saturado de pressão social, ruído de grupo, métricas de validação pública e ansiedade.**
>
> O que humanos querem em 2026 não é mais "outro app de chat". É **um espaço pra existir sem performar**.

A hipótese é que a próxima geração de comunicação social terá duas características que apps atuais não combinam bem:

1. **Memória individual preservada** (relações 1-a-1 que persistem com peso)
2. **Memória social efêmera** (presença coletiva sem culto à imagem nem ao histórico)

---

## Conceito proposto

Plataforma de mensagens dentro do TenisCash com **duas dimensões coexistentes**:

### Dimensão 1 — "Conversas" (memória individual)

Mensagens diretas entre pessoas, ou entre pessoa e loja. Persistem indefinidamente no banco (auditoria 100%). Cada usuário controla o que vê do seu lado. Apagar pros dois é permitido apenas dentro de uma janela curta (proposta: 2 horas) — depois disso, cada um só apaga pro próprio lado.

Princípios:
- Toda mensagem é importante (sem níveis de prioridade, sem hierarquia)
- Sistema nunca deleta
- Usuário tem agência sobre o que ele vê
- Lojas conversam com clientes pelos mesmos canais que pessoas conversam entre si (sem distinção visual brutal)

### Dimensão 2 — "Como está o dia hoje?" (memória coletiva efêmera)

Espaço de timeline com dois subtipos:
- **Pública**: aberta a todos os usuários da plataforma
- **Privadas**: ilimitadas. Cada usuário cria quantas quiser, convida quem quiser (por telefone, nome cadastrado ou username). Família, amigos próximos, time esportivo, parceiros — círculos íntimos por contexto.

**Regras fundamentais**:
- Posts somem para todos às 00:00 do dia seguinte (zero arquivo público)
- Sem like, sem comentário, sem reaction visual
- Reação só pode acontecer numa forma: abrir Conversas e mandar mensagem direta
- Conteúdo: texto, foto, áudio
- Editar e apagar livre até 00:00

A consequência psicológica esperada:
- Quem posta não é avaliado em público (sem métricas de validação)
- Quem se importa investe esforço deliberado (mandar DM)
- Acaba a economia de curtidas performáticas
- Vira diário coletivo da plataforma

---

## Mecanismos psicológicos hipotetizados

| Mecanismo | Como funciona | Onde já existe |
|-----------|--------------|----------------|
| **Reset diário** (00:00 zera tudo) | Elimina culto ao histórico, libera expressão sem peso | Snapchat parcial (msgs somem após leitura); ninguém aplica em timeline coletiva |
| **Ausência de reaction pública** | Reação genuína vira ação (DM), não símbolo | Path (rede social fracassada de 2010); nenhum app mainstream atual |
| **Círculos íntimos ilimitados** | Pessoa segmenta sua expressão por audiência sem fricção | "Close Friends" do Instagram (limite de 1 lista); Path (limite 50 pessoas total) |
| **Reação como esforço, não clique** | Curadoria natural de quem realmente importa | Nenhum app aplica deliberadamente |
| **Memória individual vs coletiva separadas** | DMs persistem, timeline coletiva é descartável | Snapchat (parcial: Memories opt-in); inexistente em outros |

---

## Perguntas de pesquisa

### 1. Comportamento humano
- O que motiva uma pessoa a postar sem feedback público? Validar com pesquisa qualitativa: pessoas escreveriam um diário público se soubessem que ninguém vai curtir?
- A ausência total de métricas de validação reduz ansiedade e aumenta autenticidade ou reduz engajamento ao ponto de ninguém postar?
- O reset diário é libertador (sem peso) ou frustrante (perdi o que escrevi)?
- Quantos círculos íntimos uma pessoa consegue manter ativamente sem se exaurir? (Dunbar's number variantes: 5 / 15 / 50 / 150)

### 2. Casos de uso prováveis
Quais tipos de conteúdo as pessoas postariam num espaço sem curtida?
- Hipóteses: desabafos, agradecimentos religiosos, marcos pessoais, observações cotidianas, declarações de afeto, relatos de exercício
- Pesquisar: diários físicos populares no Brasil (5 minutos, gratidão), apps de journaling (Day One, Reflectly), comunidades religiosas
- Validar se o público da Sports & Tennis (varejo esportivo, classe B/C, 18-45 anos, Paraíba) usa journaling ou tem rejeição cultural

### 3. Substituição de grupos
WhatsApp tem mais de 50 grupos por usuário ativo em média no Brasil. Grupos viraram fonte de exaustão.
- A timeline privada (sem chat ativo, só posts) substitui grupos pra fins sociais?
- Pra fins funcionais (combinar encontro, organizar evento), o que substitui?
- Como evitar que a timeline privada vire o "grupo da família" reformatado?

### 4. Economia da plataforma
- Sem ads e sem assinatura, qual é o modelo? Subsídio do varejo (cashback, comércio integrado)?
- Como medir sucesso sem vanity metrics (likes)? Propostas:
  - **Retenção** (D7, D30)
  - **Streak médio** de dias ativos
  - **Conversas iniciadas** após post na timeline (mede se reação genuína acontece)
  - **NPS / Satisfação subjetiva** ("você se sente menos ansioso com esse app?")
- Como precificar comércio integrado (vendedor manda card de produto no DM)?

### 5. Riscos
- **Risco de ninguém postar** (sem dopamina de like, esforço sem retorno aparente). Como contornar? Cashback diário só por abrir?
- **Risco de virar deserto público** (timeline pública vazia por inibição). Como semear?
- **Risco de privacidade** (timeline privada com 200 pessoas vira grupo de WhatsApp 2.0). Tem que limitar?
- **Risco regulatório** (LGPD, conteúdo gerado por usuário, moderação). Como tratar?
- **Risco de dependência tóxica** (alguém posta dor todo dia esperando que alguém mande DM, ninguém manda, espiral negativa). Como detectar e intervir?

### 6. Tecnologia
- Performance: timeline pública com 6.000 usuários ativos postando 0.5 vezes/dia = 3.000 posts/dia. Escala simples. Mas e se virar 60.000 usuários?
- Storage de mídia (foto + áudio) que some em 24h: opera com Railway Volume, AWS S3 com lifecycle policy, ou Cloudinary?
- Notificação dentro do app (sem push OS) funciona em PWA? Em iOS o PWA tem limitações de notificação?

---

## Referências pra estudo comparativo

Apps que tentaram caminhos similares:

- **Path** (2010-2018): rede social limitada a 50 amigos, sem algoritmo. Fracassou comercialmente — modelo de negócio inviável, mas formato amado pelos usuários.
- **Snapchat**: pioneiro do efêmero. Stories (24h) e msgs (apagam após leitura). Aplicou em msgs individuais, não em timeline coletiva.
- **BeReal**: tentou romper performance com foto cândida 1x/dia. Cresceu rápido, perdeu tração — dificuldade de retenção sem mecanismo de validação.
- **Locket**: widget no celular com foto do parceiro/amigo. Íntimo, sem feed. Modelo de relação 1-1 não escala pra grupos.
- **Instagram Close Friends**: lista única, posts efêmeros. Limitação: 1 lista só, formato de stories padrão.
- **Vibras / Marco Polo**: vídeos curtos entre amigos. Não conseguiu escalar.
- **Vent / Sanvello**: apps de saúde mental com posts anônimos sem reação pública. Validam tese de "expressão sem julgamento" mas em outro nicho.

Estudar especificamente:
- Por que Path falhou apesar do produto ser amado?
- Por que BeReal não reteve apesar de viralizar?
- O que Snapchat fez certo em manter usuários em modelo efêmero por anos?

---

## Diferencial competitivo do TenisCash

A plataforma é parte de um ecossistema fechado (varejo + cashback + app esportivo APEX). Isso muda o modelo:

- **Receita não vem do app**: ela vem da venda em loja física e ecommerce. App é canal de **retenção**, não de monetização direta.
- **Comércio integrado**: vendedor pode mandar card de produto no DM. Cliente reserva, vai na loja, compra. Comércio acontece **na conversa**, não no feed.
- **APEX integrado** (em construção): treino físico gera badge + cashback. Atividade vira post automático na timeline. Compra de tênis libera badge de atleta.
- **Loja física como ancoragem**: cliente entra na loja, faz check-in via app, vira post de timeline. Loja física = parte do produto digital.

Isso é algo que app de mensagem puro (WhatsApp, Telegram, Instagram) **não pode replicar** sem ser empresa de varejo.

---

## Perguntas finais pra trazer da pesquisa

1. **Validar o conceito de "ausência total de reaction"** com público brasileiro (entrevistas qualitativas com 20-30 pessoas)
2. **Mapear o que postariam** se não houvesse curtida (taxonomia de conteúdo provável)
3. **Estudar Path em profundidade**: por que produto adorado fracassou? Lições?
4. **Testar reset diário em protótipo de papel**: pessoas escrevem em papel à mão, papel é destruído à noite. Como se sentem após 7 dias?
5. **Comparar engajamento** entre Stories tradicionais (24h) e timeline pública diária (zerando 00:00)
6. **Avaliar impacto LGPD/jurídico** de "deletar do front" vs "preservar no banco"
7. **Investigar arquitetura técnica** de Snapchat e BeReal pra entender storage eficiente de mídia efêmera

---

## Status do conceito

Decisões fundamentais já tomadas pelo dono (Douglas Bernardo, Sports & Tennis):

| Decisão | Status |
|---------|--------|
| Construir interno (não usar WhatsApp API) | ✅ confirmado |
| Timeline com reset 00:00 | ✅ confirmado |
| Privadas ilimitadas, convidando N pessoas | ✅ confirmado |
| Sem like/comentário/reaction | ✅ confirmado |
| Reação = abrir Conversas e mandar DM | ✅ confirmado |
| Conversas (DM) persistem para sempre | ✅ confirmado |
| Apagar DM: 2h pros dois, depois só pro lado | ✅ confirmado |
| Hard delete no banco: NUNCA (auditoria) | ✅ confirmado |
| Tipos de mídia: texto, foto, áudio | ✅ confirmado |
| Push notification: apenas interna (não OS) | ✅ confirmado |

Pendente de pesquisa antes da implementação:
- Validação qualitativa do conceito com clientes reais
- Modelagem psicológica dos riscos (dependência, espiral negativa)
- Estudo comparativo aprofundado de Path / BeReal / Snapchat
- Análise jurídica LGPD

---

*Documento preparado para apresentar a pesquisadores, consultores de produto ou ferramentas de pesquisa aprofundada (Deep Research / agentes IA especializados).*
