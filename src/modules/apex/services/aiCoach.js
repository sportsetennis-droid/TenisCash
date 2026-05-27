// =====================================================================
// APEX COACH — Coach IA do app esportivo (unificado ao TenisCash)
// =====================================================================
// Coach conversacional baseado em Claude.
// Inputs: histórico de atividades, dados de wearable, objetivos do atleta.
// Outputs: briefing diário, ajuste de plano, análise pós-treino, chat.
//
// O mesmo atleta da loja Sports & Tennis recebe coaching aqui.
// Insights são personalizados com base no User + AthleteProfile + Activity.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.APEX_COACH_MODEL || 'claude-sonnet-4-5-20251029';

function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

const COACH_SYSTEM = `Você é o APEX COACH — assistente esportivo conversacional do app Sports & Tennis / APEX SPORT.

Sua função: ajudar atletas amadores e intermediários a treinarem melhor, recuperarem melhor, e atingirem objetivos.

REGRAS:
- Você dá insights de TREINO, não diagnóstico médico
- Sempre rotule no final: "Isso é uma sugestão de treino, não orientação médica. Em caso de dor ou sintoma, procure um profissional de saúde."
- Use linguagem direta, PT-BR informal mas técnico quando preciso
- Adapte tom ao nível do atleta (beginner = mais didático; advanced = mais técnico)
- Personalize com dados do usuário se disponíveis (idade, peso, HRV, sono, carga)
- Nunca prescreva calorias / dieta sem disclaimer de nutricionista
- Pode sugerir produtos da loja Sports & Tennis quando fizer sentido (ex: "tênis com mais amortecimento pra longão"), sem empurrar venda

Estilo:
- Frases curtas
- Bullet quando lista
- Nunca repete o que o usuário disse
- Pergunta antes de assumir`;

async function dailyBriefing({ userName, recoveryScore, lastActivity, weeklyLoad, weather, todayWorkout }) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Briefing matinal pro ${userName}:
- Recovery score: ${recoveryScore}/100
- Última atividade: ${lastActivity || '(nenhuma)'}
- Carga da semana: ${weeklyLoad || '?'}
- Clima hoje: ${weather || '?'}
- Treino planejado: ${todayWorkout || '(nenhum)'}

Gere briefing curto (4-6 linhas) com:
- Status do corpo
- Recomendação do dia (HARD / MODERATE / EASY / REST)
- 1 dica acionável
- Encorajamento final em 1 frase`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: [{ type: 'text', text: COACH_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });
    return { ok: true, text: resp.content[0]?.text, usage: resp.usage };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function postWorkoutAnalysis({ activity, comparison }) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `Treino concluído:
- Esporte: ${activity.sportType}
- Distância: ${activity.distanceM}m
- Tempo: ${activity.elapsedTimeS}s
- FC média: ${activity.avgHeartRate || '?'} bpm
- Pace médio: ${activity.avgPace || '?'} sec/km
- Ganho elevação: ${activity.elevationGainM || 0}m

${comparison ? `Comparação com média 30d: ${JSON.stringify(comparison)}` : ''}

Análise em 3 partes:
1. O que aconteceu (1 parágrafo)
2. Insight de performance (1 parágrafo)
3. Próximo passo recomendado (1 frase)`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: [{ type: 'text', text: COACH_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });
    return { ok: true, text: resp.content[0]?.text, usage: resp.usage };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function chat({ userMessage, userContext, history = [] }) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const contextPrefix = userContext
    ? `\n\nCONTEXTO DO ATLETA:\n${JSON.stringify(userContext, null, 2)}\n\n`
    : '';

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: [{ type: 'text', text: COACH_SYSTEM + contextPrefix, cache_control: { type: 'ephemeral' } }],
      messages: [...history, { role: 'user', content: userMessage }],
    });
    return { ok: true, text: resp.content[0]?.text, usage: resp.usage };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { isConfigured, dailyBriefing, postWorkoutAnalysis, chat };
