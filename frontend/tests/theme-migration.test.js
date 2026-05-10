const assert = require('assert');

function setupDom(localStorageData) {
  global.localStorage = {
    _d: { ...localStorageData },
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  global.document = {
    documentElement: {
      _attrs: {}, _classes: new Set(),
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k] || null; },
      removeAttribute(k) { delete this._attrs[k]; },
      classList: { add(c) { document.documentElement._classes.add(c); }, remove(c) { document.documentElement._classes.delete(c); }, contains(c) { return document.documentElement._classes.has(c); } },
    },
  };
}

function loadTheme() {
  delete require.cache[require.resolve('../js/core/theme.js')];
  require('../js/core/theme.js');
  return { setTheme: global.setTheme, getTheme: global.getTheme, initTheme: global.initTheme, setReduceMotion: global.setReduceMotion };
}

// Test 1: Fresh user (no keys) → glass default
setupDom({});
loadTheme();
assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'glass', 'fresh user should get glass theme');
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass', 'fresh user should have lp_theme persisted');

// Test 2: Existing user with lp_dark='1' → migrated to glass
setupDom({ lp_dark: '1' });
loadTheme();
assert.strictEqual(localStorage.getItem('lp_dark'), null, 'lp_dark should be removed');
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass', 'lp_theme should be set to glass');
assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'glass');

// Test 3: Existing user with lp_dark='0' → migrated to glass
setupDom({ lp_dark: '0' });
loadTheme();
assert.strictEqual(localStorage.getItem('lp_dark'), null);
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass');

// Test 4: Already migrated (lp_theme='glass', no lp_dark) → no-op
setupDom({ lp_theme: 'glass' });
loadTheme();
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass');

// Test 5: setTheme persists and applies
setupDom({});
const api = loadTheme();
api.setTheme('glass');
assert.strictEqual(localStorage.getItem('lp_theme'), 'glass');
assert.strictEqual(document.documentElement.getAttribute('data-theme'), 'glass');

// Test 6: setReduceMotion adds/removes .no-motion class
setupDom({});
const api2 = loadTheme();
api2.setReduceMotion(true);
assert.ok(document.documentElement.classList.contains('no-motion'), 'setReduceMotion(true) adds .no-motion');
assert.strictEqual(localStorage.getItem('lp_reduce_motion'), '1', 'setReduceMotion(true) persists lp_reduce_motion');
api2.setReduceMotion(false);
assert.ok(!document.documentElement.classList.contains('no-motion'), 'setReduceMotion(false) removes .no-motion');
assert.strictEqual(localStorage.getItem('lp_reduce_motion'), null, 'setReduceMotion(false) clears lp_reduce_motion');

// Test 7: initTheme applies .no-motion when lp_reduce_motion='1' is preset
setupDom({ lp_theme: 'glass', lp_reduce_motion: '1' });
loadTheme();
assert.ok(document.documentElement.classList.contains('no-motion'), 'initTheme adds .no-motion when lp_reduce_motion=1');

console.log('theme-migration.test: all 7 assertions passed');
