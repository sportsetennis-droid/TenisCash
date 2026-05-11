// =====================================================================
// User Context Service — carrega snapshot do usuário para o Life Agent
// =====================================================================

const { prisma } = require('../../middleware');

async function loadUserLifeContext(userId) {
  if (!userId) {
    return {
      user: null,
      lifeProfile: null,
      recentMood: null,
      trainingHistory: [],
      purchaseHistory: [],
      tenisCashBalance: 0,
      previousRecommendations: [],
      _error: 'userId não fornecido',
    };
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        balance: true,
        birthDate: true,
        city: true,
        state: true,
        height: true,
        weight: true,
        shirtSize: true,
        shoeSize: true,
        sportsPractice: true,
        sportsWant: true,
        sportsWhere: true,
        favBrands: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      return {
        user: null,
        _error: 'Usuário não encontrado',
      };
    }

    const [lifeProfile, recentMood, trainingHistory, previousRecommendations] = await Promise.all([
      prisma.userLifeProfile.findUnique({ where: { userId } }).catch(() => null),
      prisma.userMoodCheckin
        .findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
        .catch(() => null),
      prisma.userTrainingLog
        .findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 })
        .catch(() => []),
      prisma.userRecommendation
        .findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, source: true, possibilities: true, status: true, createdAt: true },
        })
        .catch(() => []),
    ]);

    // Histórico de compras: vamos olhar SellerClient com CPF do usuário se houver, senão pular.
    // Versão simples: omitido por padrão.
    const purchaseHistory = [];

    return {
      user: {
        id: user.id,
        name: user.name,
        birthDate: user.birthDate,
        city: user.city,
        state: user.state,
        physical: {
          height: user.height,
          weight: user.weight,
          shirtSize: user.shirtSize,
          shoeSize: user.shoeSize,
        },
        crm: {
          sportsPractice: user.sportsPractice,
          sportsWant: user.sportsWant,
          sportsWhere: user.sportsWhere,
          favBrands: user.favBrands,
        },
        memberSince: user.createdAt,
      },
      lifeProfile: lifeProfile || null,
      recentMood: recentMood || null,
      trainingHistory: trainingHistory || [],
      purchaseHistory,
      tenisCashBalance: Number((user.balance || 0).toFixed(2)),
      previousRecommendations: previousRecommendations || [],
    };
  } catch (err) {
    return {
      user: null,
      _error: err.message,
    };
  }
}

module.exports = { loadUserLifeContext };
