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
function _sdDaysAgo(n) {
  const d = new Date(_sdToday() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (n - 1));
  return d.toISOString().slice(0, 10);
}
function _sdSetPeriod(preset) {
  _sdState.preset = preset;
  _sdState.to = _sdToday();
  if (preset === 'today') _sdState.from = _sdState.to;
  else if (preset === 'week') _sdState.from = _sdDaysAgo(7);
  else if (preset === 'month') _sdState.from = _sdDaysAgo(30);
}
const _sdEsc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _sdFmtRub = (n) => Math.round(parseFloat(n || 0)).toLocaleString('ru');

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
        <div class="sv">₽ ${_sdFmtRub(s.periodRevenue)}</div>
        <div style="margin-top:10px;border-top:1px solid var(--bd);padding-top:10px;font-size:13px;line-height:1.7">
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t3)">Услуги</span><b>₽ ${_sdFmtRub(r.services)}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t3)">Косметика</span><b>₽ ${_sdFmtRub(r.goods)}</b></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--t3)">Абонементы</span><b>₽ ${_sdFmtRub(r.abonement)}</b></div>
        </div>
      </div>
      <div class="sc"><div class="sl">Визитов проведено</div><div class="sv">${s.periodRecords}</div></div>
      <div class="sc"><div class="sl">Не пришли</div><div class="sv">${s.noShowClients}</div></div>
      <div class="sc"><div class="sl">Средний чек</div><div class="sv">₽ ${_sdFmtRub(s.avgCheck)}</div></div>
      <div class="sc"><div class="sl">Первичных за период</div><div class="sv">${s.newClients}</div></div>
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
