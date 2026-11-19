// Questionário com nota automática da candidatura + roteiro de entrevista + role-play (dono 19/11/2026:
// "Temos que montar questionários para as vagas e veja o que mais eles fazem para recrutar os melhores").
//
// Base: pesquisa de recrutamento de 18/11/2026 (Decathlon, Renner, Magalu, Gupy; entrevista estruturada STAR).
//   ELIM = eliminatória: a resposta marcada "reprova" SINALIZA o candidato. Ninguém é reprovado sozinho:
//          quem decide é uma pessoa (LGPD art. 20 — decisão automatizada pode ser revista).
//   MC   = múltipla escolha com pontos. A nota é a soma. Os pontos e a resposta certa nunca vão para a página pública.
// Proibido perguntar: estado civil, filhos, gravidez, religião, orientação, antecedentes, idade sem justificativa
// legal (Lei 9.029/95, CLT 373-A). Por isso não há pergunta de idade nos modelos.
// Não falar de escala (6x1/5x2): vai mudar com a lei (dono 19/11/2026: "Então não fala de escala").
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

const MAX_Q = 20, MAX_OPT = 6, MAX_POINTS = 10;

// ───────── formato de texto do painel ─────────
// ELIM: pergunta            MC: pergunta
// - Sim                     - Nenhuma = 0
// - Não (reprova)           - Loja, 1 ano ou mais = 3
function parseText(text) {
  const out = []; let cur = null; let n = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    n++;
    const line = raw.trim(); if (!line) continue;
    const q = /^(ELIM|MC)\s*[:\-]\s*(.+)$/i.exec(line);
    if (q) { cur = { type: q[1].toUpperCase(), text: q[2], options: [] }; out.push(cur); continue; }
    const o = /^[-•*]\s*(.+)$/.exec(line);
    if (!o) throw httpErr(400, 'Questionário, linha ' + n + ': comece a pergunta com "ELIM:" ou "MC:" e cada alternativa com "-".');
    if (!cur) throw httpErr(400, 'Questionário, linha ' + n + ': alternativa sem pergunta antes.');
    let label = o[1].trim();
    if (cur.type === 'ELIM') {
      if (/=\s*\d{1,2}\s*$/.test(label)) throw httpErr(400, 'Questionário, linha ' + n + ': pergunta ELIM não tem pontos; use "(reprova)" na resposta que elimina ou troque para MC.');
      const elim = /\(\s*reprova\s*\)\s*$/i.test(label);
      label = label.replace(/\(\s*reprova\s*\)\s*$/i, '').trim();
      cur.options.push({ label, ok: !elim });
    } else {
      if (/\(\s*reprova\s*\)/i.test(label)) throw httpErr(400, 'Questionário, linha ' + n + ': "(reprova)" só vale em pergunta ELIM.');
      const p =/^(.*?)\s*=\s*(\d{1,2})\s*$/.exec(label);
      if (!p) throw httpErr(400, 'Questionário, linha ' + n + ': na pergunta MC, termine a alternativa com "= pontos" (ex.: "- Sim = 3").');
      cur.options.push({ label: p[1].trim(), points: +p[2] });
    }
  }
  return out;
}

function toText(list) {
  return (Array.isArray(list) ? list : []).map((q) => q.type + ': ' + q.text + '\n' +
    q.options.map((o) => '- ' + o.label + (q.type === 'ELIM' ? (o.ok ? '' : ' (reprova)') : ' = ' + (o.points || 0))).join('\n')).join('\n\n');
}

// Valida e dá id estável (o id é o que liga a resposta do candidato à pergunta).
// known = perguntas que já existiam (da vaga e dos modelos): mesma pergunta mantém o mesmo id, para a resposta
// de quem está com a página aberta não se perder quando o dono salva a vaga pelo texto.
function normalize(list, known = []) {
  if (typeof list === 'string') list = parseText(list);
  const byText = new Map();
  for (const k of [...(known || []), ...Object.values(TEMPLATES || {}).flatMap((t) => t.screening)]) if (k && k.id && !byText.has(k.text)) byText.set(k.text, k.id);
  if (!Array.isArray(list)) return [];
  if (list.length > MAX_Q) throw httpErr(400, 'Questionário com no máximo ' + MAX_Q + ' perguntas.');
  const used = new Set();
  const want = list.map((q) => { const t = clean(q && q.text, 300); const own = /^[A-Za-z0-9_-]{1,12}$/.test(String((q && q.id) || '')) ? String(q.id) : ''; return own || byText.get(t) || ''; });
  const reserved = new Set(); want.forEach((w, i) => { if (w && !reserved.has(w)) reserved.add(w); else want[i] = ''; });
  return list.map((q, i) => {
    const type = String(q.type || '').toUpperCase();
    if (!['ELIM', 'MC'].includes(type)) throw httpErr(400, 'Pergunta ' + (i + 1) + ': tipo deve ser ELIM ou MC.');
    const text = clean(q.text, 300);
    if (!text) throw httpErr(400, 'Pergunta ' + (i + 1) + ' sem texto.');
    const opts = (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: clean(o && o.label, 200) })).filter((o) => o.label);
    if (opts.length < 2 || opts.length > MAX_OPT) throw httpErr(400, 'Pergunta ' + (i + 1) + ': de 2 a ' + MAX_OPT + ' alternativas.');
    (q.options || []).filter((o) => o && clean(o.label, 200)).forEach((o, k) => {
      if (type === 'ELIM') opts[k].ok = o.ok !== false;
      else { const p = Math.round(Number(o.points) || 0); if (p < 0 || p > MAX_POINTS) throw httpErr(400, 'Pergunta ' + (i + 1) + ': pontos de 0 a ' + MAX_POINTS + '.'); opts[k].points = p; }
    });
    if (type === 'ELIM' && !opts.some((o) => o.ok)) throw httpErr(400, 'Pergunta ' + (i + 1) + ': a eliminatória precisa de pelo menos uma resposta que não reprova.');
    if (type === 'ELIM' && opts.every((o) => o.ok)) throw httpErr(400, 'Pergunta ' + (i + 1) + ': marque com "(reprova)" a resposta que elimina, ou troque para MC.');
    let qid = want[i];
    if (!qid || used.has(qid)) { let k = i + 1; do { qid = 'q' + k++; } while (used.has(qid) || reserved.has(qid)); }
    used.add(qid);
    return { id: qid, type, text, options: opts };
  });
}

const maxScore = (list) => (list || []).filter((q) => q.type === 'MC').reduce((s, q) => s + Math.max(0, ...q.options.map((o) => o.points || 0)), 0);

// O que a página pública recebe: só texto e alternativas (sem pontos, sem "reprova", sem tipo).
const publicView = (list) => (list || []).map((q) => ({ id: q.id, text: q.text, options: q.options.map((o) => o.label) }));

// Calcula a nota no servidor. answers = { id: índice da alternativa }.
function score(list, answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const saved = {}; const reasons = []; let total = 0;
  (list || []).forEach((q, i) => {
    const k = Number.parseInt(a[q.id], 10);
    if (!(k >= 0 && k < q.options.length)) throw httpErr(400, 'Responda a pergunta ' + (i + 1) + ' do questionário.');
    const o = q.options[k];
    const row = { q: q.text, a: o.label, type: q.type };
    if (q.type === 'MC') { row.points = o.points || 0; row.max = Math.max(...q.options.map((x) => x.points || 0)); total += row.points; }
    else if (!o.ok) { row.elim = true; reasons.push(q.text); }
    saved[q.id] = row;
  });
  return { answers: saved, score: total, max: maxScore(list), eliminated: reasons.length > 0, reasons };
}

// ───────── MODELOS ─────────
const T_VENDEDOR = [
  { id: 'E1', type: 'ELIM', text: 'Você tem disponibilidade para trabalhar aos sábados, domingos e feriados?', options: [{ label: 'Sim', ok: true }, { label: 'Não', ok: false }] },
  { id: 'E2', type: 'ELIM', text: 'O horário pode ir até o fechamento do shopping. Você pode trabalhar nesse horário?', options: [{ label: 'Sim', ok: true }, { label: 'Só pela manhã', ok: false }, { label: 'Não', ok: false }] },
  { id: 'M1', type: 'MC', text: 'Qual é a sua experiência com vendas?', options: [{ label: 'Nenhuma', points: 0 }, { label: 'Informal ou negócio próprio', points: 1 }, { label: 'Loja, menos de 1 ano', points: 2 }, { label: 'Loja, 1 ano ou mais', points: 3 }] },
  { id: 'M2', type: 'MC', text: 'Já trabalhou com meta e comissão?', options: [{ label: 'Não', points: 0 }, { label: 'Sim, às vezes bati a meta', points: 2 }, { label: 'Sim, bati na maioria dos meses', points: 3 }] },
  { id: 'M3', type: 'MC', text: 'Você pratica esporte com regularidade?', options: [{ label: 'Não', points: 0 }, { label: 'Às vezes', points: 1 }, { label: '1 a 2 vezes por semana', points: 2 }, { label: '3 vezes ou mais por semana', points: 3 }] },
  { id: 'M4', type: 'MC', text: 'Um cliente vai começar a correr 5 km, 3 vezes por semana, no asfalto. O que você faz primeiro?', options: [{ label: 'Mostra o tênis mais barato', points: 0 }, { label: 'Mostra o tênis mais caro', points: 1 }, { label: 'Pergunta sobre a rotina e o histórico dele e mostra tênis de corrida com amortecimento', points: 3 }, { label: 'Mostra um tênis de futsal', points: 0 }] },
  { id: 'M5', type: 'MC', text: 'Qual destas marcas é mais conhecida por artigos de natação?', options: [{ label: 'Speedo', points: 2 }, { label: 'Umbro', points: 0 }, { label: 'Hoka', points: 0 }, { label: 'Kappa', points: 0 }] },
  { id: 'M6', type: 'MC', text: 'O cliente diz que achou mais barato na internet. O que você faz?', options: [{ label: 'Diz que não pode fazer nada', points: 0 }, { label: 'Dá desconto por conta própria', points: 0 }, { label: 'Agradece, confere se é o mesmo modelo, tamanho, frete e prazo, mostra as vantagens da loja (provar agora, levar hoje, troca fácil, cashback TenisCash) e, se precisar, chama o gerente', points: 3 }, { label: 'Fala mal do site', points: 0 }] },
  { id: 'M7', type: 'MC', text: 'A loja está cheia, você está atendendo e chega outro cliente pedindo ajuda. O que você faz?', options: [{ label: 'Ignora o segundo cliente', points: 0 }, { label: 'Deixa o primeiro e vai atender o segundo', points: 0 }, { label: 'Cumprimenta o segundo, avisa que já atende ou chama um colega, e volta ao primeiro', points: 3 }, { label: 'Pede para esperar sem olhar para ele', points: 1 }] },
  { id: 'M8', type: 'MC', text: 'O número que o cliente quer acabou. O que você faz?', options: [{ label: 'Diz que não tem', points: 0 }, { label: 'Consulta outra loja ou o estoque, oferece reservar ou mandar buscar, e mostra um modelo parecido no número dele', points: 3 }, { label: 'Oferece outro número dizendo que "laceia"', points: 0 }, { label: 'Pede para voltar outro dia', points: 1 }] },
  { id: 'M9', type: 'MC', text: 'O cliente diz que está "só olhando". O que você faz?', options: [{ label: 'Deixa sozinho sem falar nada', points: 1 }, { label: 'Fica atrás dele insistindo', points: 0 }, { label: 'Cumprimenta, dá espaço, fica disponível e volta com uma pergunta quando ele mostra interesse', points: 3 }] },
  { id: 'M10', type: 'MC', text: 'O cliente decidiu levar um tênis de corrida. E agora?', options: [{ label: 'Finaliza a venda', points: 1 }, { label: 'Oferece algo que combina (meia de corrida, garrafa) explicando o benefício', points: 3 }, { label: 'Oferece tudo da loja', points: 0 }] },
  { id: 'M11', type: 'MC', text: 'Falta pouco para bater a meta e o cliente pergunta se um tênis de corrida serve para jogar futsal. O que você responde?', options: [{ label: 'Diz que serve', points: 0 }, { label: 'Explica que não é indicado e mostra o produto certo', points: 3 }] },
  { id: 'M12', type: 'MC', text: 'Vender é só uma parte: tem repor, arrumar, contar e bipar estoque, limpar vitrine. Como você vê isso?', options: [{ label: 'Não é minha função', points: 0 }, { label: 'Faço se mandarem', points: 1 }, { label: 'Faz parte, gosto de loja organizada', points: 3 }] },
];
const T_LOGISTICA = [
  { id: 'E1', type: 'ELIM', text: 'A função inclui sábados e, às vezes, inventário fora do horário. Você tem essa disponibilidade?', options: [{ label: 'Sim', ok: true }, { label: 'Não', ok: false }] },
  { id: 'M1', type: 'MC', text: 'Qual é a sua experiência com estoque e recebimento de mercadoria?', options: [{ label: 'Nenhuma', points: 0 }, { label: 'Já fui ajudante', points: 1 }, { label: 'Recebia mercadoria e conferia a nota', points: 2 }, { label: '1 ano ou mais com coletor e sistema', points: 3 }] },
  { id: 'M2', type: 'MC', text: 'A nota diz 12 pares e você contou 11 na caixa. O que você faz?', options: [{ label: 'Dá entrada nos 12', points: 0 }, { label: 'Anota a diferença, avisa o responsável e não confirma o recebimento total', points: 3 }, { label: 'Completa com um par do estoque', points: 0 }] },
  { id: 'M3', type: 'MC', text: 'Chegaram 7 caixas com 12 pares cada e mais 5 pares avulsos. Quantos pares chegaram?', options: [{ label: '84', points: 0 }, { label: '89', points: 3 }, { label: '91', points: 0 }, { label: '79', points: 0 }] },
  { id: 'M4', type: 'MC', text: 'A etiqueta de tamanho do produto não bate com a caixa. O que você faz?', options: [{ label: 'Troca a etiqueta', points: 0 }, { label: 'Separa o produto e avisa o responsável', points: 3 }, { label: 'Guarda assim mesmo', points: 0 }] },
  { id: 'M5', type: 'MC', text: 'Como você organiza um estoque?', options: [{ label: 'Onde couber', points: 0 }, { label: 'Pela ordem de chegada', points: 1 }, { label: 'Por marca, tipo, modelo e tamanho, com endereço de prateleira', points: 3 }] },
  { id: 'M6', type: 'MC', text: 'Você usa celular e aplicativo para bipar e conferir mercadoria?', options: [{ label: 'Nunca usei', points: 0 }, { label: 'Uso o básico', points: 2 }, { label: 'Uso sempre', points: 3 }] },
];
const T_SUPERVISOR = [
  { id: 'E1', type: 'ELIM', text: 'Você já liderou equipe no varejo (como líder formal ou informal) por 1 ano ou mais?', options: [{ label: 'Sim', ok: true }, { label: 'Não', ok: false }] },
  { id: 'E2', type: 'ELIM', text: 'A função inclui abertura e fechamento da loja e fins de semana de movimento forte. Você tem essa disponibilidade?', options: [{ label: 'Sim', ok: true }, { label: 'Não', ok: false }] },
  { id: 'M1', type: 'MC', text: 'Qual foi o tamanho da maior equipe que você liderou?', options: [{ label: '1 a 3 pessoas', points: 1 }, { label: '4 a 8 pessoas', points: 2 }, { label: '9 ou mais', points: 3 }] },
  { id: 'M2', type: 'MC', text: 'A loja vendeu R$ 30.000 em 150 vendas e 360 peças. Qual é o ticket médio e o número de peças por venda?', options: [{ label: 'R$ 200 e 2,4 peças', points: 3 }, { label: 'R$ 200 e 2,0 peças', points: 1 }, { label: 'R$ 83 e 2,4 peças', points: 1 }, { label: 'R$ 83 e 0,4 peça', points: 0 }] },
  { id: 'M3', type: 'MC', text: 'São 15h e a loja fez menos de 60% da meta do dia. O que você faz?', options: [{ label: 'Espera o movimento melhorar', points: 0 }, { label: 'Cobra a equipe em público', points: 0 }, { label: 'Olha fluxo e conversão, redistribui a equipe, puxa uma ação (abordagem na porta, venda adicional, WhatsApp para clientes) e acompanha de hora em hora', points: 3 }] },
  { id: 'M4', type: 'MC', text: 'O cliente pede 20% de desconto. O que você faz?', options: [{ label: 'Dá na hora', points: 0 }, { label: 'Segue a política: oferece o que está na sua alçada e leva acima disso para quem aprova', points: 3 }, { label: 'Recusa sem conversa', points: 1 }] },
  { id: 'M5', type: 'MC', text: 'Dois vendedores brigam pelo mesmo cliente por causa da comissão. O que você faz?', options: [{ label: 'Deixa eles resolverem', points: 0 }, { label: 'Resolve na hora pela regra combinada, conversa em particular depois e deixa a regra clara para todos', points: 3 }, { label: 'Dá a venda para o melhor vendedor', points: 0 }] },
  { id: 'M6', type: 'MC', text: 'O seu melhor vendedor chega atrasado toda semana. O que você faz?', options: [{ label: 'Ignora porque ele vende', points: 0 }, { label: 'Dá retorno em particular com fatos, combina prazo e registra; se repetir, aplica a política', points: 3 }, { label: 'Expõe o caso para a equipe', points: 0 }] },
  { id: 'M7', type: 'MC', text: 'Sábado de movimento e faltam 2 vendedores. O que você faz?', options: [{ label: 'Remaneja horários e pausas, pede apoio de outra loja e prioriza caixa e atendimento', points: 3 }, { label: 'Fecha uma área da loja', points: 1 }, { label: 'Não faz nada', points: 0 }] },
];

const TEMPLATES = {
  VENDEDOR: { label: 'Vendedor(a)', screening: T_VENDEDOR, cutoff: 24,
    open: ['Conte um atendimento ou venda de que você se orgulha: o que o cliente precisava e o que você fez?'] },
  LOGISTICA: { label: 'Logística / estoque', screening: T_LOGISTICA, cutoff: 12,
    open: ['Conte um erro que você pegou antes de virar problema.', 'Como você arrumaria um estoque bagunçado no 1º dia?'] },
  SUPERVISOR: { label: 'Supervisor(a)', screening: T_SUPERVISOR, cutoff: 15,
    open: ['Conte como você fez uma equipe bater meta.', 'Conte um retorno difícil que você deu para alguém da equipe e qual foi o resultado.'] },
};

// ───────── ROTEIRO DA ENTREVISTA (mesmas perguntas, mesma ordem, nota 1–5) ─────────
// 1 = não respondeu ou genérico · 3 = exemplo real mas incompleto · 5 = exemplo completo com ação própria e resultado.
const GUIDE = {
  VENDEDOR: [
    { k: 'cliente', c: 'Orientação ao cliente', q: 'Conte a vez em que você mais ajudou um cliente.', good: 'Caso concreto, entendeu a necessidade, foi além, sabe o resultado', bad: 'Resposta genérica ("sempre atendo bem")' },
    { k: 'sondagem', c: 'Sondagem', q: 'Como você descobre o que o cliente precisa?', good: 'Perguntas abertas: uso, frequência, problema, orçamento', bad: 'Já começa oferecendo' },
    { k: 'preco', c: 'Objeção de preço', q: 'Conte quando um cliente achou caro. O que você fez?', good: 'Argumentou com valor, comparou de forma justa, fechou ou manteve a relação', bad: 'Só baixou o preço' },
    { k: 'meta', c: 'Meta e resiliência', q: 'Conte um mês em que você não bateu a meta. O que fez no mês seguinte?', good: 'Assume a responsabilidade, ajusta o método, mostra números', bad: 'Culpa os outros' },
    { k: 'adicional', c: 'Venda adicional', q: 'Como você aumenta o valor de uma venda sem forçar?', good: 'Complemento que faz sentido, explica o benefício', bad: 'Empurra qualquer coisa' },
    { k: 'dificil', c: 'Cliente difícil', q: 'Qual foi o cliente mais difícil que você atendeu?', good: 'Ficou calmo, ouviu, resolveu ou chamou quem resolve', bad: 'Discutiu' },
    { k: 'equipe', c: 'Trabalho em equipe', q: 'Quando você ajudou um colega mesmo sem ganhar nada com isso?', good: 'Ajuda concreta', bad: 'Individualista' },
    { k: 'organizacao', c: 'Organização', q: 'Como você ajuda a manter a loja e o estoque em ordem?', good: 'Repõe, organiza, segue processo', bad: '"Não é comigo"' },
    { k: 'integridade', c: 'Integridade', q: 'Quando você teve que dizer "não" a um cliente para fazer o certo?', good: 'Honestidade, mesmo perdendo a venda', bad: 'Vende a qualquer custo' },
    { k: 'produto', c: 'Aprendizado de produto', q: 'Como você aprende sobre um produto novo?', good: 'Estuda, testa, pergunta, pratica esporte', bad: 'Passivo' },
    { k: 'rotina', c: 'Disponibilidade real', q: 'Como fica a sua rotina para trabalhar fins de semana e feriados? Quem te apoia?', good: 'Plano concreto (transporte, família)', bad: 'Hesita (risco de sair cedo)' },
    { k: 'motivacao', c: 'Motivação', q: 'Por que loja de esporte e por que a Sports & Tennis?', good: 'Liga a paixão pelo esporte ao atendimento', bad: '"Qualquer emprego"' },
  ],
  LOGISTICA: [
    { k: 'conferencia', c: 'Conferência', q: 'Conte uma vez em que a mercadoria não bateu com a nota. O que você fez?', good: 'Registrou, avisou, não confirmou o que não conferiu', bad: 'Ajustou por conta própria' },
    { k: 'organizacao', c: 'Organização', q: 'Como você organiza um estoque para achar qualquer item em 1 minuto?', good: 'Endereço, padrão por marca/modelo/tamanho, etiqueta', bad: '"Eu sei onde está"' },
    { k: 'detalhe', c: 'Atenção a detalhe', q: 'Conte um erro que você pegou antes de virar problema.', good: 'Caso concreto, o que conferiu, o resultado', bad: 'Nunca errou / genérico' },
    { k: 'sistema', c: 'Sistema e celular', q: 'Que sistemas ou aplicativos de estoque você já usou?', good: 'Usa coletor/app, aprende rápido', bad: 'Resiste a usar' },
    { k: 'ritmo', c: 'Ritmo e prioridade', q: 'Chegaram 3 fornecedores ao mesmo tempo. Como você se organiza?', good: 'Prioriza, separa, confere um por vez, pede apoio', bad: 'Mistura tudo' },
    { k: 'integridade', c: 'Integridade', q: 'O que você faz se perceber um colega levando algo do estoque sem registro?', good: 'Fala com o responsável', bad: 'Finge que não viu' },
    { k: 'equipe', c: 'Trabalho com a loja', q: 'Como você atende um vendedor que pede um produto com o cliente esperando?', good: 'Rápido, com cortesia, confirma tamanho/código', bad: 'Atrapalha a venda' },
    { k: 'rotina', c: 'Disponibilidade real', q: 'Como fica a sua rotina com sábados e inventário fora do horário?', good: 'Plano concreto', bad: 'Hesita' },
  ],
  SUPERVISOR: [
    { k: 'meta', c: 'Resultado', q: 'Conte como você fez uma equipe bater meta.', good: 'Números, ações, acompanhamento', bad: 'Sem números / mérito só dele' },
    { k: 'feedback', c: 'Gestão de pessoas', q: 'Conte um retorno difícil que você deu e qual foi o resultado.', good: 'Em particular, com fatos, combinou mudança', bad: 'Evitou ou expôs' },
    { k: 'indicadores', c: 'Indicadores', q: 'Que números você olha todo dia na loja e por quê?', good: 'Venda, ticket, peças por venda, conversão, ruptura', bad: 'Só o faturamento' },
    { k: 'dia-fraco', c: 'Reação no dia', q: 'O que você faz quando às 15h a loja está abaixo de 60% da meta?', good: 'Diagnóstico + ação + acompanhamento', bad: 'Espera' },
    { k: 'conflito', c: 'Conflito e justiça', q: 'Conte um conflito na equipe que você resolveu.', good: 'Regra clara, conversa em particular', bad: 'Favoritismo' },
    { k: 'margem', c: 'Política de desconto', q: 'Como você lida com pedido de desconto acima da sua alçada?', good: 'Segue a política e leva para quem aprova', bad: 'Dá para não perder a venda' },
    { k: 'operacao', c: 'Operação', q: 'Como você organiza os horários da equipe para cobrir o pico e as folgas?', good: 'Fluxo por hora, folga de domingo, banco de horas', bad: 'Improvisa' },
    { k: 'integridade', c: 'Integridade', q: 'Quando você teve que tomar uma decisão impopular por ser o certo?', good: 'Explica o motivo, mantém o padrão', bad: 'Cede para agradar' },
  ],
};

// Role-play de 5 minutos (vendedor): o entrevistador faz o cliente.
const ROLEPLAY = {
  intro: 'O entrevistador faz o cliente: "Quero começar a correr, vi um tênis mais barato na internet". Use uma carta de objeção: "Na internet tá R$ 80 mais barato." · "Vou pensar." · "Meu joelho dói quando corro."',
  criteria: [
    { k: 'abordagem', c: 'Abordagem', d: '1 sem cumprimento · 3 cumprimenta · 5 cumprimenta, sorri e faz pergunta aberta' },
    { k: 'sondagem', c: 'Sondagem', d: '1 não pergunta · 3 uma ou duas perguntas · 5 objetivo, distância, frequência, piso, tênis atual, dores, orçamento' },
    { k: 'apresentacao', c: 'Apresentação', d: '1 lista características · 3 mostra 1 produto · 5 mostra 2 ou 3 opções falando do benefício ligado ao que ouviu' },
    { k: 'provar', c: 'Convite a provar', d: '1 não convida · 3 convida · 5 convida a calçar e andar/trotar e pergunta como sentiu' },
    { k: 'preco', c: 'Objeção de preço', d: '1 baixa o preço ou desiste · 3 rebate genérico · 5 confere a comparação, mostra valor, respeita a alçada' },
    { k: 'honestidade', c: 'Honestidade (carta do joelho)', d: '1 promete que "resolve a dor" · 3 neutro · 5 indica o produto adequado e sugere procurar um profissional' },
    { k: 'adicional', c: 'Venda adicional', d: '1 nenhuma · 3 oferece sem explicar · 5 meia ou acessório com benefício claro' },
    { k: 'fechamento', c: 'Fechamento', d: '1 espera o cliente · 3 pergunta "vai levar?" · 5 resume, propõe e trata o "vou pensar"' },
    { k: 'postura', c: 'Postura e energia', d: '1 desinteressado · 3 ok · 5 entusiasmo genuíno pelo esporte' },
  ],
};

const roleOf = (r) => (GUIDE[r] ? r : 'VENDEDOR');

function cleanNotes(obj, keys) {
  const out = {};
  for (const k of keys) { const n = Number.parseInt(obj && obj[k], 10); if (n >= 1 && n <= 5) out[k] = n; }
  return out;
}
const avg = (o) => { const v = Object.values(o || {}); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null; };

// Normaliza o que o painel manda e calcula o resumo (sem decidir nada: quem decide é o dono).
function buildScorecard(role, body) {
  const r = roleOf(role);
  const guide = GUIDE[r];
  const interview = cleanNotes(body && body.interview, guide.map((g) => g.k));
  const roleplay = r === 'VENDEDOR' ? cleanNotes(body && body.roleplay, ROLEPLAY.criteria.map((c) => c.k)) : {};
  const notes = String((body && body.notes) || '').trim().slice(0, 3000) || null;
  return { role: r, interview, roleplay, notes, summary: summarize(r, { interview, roleplay }) };
}
function summarize(role, sc) {
  const r = roleOf(role);
  const iv = avg(sc && sc.interview); const rp = avg(sc && sc.roleplay);
  const ivN = Object.keys((sc && sc.interview) || {}).length; const rpN = Object.keys((sc && sc.roleplay) || {}).length;
  let roleplayOk = null;
  if (r === 'VENDEDOR' && rpN === ROLEPLAY.criteria.length) roleplayOk = rp >= 3.5 && sc.roleplay.honestidade !== 1;
  return { interviewAvg: iv, interviewDone: ivN, interviewTotal: GUIDE[r].length, roleplayAvg: rp, roleplayDone: rpN,
    roleplayTotal: r === 'VENDEDOR' ? ROLEPLAY.criteria.length : 0, roleplayOk };
}

module.exports = { parseText, toText, normalize, publicView, score, maxScore, TEMPLATES, GUIDE, ROLEPLAY, buildScorecard, summarize, roleOf };
