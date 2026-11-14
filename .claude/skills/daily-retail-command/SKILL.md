---
name: daily-retail-command
description: Gera o comando comercial do dia pras lojas Sports & Tennis. Use quando o usuário pedir "plano do dia", "rotina de hoje", "meta diária", "briefing da equipe" ou "execução do dia".
---

# Daily Retail Command

Use pra montar o plano executável do dia.

## Inputs

- Vendas de ontem (consultar `finance-agent` ou `report-agent`)
- Estoque crítico (consultar `stock-agent`)
- Campanha ativa
- Tráfego previsto (clima, eventos)
- Produtos a empurrar
- Equipe escalada

## Output

1. **Objetivo comercial do dia** (R$ X)
2. **Lista de produtos foco** (3 SKUs)
3. **Execução loja a loja** (Bessa, Tambaú, RB, Tambiá)
4. **Ação WhatsApp** (mensagem pra base segmentada)
5. **Ação Instagram** (story + feed)
6. **Script do vendedor** (3 abordagens)
7. **Trigger de intervenção de meio-dia** (se vendeu <50% até 12h, ativar plano B)
8. **Template do relatório de fechamento**
