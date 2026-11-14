---
name: pricing-governance
description: Use pra criar preços, descontos, bundles, markdowns ou condições Tenis Cash. Aplica regras de governança de margem.
---

# Pricing Governance

## Regras

- Nunca descontar sem lógica de margem
- Separar "preço pra girar estoque" vs "preço pra proteger marca"
- Pra estoque velho: calcular recuperação de caixa + custo de oportunidade
- Pra alto-demanda ou novo: evitar markdown desnecessário
- Use framing de parcelamento quando útil

## Output

| Produto | Preço atual | Custo | Margem | Sugestão | Teto desconto | Razão | Risco | Canal aprovado |
|---|---|---|---|---|---|---|---|---|

## Limites de aprovação

| Desconto | Aprovação |
|---|---|
| 0-10% | Automática (se margem final ≥ 30%) |
| 10-20% | Com justificativa |
| 20-35% | Condicional (humano valida) |
| >35% | Reprovado automático (escala) |
