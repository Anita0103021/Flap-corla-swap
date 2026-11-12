import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const themeScript = await readFile(new URL('../ui/theme.js', import.meta.url), 'utf8');
const themeStyles = await readFile(new URL('../ui/themes.css', import.meta.url), 'utf8');

function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i);
  const rgb = hex.slice(1).match(/../g).map(pair => {
    const c = Number.parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function page(saved, { storageDenied = false } = {}) {
  const key = 'corla-desk:theme';
  const root = { dataset: {} };
  const choices = ['day', 'night', 'care'];
  const options = choices.map(value => ({ name: 'theme', value, checked: value === 'night' }));
  const colors = { day: '#f4f3ef', night: '#11131a', care: '#eee8d7' };
  const storage = new Map(saved ? [[key, saved]] : []);
  const events = new Map();
  let chrome;
  const meta = { setAttribute: (name, value) => { if (name === 'content') chrome = value; } };
  const on = (name, listener) => events.set(name, listener);
  const document = {
    documentElement: root, readyState: 'loading', querySelectorAll: () => options,
    querySelector: () => meta, getElementById: () => ({ addEventListener: on }), addEventListener: on,
  };
  const localStorage = {
    getItem(k) { if (storageDenied) throw Error('blocked'); return storage.get(k); },
    setItem(k, value) { if (storageDenied) throw Error('blocked'); storage.set(k, value); },
  };
  vm.runInNewContext(themeScript, { document, localStorage, window: { addEventListener: on },
    getComputedStyle: () => ({ getPropertyValue: () => colors[root.dataset.theme] }) });
  return {
    current: () => root.dataset.theme,
    checked: () => options.filter(o => o.checked).map(o => o.value),
    chrome: () => chrome,
    saved: () => storage.get(key),
    bind: () => events.get('DOMContentLoaded')(),
    select: value => {
      options.forEach(o => { o.checked = o.value === value; });
      events.get('change')({ target: options.find(o => o.checked) });
    },
    external: newValue => events.get('storage')({ key, newValue }),
  };
}

test('theme applies before styling and radio/chrome track persisted and cross-tab changes', () => {
  const ui = page('care');
  assert.equal(ui.current(), 'care');
  ui.bind();
  assert.deepEqual(ui.checked(), ['care']);
  assert.equal(ui.chrome(), '#eee8d7');
  ui.select('day');
  assert.equal(ui.current(), 'day');
  assert.equal(ui.saved(), 'day');
  assert.equal(ui.chrome(), '#f4f3ef');
  assert.equal(page(ui.saved()).current(), 'day');
  ui.external('night');
  assert.equal(ui.current(), 'night');
  assert.deepEqual(ui.checked(), ['night']);
  assert.equal(ui.chrome(), '#11131a');
  ui.external('invalid');
  assert.equal(ui.current(), 'night');
});

test('theme control works with storage disabled', () => {
  const ui = page('care', { storageDenied: true });
  assert.equal(ui.current(), 'night');
  ui.bind();
  ui.select('care');
  assert.equal(ui.current(), 'care');
  assert.deepEqual(ui.checked(), ['care']);
});

test('all three palettes keep content, actions and semantic states legible', () => {
  const palettes = [...themeStyles.matchAll(/:root\[data-theme='(day|night|care)'\]\s*\{([^}]+)\}/g)];
  assert.deepEqual(palettes.map(([, theme]) => theme).sort(), ['care', 'day', 'night']);
  const pairs = [
    ['text', 'bg'], ['muted', 'panel'], ['subtle', 'side'], ['placeholder', 'inset'],
    ['violet-ink', 'violet-solid'], ['violet-ink', 'primary-hover'], ['accent-strong', 'accent-soft'],
    ['green', 'green-soft'], ['amber', 'amber-soft'], ['danger', 'danger-soft'], ['danger-ink', 'danger-fill'],
  ];
  for (const [, theme, css] of palettes) {
    const tokens = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[\da-f]{6});/gi)].map(([, token, hex]) => [token, hex]));
    for (const [ink, bg, min = 4.5] of [...pairs, ['focus', 'panel', 3], ['progress-accent', 'progress-track', 3]]) {
      const [a, b] = [luminance(tokens[ink]), luminance(tokens[bg])].sort((x, y) => y - x);
      assert.ok((a + 0.05) / (b + 0.05) >= min, `${theme}: ${ink}/${bg} is below ${min}:1`);
    }
  }
});
