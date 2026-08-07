// ── UTILS ──────────────────────────────────────────────────────

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function escAttr(s) {
  return (s || '').replace(/'/g, "&#39;").replace(/"/g, '&quot;');
}

// Экранирование значения для вставки в JS-строку ВНУТРИ инлайн HTML-обработчика
// (напр. onclick="foo('${escJs(x)}')"): такая строка проходит ДВА разбора подряд —
// сперва HTML-парсер режет атрибут по кавычке-разделителю атрибута, потом браузер
// разбирает содержимое как JS. escAttr() экранирует кавычки только для HTML и не
// годится сама по себе: непойманный бэкслеш или перевод строки обрывают JS-литерал
// раньше времени. Экранируем то, что способно обмануть любой из двух разборов —
// кавычки обоих видов (не только совпадающую с разделителем атрибута), бэкслеш,
// переводы строк и угловые скобки (на случай если атрибут окажется без кавычек
// или значение всплывёт где-то ещё).
function escJs(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/</g, '\\x3C')
    .replace(/>/g, '\\x3E');
}

let _nt;
function notify(msg, type = 'ok') {
  const n = document.getElementById('notif');
  if (!n) return;
  n.textContent = msg;
  n.className = 'notif show ' + type;
  clearTimeout(_nt);
  _nt = setTimeout(() => n.classList.remove('show'), 3500);
}

function showLbar(on) {
  document.getElementById('lbar').style.display = on ? 'block' : 'none';
}

function s(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val ?? '';
}

function g(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

// ── Counter Animation ─────────────────────────────────────────
function animateCount(el, toRaw, opts = {}) {
  if (!el) return;
  const { duration = 1100, prefix = '', suffix = '', isFloat = false } = opts;
  const to = parseFloat(toRaw) || 0;
  if (to === 0) { el.textContent = prefix + '0' + suffix; return; }
  const start = performance.now();
  function update(ts) {
    const p = Math.min((ts - start) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    const val = to * ease;
    el.textContent = prefix + (isFloat ? val.toLocaleString('ru', { maximumFractionDigits: 1 }) : Math.round(val).toLocaleString('ru')) + suffix;
    if (p < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ── Card Entrance Animation ───────────────────────────────────
function cascadeCards(selector, delay = 60) {
  const cards = document.querySelectorAll(selector);
  cards.forEach((c, i) => {
    c.style.opacity = '0';
    c.style.transform = 'translateY(24px)';
    c.style.transition = 'none';
    setTimeout(() => {
      c.style.transition = 'opacity .45s cubic-bezier(.22,.68,0,1.2), transform .45s cubic-bezier(.22,.68,0,1.2)';
      c.style.opacity = '1';
      c.style.transform = '';
    }, i * delay + 10);
  });
}

// ── Favicon ────────────────────────────────────────────────────
// Логотип филиала как иконка вкладки браузера. URL кэшируется в
// localStorage — применяется мгновенно, до ответа /api/salon/logo.
function applyFavicon(url) {
  applyBrandLogo(url);
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (url) {
    link.removeAttribute('type');
    link.href = url;
    localStorage.setItem('lp_favicon', url);
  } else {
    link.type = 'image/svg+xml';
    link.href = 'favicon.svg';
    localStorage.removeItem('lp_favicon');
  }
}

// Логотип филиала в шапке (слева, рядом с «LoyalPro»). При наличии —
// показываем загруженное лого вместо дефолтной звёздочки.
const BRAND_LOGO_STAR = '<svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
function applyBrandLogo(url) {
  const box = document.getElementById('tbBrandLogo');
  if (!box) return;
  if (url) {
    box.classList.add('has-img');
    box.innerHTML = `<img src="${url}" alt="Логотип">`;
  } else {
    box.classList.remove('has-img');
    box.innerHTML = BRAND_LOGO_STAR;
  }
}

async function initFavicon() {
  const cached = localStorage.getItem('lp_favicon');
  if (cached) applyFavicon(cached);
  try {
    const r = await fetch('/api/salon/logo');
    const d = await r.json();
    if (d.logoUrl) applyFavicon(d.logoUrl);
    else if (cached) applyFavicon(null);
  } catch {}
}
