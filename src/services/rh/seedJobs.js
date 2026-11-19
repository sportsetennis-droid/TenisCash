// Vaga pedida pelo dono em 19/11/2026: vendas nas lojas do Bessa e do Pirâmide (Praia de Tambaú).
// Entra uma vez só (pelo slug). Depois disso, quem manda é o painel do RH: editar, pausar ou fechar lá.
// Salário e horário ficam em branco de propósito: só o dono informa.
// Perguntas no formato usado em seleção de varejo: comportamentais ("conte uma vez em que…") e
// situacionais ("o que você faz se…"). Nada sobre estado civil, filhos, gravidez, idade ou religião (Lei 9.029/95).
const SLUG = 'vendas-bessa-piramide';

const JOB = {
  title: 'Vendedor(a) — Praia do Bessa e Pirâmide',
  description: 'Atendimento e venda de tênis, roupas e acessórios esportivos nas lojas Sports & Tennis Praia do Bessa (Parahyba Mall) e Praia de Tambaú (Pirâmide Shopping), em João Pessoa.',
  storeOptions: ['Praia do Bessa (Parahyba Mall)', 'Praia de Tambaú (Pirâmide Shopping)'],
  questions: [
    'Já trabalhou com vendas ou atendimento ao público? Onde e por quanto tempo?',
    'Tem disponibilidade para horário de shopping, com sábados, domingos e feriados em escala?',
    'Por que você quer trabalhar na Sports & Tennis?',
    'Você pratica ou acompanha algum esporte? Qual?',
    'A partir de quando você pode começar?',
  ],
  interviewQuestions: [
    'Conte um pouco sobre você e a sua trajetória de trabalho até aqui.',
    'O que você conhece da Sports & Tennis e o que chamou a sua atenção nesta vaga?',
    'Um cliente entra na loja e diz "só estou olhando". O que você faz?',
    'Como você descobre o que o cliente realmente precisa antes de oferecer um produto?',
    'O cliente pede um tênis e a loja não tem o número dele. O que você faz?',
    'O cliente diz "achei caro" ou "vi mais barato na internet". O que você responde?',
    'O cliente decidiu levar um tênis de corrida. O que mais você ofereceria e como?',
    'A loja está cheia e três clientes pedem ajuda ao mesmo tempo. Como você se organiza?',
    'Conte uma vez em que você atendeu um cliente difícil ou insatisfeito. O que aconteceu e como terminou?',
    'Conte sobre uma meta que você bateu ou deixou de bater. O que você fez e o que aprendeu?',
    'Como você reage quando passa um dia inteiro vendendo pouco?',
    'Quando a loja está sem movimento, o que você faz?',
    'Conte uma situação em que você discordou de um colega ou de um chefe. Como resolveu?',
    'Você percebe que um colega cometeu um erro que prejudica um cliente. O que você faz?',
    'O que é um bom atendimento para você? Dê um exemplo de quando você foi muito bem atendido(a).',
    'O que você espera aprender e conquistar no primeiro ano trabalhando com a gente?',
    'Quer deixar alguma pergunta ou recado para a gente? (opcional)',
  ],
};

async function seed(prisma) {
  const [has] = await prisma.$queryRaw`SELECT "id" FROM "HrJob" WHERE "slug"=${SLUG} LIMIT 1`;
  if (has) return false;
  await prisma.$executeRaw`INSERT INTO "HrJob" ("id","slug","title","jobTitle","description","openings","status","questions","storeOptions","interviewQuestions")
    VALUES (${require('crypto').randomUUID()}, ${SLUG}, ${JOB.title}, 'VENDEDOR', ${JOB.description}, 1, 'ABERTA',
      ${JSON.stringify(JOB.questions)}::jsonb, ${JSON.stringify(JOB.storeOptions)}::jsonb, ${JSON.stringify(JOB.interviewQuestions)}::jsonb)
    ON CONFLICT ("slug") DO NOTHING`;
  return true;
}

module.exports = { seed, SLUG, JOB };
