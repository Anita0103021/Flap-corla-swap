import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { LOW_LATENCY_RPC_TIMEOUT_MS } from '../src/rpc-config.mjs';
import { SNIPE_RACE_WINDOW_MS } from '../src/snipe-race.mjs';
import { MAX_SNIPE_ATTEMPTS } from '../src/snipe-limits.mjs';

const uiFile = async name => (await readFile(new URL('../ui/' + name, import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
const [app, html] = await Promise.all(['app.js', 'index.html'].map(uiFile));

function preview(snipeTiming = { retryWindowMs: SNIPE_RACE_WINDOW_MS, rpcTimeoutMs: LOW_LATENCY_RPC_TIMEOUT_MS,
  maxAttempts: MAX_SNIPE_ATTEMPTS }) {
  const listeners = new Map();
  const input = name => ({ addEventListener: (event, handler) => listeners.set(name + ':' + event, handler) });
  const nodes = {
    'snipe-form': { elements: {
      repeatAttempts: { value: '', ...input('attempts') },
      requirePreopen: { checked: false, indeterminate: false, ...input('preopen') },
    } },
    'snipe-preopen-error': { textContent: '', hidden: true },
    'snipe-duration': { textContent: '', hidden: true },
  };
  const selected = app.slice(app.indexOf('function snipeAttemptLimit('), app.indexOf('function reviewLive('));
  const bindings = app.split('\n').filter(line => line.endsWith(', syncSnipeOpeningPolicy);'));
  vm.runInNewContext([app.split('\n').find(line => line.startsWith('const UINT =')), selected, ...bindings].join('\n'), {
    $: id => nodes[id], state: { snipeTiming },
  });
  return {
    fields: nodes['snipe-form'].elements,
    error: nodes['snipe-preopen-error'],
    change(value, requirePreopen = false) {
      const { repeatAttempts, requirePreopen: checkbox } = nodes['snipe-form'].elements;
      checkbox.checked = requirePreopen;
      repeatAttempts.value = value;
      listeners.get('attempts:input')();
      return nodes['snipe-duration'];
    },
    preopenChange(checked) {
      nodes['snipe-form'].elements.requirePreopen.checked = checked;
      listeners.get('preopen:change')();
      return nodes['snipe-duration'];
    },
  };
}

test('duration preview updates on input and distinguishes the RPC timeout from the shared retry window', () => {
  assert.match(html, /name="repeatAttempts"[^>]+aria-describedby="snipe-duration snipe-attempts-hint"/);
  assert.match(html, /id="snipe-duration" role="status" hidden/);
  const page = preview();
  const once = page.change('1');
  assert.equal(once.hidden, false);
  assert.match(once.textContent, /1 轮.*2\.2 秒 RPC 应答，链上确认另计/);
  for (const attempts of ['2', '5', '6', '12', String(MAX_SNIPE_ATTEMPTS)]) {
    const current = page.change(attempts);
    assert.equal(current.hidden, false);
    assert.ok(current.textContent.includes('最多 ' + attempts + ' 轮'));
    assert.match(current.textContent, /共用 4\.8 秒重试窗口，到期不再开新一轮/);
    assert.match(current.textContent, /等待末笔 Mint 的时间另计/);
  }
  assert.equal(page.fields.repeatAttempts.max, String(MAX_SNIPE_ATTEMPTS));
  for (const invalid of ['', '0', '21', '2.5', '2e0']) assert.equal(page.change(invalid).hidden, true);
});

test('no-chase validation hides a one-round preview until the mode is valid', () => {
  const page = preview();
  assert.equal(page.change('1').hidden, false);
  assert.equal(page.preopenChange(true).hidden, true);
  assert.match(page.error.textContent, new RegExp('2–' + MAX_SNIPE_ATTEMPTS));
  assert.equal(page.change('2', true).hidden, false);
  assert.equal(page.change('20', true).hidden, false);
  assert.equal(page.change('1', true).textContent, '');
  assert.equal(page.preopenChange(false).hidden, false);
});

test('the no-chase checkbox starts checked with two valid rounds', () => {
  assert.match(html, /name="requirePreopen"[^>]+\bchecked\b/);
  const defaults = app.slice(app.indexOf('const defaults ='), app.indexOf('const refreshJobs'));
  const { repeatAttempts, requirePreopen } = vm.runInNewContext(defaults + '\ndefaults.snipe');
  assert.equal(requirePreopen, true);
  assert.equal(repeatAttempts, 2);
  assert.match(preview().change(String(repeatAttempts), requirePreopen).textContent, /最多 2 轮/);
});

test('the UI takes timing and caps from the backend, and still handles an older service', () => {
  const updated = preview({ retryWindowMs: 4_800, rpcTimeoutMs: 1_700, maxAttempts: 12 });
  assert.equal(updated.change('12').hidden, false);
  assert.equal(updated.change('13').hidden, true);
  const page = preview({ retryWindowMs: 6_500, rpcTimeoutMs: 1_700 });
  assert.match(page.change('3').textContent, /6\.5 秒重试窗口/);
  assert.match(page.change('1').textContent, /1\.7 秒 RPC 应答/);
  assert.equal(page.fields.repeatAttempts.max, '5');
  assert.ok(page.change('6').hidden);
  assert.ok(preview(null).change('3').hidden);
});
