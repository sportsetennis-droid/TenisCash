// =====================================================================
// Weekly Interview — perguntas fixas do questionário semanal do vendedor
// =====================================================================

const QUESTIONS = [
  // PERSONAL_STATE
  { key: 'mood_week', category: 'PERSONAL_STATE', text: 'Como você se sentiu essa semana?' },
  { key: 'energy_source', category: 'PERSONAL_STATE', text: 'O que mais te deu energia?' },
  { key: 'energy_block', category: 'PERSONAL_STATE', text: 'O que mais te travou?' },
  { key: 'sales_difficulty', category: 'PERSONAL_STATE', text: 'Você sentiu dificuldade em vender algum produto?' },
  { key: 'confidence_feeling', category: 'PERSONAL_STATE', text: 'Você se sentiu confiante no atendimento?' },
  { key: 'week_score', category: 'PERSONAL_STATE', text: 'De 0 a 10, como foi sua semana?' },
  { key: 'next_week_goal', category: 'PERSONAL_STATE', text: 'Qual seu objetivo principal para a próxima semana?' },
  { key: 'company_need', category: 'PERSONAL_STATE', text: 'O que você precisa da empresa para vender melhor?' },
  // SELLER_PROFILE
  { key: 'favorite_to_sell', category: 'SELLER_PROFILE', text: 'O que você mais gosta de vender?' },
  { key: 'confident_category', category: 'SELLER_PROFILE', text: 'Qual categoria você se sente mais seguro vendendo?' },
  { key: 'most_believed_product', category: 'SELLER_PROFILE', text: 'Qual produto você mais acredita hoje?' },
  { key: 'best_known_brand', category: 'SELLER_PROFILE', text: 'Qual marca você mais entende?' },
  { key: 'best_customer_type', category: 'SELLER_PROFILE', text: 'Qual tipo de cliente você atende melhor?' },
  { key: 'hard_customer_type', category: 'SELLER_PROFILE', text: 'Qual tipo de cliente você tem mais dificuldade?' },
  { key: 'tried_new_product', category: 'SELLER_PROFILE', text: 'Você experimentou algum produto novo essa semana?' },
  { key: 'tried_product_name', category: 'SELLER_PROFILE', text: 'Qual produto você usou ou testou?' },
  { key: 'tried_product_opinion', category: 'SELLER_PROFILE', text: 'O que você achou?' },
  // CUSTOMER_INSIGHT
  { key: 'remarkable_customer', category: 'CUSTOMER_INSIGHT', text: 'Qual cliente mais te marcou essa semana?' },
  { key: 'cool_customer', category: 'CUSTOMER_INSIGHT', text: 'Qual cliente foi mais legal ou interessante?' },
  { key: 'high_intent_customer', category: 'CUSTOMER_INSIGHT', text: 'Qual cliente tinha maior intenção de compra?' },
  { key: 'almost_bought', category: 'CUSTOMER_INSIGHT', text: 'Qual cliente quase comprou e por que desistiu?' },
  { key: 'callback_customer', category: 'CUSTOMER_INSIGHT', text: 'Qual cliente precisa ser chamado de volta?' },
  { key: 'potential_loyal', category: 'CUSTOMER_INSIGHT', text: 'Qual cliente você acha que pode virar fiel?' },
  { key: 'product_that_impacted', category: 'CUSTOMER_INSIGHT', text: 'Qual produto mais impactou um cliente?' },
  { key: 'customer_quote', category: 'CUSTOMER_INSIGHT', text: 'Qual frase ou reação de cliente chamou sua atenção?' },
  // PRODUCT_DEMAND
  { key: 'most_searched_products', category: 'PRODUCT_DEMAND', text: 'Quais produtos foram mais procurados essa semana?' },
  { key: 'most_asked_brands', category: 'PRODUCT_DEMAND', text: 'Quais marcas os clientes mais perguntaram?' },
  { key: 'cited_models', category: 'PRODUCT_DEMAND', text: 'Quais modelos os clientes citaram pelo nome?' },
  { key: 'missing_sizes', category: 'PRODUCT_DEMAND', text: 'Quais tamanhos faltaram?' },
  { key: 'wanted_colors', category: 'PRODUCT_DEMAND', text: 'Quais cores foram mais pedidas?' },
  { key: 'attention_no_sale', category: 'PRODUCT_DEMAND', text: 'Qual produto chamou atenção, mas não vendeu?' },
  { key: 'easy_sale', category: 'PRODUCT_DEMAND', text: 'Qual produto vendeu fácil?' },
  { key: 'objection_product', category: 'PRODUCT_DEMAND', text: 'Qual produto gerou objeção?' },
  { key: 'expensive_perception', category: 'PRODUCT_DEMAND', text: 'Qual produto parecia caro para o cliente?' },
  { key: 'cheap_perception', category: 'PRODUCT_DEMAND', text: 'Qual produto parecia barato ou com bom custo-benefício?' },
  // SOCIAL_TRENDS
  { key: 'social_seen', category: 'SOCIAL_TRENDS', text: 'O que você mais viu nas redes sociais essa semana?' },
  { key: 'trending_item', category: 'SOCIAL_TRENDS', text: 'Algum tênis, roupa, marca ou tendência apareceu muito?' },
  { key: 'influencer_video', category: 'SOCIAL_TRENDS', text: 'Algum influenciador, atleta ou vídeo chamou atenção?' },
  { key: 'customer_cited_social', category: 'SOCIAL_TRENDS', text: 'Clientes citaram algo que viram no Instagram, TikTok ou YouTube?' },
  { key: 'competitor_action', category: 'SOCIAL_TRENDS', text: 'Você viu alguma loja ou marca fazendo algo interessante?' },
  { key: 'wishful_product', category: 'SOCIAL_TRENDS', text: 'Você viu algum produto que gostaria que a Sports & Tennis tivesse?' },
  { key: 'liked_something_new', category: 'SOCIAL_TRENDS', text: 'Você gostou de alguma coisa nova?' },
  { key: 'desire_potential', category: 'SOCIAL_TRENDS', text: 'Você acha que algo novo pode virar desejo?' },
  // STORE_EXPOSURE
  { key: 'attention_grabber_product', category: 'STORE_EXPOSURE', text: 'Qual produto mais chamou atenção na loja?' },
  { key: 'hidden_product', category: 'STORE_EXPOSURE', text: 'Qual produto estava escondido e deveria aparecer mais?' },
  { key: 'best_store_area', category: 'STORE_EXPOSURE', text: 'Qual área da loja funcionou melhor?' },
  { key: 'window_feedback', category: 'STORE_EXPOSURE', text: 'A vitrine ajudou ou atrapalhou?' },
  { key: 'curation_feedback', category: 'STORE_EXPOSURE', text: 'A curadoria exposta fez sentido?' },
  { key: 'center_table_suggestion', category: 'STORE_EXPOSURE', text: 'Qual produto deveria estar na mesa central?' },
  { key: 'remove_from_display', category: 'STORE_EXPOSURE', text: 'Qual produto deveria sair da exposição?' },
  { key: 'most_touched_product', category: 'STORE_EXPOSURE', text: 'O que os clientes mais tocaram ou pegaram na mão?' },
  // COMPETITION
  { key: 'price_comparison', category: 'COMPETITION', text: 'Cliente comparou preço com outra loja?' },
  { key: 'competitor_cited', category: 'COMPETITION', text: 'Qual loja ou site foi citado?' },
  { key: 'marketplace_mentions', category: 'COMPETITION', text: 'Cliente falou da Netshoes, Centauro, Mercado Livre, Shopee ou Instagram?' },
  { key: 'common_objection', category: 'COMPETITION', text: 'Qual objeção apareceu mais? (preço, marca, pagamento, variedade, confiança, localização)' },
  // IDEAS
  { key: 'idea_to_sell_more', category: 'IDEAS', text: 'Que ideia você teve essa semana para vender mais?' },
  { key: 'store_action_idea', category: 'IDEAS', text: 'Que ação você faria na loja?' },
  { key: 'promo_idea', category: 'IDEAS', text: 'Que produto você colocaria em promoção?' },
  { key: 'content_idea', category: 'IDEAS', text: 'Que conteúdo você gravaria?' },
  { key: 'customer_invite_idea', category: 'IDEAS', text: 'Que cliente você chamaria para participar de algo?' },
  { key: 'service_improvement', category: 'IDEAS', text: 'Que melhoria você faria no atendimento?' },
  { key: 'good_sale_phrase', category: 'IDEAS', text: 'Que frase funcionou bem em venda?' },
];

function questionsByCategory() {
  const groups = {};
  for (const q of QUESTIONS) {
    if (!groups[q.category]) groups[q.category] = [];
    groups[q.category].push(q);
  }
  return groups;
}

function categoryLabel(cat) {
  const map = {
    PERSONAL_STATE: 'Estado pessoal',
    SELLER_PROFILE: 'Perfil do vendedor',
    CUSTOMER_INSIGHT: 'Clientes',
    PRODUCT_DEMAND: 'Produtos',
    SOCIAL_TRENDS: 'Redes sociais e tendências',
    STORE_EXPOSURE: 'Loja e exposição',
    COMPETITION: 'Concorrência',
    IDEAS: 'Ideias',
  };
  return map[cat] || cat;
}

function weekBoundsFor(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Dom..6=Sáb
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { weekStartDate: monday, weekEndDate: sunday };
}

// Gera insights por regra a partir das respostas
function deriveInsights(answers) {
  const byKey = {};
  for (const a of answers) byKey[a.questionKey] = a.answerText || '';

  const insights = [];

  if (byKey.missing_sizes && byKey.missing_sizes.trim()) {
    insights.push({
      type: 'MISSING_PRODUCT',
      title: 'Tamanhos faltando',
      description: byKey.missing_sizes,
      priority: 'HIGH',
    });
  }
  if (byKey.most_searched_products && byKey.most_searched_products.trim()) {
    insights.push({
      type: 'PRODUCT_DEMAND',
      title: 'Produtos mais procurados',
      description: byKey.most_searched_products,
      priority: 'MEDIUM',
    });
  }
  if (byKey.common_objection && byKey.common_objection.trim()) {
    insights.push({
      type: 'PRICE_OBJECTION',
      title: 'Objeção recorrente',
      description: byKey.common_objection,
      priority: 'MEDIUM',
    });
  }
  if (byKey.hidden_product && byKey.hidden_product.trim()) {
    insights.push({
      type: 'STORE_DISPLAY',
      title: 'Produto escondido na loja',
      description: byKey.hidden_product,
      priority: 'MEDIUM',
    });
  }
  if (byKey.trending_item && byKey.trending_item.trim()) {
    insights.push({
      type: 'SOCIAL_TREND',
      title: 'Tendência social observada',
      description: byKey.trending_item,
      priority: 'LOW',
    });
  }
  if (byKey.callback_customer && byKey.callback_customer.trim()) {
    insights.push({
      type: 'CUSTOMER_OPPORTUNITY',
      title: 'Cliente para chamar de volta',
      description: byKey.callback_customer,
      priority: 'HIGH',
    });
  }
  if (byKey.idea_to_sell_more && byKey.idea_to_sell_more.trim()) {
    insights.push({
      type: 'CAMPAIGN_IDEA',
      title: 'Ideia de venda do vendedor',
      description: byKey.idea_to_sell_more,
      priority: 'LOW',
    });
  }
  if (byKey.sales_difficulty && byKey.sales_difficulty.trim()) {
    insights.push({
      type: 'TRAINING_NEED',
      title: 'Dificuldade de venda relatada',
      description: byKey.sales_difficulty,
      priority: 'MEDIUM',
    });
  }
  return insights;
}

module.exports = {
  QUESTIONS,
  questionsByCategory,
  categoryLabel,
  weekBoundsFor,
  deriveInsights,
};
