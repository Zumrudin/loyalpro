// ── Personal Staff Dashboard ─────────────────────────────────────
// Для пользователей с ролью specialist. Показывает их личные метрики
// за выбранный период: визиты, выручка с разбивкой по категориям,
// уник. клиенты, первичные, средний чек, топ-5 услуг, дневной график.
//
// Бэкенд: GET /api/analytics/staff-dashboard?from&to
// Если у пользователя не настроена привязка `users.staff_member_id` →
// сервер вернёт {unlinked: true} и страница покажет плашку.
'use strict';

const _sdRoot = () => document.querySelector('#page-staff-dashboard .sd-root');
const _sdState = { from: null, to: null, preset: 'week' };

function _sdToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}
// Понедельник текущей календарной недели (по МСК). Если сегодня понедельник —
// возвращает сегодня. Использует UTC-арифметику по строке YYYY-MM-DD, что
// безопасно: getUTCDay для даты в UTC 00:00 совпадает с днём в МСК для всех чисел.
function _sdWeekStart() {
  const today = new Date(_sdToday() + 'T00:00:00Z');
  // getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat. Сдвиг до пн = (day + 6) % 7.
  const daysSinceMon = (today.getUTCDay() + 6) % 7;
  today.setUTCDate(today.getUTCDate() - daysSinceMon);
  return today.toISOString().slice(0, 10);
}
// 1-е число текущего месяца (по МСК).
function _sdMonthStart() {
  return _sdToday().slice(0, 7) + '-01';
}
function _sdSetPeriod(preset) {
  _sdState.preset = preset;
  _sdState.to = _sdToday();
  if (preset === 'today') _sdState.from = _sdState.to;
  else if (preset === 'week') _sdState.from = _sdWeekStart();   // ← с пн текущей недели
  else if (preset === 'month') _sdState.from = _sdMonthStart(); // ← с 1-го числа текущего месяца
}
const _sdEsc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _sdFmtRub = (n) => Math.round(parseFloat(n || 0)).toLocaleString('ru');

// Бейдж динамики ▲/▼ к прошлому периоду. opts.inverse — рост это плохо
// (например «не пришли»); opts.pp — метрика уже в процентах, разница
// считается в процентных пунктах, а не относительно.
function _sdDelta(cur, prev, opts = {}) {
  const c = parseFloat(cur), p = parseFloat(prev);
  if (!isFinite(c) || !isFinite(p)) return '';
  let diff, txt;
  if (opts.pp) {
    diff = Math.round((c - p) * 10) / 10;
    txt = (diff > 0 ? '+' : '') + diff + ' п.п.';
  } else {
    if (p === 0) return '';
    diff = Math.round((c - p) / p * 100);
    txt = (diff > 0 ? '+' : '') + diff + '%';
  }
  if (diff === 0)
    return `<span style="font-size:13px;font-weight:600;color:var(--t3);vertical-align:3px;white-space:nowrap">${opts.pp ? '0 п.п.' : '0%'}</span>`;
  const good = opts.inverse ? diff < 0 : diff > 0;
  return `<span style="font-size:13px;font-weight:700;color:${good ? '#13a05e' : '#d23f3f'};vertical-align:3px;white-space:nowrap">${diff > 0 ? '▲' : '▼'} ${txt}</span>`;
}

const _SD_MON_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const _SD_MON_NOM = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

// ── Экран приветствия при первом заходе ─────────────────────────
// Имя берём из ME (users.name = «Фамилия Имя») — второе слово.
function _sdFirstName() {
  const parts = String((typeof ME !== 'undefined' && ME && ME.name) || '').trim().split(/\s+/);
  return parts.length >= 2 ? parts[1] : (parts[0] || '');
}
// Приветствие по локальному времени устройства специалиста.
function _sdGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12)  return ['Доброе утро', '🌅'];
  if (h >= 12 && h < 17) return ['Добрый день', '☀️'];
  if (h >= 17 && h < 23) return ['Добрый вечер', '🌆'];
  return ['Доброй ночи', '🌙'];
}
function _sdHelloHtml() {
  const [greet, emoji] = _sdGreeting();
  const name = _sdFirstName();
  return `
    <div class="sd-hello">
      <div class="sd-hello-emoji">${emoji}</div>
      <h2>${greet}${name ? ', ' + _sdEsc(name) : ''}!</h2>
      <div class="sd-hello-sub" id="sd-hello-step"><span class="sd-step-txt">Собираем актуальные данные…</span></div>
      <div class="sd-hello-bar"><div class="sd-hello-fill"></div></div>
    </div>`;
}
// Смена статуса двумя независимыми span'ами строго по очереди: старый
// полностью угасает, потом появляется новый. Менять textContent во время
// opacity-перехода нельзя — iOS Safari рисует обе строки разом (наложение).
function _sdStepSwap(el, txt, isFinal) {
  const old = el.querySelector('.sd-step-txt:not(.sd-step-out)');
  const delay = old ? 260 : 0;
  if (old) { old.classList.add('sd-step-out'); setTimeout(() => old.remove(), 300); }
  setTimeout(() => {
    // «Готово!» уже показано или на подходе — отложенный статус не вставляем
    if (!el.isConnected || (el.dataset.done && !isFinal)) return;
    const span = document.createElement('span');
    span.className = 'sd-step-txt';
    span.textContent = txt;
    el.appendChild(span);
  }, delay);
}
// Ротация статусов «что мы сейчас делаем» под приветствием.
function _sdHelloSteps(root) {
  const steps = ['Загружаем визиты…', 'Считаем выручку…', 'Сверяем цель месяца…', 'Почти готово…'];
  let i = 0;
  return setInterval(() => {
    const el = root.querySelector('#sd-hello-step');
    if (!el || el.dataset.done || i >= steps.length) return;
    _sdStepSwap(el, steps[i++]);
  }, 800);
}

// ── Редизайн: пастельные хелперы (спека 2026-06-12) ─────────────
// Count-up: после вставки HTML вызвать _sdRunCountUps(root).
// Элемент: <span class="sd-cu" data-cu="58600" data-fmt="rub|int|pct1"></span>
function _sdCuFmt(v, fmt) {
  if (fmt === 'rub')  return '₽ ' + Math.round(v).toLocaleString('ru');
  if (fmt === 'pct1') return (Math.round(v * 10) / 10) + '%';
  return String(Math.round(v));
}
function _sdRunCountUps(root) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.querySelectorAll('.sd-cu').forEach(el => {
    const target = parseFloat(el.dataset.cu) || 0;
    const fmt = el.dataset.fmt || 'int';
    if (reduced || target === 0) { el.textContent = _sdCuFmt(target, fmt); return; }
    const t0 = performance.now(), dur = 600;
    const tick = (t) => {
      if (!el.isConnected) return; // элемент убран из DOM — останавливаем анимацию
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      el.textContent = _sdCuFmt(target * e, fmt);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// Прогресс-кольцо 64px. val: 0..100 или null («—», пустое кольцо).
// Заполнение анимируется CSS-транзишеном stroke-dashoffset — после вставки
// в DOM вызвать _sdFillRings(root).
const _SD_RING_C = 2 * Math.PI * 26; // r=26 во viewBox 64
function _sdRingHtml(val) {
  const shown = val == null ? '—' : (val + '%');
  return `
    <svg class="sd-ring" viewBox="0 0 64 64" data-ring="${val == null ? '' : val}">
      <circle class="bgc" cx="32" cy="32" r="26"/>
      <circle class="fgc" cx="32" cy="32" r="26"
        stroke-dasharray="${_SD_RING_C.toFixed(1)}"
        stroke-dashoffset="${_SD_RING_C.toFixed(1)}"/>
      <text x="32" y="37" text-anchor="middle">${shown}</text>
    </svg>`;
}
function _sdFillRings(root) {
  // Двойной rAF — иначе браузер схлопнет транзишен (как в _sdRender прогресс-бар)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.sd-ring').forEach(svg => {
      const v = parseFloat(svg.dataset.ring);
      if (!isFinite(v)) return;
      const off = _SD_RING_C * (1 - Math.min(100, Math.max(0, v)) / 100);
      svg.querySelector('.fgc').style.strokeDashoffset = off.toFixed(1);
    });
  }));
}

// Hero-блок. s — data.stats. Использует существующий _sdGreeting().
function _sdHeroHtml(s) {
  const [greet, emoji] = _sdGreeting();
  const name = String(s.staffName || '').trim().split(/\s+/).pop() || ''; // «Гатауллина Юлия» → «Юлия»
  const ava = s.staffAvatar
    ? `<img class="sd-hero-ava" src="${_sdEsc(s.staffAvatar)}" alt="" data-fb="${_sdEsc(name.slice(0, 1) || '•')}">`
    : `<div class="sd-hero-ava-fb">${_sdEsc(name.slice(0, 1) || '•')}</div>`;
  return `
    <div class="sd-hero sd-anim" style="--i:0">
      ${ava}
      <div class="sd-hero-t">
        <h2>${greet}${name ? ', ' + _sdEsc(name) : ''}! ${emoji}</h2>
        <div class="sd-hero-sub">За период: ${s.periodRecords} ${_sdPlural(s.periodRecords, 'визит', 'визита', 'визитов')} на ₽ ${_sdFmtRub(s.periodRevenue)}</div>
      </div>
      <div class="sd-hero-dates">${_sdState.from} … ${_sdState.to}</div>
    </div>`;
}
// Фолбэк аватара: если картинка не загрузилась — заменяем на круг с инициалом.
// Вызывается из рендера после вставки HTML. textContent → XSS-safe.
function _sdBindAvaFallback(root) {
  const img = root.querySelector('.sd-hero-ava');
  if (!img) return;
  img.onerror = () => {
    const d = document.createElement('div');
    d.className = 'sd-hero-ava-fb';
    d.textContent = img.dataset.fb || '•';
    img.replaceWith(d);
  };
}
function _sdPlural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Сегментный контрол: позиционируем пилюлю под активной кнопкой.
function _sdMovePill(seg) {
  const pill = seg.querySelector('.sd-seg-pill');
  const btn = seg.querySelector('button.on');
  if (!pill || !btn) return;
  pill.style.left = btn.offsetLeft + 'px';
  pill.style.width = btn.offsetWidth + 'px';
}

async function loadStaffDashboard() {
  const page = document.querySelector('#page-staff-dashboard');
  if (page) page.hidden = false;
  if (!_sdState.from) _sdSetPeriod('week');
  await _sdRender();
}

async function _sdRender() {
  const root = _sdRoot();
  if (!root) return;
  // Первый заход — приветствие с анимацией сбора данных; при смене пресета
  // не стираем контент, а приглушаем его, пока едут свежие данные.
  const firstLoad = !root.dataset.loaded;
  let stepTimer = null;
  let minDelay = Promise.resolve();
  if (firstLoad) {
    root.innerHTML = _sdHelloHtml();
    stepTimer = _sdHelloSteps(root);
    // Прогресс ведём транзишеном из JS (не keyframe): тогда «доезд» до 100%
    // продолжается с текущей ширины без скачка. Старт — кадром позже вставки
    // в DOM, иначе браузер схлопнет 0→88% без анимации.
    const fill0 = root.querySelector('.sd-hello-fill');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (fill0) fill0.style.width = '88%';
    }));
    // Даже если данные пришли раньше — даём бару плавно дойти до конца.
    minDelay = new Promise(r => setTimeout(r, 2600));
  } else {
    root.classList.add('sd-stale');
  }
  let data;
  try {
    data = await api('GET',
      `/api/analytics/staff-dashboard?from=${_sdState.from}&to=${_sdState.to}`);
  } catch (e) {
    if (stepTimer) clearInterval(stepTimer);
    root.classList.remove('sd-stale');
    root.innerHTML = `<div class="pp-hint" style="color:#c00;padding:24px">Ошибка: ${_sdEsc(e.message)}</div>`;
    return;
  }
  if (firstLoad) {
    await minDelay;
    clearInterval(stepTimer);
    // Плавно довозим бар с текущей ширины до 100%, показываем «Готово!»,
    // затем растворяем приветствие — и только после этого рисуем дашборд.
    const fill = root.querySelector('.sd-hello-fill');
    const step = root.querySelector('#sd-hello-step');
    if (step) { step.dataset.done = '1'; _sdStepSwap(step, 'Готово!', true); }
    if (fill) { fill.classList.add('done'); fill.style.width = '100%'; }
    await new Promise(r => setTimeout(r, 650));
    const hello = root.querySelector('.sd-hello');
    if (hello) { hello.classList.add('out'); await new Promise(r => setTimeout(r, 330)); }
  }
  root.classList.remove('sd-stale');
  if (firstLoad) {
    // Дашборд появляется с тем же мягким въездом, что и приветствие.
    root.classList.add('sd-enter');
    setTimeout(() => root.classList.remove('sd-enter'), 600);
  }
  root.dataset.loaded = '1';

  if (data && data.unlinked) {
    root.innerHTML = `
      <div class="sc" style="text-align:center;padding:40px 24px;max-width:600px;margin:40px auto">
        <h3 style="margin:0 0 12px;color:var(--t1)">Профиль не привязан</h3>
        <p style="color:var(--t3);line-height:1.5;margin:0">
          Ваш логин не привязан к мастеру YClients.<br>
          Обратитесь к администратору клиники, чтобы посмотреть свою личную статистику.
        </p>
      </div>`;
    return;
  }

  const s = data.stats;
  const r = s.revenueByCategory;

  // ── Сравнение с прошлым месяцем ─────────────────────────────────
  // pW — эквивалентный отрезок прошлого месяца (1-е…то же число), по нему
  // считаем бейдж динамики, но только на пресете «Месяц» (день/неделю
  // сравнивать с месячным отрезком некорректно). pM — весь прошлый месяц,
  // показывается справкой внизу карточки на всех пресетах.
  const cmp = data.comparison || {};
  const pW = (cmp.prevWindow && cmp.prevWindow.stats) || null;
  const pM = (cmp.prevMonth && cmp.prevMonth.stats) || null;
  const isMonthCmp = _sdState.preset === 'month' && !!pW;
  let wLabel = '', mLabel = 'Прошлый месяц';
  if (cmp.prevWindow) {
    const mIdx = parseInt(cmp.prevWindow.to.slice(5, 7), 10) - 1;
    wLabel = `к 1–${parseInt(cmp.prevWindow.to.slice(8, 10), 10)} ${_SD_MON_GEN[mIdx]}`;
    if (isMonthCmp) mLabel = `Весь ${_SD_MON_NOM[mIdx]}`;
  }
  const fmtRub = (v) => '₽ ' + _sdFmtRub(v);
  const fmtInt = (v) => String(parseInt(v) || 0);
  const fmtPct = (v) => v == null ? '—' : v + '%';
  // Возвращает {badge, sub, ref} для карточки метрики `key`.
  const _sdC = (cur, key, fmt, opts = {}) => {
    if (!pM) return { badge: '', sub: '', ref: '' };
    const vW = pW ? pW[key] : null;
    const vM = pM[key];
    let badge = '', sub = '';
    if (isMonthCmp && vW != null && cur != null) {
      badge = _sdDelta(cur, vW, opts);
      if (badge) sub = `<div style="font-size:11px;color:var(--t3);margin-top:3px">${wLabel} (${fmt(vW)})</div>`;
    }
    const ref = vM == null ? '' :
      `<div style="font-size:12px;color:var(--t3);margin-top:8px;border-top:1px dashed var(--bd);padding-top:6px">${mLabel}: <b>${fmt(vM)}</b></div>`;
    return { badge, sub, ref };
  };
  const cRev  = _sdC(s.periodRevenue,     'periodRevenue',     fmtRub);
  const cVis  = _sdC(s.periodRecords,     'periodRecords',     fmtInt);
  const cNoSh = _sdC(s.noShowClients,     'noShowClients',     fmtInt, { inverse: true });
  const cAvg  = _sdC(s.avgCheck,          'avgCheck',          fmtRub);
  const cNew  = _sdC(s.newClients,        'newClients',        fmtInt);
  const cRet  = _sdC(s.retentionRate,     'retentionRate',     fmtPct, { pp: true });
  const cReap = _sdC(s.reappointmentRate, 'reappointmentRate', fmtPct, { pp: true });
  const cUtil = _sdC(s.utilizationRate,   'utilizationRate',   fmtPct, { pp: true });
  const cGoods = _sdC(s.goodsRevenue,     'goodsRevenue',      fmtRub);
  // Для товаров справка комбинированная: «N шт на ₽ X»
  if (pM) cGoods.ref =
    `<div style="font-size:12px;color:var(--t3);margin-top:8px;border-top:1px dashed var(--bd);padding-top:6px">${mLabel}: <b>${fmtInt(pM.goodsCount)} шт на ${fmtRub(pM.goodsRevenue)}</b></div>`;

  // ── Цель месяца ─────────────────────────────────────────────────
  // Личный план (услуги ₽ + товары ₽), который ставит руководитель на
  // странице «Сотрудники». Всегда за текущий календарный месяц,
  // независимо от пресета. Цвет — по прогнозу на конец месяца.
  const goalHtml = (() => {
    const g = data.goal;
    if (!g) return '';
    const goalBar = (lbl, o) => {
      if (!(parseFloat(o.target) > 0)) return '';
      const pct = Math.round(o.fact / o.target * 100);
      const fc  = Math.round(o.forecast / o.target * 100);
      const color = fc >= 100 ? '#13a05e' : fc >= 80 ? '#e8a23d' : '#d23f3f';
      const fcTxt = fc >= 100
        ? `Прогноз: ₽ ${_sdFmtRub(o.forecast)} — план будет выполнен ✓`
        : `Прогноз: ₽ ${_sdFmtRub(o.forecast)} (${fc}% плана)`;
      return `
        <div style="margin-top:12px">
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:13px;margin-bottom:4px;flex-wrap:wrap">
            <span><b>${lbl}</b>: ₽ ${_sdFmtRub(o.fact)} <span style="color:var(--t3)">из ₽ ${_sdFmtRub(o.target)}</span></span>
            <b style="color:${color}">${Math.min(999, pct)}%</b>
          </div>
          <div style="height:10px;background:var(--bg);border-radius:5px;overflow:hidden">
            <div style="height:100%;width:${Math.min(100, pct)}%;background:${color};border-radius:5px"></div>
          </div>
          <div style="font-size:12px;color:${color};margin-top:4px">${fcTxt}</div>
        </div>`;
    };
    const mIdx = parseInt(g.month.slice(5, 7), 10) - 1;
    const daysInfo = g.plannedDays > 0
      ? `отработано ${g.workedDays} из ${g.plannedDays} раб. дней`
      : `прошло ${g.elapsedDays} из ${g.daysTotal} дней`;
    return `
      <div class="sc" style="margin-top:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
          <div class="sl">🎯 Цель на ${_SD_MON_NOM[mIdx]}</div>
          <span style="font-size:11px;color:var(--t3)">${daysInfo}</span>
        </div>
        ${goalBar('Услуги', g.services)}
        ${goalBar('Товары', g.goods)}
      </div>`;
  })();

  const presets = { today: 'Сегодня', week: 'Неделя', month: 'Месяц' };
  root.innerHTML = `
    ${_sdHeroHtml(s)}
    <div class="sd-toolbar">
      <div class="sd-seg" id="sd-seg">
        <div class="sd-seg-pill"></div>
        ${Object.entries(presets).map(([p, t]) =>
          `<button class="${p === _sdState.preset ? 'on' : ''}" data-preset="${p}">${t}</button>`).join('')}
      </div>
    </div>
    ${goalHtml}
    <div class="sd-g3" style="margin-top:${goalHtml ? '14px' : '0'}">
      <div class="sc sd-p sd-p-rev sd-anim sd-card-rev" style="--i:1">
        <div class="sd-p-head"><span class="sd-p-ico">₽</span><span class="sl">Моя выручка за период</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${parseFloat(s.periodRevenue) || 0}" data-fmt="rub"></span> ${cRev.badge}</div>${cRev.sub}
        <div style="margin-top:10px;border-top:1px solid rgba(0,0,0,.07);padding-top:10px;font-size:13px;line-height:1.6">
          ${[['Услуги', r.services, 'var(--sda-rev)'], ['Косметика', r.goods, 'var(--sda-goods)'], ['Абонементы', r.abonement, 'var(--sda-avg)']].map(([lbl, v, col]) => {
            const pct = s.periodRevenue > 0 ? Math.round((parseFloat(v) || 0) / s.periodRevenue * 100) : 0;
            return `<div style="margin-bottom:6px">
              <div style="display:flex;justify-content:space-between">
                <span style="color:var(--t3)"><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};margin-right:6px"></i>${lbl}</span>
                <b>₽ ${_sdFmtRub(v)}</b>
              </div>
              <div class="sd-mini"><i data-w="${pct}" style="background:${col}"></i></div>
            </div>`;
          }).join('')}
        </div>
        ${cRev.ref}
      </div>
      <div class="sc sd-p sd-p-vis sd-anim" style="--i:2">
        <div class="sd-p-head"><span class="sd-p-ico">📅</span><span class="sl">Визитов проведено</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${s.periodRecords}" data-fmt="int"></span> ${cVis.badge}</div>${cVis.sub}${cVis.ref}
      </div>
      <div class="sc sd-p sd-p-nosh sd-anim" style="--i:3">
        <div class="sd-p-head"><span class="sd-p-ico">✖️</span><span class="sl">Не пришли</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${s.noShowClients}" data-fmt="int"></span> ${cNoSh.badge}</div>${cNoSh.sub}${cNoSh.ref}
      </div>
      <div class="sc sd-p sd-p-avg sd-anim" style="--i:4">
        <div class="sd-p-head"><span class="sd-p-ico">💳</span><span class="sl">Средний чек</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${parseFloat(s.avgCheck) || 0}" data-fmt="rub"></span> ${cAvg.badge}</div>${cAvg.sub}${cAvg.ref}
      </div>
      <div class="sc sd-p sd-p-new sd-anim" style="--i:5">
        <div class="sd-p-head"><span class="sd-p-ico">🌱</span><span class="sl">Первичных за период</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${s.newClients}" data-fmt="int"></span> ${cNew.badge}</div>${cNew.sub}${cNew.ref}
      </div>
    </div>

    <div class="sd-g4" style="margin-top:14px">
      <div class="sc sd-p sd-p-ret sd-anim" style="--i:6">
        <div class="sd-p-head"><span class="sd-p-ico">🔄</span><span class="sl">Возвращаемость</span></div>
        <div class="sd-ring-row">
          ${_sdRingHtml(s.retentionRate)}
          <div>
            ${cRet.badge ? `<div>${cRet.badge}</div>` : ''}${cRet.sub}
            <div class="sd" style="font-size:11px;color:var(--t3)">клиенты, вернувшиеся в течение 45 дней</div>
          </div>
        </div>
        ${cRet.ref}
      </div>
      <div class="sc sd-p sd-p-reap sd-anim" style="--i:7">
        <div class="sd-p-head"><span class="sd-p-ico">📝</span><span class="sl">Перезапись</span></div>
        <div class="sd-ring-row">
          ${_sdRingHtml(s.reappointmentRate)}
          <div>
            ${cReap.badge ? `<div>${cReap.badge}</div>` : ''}${cReap.sub}
            <div class="sd" style="font-size:11px;color:var(--t3)">% визитов с последующей записью</div>
          </div>
        </div>
        ${cReap.ref}
      </div>
      <div class="sc sd-p sd-p-goods sd-anim" style="--i:8">
        <div class="sd-p-head"><span class="sd-p-ico">🛍️</span><span class="sl">Продажи товаров</span></div>
        <div class="sv"><span class="sd-cu" data-cu="${s.goodsCount || 0}" data-fmt="int"></span> <span style="font-size:14px;color:var(--t3);font-weight:400">шт</span> ${cGoods.badge}</div>${cGoods.sub}
        <div class="sd" style="font-size:11px;color:var(--t3);margin-top:6px">на ₽ ${_sdFmtRub(s.goodsRevenue)}</div>
        ${cGoods.ref}
      </div>
      <div class="sc sd-p sd-p-util sd-anim" style="--i:9">
        <div class="sd-p-head"><span class="sd-p-ico">⏱️</span><span class="sl">Загрузка</span></div>
        <div class="sd-ring-row">
          ${_sdRingHtml(s.utilizationRate)}
          <div>
            ${cUtil.badge ? `<div>${cUtil.badge}</div>` : ''}${cUtil.sub}
            <div class="sd" style="font-size:11px;color:var(--t3)">от рабочего расписания</div>
          </div>
        </div>
        ${cUtil.ref}
      </div>
    </div>

    <div class="sc sd-anim" style="--i:10;margin-top:14px;border-radius:16px">
      <div class="sl">Дневной график выручки</div>
      <div class="sd-chart-wrap" id="sd-chart-wrap"></div>
    </div>

    <div class="sc sd-anim" style="--i:11;margin-top:14px;border-radius:16px">
      <div class="sl">Топ-5 услуг</div>
      <div id="sd-top5"></div>
    </div>
  `;

  // Переключатель периодов
  root.querySelectorAll('[data-preset]').forEach(b => {
    b.onclick = () => { _sdSetPeriod(b.dataset.preset); _sdRender(); };
  });
  const seg = root.querySelector('#sd-seg');
  if (seg) requestAnimationFrame(() => _sdMovePill(seg));

  // Анимации
  _sdBindAvaFallback(root);
  _sdRunCountUps(root);
  _sdFillRings(root);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.sd-mini i').forEach(i => { i.style.width = (i.dataset.w || 0) + '%'; });
  }));

  // График + топ-5 (реализации в следующих тасках)
  _sdRenderChart(root.querySelector('#sd-chart-wrap'), data.dailyRevenue || []);
  _sdRenderTop5(root.querySelector('#sd-top5'), data.topServices || []);
}

// SVG-график выручки: сглаженная кривая + градиентная область + hover-тултип.
// rows: [{d:'2026-06-05', revenue:'58600'}]. 1 точка → плашка вместо графика.
function _sdRenderChart(wrap, rows) {
  if (!wrap) return;
  if (!rows.length) {
    wrap.innerHTML = '<div class="pp-hint" style="padding:20px;text-align:center">Нет данных за период</div>';
    return;
  }
  if (rows.length === 1) {
    wrap.innerHTML = `<div style="padding:24px;text-align:center">
      <div style="font-size:30px;font-weight:800;color:var(--sda-rev)">₽ ${_sdFmtRub(rows[0].revenue)}</div>
      <div style="font-size:12px;color:var(--t3);margin-top:4px">за сегодня</div></div>`;
    return;
  }
  const W = 1200, H = 200, padL = 10, padR = 10, padT = 14, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const vals = rows.map(r => parseFloat(r.revenue) || 0);
  const max = Math.max(...vals, 1);
  const pts = vals.map((v, i) => [
    padL + i * iw / (rows.length - 1),
    padT + ih - (v / max) * ih,
  ]);
  // Catmull-Rom → cubic bezier (сглаживание)
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i],
          p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const area = `${d} L ${pts[pts.length - 1][0].toFixed(1)} ${H - padB} L ${pts[0][0].toFixed(1)} ${H - padB} Z`;
  const step = Math.ceil(rows.length / 14);
  const fmtD = (s) => { const parts = String(s).split('-'); return `${parseInt(parts[2])}.${parts[1]}`; };
  const xLabels = rows.map((r, i) =>
    (rows.length <= 14 || i % step === 0)
      ? `<text class="sd-chart-x" x="${pts[i][0].toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtD(r.d)}</text>` : ''
  ).join('');
  const pathLen = 2200; // безопасно больше реальной длины — для stroke-dash анимации

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:200px">
      <defs>
        <linearGradient id="sdAg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--sda-rev)" stop-opacity=".25"/>
          <stop offset="100%" stop-color="var(--sda-rev)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="sd-chart-area" d="${area}" fill="url(#sdAg)" style="opacity:0;transition:opacity .5s ease .4s"/>
      <path class="sd-chart-line" d="${d}"
        style="stroke-dasharray:${pathLen};stroke-dashoffset:${pathLen};transition:stroke-dashoffset .9s ease"/>
      <line class="sd-chart-guide" x1="0" y1="${padT}" x2="0" y2="${H - padB}"/>
      <circle class="sd-chart-dot" r="5" cx="0" cy="0"/>
      ${xLabels}
      <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" style="cursor:crosshair"/>
    </svg>
    <div class="sd-tip"></div>`;

  const svg = wrap.querySelector('svg');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const line = svg.querySelector('.sd-chart-line');
    const areaEl = svg.querySelector('.sd-chart-area');
    if (reduced) { line.style.transition = 'none'; areaEl.style.transition = 'none'; }
    line.style.strokeDashoffset = '0';
    areaEl.style.opacity = '1';
  }));

  // Hover: ближайшая точка → направляющая + точка + тултип
  const guide = svg.querySelector('.sd-chart-guide');
  const dot = svg.querySelector('.sd-chart-dot');
  const tip = wrap.querySelector('.sd-tip');
  const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  svg.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const dd = Math.abs(p[0] - x); if (dd < bd) { bd = dd; best = i; } });
    const px = pts[best][0], py = pts[best][1];
    guide.setAttribute('x1', px); guide.setAttribute('x2', px);
    guide.style.opacity = '1';
    dot.setAttribute('cx', px); dot.setAttribute('cy', py);
    dot.style.opacity = '1';
    const dparts = String(rows[best].d).split('-');
    tip.textContent = `${parseInt(dparts[2])} ${MON[parseInt(dparts[1]) - 1]} · ₽ ${_sdFmtRub(rows[best].revenue)}`;
    // px в координатах viewBox → проценты контейнера; зажать чтобы не вылезал
    const leftPct = Math.min(92, Math.max(8, px / W * 100));
    tip.style.left = leftPct + '%';
    tip.style.top = (py / H * 100) + '%';
    tip.style.opacity = '1';
  });
  svg.addEventListener('mouseleave', () => {
    guide.style.opacity = '0'; dot.style.opacity = '0'; tip.style.opacity = '0';
  });
}

// Заглушка — заменяется в Task 6 плана редизайна.
function _sdRenderTop5(wrap, rows)  { /* Task 6 */ }
