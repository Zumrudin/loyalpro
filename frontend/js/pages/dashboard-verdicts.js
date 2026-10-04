// ── ДАШБОРД: детализация вердиктов ИИ по перепискам ────────────────────────
// Спека: docs/superpowers/specs/2026-10-04-dialog-verdicts-design.md.
// Уровни: цифра в таблице → список контактов (под таблицей) → переписка за
// день (панель справа, на ≤700px — на весь экран). Состояние ТОЛЬКО в hash:
//   #dashboard/msg/<канал|all>/<статус>[/<ключ диалога>/<YYYY-MM-DD>]
// Клики пишут hash, а рисует всё vdSync() из обработчика hashchange (nav.js
// зовёт dashboardOnHashArg) — один путь и для клика, и для «Назад», и для F5.
// Файл подключён обычным <script>: глобальная область общая с dashboard.js,
// dashboard-messengers.js и chat.js (отсюда переиспользуется _chatMsgHtml).
// Зависимости: api(), esc(), notify(), dashRange, loadDashboard, _chatMsgHtml.

const VD_KEY_RE = /^[\w@.:+-]{1,120}$/;
const VD_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VD_POLL_MS = 5000;

function vdParseArg(arg) {
  if (!arg) return null;
  const p = String(arg).split('/');
  if (p[0] !== 'msg' || p.length < 3 || p.length === 4 || p.length > 5) return null;
  const channel = p[1] === 'all' ? '' : p[1];
  const status = p[2];
  if (!/^[a-z_]{1,32}$/.test(status) || !/^[\w-]{0,20}$/.test(channel)) return null;
  if (!MSG_VERDICT_COLS.some(c => c.code === status)) return null;
  const out = { channel, status, key: null, day: null };
  if (p.length === 5) {
    if (!VD_KEY_RE.test(p[3]) || !VD_DAY_RE.test(p[4])) return null;
    if (!Number.isFinite(Date.parse(p[4])) || new Date(p[4]).toISOString().slice(0, 10) !== p[4]) return null;
    out.key = p[3]; out.day = p[4];
  }
  return out;
}

function vdBuildHash(s) {
  if (!s) return 'dashboard';
  let h = 'dashboard/msg/' + (s.channel || 'all') + '/' + s.status;
  if (s.key && s.day) h += '/' + s.key + '/' + s.day;
  return h;
}

function vdStatusLabel(status, label) {
  const col = MSG_VERDICT_COLS.find(c => c.code === status);
  const base = col ? col.short : String(status || '');
  return status === 'other' && label ? base + ': ' + label : base;
}

function vdFmtDay(day) {
  const [, m, d] = String(day || '').split('-');
  return d && m ? d + '.' + m : String(day || '');
}

function vdFmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Чистое представление строки списка (уровень 1).
function vdRowView(r) {
  return {
    key: r.dialog_key, channel: r.channel || '', day: vdFmtDay(r.day), dayIso: r.day,
    title: r.name || r.phone || r.dialog_key,
    statusLabel: vdStatusLabel(r.status, r.label),
    note: r.note || '',
    badges: [{ text: 'уведомл.', on: !!r.notified }, { text: 'CRM', on: !!r.booked_crm }],
  };
}

// Строка состояния прогона под кнопкой.
function vdRunText(run) {
  if (!run) return 'анализ ещё не запускался';
  if (run.status === 'running') return 'идёт: ' + (run.analyzed || 0) + ' из ' + (run.requested || 0) + ' · с ' + vdFmtTime(run.started_at);
  if (run.status === 'error') return 'ошибка: ' + (run.error || 'неизвестно') + ' · ' + vdFmtTime(run.finished_at);
  let s = vdFmtTime(run.finished_at) + ' · ' + (run.analyzed || 0) + ' из ' + (run.requested || 0);
  if (run.failed) s += ' · сбой ' + run.failed;
  if (run.model) s += ' · ' + run.model;
  return s;
}

// ── DOM-часть (в node --test не вызывается) ──────────────────────────────
let _vdSyncReq = 0;
let _vdDialogReq = 0;
let _vdActive = false;
let _vdState = null;      // открытый уровень {channel,status,key,day} или null
let _vdListReq = 0;       // ответ устаревшего запроса списка игнорируется
let _vdPollTimer = null;

function vdCurrentArg() {
  const parts = (location.hash || '').slice(1).split('/');
  return parts[0] === 'dashboard' && parts.length > 1 ? parts.slice(1).join('/') : null;
}

// nav.js → hashchange на той же странице (клик по цифре, «Назад», ручная правка адреса).
function dashboardOnHashArg(arg) { vdSync(vdParseArg(arg)); }

// dashboard-messengers.js → после (пере)рисовки таблицы: F5, смена периода.
function vdAfterRender() {
  if (document.body.dataset.page !== 'dashboard') return;
  _vdActive = true;
  vdSync(vdParseArg(vdCurrentArg()), { force: true });
  vdRefreshRunStatus().catch(() => {});
  const tbody = document.getElementById('msgTbody');
  if (tbody && !tbody._vdBound) {
    tbody._vdBound = true;
    tbody.addEventListener('click', (e) => {
      const b = e.target.closest('.vd-cell');
      if (!b) return;
      location.hash = vdBuildHash({ channel: b.dataset.ch || '', status: b.dataset.st });
    });
  }
}

async function vdSync(target, opts) {
  const syncReq = ++_vdSyncReq;
  ++_vdDialogReq;
  const force = !!(opts && opts.force);
  const wrap = document.getElementById('vdWrap');
  if (!wrap) return;
  if (!target) {
    ++_vdListReq;
    _vdState = null;
    wrap.style.display = 'none';
    vdCloseDialogPane();
    return;
  }
  const sameList = _vdState && _vdState.channel === target.channel && _vdState.status === target.status;
  _vdState = target;
  wrap.style.display = '';
  if (!sameList || force) { vdCloseDialogPane(); await vdLoadList(target); }
  if (syncReq !== _vdSyncReq) return;
  if (target.key) {
    vdMarkActive(target.key, target.day);
    await vdLoadDialog(target);
  } else {
    vdCloseDialogPane();
  }
}

async function vdLoadList(s) {
  const list = document.getElementById('vdList');
  if (!list || !dashRange.from || !dashRange.to) return;
  const req = ++_vdListReq;
  list.innerHTML = '<div class="vd-more">Загрузка…</div>';
  const col = MSG_VERDICT_COLS.find(c => c.code === s.status);
  const chanName = s.channel ? ((MSG_CHANNEL_BADGE[s.channel] || {}).short || s.channel) : 'все каналы';
  try {
    const q = '?from=' + dashRange.from + '&to=' + dashRange.to + '&status=' + encodeURIComponent(s.status)
      + (s.channel ? '&channel=' + encodeURIComponent(s.channel) : '');
    const data = await api('GET', '/api/analytics/messengers/verdicts' + q);
    if (req !== _vdListReq) return;
    const rows = (data.rows || []).map(vdRowView);
    list.innerHTML = `
      <div class="vd-list-head"><span>${esc(col ? col.short : s.status)} · ${esc(chanName)} · ${rows.length}${data.truncated ? '+' : ''}</span>
        <button type="button" class="vd-close" title="Закрыть список" onclick="vdCloseList()">✕</button></div>
      <div class="vd-list-sub">${esc(col ? col.title : '')}. Клик по строке открывает переписку за этот день.</div>
      ${rows.length ? rows.map(vdRowHtml).join('') : '<div class="vd-more">Пусто за выбранный период</div>'}
      ${data.truncated ? '<div class="vd-more">Показаны первые ' + rows.length + ' — сузьте период</div>' : ''}`;
    if (_vdState && _vdState.key) vdMarkActive(_vdState.key, _vdState.day);
  } catch (e) {
    if (req !== _vdListReq) return;
    list.innerHTML = '<div class="vd-more">Не удалось загрузить: ' + esc(e && e.message) + '</div>';
  }
}

function vdRowHtml(v) {
  const b = (typeof msgBadge === 'function') ? msgBadge(v.channel) : { short: '?', cls: 'ch-all' };
  return `
    <div class="vd-row" data-key="${esc(v.key)}" data-day="${esc(v.dayIso)}" onclick="vdOpenRow(this)">
      <span class="ch ${esc(b.cls)}"><i>${esc(b.short)}</i></span>
      <div><div class="vd-name">${esc(v.title)}</div><div class="vd-note">${esc(v.statusLabel)}${v.note ? ' — ' + esc(v.note) : ''}</div></div>
      <div class="vd-badges"><span class="vd-day">${esc(v.day)}</span>${v.badges.map(x => `<span class="vd-b${x.on ? ' on' : ''}">${esc(x.text)}</span>`).join('')}</div>
    </div>`;
}

function vdOpenRow(el) {
  if (!_vdState) return;
  location.hash = vdBuildHash({ channel: _vdState.channel, status: _vdState.status, key: el.dataset.key, day: el.dataset.day });
}

function vdMarkActive(key, day) {
  document.querySelectorAll('#vdList .vd-row').forEach(r =>
    r.classList.toggle('active', r.dataset.key === key && r.dataset.day === day));
}

function vdCloseList() { location.hash = 'dashboard'; }
function vdCloseDialog() { if (_vdState) location.hash = vdBuildHash({ channel: _vdState.channel, status: _vdState.status }); }

function vdCloseDialogPane() {
  ++_vdDialogReq;
  const panel = document.getElementById('vdPanel'), wrap = document.getElementById('vdWrap');
  if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
  if (wrap) wrap.classList.add('vd-no-dialog');
  document.body.classList.remove('vd-dialog-open');
  vdMarkActive(null, null);
}

function vdMskDay(ts) {
  return new Date(Number(ts) * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
}

async function vdLoadDialog(s) {
  const req = ++_vdDialogReq;
  const panel = document.getElementById('vdPanel'), wrap = document.getElementById('vdWrap');
  if (!panel) return;
  wrap.classList.remove('vd-no-dialog');
  panel.style.display = '';
  document.body.classList.add('vd-dialog-open');
  panel.innerHTML = '<div class="vd-more">Загрузка переписки…</div>';
  try {
    const data = await api('GET', '/api/chat/dialogs/' + encodeURIComponent(s.key) + '/messages');
    if (req !== _vdDialogReq || !_vdState || _vdState.key !== s.key || _vdState.day !== s.day) return;
    const row = [...document.querySelectorAll('#vdList .vd-row')].find(r => r.dataset.key === s.key && r.dataset.day === s.day);
    const title = row ? row.querySelector('.vd-name').textContent : s.key;
    const sub = row ? row.querySelector('.vd-note').textContent : '';
    const msgs = (data.messages || []).filter(m => m.msg_ts && vdMskDay(m.msg_ts) <= s.day);
    const canRender = typeof _chatMsgHtml === 'function';
    let html = '', lastDay = null;
    for (const m of msgs) {
      const d = vdMskDay(m.msg_ts);
      if (d !== lastDay) { html += `<div class="vd-sep">${esc(vdFmtDay(d))}${d === s.day ? ' — этот день' : ''}</div>`; lastDay = d; }
      let one = canRender ? _chatMsgHtml(m, false) : `<div class="chat-msg chat-msg-${m.direction === 'outgoing' ? 'out' : 'in'}"><div class="chat-bubble">${esc(m.text || '')}</div></div>`;
      if (d !== s.day) one = one.replace('class="chat-msg ', 'class="chat-msg vd-dim ');
      html += one;
    }
    panel.innerHTML = `
      <div class="vd-panel-head">
        <div><div class="vd-ttl">${esc(title)} · ${esc(vdFmtDay(s.day))}</div><div class="vd-st">${esc(sub)}</div></div>
        <button type="button" class="vd-close" title="Закрыть переписку" onclick="vdCloseDialog()">✕</button>
      </div>
      <div class="vd-msgs" id="vdMsgs">${html || '<div class="vd-more">Сообщений нет</div>'}</div>
      <div class="vd-panel-foot"><a href="#chat/${encodeURIComponent(s.key)}">Открыть в Чате →</a></div>`;
    const box = document.getElementById('vdMsgs');
    if (box) box.scrollTop = box.scrollHeight;
  } catch (e) {
    if (req !== _vdDialogReq) return;
    panel.innerHTML = '<div class="vd-panel-head"><div class="vd-ttl">Переписка</div><button type="button" class="vd-close" onclick="vdCloseDialog()">✕</button></div>'
      + '<div class="vd-more">Не удалось загрузить: ' + esc(e && e.message) + '</div>';
  }
}

// ── Кнопка «Проанализировать» ────────────────────────────────────────────
function vdStop() {
  _vdActive = false;
  clearTimeout(_vdPollTimer);
  ++_vdListReq; ++_vdSyncReq;
  _vdState = null;
  vdCloseDialogPane();
}

async function vdRefreshRunStatus() {
  const el = document.getElementById('vdRunSt');
  if (!el) return null;
  const r = await api('GET', '/api/analytics/messengers/verdicts/runs?limit=1');
  if (!_vdActive) return null;
  const run = r && r.runs && r.runs[0];
  el.textContent = vdRunText(run);
  const btn = document.getElementById('vdRunBtn');
  if (btn) btn.disabled = !!(run && run.status === 'running');
  if (run && run.status === 'running') vdPoll();
  return run;
}

function vdPoll() {
  if (!_vdActive) return;
  clearTimeout(_vdPollTimer);
  _vdPollTimer = setTimeout(async () => {
    try {
      const run = await vdRefreshRunStatus();
      if (_vdActive && (!run || run.status !== 'running')) {
        if (typeof loadDashboard === 'function') loadDashboard();   // перечитать таблицу с новыми вердиктами
      }
    } catch (_) { vdPoll(); }
  }, VD_POLL_MS);
}

async function vdRunClick() {
  const btn = document.getElementById('vdRunBtn');
  const rec = document.getElementById('vdRecompute');
  if (!dashRange.from || !dashRange.to) return;
  if (btn) btn.disabled = true;
  try {
    await api('POST', '/api/analytics/messengers/verdicts/run',
      { from: dashRange.from, to: dashRange.to, recompute: !!(rec && rec.checked) });
    notify('Анализ запущен', 'ok');
    await vdRefreshRunStatus();
  } catch (e) {
    notify('Анализ: ' + e.message, 'err');
    if (btn) btn.disabled = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { vdParseArg, vdBuildHash, vdRunText, vdRowView, vdStatusLabel };
}
