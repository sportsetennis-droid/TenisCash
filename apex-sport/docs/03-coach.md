# APEX MIND — Coach IA

## Arquitetura

Diferente da hype de "coach conversacional universal", o coach é uma **camada de features ML específicas**, com chat por cima.

### Features (ordem de implementação)

| Feature | Modelo | Quando | Valor |
|---|---|---|---|
| Classificação de atividade | HAR (deep) + heurística | MVP | Auto-tag, correção |
| Detecção de anomalia | Anomaly detection híbrido | MVP | Anti-fraude, qualidade |
| Race-time prediction | Modelo explicável + intervalos | 6-12m | Coaching tangível |
| Personalização de plano | CBR + gradient boosting | 6-12m | Retenção |
| Recomendação de rotas | Ranking geoespacial | 12-24m | Descoberta |
| Coaching preditivo | Time-series forecast | 12-24m | "O que faço amanhã?" |

## Briefing diário

Input:
- Recovery score (de wearable ou calculado)
- Carga aguda vs crônica (ATL/CTL/TSB)
- Sono última noite
- HRV trend 7d
- Treino planejado (do plano)
- Clima

Output:
- Status corporal
- Recomendação: HARD / MODERATE / EASY / REST
- Dica acionável
- Encorajamento

Implementado em `aiCoach.js → dailyBriefing()`.

## Análise pós-treino

Input:
- Activity completa
- Comparação com média 30d do mesmo atleta
- Comparação com pace zones definidas

Output:
- O que aconteceu (factual)
- Insight (interpretação)
- Próximo passo (recomendação)

Implementado em `aiCoach.js → postWorkoutAnalysis()`.

## Chat

Conversacional com contexto do atleta. Sempre com disclaimer médico.

Implementado em `aiCoach.js → chat()`.

## Plano de treino estruturado

Não inventa — usa **planos científicos validados** como base:
- Pfitzinger Half Marathon Plans
- Hal Higdon Marathon Plans
- Jack Daniels Running Formula
- Joe Friel Triathlon Plans

Sistema **adapta** o plano:
- Se HRV cai > 15% → reduz intensidade
- Se atleta perde 2+ treinos consecutivos → reagenda
- Se atleta supera meta de pace consistentemente → progride mais rápido

## Limites éticos

O coach NÃO:
- Diagnostica lesões
- Prescreve nutrição (só dá insights gerais)
- Dá orientação médica
- Substitui fisioterapeuta / treinador credenciado
- Promete cura ou prevenção de doenças

Toda saída tem disclaimer: "Isso é uma sugestão de treino, não orientação médica. Em caso de dor, procure profissional de saúde."

## Custos

- Briefing diário: ~$0.001 por usuário/dia
- Análise pós-treino: ~$0.005 por atividade
- Chat: ~$0.01 por mensagem

Pra 100k DAU × 1 briefing/dia + 5 análises/dia + 2 chats/dia = ~$1.700/dia ≈ R$ 280k/mês

**Mitigação:**
- Prompt caching (system prompt cacheado → 90% de economia)
- Batch processing pra briefings agendados (50% desconto)
- Modelo Haiku pra tarefas simples (Sonnet só pra análise complexa)
- Estimativa otimizada: ~R$ 50k/mês pra 100k DAU
