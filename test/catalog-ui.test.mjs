import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
const zero = '0x' + '0'.repeat(40);
const address = n => '0x' + n.toString(16).padStart(40, '0');
const makeRow = n => ({ mint: address(n), token: address(100 + n), url: 'test:' + n });
const makeStatus = (row, extras = {}) => ({ ...row, launched: true, totalLots: '200', mintedLots: '200',
  pricePerLot: '5000000', quoteToken: zero, block: 10, ...extras });

function testUi(handler) {
  const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
  let now = 1_000_000;
  class MockDate extends Date { static now() { return now; } }
  class Node {
    constructor(tag, text = '') { this.tag = tag; this.text = text; this.children = []; this.dataset = {}; }
    get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
    set textContent(text) { this.text = String(text); this.children.length = 0; }
    get classList() { return { add() {} }; }
    append(...nodes) { this.children.push(...nodes); }
    querySelector(tag) {
      return this.children.find(node => node.tag === tag) ?? this.children.map(node => node.querySelector(tag)).find(Boolean);
    }
    setAttribute() {}
    addEventListener() {}
  }
  const context = vm.createContext({
    api: handler, catalogVisible: () => true, renderDiscover() {}, Date: MockDate,
    fmtInt: new Intl.NumberFormat('en-US'), paintCatalogMetadata() {}, paintCatalogDuration() {},
    element: (tag, _class, text) => new Node(tag, text), icon: () => new Node('svg'),
    tokenTitle: () => new Node('name'), tokenPicture: () => new Node('picture'),
    external: (_url, _class, text) => new Node('a', text), badge: text => new Node('badge', text),
    iconAction: () => new Node('button'), setButton: (node, label) => { node.textContent = label; },
  });
  vm.runInContext([
    between('const HEX_ADDRESS', 'const defaults'),
    between('const CATALOG_LIMIT', 'let metadataInFlight'),
    between('const catalogDate', 'function catalogInteger'),
    between('function short', 'function decimal'),
    between('function formatUnits', 'function parseLink'),
    between('function same', 'function imageUrl'),
    between('function catalogInteger', 'function catalogIsFilled'),
    between('function catalogQuote(', 'function catalogQuery'),
    between('function catalogStat', 'function updateCatalogCards'),
    between('function catalogStatusRows', 'function mergeCatalogPage'),
    'globalThis.model = { catalog, catalogQuote, catalogPhase, catalogStatusRows, loadCatalogStatus, catalogCard };',
  ].join('\n'), context);
  return { ...context.model, now: () => now, advance: ms => { now += ms; } };
}
function renderCard(ui, row, status, failed = false) {
  const now = Math.floor(ui.now() / 1000);
  const [kind, title, tone] = ui.catalogPhase(status, now, failed);
  return ui.catalogCard(row, { key: row.mint, view: status ?? row, kind, title, tone, mode: '', mintIndex: -1,
    hasSnipe: false, disabled: false, fundingPhase: 'unknown', now, quote: ui.catalogQuote(status),
    stale: Boolean(status && failed) });
}
function actions(node) {
  return [...(node.dataset.catalogAction ? [node.dataset.catalogAction] : []), ...node.children.flatMap(actions)];
}

function testDirectory(api) {
  const state = { session: 'test', reloadRequired: false };
  const controls = {
    'catalog-quote-summary': { textContent: '' },
    'catalog-quote-filter': { value: 'enabled' },
    'catalog-quote-refresh': { disabled: false },
    'catalog-quote-list': { rows: [], replaceChildren(...rows) { this.rows = rows; } },
  };
  const context = vm.createContext({
    $, api, state, fmtInt: new Intl.NumberFormat('en-US'), ZERO_ADDRESS: zero, EXPLORER: 'https://example.org',
    element: (tag, cls, text) => ({ tag, cls, text, append(...args) { this.children = args; } }),
    external: (_url, _cls, text) => text, badge: text => text,
  });
  function $(key) { return controls[key]; }
  vm.runInContext(app.slice(app.indexOf('let quoteDirectoryRequest'), app.indexOf('function renderDiscover()')) +
    '\nglobalThis.directory = { loadQuoteDirectory, renderQuoteDirectory };', context);
  return { ...context.directory, state, summary: controls['catalog-quote-summary'], refresh: controls['catalog-quote-refresh'],
    filter: controls['catalog-quote-filter'], list: controls['catalog-quote-list'] };
}

test('a stale backend 404 explains that a restart is needed, while refresh can still recover', async () => {
  let calls = 0;
  const ui = testDirectory(async (path, body) => {
    assert.equal(path, 'catalog/quote-assets');
    assert.equal(Object.keys(body).length, 0);
    if (++calls === 1) throw Object.assign(new Error('页面不存在'), { status: 404 });
    return { block: 4321, assets: [{ address: zero, symbol: 'BNB', status: 'enabled', category: 'featured', decimals: 18 }] };
  });
  await ui.loadQuoteDirectory();
  assert.match(ui.summary.textContent, /未加载底池接口.*重启 Corla/);
  assert.equal(ui.refresh.disabled, false);
  await ui.loadQuoteDirectory();
  assert.match(ui.summary.textContent, /#4,321 · 1 个已开放/);
  assert.equal(ui.list.rows.length, 1);
  assert.equal(ui.list.rows[0].children[0].text, 'BNB');
});

test('refresh failures retain the previous catalog and zero verified assets have an explanation', async () => {
  let calls = 0;
  const ui = testDirectory(async () => {
    if (calls++ > 0) throw Object.assign(new Error('offline'), { status: 503 });
    return { block: 4321, assets: [{ address: zero, symbol: 'BNB', status: 'unknown', category: 'featured', decimals: 18 }] };
  });
  await ui.loadQuoteDirectory();
  assert.match(ui.list.rows[0].text, /待核验.*全部候选/);
  ui.filter.value = 'all';
  ui.renderQuoteDirectory();
  assert.equal(ui.list.rows[0].children[0].text, 'BNB');
  const refresh = ui.loadQuoteDirectory();
  assert.match(ui.summary.textContent, /正在刷新，保留上次结果/);
  await refresh;
  assert.match(ui.summary.textContent, /查询失败.*显示上次结果.*#4,321/);
  assert.equal(ui.list.rows[0].children[0].text, 'BNB');
});

test('catalog tools stay in the page header, separate from the query and sync status', () => {
  const markup = html.slice(html.indexOf('id="view-discover"'), html.indexOf('id="view-wallets"'));
  const part = (begin, end) => markup.slice(markup.indexOf(begin), markup.indexOf(end));
  const heading = part('catalog-heading', 'catalog-toolbar');
  const toolbar = part('catalog-toolbar', 'catalog-caption');
  const caption = part('catalog-caption', 'id="catalog-notice"');
  assert.match(heading, /class="catalog-utilities"[\s\S]*id="catalog-quote-open"[\s\S]*id="catalog-notification-link"/);
  assert.match(toolbar, /id="catalog-filters"[\s\S]*id="catalog-search"[\s\S]*id="catalog-sort"/);
  assert.doesNotMatch(toolbar, /id="catalog-(quote-open|notification-link|live-label)"/);
  assert.match(caption, /id="catalog-summary"[\s\S]*id="catalog-live-label"[\s\S]*id="catalog-updated"/);
  const directory = html.slice(html.indexOf('id="catalog-quote-dialog"'), html.indexOf('id="project-remove-dialog"'));
  assert.match(directory, /class="quote-directory-controls"[\s\S]*id="catalog-quote-filter"[\s\S]*id="catalog-quote-refresh"/);
  assert.doesNotMatch(directory, /catalog-search-tools/);
});

test('catalog cards offer ERC-20 Mint and sniping while funding, and claiming after launch', () => {
  const ui = testUi();
  const row = makeRow(1);
  const status = makeStatus(row, { quoteToken: address(999), quoteSymbol: 'QUOTE', quoteDecimals: 6 });
  const card = renderCard(ui, row, status);
  assert.match(card.textContent, /已开盘/);
  assert.match(card.textContent, /200 \/ 200 批100%/);
  assert.match(card.textContent, /5 QUOTE/);
  assert.match(card.textContent, /1000 QUOTE/);
  assert.match(card.textContent, /配置领币/);
  assert.deepEqual(actions(card), ['copy', 'official', 'mint']);
  const noSymbol = renderCard(ui, row, { ...status, quoteSymbol: null, quoteDecimals: 0 });
  assert.match(noSymbol.textContent, /5000000 0x000000…0003e7/);
  const unverifiedDecimals = renderCard(ui, row, { ...status, quoteDecimals: null });
  assert.match(unverifiedDecimals.textContent, /Mint 单批—/);
  assert.doesNotMatch(unverifiedDecimals.textContent, /5000000| BNB/);
  const active = { ...status, launched: false, phase: 1, mintedLots: '100', fundingDeadline: 9_000 };
  assert.deepEqual(actions(renderCard(ui, row, active)), ['copy', 'official', 'mint', 'snipe']);
  assert.deepEqual(actions(renderCard(ui, row, { ...active, quoteDecimals: null })), ['copy', 'official']);
});

test('catalog never guesses a quote from a factory row and preserves verified native actions', () => {
  const ui = testUi();
  const row = makeRow(1);
  const pending = renderCard(ui, { ...row, pricePerLot: '5000000000000000' });
  assert.match(pending.textContent, /支付币种或精度待核验/);
  assert.doesNotMatch(pending.textContent, / BNB/);
  assert.deepEqual(actions(pending), ['copy', 'official']);
  const noAddress = renderCard(ui, row, makeStatus(row, { quoteToken: undefined, nativeQuote: true }));
  assert.deepEqual(actions(noAddress), ['copy', 'official']);
  const native = renderCard(ui, row, makeStatus(row, { pricePerLot: '5000000000000000' }));
  assert.match(native.textContent, /0\.005 BNB/);
  assert.match(native.textContent, /配置领币/);
  assert.ok(actions(native).includes('mint'));
});

test('one missing row retries independently without losing good or retained statuses', async () => {
  const rows = [makeRow(1), makeRow(2), makeRow(3)];
  const [a, b, c] = rows;
  let outcome = [makeStatus(a), makeStatus(b)];
  const ui = testUi(async () => ({ projects: outcome }));
  const key = row => row.mint + ':' + row.token;
  ui.catalog.rows = rows;
  assert.equal(await ui.loadCatalogStatus(rows), true);
  assert.equal(ui.catalog.statusError, '');
  assert.equal(ui.catalog.statuses.size, 2);
  assert.match(renderCard(ui, c, undefined, ui.catalog.statusFailures.has(key(c))).textContent, /状态暂未读到/);
  assert.equal(ui.catalogStatusRows(rows).some(row => row.url === c.url), false);
  ui.advance(6000);
  assert.equal(ui.catalogStatusRows(rows).some(row => row.url === c.url), true);
  outcome = [makeStatus(a, { block: 11 }), { ...b, error: 'broken' }, makeStatus(c)];
  assert.equal(await ui.loadCatalogStatus(rows), true);
  assert.equal(ui.catalog.statusError, '');
  assert.equal(ui.catalog.statuses.get(key(b)).block, 10);
  assert.match(renderCard(ui, b, ui.catalog.statuses.get(key(b)), true).textContent, /显示上次快照/);
  assert.equal(ui.catalog.statusFailures.has(key(c)), false);
});

test('whole-board failures report retry while one-off exact lookup is local', async () => {
  const rows = [makeRow(1), makeRow(2), makeRow(3)];
  let outcome = [];
  const ui = testUi(async () => {
    if (outcome === null) throw new Error('offline');
    return { projects: outcome };
  });
  assert.equal(await ui.loadCatalogStatus(rows), false);
  assert.match(ui.catalog.statusError, /多数项目状态暂未同步/);
  outcome = [makeStatus(rows[0])];
  assert.equal(await ui.loadCatalogStatus(rows), true);
  assert.equal(ui.catalog.statusError, '');
  outcome = null;
  const lastUpdated = ui.catalog.lastUpdated;
  ui.advance(5000);
  assert.equal(await ui.loadCatalogStatus([rows[0]], { isolated: true }), false);
  assert.equal(ui.catalog.statusError, '');
  assert.equal(await ui.loadCatalogStatus([rows[0]]), true);
  assert.equal(ui.catalog.statusError, '', 'a retry consisting of one failed card is not a board-wide outage');
  assert.equal(ui.catalog.lastUpdated, lastUpdated, 'failure does not advance the last synced time');
  assert.equal(await ui.loadCatalogStatus(rows), false);
  assert.match(ui.catalog.statusError, /offline/);
  assert.equal(ui.catalog.statuses.size, 1);
});
