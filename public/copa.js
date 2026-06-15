(function () {
  const API = window.location.origin + '/api';
  const token = localStorage.getItem('tc_token');
  const cachedUser = safeJson(localStorage.getItem('tc_user'));

  let state = null;
  let activeTab = 'today';
  let matchFilter = 'all';
  let teamQuery = '';
  let albumQuery = '';
  let albumTeam = 'all';
  let albumPosition = 'all';
  let albumVisibleCount = 120;
  let albumState = {
    loaded: false,
    loading: false,
    players: [],
    teams: [],
    errors: [],
    status: 'idle',
  };
  let brazilSquadState = {
    loaded: false,
    loading: false,
    teamId: '',
    players: [],
    error: '',
  };
  let brazilUserLineup = null;
  let hasRendered = false;
  let toastTimer = null;
  let previousScoreboard = new Map();
  let recentGoalMatchIds = new Set();
  let goalQueue = [];
  let matchLineupCache = new Map();
  let goalAnimationTimer = null;
  let goalAnimationActive = false;
  let refreshTimer = null;
  let refreshInFlight = false;
  let visibilityRefreshBound = false;
  let localGoalPreviewPlayed = false;

  const LIVE_REFRESH_MS = 20000;
  const GOAL_ANIMATION_MS = 3400;

  const FILTERS = [
    { id: 'all', label: 'Todos' },
    { id: 'today', label: 'Hoje' },
    { id: 'live', label: 'Ao vivo' },
    { id: 'brazil', label: 'Brasil' },
    { id: 'open', label: 'Abertos' },
    { id: 'final', label: 'Encerrados' },
  ];

  const BRAZIL_FORMATIONS = {
    '4-3-3': [
      ['GOL', 'Goleiro'], ['LD', 'Defensor'], ['ZAG', 'Defensor'], ['ZAG', 'Defensor'], ['LE', 'Defensor'],
      ['VOL', 'Meio-campista'], ['MEI', 'Meio-campista'], ['MEI', 'Meio-campista'],
      ['PD', 'Atacante'], ['CA', 'Atacante'], ['PE', 'Atacante'],
    ],
    '4-2-3-1': [
      ['GOL', 'Goleiro'], ['LD', 'Defensor'], ['ZAG', 'Defensor'], ['ZAG', 'Defensor'], ['LE', 'Defensor'],
      ['VOL', 'Meio-campista'], ['VOL', 'Meio-campista'], ['MEI', 'Meio-campista'],
      ['PD', 'Atacante'], ['CA', 'Atacante'], ['PE', 'Atacante'],
    ],
    '3-5-2': [
      ['GOL', 'Goleiro'], ['ZAG', 'Defensor'], ['ZAG', 'Defensor'], ['ZAG', 'Defensor'],
      ['ALA', 'Defensor'], ['VOL', 'Meio-campista'], ['MEI', 'Meio-campista'], ['MEI', 'Meio-campista'], ['ALA', 'Defensor'],
      ['ATA', 'Atacante'], ['ATA', 'Atacante'],
    ],
    '4-4-2': [
      ['GOL', 'Goleiro'], ['LD', 'Defensor'], ['ZAG', 'Defensor'], ['ZAG', 'Defensor'], ['LE', 'Defensor'],
      ['VOL', 'Meio-campista'], ['MEI', 'Meio-campista'], ['MEI', 'Meio-campista'], ['MEI', 'Meio-campista'],
      ['ATA', 'Atacante'], ['ATA', 'Atacante'],
    ],
  };

  const FLAG = {
    ARG: 'ar',
    AUS: 'au',
    AUT: 'at',
    BEL: 'be',
    BRA: 'br',
    CAN: 'ca',
    CIV: 'ci',
    COL: 'co',
    CMR: 'cm',
    CRC: 'cr',
    CRO: 'hr',
    CZE: 'cz',
    DEN: 'dk',
    ECU: 'ec',
    EGY: 'eg',
    ENG: 'gb-eng',
    ESP: 'es',
    FRA: 'fr',
    GER: 'de',
    GHA: 'gh',
    IRN: 'ir',
    ITA: 'it',
    JPN: 'jp',
    KOR: 'kr',
    MAR: 'ma',
    MEX: 'mx',
    NED: 'nl',
    NGA: 'ng',
    NOR: 'no',
    NZL: 'nz',
    PAN: 'pa',
    PAR: 'py',
    POL: 'pl',
    POR: 'pt',
    QAT: 'qa',
    RSA: 'za',
    SAU: 'sa',
    SCO: 'gb-sct',
    SEN: 'sn',
    SRB: 'rs',
    SUI: 'ch',
    SWE: 'se',
    TUN: 'tn',
    TUR: 'tr',
    UKR: 'ua',
    URU: 'uy',
    USA: 'us',
    WAL: 'gb-wls',
  };

  function safeJson(value) {
    try { return JSON.parse(value || 'null'); } catch (_) { return null; }
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalize(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function fmtNumber(value) {
    return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function fmtMoney(value) {
    return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
  }

  function fmtPercent(value) {
    return `${fmtNumber(value)}%`;
  }

  function fmtDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Horário a confirmar';
    return new Intl.DateTimeFormat('pt-BR', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date).replace('.', '');
  }

  function fmtDay(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Data a confirmar';
    return new Intl.DateTimeFormat('pt-BR', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    }).format(date).replace('.', '');
  }

  function fmtNewsDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Agora';
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function canManageCopa() {
    return Boolean(state && state.user && state.user.canManageCopa);
  }

  function accountPillHtml(title, subtitle, href) {
    const body = `
      <span class="account-copy">
        <strong>${esc(title)}</strong>
        <small>${esc(subtitle)}</small>
      </span>
    `;
    return href ? `<a class="account-link" href="${esc(href)}">${body}</a>` : body;
  }

  function dateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function teamAsset(code, name, imageUrl, className) {
    const baseClass = className || 'team-logo';
    const symbolClass = `selection-symbol ${baseClass}${baseClass === 'mini-logo' ? ' selection-symbol-mini' : ''}${baseClass === 'sticker-flag' ? ' selection-symbol-sticker' : ''}`;
    const label = name ? `Simbolo ${name}` : 'Simbolo da selecao';
    if (imageUrl) {
      return `<span class="${symbolClass}" role="img" aria-label="${esc(label)}"><img class="selection-symbol-img" src="${esc(imageUrl)}" alt="" loading="eager" decoding="async" aria-hidden="true"></span>`;
    }
    const flag = FLAG[String(code || '').toUpperCase()];
    if (flag) {
      return `<span class="${symbolClass}" role="img" aria-label="${esc(label)}"><img class="selection-symbol-img" src="https://flagcdn.com/w80/${esc(flag)}.png" alt="" loading="eager" decoding="async" aria-hidden="true"></span>`;
    }
    return `<span class="${symbolClass} logo-fallback" role="img" aria-label="${esc(label)}"><span class="selection-symbol-fallback">${esc(String(name || '?').slice(0, 2).toUpperCase())}</span></span>`;
  }

  function playerInitials(name) {
    return String(name || 'Jogador')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || 'ST';
  }

  function positionClass(position) {
    const key = normalize(position);
    if (key.includes('goleiro')) return 'pos-gk';
    if (key.includes('defensor')) return 'pos-def';
    if (key.includes('meio')) return 'pos-mid';
    if (key.includes('atacante')) return 'pos-att';
    return 'pos-squad';
  }

  function playerPhoto(player) {
    if (player.photo) {
      return `<img src="${esc(player.photo)}" alt="${esc(player.name)}" loading="lazy">`;
    }
    return `<span class="sticker-initials">${esc(playerInitials(player.name))}</span>`;
  }

  async function api(path, method, body) {
    const opts = {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(API + path, opts);
    const text = await res.text();
    const data = text ? safeJson(text) : {};
    if (!res.ok) throw new Error((data && data.error) || text || ('Erro ' + res.status));
    return data || {};
  }

  function showToast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
  }

  function scoreValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function scoreSnapshot(match) {
    return {
      status: match.status || '',
      homeScore: scoreValue(match.homeScore),
      awayScore: scoreValue(match.awayScore),
    };
  }

  function rememberScoreboard(nextState) {
    previousScoreboard = new Map(
      ((nextState && nextState.matches) || []).map((match) => [String(match.id), scoreSnapshot(match)])
    );
  }

  function buildGoalEvent(match, side, delta) {
    const isHome = side === 'home';
    const scoringTeam = isHome ? match.home : match.away;
    const scoringCode = isHome ? match.homeCode : match.awayCode;
    const scoringLogo = isHome ? match.homeLogo : match.awayLogo;
    const isBrazilGoal = normalize(scoringTeam) === 'brasil' || normalize(scoringCode) === 'bra';
    return {
      matchId: String(match.id),
      side,
      delta,
      scoringTeam: scoringTeam || 'Selecao',
      scoringCode,
      scoringLogo,
      isBrazilGoal,
      home: match.home || 'Mandante',
      away: match.away || 'Visitante',
      homeCode: match.homeCode || '',
      awayCode: match.awayCode || '',
      homeLogo: match.homeLogo || '',
      awayLogo: match.awayLogo || '',
      homeScore: scoreValue(match.homeScore),
      awayScore: scoreValue(match.awayScore),
      stage: match.stage || match.group || 'Copa do Mundo',
      stateLabel: match.stateLabel || 'Ao vivo',
    };
  }

  function detectGoalEvents(nextState) {
    if (!previousScoreboard.size) return [];
    const events = [];
    ((nextState && nextState.matches) || []).forEach((match) => {
      const previous = previousScoreboard.get(String(match.id));
      if (!previous) return;

      const homeScore = scoreValue(match.homeScore);
      const awayScore = scoreValue(match.awayScore);
      if (homeScore === null || awayScore === null) return;

      const liveContext = match.status === 'LIVE' || previous.status === 'LIVE';
      if (!liveContext) return;

      const previousHome = previous.homeScore === null ? 0 : previous.homeScore;
      const previousAway = previous.awayScore === null ? 0 : previous.awayScore;
      if (homeScore > previousHome) events.push(buildGoalEvent(match, 'home', homeScore - previousHome));
      if (awayScore > previousAway) events.push(buildGoalEvent(match, 'away', awayScore - previousAway));
    });
    return events.slice(0, 4);
  }

  function markGoalMatches(events) {
    events.forEach((event) => {
      recentGoalMatchIds.add(event.matchId);
      window.setTimeout(() => {
        recentGoalMatchIds.delete(event.matchId);
        document.querySelectorAll('.match-card.has-goal-flash').forEach((card) => {
          if (card.getAttribute('data-match-id') === event.matchId) {
            card.classList.remove('has-goal-flash');
          }
        });
      }, 5600);
    });
  }

  function goalConfettiHtml() {
    const colors = [
      'oklch(83% 0.17 91)',
      'oklch(58% 0.17 146)',
      'oklch(55% 0.2 31)',
      'oklch(47% 0.16 252)',
      'oklch(98% 0.004 115)',
    ];
    return Array.from({ length: 28 }).map((_, index) => {
      const x = 5 + ((index * 17) % 90);
      const delay = (index % 9) * 72;
      const rotation = (index * 31) % 180;
      return `<span style="--x:${x}%;--d:${delay}ms;--r:${rotation}deg;--c:${colors[index % colors.length]}"></span>`;
    }).join('');
  }

  function renderGoalCelebration(event) {
    const el = document.getElementById('goal-celebration');
    if (!el) return false;
    const score = `${event.homeScore === null ? '-' : fmtNumber(event.homeScore)} x ${event.awayScore === null ? '-' : fmtNumber(event.awayScore)}`;
    const lead = event.isBrazilGoal ? 'Gol do Brasil' : 'Saiu gol';
    const deltaText = event.delta > 1 ? `${fmtNumber(event.delta)} gols no lance` : 'Gol confirmado';
    el.innerHTML = `
      <div class="goal-confetti" aria-hidden="true">${goalConfettiHtml()}</div>
      <div class="goal-card">
        <div class="goal-stadium" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <p class="goal-kicker">${esc(lead)} · ${esc(deltaText)}</p>
        <strong class="goal-word">GOOOL</strong>
        <div class="goal-team">
          ${teamAsset(event.scoringCode, event.scoringTeam, event.scoringLogo, 'goal-symbol')}
          <span>
            <strong>${esc(event.scoringTeam)}</strong>
            <small>${esc(event.stage)} · ${esc(event.stateLabel)}</small>
          </span>
        </div>
        <div class="goal-scoreline">
          <span>${esc(event.home)}</span>
          <strong>${esc(score)}</strong>
          <span>${esc(event.away)}</span>
        </div>
      </div>
    `;
    el.setAttribute('aria-hidden', 'false');
    el.classList.remove('is-visible');
    void el.offsetWidth;
    el.classList.add('is-visible');
    try {
      if (navigator.vibrate) navigator.vibrate([80, 45, 110]);
    } catch (_) {}
    return true;
  }

  function hideGoalCelebration() {
    const el = document.getElementById('goal-celebration');
    if (!el) return;
    el.classList.remove('is-visible');
    el.setAttribute('aria-hidden', 'true');
  }

  function playNextGoalCelebration() {
    const event = goalQueue.shift();
    if (!event) {
      goalAnimationActive = false;
      return;
    }
    goalAnimationActive = true;
    if (!renderGoalCelebration(event)) {
      playNextGoalCelebration();
      return;
    }
    clearTimeout(goalAnimationTimer);
    goalAnimationTimer = window.setTimeout(() => {
      hideGoalCelebration();
      window.setTimeout(playNextGoalCelebration, 280);
    }, GOAL_ANIMATION_MS);
  }

  function queueGoalCelebrations(events) {
    if (!events.length) return;
    goalQueue.push(...events);
    if (!goalAnimationActive) playNextGoalCelebration();
  }

  function currentStateEndpoint() {
    return token && !(state && state.isPublic) ? '/copa/summary' : '/copa/public';
  }

  function applyState(nextState, options) {
    const shouldAnimate = Boolean(options && options.animate && hasRendered);
    const goalEvents = shouldAnimate ? detectGoalEvents(nextState) : [];
    if (goalEvents.length) markGoalMatches(goalEvents);
    state = nextState;
    syncBrazilUserLineup(nextState);
    renderAll();
    rememberScoreboard(nextState);
    if (goalEvents.length) queueGoalCelebrations(goalEvents);
    startLiveRefresh();
    maybeRunLocalGoalPreview();
  }

  async function refreshLiveState() {
    if (!state || refreshInFlight || document.hidden) return;
    refreshInFlight = true;
    try {
      applyState(await api(currentStateEndpoint()), { animate: true });
    } catch (err) {
      console.warn('[copa] Atualizacao ao vivo falhou:', err.message);
    } finally {
      refreshInFlight = false;
    }
  }

  function startLiveRefresh() {
    if (!refreshTimer) {
      refreshTimer = window.setInterval(refreshLiveState, LIVE_REFRESH_MS);
    }
    if (!visibilityRefreshBound) {
      visibilityRefreshBound = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshLiveState();
      });
    }
  }

  function exposeLocalGoalPreview() {
    if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return;
    window.__copaPreviewGoal = () => {
      const match = ((state && state.matches) || []).find((item) => item.status === 'LIVE')
        || ((state && state.matches) || [])[0]
        || {};
      const previewMatch = {
        ...match,
        status: 'LIVE',
        homeScore: (scoreValue(match.homeScore) || 0) + 1,
        awayScore: scoreValue(match.awayScore) || 0,
        stateLabel: match.stateLabel || 'Ao vivo',
      };
      const event = buildGoalEvent(previewMatch, 'home', 1);
      markGoalMatches([event]);
      renderAll();
      queueGoalCelebrations([event]);
      return event;
    };
  }

  function maybeRunLocalGoalPreview() {
    if (localGoalPreviewPlayed || !['localhost', '127.0.0.1'].includes(window.location.hostname)) return;
    if (!new URLSearchParams(window.location.search).has('goalpreview')) return;
    localGoalPreviewPlayed = true;
    window.setTimeout(() => {
      if (window.__copaPreviewGoal) window.__copaPreviewGoal();
    }, 700);
  }

  function isBrazilMatch(match) {
    return [match.homeCode, match.awayCode].some((code) => normalize(code) === 'bra')
      || [match.home, match.away].some((name) => normalize(name) === 'brasil');
  }

  function matchFromState(match) {
    if (!match || !state) return match;
    return (state.matches || []).find((item) => String(item.id) === String(match.id)) || match;
  }

  function statusMeta(match) {
    if (match.status === 'FINAL') return { label: 'Encerrado', className: 'final' };
    if (match.status === 'LIVE') return { label: match.stateLabel || 'Ao vivo', className: 'live' };
    if (match.locked) return { label: 'Travado', className: 'locked' };
    return { label: 'Aberto', className: 'open' };
  }

  function scoreLine(match) {
    const hasScore = Number.isFinite(match.homeScore) && Number.isFinite(match.awayScore);
    if ((match.status === 'FINAL' || match.status === 'LIVE') && hasScore) {
      return `${match.homeScore} × ${match.awayScore}`;
    }
    return '×';
  }

  function resultLine(match) {
    if (match.status === 'FINAL') return `Final: ${match.homeScore} × ${match.awayScore}`;
    if (match.status === 'LIVE' && Number.isFinite(match.homeScore) && Number.isFinite(match.awayScore)) {
      return `Ao vivo: ${match.homeScore} × ${match.awayScore}`;
    }
    return fmtDate(match.kickoff);
  }

  function predictionText(match) {
    if (state && state.isPublic) {
      return match.locked ? 'Consulta liberada' : 'Entre para palpitar';
    }
    if (!match.prediction) return match.locked ? 'Sem palpite' : 'Palpite aberto';
    return `Seu palpite: ${match.prediction.homeScore} × ${match.prediction.awayScore}`;
  }

  function rewardText(match) {
    if (state && state.isPublic) {
      return match.locked ? 'Resultado oficial' : 'Exato: 100 pts + T$ 10,00';
    }
    return `${fmtNumber(match.score.points)} pts · T$ ${fmtMoney(match.score.tenisCash)}`;
  }

  function canRequestLineup(match) {
    if (!match) return false;
    if (match.status === 'LIVE' || match.status === 'FINAL' || match.locked) return true;
    if (dateKey(match.kickoff) === todayKey()) return true;
    const kickoff = new Date(match.kickoff).getTime();
    if (!Number.isFinite(kickoff)) return false;
    const hoursUntilKickoff = (kickoff - Date.now()) / (60 * 60 * 1000);
    return hoursUntilKickoff <= 12 && hoursUntilKickoff >= -6;
  }

  function lineupAction(match, className) {
    if (!canRequestLineup(match)) return '';
    return `<button class="${esc(className || 'lineup-action')}" type="button" data-match-lineup="${esc(match.id)}">Escalação</button>`;
  }

  function matchCard(match, options) {
    const compact = Boolean(options && options.compact);
    const publicMode = Boolean(state && state.isPublic);
    const pred = match.prediction || {};
    const homeValue = Number.isInteger(pred.homeScore) ? pred.homeScore : '';
    const awayValue = Number.isInteger(pred.awayScore) ? pred.awayScore : '';
    const meta = statusMeta(match);
    const lockedWithoutPrediction = match.locked && !match.prediction;
    const cardClasses = [
      'match-card',
      compact ? 'is-compact' : '',
      meta.className ? `is-${meta.className}` : '',
      isBrazilMatch(match) ? 'is-brazil' : '',
      recentGoalMatchIds.has(String(match.id)) ? 'has-goal-flash' : '',
    ].filter(Boolean).join(' ');

    const lineupButton = lineupAction(match);
    const editor = publicMode
      ? `<div class="match-action-stack"><a class="action-link" href="/">${match.locked ? 'Abrir TenisCash' : 'Entrar e palpitar'}</a>${lineupButton}</div>`
      : lockedWithoutPrediction
        ? `<div class="match-action-stack"><div class="locked-callout">Palpites encerrados</div>${lineupButton}</div>`
        : `
          <div class="match-action-stack">
          <div class="score-editor">
            <input type="number" min="0" max="20" step="1" inputmode="numeric" name="homeScore" value="${esc(homeValue)}" aria-label="Gols de ${esc(match.home)}" ${match.locked ? 'disabled' : ''}>
            <span class="score-sep">×</span>
            <input type="number" min="0" max="20" step="1" inputmode="numeric" name="awayScore" value="${esc(awayValue)}" aria-label="Gols de ${esc(match.away)}" ${match.locked ? 'disabled' : ''}>
            <button class="save-btn" type="submit" ${match.locked ? 'disabled' : ''}>Salvar</button>
          </div>
          ${lineupButton}
          </div>
        `;

    return `
      <form class="${cardClasses}" data-match-id="${esc(match.id)}">
        <div class="match-card-top">
          <div>
            <span class="match-stage">${esc(match.stage || match.group || 'Copa')}</span>
            <strong>${esc(resultLine(match))}</strong>
          </div>
          <span class="status-pill ${esc(meta.className)}">${esc(meta.label)}</span>
        </div>

        <div class="scoreboard">
          <div class="score-team">
            ${teamAsset(match.homeCode, match.home, match.homeLogo)}
            <span>${esc(match.home)}</span>
            <small>${esc(match.homeCode || '')}</small>
          </div>
          <div class="score-box">
            <strong>${esc(scoreLine(match))}</strong>
            <span>${match.status === 'SCHEDULED' && !match.locked ? 'Palpite' : 'Placar'}</span>
          </div>
          <div class="score-team away">
            ${teamAsset(match.awayCode, match.away, match.awayLogo)}
            <span>${esc(match.away)}</span>
            <small>${esc(match.awayCode || '')}</small>
          </div>
        </div>

        <div class="prediction-row">
          <div>
            <strong>${esc(predictionText(match))}</strong>
            <span>${esc(rewardText(match))}</span>
          </div>
          ${editor}
        </div>
      </form>
    `;
  }

  function smallMatchRow(match) {
    if (!match) return '<p class="muted-copy">Aguardando calendário.</p>';
    const meta = statusMeta(match);
    return `
      <div class="small-match-row">
        <div class="small-team">
          ${teamAsset(match.homeCode, match.home, match.homeLogo, 'mini-logo')}
          <span>${esc(match.home)}</span>
        </div>
        <strong>${esc(scoreLine(match))}</strong>
        <div class="small-team away">
          <span>${esc(match.away)}</span>
          ${teamAsset(match.awayCode, match.away, match.awayLogo, 'mini-logo')}
        </div>
        <span class="status-pill ${esc(meta.className)}">${esc(meta.label)}</span>
      </div>
    `;
  }

  function renderHero() {
    const hero = document.getElementById('hero-board');
    if (!hero || !state) return;
    const featured = state.featured || {};
    const summary = state.summary || {};
    const next = featured.nextMatch || summary.nextMatch || {};
    const brazil = featured.brazilMatch || null;
    const publicMode = Boolean(state.isPublic);

    hero.innerHTML = `
      <div class="hero-score">
        <div class="score-label">
          <span>Próximo jogo</span>
          <strong>${esc(next.stage || 'Copa')}</strong>
        </div>
        <div class="hero-versus">
          <div>
            ${teamAsset(next.homeCode, next.home, next.homeLogo)}
            <strong>${esc(next.home || 'A definir')}</strong>
          </div>
          <span>${esc(scoreLine(next))}</span>
          <div>
            ${teamAsset(next.awayCode, next.away, next.awayLogo)}
            <strong>${esc(next.away || 'A definir')}</strong>
          </div>
        </div>
        <p>${esc(fmtDate(next.kickoff))}${next.venue ? ' · ' + esc(next.venue) : ''}</p>
      </div>

      <div class="hero-side">
        <button class="hero-tile" type="button" data-tab="pool">
          <span>Bolão S&T</span>
          <strong>${publicMode ? 'Entrar' : `${fmtNumber(summary.points)} pts`}</strong>
          <small>${publicMode ? 'Camisa oficial + T$' : `T$ ${fmtMoney(summary.tenisCash)}`}</small>
        </button>
        <button class="hero-tile yellow" type="button" data-tab="brazil">
          <span>Brasil</span>
          <strong>${brazil ? esc(resultLine(brazil)) : 'Acompanhar'}</strong>
          <small>${brazil ? esc(`${brazil.home} × ${brazil.away}`) : 'Seleção brasileira'}</small>
        </button>
      </div>
    `;
  }

  function renderTopbar() {
    if (!state) return;
    const userPill = document.getElementById('user-pill');
    const myRank = document.getElementById('my-rank');
    if (myRank) myRank.textContent = state.isPublic ? 'Visitante' : `${fmtNumber(state.summary.rank)}º lugar`;

    if (!userPill) return;
    if (state.isPublic) {
      userPill.innerHTML = accountPillHtml('Entrar no bolão', 'Visitante', '/');
    } else {
      userPill.innerHTML = accountPillHtml(state.user.name, `T$ ${fmtMoney(state.user.balance)}`);
    }
  }

  function renderFlow() {
    const list = document.getElementById('flow-list');
    if (!list || !state) return;
    const flow = state.accessMap || [];
    list.innerHTML = flow.map((item, index) => `
      <button class="flow-step" type="button" data-tab="${esc(item.tab)}">
        <span>${fmtNumber(index + 1)}</span>
        <strong>${esc(item.label)}</strong>
        <small>${esc(item.description)}</small>
      </button>
    `).join('') || '<p class="muted-copy">Fluxo da Copa aparece aqui.</p>';
  }

  function renderToday() {
    const grid = document.getElementById('today-grid');
    const count = document.getElementById('today-count');
    if (!grid || !state) return;
    const featured = state.featured || {};
    const todayMatches = featured.todayMatches || [];
    const liveMatches = featured.liveMatches || [];
    const lastResults = featured.lastResults || [];
    const brazil = featured.brazilMatch || null;
    const next = featured.nextMatch || state.summary.nextMatch;
    if (count) count.textContent = `${fmtNumber(todayMatches.length)} jogos hoje`;

    grid.innerHTML = `
      <article class="feature-card main-feature">
        <div class="card-head">
          <p class="eyebrow">${liveMatches.length ? 'Ao vivo agora' : 'Próximo da fila'}</p>
          <span>${esc(next ? fmtDay(next.kickoff) : 'Copa')}</span>
        </div>
        ${matchCard(liveMatches[0] || next, { compact: true })}
      </article>

      <article class="feature-card brazil-feature">
        <div class="card-head">
          <p class="eyebrow">Seleção brasileira</p>
          <span>BRA</span>
        </div>
        ${brazil ? smallMatchRow(brazil) : '<p class="muted-copy">Brasil ainda sem jogo destacado.</p>'}
      </article>

      <article class="feature-card">
        <div class="card-head">
          <p class="eyebrow">Jogos de hoje</p>
          <span>${fmtNumber(todayMatches.length)}</span>
        </div>
        <div class="stack-list">
          ${(todayMatches.length ? todayMatches : [next].filter(Boolean)).slice(0, 5).map(smallMatchRow).join('')}
        </div>
      </article>

      <article class="feature-card">
        <div class="card-head">
          <p class="eyebrow">Últimos resultados</p>
          <span>${fmtNumber(lastResults.length)}</span>
        </div>
        <div class="stack-list">
          ${(lastResults.length ? lastResults : []).slice(0, 5).map(smallMatchRow).join('') || '<p class="muted-copy">Resultados aparecem aqui ao fim dos jogos.</p>'}
        </div>
      </article>
    `;
  }

  function filterMatches(matches) {
    const today = todayKey();
    return matches.filter((match) => {
      if (matchFilter === 'today') return dateKey(match.kickoff) === today;
      if (matchFilter === 'live') return match.status === 'LIVE';
      if (matchFilter === 'brazil') return isBrazilMatch(match);
      if (matchFilter === 'open') return !match.locked;
      if (matchFilter === 'final') return match.status === 'FINAL';
      return true;
    });
  }

  function countFilter(id) {
    const current = matchFilter;
    matchFilter = id;
    const count = filterMatches(state.matches || []).length;
    matchFilter = current;
    return count;
  }

  function matchTableTeam(match, side) {
    const isHome = side === 'home';
    const name = isHome ? match.home : match.away;
    const code = isHome ? match.homeCode : match.awayCode;
    const logo = isHome ? match.homeLogo : match.awayLogo;
    return `
      <span class="match-table-team">
        ${teamAsset(code, name, logo, 'mini-logo')}
        <span>
          <strong>${esc(name || 'A definir')}</strong>
          <small>${esc(code || '')}</small>
        </span>
      </span>
    `;
  }

  function matchTablePrediction(match) {
    if (state && state.isPublic) return match.locked ? 'Resultado' : 'Entre para palpitar';
    if (match.prediction) return `${match.prediction.homeScore} × ${match.prediction.awayScore}`;
    return match.locked ? 'Sem palpite' : 'Aberto';
  }

  function matchTableAction(match) {
    const lineupButton = lineupAction(match, 'table-action secondary');
    const wrap = (primary) => `<span class="table-actions">${primary}${lineupButton}</span>`;
    if (state && state.isPublic) {
      return wrap(`<a class="table-action" href="/">${match.locked ? 'Abrir' : 'Entrar'}</a>`);
    }
    if (match.locked && !match.prediction) {
      return wrap('<span class="table-muted">Travado</span>');
    }
    return wrap(`<button class="table-action" type="button" data-match-jump="${esc(match.id)}">${match.locked ? 'Ver' : 'Palpitar'}</button>`);
  }

  function matchTable(matches) {
    return `
      <div class="match-table-title">
        <div>
          <strong>Tabela de jogos</strong>
          <span>${fmtNumber(matches.length)} partidas no filtro atual</span>
        </div>
        <small>Role para o lado para ver tudo</small>
      </div>
      <table class="match-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Data</th>
            <th>Fase</th>
            <th>Mandante</th>
            <th>Placar</th>
            <th>Visitante</th>
            <th>Status</th>
            <th>Palpite</th>
            <th>Ação</th>
          </tr>
        </thead>
        <tbody>
          ${matches.map((match, index) => {
            const meta = statusMeta(match);
            const rowClass = [
              meta.className ? `is-${meta.className}` : '',
              isBrazilMatch(match) ? 'is-brazil' : '',
              recentGoalMatchIds.has(String(match.id)) ? 'has-goal-flash' : '',
            ].filter(Boolean).join(' ');
            return `
              <tr class="${rowClass}" data-match-row="${esc(match.id)}">
                <td>${fmtNumber(index + 1)}</td>
                <td><strong>${esc(fmtDay(match.kickoff))}</strong><small>${esc(fmtDate(match.kickoff).replace(/^.*?,\s*/, ''))}</small></td>
                <td><strong>${esc(match.stage || 'Copa')}</strong><small>${esc(match.group || match.round || '')}</small></td>
                <td>${matchTableTeam(match, 'home')}</td>
                <td><span class="table-score">${esc(scoreLine(match))}</span></td>
                <td>${matchTableTeam(match, 'away')}</td>
                <td><span class="status-pill ${esc(meta.className)}">${esc(meta.label)}</span></td>
                <td><span class="table-prediction">${esc(matchTablePrediction(match))}</span></td>
                <td>${matchTableAction(match)}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function renderMatches() {
    const filters = document.getElementById('match-filters');
    const list = document.getElementById('match-list');
    const tableWrap = document.getElementById('match-table-wrap');
    const count = document.getElementById('matches-count');
    if (!filters || !list || !state) return;
    const matches = filterMatches(state.matches || []);
    if (count) count.textContent = `${fmtNumber(matches.length)} jogos`;

    filters.innerHTML = FILTERS.map((filter) => `
      <button class="filter-chip ${matchFilter === filter.id ? 'is-active' : ''}" type="button" data-filter="${esc(filter.id)}">
        ${esc(filter.label)}
        <span>${fmtNumber(countFilter(filter.id))}</span>
      </button>
    `).join('');

    if (tableWrap) {
      tableWrap.innerHTML = matches.length
        ? matchTable(matches)
        : '<div class="empty-state"><strong>Nenhum jogo neste filtro.</strong><span>Troque o filtro para ver a tabela completa.</span></div>';
    }

    list.innerHTML = matches.length
      ? matches.map((match) => matchCard(match)).join('')
      : '<div class="empty-state"><strong>Nenhum jogo neste filtro.</strong><span>Troque o filtro para ver o calendário completo.</span></div>';
  }

  function renderTables() {
    const grid = document.getElementById('tables-grid');
    if (!grid || !state) return;
    const tables = state.tables || [];
    grid.innerHTML = tables.map((group) => `
      <article class="table-card">
        <div class="table-title">
          <strong>${esc(group.name)}</strong>
          <span>Top 2 avançam</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Seleção</th>
              <th>J</th>
              <th>SG</th>
              <th>Pts</th>
            </tr>
          </thead>
          <tbody>
            ${(group.teams || []).map((team) => `
              <tr class="${team.position <= 2 ? 'zone-direct' : (team.position === 3 ? 'zone-third' : '')}">
                <td>${fmtNumber(team.position)}</td>
                <td>
                  <span class="table-team">
                    ${teamAsset(team.code, team.name, team.logo, 'mini-logo')}
                    <span>${esc(team.name)}</span>
                  </span>
                </td>
                <td>${fmtNumber(team.played)}</td>
                <td>${team.goalDifference > 0 ? '+' : ''}${fmtNumber(team.goalDifference)}</td>
                <td><strong>${fmtNumber(team.points)}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </article>
    `).join('');
  }

  function statAvatar(row) {
    if (row.playerPhoto) {
      return `<span class="stat-avatar"><img src="${esc(row.playerPhoto)}" alt="" loading="lazy" decoding="async"></span>`;
    }
    return `<span class="stat-avatar stat-initials">${esc(playerInitials(row.player))}</span>`;
  }

  function statTeam(row) {
    return `
      <span class="stat-team">
        ${teamAsset(row.teamCode, row.team, row.teamLogo, 'mini-logo')}
        <span>${esc(row.team || 'Selecao')}</span>
      </span>
    `;
  }

  function statRows(rows, metricLabel, emptyText, limit) {
    const list = (rows || []).slice(0, limit || 8);
    if (!list.length) {
      return `<div class="empty-state compact-empty"><strong>${esc(emptyText || 'Sem dados ainda.')}</strong><span>A fonte publica esses numeros conforme os jogos acontecem.</span></div>`;
    }

    return `
      <div class="stat-list">
        ${list.map((row, index) => `
          <div class="stat-row">
            <span class="stat-rank">${fmtNumber(index + 1)}</span>
            ${statAvatar(row)}
            <span class="stat-player">
              <strong>${esc(row.player || 'Jogador')}</strong>
              ${statTeam(row)}
            </span>
            <span class="stat-value">
              <strong>${fmtNumber(row.total)}</strong>
              <small>${esc(metricLabel)}</small>
            </span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function disciplineRows(rows) {
    const list = (rows || []).slice(0, 8);
    if (!list.length) {
      return '<div class="empty-state compact-empty"><strong>Sem cartões ainda.</strong><span>Quando amarelos e vermelhos entrarem na fonte, eles aparecem aqui.</span></div>';
    }

    return `
      <div class="stat-list">
        ${list.map((row, index) => `
          <div class="stat-row discipline-row">
            <span class="stat-rank">${fmtNumber(index + 1)}</span>
            ${statAvatar(row)}
            <span class="stat-player">
              <strong>${esc(row.player || 'Jogador')}</strong>
              ${statTeam(row)}
              <span class="card-chip-row">
                <span class="card-chip yellow-card">${fmtNumber(row.yellowCards || 0)} amarelos</span>
                <span class="card-chip red-card">${fmtNumber(row.redCards || 0)} vermelhos</span>
              </span>
            </span>
            <span class="stat-value">
              <strong>${fmtNumber(row.points || row.total)}</strong>
              <small>pts</small>
            </span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderPlayerStats() {
    const grid = document.getElementById('stats-grid');
    const status = document.getElementById('stats-status');
    if (!grid || !state) return;

    const stats = state.playerStats || {};
    const goals = stats.goals || [];
    const assists = stats.assists || [];
    const discipline = stats.discipline || [];
    const redCards = stats.redCards || [];
    const totalRows = goals.length + assists.length + discipline.length + redCards.length;

    if (status) {
      status.textContent = stats.status === 'ok'
        ? `${fmtNumber(totalRows)} registros`
        : 'Aguardando fonte';
    }

    grid.innerHTML = `
      <article class="stat-board stat-board-main">
        <div class="card-head">
          <p class="eyebrow">Artilharia</p>
          <span>${goals[0] ? `${fmtNumber(goals[0].total)} gols` : 'Gols'}</span>
        </div>
        ${statRows(goals, 'gols', 'Artilharia ainda sem dados.', 10)}
      </article>

      <article class="stat-board">
        <div class="card-head">
          <p class="eyebrow">Assistências</p>
          <span>${assists[0] ? `${fmtNumber(assists[0].total)} ast` : 'Passes'}</span>
        </div>
        ${statRows(assists, 'ast', 'Assistências ainda sem dados.', 8)}
      </article>

      <article class="stat-board stat-board-discipline">
        <div class="card-head">
          <p class="eyebrow">Cartões</p>
          <span>Amarelos + vermelhos</span>
        </div>
        ${disciplineRows(discipline)}
      </article>

      <article class="stat-board">
        <div class="card-head">
          <p class="eyebrow">Vermelhos</p>
          <span>${redCards[0] ? `${fmtNumber(redCards[0].total)} expulsões` : 'Expulsões'}</span>
        </div>
        ${statRows(redCards, 'vermelhos', 'Nenhum vermelho registrado.', 8)}
      </article>

      ${stats.message ? `<p class="stats-note">${esc(stats.message)}</p>` : ''}
    `;
  }

  function renderTeams() {
    const grid = document.getElementById('team-grid');
    if (!grid || !state) return;
    const teams = (state.teams || []).filter((team) => (
      !teamQuery
      || normalize(team.name).includes(normalize(teamQuery))
      || normalize(team.code).includes(normalize(teamQuery))
      || normalize(team.group).includes(normalize(teamQuery))
    ));

    grid.innerHTML = teams.map((team) => `
      <button class="team-card" type="button" data-team-squad="${esc(team.id)}">
        <span class="team-card-head">
          ${teamAsset(team.code, team.name, team.logo)}
          <span>
            <strong>${esc(team.name)}</strong>
            <small>${esc(team.group)} · ${fmtNumber(team.position)}º</small>
          </span>
        </span>
        <span class="team-metrics">
          <span><strong>${fmtNumber(team.points)}</strong><small>Pts</small></span>
          <span><strong>${fmtNumber(team.played)}</strong><small>J</small></span>
          <span><strong>${team.goalDifference > 0 ? '+' : ''}${fmtNumber(team.goalDifference)}</strong><small>SG</small></span>
        </span>
        <span class="team-next">${team.nextMatch ? `Próximo: ${esc(team.nextMatch.opponent)} · ${esc(fmtDate(team.nextMatch.kickoff))}` : 'Elenco e campanha'}</span>
      </button>
    `).join('') || '<div class="empty-state"><strong>Nenhuma seleção encontrada.</strong><span>Limpe a busca para ver todas.</span></div>';
  }

  function filteredAlbumPlayers() {
    return (albumState.players || []).filter((player) => {
      const queryMatch = !albumQuery
        || normalize(player.name).includes(normalize(albumQuery))
        || normalize(player.fullName).includes(normalize(albumQuery))
        || normalize(player.teamName).includes(normalize(albumQuery))
        || normalize(player.teamCode).includes(normalize(albumQuery));
      const teamMatch = albumTeam === 'all' || String(player.teamId) === String(albumTeam);
      const positionMatch = albumPosition === 'all' || player.position === albumPosition;
      return queryMatch && teamMatch && positionMatch;
    });
  }

  function stickerCard(player) {
    return `
      <article class="sticker-card ${positionClass(player.position)}">
        <div class="sticker-shell">
          <div class="sticker-topline">
            <span>${esc(player.albumNumber || 'ST-0000')}</span>
            <strong>${esc(player.teamCode || player.positionShort || 'Copa')}</strong>
          </div>
          <div class="sticker-photo">
            ${playerPhoto(player)}
            <span class="sticker-gloss" aria-hidden="true"></span>
          </div>
          <div class="sticker-team-strip">
            ${teamAsset(player.teamCode, player.teamName, player.teamLogo, 'sticker-flag')}
            <span>${esc(player.teamName || 'Selecao')}</span>
          </div>
        </div>
        <div class="sticker-caption">
          <strong>${esc(player.name || 'Jogador')}</strong>
          <span>${player.jerseyNumber ? `#${fmtNumber(player.jerseyNumber)} · ` : ''}${esc(player.position || 'Elenco')}</span>
          <small>${esc(player.group || 'Copa do Mundo')}</small>
        </div>
      </article>
    `;
  }

  function renderAlbum() {
    const grid = document.getElementById('sticker-grid');
    const count = document.getElementById('album-count');
    const stats = document.getElementById('album-status-grid');
    const more = document.getElementById('album-more');
    const teamFilter = document.getElementById('album-team-filter');
    const positionFilter = document.getElementById('album-position-filter');
    const search = document.getElementById('album-search');
    const loadButton = document.getElementById('album-load-button');
    if (!grid || !state) return;

    const teams = albumState.teams.length ? albumState.teams : (state.teams || []);
    if (teamFilter) {
      teamFilter.innerHTML = '<option value="all">Todas</option>' + teams.map((team) => (
        `<option value="${esc(team.id)}">${esc(team.name)}${team.playerCount ? ` (${fmtNumber(team.playerCount)})` : ''}</option>`
      )).join('');
      teamFilter.value = albumTeam;
    }
    if (positionFilter) positionFilter.value = albumPosition;
    if (search) search.value = albumQuery;
    if (loadButton) {
      loadButton.disabled = albumState.loading;
      loadButton.textContent = albumState.loaded ? 'Atualizar album' : (albumState.loading ? 'Carregando...' : 'Carregar jogadores');
    }

    const players = filteredAlbumPlayers();
    const visible = players.slice(0, albumVisibleCount);
    if (count) {
      count.textContent = albumState.loaded
        ? `${fmtNumber(players.length)} figurinhas`
        : (albumState.loading ? 'Carregando elencos' : 'Album pronto para carregar');
    }

    if (stats) {
      const loadedTeams = albumState.teams.filter((team) => team.playerCount > 0).length;
      stats.innerHTML = `
        <div><strong>${fmtNumber(albumState.players.length)}</strong><span>jogadores</span></div>
        <div><strong>${fmtNumber(loadedTeams || 0)}</strong><span>selecoes</span></div>
        <div><strong>${fmtNumber(players.length)}</strong><span>filtrados</span></div>
        <div><strong>${albumState.status === 'partial' ? 'Parcial' : (albumState.loaded ? 'Completo' : 'Pronto')}</strong><span>status</span></div>
      `;
    }

    if (albumState.loading) {
      grid.innerHTML = Array.from({ length: 12 }).map(() => '<div class="sticker-skeleton skeleton"></div>').join('');
      if (more) more.innerHTML = '<p class="muted-copy">Buscando elencos oficiais das selecoes. A primeira carga pode levar alguns segundos.</p>';
      return;
    }

    if (!albumState.loaded) {
      grid.innerHTML = `
        <div class="empty-state album-empty">
          <strong>Carregue o album de jogadores.</strong>
          <span>Depois disso, voce navega por selecao, posicao e nome como uma colecao de figurinhas.</span>
        </div>
      `;
      if (more) more.innerHTML = '';
      return;
    }

    grid.innerHTML = visible.map(stickerCard).join('')
      || '<div class="empty-state album-empty"><strong>Nenhuma figurinha encontrada.</strong><span>Ajuste os filtros para ver mais jogadores.</span></div>';

    if (more) {
      more.innerHTML = players.length > visible.length
        ? `
          <div class="album-more-actions">
            <button class="hero-action compact-action" type="button" id="album-load-more">Mostrar mais ${fmtNumber(Math.min(120, players.length - visible.length))}</button>
            <button class="action-link" type="button" id="album-show-all">Mostrar todos</button>
          </div>
        `
        : (albumState.errors.length ? `<p class="muted-copy">Algumas selecoes nao retornaram elenco agora: ${fmtNumber(albumState.errors.length)}.</p>` : '');
    }
  }

  async function loadAlbumPlayers() {
    if (albumState.loading) return;
    albumState = { ...albumState, loading: true, status: 'loading' };
    renderAlbum();
    try {
      const payload = await api('/copa/players');
      albumState = {
        loaded: true,
        loading: false,
        players: payload.players || [],
        teams: payload.teams || [],
        errors: payload.errors || [],
        status: payload.status || 'ok',
      };
      albumVisibleCount = 120;
      renderAlbum();
    } catch (err) {
      albumState = { ...albumState, loaded: false, loading: false, status: 'error', errors: [{ message: err.message }] };
      renderAlbum();
      showToast(err.message);
    }
  }

  function brazilSlotsFor(formation) {
    return BRAZIL_FORMATIONS[formation] || BRAZIL_FORMATIONS['4-3-3'];
  }

  function localBrazilLineupKey() {
    const userId = state && state.user && state.user.id ? state.user.id : 'visitor';
    return `tc_copa_brazil_lineup_${userId}`;
  }

  function defaultBrazilUserLineup() {
    return {
      mode: 'wish',
      formation: '4-3-3',
      notes: '',
      players: brazilSlotsFor('4-3-3').map(([slot, role]) => ({
        slot,
        role,
        position: role,
        playerId: '',
        name: '',
        jerseyNumber: null,
        photo: '',
      })),
    };
  }

  function normalizeBrazilUserLineup(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const formation = BRAZIL_FORMATIONS[source.formation] ? source.formation : '4-3-3';
    const existing = Array.isArray(source.players) ? source.players : [];
    const slots = brazilSlotsFor(formation);
    return {
      mode: source.mode === 'prediction' ? 'prediction' : 'wish',
      formation,
      notes: source.notes || '',
      updatedAt: source.updatedAt || '',
      players: slots.map(([slot, role], index) => {
        const current = existing[index] || {};
        return {
          slot,
          role,
          position: current.position || role,
          playerId: String(current.playerId || ''),
          name: current.name || '',
          jerseyNumber: current.jerseyNumber || null,
          photo: current.photo || '',
        };
      }),
    };
  }

  function readLocalBrazilLineup() {
    try {
      return safeJson(localStorage.getItem(localBrazilLineupKey()));
    } catch (_) {
      return null;
    }
  }

  function persistLocalBrazilLineup(lineup) {
    try {
      localStorage.setItem(localBrazilLineupKey(), JSON.stringify(lineup));
    } catch (_) {
      // Local storage can fail in private browsing; backend save still works for logged users.
    }
  }

  function syncBrazilUserLineup(nextState) {
    const saved = nextState && nextState.userBrazilLineup;
    const local = readLocalBrazilLineup();
    const candidate = saved && Array.isArray(saved.players) && saved.players.some((player) => player.name || player.playerId)
      ? saved
      : local;
    brazilUserLineup = normalizeBrazilUserLineup(candidate || brazilUserLineup || defaultBrazilUserLineup());
  }

  function brazilSquadSorted(players) {
    const order = { Goleiro: 1, Defensor: 2, 'Meio-campista': 3, Atacante: 4 };
    return [...(players || [])].sort((a, b) => (
      (order[a.position] || 9) - (order[b.position] || 9)
      || (a.jerseyNumber || 999) - (b.jerseyNumber || 999)
      || String(a.name || '').localeCompare(String(b.name || ''))
    ));
  }

  async function loadBrazilSquad() {
    const teamId = state && state.brazil && state.brazil.team && state.brazil.team.id;
    if (!teamId || brazilSquadState.loading) return;
    if (brazilSquadState.loaded && String(brazilSquadState.teamId) === String(teamId)) return;

    brazilSquadState = { loaded: false, loading: true, teamId: String(teamId), players: [], error: '' };
    renderBrazil();
    try {
      const payload = await api(`/copa/teams/${encodeURIComponent(teamId)}/squad`);
      brazilSquadState = {
        loaded: true,
        loading: false,
        teamId: String(teamId),
        players: brazilSquadSorted(payload.squad || []),
        error: '',
      };
    } catch (err) {
      brazilSquadState = {
        ...brazilSquadState,
        loaded: false,
        loading: false,
        players: [],
        error: err.message,
      };
    }
    renderBrazil();
  }

  function renderLineupList(players, emptyLabel) {
    const rows = players || [];
    if (!rows.length) return `<p class="muted-copy">${esc(emptyLabel || 'Escalacao ainda nao disponivel.')}</p>`;
    return `
      <div class="lineup-list">
        ${rows.map((player) => `
          <div class="lineup-row">
            <span>${esc(player.slot || player.formationPosition || player.position || 'POS')}</span>
            <strong>${esc(player.name || 'A definir')}</strong>
            <small>${esc(player.role || player.position || '')}${player.jerseyNumber ? ` · camisa ${fmtNumber(player.jerseyNumber)}` : ''}</small>
          </div>
        `).join('')}
      </div>
    `;
  }

  function brazilPlayerOptions(currentPlayerId, selectedIds) {
    const players = brazilSquadState.players || [];
    if (!players.length) return '<option value="">Carregue o elenco oficial</option>';
    return '<option value="">Escolher jogador</option>' + players.map((player) => {
      const id = String(player.playerId || player.id || '');
      const selected = String(currentPlayerId || '') === id;
      const disabled = selectedIds.has(id) && !selected;
      const label = `${player.jerseyNumber ? '#' + fmtNumber(player.jerseyNumber) + ' ' : ''}${player.name} · ${player.position}`;
      return `<option value="${esc(id)}" ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(label)}</option>`;
    }).join('');
  }

  function renderBrazilUserLineup() {
    const lineup = brazilUserLineup || normalizeBrazilUserLineup(defaultBrazilUserLineup());
    const selectedIds = new Set((lineup.players || []).map((player) => String(player.playerId || '')).filter(Boolean));
    const filled = (lineup.players || []).filter((player) => player.playerId || player.name).length;
    const squadStatus = brazilSquadState.loading
      ? 'Carregando elenco'
      : (brazilSquadState.loaded ? `${fmtNumber(brazilSquadState.players.length)} jogadores` : 'Elenco');

    return `
      <article class="user-brazil-lineup-card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Minha seleção</p>
            <h3>Escalar o Brasil</h3>
          </div>
          <span>${fmtNumber(filled)} / 11</span>
        </div>
        <form id="brazil-user-lineup-form">
          <div class="lineup-mode-row" role="group" aria-label="Tipo de escalação">
            <button class="${lineup.mode === 'wish' ? 'is-active' : ''}" type="button" data-brazil-lineup-mode="wish">Eu escalaria</button>
            <button class="${lineup.mode === 'prediction' ? 'is-active' : ''}" type="button" data-brazil-lineup-mode="prediction">Acho que vai ser</button>
          </div>

          <div class="user-lineup-toolbar">
            <label>
              <span>Formação</span>
              <select name="formation">
                ${Object.keys(BRAZIL_FORMATIONS).map((formation) => (
                  `<option value="${esc(formation)}" ${lineup.formation === formation ? 'selected' : ''}>${esc(formation)}</option>`
                )).join('')}
              </select>
            </label>
            <button class="action-link ghost-action" type="button" id="brazil-squad-load">${esc(squadStatus)}</button>
          </div>

          ${brazilSquadState.error ? `<p class="muted-copy">${esc(brazilSquadState.error)}</p>` : ''}

          <div class="user-lineup-list">
            ${(lineup.players || []).map((slotPlayer, index) => `
              <label class="user-lineup-row">
                <span class="slot-badge">${esc(slotPlayer.slot || '')}</span>
                <span class="slot-copy">
                  <strong>${esc(slotPlayer.role || slotPlayer.position || 'Posição')}</strong>
                  <select data-brazil-player-select="${fmtNumber(index)}" name="player-${fmtNumber(index)}" ${brazilSquadState.players.length ? '' : 'disabled'}>
                    ${brazilPlayerOptions(slotPlayer.playerId, selectedIds)}
                  </select>
                </span>
              </label>
            `).join('')}
          </div>

          <label class="wide-label">Notas<textarea name="notes" rows="2" placeholder="Ex: time mais ofensivo, quero ver os jovens...">${esc(lineup.notes || '')}</textarea></label>

          <div class="user-lineup-actions">
            <button class="hero-action" type="submit">Salvar minha escalação</button>
            <button class="action-link ghost-action" type="button" id="brazil-lineup-clear">Limpar</button>
          </div>
        </form>
      </article>
    `;
  }

  function renderBrazil() {
    const grid = document.getElementById('brazil-grid');
    const status = document.getElementById('brazil-status');
    if (!grid || !state) return;
    const brazil = state.brazil || {};
    const nextMatches = (brazil.nextMatches || []).map((item) => ({
      ...matchFromState(item),
      expectedLineup: item.expectedLineup || {},
    }));
    const next = nextMatches[0] || matchFromState(brazil.nextMatch || {});
    const expected = next.expectedLineup || brazil.expectedLineup || {};
    const official = brazil.officialLineup || {};
    const officialPlayers = (official.players || []).filter((player) => player.isStarter);
    const expectedPlayers = expected.players || [];
    if (status) status.textContent = next.home ? `${next.home} x ${next.away}` : 'Brasil';

    const lineupBlocks = nextMatches.length ? nextMatches.map((match, index) => {
      const lineup = match.expectedLineup || {};
      const players = lineup.players || [];
      return `
        <details class="lineup-match-card" ${index === 0 ? 'open' : ''}>
          <summary>
            <span>${esc(match.home || 'Brasil')} × ${esc(match.away || 'Adversario')}</span>
            <strong>${esc(lineup.formation || '4-3-3')}</strong>
          </summary>
          <p class="muted-copy">${esc(lineup.notes || 'Escalacao provavel ainda nao definida para este jogo.')}</p>
          ${renderLineupList(players, 'Admin ainda nao definiu a provavel.')}
        </details>
      `;
    }).join('') : renderLineupList(expectedPlayers, 'Sem proximos jogos do Brasil carregados.');

    const editor = canManageCopa() && nextMatches.length ? `
      <section class="admin-config-card lineup-editor">
        <div class="card-head">
          <p class="eyebrow">Admin</p>
          <span>Escalacao por jogo</span>
        </div>
        ${nextMatches.map((match, matchIndex) => {
          const lineup = match.expectedLineup || {};
          const players = (lineup.players && lineup.players.length ? lineup.players : expectedPlayers).slice(0, 11);
          return `
            <details class="lineup-admin-match" ${matchIndex === 0 ? 'open' : ''}>
              <summary>${esc(match.home || 'Brasil')} × ${esc(match.away || 'Adversario')} · ${esc(resultLine(match))}</summary>
              <form class="brazil-lineup-form" data-match-id="${esc(match.id || '')}">
                <div class="config-grid compact">
                  <label>Formacao<input name="formation" value="${esc(lineup.formation || '4-3-3')}"></label>
                  <label>Confianca<input name="confidence" value="${esc(lineup.confidence || 'media')}"></label>
                  <label>Status<input name="status" value="${esc(lineup.status || 'rascunho')}"></label>
                </div>
                <label class="wide-label">Notas<textarea name="notes" rows="3">${esc(lineup.notes || '')}</textarea></label>
                <div class="lineup-editor-list">
                  ${players.map((player, index) => `
                    <div class="lineup-edit-row">
                      <input name="slot-${index}" value="${esc(player.slot || '')}" aria-label="Posicao ${index + 1}">
                      <input name="name-${index}" value="${esc(player.name || '')}" aria-label="Jogador ${index + 1}" placeholder="Jogador">
                      <input name="role-${index}" value="${esc(player.role || '')}" aria-label="Funcao ${index + 1}" placeholder="Funcao">
                    </div>
                  `).join('')}
                </div>
                <button class="hero-action" type="submit">Salvar escalacao deste jogo</button>
              </form>
            </details>
          `;
        }).join('')}
      </section>
    ` : '';

    grid.innerHTML = `
      <article class="brazil-main">
        <div class="card-head">
          <p class="eyebrow">Proximo jogo do Brasil</p>
          <span>${esc(next.stage || 'Copa')}</span>
        </div>
        ${next.home ? matchCard(next, { compact: true }) : '<p class="muted-copy">Brasil ainda sem jogo destacado.</p>'}
      </article>

      ${renderBrazilUserLineup()}

      <article class="info-card">
        <div class="card-head">
          <p class="eyebrow">Agenda Brasil</p>
          <span>${fmtNumber((brazil.nextMatches || []).length)}</span>
        </div>
        <div class="stack-list">
          ${(brazil.nextMatches || []).length ? (brazil.nextMatches || []).map(matchFromState).map(smallMatchRow).join('') : '<p class="muted-copy">Sem proximos jogos carregados.</p>'}
        </div>
      </article>

      <article class="info-card">
        <div class="card-head">
          <p class="eyebrow">Escalacao oficial</p>
          <span>${esc(official.status || 'pending')}</span>
        </div>
        <p class="muted-copy">${esc(official.message || 'Aguardando publicacao da fonte.')}</p>
        ${renderLineupList(officialPlayers, 'A oficial aparece perto do jogo.')}
      </article>

      <article class="info-card">
        <div class="card-head">
          <p class="eyebrow">Provaveis S&T</p>
          <span>${fmtNumber(nextMatches.length)}</span>
        </div>
        <div class="lineup-next-list">
          ${lineupBlocks}
        </div>
      </article>

      ${editor}
    `;
  }

  function renderRankingPanel() {
    const grid = document.getElementById('ranking-grid');
    const count = document.getElementById('ranking-count');
    if (!grid || !state) return;
    const stats = state.rankingStats || {};
    const rows = state.leaderboard || [];
    if (count) count.textContent = `${fmtNumber(stats.participants || rows.length)} participantes`;

    grid.innerHTML = `
      <div class="ranking-stats">
        <div><strong>${fmtNumber(stats.participants || 0)}</strong><span>participantes</span></div>
        <div><strong>${fmtNumber(stats.totalPredictions || 0)}</strong><span>palpites</span></div>
        <div><strong>${fmtNumber(stats.exactHits || 0)}</strong><span>exatos</span></div>
        <div><strong>T$ ${fmtMoney(stats.tenisCashProjected || 0)}</strong><span>projetado</span></div>
      </div>
      <div class="ranking-table-wrap">
        ${rows.length ? `
          <table class="ranking-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Usuario</th>
                <th>Pts</th>
                <th>Exatos</th>
                <th>Resultado</th>
                <th>Palpites</th>
                <th>T$</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row) => `
                <tr class="${row.isMe ? 'is-me' : ''}">
                  <td>${fmtNumber(row.rank)}</td>
                  <td><strong>${esc(row.name)}</strong><small>${fmtPercent(row.completionRate || 0)} completo</small></td>
                  <td>${fmtNumber(row.points)}</td>
                  <td>${fmtNumber(row.exactHits)}</td>
                  <td>${fmtNumber(row.resultHits)}</td>
                  <td>${fmtNumber(row.predicted)} / ${fmtNumber(row.totalMatches)}</td>
                  <td>T$ ${fmtMoney(row.tenisCash)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<div class="empty-state"><strong>Ranking aguardando palpites.</strong><span>Quando os usuarios entrarem no bolao, a tabela nasce aqui.</span></div>'}
      </div>
    `;
  }

  function renderPool() {
    const grid = document.getElementById('pool-grid');
    const status = document.getElementById('pool-status');
    if (!grid || !state) return;
    const summary = state.summary || {};
    const rules = (state.pool && state.pool.rules) || {};
    const prizes = state.prizes || (state.pool && state.pool.prizes) || [];
    const openMatches = (state.matches || []).filter((match) => !match.locked).slice(0, 4);
    if (status) status.textContent = state.pool.status || 'Aberto';

    const adminPrizeRows = prizes.map((prize, index) => `
      <div class="prize-edit-row">
        <input name="prize-title-${index}" value="${esc(prize.title || '')}" aria-label="Titulo do premio ${index + 1}">
        <input name="prize-criteria-${index}" value="${esc(prize.criteria || '')}" aria-label="Criterio do premio ${index + 1}">
        <input name="prize-quantity-${index}" type="number" min="1" value="${esc(prize.quantity || 1)}" aria-label="Quantidade do premio ${index + 1}">
        <input name="prize-status-${index}" value="${esc(prize.status || 'rascunho')}" aria-label="Status do premio ${index + 1}">
        <input name="prize-sponsor-${index}" value="${esc(prize.sponsor || 'Sports & Tennis')}" aria-label="Patrocinador do premio ${index + 1}">
        <textarea name="prize-notes-${index}" rows="2" aria-label="Notas do premio ${index + 1}">${esc(prize.notes || '')}</textarea>
      </div>
    `).join('');

    grid.innerHTML = `
      <article class="pool-card prize-card">
        <p class="eyebrow">Premio principal</p>
        <h3>${esc(state.pool.prize || 'Camisa oficial + TenisCash')}</h3>
        <div class="pool-stats">
          <span><strong>${fmtNumber(summary.rank || 0)}</strong><small>posicao</small></span>
          <span><strong>${fmtNumber(summary.points)}</strong><small>pontos</small></span>
          <span><strong>T$ ${fmtMoney(summary.tenisCash)}</strong><small>previsto</small></span>
        </div>
        ${state.isPublic ? '<a class="hero-action" href="/">Entrar no bolao</a>' : '<button class="hero-action" type="button" data-tab="matches">Palpitar nos jogos</button>'}
      </article>

      <article class="pool-card">
        <p class="eyebrow">Pontuacao</p>
        <div class="rule-list inline">
          <div class="rule-row"><strong>Placar exato</strong><span>${fmtNumber(rules.exactScore)} pts + T$ ${fmtMoney(rules.tenisCashExact)}</span></div>
          <div class="rule-row"><strong>Vencedor ou empate</strong><span>${fmtNumber(rules.result)} pts + T$ ${fmtMoney(rules.tenisCashResult)}</span></div>
          <div class="rule-row"><strong>Saldo de gols</strong><span>${fmtNumber(rules.goalDifference)} pts</span></div>
          <div class="rule-row"><strong>Trava</strong><span>No inicio do jogo</span></div>
        </div>
      </article>

      <article class="pool-card prizes-board">
        <div class="card-head">
          <p class="eyebrow">Premios definidos</p>
          <span>${fmtNumber(prizes.length)}</span>
        </div>
        <div class="prize-list">
          ${prizes.map((prize) => `
            <div class="prize-row">
              <strong>${esc(prize.title)}</strong>
              <span>${esc(prize.criteria)}</span>
              <small>${fmtNumber(prize.quantity)} un · ${esc(prize.status)} · ${esc(prize.sponsor)}</small>
            </div>
          `).join('') || '<p class="muted-copy">Premios ainda nao definidos.</p>'}
        </div>
      </article>

      <article class="pool-card open-picks">
        <div class="card-head">
          <p class="eyebrow">Palpites abertos</p>
          <span>${fmtNumber(openMatches.length)}</span>
        </div>
        <div class="stack-list">
          ${openMatches.length ? openMatches.map((match) => matchCard(match, { compact: true })).join('') : '<p class="muted-copy">Nenhum palpite aberto agora.</p>'}
        </div>
      </article>

      ${canManageCopa() ? `
        <form class="admin-config-card prize-admin" id="prize-config-form">
          <div class="card-head">
            <p class="eyebrow">Admin</p>
            <span>Definicao de premios</span>
          </div>
          <div class="config-grid">
            <label>Titulo<input name="pool-title" value="${esc(state.pool.title || '')}"></label>
            <label>Status<input name="pool-status" value="${esc(state.pool.status || '')}"></label>
            <label>Premio principal<input name="pool-prize" value="${esc(state.pool.prize || '')}"></label>
          </div>
          <label class="wide-label">Subtitulo<textarea name="pool-subtitle" rows="2">${esc(state.pool.subtitle || '')}</textarea></label>
          <div class="prize-edit-list" data-prize-count="${fmtNumber(prizes.length)}">
            ${adminPrizeRows}
          </div>
          <button class="hero-action" type="submit">Salvar premios</button>
        </form>
      ` : ''}
    `;
  }

  function renderLeaderboard() {
    const list = document.getElementById('leaderboard-list');
    if (!list || !state) return;
    if (!state.leaderboard.length) {
      list.innerHTML = '<p class="muted-copy">O ranking aparece quando os palpites forem salvos.</p>';
      return;
    }
    list.innerHTML = state.leaderboard.slice(0, 8).map((row) => `
      <div class="leader-row ${row.isMe ? 'is-me' : ''}">
        <span>${fmtNumber(row.rank)}</span>
        <strong>${esc(row.name)}</strong>
        <small>${fmtNumber(row.points)} pts · ${fmtNumber(row.exactHits)} exatos · ${fmtNumber(row.predicted)} palpites</small>
      </div>
    `).join('') + '<button class="rail-link" type="button" data-tab="ranking">Ver ranking completo</button>';
  }

  function renderNews() {
    const list = document.getElementById('news-list');
    const mode = document.getElementById('news-mode');
    if (!list || !state) return;
    const news = state.news || {};
    const items = news.items || [];
    if (mode) mode.textContent = news.mode === 'google_news_rss' ? 'RSS BR' : 'Fontes';

    list.innerHTML = items.slice(0, 6).map((item) => `
      <a class="news-row" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">
        <span>${esc(item.tag || item.source || 'Copa')}</span>
        <strong>${esc(item.title)}</strong>
        <small>${esc(item.source || 'Fonte')} · ${esc(fmtNewsDate(item.publishedAt))}</small>
      </a>
    `).join('') || '<p class="muted-copy">Notícias aparecem aqui quando o feed responder.</p>';
  }

  function renderRules() {
    const rules = state && state.pool && state.pool.rules;
    const list = document.getElementById('rule-list');
    if (!list || !rules) return;
    list.innerHTML = `
      <div class="rule-row"><strong>Exato</strong><span>${fmtNumber(rules.exactScore)} pts</span></div>
      <div class="rule-row"><strong>Resultado</strong><span>${fmtNumber(rules.result)} pts</span></div>
      <div class="rule-row"><strong>Saldo</strong><span>${fmtNumber(rules.goalDifference)} pts</span></div>
      <div class="rule-row"><strong>TenisCash</strong><span>T$ ${fmtMoney(rules.tenisCashExact)}</span></div>
    `;
  }

  function renderAll() {
    const firstRender = !hasRendered;
    document.body.classList.toggle('is-public', Boolean(state && state.isPublic));
    renderHero();
    renderTopbar();
    renderFlow();
    renderToday();
    renderMatches();
    renderTables();
    renderPlayerStats();
    renderTeams();
    renderAlbum();
    renderBrazil();
    renderRankingPanel();
    renderPool();
    renderLeaderboard();
    renderNews();
    renderRules();
    activateTab(activeTab, false);
    hasRendered = true;
    if (firstRender) {
      window.setTimeout(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }), 0);
    }
  }

  function activateTab(tab, shouldScroll) {
    activeTab = tab;
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.classList.toggle('is-active', button.getAttribute('data-tab') === tab);
    });
    document.querySelectorAll('[data-panel]').forEach((panel) => {
      const active = panel.getAttribute('data-panel') === tab;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    const target = document.querySelector(`[data-panel="${tab}"]`);
    if (tab === 'album' && !albumState.loaded && !albumState.loading) {
      loadAlbumPlayers();
    }
    if (tab === 'brazil') {
      loadBrazilSquad();
    }
    if (shouldScroll && target && window.matchMedia('(max-width: 780px)').matches) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  async function loadPublicPreview() {
    applyState(await api('/copa/public'), { animate: false });
  }

  async function load() {
    if (cachedUser && cachedUser.name) {
      const pill = document.getElementById('user-pill');
      if (pill) pill.innerHTML = accountPillHtml(cachedUser.name, 'Carregando');
    }

    if (!token) {
      try {
        await loadPublicPreview();
      } catch (err) {
        showFatalError(err);
      }
      return;
    }

    try {
      applyState(await api('/copa/summary'), { animate: false });
    } catch (err) {
      if (/token|401|inv/i.test(err.message)) {
        try {
          await loadPublicPreview();
        } catch (fallbackErr) {
          showFatalError(fallbackErr);
        }
        return;
      }
      showFatalError(err);
    }
  }

  function showFatalError(err) {
    const hero = document.getElementById('hero-board');
    if (!hero) return;
    hero.innerHTML = `
      <div class="fatal-card">
        <p class="eyebrow">Erro</p>
        <h1>Não consegui carregar a Copa</h1>
        <p>${esc(err.message || 'Tente novamente em instantes.')}</p>
        <button class="hero-action" type="button" id="retry-load">Tentar de novo</button>
      </div>
    `;
    const retry = document.getElementById('retry-load');
    if (retry) retry.addEventListener('click', load);
  }

  async function savePrediction(form) {
    const matchId = form.getAttribute('data-match-id');
    const homeScore = Number(form.elements.homeScore.value);
    const awayScore = Number(form.elements.awayScore.value);
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) {
      showToast('Informe os dois placares.');
      return;
    }

    const button = form.querySelector('.save-btn');
    if (button) {
      button.disabled = true;
      button.textContent = 'Salvando';
    }

    try {
      applyState(await api('/copa/predictions', 'POST', { matchId, homeScore, awayScore }), { animate: false });
      showToast('Palpite salvo.');
    } catch (err) {
      showToast(err.message);
      if (button) {
        button.disabled = false;
        button.textContent = 'Salvar';
      }
    }
  }

  async function saveCopaConfig(payload, button) {
    if (button) {
      button.disabled = true;
      button.textContent = 'Salvando';
    }
    try {
      applyState(await api('/copa/admin/config', 'PUT', payload), { animate: false });
      showToast('Configuracao da Copa salva.');
    } catch (err) {
      showToast(err.message);
      if (button) {
        button.disabled = false;
        button.textContent = 'Salvar';
      }
    }
  }

  function savePrizeConfig(form) {
    const count = (state.prizes || []).length;
    const prizes = Array.from({ length: count }).map((_, index) => ({
      id: (state.prizes || [])[index]?.id || `premio-${index + 1}`,
      title: form.elements[`prize-title-${index}`]?.value || '',
      criteria: form.elements[`prize-criteria-${index}`]?.value || '',
      quantity: Number(form.elements[`prize-quantity-${index}`]?.value || 1),
      status: form.elements[`prize-status-${index}`]?.value || 'rascunho',
      sponsor: form.elements[`prize-sponsor-${index}`]?.value || 'Sports & Tennis',
      notes: form.elements[`prize-notes-${index}`]?.value || '',
    }));
    saveCopaConfig({
      pool: {
        title: form.elements['pool-title']?.value || '',
        status: form.elements['pool-status']?.value || '',
        prize: form.elements['pool-prize']?.value || '',
        subtitle: form.elements['pool-subtitle']?.value || '',
      },
      prizes,
    }, form.querySelector('button[type="submit"]'));
  }

  function saveBrazilLineup(form) {
    const players = Array.from({ length: 11 }).map((_, index) => ({
      slot: form.elements[`slot-${index}`]?.value || '',
      name: form.elements[`name-${index}`]?.value || '',
      role: form.elements[`role-${index}`]?.value || '',
    }));
    saveCopaConfig({
      matchId: form.getAttribute('data-match-id'),
      lineup: {
        formation: form.elements.formation?.value || '4-3-3',
        confidence: form.elements.confidence?.value || 'media',
        status: form.elements.status?.value || 'rascunho',
        notes: form.elements.notes?.value || '',
        players,
      },
    }, form.querySelector('button[type="submit"]'));
  }

  function captureBrazilLineupNotes() {
    const form = document.getElementById('brazil-user-lineup-form');
    if (form && brazilUserLineup) {
      brazilUserLineup.notes = form.querySelector('[name="notes"]')?.value || '';
    }
  }

  function updateBrazilUserFormation(formation) {
    captureBrazilLineupNotes();
    const previous = brazilUserLineup || defaultBrazilUserLineup();
    const nextSlots = brazilSlotsFor(formation);
    brazilUserLineup = normalizeBrazilUserLineup({
      ...previous,
      formation,
      players: nextSlots.map(([slot, role], index) => ({
        ...(previous.players || [])[index],
        slot,
        role,
        position: (previous.players || [])[index]?.position || role,
      })),
    });
    renderBrazil();
  }

  function updateBrazilUserPlayer(index, playerId) {
    const numericIndex = Number(index);
    if (!Number.isInteger(numericIndex)) return;
    captureBrazilLineupNotes();
    const lineup = normalizeBrazilUserLineup(brazilUserLineup || defaultBrazilUserLineup());
    const player = (brazilSquadState.players || []).find((item) => String(item.playerId || item.id || '') === String(playerId));
    const current = lineup.players[numericIndex] || {};
    lineup.players[numericIndex] = {
      ...current,
      playerId: player ? String(player.playerId || player.id || '') : '',
      name: player ? String(player.name || '').trim() : '',
      jerseyNumber: player ? player.jerseyNumber : null,
      photo: player ? player.photo : '',
      position: player ? player.position : current.role,
    };
    brazilUserLineup = lineup;
    renderBrazil();
  }

  async function saveUserBrazilLineup(form) {
    captureBrazilLineupNotes();
    const lineup = normalizeBrazilUserLineup(brazilUserLineup || defaultBrazilUserLineup());
    persistLocalBrazilLineup(lineup);

    const button = form.querySelector('button[type="submit"]');
    if (button) {
      button.disabled = true;
      button.textContent = 'Salvando';
    }

    if (!token || (state && state.isPublic)) {
      renderBrazil();
      showToast('Escalação salva neste aparelho. Entre para guardar no TenisCash.');
      return;
    }

    try {
      applyState(await api('/copa/brazil-lineup', 'PUT', lineup), { animate: false });
      showToast('Sua escalação do Brasil foi salva.');
    } catch (err) {
      showToast(err.message);
      if (button) {
        button.disabled = false;
        button.textContent = 'Salvar minha escalação';
      }
    }
  }

  function clearUserBrazilLineup() {
    brazilUserLineup = normalizeBrazilUserLineup(defaultBrazilUserLineup());
    persistLocalBrazilLineup(brazilUserLineup);
    renderBrazil();
    showToast('Escalação limpa.');
  }

  function openDrawer() {
    const drawer = document.getElementById('squad-drawer');
    if (!drawer) return;
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    const drawer = document.getElementById('squad-drawer');
    if (!drawer) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
  }

  async function loadSquad(teamId) {
    const drawerTitle = document.getElementById('drawer-title');
    const content = document.getElementById('squad-content');
    const team = (state.teams || []).find((item) => String(item.id) === String(teamId));
    openDrawer();

    if (drawerTitle) {
      drawerTitle.innerHTML = `
        <p class="eyebrow">Dossie</p>
        <h2>${esc(team ? team.name : 'Selecao')}</h2>
      `;
    }
    if (content) content.innerHTML = '<div class="skeleton block"></div>';

    try {
      const payload = await api(`/copa/teams/${encodeURIComponent(teamId)}/profile`);
      const squad = payload.squad || [];
      const profile = payload.profile || {};
      const stats = payload.stats || {};
      const groupTeams = (payload.group && payload.group.teams) || [];
      if (drawerTitle) {
        drawerTitle.innerHTML = `
          <p class="eyebrow">${esc(payload.team.group || 'Selecao')}</p>
          <h2>${esc(payload.team.name)}</h2>
        `;
      }
      if (!content) return;
      content.innerHTML = `
        <div class="team-dossier">
          <div class="dossier-stats">
            <span><strong>${fmtNumber(stats.position || payload.team.position)}</strong><small>posicao</small></span>
            <span><strong>${fmtNumber(stats.points || 0)}</strong><small>pontos</small></span>
            <span><strong>${fmtNumber(stats.played || 0)}</strong><small>jogos</small></span>
            <span><strong>${stats.goalDifference > 0 ? '+' : ''}${fmtNumber(stats.goalDifference || 0)}</strong><small>saldo</small></span>
          </div>

          <section class="drawer-section">
            <div class="card-head">
              <p class="eyebrow">Campanha</p>
              <span>${esc(payload.team.group || '')}</span>
            </div>
            <div class="rule-list inline">
              <div class="rule-row"><strong>Vitorias</strong><span>${fmtNumber(stats.won || 0)}</span></div>
              <div class="rule-row"><strong>Empates</strong><span>${fmtNumber(stats.drawn || 0)}</span></div>
              <div class="rule-row"><strong>Derrotas</strong><span>${fmtNumber(stats.lost || 0)}</span></div>
              <div class="rule-row"><strong>Gols</strong><span>${fmtNumber(stats.goalsFor || 0)} feitos / ${fmtNumber(stats.goalsAgainst || 0)} sofridos</span></div>
            </div>
          </section>

          <section class="drawer-section">
            <div class="card-head">
              <p class="eyebrow">Grupo</p>
              <span>${fmtNumber(groupTeams.length)} selecoes</span>
            </div>
            <div class="mini-table">
              ${groupTeams.map((row) => `
                <div class="${String(row.id) === String(payload.team.id) ? 'is-me' : ''}">
                  <span>${fmtNumber(row.position)}</span>
                  <strong>${esc(row.name)}</strong>
                  <small>${fmtNumber(row.points)} pts · ${row.goalDifference > 0 ? '+' : ''}${fmtNumber(row.goalDifference)}</small>
                </div>
              `).join('')}
            </div>
          </section>

          <section class="drawer-section">
            <div class="card-head">
              <p class="eyebrow">Jogos da selecao</p>
              <span>${fmtNumber((payload.matches || []).length)}</span>
            </div>
            <div class="stack-list">
              ${(payload.matches || []).map(smallMatchRow).join('') || '<p class="muted-copy">Jogos nao carregados.</p>'}
            </div>
          </section>

          <section class="drawer-section">
            <div class="card-head">
              <p class="eyebrow">Perfil da fonte</p>
              <span>${esc(payload.profileStatus || 'ok')}</span>
            </div>
            <div class="rule-list inline">
              <div class="rule-row"><strong>Pais</strong><span>${esc(profile.country || payload.team.originalName || payload.team.name)}</span></div>
              <div class="rule-row"><strong>Codigo</strong><span>${esc(profile.code || payload.team.code || '-')}</span></div>
              <div class="rule-row"><strong>Estadio</strong><span>${esc(profile.venue ? `${profile.venue.name}${profile.venue.city ? ' · ' + profile.venue.city : ''}` : 'Nao informado')}</span></div>
              <div class="rule-row"><strong>Tecnicos</strong><span>${esc((profile.coaches || []).map((coach) => coach.name).join(', ') || 'Nao informado')}</span></div>
            </div>
          </section>

          <section class="drawer-section">
            <div class="card-head">
              <p class="eyebrow">Elenco</p>
              <span>${fmtNumber(squad.length)} jogadores</span>
            </div>
            ${squad.length ? `
              <div class="squad-list">
                ${squad.map((player) => `
                  <div class="player-row">
                    ${player.photo ? `<img src="${esc(player.photo)}" alt="${esc(player.name)}" loading="lazy">` : '<span class="player-avatar"></span>'}
                    <span>
                      <strong>${esc(player.name)}</strong>
                      <small>${esc(player.position)}${player.jerseyNumber ? ` · camisa ${fmtNumber(player.jerseyNumber)}` : ''}</small>
                    </span>
                  </div>
                `).join('')}
              </div>
            ` : '<p class="muted-copy">Elenco ainda nao disponivel nesta fonte.</p>'}
          </section>
        </div>
      `;
    } catch (err) {
      if (content) content.innerHTML = `<p class="muted-copy">${esc(err.message)}</p>`;
    }
  }

  function lineupMinuteTag(player) {
    if (player.enteredAt) return `<span class="lineup-tag entered">Entrou ${esc(player.enteredAt)}</span>`;
    if (player.subbedOutAt) return `<span class="lineup-tag out">Saiu ${esc(player.subbedOutAt)}</span>`;
    if (player.wasStarter) return '<span class="lineup-tag starter">Titular</span>';
    return '<span class="lineup-tag bench">Banco</span>';
  }

  function substitutionMinuteLabel(event) {
    const minute = Number(event && event.minute);
    if (!Number.isFinite(minute)) return '-';
    const extra = Number(event && event.extraMinute);
    return `${fmtNumber(minute)}${Number.isFinite(extra) && extra > 0 ? `+${fmtNumber(extra)}` : ''}'`;
  }

  function lineupPlayerRow(player) {
    const number = player.jerseyNumber ? fmtNumber(player.jerseyNumber) : '-';
    return `
      <div class="lineup-player-row ${player.isOnField ? 'is-on-field' : ''}">
        <span class="player-shirt">${esc(number)}</span>
        ${player.photo ? `<img src="${esc(player.photo)}" alt="${esc(player.name)}" loading="lazy">` : '<span class="player-avatar"></span>'}
        <span class="lineup-player-copy">
          <strong>${esc(player.name || 'Jogador')}</strong>
          <small>${esc(player.position || 'Elenco')}</small>
        </span>
        ${lineupMinuteTag(player)}
      </div>
    `;
  }

  function lineupList(rows, emptyText) {
    return (rows || []).length
      ? `<div class="lineup-player-list">${rows.map(lineupPlayerRow).join('')}</div>`
      : `<p class="muted-copy">${esc(emptyText || 'Aguardando lista oficial.')}</p>`;
  }

  function lineupTeamBlock(team, match) {
    const activeLabel = match.status === 'LIVE'
      ? 'Em campo'
      : (match.status === 'FINAL' ? 'Terminaram em campo' : 'Titulares');
    const benchLabel = match.status === 'SCHEDULED' ? 'Banco' : 'Banco / fora';
    return `
      <section class="lineup-team-card">
        <div class="lineup-team-head">
          ${teamAsset(team.code, team.name, team.logo)}
          <span>
            <strong>${esc(team.name || 'Seleção')}</strong>
            <small>${team.formation ? `Formação ${esc(team.formation)}` : 'Formação oficial'}</small>
          </span>
        </div>
        <div class="lineup-group">
          <div class="card-head">
            <p class="eyebrow">${esc(activeLabel)}</p>
            <span>${fmtNumber((team.onField || []).length)}</span>
          </div>
          ${lineupList(team.onField || team.starters, 'Titulares ainda não publicados.')}
        </div>
        <div class="lineup-group">
          <div class="card-head">
            <p class="eyebrow">${esc(benchLabel)}</p>
            <span>${fmtNumber((team.bench || []).length)}</span>
          </div>
          ${lineupList(team.bench, 'Banco ainda não publicado.')}
        </div>
      </section>
    `;
  }

  function substitutionsList(payload) {
    const rows = payload.substitutions || [];
    if (!rows.length) return '';
    return `
      <section class="drawer-section">
        <div class="card-head">
          <p class="eyebrow">Substituições</p>
          <span>${fmtNumber(rows.length)}</span>
        </div>
        <div class="substitution-list">
          ${rows.map((event) => `
            <div class="substitution-row">
              <span>${esc(substitutionMinuteLabel(event))}</span>
              <strong>${esc(event.player || 'Entrou')}</strong>
              <small>${esc(event.relatedPlayer ? `saiu ${event.relatedPlayer}` : 'substituição')}</small>
            </div>
          `).join('')}
        </div>
      </section>
    `;
  }

  function lineupDrawerHtml(payload) {
    const match = payload.match || {};
    if (payload.status !== 'available') {
      return `
        <div class="team-dossier">
          <section class="drawer-section">
            <div class="empty-state">
              <strong>Escalação oficial ainda não disponível.</strong>
              <span>${esc(payload.message || 'A fonte ainda não publicou titulares e banco deste jogo.')}</span>
            </div>
          </section>
        </div>
      `;
    }

    return `
      <div class="match-lineup-drawer">
        <div class="lineup-scoreline">
          <div>
            ${teamAsset(match.homeCode, match.home, match.homeLogo, 'mini-logo')}
            <strong>${esc(match.home || 'Mandante')}</strong>
          </div>
          <span>${esc(scoreLine(match))}</span>
          <div>
            <strong>${esc(match.away || 'Visitante')}</strong>
            ${teamAsset(match.awayCode, match.away, match.awayLogo, 'mini-logo')}
          </div>
        </div>
        <div class="official-lineup-grid">
          ${lineupTeamBlock(payload.home || {}, match)}
          ${lineupTeamBlock(payload.away || {}, match)}
        </div>
        ${substitutionsList(payload)}
      </div>
    `;
  }

  async function loadMatchLineup(matchId) {
    const drawerTitle = document.getElementById('drawer-title');
    const content = document.getElementById('squad-content');
    const match = (state.matches || []).find((item) => String(item.id) === String(matchId));
    openDrawer();

    if (drawerTitle) {
      drawerTitle.innerHTML = `
        <p class="eyebrow">Escalação oficial</p>
        <h2>${esc(match ? `${match.home} x ${match.away}` : 'Jogo da Copa')}</h2>
      `;
    }
    if (content) content.innerHTML = '<div class="skeleton block"></div>';

    try {
      let payload = matchLineupCache.get(String(matchId));
      const shouldRefreshLineup = match && match.status === 'LIVE';
      if (!payload || shouldRefreshLineup) {
        payload = await api(`/copa/matches/${encodeURIComponent(matchId)}/lineup`);
        matchLineupCache.set(String(matchId), payload);
      }
      if (drawerTitle) {
        const payloadMatch = payload.match || match || {};
        drawerTitle.innerHTML = `
          <p class="eyebrow">${esc(payload.status === 'available' ? 'Escalação oficial' : 'Aguardando oficial')}</p>
          <h2>${esc(payloadMatch.home || 'Mandante')} x ${esc(payloadMatch.away || 'Visitante')}</h2>
        `;
      }
      if (content) content.innerHTML = lineupDrawerHtml(payload);
    } catch (err) {
      if (content) content.innerHTML = `<p class="muted-copy">${esc(err.message)}</p>`;
    }
  }

  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      activateTab(tab.getAttribute('data-tab'), true);
      return;
    }

    const filter = event.target.closest('[data-filter]');
    if (filter) {
      matchFilter = filter.getAttribute('data-filter');
      renderMatches();
      return;
    }

    const matchLineup = event.target.closest('[data-match-lineup]');
    if (matchLineup) {
      loadMatchLineup(matchLineup.getAttribute('data-match-lineup'));
      return;
    }

    const matchJump = event.target.closest('[data-match-jump]');
    if (matchJump) {
      const matchId = matchJump.getAttribute('data-match-jump');
      const card = Array.from(document.querySelectorAll('.match-card')).find((item) => item.getAttribute('data-match-id') === matchId);
      if (card) {
        card.classList.add('has-table-focus');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.setTimeout(() => card.classList.remove('has-table-focus'), 1800);
      }
      return;
    }

    if (event.target.closest('#album-load-button')) {
      loadAlbumPlayers();
      return;
    }

    if (event.target.closest('#album-load-more')) {
      albumVisibleCount += 120;
      renderAlbum();
      return;
    }

    if (event.target.closest('#album-show-all')) {
      albumVisibleCount = filteredAlbumPlayers().length;
      renderAlbum();
      return;
    }

    const lineupMode = event.target.closest('[data-brazil-lineup-mode]');
    if (lineupMode) {
      captureBrazilLineupNotes();
      brazilUserLineup = normalizeBrazilUserLineup({
        ...(brazilUserLineup || defaultBrazilUserLineup()),
        mode: lineupMode.getAttribute('data-brazil-lineup-mode'),
      });
      renderBrazil();
      return;
    }

    if (event.target.closest('#brazil-squad-load')) {
      loadBrazilSquad();
      return;
    }

    if (event.target.closest('#brazil-lineup-clear')) {
      clearUserBrazilLineup();
      return;
    }

    const team = event.target.closest('[data-team-squad]');
    if (team) {
      loadSquad(team.getAttribute('data-team-squad'));
      return;
    }

    if (event.target.closest('#drawer-close')) {
      closeDrawer();
    }
  });

  document.addEventListener('submit', (event) => {
    if (event.target && event.target.id === 'prize-config-form') {
      event.preventDefault();
      savePrizeConfig(event.target);
      return;
    }

    if (event.target && event.target.matches('.brazil-lineup-form')) {
      event.preventDefault();
      saveBrazilLineup(event.target);
      return;
    }

    if (event.target && event.target.id === 'brazil-user-lineup-form') {
      event.preventDefault();
      saveUserBrazilLineup(event.target);
      return;
    }

    const form = event.target.closest('.match-card');
    if (!form) return;
    event.preventDefault();
    savePrediction(form);
  });

  document.addEventListener('change', (event) => {
    const form = event.target.closest('#brazil-user-lineup-form');
    if (!form) return;
    if (event.target.name === 'formation') {
      updateBrazilUserFormation(event.target.value);
      return;
    }
    if (event.target.matches('[data-brazil-player-select]')) {
      updateBrazilUserPlayer(event.target.getAttribute('data-brazil-player-select'), event.target.value);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });

  const search = document.getElementById('team-search');
  if (search) {
    search.addEventListener('input', (event) => {
      teamQuery = event.target.value;
      renderTeams();
    });
  }

  const albumSearch = document.getElementById('album-search');
  if (albumSearch) {
    albumSearch.addEventListener('input', (event) => {
      albumQuery = event.target.value;
      albumVisibleCount = 120;
      renderAlbum();
    });
  }

  const albumTeamFilter = document.getElementById('album-team-filter');
  if (albumTeamFilter) {
    albumTeamFilter.addEventListener('change', (event) => {
      albumTeam = event.target.value || 'all';
      albumVisibleCount = 120;
      renderAlbum();
    });
  }

  const albumPositionFilter = document.getElementById('album-position-filter');
  if (albumPositionFilter) {
    albumPositionFilter.addEventListener('change', (event) => {
      albumPosition = event.target.value || 'all';
      albumVisibleCount = 120;
      renderAlbum();
    });
  }

  exposeLocalGoalPreview();
  load();
})();
