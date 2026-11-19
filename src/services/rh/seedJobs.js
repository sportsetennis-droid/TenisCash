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
  // Tema entre colchetes no começo da pergunta vira o título da etapa na tela do candidato.
  interviewQuestions: [
    '[Sobre você] Conte um pouco sobre você e a sua trajetória de trabalho até aqui.',
    '[Sobre você] O que você conhece da Sports & Tennis e o que chamou a sua atenção nesta vaga?',
    '[Sobre você] Quais são os seus pontos fortes no trabalho? Dê um exemplo real de cada um.',
    '[Sobre você] O que você ainda precisa melhorar como profissional e o que está fazendo para isso?',
    '[Esporte e produto] Qual é a sua relação com esporte? Você pratica, acompanha ou já praticou algum?',
    '[Esporte e produto] Como você costuma aprender sobre um produto novo?',
    '[Esporte e produto] O cliente pergunta sobre um tênis que você ainda não conhece bem. O que você faz?',
    '[Atendimento] O que é um bom atendimento para você? Dê um exemplo de quando você foi muito bem atendido(a).',
    '[Atendimento] Um cliente entra na loja e diz "só estou olhando". O que você faz?',
    '[Atendimento] A loja está cheia e três clientes pedem ajuda ao mesmo tempo. Como você se organiza?',
    '[Atendimento] Conte uma vez em que você atendeu um cliente difícil ou insatisfeito. O que aconteceu e como terminou?',
    '[Vendas] Como você descobre o que o cliente realmente precisa antes de oferecer um produto?',
    '[Vendas] O cliente pede um tênis e a loja não tem o número dele. O que você faz?',
    '[Vendas] O cliente diz "achei caro" ou "vi mais barato na internet". O que você responde?',
    '[Vendas] O cliente decidiu levar um tênis de corrida. O que mais você ofereceria e como?',
    '[Vendas] Conte sobre uma meta que você bateu ou deixou de bater. O que você fez e o que aprendeu?',
    '[Rotina da loja] Além de vender, o dia a dia tem arrumar vitrine, repor e organizar o estoque e manter a loja limpa. Como você vê essa parte do trabalho?',
    '[Rotina da loja] Quando a loja está sem movimento, o que você faz?',
    '[Rotina da loja] Como você se organiza para chegar no horário e cumprir a escala?',
    '[Rotina da loja] Você recebeu uma tarefa e percebeu que não vai conseguir terminar no prazo. O que você faz?',
    '[Equipe e postura] Como você reage quando recebe uma crítica ou correção de quem lidera a loja? Dê um exemplo.',
    '[Equipe e postura] Conte uma situação em que você discordou de um colega ou de um chefe. Como resolveu?',
    '[Equipe e postura] Um colega passa a atender um cliente que você já tinha começado a atender. Como você lida com isso?',
    '[Equipe e postura] Como você reage quando passa um dia inteiro vendendo pouco?',
    '[Confiança] Você percebe que um colega cometeu um erro que prejudica um cliente. O que você faz?',
    '[Confiança] Você encontra dinheiro ou um produto fora do lugar e ninguém viu. O que você faz?',
    '[Confiança] Um amigo pede um desconto que você não tem autorização para dar. O que você responde?',
    '[Futuro] O que você espera aprender e conquistar no primeiro ano trabalhando com a gente?',
    '[Futuro] Quer deixar alguma pergunta ou recado para a gente? (opcional)',
  ],
};

// Primeira versão (19/11/2026, só vendas e atendimento). Se a vaga ainda estiver com ela, sem edição do dono,
// troca pela lista por temas. Lista já editada no painel nunca é tocada.
const INTERVIEW_V1 = [
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
];

// Questionário com nota (19/11/2026): modelo Vendedor(a) da pesquisa de recrutamento.
// As perguntas abertas que viraram questionário (experiência, disponibilidade, esporte) saem da lista aberta.
const QUESTIONS_V1 = JOB.questions.slice();
JOB.questions = [
  'Por que você quer trabalhar na Sports & Tennis?',
  'Conte um atendimento ou venda de que você se orgulha: o que o cliente precisava e o que você fez?',
  'A partir de quando você pode começar?',
];
const { TEMPLATES } = require('./screening');
JOB.screening = TEMPLATES.VENDEDOR.screening;
JOB.cutoff = TEMPLATES.VENDEDOR.cutoff;

async function seed(prisma) {
  const [has] = await prisma.$queryRaw`SELECT "id", "interviewQuestions", "questions", "screening", "screeningSeeded" FROM "HrJob" WHERE "slug"=${SLUG} LIMIT 1`;
  if (has) {
    if (JSON.stringify(has.interviewQuestions) === JSON.stringify(INTERVIEW_V1)) {
      await prisma.$executeRaw`UPDATE "HrJob" SET "interviewQuestions"=${JSON.stringify(JOB.interviewQuestions)}::jsonb, "updatedAt"=NOW() WHERE "id"=${has.id}`;
    }
    // Entra uma vez só, e só se a vaga ainda não tem questionário. Se o dono apagar depois, não volta.
    if (!has.screeningSeeded && (!Array.isArray(has.screening) || !has.screening.length)) {
      const swapOpen = JSON.stringify(has.questions) === JSON.stringify(QUESTIONS_V1);
      await prisma.$executeRaw`UPDATE "HrJob" SET "screening"=${JSON.stringify(JOB.screening)}::jsonb, "cutoff"=COALESCE("cutoff", ${JOB.cutoff}::int),
        "questions"=CASE WHEN ${swapOpen} THEN ${JSON.stringify(JOB.questions)}::jsonb ELSE "questions" END, "screeningSeeded"=true, "updatedAt"=NOW() WHERE "id"=${has.id}`;
    } else if (!has.screeningSeeded) {
      await prisma.$executeRaw`UPDATE "HrJob" SET "screeningSeeded"=true WHERE "id"=${has.id}`;
    }
    return false;
  }
  await prisma.$executeRaw`INSERT INTO "HrJob" ("id","slug","title","jobTitle","description","openings","status","questions","storeOptions","interviewQuestions","screening","cutoff","screeningSeeded")
    VALUES (${require('crypto').randomUUID()}, ${SLUG}, ${JOB.title}, 'VENDEDOR', ${JOB.description}, 1, 'ABERTA',
      ${JSON.stringify(JOB.questions)}::jsonb, ${JSON.stringify(JOB.storeOptions)}::jsonb, ${JSON.stringify(JOB.interviewQuestions)}::jsonb, ${JSON.stringify(JOB.screening)}::jsonb, ${JOB.cutoff}::int, true)
    ON CONFLICT ("slug") DO NOTHING`;
  return true;
}

module.exports = { seed, SLUG, JOB, INTERVIEW_V1, QUESTIONS_V1 };
