# Rede Neural de Agentes (RNA) — arquitetura completa

> Muitos **mini agentes**, cada um com **uma responsabilidade só**, ligados como
> neurônios. Um sinal (uma NF-e que chegou, uma venda, uma pergunta do dono)
> entra pela borda e **só acende os agentes que aquele sinal precisa**, do mais
> barato pro mais caro, até cumprir um **objetivo**. O que o dono aprova ou
> rejeita ajusta os "pesos" — a rede aprende.

---

## 0. Para o dono, em 6 linhas

1. Em vez de 13 agentes "faz-tudo", a empresa ganha **dezenas de mini agentes** de tarefa única (ex.: "acha produto sem foto", "confere preço abaixo do custo", "monta rascunho de WhatsApp").
2. Eles ficam **dormindo** (custo zero) e só **acordam quando há sinal** — igual neurônio.
3. A ativação é **gradativa**: primeiro regra simples (grátis), depois IA barata, IA forte só se o caso pedir, e **você** só quando mexe em preço, cliente ou dinheiro.
4. Você dá um **objetivo** ("girar o Nike parado da Tambaú em 30 dias") e a rede acende só a região que serve a ele, com orçamento de IA definido.
5. Cada "sim/não/edita" seu muda os pesos: o que acerta ganha força, o que erra perde e acaba **podado**; correção que você repete vira **regra nova**.
6. Tudo fica registrado: quem acendeu, por quê, quanto custou, o que propôs, o que você decidiu.

---

## 1. A analogia, peça por peça

| Rede neural | Na RNA do TenisCash | Exemplo |
|---|---|---|
| Neurônio | **Mini agente** com 1 responsabilidade, entrada e saída fixas | `nuvem.sem-foto` |
| Entrada da rede | **Sensor**: evento do sistema, horário ou pergunta do dono | NF-e importada, webhook Nuvemshop, bipe, venda, mensagem WhatsApp |
| Sinapse | **Ligação** "saída do agente A alimenta o agente B" | `estoque.ruptura-grade` → `compra.sugestao-reposicao` |
| Peso | **Confiança aprendida** daquela ligação (0–1) | sobe quando o dono aprova o que a ligação produziu |
| Limiar de ativação | **Necessidade mínima** pro agente acordar | só roda se impacto ≥ R$ 300 **ou** força do sinal ≥ 0,6 |
| Função de ativação | **Decisão de acender**: força × peso ≥ limiar e cabe no orçamento | — |
| Camadas | **Níveis de custo/poder**: sensor → detector (regra) → analista (IA barata) → especialista (IA forte) → atuador (ferramenta) → dono | — |
| Função objetivo | **Objetivo do dono** compilado em KPI (margem, giro, venda, NPS) | "+20% giro Nike Tambaú em 30 dias" |
| Atenção | **Região pré-ativada** pelo objetivo (baixa limiar dos neurônios relevantes) | objetivo de giro baixa o limiar de estoque/preço/marketing daquela loja |
| Treino / retropropagação | **Feedback** do dono + **resultado medido** do KPI ajustam pesos e limiares | aprovado: peso ↑; rejeitado: peso ↓ |
| Poda (pruning) | Neurônio que nunca acerta ou nunca é usado é **desligado** | — |
| Crescimento | Correção repetida 3× vira **neurônio/regra nova** | "nunca chutar tamanho" virou trava |
| Dropout / mistura de especialistas | **Ativação esparsa**: num sinal, só uma fração mínima da rede acende | um bipe acende 2–4 neurônios, não 60 |

---

## 2. Visão geral

```
 SENSORES (custo 0)            DETECTORES (regra/SQL, custo 0)      ANALISTAS (IA barata)        ESPECIALISTAS (IA forte)      ATUADORES (ferramentas)          DONO
 ─────────────────            ───────────────────────────────      ────────────────────         ────────────────────────      ───────────────────────          ────
 NF-e importada  ──┐          nfe.item-sem-card     ──┐             compra.reposicao  ──┐        preco.plano-markdown ──┐       mcp.ler (livre)                 aprova
 Venda (PDV)     ──┤          estoque.ruptura-grade ──┤             crm.segmento      ──┤        mkt.campanha         ──┤       mcp.propor → AIApproval  ───►  edita
 Bipe            ──┼──sinais─►nuvem.sem-foto        ──┼──sinais──►  conteudo.descricao──┼──sinais►  compra.negociacao   ──┼─────► mcp.agir (só aprovado)          rejeita
 Webhook Nuvem   ──┤          preco.abaixo-custo    ──┤             (classifica,       │        (só se impacto alto   │                                          │
 WhatsApp msg    ──┤          bipe.acima-comprado   ──┤              resume, decide     │         ou analista inseguro)│                                          │
 Relógio (cron)  ──┤          ...                   ──┘              se escala)       ──┘                            ──┘                                          │
 Pergunta dono   ──┘                                                                                                                                          │
        ▲                                                                                                                                                     │
        └──────────────────────────────── APRENDIZADO: feedback + KPI medido ajustam pesos, limiares, poda e crescimento ◄──────────────────────────────────────┘

  Em volta de TUDO:  Middleware de segurança (máscara CPF/telefone, OWASP, política dura)  ·  Orçamento por objetivo  ·  Trace/log de cada ativação
  Por baixo:         Fila pg-boss (reativo)  ·  Servidor MCP do TenisCash (sentidos e mãos)  ·  Banco Postgres (Railway)
```

**Regra de ouro da propagação:** o sinal anda da esquerda pra direita e **para assim que alguém resolve**. Se um detector (regra) já basta, nenhuma IA é chamada.

---

## 3. O mini agente (neurônio) — o contrato

Todo neurônio é **um arquivo** em `src/ai/rede/neuronios/<dominio>/<nome>.js` com este contrato:

```js
module.exports = {
  id: 'nuvem.sem-foto',                 // dominio.responsabilidade (único)
  camada: 'detector',                   // sensor | detector | analista | especialista | atuador
  missao: 'Achar produto publicado na Nuvemshop sem foto ou sem descrição.', // 1 frase, 1 responsabilidade
  escuta: ['nuvem.produto-publicado', 'relogio.diario'],  // tipos de sinal que o acordam
  emite: ['nuvem.produto-incompleto'],  // tipos de sinal que pode produzir
  limiar: 0.0,                          // necessidade mínima (0 = qualquer sinal acorda)
  custo: { tipo: 'regra' },             // regra | ia-barata | ia-forte (o motor escolhe o modelo)
  permissao: 'ler',                     // ler | propor | agir   (agir SEMPRE passa por aprovação quando toca preço/cliente/dinheiro)
  regras: ['nuvemshop-foto-descricao'], // skills/regras da casa que viajam com o neurônio
  tempoMax: 20_000,                     // ms
  async disparar({ sinal, ferramentas, quadro, orcamento }) {
    // 1) ler só o que precisa (ferramentas = MCP do TenisCash, só leitura aqui)
    // 2) decidir
    // 3) devolver sinais (ou nada)
    return [{ tipo: 'nuvem.produto-incompleto', forca: 0.9, impactoRS: 0, dados: { productId, falta: ['foto'] } }];
  },
};
```

Regras do contrato (inquebráveis):
- **Uma responsabilidade.** Se a missão precisa de "e", são dois neurônios.
- **Entrada e saída tipadas.** O neurônio só conversa por sinais; nunca chama outro neurônio direto.
- **Sem estado próprio.** O que precisa lembrar vai pro **quadro** do objetivo ou pra memória da empresa.
- **Idempotente.** O mesmo sinal processado duas vezes não duplica nada (chave = `neuronio + sinal.id`).
- **`dados.chave` obrigatória quando o neurônio emite vários sinais do mesmo tipo.** O anti-ciclo junta sinais iguais (neurônio + tipo + chave) dentro do mesmo rastro; sem chave, só o primeiro passa. A mesma chave deduplica a proposta pendente e segura a proposta **recusada** por `RNA_ESPERA_REJEITADA_DIAS` (padrão 14).
- **Helpers** dentro de `neuronios/<dominio>/` começam com `_` (não são carregados como neurônio). Regras compartilhadas ficam em `src/ai/rede/regras/`.
- **Orçamento:** `ia-forte` é barrada antes de rodar; `ia-barata` roda e só tem a IA recusada (`pensar` devolve `{ok:false, semOrcamento:true}`) quando o teto acabou — o neurônio deve cair para a regra.
- **Desconto > 15%** em `proposta.preco*`, `proposta.desconto*` ou `proposta.campanha*` (campo `descontoPct`, inclusive em `itens[]`) é barrado pela política se não vier `validacaoMargem: { agente: 'pricing-margin', ok: true }`.
- **Ação executada** que recusa na revalidação devolve `{ executado: false, motivo }` — a proposta fica `approved`, não vira `executed`.
- **Nunca inventa dado.** Faltou dado na fonte → emite `dado-faltante` e para (regra global da casa).

---

## 4. Sinais — o que corre nas sinapses

```js
{
  id: 'sig_…',              // único
  tipo: 'estoque.ruptura-grade',
  origem: 'estoque.ruptura-grade',   // neurônio ou sensor que emitiu
  forca: 0.0–1.0,           // certeza/urgência do emissor
  impactoRS: 1850,          // R$ em jogo (quando dá pra estimar) — pesa na escalada
  loja: 'LOJA05',           // opcional — escopo
  objetivoId: 'goal_…',     // opcional — a qual objetivo serve
  traceId: 'tr_…',          // costura a cadeia inteira (de que evento nasceu)
  profundidade: 3,          // quantos saltos desde o sensor (trava em 8 — evita loop)
  dados: { … },             // carga útil tipada por tipo
  criadoEm: ISODate
}
```

Famílias de tipos: `nfe.*`, `estoque.*`, `bipe.*`, `nuvem.*`, `preco.*`, `venda.*`, `crm.*`, `mkt.*`, `fin.*`, `club.*`, `seg.*`, `dono.*`, `relogio.*`, `dado-faltante`, `proposta.*` (vira aprovação), `resultado.*` (KPI medido).

---

## 5. Ativação gradativa — o algoritmo

Para cada sinal que chega, o **motor** faz:

```
1. Candidatos  = neurônios cuja lista `escuta` contém sinal.tipo  (índice em memória)
2. Para cada candidato n:
     peso      = peso da sinapse (origem → n)  [default 0.5 para ligação nova]
     atencao   = bônus do objetivo ativo que inclui n (0 a 0.3)   ← "região pré-ativada"
     ativacao  = sinal.forca × peso + atencao + f(impactoRS)       ← f cresce devagar com o R$ em jogo
     acende se ativacao ≥ n.limiar  E  orçamento do objetivo cabe o custo de n
3. Ordena os que acendem por CUSTO crescente (regra → ia-barata → ia-forte).
4. Executa em ondas:
     onda 1: todos os de custo "regra" (em paralelo, grátis)
     onda 2: "ia-barata" só para sinais que a onda 1 NÃO resolveu
     onda 3: "ia-forte" só se:  impactoRS ≥ R$ X  OU  analista devolveu confiança < 0.6  OU  o dono pediu
5. Cada saída vira novo sinal → volta ao passo 1 (profundidade+1; para em 8)
6. Sinal do tipo `proposta.*` NÃO vai pra frente: vira AIApproval e espera o dono.
7. Saída final do objetivo → resumo pro dono (WhatsApp/painel), com custo e trace.
```

**Por que é "gradativo":** a maioria dos sinais morre na onda 1 (regra resolve). IA só gasta onde precisa. É o mesmo princípio de "agente reativo" (só roda quando há trabalho) e de "mistura de especialistas" (só uma fração acende).

**Travas do motor:**
- **Orçamento** por objetivo (R$ e nº de ativações) e teto diário global → estourou, pausa e avisa o dono.
- **Profundidade** máx. 8 e **anti-ciclo** (mesmo tipo de sinal pelo mesmo neurônio no mesmo trace = descarta).
- **Tempo** por neurônio (`tempoMax`) e por objetivo.
- **Desligamento** instantâneo de qualquer neurônio pelo painel (feature flag).

---

## 6. Objetivos — a função objetivo da rede

O dono declara em linguagem natural; o neurônio `dono.objetivo` (IA forte, 1 vez) compila em:

```js
{
  id: 'goal_…',
  texto: 'Girar o Nike parado da Tambaú em 30 dias sem baixar margem abaixo de 35%',
  kpis: [{ nome: 'giro', loja: 'LOJA05', marca: 'Nike', meta: '+20%', base: 0.31 },
         { nome: 'margem_bruta', min: 0.35 }],
  regiao: ['estoque.*', 'preco.*', 'mkt.*', 'crm.*'],   // atenção: estes ganham bônus
  restricoes: ['sem desconto > 15% sem pricing', 'nada ao cliente sem aprovação'],
  orcamento: { rs: 40, ativacoesIA: 300 },
  prazo: '2026-12-17',
  status: 'ativo'
}
```

Enquanto o objetivo vive, o sensor `relogio.objetivo` dispara todo dia e os neurônios da região têm limiar menor. No fim (ou a cada semana) o neurônio `resultado.medir` compara KPI × base e gera o sinal `resultado.kpi` — é ele que treina a rede (seção 7).

---

## 7. Aprendizado — a "retropropagação" do varejo

Três fontes de sinal de treino, do mais rápido ao mais confiável:

| Fonte | Quando | Efeito |
|---|---|---|
| **Decisão do dono** na aprovação (aprovar / editar / rejeitar) | na hora | peso de **todas as sinapses do trace** que gerou a proposta: aprovar +0,05 · editar +0,01 · rejeitar −0,08 |
| **Resultado medido** (`resultado.kpi`) | fim da janela do objetivo | se o KPI melhorou acima do esperado: +0,1 nas sinapses que contribuíram; se piorou: −0,1 |
| **Uso** | contínuo | neurônio que acende e nunca resulta em nada útil por 60 dias → candidato a **poda** (o dono confirma) |

Fórmula de peso (simples, auditável): `peso ← clamp(peso + taxa × recompensa, 0.05, 0.95)`. Limiar se ajusta igual (neurônio que gera muito rejeitado sobe o próprio limiar).

**Crescimento:** quando o dono faz a **mesma correção 3 vezes** (o `learning.service` já detecta e promove), a correção vira:
- uma **regra da casa** (skill) anexada aos neurônios daquele domínio, ou
- um **neurônio detector novo** (regra pura, custo zero) — proposto ao dono, que aprova antes de entrar.

Nada de peso muda em silêncio: toda mudança grava `AjustePeso` com o motivo (trace + decisão).

---

## 8. Memória

| Camada | Onde | Para quê |
|---|---|---|
| **Quadro do objetivo** (blackboard) | tabela `RnaQuadro` (por objetivo) | fatos, hipóteses e decisões compartilhados entre os neurônios daquele objetivo |
| **Memória da empresa** | `CompanyMemory` (já existe) | eventos e fatos de longo prazo (getBrain) |
| **Regras da casa** | skills em `src/ai/rede/regras/*.md` | as regras do CLAUDE.md quebradas por assunto; cada neurônio carrega só as dele |
| **Pesos e limiares** | `RnaSinapse`, `RnaNeuronio` | o "conhecimento aprendido" da rede |

---

## 9. Ferramentas — sentidos e mãos (servidor MCP do TenisCash)

Os neurônios **não tocam o banco direto**: usam ferramentas do servidor MCP próprio (`/mcp`, SDK oficial), marcadas pelo protocolo:

| Tipo | Exemplos | Regra |
|---|---|---|
| **Leitura** (`readOnlyHint`) | `estoque.porEan`, `estoque.porLoja`, `nfe.porChave`, `vendas.doDia`, `nuvem.statusProduto`, `club.medalhas` | livre para qualquer neurônio com `permissao ≥ ler` |
| **Proposta** | `proposta.preco`, `proposta.whatsapp`, `proposta.reposicao`, `proposta.publicar` | gera `AIApproval` (já existe) com prévia; nada acontece até o "sim" |
| **Ação** (`destructiveHint`) | `nuvem.publicar`, `crm.enviarRascunhoAprovado`, `estoque.ajustarLocalizacao` | só executa **aprovação aprovada** (o executor já existe: `approval.executor`) |

As **regras duras** do CLAUDE.md viram **validação dentro da ferramenta** (não dependem do agente lembrar): excluir "SEM GTIN", transferência não cria card, comprado nunca recalcula, só publica com 4 classificações + foto + descrição + preço com markup + estoque físico.

O mesmo servidor MCP serve o **Claude do celular do dono**: ele conversa com a mesma rede.

---

## 10. Segurança — o middleware em volta de toda ativação

Toda chamada passa por um **interceptador** (padrão "validadores + mutadores" das palestras da Bloomberg / OWASP):

1. **Mutador PII:** mascara CPF, telefone, e-mail e nome de cliente antes de qualquer prompt; desmascara só na ferramenta, se autorizado.
2. **Validador de política (dura):** preço, desconto > 15%, mensagem ao cliente, dinheiro, publicação → **sempre** `proposta.*` (aprovação). Nunca ação direta.
3. **Validador de injeção:** conteúdo externo (WhatsApp, e-mail, XML de NF-e, comentário do Instagram) é **dado**, nunca instrução; neurônio que lê conteúdo externo não tem permissão `agir`.
4. **Validador anti-chute:** saída com campo que não veio da fonte (tamanho, cor, preço) é bloqueada e vira `dado-faltante`.
5. **Orçamento:** corta ao estourar.
6. **Segredos:** nenhum neurônio lê `.env`; tokens só dentro das ferramentas.

---

## 11. Execução

- **Fila:** `pg-boss` (já no projeto). Cada ativação = 1 job (`rna:ativar`) com `singletonKey = neuronio + sinal.id` (idempotência).
- **Reativo:** sensores publicam sinais nos pontos onde o evento já acontece (import de NF-e, webhook Nuvemshop, bipe, venda, mensagem); o relógio usa `node-cron` com `timezone: 'America/Fortaleza'`.
- **Concorrência:** limite por camada (regra: 20 · ia-barata: 4 · ia-forte: 1) e por loja.
- **Falha:** 2 tentativas com espera; falhou → sinal `seg.neuronio-falhou` (aparece no painel), cadeia segue sem ele.
- **Modelos:** o motor escolhe pelo `custo` do neurônio — `ia-barata` = modelo rápido, `ia-forte` = modelo mais capaz (via `ai-client.js`, que já calcula custo em R$).

---

## 12. Observabilidade — ver a rede pensar

- **Trace por objetivo/evento:** árvore sensor → neurônios acesos → sinais → proposta → decisão, com custo e tempo de cada nó.
- **Mapa de calor da rede:** quais neurônios acendem mais, quais acertam (taxa de aprovação), quais custam mais.
- **Painel do dono** (mobile): objetivos ativos, propostas esperando aprovação, custo do dia, neurônios desligados/podados.
- Base técnica: `AILog` (custo/tokens) + tabelas da seção 13; opcional exportar em OpenTelemetry.

---

## 13. Modelo de dados (aditivo — `ensureApexSchema`/boot, nunca destrutivo)

```prisma
model RnaNeuronio {        // registro + estado aprendido de cada mini agente
  id          String   @id            // 'nuvem.sem-foto'
  camada      String
  ativo       Boolean  @default(true) // desligar no painel
  limiar      Float    @default(0.5)
  acertos     Int      @default(0)    // aprovados
  erros       Int      @default(0)    // rejeitados
  disparos    Int      @default(0)
  custoRS     Float    @default(0)
  ultimoUso   DateTime?
  atualizadoEm DateTime @updatedAt
}
model RnaSinapse {         // peso aprendido de cada ligação
  id      String @id @default(cuid())
  origem  String           // neurônio ou sensor
  destino String
  peso    Float  @default(0.5)
  @@unique([origem, destino])
}
model RnaSinal {           // tudo o que correu na rede (auditoria e replay)
  id         String   @id @default(cuid())
  tipo       String
  origem     String
  forca      Float
  impactoRS  Float?
  loja       String?
  objetivoId String?
  traceId    String
  profundidade Int
  dados      Json
  criadoEm   DateTime @default(now())
  @@index([traceId]) @@index([tipo, criadoEm]) @@index([objetivoId])
}
model RnaAtivacao {        // cada vez que um neurônio acendeu
  id         String   @id @default(cuid())
  neuronio   String
  sinalId    String
  traceId    String
  status     String   // ok | sem-saida | erro | bloqueado-politica | sem-orcamento
  custoRS    Float    @default(0)
  ms         Int
  saida      Json?
  criadoEm   DateTime @default(now())
  @@unique([neuronio, sinalId])   // idempotência
  @@index([traceId]) @@index([neuronio, criadoEm])
}
model RnaObjetivo {
  id        String   @id @default(cuid())
  texto     String
  kpis      Json
  regiao    String[]
  restricoes String[]
  orcamento Json
  gastoRS   Float    @default(0)
  prazo     DateTime?
  status    String   @default("ativo") // ativo | pausado | concluido | cancelado
  resultado Json?
  criadoPor String
  criadoEm  DateTime @default(now())
}
model RnaQuadro {          // blackboard do objetivo
  id         String @id @default(cuid())
  objetivoId String
  chave      String
  valor      Json
  autor      String  // neurônio
  criadoEm   DateTime @default(now())
  @@index([objetivoId, chave])
}
model RnaAjustePeso {      // todo aprendizado é auditável
  id       String @id @default(cuid())
  alvo     String   // 'sinapse:a->b' | 'limiar:neuronio'
  de       Float
  para     Float
  motivo   String   // aprovado | rejeitado | editado | kpi | poda
  traceId  String?
  aprovacaoId String?
  criadoEm DateTime @default(now())
}
```

Reaproveita: `AIApproval` (propostas), `CompanyMemory` (memória longa), `AILog` (custo por chamada), `learning.service` (promoção de regra).

---

## 14. Catálogo inicial de neurônios (v1 — 42 mini agentes)

Legenda de custo: **R** = regra/SQL (grátis) · **B** = IA barata · **F** = IA forte · **T** = atuador (ferramenta).

**Sensores (S, custo 0):** `s.nfe-importada` · `s.venda` · `s.bipe` · `s.nuvem-webhook` · `s.whatsapp-msg` · `s.relogio` (hora/dia/semana) · `s.dono-pergunta` · `s.objetivo-diario`

| Domínio | Neurônio | Camada | Escuta → Emite | Missão (1 frase) |
|---|---|---|---|---|
| NF-e | `nfe.entrada-x-transferencia` | R | nfe-importada → nfe.classificada | Classifica entrada/transferência pelo CNPJ raiz e CFOP |
| NF-e | `nfe.item-sem-card` | R | nfe.classificada → nfe.item-orfao | Acha item de entrada sem card (busca card existente antes) |
| NF-e | `nfe.formato-fornecedor` | B | nfe.item-orfao → nfe.leitura-ref | Lê ref/tamanho/cor **literal** do formato daquele fornecedor; faltou → dado-faltante |
| NF-e | `nfe.custo-medio` | R | nfe.classificada(entrada) → preco.custo-atualizado | Atualiza custo médio (só entrada) |
| Estoque | `estoque.ruptura-grade` | R | venda / relogio.diario → estoque.ruptura | Grade quebrada (tamanho-chave zerado) por loja |
| Estoque | `estoque.parado` | R | relogio.semanal → estoque.parado | Produto sem venda há N dias com estoque físico |
| Estoque | `estoque.transferencia-sugerida` | B | estoque.ruptura + estoque.parado → proposta.transferencia | Sobra numa loja, falta em outra |
| Bipe | `bipe.acima-comprado` | R | bipe → bipe.conferir-loja | Σbipes > comprado → pede conferência física (nunca apaga) |
| Bipe | `bipe.codigo-desconhecido` | R | bipe → bipe.resolver-codigo | EAN não casa → busca NF-e/aliases |
| Bipe | `bipe.tamanho-pendente` | R | bipe → dono.pendencia | Tamanho sem confirmação de caixa |
| Nuvemshop | `nuvem.sem-foto` | R | nuvem-webhook / relogio → nuvem.incompleto | Publicado sem foto/descrição |
| Nuvemshop | `nuvem.sem-classificacao` | R | idem → nuvem.incompleto | Falta uma das 4 classificações |
| Nuvemshop | `nuvem.estoque-divergente` | R | relogio.hora → nuvem.divergente | Variante com estoque ≠ Σ StoreStock |
| Nuvemshop | `nuvem.ghost` | R | nuvem-webhook → nuvem.ghost | Card-fantasma de eco de webhook |
| Nuvemshop | `nuvem.correcao` | B | nuvem.* → proposta.nuvem | Monta a correção pronta pra aprovar |
| Conteúdo | `conteudo.descricao` | B | nuvem.incompleto(descricao) → proposta.descricao | Descrição técnica a partir de dados reais do card |
| Conteúdo | `conteudo.foto-oficial` | B | nuvem.incompleto(foto) → proposta.foto | Busca foto oficial pelo código exato, valida cor |
| Preço | `preco.abaixo-custo` | R | preco.custo-atualizado / relogio → preco.alerta | Preço ≤ custo ou markup não aplicado |
| Preço | `preco.desconto-acima-15` | R | qualquer proposta.preco → seg.bloqueio | Trava >15% sem pricing |
| Preço | `preco.plano-markdown` | F | estoque.parado(impacto alto) → proposta.preco | Plano de remarcação com margem mínima |
| Vendas | `venda.meta-dia` | R | relogio(11:30/15:30) → venda.abaixo-meta | Venda <60% da meta até 15h |
| Vendas | `venda.intervencao` | B | venda.abaixo-meta → proposta.acao-loja | Ação de loja para recuperar o dia |
| CRM | `crm.cliente-sumido` | R | relogio.semanal → crm.reativar | Cliente com cashback parado / sem compra |
| CRM | `crm.segmento` | B | crm.reativar → crm.lista | Segmenta por esporte/marca/tamanho |
| CRM | `crm.rascunho-whatsapp` | B | crm.lista / whatsapp-msg → proposta.whatsapp | Rascunho (nunca envia sozinho) |
| CRM | `crm.resposta-cliente` | B | whatsapp-msg → proposta.resposta | Resposta com dado real de estoque |
| Marketing | `mkt.produto-do-dia` | R | relogio.diario → mkt.candidatos | Estoque alto + foto boa + margem ok |
| Marketing | `mkt.recebimento` | R | nfe.classificada(entrada) → mkt.chegada | Mercadoria nova → carrossel de chegada |
| Marketing | `mkt.campanha` | F | objetivo / mkt.candidatos → proposta.campanha | Campanha completa (passa pelo safety) |
| Marketing | `mkt.safety` | B | proposta.campanha → proposta.campanha(revisada) | Revisão da Constituição de Comunicação |
| Financeiro | `fin.conta-vencendo` | R | relogio.diario → dono.pendencia | Contas a pagar vencendo |
| Financeiro | `fin.margem-bridge` | B | relogio.semanal → dono.relatorio | Por que a margem mudou |
| Compras | `compra.reposicao` | B | estoque.ruptura(giro alto) → proposta.reposicao | Sugere reposição com histórico |
| Club | `club.medalha-pendente` | R | torneio-finalizado → proposta.emitir-medalhas | Final encerrada → prévia de medalhas |
| Club | `club.atleta-sem-cpf` | R | proposta.emitir-medalhas → crm.lista | Atleta bloqueado por falta de CPF |
| Segurança | `seg.pii` | R | (middleware, todo sinal) | Máscara de dados pessoais |
| Segurança | `seg.injecao` | R | conteúdo externo → seg.alerta | Detecta instrução escondida em dado externo |
| Segurança | `seg.orcamento` | R | toda ativação → seg.pausa | Corta ao estourar |
| Meta | `dono.objetivo` | F | dono-pergunta(objetivo) → objetivo.criado | Compila objetivo em KPI/região/orçamento |
| Meta | `dono.resposta` | B | dono-pergunta → dono.resposta | Responde perguntas com ferramentas de leitura |
| Meta | `resultado.medir` | R | relogio / fim objetivo → resultado.kpi | Mede KPI × base (treina a rede) |
| Meta | `rede.poda` | R | relogio.mensal → dono.pendencia | Lista neurônios inúteis para desligar |

---

## 15. Exemplo de ponta a ponta

**Evento:** chega a NF-e de entrada da Adidas (ALPAR) com 48 itens.

```
s.nfe-importada ──► nfe.entrada-x-transferencia (R) ── "entrada" ──┬─► nfe.custo-medio (R) ──► preco.custo-atualizado ──► preco.abaixo-custo (R): 2 cards com preço ≤ custo ──► proposta.preco ─► AIApproval ─► DONO
                                                                    ├─► nfe.item-sem-card (R): 6 itens órfãos ──► nfe.formato-fornecedor (B): lê ref; tamanho NÃO está na NF-e ─► dado-faltante ─► bipe.tamanho-pendente (a caixa decide)
                                                                    └─► mkt.recebimento (R) ──► mkt.chegada ──► (sem objetivo de marketing ativo: limiar não atingido, para aqui)
Custo IA: 1 chamada barata. Neurônios acesos: 7 de 42. Duas propostas esperando o dono. Nenhum dado inventado.
```

**Objetivo:** "girar o Nike parado da Tambaú em 30 dias, margem ≥ 35%" → `dono.objetivo` (F, 1×) cria região {estoque, preço, mkt, crm} da LOJA05 → todo dia `estoque.parado` acende com limiar baixo → `preco.plano-markdown` (F) só para os 5 modelos de maior R$ parado → `mkt.campanha` + `mkt.safety` → `crm.rascunho-whatsapp` para clientes que compraram Nike → tudo vira aprovação → depois de 30 dias `resultado.medir` compara giro e ajusta os pesos.

---

## 16. Como os agentes atuais entram

- Os **13 agentes de `src/ai/agents`** viram **especialistas** (camada F) ou são **quebrados** em neurônios menores. Ex.: `stock.agent` → `estoque.ruptura-grade` (R) + `estoque.parado` (R) + `estoque.transferencia-sugerida` (B).
- Os **27 agentes do `.claude/agents`** (Claude Code) continuam como **times de desenvolvimento/curadoria**; podem chamar a rede pelo MCP.
- `orchestrator.service` vira um **sensor** (`s.dono-pergunta`) + `dono.resposta`; `approval.*`, `memory.*`, `learning.*` e `ai-client` são reaproveitados como estão.

---

## 17. Construção em fases

| Fase | Entrega | Pronto quando |
|---|---|---|
| **F0 — Base** (motor) | tabelas RNA (aditivas), motor de ativação com ondas/limiar/orçamento/idempotência, fila pg-boss, middleware de segurança, trace | teste ponta a ponta com neurônios fake: sinal acende só quem deve, ondas na ordem de custo, orçamento corta, anti-ciclo funciona |
| **F1 — Primeiros sentidos e mãos** | servidor MCP do TenisCash (leitura) + ferramentas de proposta → AIApproval; 10 neurônios R de maior valor (Nuvemshop incompleto, preço ≤ custo, bipe > comprado, ruptura, NF-e órfã…) | rodando em produção 7 dias, propostas reais aprovadas pelo dono, custo de IA ~0 |
| **F2 — Inteligência gradativa** | neurônios B (correção Nuvemshop, rascunho WhatsApp, transferência, descrição) e F (markdown, campanha) + objetivos | 1 objetivo real do dono rodando com orçamento e relatório |
| **F3 — Aprendizado** | ajuste de pesos por decisão e por KPI, poda, crescimento de regra; painel mapa de calor | pesos mudando com auditoria; 1 neurônio podado e 1 regra nova promovida com aprovação do dono |
| **F4 — Escala** | catálogo completo (42+), Club/medalhas, avaliação por jornada no CI, Claude do celular conversando com a rede | jornadas críticas verdes no CI antes de cada deploy |

Cada fase segue a Constituição: teste no ambiente real, nada destrutivo no schema, nada ao cliente sem aprovação.

---

## 18. Riscos e travas

| Risco | Trava |
|---|---|
| Cascata de chamadas de IA (custo) | ondas por custo, orçamento por objetivo e diário, profundidade máx. 8 |
| Loop entre neurônios | anti-ciclo por trace + idempotência por (neurônio, sinal) |
| Agente mexendo em preço/cliente | política dura no middleware + ferramentas `destrutivas` só com aprovação |
| Dado inventado | validador anti-chute + sinal `dado-faltante` |
| Injeção via WhatsApp/XML | conteúdo externo é dado; neurônio que lê externo não tem permissão de agir |
| Aprendizado "viciado" | pesos com piso/teto (0,05–0,95), toda mudança auditada, poda só com confirmação do dono |
| Rede opaca | trace completo e painel; qualquer neurônio desligável na hora |
