// =====================================================================
// Liga Aberta F6 — PRIVACIDADE: baixar e apagar os próprios dados do Club/torneios
// ---------------------------------------------------------------------
// BAIXAR (exportData): JSON com o que é do domínio esportivo — perfil de atleta,
// inscrições, vagas de elenco, lances de súmula em que ele é o jogador, avisos que
// escreveu, preferências de aviso, consentimentos, medalhas (CPF só em HASH: o
// identityHash da credencial; nunca o CPF nem o sal), clubes, papéis e denúncias feitas.
// Venda, NF-e, transação e saldo TenisCash NÃO entram (são do varejo/fiscal).
//
// APAGAR (eraseSportData) — confirmação forte (digitar "APAGAR MEUS DADOS"):
//  - perfil de atleta: nome/foto/@/bio/metas viram vazios; o @ do Club (User.username) sai
//  - elenco: a vaga vira "Atleta removido" e perde a conta (os gols continuam do time)
//  - inscrição individual/dupla: a conta sai da inscrição; inscrição só dele vira "Atleta removido"
//  - racha: o jogador vira "Atleta removido" e perde a conta
//  - vínculo com times (TeamMembership → REMOVED) e clubes (ClubMembership apagada)
//  - preferências de aviso, celular (push do Club) e consentimentos esportivos apagados
//  - menores sob a responsabilidade dele: autorização revogada, nome apagado
//  - NÃO apaga venda, NF-e, transação, saldo TenisCash, inscrição paga, nem dado fiscal
//    (guarda obrigatória por lei). Medalha (credencial assinada) não muda de dono.
//  - Conta de login: só é desativada se NÃO há saldo, comissão, compra no varejo,
//    transação, torneio/clube dele nem papel de equipe. Senão a conta FICA e nasce um
//    pedido PENDING_ADMIN para o admin olhar (fila de moderação). Nada de dinheiro mexe.
// Todo pedido fica registrado em PrivacyRequest (quem, quando, o que foi feito).
// =====================================================================

const { prisma } = require('../middleware');
const roles = require('./tournamentRoles');

const CONFIRM_PHRASE = 'APAGAR MEUS DADOS';
const REMOVED_NAME = 'Atleta removido';
const SPORT_CONSENT_SCOPES = ['location_history', 'live_tracking', 'health_data', 'heatmap_optin'];
const MAX_ROWS = 5000;

class PrivacyError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const fail = (s, m, e) => { throw new PrivacyError(s, m, e); };

const safe = (p) => p.catch(() => []);
const safeOne = (p) => p.catch(() => null);

// --------------------------------------------------------------- BAIXAR
async function exportData(userId) {
  if (!(await roles.can(userId, null, null, 'PRIVACY_SELF', { targetUserId: userId }))) fail(401, 'entre na sua conta');
  const uid = String(userId);
  const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true, name: true, phone: true, email: true, username: true, cpf: true, createdAt: true, lgpdAccepted: true, lgpdDate: true } });
  if (!user) fail(404, 'conta não encontrada');
  const [profile, entryMembers, roster, posts, pref, push, consents, medals, teamMems, clubMems, tRoles, owned, pickups, reports, requests, minors, ratings, regs, evals, trainings, challenges, notifs] = await Promise.all([
    safeOne(prisma.athleteProfile.findUnique({ where: { userId: uid } })),
    safe(prisma.entryMember.findMany({ where: { userId: uid }, take: MAX_ROWS, select: { entry: { select: { id: true, name: true, status: true, tournamentId: true, categoryId: true, createdAt: true } } } })),
    safe(prisma.rosterPlayer.findMany({ where: { userId: uid }, take: MAX_ROWS })),
    safe(prisma.tournamentPost.findMany({ where: { authorId: uid }, take: MAX_ROWS, select: { id: true, tournamentId: true, title: true, body: true, imageUrl: true, pinned: true, hiddenAt: true, createdAt: true } })),
    safeOne(prisma.clubNotifyPref.findUnique({ where: { userId: uid } })),
    safe(prisma.pushSubscription.findMany({ where: { userId: uid, app: 'club' }, select: { id: true, userAgent: true, createdAt: true, lastUsedAt: true } })),
    safe(prisma.consent.findMany({ where: { userId: uid }, select: { scope: true, granted: true, version: true, grantedAt: true, revokedAt: true } })),
    safe(prisma.medal.findMany({ where: { userId: uid }, take: MAX_ROWS, select: { serial: true, credentialId: true, sport: true, eventName: true, categoryName: true, achievement: true, tier: true, placement: true, editionNumber: true, editionTotal: true, recipientName: true, identityHash: true, verificationCode: true, status: true, issuedAt: true, revokedAt: true, eventDate: true } })),
    safe(prisma.teamMembership.findMany({ where: { userId: uid }, select: { tournamentId: true, clubName: true, status: true, createdAt: true } })),
    safe(prisma.clubMembership.findMany({ where: { userId: uid }, select: { clubId: true, role: true, status: true, joinedAt: true, club: { select: { name: true, slug: true } } } })),
    safe(prisma.tournamentRole.findMany({ where: { userId: uid }, select: { tournamentId: true, role: true, entryId: true, createdAt: true } })),
    safe(prisma.tournament.findMany({ where: { ownerId: uid }, select: { id: true, slug: true, name: true, status: true, createdAt: true } })),
    safe(prisma.pickupPlayer.findMany({ where: { userId: uid }, select: { tournamentId: true, name: true, level: true, createdAt: true } })),
    safe(prisma.contentReport.findMany({ where: { reporterId: uid }, select: { targetType: true, targetId: true, reason: true, text: true, status: true, createdAt: true } })),
    safe(prisma.privacyRequest.findMany({ where: { userId: uid }, select: { kind: true, status: true, createdAt: true, summary: true } })),
    safe(prisma.minorProfile.findMany({ where: { guardianUserId: uid }, select: { id: true, firstName: true, birthDate: true, status: true, consentVersion: true, consentAt: true, ageVerification: true, revokedAt: true } })),
    safe(prisma.athleteRating.findMany({ where: { userId: uid } })),
    safe(prisma.tournamentRegistration.findMany({ where: { userId: uid }, take: MAX_ROWS, select: { id: true, tournamentId: true, categoryId: true, kind: true, displayName: true, status: true, contactName: true, contactPhone: true, contactEmail: true, athletes: true, roster: true, answers: true, termsAcceptedAt: true, feeCents: true, paidCents: true, tcCents: true, createdAt: true } })),
    safe(prisma.athleteEvaluation.findMany({ where: { userId: uid }, take: MAX_ROWS })),
    safe(prisma.trainingAttendance.findMany({ where: { userId: uid }, take: MAX_ROWS })),
    safe(prisma.playChallenge.findMany({ where: { OR: [{ challengerId: uid }, { challengedId: uid }] }, take: MAX_ROWS })),
    safe(prisma.appNotification.findMany({ where: { userId: uid }, orderBy: { createdAt: 'desc' }, take: 500, select: { type: true, title: true, body: true, link: true, createdAt: true } })),
  ]);
  const rosterIds = roster.map((r) => r.id);
  const events = rosterIds.length ? await safe(prisma.matchEvent.findMany({ where: { playerId: { in: rosterIds } }, take: MAX_ROWS, select: { matchId: true, entryId: true, playerId: true, type: true, minute: true, period: true, createdAt: true } })) : [];
  // nomes dos torneios citados (pra o JSON ser legível)
  const tIds = [...new Set([].concat(entryMembers.map((m) => m.entry && m.entry.tournamentId), posts.map((p) => p.tournamentId), teamMems.map((m) => m.tournamentId), tRoles.map((r) => r.tournamentId), pickups.map((p) => p.tournamentId)).filter(Boolean))];
  const ts = tIds.length ? await prisma.tournament.findMany({ where: { id: { in: tIds } }, select: { id: true, name: true, slug: true } }) : [];
  const rEntries = roster.length ? await prisma.tournamentEntry.findMany({ where: { id: { in: [...new Set(roster.map((r) => r.entryId))] } }, select: { id: true, name: true, tournamentId: true } }) : [];
  const out = {
    geradoEm: new Date().toISOString(),
    fusoHorario: 'America/Fortaleza',
    sobre: 'Seus dados do Club Sports & Tennis (ligas e torneios). Dados de compra, nota fiscal e saldo TenisCash não entram aqui: são do varejo e ficam guardados por obrigação legal.',
    conta: { id: user.id, nome: user.name, whatsapp: user.phone, email: user.email || null, usuario: user.username || null, cpfCadastrado: !!user.cpf, criadaEm: user.createdAt, lgpdAceito: user.lgpdAccepted, lgpdData: user.lgpdDate },
    perfilAtleta: profile ? { usuario: profile.username, foto: profile.avatarUrl, bio: profile.bio, nivel: profile.experienceLevel, sexo: profile.sex, anoNascimento: profile.birthYear, metas: profile.goals, criadoEm: profile.createdAt, atualizadoEm: profile.updatedAt } : null,
    torneios: ts,
    inscricoes: entryMembers.map((m) => m.entry).filter(Boolean),
    elenco: roster.map((r) => ({ id: r.id, time: (rEntries.find((e) => e.id === r.entryId) || {}).name || null, torneioId: (rEntries.find((e) => e.id === r.entryId) || {}).tournamentId || null, nome: r.name, numero: r.number, funcao: r.role, goleiro: r.isGoalkeeper, capitao: r.isCaptain, criadoEm: r.createdAt })),
    lancesDaSumula: events,
    avisosEscritos: posts,
    preferenciasDeAviso: pref ? { celular: pref.push, tipos: pref.types, whatsapp: pref.whatsapp, atualizadoEm: pref.updatedAt } : null,
    celularesComAviso: push,
    consentimentos: consents,
    medalhas: medals,
    vinculosComTimes: teamMems,
    clubes: clubMems.map((c) => ({ clube: c.club ? c.club.name : null, slug: c.club ? c.club.slug : null, papel: c.role, status: c.status, desde: c.joinedAt })),
    papeisEmTorneios: tRoles,
    torneiosQueOrganizo: owned,
    racha: pickups,
    ratings: ratings,
    denunciasQueFiz: reports,
    menoresSobMinhaResponsabilidade: minors,
    pedidosDePrivacidade: requests,
    inscricoesOnline: regs,
    avaliacoesDoTreinador: evals,
    treinos: trainings,
    desafios: challenges,
    avisosNoApp: notifs,
  };
  await prisma.privacyRequest.create({ data: { userId: uid, kind: 'EXPORT', status: 'DONE', summary: { counts: { inscricoes: out.inscricoes.length, elenco: out.elenco.length, lances: events.length, avisos: posts.length, medalhas: medals.length } } } });
  return out;
}

// --------------------------------------------------------------- APAGAR
// O que segura a conta de login (dinheiro/varejo/organização) — nada disso é mexido.
async function loginTies(uid) {
  const u = await prisma.user.findUnique({ where: { id: uid }, select: { balance: true, partnerBalance: true, role: true } });
  const ties = [];
  if (!u) return ['conta não encontrada'];
  if ((u.balance || 0) > 0) ties.push('saldo TenisCash');
  if ((u.partnerBalance || 0) > 0) ties.push('comissão de parceiro');
  if (u.role && u.role !== 'user') ties.push('conta da equipe/parceiro');
  const [sales, tx, ownedT, ownedC, regs] = await Promise.all([
    prisma.sale.count({ where: { customerUserId: uid } }).catch(() => 0),
    prisma.transaction.count({ where: { OR: [{ senderId: uid }, { receiverId: uid }] } }).catch(() => 0),
    prisma.tournament.count({ where: { ownerId: uid } }).catch(() => 0),
    prisma.club.count({ where: { ownerId: uid } }).catch(() => 0),
    // só inscrição com dinheiro de verdade (PIX/TenisCash) é guarda fiscal
    prisma.tournamentRegistration.count({ where: { userId: uid, OR: [{ paidCents: { gt: 0 } }, { tcCents: { gt: 0 } }] } }).catch(() => 0),
  ]);
  if (sales) ties.push('compras no varejo');
  if (tx) ties.push('movimentações TenisCash');
  if (ownedT) ties.push('torneios que você organiza');
  if (ownedC) ties.push('clubes que você é dono');
  if (regs) ties.push('inscrições pagas (guardadas por obrigação fiscal)');
  return ties;
}

async function eraseSportData(userId, { confirm } = {}) {
  if (!(await roles.can(userId, null, null, 'PRIVACY_SELF', { targetUserId: userId }))) fail(401, 'entre na sua conta');
  if (String(confirm || '').trim().toUpperCase() !== CONFIRM_PHRASE) fail(400, `para apagar, digite exatamente: ${CONFIRM_PHRASE}`, { code: 'CONFIRM_REQUIRED', phrase: CONFIRM_PHRASE });
  const uid = String(userId);
  const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true, active: true, cpf: true, balance: true } });
  if (!user || !user.active) fail(404, 'conta não encontrada');
  const ties = await loginTies(uid);
  const medalsKept = await prisma.medal.count({ where: { userId: uid } }).catch(() => 0);
  const done = {};
  // Lista de exclusão (Master Cup): nada da F6 altera os dados dele — o que é de lá fica
  // como está e vira pedido para o admin resolver com o atleta depois do evento.
  const exSlugs = [...require('./clubIdentity').excludedSlugs()];
  const exT = exSlugs.length ? await prisma.tournament.findMany({ where: { slug: { in: exSlugs } }, select: { id: true } }) : [];
  const exIds = exT.map((t) => t.id);
  const exEntryIds = exIds.length ? (await prisma.tournamentEntry.findMany({ where: { tournamentId: { in: exIds } }, select: { id: true } })).map((e) => e.id) : [];
  const keptExcluded = exIds.length ? {
    vagas: await prisma.rosterPlayer.count({ where: { userId: uid, entryId: { in: exEntryIds } } }),
    inscricoes: await prisma.entryMember.count({ where: { userId: uid, entryId: { in: exEntryIds } } }),
    vinculos: await prisma.teamMembership.count({ where: { userId: uid, tournamentId: { in: exIds }, NOT: { status: 'REMOVED' } } }),
  } : { vagas: 0, inscricoes: 0, vinculos: 0 };
  const hasExcluded = keptExcluded.vagas + keptExcluded.inscricoes + keptExcluded.vinculos > 0;
  const firstName = (((await prisma.user.findUnique({ where: { id: uid }, select: { name: true } })) || {}).name || '').trim().split(/\s+/)[0] || '';
  await prisma.$transaction(async (tx) => {
    // perfil de atleta (nome/foto/@ do Club)
    const prof = await tx.athleteProfile.updateMany({ where: { userId: uid }, data: { username: null, avatarUrl: null, bio: null, goals: null, zones: null, privacyDefaults: null, birthYear: null, sex: null, experienceLevel: null } });
    done.perfilAtleta = prof.count;
    await tx.user.update({ where: { id: uid }, data: { username: null } });
    // elenco: "Atleta removido" (gols seguem do time)
    const ros = await tx.rosterPlayer.updateMany({ where: { userId: uid, entryId: { notIn: exEntryIds } }, data: { name: REMOVED_NAME, userId: null } });
    done.vagasDeElenco = ros.count;
    // inscrição individual/dupla
    const ems = await tx.entryMember.findMany({ where: { userId: uid, entryId: { notIn: exEntryIds } }, select: { id: true, entryId: true, entry: { select: { name: true } } } });
    for (const em of ems) {
      const others = await tx.entryMember.count({ where: { entryId: em.entryId, NOT: { userId: uid } } });
      await tx.entryMember.delete({ where: { id: em.id } });
      if (!others) await tx.tournamentEntry.update({ where: { id: em.entryId }, data: { name: REMOVED_NAME } });
      else if (firstName.length >= 2 && em.entry && em.entry.name) {
        // dupla "João & Maria": só o nome DELE sai (palavra inteira, sem mexer no parceiro)
        const esc = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const nn = em.entry.name.replace(new RegExp('(^|[^\\p{L}])' + esc + '(?=$|[^\\p{L}])', 'giu'), '$1' + REMOVED_NAME);
        if (nn !== em.entry.name) await tx.tournamentEntry.update({ where: { id: em.entryId }, data: { name: nn.slice(0, 80) } });
      }
    }
    done.inscricoes = ems.length;
    const pk = await tx.pickupPlayer.updateMany({ where: { userId: uid, tournamentId: { notIn: exIds } }, data: { name: REMOVED_NAME, userId: null } });
    done.racha = pk.count;
    // nível/rating do atleta (aparece em ranking público com nome e cidade) — sai; o do TIME fica
    const ar = await tx.athleteRating.deleteMany({ where: { userId: uid } });
    const gr = await tx.glickoRating.deleteMany({ where: { subjectType: 'USER', OR: [{ userId: uid }, { subjectKey: uid }] } }).catch(() => ({ count: 0 }));
    done.ratings = ar.count + gr.count;
    // avaliações do treinador sobre ele, presença/nota de treino e avisos no app
    const ev = await tx.athleteEvaluation.deleteMany({ where: { userId: uid } }).catch(() => ({ count: 0 }));
    done.avaliacoes = ev.count;
    const ta = await tx.trainingAttendance.deleteMany({ where: { userId: uid } }).catch(() => ({ count: 0 }));
    done.treinos = ta.count;
    const an = await tx.appNotification.deleteMany({ where: { userId: uid } }).catch(() => ({ count: 0 }));
    done.avisosNoApp = an.count;
    const tm = await tx.teamMembership.updateMany({ where: { userId: uid, NOT: { status: 'REMOVED' }, tournamentId: { notIn: exIds } }, data: { status: 'REMOVED', respondedAt: new Date() } });
    done.vinculosComTimes = tm.count;
    const cm = await tx.clubMembership.deleteMany({ where: { userId: uid } });
    done.clubes = cm.count;
    // papel de JOGADOR nos torneios (o de organização fica — é decisão do admin)
    const pr = await tx.tournamentRole.deleteMany({ where: { userId: uid, role: 'PLAYER', tournamentId: { notIn: exIds } } });
    done.papeisDeJogador = pr.count;
    const pref = await tx.clubNotifyPref.deleteMany({ where: { userId: uid } });
    done.preferencias = pref.count;
    const push = await tx.pushSubscription.deleteMany({ where: { userId: uid, app: 'club' } });
    done.celularesComAviso = push.count;
    const cons = await tx.consent.deleteMany({ where: { userId: uid, scope: { in: SPORT_CONSENT_SCOPES } } });
    done.consentimentosEsportivos = cons.count;
    const fol = await tx.athleteFollow.deleteMany({ where: { OR: [{ followerId: uid }, { followeeId: uid }] } }).catch(() => ({ count: 0 }));
    done.seguidores = fol.count;
    const mn = await tx.minorProfile.updateMany({ where: { guardianUserId: uid }, data: { status: 'REVOKED', revokedAt: new Date(), firstName: 'Removido', birthDate: '' } });
    done.menores = mn.count;
  }, { timeout: 60000 });

  if (hasExcluded) ties.push('jogos num torneio em andamento da lista de exclusão (Master Cup) — o admin conclui depois do evento');
  let loginExcluded = false;
  let status = 'DONE';
  if (!ties.length) {
    // nenhum vínculo de dinheiro/varejo/organização: desativa o login (mesmo padrão do
    // "Excluir conta" do app — CPF vai para deletedCpf só como trava anti-fraude de bônus);
    // NÃO mexe em saldo (é zero aqui por definição).
    await prisma.user.update({
      where: { id: uid },
      data: { active: false, name: 'Conta excluída', phone: `deleted_${uid}`, email: null, cpf: null, deletedCpf: user.cpf || null, birthDate: null, cep: null, street: null, number: null, complement: null, neighborhood: null, city: null, state: null, height: null, weight: null, shirtSize: null, shoeSize: null, sportsPractice: null, sportsWant: null, sportsWhere: null, favBrands: null },
    });
    loginExcluded = true;
  } else {
    status = 'PENDING_ADMIN';
  }
  const summary = { apagado: done, contaDeLogin: loginExcluded ? 'desativada' : 'mantida', motivosParaManter: ties, medalhasMantidas: medalsKept, mantidoNoMasterCup: hasExcluded ? keptExcluded : null, naoApagado: ['vendas', 'notas fiscais', 'transações', 'saldo TenisCash', 'inscrições pagas', 'medalhas (credencial assinada)'] };
  const reqRow = await prisma.privacyRequest.create({ data: { userId: uid, kind: 'DELETE', status, summary, note: ties.length ? 'Conta de login mantida: ' + ties.join(', ') + '. Revisar com o atleta.' : null } });
  return { ok: true, requestId: reqRow.id, status, loginExcluded, keptBecause: ties, summary };
}

// Perfil apagado (pedido DELETE feito)? O card público /atleta some.
async function isErased(userId) {
  if (!userId) return false;
  try {
    const r = await prisma.privacyRequest.findFirst({ where: { userId: String(userId), kind: 'DELETE' }, select: { id: true } });
    return !!r;
  } catch (_) { return false; }
}

// Fila do admin: pedidos que precisam de olho humano.
async function listRequests(req, { status = 'PENDING_ADMIN', limit = 50 } = {}) {
  if (!(await roles.can(req.userId, req.userRole, null, 'MODERATE'))) fail(403, 'só a moderação (administrador do sistema)');
  const st = ['PENDING_ADMIN', 'DONE', 'CLOSED', 'ALL'].includes(String(status).toUpperCase()) ? String(status).toUpperCase() : 'PENDING_ADMIN';
  const rows = await prisma.privacyRequest.findMany({ where: st === 'ALL' ? {} : { status: st }, orderBy: { createdAt: 'desc' }, take: Math.max(1, Math.min(Number(limit) || 50, 200)) });
  const users = rows.length ? await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true, active: true } }) : [];
  const uById = new Map(users.map((u) => [u.id, u]));
  return { items: rows.map((r) => ({ ...r, user: uById.get(r.userId) || { id: r.userId } })) };
}
async function closeRequest(req, id, { note } = {}) {
  if (!(await roles.can(req.userId, req.userRole, null, 'MODERATE'))) fail(403, 'só a moderação (administrador do sistema)');
  const r = await prisma.privacyRequest.findUnique({ where: { id: String(id || '') } });
  if (!r) fail(404, 'pedido não encontrado');
  const upd = await prisma.privacyRequest.update({ where: { id: r.id }, data: { status: 'CLOSED', resolvedBy: req.userId, resolvedAt: new Date(), note: [r.note, note ? 'Admin: ' + String(note).slice(0, 500) : null].filter(Boolean).join(' | ') || null } });
  await require('./ligaModeration').logGlobal({ actorId: req.userId, action: 'privacy.resolve', targetType: 'PRIVACY_REQUEST', targetId: r.id, before: { status: r.status }, after: { status: 'CLOSED' } });
  return { ok: true, request: upd };
}

module.exports = { exportData, eraseSportData, isErased, listRequests, closeRequest, loginTies, PrivacyError, CONFIRM_PHRASE, REMOVED_NAME };
