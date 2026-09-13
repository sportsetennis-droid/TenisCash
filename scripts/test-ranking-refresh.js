const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual frontend block, with deferred HTTP responses and a small DOM.
// No network calls, real timers, production credentials or database writes are used.
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loja.html'), 'utf8');
const startMarker = '// ============== RANKING ==============';
const endMarker = '// ============== CRM ==============';
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'The complete ranking frontend block must exist');
const source = html.slice(start, end);

function element(initial = {}) {
  const result = {
    value: '', disabled: false, hidden: false, style: {}, dataset: {},
    htmlWrites: [], textWrites: [], classes: new Set(),
    ...initial,
  };
  let markup = initial.innerHTML || '';
  let text = initial.textContent || '';
  Object.defineProperty(result, 'innerHTML', {
    get: () => markup,
    set(value) { markup = String(value); result.htmlWrites.push(markup); },
  });
  Object.defineProperty(result, 'textContent', {
    get: () => text,
    set(value) {
      text = String(value);
      markup = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      result.textWrites.push(text);
    },
  });
  result.classList = {
    contains: name => result.classes.has(name),
    add: name => result.classes.add(name),
    remove: name => result.classes.delete(name),
  };
  return result;
}

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) || [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
    },
    dispatch(name) {
      for (const callback of listeners.get(name) || []) callback({ type: name });
    },
  };
}

function fixture() {
  const elements = {
    'page-ranking': element({ classes: new Set(['show']) }),
    rankStore: element({ value: 'loja05' }),
    rankPeriod: element({ value: 'today' }),
    rankFrom: element({ value: '2026-09-01' }),
    rankTo: element({ value: '2026-09-13' }),
    rankCustomGroup: element(),
    rankRefresh: element(),
    rankRefreshStatus: element({ textContent: 'Última atualização anterior' }),
    rankPdfDownload: element(),
    rankPdfShare: element(),
    rankWhatsappGenerate: element(),
    rankPdfStatus: element({ textContent: 'PDF pronto' }),
    rankWhatsappBox: element({ hidden: true }),
    rankWhatsappText: element(),
    rankWhatsappStatus: element(),
    rankingTable: element({ innerHTML: '<p>Ranking anterior preservado</p>' }),
    rankingTotals: element({ innerHTML: '<p>Totais anteriores preservados</p>' }),
  };
  const flags = { details: false, modal: false, saleModal: false };
  const intervals = [];
  const requests = [];
  const errors = [];
  const alerts = [];
  const window = eventTarget();
  const document = {
    ...eventTarget(),
    hidden: false,
    getElementById(id) {
      assert.ok(elements[id], 'Unexpected DOM element: ' + id);
      return elements[id];
    },
    querySelector(selector) {
      for (const part of selector.split(',').map(value => value.trim())) {
        if (part === '#rankingTable details[open]' && flags.details) return {};
        if (part === '.modal-bg.show' && flags.modal) return {};
        if (part === '#saleModalOverlay' && flags.saleModal) return {};
      }
      return null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, '#rankingTotals .kpi-card');
      return [0, 1, 2, 3].map(() => ({ remove() {} }));
    },
  };
  const context = vm.createContext({
    document, window, token: 'test-token', activeStore: { id: 'loja05' },
    URLSearchParams, Date,
    console: { log() {}, error: error => errors.push(error) },
    alert: message => alerts.push(message),
    fmt: amount => 'R$ ' + Number(amount || 0).toFixed(2),
    escPreco: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    avatarColor: () => 'blue',
    initials: name => name.slice(0, 2),
    setInterval(callback, milliseconds) {
      intervals.push({ callback, milliseconds });
      return intervals.length;
    },
    api(url) {
      assert.ok(url.startsWith('/api/seller/rankings?'), 'Unexpected API call: ' + url);
      const request = { url, settled: false };
      const promise = new Promise((resolve, reject) => {
        request.resolve = data => { request.settled = true; resolve(data); };
        request.reject = error => { request.settled = true; reject(error); };
      });
      requests.push(request);
      return promise;
    },
  });
  vm.runInContext(source, context, { filename: 'loja-ranking.js' });
  assert.equal(typeof context.refreshVisibleRanking, 'function', 'Ranking refresh helper must exist');
  assert.equal(typeof context.loadRanking, 'function');
  return { context, elements, flags, intervals, requests, document, window, errors, alerts };
}

async function flush() {
  // Flush async continuations, including a request queued by the previous finally.
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

async function loadedFixture({ period = 'today' } = {}) {
  const f = fixture();
  f.elements.rankPeriod.value = period;
  const pending = f.context.loadRanking();
  await flush();
  assert.equal(f.requests.length, 1, 'Initial load must request ranking data');
  f.requests[0].resolve(result('Anterior', period));
  await pending;
  await flush();
  assertRows(f, 'Anterior');
  f.requests.length = 0;
  for (const element of Object.values(f.elements)) {
    element.htmlWrites.length = 0;
    element.textWrites.length = 0;
  }
  return f;
}

function result(label, period = 'today', count = 8) {
  return {
    period, from: '2026-09-13T03:00:00Z', to: '2026-09-14T03:00:00Z',
    canViewRevenueTotals: true,
    totals: { sellersCount: count, salesCount: 12, salesAmount: 1234.56, commissionAmount: 12.35 },
    ranking: Array.from({ length: count }, (_, index) => ({
      sellerId: 'seller-' + index, name: label + ' vendedor ' + (index + 1),
      position: index + 1, store: { id: 'loja05', name: 'Loja 05' },
      salesCount: index === count - 1 ? 0 : 2,
      salesAmount: 100 - index, commissionAmount: 1,
      commission: {
        baseAmount: 1, at50kAmount: 2, clothingBaseAmount: 0.3,
        at20kClothingAmount: 1.2, totalAt1Percent: 1, totalAt2And4Percent: 2.6,
        clothingSalesAmount: 30,
        clothingItems: index === count - 1 ? [{
          date: '2026-09-13T12:00:00Z', quantity: 2, productName: 'Camiseta S&T teste', amount: 30,
        }] : [],
      },
    })),
  };
}

function snapshot(f) {
  return { table: f.elements.rankingTable.innerHTML, totals: f.elements.rankingTotals.innerHTML };
}

function assertPreserved(f, previous, message) {
  assert.equal(f.elements.rankingTable.innerHTML, previous.table, message + ': ranking');
  assert.equal(f.elements.rankingTotals.innerHTML, previous.totals, message + ': totals');
}

function assertRows(f, label, count = 8) {
  const markup = f.elements.rankingTable.innerHTML;
  assert.match(markup, new RegExp('Classificação completa · ' + count + ' vendedores'));
  const tbody = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
  assert.ok(tbody, 'The complete ranking table must be rendered');
  assert.equal((tbody.match(/<tr>/g) || []).length, count);
  for (let i = 1; i <= count; i++) {
    assert.ok(tbody.includes(label + ' vendedor ' + i), 'Missing seller at position ' + i);
    assert.ok(tbody.includes('#' + i), 'Missing numeric position ' + i);
  }
  assert.match(tbody, /Conferir 2 peça/);
  assert.match(tbody, /Camiseta S&amp;T teste/);
  assert.match(markup, /Comissão geral<br>1%/);
  assert.match(markup, /Batendo 50k/);
  assert.match(markup, /Batendo 20k · 4%/);
  assert.match(markup, /Valor total<br>2% \+ 4%/);
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

test('manual refresh preserves the existing table and renders every seller', async () => {
  const f = await loadedFixture();
  const previous = snapshot(f);
  const pending = f.context.loadRanking();
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.rankRefresh.disabled, true);
  assert.ok(f.elements.rankRefreshStatus.textContent.length > 0);
  assertPreserved(f, previous, 'Manual loading must preserve displayed results');
  assert.equal(f.elements.rankingTable.htmlWrites.length, 0);
  assert.equal(f.elements.rankingTotals.htmlWrites.length, 0);
  f.requests[0].resolve(result('Atualizado'));
  await pending;
  await flush();
  assertRows(f, 'Atualizado');
  assert.equal(f.elements.rankRefresh.disabled, false);
  assert.match(f.elements.rankRefreshStatus.textContent, /Atualizado às \d{2}:\d{2}:\d{2}/);
  assert.match(f.elements.rankingTotals.innerHTML, /R\$ 1234.56/);
});

for (const event of ['focus', 'visibilitychange', 'interval']) {
  test(event + ' refreshes the visible ranking without a loading flash', async () => {
    const f = await loadedFixture();
    const previous = snapshot(f);
    const previousStatus = f.elements.rankRefreshStatus.textContent;
    if (event === 'interval') {
      const timers = f.intervals.filter(timer => timer.milliseconds === 30000);
      assert.equal(timers.length, 1, 'Register exactly one 30-second ranking refresh');
      timers[0].callback();
    } else {
      const target = event === 'focus' ? f.window : f.document;
      assert.ok(target.listeners.has(event), 'Register the ' + event + ' listener');
      target.dispatch(event);
    }
    await flush();
    assert.equal(f.requests.length, 1);
    assertPreserved(f, previous, 'Background loading must not flash');
    assert.equal(f.elements.rankRefresh.disabled, false);
    assert.equal(f.elements.rankRefreshStatus.textContent, previousStatus);
    f.requests[0].resolve(result(event));
    await flush();
    assertRows(f, event);
    assert.match(f.elements.rankRefreshStatus.textContent, /Atualizado às \d{2}:\d{2}:\d{2}/);
  });
}

const blockers = [
  ['hidden document', f => { f.document.hidden = true; }],
  ['missing token', f => { f.context.token = ''; }],
  ['other page', f => { f.elements['page-ranking'].classList.remove('show'); }],
  ['open clothing details', f => { f.flags.details = true; }],
  ['open modal', f => { f.flags.modal = true; }],
  ['open sale modal', f => { f.flags.saleModal = true; }],
  ['PDF download running', f => { f.elements.rankPdfDownload.disabled = true; }],
  ['PDF sharing running', f => { f.elements.rankPdfShare.disabled = true; }],
  ['WhatsApp generation running', f => { f.elements.rankWhatsappGenerate.disabled = true; }],
  ['visible WhatsApp text', f => { f.elements.rankWhatsappBox.hidden = false; }],
];

for (const [name, block] of blockers) {
  test(name + ' prevents automatic requests', async () => {
    const f = await loadedFixture();
    const previous = snapshot(f);
    block(f);
    f.context.refreshVisibleRanking();
    f.window.dispatch('focus');
    f.document.dispatch('visibilitychange');
    for (const timer of f.intervals) timer.callback();
    await flush();
    assert.equal(f.requests.length, 0);
    assertPreserved(f, previous, 'An active interaction must preserve the view');
  });
}

test('automatic triggers cannot duplicate a request already in flight', async () => {
  const f = await loadedFixture();
  f.context.refreshVisibleRanking();
  await flush();
  f.context.refreshVisibleRanking();
  f.window.dispatch('focus');
  f.document.dispatch('visibilitychange');
  for (const timer of f.intervals) timer.callback();
  await flush();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(result('Único'));
  await flush();
  assert.equal(f.requests.length, 1, 'Silent triggers must not queue another request');
  assertRows(f, 'Único');
});

test('manual filter changes discard the old response and request only the latest selection', async () => {
  const f = await loadedFixture();
  f.context.loadRanking();
  await flush();
  f.elements.rankStore.value = 'loja02';
  f.context.loadRanking();
  f.elements.rankStore.value = 'all';
  f.elements.rankPeriod.value = 'month';
  f.context.loadRanking();
  f.context.refreshVisibleRanking();
  await flush();
  assert.equal(f.requests.length, 1, 'Only one HTTP request may be in flight');
  assert.equal(f.elements.rankingTotals.innerHTML, '', 'A new filter must clear the previous shop totals');
  assert.match(f.elements.rankingTable.innerHTML, /Carregando/);
  assert.doesNotMatch(f.elements.rankingTable.innerHTML, /Anterior/);
  const loading = snapshot(f);
  f.requests[0].resolve(result('Obsoleto'));
  await flush();
  assertPreserved(f, loading, 'A response for the old store must not be painted');
  assert.equal(f.requests.length, 2);
  const query = new URLSearchParams(f.requests[1].url.split('?')[1]);
  assert.equal(query.get('storeId'), 'all');
  assert.equal(query.get('period'), 'month');
  assert.equal(f.elements.rankRefresh.disabled, true);
  f.requests[1].resolve(result('Mês atual', 'month'));
  await flush();
  assert.equal(f.requests.length, 2, 'Intermediate filters must not issue queued requests');
  assertRows(f, 'Mês atual');
  assert.doesNotMatch(f.elements.rankingTable.innerHTML, /Top 3 do período|Obsoleto/);
  assert.equal(f.elements.rankRefresh.disabled, false);
});

test('editing custom dates without Apply prevents an old response from being painted', async () => {
  const f = await loadedFixture({ period: 'custom' });
  const previous = snapshot(f);
  f.elements.rankPeriod.value = 'custom';
  f.context.loadRanking();
  await flush();
  const query = new URLSearchParams(f.requests[0].url.split('?')[1]);
  assert.equal(query.get('from'), '2026-09-01');
  assert.equal(query.get('to'), '2026-09-13');
  f.elements.rankFrom.value = '2026-09-12';
  f.elements.rankTo.value = '2026-09-14';
  f.requests[0].resolve(result('Datas antigas', 'custom'));
  await flush();
  assertPreserved(f, previous, 'Unsaved custom dates invalidate the displayed response');
  assert.equal(f.elements.rankRefresh.disabled, false);
});

for (const [name, block] of blockers) {
  test(name + ' opened while awaiting a silent request prevents a redraw', async () => {
    const f = await loadedFixture();
    const previous = snapshot(f);
    f.context.refreshVisibleRanking();
    await flush();
    assert.equal(f.requests.length, 1);
    block(f);
    f.requests[0].resolve(result('Não redesenhar'));
    await flush();
    assertPreserved(f, previous, 'Silent response must recheck current interaction state');
    assert.equal(f.elements.rankRefresh.disabled, false);
  });
}

test('manual failure preserves data, reports the error as text and allows retry', async () => {
  const f = await loadedFixture();
  const previous = snapshot(f);
  const failure = new Error('Falha temporária <b>sem HTML</b>');
  f.context.loadRanking();
  await flush();
  f.requests[0].reject(failure);
  await flush();
  assertPreserved(f, previous, 'Failed requests must preserve the last good values');
  assert.ok(f.elements.rankRefreshStatus.textContent.includes(failure.message));
  assert.equal(f.elements.rankRefreshStatus.htmlWrites.length, 0, 'Error messages must use textContent');
  assert.equal(f.elements.rankRefresh.disabled, false);
  f.context.loadRanking();
  await flush();
  assert.equal(f.requests.length, 2, 'Failure must release the in-flight request');
  f.requests[1].resolve(result('Nova tentativa'));
  await flush();
  assertRows(f, 'Nova tentativa');
  assert.equal(f.elements.rankRefresh.disabled, false);
});

test('silent failure leaves the status and displayed values intact and allows the next refresh', async () => {
  const f = await loadedFixture();
  const previous = snapshot(f);
  const status = f.elements.rankRefreshStatus.textContent;
  f.context.refreshVisibleRanking();
  await flush();
  f.requests[0].reject(new Error('Servidor indisponível'));
  await flush();
  assertPreserved(f, previous, 'Silent failure must not replace the last good results');
  assert.equal(f.elements.rankRefreshStatus.textContent, status);
  assert.equal(f.elements.rankRefreshStatus.textWrites.length, 0);
  assert.equal(f.elements.rankRefresh.disabled, false);
  f.context.refreshVisibleRanking();
  await flush();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(result('Recuperado'));
  await flush();
  assertRows(f, 'Recuperado');
});

test('a stale failure does not overwrite the status of a newer manual filter request', async () => {
  const f = await loadedFixture();
  f.context.loadRanking();
  await flush();
  f.elements.rankStore.value = 'all';
  f.context.loadRanking();
  f.requests[0].reject(new Error('Erro da seleção antiga'));
  await flush();
  assert.equal(f.requests.length, 2);
  assert.doesNotMatch(f.elements.rankRefreshStatus.textContent, /Erro da seleção antiga/);
  assert.equal(f.elements.rankRefresh.disabled, true);
  f.requests[1].resolve(result('Seleção atual'));
  await flush();
  assertRows(f, 'Seleção atual');
  assert.equal(f.elements.rankRefresh.disabled, false);
});

test('an empty ranking still releases the refresh controls', async () => {
  const f = await loadedFixture();
  f.context.loadRanking();
  await flush();
  f.requests[0].resolve(result('Vazio', 'today', 0));
  await flush();
  assert.match(f.elements.rankingTable.innerHTML, /Nenhum vendedor/);
  assert.equal(f.elements.rankRefresh.disabled, false);
  f.context.refreshVisibleRanking();
  await flush();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(result('Após vazio'));
  await flush();
  assertRows(f, 'Após vazio');
});

test('a failed request for a different shop cannot retain previous shop totals', async () => {
  const f = await loadedFixture();
  f.elements.rankStore.value = 'loja02';
  f.context.loadRanking();
  await flush();
  assert.equal(f.elements.rankingTotals.innerHTML, '');
  assert.doesNotMatch(f.elements.rankingTable.innerHTML, /Anterior/);
  f.requests[0].reject(new Error('Falha na loja selecionada'));
  await flush();
  assert.equal(f.elements.rankingTotals.innerHTML, '');
  assert.doesNotMatch(f.elements.rankingTable.innerHTML, /Anterior|Carregando/);
  assert.match(f.elements.rankRefreshStatus.textContent, /Falha na loja selecionada/);
  assert.equal(f.elements.rankRefresh.disabled, false);
});

for (const silent of [false, true]) {
  test((silent ? 'silent' : 'manual') + ' response cannot cross an authentication session change', async () => {
    const f = await loadedFixture();
    const previous = snapshot(f);
    f.context.loadRanking({ silent });
    await flush();
    f.context.token = 'seller-session';
    f.requests[0].resolve(result('Resposta de outra sessão'));
    await flush();
    assertPreserved(f, previous, 'A response fetched using a different token must be ignored');
    assert.equal(f.elements.rankRefresh.disabled, false);
  });
}

test('logout reset clears ranking and exports and invalidates a pending response', async () => {
  const f = await loadedFixture();
  f.elements.rankWhatsappBox.hidden = false;
  f.elements.rankWhatsappText.value = 'Mensagem com dados da sessão anterior';
  f.elements.rankWhatsappStatus.textContent = 'Copiado';
  f.context.loadRanking();
  await flush();
  assert.equal(typeof f.context.resetRankingSession, 'function');
  const logoutStart = html.indexOf('function logout()');
  const logoutEnd = html.indexOf('\n}', logoutStart);
  assert.ok(logoutStart >= 0 && logoutEnd > logoutStart);
  assert.match(html.slice(logoutStart, logoutEnd), /resetRankingSession\(\)/);
  f.context.resetRankingSession();
  f.context.token = 'seller-session';
  assert.equal(f.elements.rankingTable.innerHTML, '');
  assert.equal(f.elements.rankingTotals.innerHTML, '');
  assert.equal(f.elements.rankRefreshStatus.textContent, '');
  assert.equal(f.elements.rankPdfStatus.textContent, '');
  assert.equal(f.elements.rankWhatsappStatus.textContent, '');
  assert.equal(f.elements.rankWhatsappText.value, '');
  assert.equal(f.elements.rankWhatsappBox.hidden, true);
  assert.equal(f.elements.rankRefresh.disabled, false);
  f.requests[0].resolve(result('Sessão encerrada'));
  await flush();
  assert.equal(f.elements.rankingTable.innerHTML, '');
  assert.equal(f.elements.rankingTotals.innerHTML, '');
  f.context.loadRanking();
  await flush();
  assert.equal(f.requests.length, 2, 'A new session must be able to fetch immediately');
  f.requests[1].resolve(result('Sessão nova'));
  await flush();
  assertRows(f, 'Sessão nova');
});

(async () => {
  for (const { name, run } of tests) {
    try { await run(); }
    catch (error) { error.message = name + ': ' + error.message; throw error; }
  }
  console.log('PASS: ' + tests.length + ' ranking refresh scenarios (events, interaction guards, single flight, stale responses, errors and full rendering)');
})().catch(error => { console.error(error); process.exitCode = 1; });
