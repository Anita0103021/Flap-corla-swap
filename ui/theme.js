(() => {
  'use strict';
  const key = 'corla-desk:theme';
  const root = document.documentElement;
  const choices = new Set(['day', 'night', 'care']);
  const fallback = 'night';
  const valid = value => choices.has(value) ? value : fallback;
  let saved;
  try { saved = localStorage.getItem(key); } catch { /* Private mode can deny storage. */ }
  // This script runs before stylesheets so a reload does not flash a different theme.
  root.dataset.theme = valid(saved);

  function syncControls() {
    for (const input of document.querySelectorAll('#theme-picker input[name="theme"]')) {
      input.checked = input.value === root.dataset.theme;
    }
    const color = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  }
  function apply(value, persist = false) {
    root.dataset.theme = valid(value);
    syncControls();
    if (persist) {
      try { localStorage.setItem(key, root.dataset.theme); } catch { /* Keep this tab usable. */ }
    }
  }
  function bind() {
    syncControls();
    document.getElementById('theme-picker')?.addEventListener('change', event => {
      const input = event.target;
      if (input.name === 'theme' && input.checked && choices.has(input.value)) apply(input.value, true);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
