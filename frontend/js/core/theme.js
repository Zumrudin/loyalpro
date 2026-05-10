// frontend/js/core/theme.js
// ── THEME ────────────────────────────────────────────────────
const LP_THEME_KEY = 'lp_theme';
const LP_DARK_LEGACY_KEY = 'lp_dark';
const LP_REDUCE_MOTION_KEY = 'lp_reduce_motion';
const DEFAULT_THEME = 'glass';

function initTheme() {
  // One-time migration: drop legacy lp_dark, force glass.
  if (localStorage.getItem(LP_DARK_LEGACY_KEY) !== null && !localStorage.getItem(LP_THEME_KEY)) {
    localStorage.removeItem(LP_DARK_LEGACY_KEY);
    localStorage.setItem(LP_THEME_KEY, DEFAULT_THEME);
  }
  let theme = localStorage.getItem(LP_THEME_KEY);
  if (!theme) {
    theme = DEFAULT_THEME;
    localStorage.setItem(LP_THEME_KEY, theme);
  }
  document.documentElement.setAttribute('data-theme', theme);

  if (localStorage.getItem(LP_REDUCE_MOTION_KEY) === '1') {
    document.documentElement.classList.add('no-motion');
  }
}

function setTheme(name) {
  if (name !== 'glass') return; // future-extensible; only glass is valid today
  localStorage.setItem(LP_THEME_KEY, name);
  document.documentElement.setAttribute('data-theme', name);
}

function getTheme() {
  return localStorage.getItem(LP_THEME_KEY) || DEFAULT_THEME;
}

function setReduceMotion(on) {
  if (on) {
    localStorage.setItem(LP_REDUCE_MOTION_KEY, '1');
    document.documentElement.classList.add('no-motion');
  } else {
    localStorage.removeItem(LP_REDUCE_MOTION_KEY);
    document.documentElement.classList.remove('no-motion');
  }
}

initTheme();

// Expose for Node test runner; in browser these are also implicit globals.
globalThis.initTheme = initTheme;
globalThis.setTheme = setTheme;
globalThis.getTheme = getTheme;
globalThis.setReduceMotion = setReduceMotion;
