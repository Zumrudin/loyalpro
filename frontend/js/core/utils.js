// ── UTILS ──────────────────────────────────────────────────────

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function escAttr(s) {
  return (s || '').replace(/'/g, "&#39;").replace(/"/g, '&quot;');
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
  if (to === 0) return;
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
