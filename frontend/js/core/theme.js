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

// ── ОФОРМЛЕНИЕ IVORY & BRASS (дев-приёмка) ─────────────────────
// Новая айдентика PERI включается атрибутом <html data-skin="ivory"> и живёт
// в css/ivory-brass.css. С 06.11.2026 (решение владельца) — основной вид везде:
// на боевом домене Ivory всегда, кнопки «Прежний вид» нет. Переключатель
// остаётся ТОЛЬКО на дев-стенде (_skinAvailable) — сравнивать со старым видом.
// Тёмная тема в Ivory не применяется, её выбор (lp_dark) не стирается.
function _skinAvailable() {
  const h = location.hostname;
  return h.startsWith('dev.') || h === 'localhost' || h === '127.0.0.1' || h === '89.125.92.223';
}
function _skinIvory() {
  return !_skinAvailable() || localStorage.getItem('lp_skin') !== 'classic';
}
function applySkin() {
  const html = document.documentElement;
  if (_skinIvory()) {
    html.setAttribute('data-skin', 'ivory');
    html.removeAttribute('data-theme');
  } else {
    html.removeAttribute('data-skin');
    if (localStorage.getItem('lp_dark') === '1') html.setAttribute('data-theme', 'dark');
  }
  const b = document.getElementById('skinToggle');
  if (b) {
    b.hidden = !_skinAvailable();
    b.textContent = _skinIvory() ? 'Прежний вид' : 'Ivory & Brass';
  }
}
function toggleSkin() {
  localStorage.setItem('lp_skin', _skinIvory() ? 'classic' : 'ivory');
  applySkin();
  // Графики Chart.js берут цвета при создании — проще и надёжнее перезагрузить
  // страницу (hash сохраняет раздел и открытый диалог).
  location.reload();
}
applySkin();
document.addEventListener('DOMContentLoaded', applySkin);

// Цвета графиков: в Ivory — латунь / тауп / приглушённый терракотовый вместо
// зелёного / синего / красного. Прежнее оформление получает прежние значения.
function lpChartColor(role, alpha) {
  const P = _skinIvory()
    ? { main: [128, 99, 53], second: [183, 168, 155], neg: [166, 83, 66] }
    : { main: [0, 200, 150], second: [59, 130, 246], neg: [232, 84, 84] };
  const c = P[role] || P.main;
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
}
if (window.Chart && _skinIvory()) {
  Chart.defaults.font.family = 'Manrope, Arial, sans-serif';
  Chart.defaults.color = '#6C5F55';
  Chart.defaults.borderColor = '#E7DDD1';
}

// Цвета уровней лояльности: в Ivory — приглушённая гамма бренда, иначе прежние.
function lpLevelColor(key, fallback) {
  if (!_skinIvory()) return fallback;
  return { platinum: '#6F6A80', gold: '#C9A96B', silver: '#B7A89B', bronze: '#8E6334' }[key] || fallback;
}
