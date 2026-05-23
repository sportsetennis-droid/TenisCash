# Sistema de Mensagens TenisCash

## O que é

Uma plataforma de comunicação dentro do app TenisCash, construída para substituir o uso de WhatsApp no relacionamento entre a Sports & Tennis (lojas, vendedores), os clientes e os clientes entre si.

O sistema tem dois espaços diferentes que coexistem na mesma tela inicial:

- **Conversas** — onde mensagens entre duas pessoas vivem e ficam guardadas
- **Como está o dia hoje?** — onde cada pessoa compartilha seu dia em texto, foto ou áudio. Tudo o que é postado aqui some à meia-noite

Esses dois espaços nunca se misturam. Conversa é memória, timeline é presente.

---

## Para quem é

- **Clientes finais** que compram nas lojas físicas Sports & Tennis ou no ecommerce, e que têm cadastro no TenisCash
- **Vendedores** das 4 lojas (Bessa, Tambaú, Rainha da Borborema, Tambiá)
- **Administradores** das lojas (gerentes, donos)
- **As próprias lojas**, que aparecem como remetentes oficiais nas conversas

Todo mundo usa o mesmo app. A diferença é o que cada perfil vê e pode fazer.

---

## Como o usuário entra

O cliente já existe no banco de dados do TenisCash (cadastrou ao comprar pela primeira vez, recebeu PIN por SMS). Ele abre o app, entra com telefone + PIN, e a partir daí tem acesso ao Mensagens.

No primeiro acesso ao Mensagens, ele vê:
- A timeline pública "Como está o dia hoje?" — com posts de outros clientes, vendedores, lojas
- As Conversas vazias (até receber a primeira mensagem da loja ou mandar pra alguém)

---

## A tela principal

Quando o usuário abre o Mensagens, vê duas abas no topo:

```
[💬 Conversas]   [📓 Como está o dia hoje?]
```

Em cada aba aparece um número quando há algo novo:

```
[💬 Conversas (3)]   [📓 Como está o dia hoje? (2)]
```

Significa: 3 mensagens novas para ler em Conversas, e 2 timelines com posts não lidos.

---

## Conversas

É onde a vida íntima da comunicação acontece — entre o cliente e o vendedor, entre o cliente e a loja, entre clientes entre si.

### O que aparece

Uma lista vertical. Cada linha é uma conversa em andamento:

```
💬 João Silva (vendedor Bessa)        ontem 14:30
   "Reservei o tênis na sua medida..."  • 1 não lida

🏪 Sports & Tennis Bessa              hoje 09:00
   "Sua reserva expira amanhã"          • 1 não lida

💬 Ana Souza                          hoje 12:00
   "Bora correr sábado?"
```

A pessoa clica numa linha → entra na conversa.

### Dentro da conversa

Bolhas tradicionais: o que ela enviou à direita, o que recebeu à esquerda. Cada mensagem com horário.

Pode mandar:
- **Texto**
- **Foto** (tira na hora ou escolhe da galeria)
- **Áudio** (segura o botão e fala, igual gravador de voz)

### Apagar mensagem

Se a pessoa enviou e quer apagar:

- Até 2 horas depois → ela escolhe "Apagar pros dois". Some na tela dela e na tela do outro.
- Depois de 2 horas → só consegue "Apagar pra mim". Some na tela dela, o outro continua vendo.

Mensagem recebida (que não foi a pessoa quem mandou): sempre só apaga pro lado dela mesma. Não tira da tela do remetente.

**No banco de dados, nenhuma mensagem é apagada de verdade.** Todas ficam guardadas pra sempre, mesmo que invisíveis na tela. Isso garante auditoria — se um dia precisar provar o que foi dito (questão jurídica, fiscal, suporte), está lá.

### Mensagem da loja

Quando uma loja manda mensagem (reserva, oferta, cobrança de cashback, suporte), aparece como conversa normal — só com um ícone diferente identificando que é a loja, não uma pessoa.

O cliente pode apagar do lado dele, exatamente como apagaria mensagem de outra pessoa. Mas a loja vê a mensagem original sempre, e o registro fica no banco.

---

## Como está o dia hoje?

É o espaço onde a pessoa expressa o seu dia. Sem like, sem comentário, sem reação visível.

### O conceito

Toda meia-noite (00:00), tudo o que foi postado nas timelines durante o dia desaparece da tela. O ontem morreu. O hoje começa do zero.

Quem se importou com algo que viu, sai dali e abre Conversas para falar com a pessoa diretamente. A reação vira ato — não emoji.

### As timelines

Cada pessoa participa de duas categorias:

**Timeline Pública**
- Aberta a todos os usuários TenisCash
- Pessoa posta lá quando quer compartilhar com o universo
- Vendedor da loja pode postar lá uma novidade, um look, uma vibe da loja
- A loja também pode postar (anúncio de evento, abertura, treino em grupo)

**Timelines Privadas**
- A pessoa cria quantas quiser
- Cada uma tem um nome (Família, Time de Vôlei, Amigos da Loja, etc)
- Convida outras pessoas pra participar
- Só quem foi convidado vê
- Convite acontece de 3 formas: pelo número de telefone do contato, pelo nome salvo (se já cadastrado no TenisCash), ou por username (apelido único que cada pessoa escolhe pra si dentro do app)

### Como aparece na tela

```
Como está o dia hoje?
─────────────────────────

[🌍 Geral]  [Família •]  [Time Bessa •]  [+ criar nova]

────── Família ──────

Carlos · 09:14
"Treino de hoje foi pesado. Mas terminei a corrida de 5km."
        [foto da corrida]

Mãe · 11:30
"Bolo de cenoura no forno. Quem quer?"

Ana · 14:30
"Bessa cheia hoje. Bom dia pra Sports & Tennis."

────── escrever ──────

✍️ O que você quer compartilhar do seu dia?
[texto / 📷 foto / 🎤 áudio]

⏰ Tudo aqui some às 00:00
```

### O que pode postar

- **Texto curto ou longo**
- **Foto** (uma por post)
- **Áudio gravado** (até 2 minutos, por exemplo)

### Editar e apagar post

A qualquer momento, até 00:00, a pessoa pode:
- **Editar** (corrigir erro de escrita, melhorar a frase)
- **Apagar** (se arrependeu)

Depois das 00:00, o post some sozinho — pra ela e pra todos. Não precisa fazer nada.

### Não tem like, não tem comentário

Esse é o ponto central. Numa timeline tradicional (Instagram, Facebook), cada post acumula likes, virando métrica de validação pública. Quem não recebe likes se sente excluído. Quem só dá like sem ler vira ruído.

Aqui não tem. O post fica ali. Quem leu, leu. Quem se sensibilizou, abre Conversas e manda mensagem pra pessoa. Ninguém é contado, ninguém compara, ninguém vê quem leu seu post.

### Notificação de timeline

Quando alguém posta em uma timeline que a pessoa participa, aparece um círculo azul ao lado do nome da timeline (Família •), indicando "tem coisa nova". Igual email com badge.

Quando a pessoa abre essa timeline, marca como lida — o círculo some.

---

## A integração com o resto do TenisCash

O sistema de mensagens não vive sozinho. Ele se conecta com outros pedaços do TenisCash:

### Cashback
Quando o cliente ganha cashback (compra na loja, treino no APEX, badge desbloqueado), aparece uma mensagem da loja na aba Conversas. Tipo: "Sports & Tennis Bessa: você ganhou R$ 12,40 em TenisCash pela compra de hoje".

### Reservas
Vendedor reservou um par na medida do cliente. Vai por Conversas, com botão "Confirmar reserva" embutido na mensagem. O cliente confirma direto, sem sair da conversa.

### Lojas postam novidades
Cada loja pode postar na timeline pública. Tipo "Chegou Asics novo, dá uma passada". A pessoa que se interessar abre Conversas e fala com o vendedor da loja específica.

### APEX (app esportivo)
Quando o cliente completa um treino no APEX, o sistema automaticamente posta na timeline privada que ele escolher (Família, Time de Corrida). Compartilha o feito sem ele precisar escrever.

### Comércio dentro da conversa
Vendedor pode mandar um card de produto no DM — foto, preço, tamanhos disponíveis na loja certa. O cliente toca no card e tem botão de reservar, perguntar disponibilidade, ou abrir no ecommerce.

---

## Como uma pessoa vive o dia no sistema

**Manhã.** Acorda, abre o app. A timeline Família tem 3 posts novos do dia anterior — ah não, ontem morreu. A timeline está limpa. O irmão postou às 06:30 que foi correr. A pessoa lê, sorri, vai pra Conversas e manda mensagem pro irmão: "Que orgulho!". Não tem like pra dar.

**Meio-dia.** Recebe notificação: a loja Bessa mandou mensagem — Asics novo chegou. Vai em Conversas, vê foto do produto. Manda áudio pro vendedor: "Tem na 38? Vou passar à tarde".

**Tarde.** Posta na pública: "Indo pra Bessa, alguém quer me encontrar?". 2 conhecidos veem, um manda DM "tô lá em 1 hora, te encontro". Encontram, conversam, compram.

**Noite.** Posta no privado da Família uma foto da bicicleta: "Comprei o que prometi". Mãe vê, manda DM dizendo "Estou orgulhosa". Sem like, mensagem pessoal.

**Madrugada.** 00:00. Timeline some. O dia foi.

---

## Quem pode fazer o quê

| Ação | Cliente | Vendedor | Loja (sistema) | Admin |
|------|---------|----------|----------------|-------|
| Mandar DM pra outra pessoa | Sim | Sim | — | Sim |
| Mandar DM em nome da loja | — | Sim | Sim | Sim |
| Receber DM da loja | Sim | — | — | — |
| Postar na timeline pública | Sim | Sim | Sim | Sim |
| Criar timeline privada | Sim | Sim | — | Sim |
| Apagar próprio post (até 00:00) | Sim | Sim | Sim | Sim |
| Apagar mensagem do outro lado | — | — | — | — |
| Apagar mensagem do próprio lado | Sim | Sim | — | Sim |
| Mandar foto / áudio | Sim | Sim | Sim | Sim |
| Convidar pra timeline privada | Sim | Sim | — | Sim |

---

## Notificações

Tudo acontece dentro do app. Não usa push do sistema operacional (sem dependência de Apple/Google).

A pessoa vê notificação quando:
- Recebe mensagem nova em Conversas → contador na aba sobe
- Alguém posta em timeline que ela participa → círculo azul ao lado do nome da timeline
- Loja mandou alguma coisa pra ela → contador em Conversas

Quando a pessoa abre o app, a notificação some. Se não abrir, o contador continua subindo. Não tem barulho, vibração, popup na tela bloqueada — tudo é só dentro do TenisCash mesmo.

---

## Por que isso difere do WhatsApp

| Aspecto | WhatsApp | TenisCash Mensagens |
|---------|----------|---------------------|
| Onde os dados ficam | Servidores da Meta | Banco do TenisCash |
| Quem controla o número | Meta | A própria empresa |
| Grupos | Existem, podem ter 1024 pessoas | Não existem grupos — existem timelines privadas (sem chat ativo) |
| Like/Reaction | Tem emoji rápido em status | Não tem — reação é DM |
| Posts duram | Para sempre (status 24h) | Timeline some 00:00 |
| Histórico | Pode perder se trocar de celular | Sempre preservado no banco |
| Mídia | Pode comprimir, viraliza fácil | Controlado, dentro do escopo da Sports & Tennis |
| Integração com loja física | Nenhuma, é genérico | Total — cashback, reserva, APEX, ecommerce |

---

## O que está fora desse sistema (intencional)

- Não tem grupo tradicional com chat ativo (substituído pela timeline privada)
- Não tem like, coração, reaction visual
- Não tem comentário público
- Não tem stories tradicionais (substituídos pela timeline diária)
- Não tem ligação de voz/vídeo
- Não tem encaminhar mensagem
- Não tem mensagem editada com histórico visível
- Não usa push do sistema operacional do celular

Esses ausentes não são limitações técnicas — são decisões. O sistema é desenhado pra que ninguém precise deles.

---

## Estado atual do projeto

Conceito definido com o dono (Douglas Bernardo, Sports & Tennis).
Decisões fundamentais aprovadas.
Documento técnico de implementação preparado separadamente.
Aguardando o início do desenvolvimento.
