import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [app, html] = await Promise.all(['app.js', 'index.html']
  .map(file => readFile(new URL('../ui/' + file, import.meta.url), 'utf8')));
const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
const burstToken = '0x59676e6d3e4479b0ed4831f87eba9816b8407777';
const whitelistToken = '0x91c8a278b0143c40ebdc1d6158c554f036557777';

function browser({ permission = 'granted', enabled = false, deferShow = false, loadImages = true, lookup } = {}) {
  const opened = [], messages = [], banners = [], images = [], requests = [], nodes = new Map(), metadataCache = new Map();
  const timers = new Map(), events = new Map();
  let timerIndex = 0, tick = 0;
  const storage = new Map([
    ['corla-desk:notifications:v1', JSON.stringify({ enabled, whitelist: true, burst: true })],
  ]);
  const catalog = { filter: 'ending' }, location = { hash: '#settings' };
  let focused = 0, rejectNext = false;
  const $ = id => {
    if (!nodes.has(id)) {
      nodes.set(id, { children: [], dataset: {}, addEventListener(type, listener) { this[type] = listener; } });
    }
    return nodes.get(id);
  };
  class Notification {
    static permission = permission;
    constructor(title, options) {
      if (rejectNext) { rejectNext = false; throw new Error('Mock notification constructor error'); }
      Object.assign(this, { title, options, shown: !deferShow, closed: false });
      // Same-tag notifications replace the active entry in Chrome. A
      // replacement is quiet by default even though the constructor succeeds.
      const replaced = options.tag && messages.findLast(row => row.options.tag === options.tag && !row.closed);
      if (replaced) replaced.close();
      if (!replaced || options.renotify) banners.push(this);
      messages.push(this);
    }
    show() { this.shown = true; this.onshow?.(); }
    close() {
      if (!this.shown || this.closed) return;
      this.closed = true;
      this.onclose?.();
    }
  }
  class Image {
    naturalWidth = 128;
    naturalHeight = 160;
    set src(value) {
      this.url = value;
      images.push(this);
      if (loadImages) queueMicrotask(() => this.onload?.());
    }
    removeAttribute() { this.aborted = true; }
  }
  const context = vm.createContext({
    $, catalog, location, metadataCache, navigator: {}, state: { session: lookup ? 'local-test' : '' },
    Image, URL, URLSearchParams,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { Notification, isSecureContext: true, focus() { focused++; }, addEventListener: (name, cb) => events.set(name, cb) },
    document: { addEventListener() {}, createElement(tag) {
      assert.equal(tag, 'canvas');
      let source;
      return {
        getContext: () => ({ drawImage: image => { source = image.url; } }),
        toDataURL: mime => 'data:' + mime + ';base64,' + Buffer.from(source).toString('base64'),
      };
    } },
    setTimeout(fn, delay) { timers.set(++timerIndex, { fn, due: tick + delay }); return timerIndex; },
    clearTimeout(id) { timers.delete(id); },
    renderDiscover() {},
    syncCatalogSearch() { opened.push($('catalog-search').value); },
    async api(path, body) {
      assert.ok(lookup, 'The test samples require no metadata RPC');
      requests.push({ path, body });
      return lookup(body.urls[0]);
    },
    fetch() { assert.fail('Testing a notification should not call the local service'); },
    notify() { assert.fail('Notification delivery should succeed'); },
  });
  vm.runInContext([
    between('const HEX_ADDRESS', 'const defaults'),
    between('const METADATA_RETRY_MS', 'const CATALOG_LIMIT'),
    between('const NOTIFICATION_PREFS_KEY', 'function element'),
    between('function short', 'function decimal'),
    between('function projectKey', 'function tokenTitle'),
    between('function rememberProjectMetadata', 'function drainMetadata'),
    between('function catalogInteger', 'function catalogTimestamp'),
    between('function readNotificationPrefs', 'function requirePageReload'),
    'bindDesktopNotifications();',
    'globalThis.ui = { deliverChainNotification, renderNotificationControls, previews: NOTIFICATION_PREVIEWS };',
  ].join('\n'), context);
  return {
    ...context.ui, $, opened, messages, banners, images, requests, metadataCache, status: $('notifications-test-status'),
    focused: () => focused, catalog, location, Notification, storage,
    failNext() { rejectNext = true; },
    send(kind) { $('notifications-test-kind').value = kind; return $('notifications-test').click(); },
    pagehide: () => events.get('pagehide')(),
    advance(ms) {
      tick += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= tick && timers.delete(id)) timer.fn();
    },
  };
}

function sourceOf(message) {
  assert.match(message.options.icon, /^data:image\/png;base64,/);
  return Buffer.from(message.options.icon.split(',')[1], 'base64').toString();
}

test('three consecutive abnormal Mint tests each request a fresh banner instead of silently replacing one', async () => {
  const b = browser();
  for (let i = 0; i < 3; i++) await b.send('burst');
  assert.equal(b.messages.length, 3);
  assert.equal(b.banners.length, 3);
  assert.deepEqual(b.messages.map(row => row.closed), [true, true, false]);
  assert.match(b.status.textContent, /第 3 次测试（异常 Mint）：已提交给 Chrome/);
  assert.equal(b.images.length, 1, 'Repeated tests reuse the decoded avatar');
});

test('rapid clicks retire a superseded test even if its show callback arrives late', async () => {
  const b = browser({ deferShow: true });
  await Promise.all([b.send('burst'), b.send('whitelist')]);
  const [older, newer] = b.messages;
  assert.equal(older.closed, false);
  older.show();
  newer.show();
  assert.equal(older.closed, true);
  assert.equal(newer.closed, false);
  assert.match(b.status.textContent, /第 2 次测试（白名单 Mint）/);
});

test('a test error stays local, allows retry, and a late error does not overwrite newer feedback', async () => {
  const b = browser({ enabled: true });
  b.failNext();
  await b.send('burst');
  assert.equal(b.status.dataset.error, 'true');
  assert.match(b.status.textContent, /第 1 次测试.*未接受显示请求/);
  assert.equal(b.$('notifications-test').disabled, false);
  assert.equal(b.$('notifications-burst').disabled, false);
  await b.send('burst');
  await b.send('burst');
  assert.equal(b.status.dataset.error, 'false');
  b.messages[0].onerror();
  assert.equal(b.status.dataset.error, 'false');
  b.messages[1].onerror();
  assert.equal(b.status.dataset.error, 'true');
  assert.match(b.status.textContent, /第 3 次测试.*未接受显示请求/);
  await b.send('burst');
  assert.match(b.status.textContent, /第 4 次测试.*已提交给 Chrome/);
  await b.deliverChainNotification({ ...b.previews.burst, id: 'burst:can-still-deliver' }, { generation: 0 });
  assert.equal(b.messages.at(-1).options.tag, 'corla-desk:burst:can-still-deliver');
});

test('real-token previews show both native notification variants and locate the matching contracts on click', async () => {
  assert.match(html, /<label for="notifications-test-kind"[^>]*>测试通知类型<\/label>/);
  assert.match(html, /id="notifications-test-kind"[\s\S]*<option value="burst">异常 Mint<\/option>[\s\S]*<option value="whitelist">白名单 Mint<\/option>/);
  assert.match(html, /id="notifications-test-status"[^>]*role="status"/);
  const b = browser();
  for (const kind of ['burst', 'whitelist']) {
    await b.send(kind);
    const notification = b.messages.at(-1);
    let prevented = false;
    notification.onclick({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(notification.closed, true);
  }
  assert.equal(b.messages.length, 2, 'Preview works with real monitoring turned off');
  const [burst, whitelist] = b.messages;
  assert.match(burst.title, /^【测试】异常 Mint · ai16z/);
  assert.match(burst.options.body, /最近 60 秒认购 17\/50 批（34\.0%）。\nCA 0x59676E…407777/);
  assert.equal(whitelist.title, '【测试】白名单 Mint · 比特币共建');
  assert.match(whitelist.options.body, /检测到新创建的白名单 Mint。\nCA 0x91C8A2…557777/);
  assert.equal(sourceOf(burst), b.previews.burst.image);
  assert.equal(sourceOf(whitelist), b.previews.whitelist.image);
  assert.notEqual(burst.options.icon, whitelist.options.icon);
  assert.ok(b.images.every(image => image.crossOrigin === 'anonymous' && image.referrerPolicy === 'no-referrer'));
  assert.equal(b.location.hash, '#discover');
  assert.equal(b.catalog.filter, 'all');
  assert.equal(b.focused(), 2);
  assert.deepEqual(b.opened.map(address => address.toLowerCase()), [burstToken, whitelistToken]);
  assert.equal(b.storage.size, 1, 'Preview does not write to the seen or preferences stores');
});

test('a preview uses the production layout but its tag and deduplication stay separate', async () => {
  const b = browser({ enabled: true });
  for (const kind of ['burst', 'whitelist']) {
    const position = b.messages.length;
    await b.send(kind);
    const { image, ...sample } = b.previews[kind];
    const event = { ...sample, id: kind + ':real-event' };
    b.metadataCache.set(event.mint.toLowerCase() + ':' + event.token.toLowerCase(), { image });
    await b.deliverChainNotification(event, { generation: 0 });
    await b.deliverChainNotification(event, { generation: 0 });
    await b.send(kind);
    const [preview, live, repeatedPreview] = b.messages.slice(position);
    assert.equal(b.messages.length, position + 3);
    assert.equal(preview.title, '【测试】' + live.title);
    assert.equal(preview.options.body, live.options.body);
    assert.equal(preview.options.lang, live.options.lang);
    assert.equal(preview.options.icon, live.options.icon);
    assert.equal(preview.options.tag, undefined);
    assert.equal(live.options.tag, 'corla-desk:' + event.id);
    assert.equal(repeatedPreview.options.tag, undefined);
    assert.equal(live.closed, false, 'A new preview only closes an earlier preview');
  }
});

test('preview respects browser permission and ignores unsupported preview types', async () => {
  const b = browser({ permission: 'denied' });
  assert.equal(b.$('notifications-test').disabled, true);
  assert.equal(b.$('notifications-test-kind').disabled, true);
  await b.send('burst');
  assert.equal(b.messages.length, 0);
  b.Notification.permission = 'granted';
  b.renderNotificationControls();
  assert.equal(b.$('notifications-test').disabled, false);
  assert.equal(b.$('notifications-test-kind').disabled, false);
  await b.send('__proto__');
  assert.equal(b.messages.length, 0);
});

test('slow avatar is bounded and still sends the preview as text', async () => {
  const b = browser({ loadImages: false });
  const pending = b.send('burst');
  assert.match(b.status.textContent, /正在准备代币头像/);
  b.advance(3_500);
  await pending;
  assert.equal(b.images[0].aborted, true);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].options.icon, undefined);
  assert.match(b.status.textContent, /已提交给 Chrome（头像暂未加载）/);
});

test('live notifications can load an uncached avatar without ever opening the catalog', async () => {
  let result;
  const b = browser({ enabled: true, lookup: () => result });
  const { image, ...event } = b.previews.whitelist;
  result = { projects: [{ token: event.token, mint: event.mint, name: event.name, image }] };
  await b.deliverChainNotification({ ...event, id: 'live-one' }, { generation: 0 });
  await b.deliverChainNotification({ ...event, id: 'live-two' }, { generation: 0 });
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].path, 'project/metadata');
  const url = new URL(b.requests[0].body.urls[0]);
  assert.equal(url.origin, 'https://flap.sh');
  assert.equal(url.pathname, '/apps/corla/mint/' + event.token);
  assert.equal(url.searchParams.get('mint'), event.mint);
  assert.ok(b.messages.every(message => sourceOf(message) === image));
  assert.equal(b.images.length, 1);
  assert.equal(b.opened.length, 0);
});

test('unapproved avatar URLs are skipped and a delayed lookup does not send after pagehide', async () => {
  const b = browser({ enabled: true });
  const { image: _sample, ...event } = b.previews.burst;
  const key = event.mint.toLowerCase() + ':' + event.token.toLowerCase();
  b.metadataCache.set(key, { image: 'https://untrusted.invalid/test.png' });
  await b.deliverChainNotification({ ...event, id: 'blocked-image' }, { generation: 0 });
  assert.equal(b.images.length, 0);
  assert.equal(b.messages[0].options.icon, undefined);
  const ready = Promise.withResolvers();
  const later = browser({ enabled: true, lookup: () => ready.promise });
  const pending = later.deliverChainNotification({ ...event, id: 'on-close' }, { generation: 0 });
  later.pagehide();
  ready.resolve({ projects: [{ ...event, image: b.previews.burst.image }] });
  await pending;
  assert.equal(later.images.length, 0);
  assert.equal(later.messages.length, 0);
});
