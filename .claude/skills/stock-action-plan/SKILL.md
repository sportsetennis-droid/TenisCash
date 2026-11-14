---
name: stock-action-plan
description: Use pra transformar dados de estoque em plano executável de transferência, markdown, campanha e ação do vendedor. Aciona stock-agent + pricing-margin-agent.
---

# Stock Action Plan

## Workflow

1. Classifica estoque por idade e categoria
2. Identifica capital preso de alto valor
3. Detecta tamanhos faltando e problemas de grade
4. Escolhe melhor ação por SKU: full price, campanha, bundle, transferência, markdown, live, ecommerce
5. Cria pontos de fala pro vendedor

## Output em tabela

| SKU | Problema | Causa | Ação | Preço/Oferta | Canal | Responsável | KPI |
|---|---|---|---|---|---|---|---|

## Critérios

- 0-30 dias: Novo (full price)
- 31-60 dias: Watch (campanha leve)
- 61-90 dias: Risk (markdown 10-15%)
- 91+ dias: Critical (liquidação ou bundle)
