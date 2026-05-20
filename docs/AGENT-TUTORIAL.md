# Tutorial fácil — Como criar e usar um agente

Guia prático pra criar um agente novo na Central IA Sports & Tennis e colocá-lo pra rodar. Usa exatamente o mesmo padrão dos 18 agentes que já existem em `.claude/agents/`.

---

## 1. O que é um agente?

Um arquivo `.md` em `.claude/agents/` com instruções pro Claude. Cada agente tem:

- **Identidade** (nome + descrição)
- **Tools liberadas** (Read, Write, Bash, etc.)
- **Conhecimento de domínio** (o que ele sabe fazer)
- **Output esperado** (estrutura da resposta)

O `retail-orchestrator` é quem aciona os outros via Task tool. Você raramente chama um especialista direto.

---

## 2. Criar um agente em 4 passos

### Passo 1 — Criar o arquivo

```bash
touch .claude/agents/meu-agente.md
```

Nome do arquivo = nome do agente. Use `kebab-case` (`finance-agent`, não `FinanceAgent`).

### Passo 2 — Frontmatter (obrigatório)

Toda primeira linha precisa ser esse bloco YAML:

```yaml
---
name: meu-agente
description: Use pra [quando acionar]. Frase única, objetiva, em PT-BR.
tools: Read, Write, Edit
---
```

Regras:

| Campo | Regra |
|---|---|
| `name` | Exatamente igual ao nome do arquivo |
| `description` | Começa com "Use pra...". É o que o orquestrador lê pra decidir se aciona ele |
| `tools` | Lista mínima. Só dê Bash se for executar comandos. Só dê Task se for orquestrar outros agentes |
| `model` (opcional) | `sonnet`, `opus` ou `haiku`. Padrão herda do pai |

### Passo 3 — Corpo do agente

Estrutura recomendada (espelha o padrão do projeto):

```markdown
# Nome do Agente — Função

Frase de 1 linha sobre o que ele é e pra quem.

## Quando me aciona
- Caso 1
- Caso 2

## Conhecimento de domínio
[regras, tabelas, scripts, checklists que o agente precisa saber]

## Output padrão
\`\`\`
[estrutura fixa da resposta]
\`\`\`

## Regras absolutas
- Nunca [coisa proibida]
- Sempre [coisa obrigatória]
```

### Passo 4 — Conectar ao orquestrador

Abre `.claude/agents/retail-orchestrator.md` e adiciona uma linha na tabela "Roteador de decisão":

```markdown
| [Tipo de demanda] | `meu-agente` |
```

Se o agente entra em algum workflow ("Segunda de manhã", "Campanha flash", etc.), inclui ele na ordem.

---

## 3. Exemplo completo — `promo-flash-agent`

```markdown
---
name: promo-flash-agent
description: Use pra criar promoções relâmpago (24-48h) com gatilho de urgência. Calcula desconto seguro, gera copy e define canais.
tools: Read, Write, Edit
---

# Promo Flash Agent — Promoção Relâmpago

Especialista em promoção curta com urgência real. Não substitui campanha estratégica.

## Quando me aciona
- Estoque parado >60 dias precisa girar rápido
- Concorrente fez ação agressiva e precisa reagir
- Data com tráfego natural (feriado, Black Friday Lite)

## Regras de desconto
- Máximo 15% sem pricing-margin-agent validar
- Margem final nunca abaixo de 18%
- Sempre com prazo explícito ("hoje até 22h", não "por tempo limitado")

## Output padrão
\`\`\`
PROMO FLASH — [PRODUTO]
Desconto: [X%] (de R$Y por R$Z)
Validade: [HH:MM até HH:MM]
Canais: WhatsApp + Instagram Story
Copy WhatsApp: [texto]
Copy Story: [texto]
Estoque comprometido: [N] unidades
\`\`\`

## Regras absolutas
- Nunca prometo estoque que não existe (consulta stock-agent antes)
- Nunca aprovo sem safety-agent revisar
```

---

## 4. Como usar o agente

### Forma 1 — Via orquestrador (recomendado)

Você fala em linguagem natural com o Claude. Ele decide acionar.

> "Tenho 30 pares parados do Mizuno Wave Prophecy 12. Cria uma promo flash pra hoje."

O `retail-orchestrator` lê a demanda → roteia pra `promo-flash-agent` → coordena com `stock-agent` + `pricing-margin-agent` + `safety-agent` → te entrega o plano final.

### Forma 2 — Acionar direto

Quando você sabe exatamente qual agente quer:

> "Aciona o promo-flash-agent pro Mizuno Wave 12."

Claude usa a Task tool com `subagent_type: promo-flash-agent`.

### Forma 3 — Via skill

Se vira workflow recorrente, vira skill em `.claude/skills/<nome>/SKILL.md`. Skills são chamadas com `/nome-skill`.

---

## 5. Testar o agente

```
Aciona o [meu-agente] pra [caso de teste]. Mostra o output completo antes de executar nada.
```

Verifica:

- [ ] Output segue a estrutura que você definiu?
- [ ] Respeita as "regras absolutas"?
- [ ] Aciona os agentes dependentes (safety, finance) quando precisa?
- [ ] Pede aprovação humana antes de algo irreversível?

Se falhar em algum item, ajusta o `.md` e testa de novo. Não precisa reiniciar nada — o Claude relê o arquivo a cada sessão.

---

## 6. Checklist antes de commitar

- [ ] `name` igual ao nome do arquivo
- [ ] `description` começa com "Use pra"
- [ ] `tools` no mínimo necessário
- [ ] Tem "Output padrão" definido
- [ ] Tem "Regras absolutas"
- [ ] Adicionado ao roteador do `retail-orchestrator`
- [ ] Testado com 1 caso real

---

## 7. Erros comuns

| Erro | Sintoma | Correção |
|---|---|---|
| Description vaga | Orquestrador nunca aciona o agente | Reescreve começando com "Use pra..." |
| Tools demais | Agente faz coisa que não devia | Tira tools desnecessárias |
| Sem output padrão | Resposta varia toda vez | Define template fixo em ```` ``` ```` |
| Sem regra absoluta | Agente quebra governança | Adiciona seção "Regras absolutas" |
| Não está no roteador | Orquestrador não sabe que existe | Adiciona linha na tabela de roteamento |

---

## Onde ver exemplos

Todos os 18 agentes ativos: `.claude/agents/`.

Os mais didáticos pra copiar a estrutura:

- `sales-agent.md` — curto, foco em scripts
- `safety-agent.md` — foco em checklist
- `stock-agent.md` — foco em análise de dados
- `retail-orchestrator.md` — referência pra criar orquestradores
