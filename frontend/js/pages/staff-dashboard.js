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

async function loadStaffDashboard() {
  const page = document.querySelector('#page-staff-dashboard');
  if (page) page.hidden = false;
  if (!_sdState.from) _sdSetPeriod('week');
  await _sdRender();
}

async function _sdRender() {
  const root = _sdRoot();
  if (!root) return;
  root.innerHTML = `<div class="pp-hint" style="padding:24px">Загрузка…</div>`;
  let data;
  try {
    data = await api('GET',
      `/api/analytics/staff-dashboard?from=${_sdState.from}&to=${_sdState.to}`);
  } catch (e) {
    root.innerHTML = `<div class="pp-hint" style="color:#c00;padding:24px">Ошибка: ${_sdEsc(e.message)}</div>`;
    return;
  }

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

  root.innerHTML = `
    <div class="sd-toolbar" style="display:flex;gap:8px;padding:14px 0;align-items:center;flex-wrap:wrap">
      ${['today','week','month'].map(p => `
        <button class="btn ${p===_sdState.preset?'btn-pri':''}" data-preset="${p}">
          ${({today:'Сегодня',week:'Неделя',month:'Месяц'})[p]}
        </button>`).join('')}
      <span style="flex:1;min-width:12px"></span>
      <span style="font-size:13px;color:var(--t3)">${s.staffName || ''} · ${_sdState.from} … ${_sdState.to}</span>
    </div>

    <div class="sg" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">
      <div class="sc">
        <div class="sl">Моя выручка за период</div>
        <div class="sv">₽ ${_sdFmtRub(s.periodRevenue)} ${cRev.badge}</div>${cRev.sub}
        <div style="margin-top:10px;border-top:1px solid var(--bd);padding-top:10px;font-size:13px;line-height:1.7">
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t3)">Услуги</span><b>₽ ${_sdFmtRub(r.services)}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t3)">Косметика</span><b>₽ ${_sdFmtRub(r.goods)}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t3)">Абонементы</span><b>₽ ${_sdFmtRub(r.abonement)}</b></div>
        </div>
        ${cRev.ref}
      </div>
      <div class="sc"><div class="sl">Визитов проведено</div><div class="sv">${s.periodRecords} ${cVis.badge}</div>${cVis.sub}${cVis.ref}</div>
      <div class="sc"><div class="sl">Не пришли</div><div class="sv">${s.noShowClients} ${cNoSh.badge}</div>${cNoSh.sub}${cNoSh.ref}</div>
      <div class="sc"><div class="sl">Средний чек</div><div class="sv">₽ ${_sdFmtRub(s.avgCheck)} ${cAvg.badge}</div>${cAvg.sub}${cAvg.ref}</div>
      <div class="sc"><div class="sl">Первичных за период</div><div class="sv">${s.newClients} ${cNew.badge}</div>${cNew.sub}${cNew.ref}</div>
    </div>

    <div class="sg" style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:14px">
      <div class="sc">
        <div class="sl">Возвращаемость</div>
        <div class="sv">${s.retentionRate == null ? '—' : s.retentionRate + '%'} ${cRet.badge}</div>${cRet.sub}
        <div class="sd" style="font-size:11px;color:var(--t3);margin-top:6px">клиенты, вернувшиеся в течение 45 дней</div>
        ${cRet.ref}
      </div>
      <div class="sc">
        <div class="sl">Перезапись</div>
        <div class="sv">${s.reappointmentRate == null ? '—' : s.reappointmentRate + '%'} ${cReap.badge}</div>${cReap.sub}
        <div class="sd" style="font-size:11px;color:var(--t3);margin-top:6px">% визитов с последующей записью</div>
        ${cReap.ref}
      </div>
      <div class="sc">
        <div class="sl">Продажи товаров</div>
        <div class="sv">${s.goodsCount || 0} <span style="font-size:14px;color:var(--t3);font-weight:400">шт</span> ${cGoods.badge}</div>${cGoods.sub}
        <div class="sd" style="font-size:11px;color:var(--t3);margin-top:6px">на ₽ ${_sdFmtRub(s.goodsRevenue)}</div>
        ${cGoods.ref}
      </div>
      <div class="sc">
        <div class="sl">Загрузка</div>
        <div class="sv">${s.utilizationRate == null ? '—' : s.utilizationRate + '%'} ${cUtil.badge}</div>${cUtil.sub}
        <div class="sd" style="font-size:11px;color:var(--t3);margin-top:6px">от рабочего расписания</div>
        ${cUtil.ref}
      </div>
    </div>

    <div class="sc" style="margin-top:14px">
      <div class="sl">Дневной график выручки</div>
      <canvas id="sd-chart" width="1200" height="180"
        style="width:100%;height:180px;display:block;margin-top:10px"></canvas>
    </div>

    <div class="sc" style="margin-top:14px">
      <div class="sl">Топ-5 услуг</div>
      ${data.topServices.length === 0
        ? '<div class="pp-hint" style="margin-top:10px">Нет данных за период</div>'
        : `<table style="width:100%;margin-top:10px;font-size:13px;border-collapse:collapse">
            <thead><tr style="border-bottom:1px solid var(--bd)">
              <th style="text-align:left;padding:8px 6px;color:var(--t3);font-weight:600">Услуга</th>
              <th style="text-align:right;padding:8px 6px;color:var(--t3);font-weight:600">Кол-во</th>
              <th style="text-align:right;padding:8px 6px;color:var(--t3);font-weight:600">Выручка</th>
            </tr></thead>
            <tbody>
              ${data.topServices.map(t => `
                <tr style="border-bottom:1px solid var(--bg)">
                  <td style="padding:8px 6px">${_sdEsc(t.service_name)}</td>
                  <td style="padding:8px 6px;text-align:right">${t.cnt}</td>
                  <td style="padding:8px 6px;text-align:right;font-weight:600">₽ ${_sdFmtRub(t.total_amount)}</td>
                </tr>`).join('')}
            </tbody>
          </table>`}
    </div>
  `;

  root.querySelectorAll('[data-preset]').forEach(b => {
    b.onclick = () => { _sdSetPeriod(b.dataset.preset); _sdRender(); };
  });

  const cv = root.querySelector('#sd-chart');
  if (cv && data.dailyRevenue && data.dailyRevenue.length) {
    _sdDrawChart(cv, data.dailyRevenue);
  } else if (cv) {
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#888'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Нет данных за период', cv.width / 2, cv.height / 2);
  }
}

// Простой канвас-бар-чарт (без внешних либ — соответствует существующему стилю
// главного дашборда, который тоже использует канвас).
function _sdDrawChart(canvas, rows) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...rows.map(r => parseFloat(r.revenue) || 0), 1);
  const padL = 8, padR = 8, padB = 22, padT = 8;
  const innerW = w - padL - padR;
  const innerH = h - padB - padT;
  const barW = innerW / rows.length;
  rows.forEach((r, i) => {
    const val = parseFloat(r.revenue) || 0;
    const barH = (val / max) * innerH;
    const x = padL + i * barW;
    const y = h - padB - barH;
    ctx.fillStyle = '#19c39c';
    ctx.fillRect(x + 2, y, Math.max(2, barW - 4), barH);
    ctx.fillStyle = '#888';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const step = Math.ceil(rows.length / 14);
    if (rows.length <= 14 || i % step === 0) {
      ctx.fillText(String(r.d).slice(5), x + barW / 2, h - 5);
    }
  });
}
