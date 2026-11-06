// ── МОНИТОР РАССЫЛКИ ЧЕРЕЗ МЕССЕНДЖЕРЫ ─────────────────────────────────────────────────────
// Верх файла — чистые помощники (тестируются в vm, broadcasts-monitor.test.js); ниже — панель #bcMonitorOv.
// Глобальные имена только bc*/BC_*: файл делит одну область с остальными страницами.
// Зависимости: api(), esc(), notify(), bcOpenComposerWithList() (broadcasts.js).

const BC_MON_NAMES = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };
const BC_MON_POLL_MS = 5000;
const BC_MON_PAGE = 100;

const BC_MON_REASONS = {
  limit: 'лимит мессенджера',
  no_recipient: 'нет адресата',
  blacklist: 'чёрный список',
};

// Почему получатель ушёл дальше по каскаду / почему шаг не удался. Порядок ключей — порядок в карточке.
const BC_MON_WHY = {
  limit: 'лимит', not_registered: 'нет в мессенджере', rejected: 'отказ', unreachable: 'шлюз недоступен', ambiguous: 'неизвестно',
};

function bcMonName(ch) { return BC_MON_NAMES[ch] || String(ch || ''); }

// Время по Москве с секундами (окно рассылки и пауза считаются по Москве, браузер может быть в другом поясе).
function bcMonClock(ms) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
}

// Состояние шапки монитора + какие кнопки доступны. Ручная пауза главнее ночной.
function bcMonState(m) {
  if (!m) return { key: 'loading', text: '…', done: false, canPause: false, canResume: false, canCancel: false };
  const st = m.status;
  if (st === 'completed') return { key: 'completed', text: 'Завершена', done: true, canPause: false, canResume: false, canCancel: false };
  if (st === 'cancelled') return { key: 'cancelled', text: 'Отменена', done: true, canPause: false, canResume: false, canCancel: false };
  if (st === 'failed') return { key: 'failed', text: 'Ошибка', done: true, canPause: false, canResume: false, canCancel: false };
  const base = { done: false, canPause: false, canResume: false, canCancel: !m.cancelRequested };
  if (m.cancelRequested) return { ...base, key: 'cancelling', text: 'Отменяется…' };
  if (m.paused) {
    const gw = m.pauseReason === 'gateway_unreachable';
    return { ...base, key: gw ? 'paused_gateway' : 'paused', text: gw ? 'Пауза: шлюз недоступен' : 'Пауза', canResume: true };
  }
  if (st === 'pending') return { ...base, key: 'pending', text: 'В очереди', canPause: true };
  if (m.inWindow === false) return { ...base, key: 'night', text: 'Ночная пауза до 09:00', canPause: true };
  return { ...base, key: 'running', text: 'Идёт', canPause: true };
}

// Подпись состояния карточки мессенджера. nowMs передаём снаружи — обратный отсчёт тикает раз в секунду.
function bcChannelLabel(ch, nowMs) {
  const c = ch || {};
  if (c.state === 'disabled') return '⚪ выключен';
  if (c.state === 'limit') return `🔴 лимит ${c.sent || 0}/${c.limit == null ? '∞' : c.limit}`;
  if (c.state === 'paused') {
    if (c.pausedUntil == null) return '⏸ пауза';
    const left = Math.ceil((c.pausedUntil - nowMs) / 1000);
    if (left <= 0) return '🟢 отправляет';
    return `⏸ пауза до ${bcMonClock(c.pausedUntil)} · ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }
  return '🟢 отправляет';
}

// Статус строки получателя по-русски. Внутренние коды причин наружу не показываем.
function bcStatusText(r) {
  const x = r || {};
  switch (x.status) {
    case 'pending': return 'ждёт';
    case 'sending': return 'отправляется';
    case 'cancelled': return 'отменено';
    case 'sent':
      if (x.delivery_status === 'delivered') return 'доставлено';
      if (x.delivery_status === 'undeliverable') {
        // error — текст отказа мессенджера («Клиент не зарегистрирован в MAX»), не внутренний код
        const why = String(x.error || '').trim();
        return why ? `не доставлено: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : 'не доставлено';
      }
      if (x.delivery_status === 'unknown') return 'отправлено, доставка неизвестна';
      return 'отправлено';
    case 'skipped': {
      const why = BC_MON_REASONS[x.reason];
      return why ? `пропущен: ${why}` : 'пропущен';
    }
    case 'failed':
      if (x.reason === 'ambiguous_failure') return 'мессенджер не подтвердил — могло уйти';
      if (x.reason === 'all_rejected') return 'все мессенджеры отказали';
      return 'ошибка';
    default: return String(x.status || '');
  }
}

// Путь по каскаду: «Telegram: отказ → WhatsApp». Успешные отправки (ok:true) в путь не входят.
function bcCascadePath(log) {
  if (!Array.isArray(log)) return '';
  const WHY = BC_MON_WHY;
  const parts = [];
  for (const e of log) {
    if (!e || typeof e !== 'object') continue;
    if (e.from && e.to) parts.push(`${bcMonName(e.from)}: ${WHY[e.why] || 'отказ'} → ${bcMonName(e.to)}`);
    else if (e.skipped) parts.push(`${bcMonName(e.channel)}: ${WHY[e.skipped] || 'пропуск'}`);
    else if (e.ok === false) parts.push(`${bcMonName(e.channel)}: ${WHY[e.why] || 'ошибка'}`);
  }
  return parts.join(' · ');
}

// Строки карточки мессенджера. Числа сходятся: ушло = доставлено + не доставлено + проверяется +
// доставка неизвестна + ушедшие дальше из-за «нет в мессенджере» (они — в строке «перешли дальше»).
function bcChannelSummary(c) {
  const x = c || {}, bs = x.byStatus || {}, bd = x.byDelivery || {};
  const parts = [`ушло ${x.sent || 0}`, `доставлено ${bd.delivered || 0}`, `не доставлено ${bd.undeliverable || 0}`];
  if (bd.accepted > 0) parts.push(`проверяется ${bd.accepted}`);
  if (bd.unknown > 0) parts.push(`доставка неизвестна ${bd.unknown}`);
  parts.push(`ждут ${(bs.pending || 0) + (bs.sending || 0)}`, `отказ ${bs.failed || 0}`);
  let adv = '';
  if (x.advancedFrom > 0) {
    const by = x.advancedBy || {};
    const known = Object.keys(BC_MON_WHY);
    const reasons = Object.keys(by).filter((k) => by[k] > 0)
      .sort((a, b) => (known.indexOf(a) + 1 || 99) - (known.indexOf(b) + 1 || 99));
    const label = (k) => BC_MON_WHY[k] || 'другое';
    let tail = '';
    if (reasons.length === 1) tail = ` (${label(reasons[0])})`;
    else if (reasons.length > 1) tail = ` (${reasons.map((k) => `${label(k)} ${by[k]}`).join(' · ')})`;
    adv = `перешли дальше по каскаду: ${x.advancedFrom}${tail}`;
  }
  return { line: parts.join(' · '), adv };
}

// «Не получили сообщение»: пропущенные, ошибки, отменённые и не доставленные после приёма мессенджером.
function bcMonLost(m) {
  const bs = (m && m.byStatus) || {}, bd = (m && m.byDelivery) || {};
  return (bs.skipped || 0) + (bs.failed || 0) + (bs.cancelled || 0) + (bd.undeliverable || 0);
}

// ── Панель ────────────────────────────────────────────────────────────────────────────────

let _bcMonId = null;
let _bcMonGen = 0;            // поколение: запоздалый ответ закрытой/переоткрытой панели не рисуем
let _bcMonPoll = null;        // setInterval опроса /monitor
let _bcMonTick = null;        // setInterval обратного отсчёта
let _bcMonData = null;
let _bcMonOffset = 0;
let _bcMonSearchTimer = null;

function bcMonBox() { return document.getElementById('bcMonitorOv'); }

async function bcOpenMonitor(id) {
  bcStopMonitor();
  _bcMonId = id; _bcMonData = null; _bcMonOffset = 0;
  const gen = ++_bcMonGen;
  for (const k of ['bcMonStatus', 'bcMonProgress', 'bcMonCards', 'bcMonWaiting', 'bcMonRows', 'bcMonPager', 'bcMonSummary', 'bcMonText']) {
    const el = document.getElementById(k); if (el) el.innerHTML = '';
  }
  document.getElementById('bcMonStatusF').value = '';
  document.getElementById('bcMonChannelF').value = '';
  document.getElementById('bcMonQ').value = '';
  bcMonBox().classList.add('open');
  await bcMonRefresh(gen);
  if (gen !== _bcMonGen) return;
  _bcMonPoll = setInterval(() => { bcMonRefresh(gen); }, BC_MON_POLL_MS);
  _bcMonTick = setInterval(() => { if (gen === _bcMonGen) bcMonTickRender(); }, 1000);
}

// Останавливает опрос и «обнуляет» поколение: все ещё летящие ответы будут проигнорированы.
function bcStopMonitor() {
  _bcMonGen++;
  if (_bcMonPoll) { clearInterval(_bcMonPoll); _bcMonPoll = null; }
  if (_bcMonTick) { clearInterval(_bcMonTick); _bcMonTick = null; }
  if (_bcMonSearchTimer) { clearTimeout(_bcMonSearchTimer); _bcMonSearchTimer = null; }
  // Уход со страницы/выход из аккаунта: панель-оверлей не должна остаться висеть поверх другого экрана.
  const box = typeof document !== 'undefined' && document.getElementById ? document.getElementById('bcMonitorOv') : null;
  if (box) box.classList.remove('open');
}

function bcCloseMonitor() {
  bcStopMonitor();
  _bcMonId = null; _bcMonData = null;
  const box = bcMonBox(); if (box) box.classList.remove('open');
  if (typeof bcLoadHistory === 'function') bcLoadHistory();
}

async function bcMonRefresh(gen) {
  const id = _bcMonId;
  if (id == null) return;
  try {
    const m = await api('GET', `/api/broadcasts/${id}/monitor`);
    if (gen !== _bcMonGen) return;
    _bcMonData = m;
    bcMonRender(m);
    await bcMonLoadRecipients(gen);
    // Рассылка закончилась — опрашивать больше нечего (кнопки итога остаются).
    if (gen === _bcMonGen && bcMonState(m).done && _bcMonPoll) { clearInterval(_bcMonPoll); _bcMonPoll = null; }
  } catch (e) {
    if (gen !== _bcMonGen) return;
    const el = document.getElementById('bcMonStatus');
    if (el) el.textContent = 'Нет связи: ' + e.message;
  }
}

function bcMonRender(m) {
  const s = bcMonState(m);
  const done = (m.sent || 0) + (m.failed || 0) + (m.skipped || 0);
  const total = m.total || 0;
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
  document.getElementById('bcMonStatus').innerHTML = `<span class="bc-mon-badge bc-mon-${esc(s.key)}">${esc(s.text)}</span>`;
  document.getElementById('bcMonProgress').innerHTML =
    `<div class="bc-progress-bar"><i style="width:${pct}%"></i></div>` +
    `<div class="bc-mon-sub">${done} из ${total} · ушло ${m.sent || 0} · ошибок ${m.failed || 0} · пропущено ${m.skipped || 0}</div>`;
  const pause = document.getElementById('bcMonPause'), resume = document.getElementById('bcMonResume'), cancel = document.getElementById('bcMonCancel');
  pause.style.display = s.canPause ? '' : 'none';
  resume.style.display = s.canResume ? '' : 'none';
  cancel.style.display = (s.canCancel && !s.done) ? '' : 'none';
  document.getElementById('bcMonText').textContent = m.messageTemplate || '';

  const chs = m.channels || {};
  const keys = Object.keys(BC_MON_NAMES).filter((k) => chs[k]);
  document.getElementById('bcMonCards').innerHTML = keys.map((k) => {
    const c = chs[k];
    const sum = bcChannelSummary(c);
    return `<div class="bc-mon-card">
      <div class="bc-mon-card-h"><b>${esc(bcMonName(k))}</b><span id="bcMonSt-${k}">${esc(bcChannelLabel(c, Date.now()))}</span></div>
      <div class="bc-mon-sub">${esc(sum.line)}</div>
      ${sum.adv ? `<div class="bc-mon-sub">${esc(sum.adv)}</div>` : ''}
    </div>`;
  }).join('');

  const w = m.waiting || [];
  document.getElementById('bcMonWaiting').innerHTML = w.length
    ? w.map((r) => `<div class="bc-mon-wrow"><span>${esc(r.name || '—')}</span><span class="bc-mon-sub">${esc(r.phone || '')} · ${esc(bcMonName(r.channel))}</span></div>`).join('')
    : '<div class="bc-mon-sub">Очередь пуста</div>';

  const lost = bcMonLost(m);
  const sum = document.getElementById('bcMonSummary');
  sum.innerHTML = (s.done && lost > 0)
    ? `<div class="bc-mon-sub" style="margin-bottom:6px">Не получили сообщение: ${lost}</div><button class="btn btn-pri btn-sm" onclick="bcMonRetryDraft()">Новая рассылка по пропущенным</button>`
    : '';
}

// Раз в секунду обновляем только подписи состояний (без перерисовки карточек).
function bcMonTickRender() {
  if (!_bcMonData) return;
  const chs = _bcMonData.channels || {};
  for (const k of Object.keys(chs)) {
    const el = document.getElementById('bcMonSt-' + k);
    if (el) el.textContent = bcChannelLabel(chs[k], Date.now());
  }
}

async function bcMonLoadRecipients(gen) {
  const id = _bcMonId;
  if (id == null) return;
  const q = new URLSearchParams({ offset: String(_bcMonOffset), limit: String(BC_MON_PAGE) });
  const st = document.getElementById('bcMonStatusF').value, ch = document.getElementById('bcMonChannelF').value;
  const text = document.getElementById('bcMonQ').value.trim();
  if (st) q.set('status', st);
  if (ch) q.set('channel', ch);
  if (text) q.set('q', text);
  const d = await api('GET', `/api/broadcasts/${id}/recipients?${q}`);
  if (gen !== _bcMonGen) return;
  const rows = d.items || [];
  document.getElementById('bcMonRows').innerHTML = rows.length
    ? rows.map((r) => {
        const path = bcCascadePath(r.cascade_log);
        return `<tr><td>${esc(r.name || '—')}</td><td>${esc(r.phone || '')}</td><td>${esc(bcMonName(r.channel))}</td>` +
          `<td>${esc(bcStatusText(r))}${path ? `<div class="bc-mon-sub">${esc(path)}</div>` : ''}</td></tr>`;
      }).join('')
    : '<tr><td colspan="4" class="bc-mon-sub">Никого нет</td></tr>';
  const total = d.total || 0, from = total ? _bcMonOffset + 1 : 0, to = Math.min(total, _bcMonOffset + BC_MON_PAGE);
  document.getElementById('bcMonPager').innerHTML =
    `<button class="btn btn-sec btn-sm" ${_bcMonOffset <= 0 ? 'disabled' : ''} onclick="bcMonPage(-1)">←</button>` +
    `<span class="bc-mon-sub"> ${from}–${to} из ${total} </span>` +
    `<button class="btn btn-sec btn-sm" ${to >= total ? 'disabled' : ''} onclick="bcMonPage(1)">→</button>`;
}

function bcMonPage(dir) {
  _bcMonOffset = Math.max(0, _bcMonOffset + dir * BC_MON_PAGE);
  const gen = _bcMonGen;
  bcMonLoadRecipients(gen).catch((e) => notify('Ошибка: ' + e.message, 'err'));
}

// Смена фильтра/поиска — с первой страницы; поиск с дебаунсом.
function bcMonFilterChanged(delay) {
  _bcMonOffset = 0;
  if (_bcMonSearchTimer) clearTimeout(_bcMonSearchTimer);
  const gen = _bcMonGen;
  _bcMonSearchTimer = setTimeout(() => {
    bcMonLoadRecipients(gen).catch((e) => notify('Ошибка: ' + e.message, 'err'));
  }, delay || 0);
}

async function bcMonAction(action) {
  const id = _bcMonId;
  if (id == null) return;
  if (action === 'cancel' && !confirm('Отменить отправку оставшихся сообщений? Уже отправленные останутся доставленными.')) return;
  try {
    await api('POST', `/api/broadcasts/${id}/${action}`);
    await bcMonRefresh(_bcMonGen);
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
  }
}

async function bcMonRetryDraft() {
  const id = _bcMonId;
  if (id == null) return;
  try {
    const d = await api('POST', `/api/broadcasts/${id}/retry-draft`);
    bcCloseMonitor();
    bcOpenComposerWithList(d.list || []);
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
  }
}
