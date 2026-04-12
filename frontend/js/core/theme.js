// ── DARK MODE ──────────────────────────────────────────────────

function initDarkMode() {
  const dark = localStorage.getItem('lp_dark') === '1';
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  updateDmLabel(dark);
}

function toggleDarkMode() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('lp_dark', '0');
    updateDmLabel(false);
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('lp_dark', '1');
    updateDmLabel(true);
  }
}

function updateDmLabel(dark) {
  const lbl = document.getElementById('dmLabel');
  if (lbl) lbl.textContent = dark ? '☀️' : '🌙';
}

initDarkMode();
