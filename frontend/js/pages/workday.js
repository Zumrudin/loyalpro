// ── РАБОЧИЙ ДЕНЬ: главная администратора (Ivory & Brass, этап 4) ────────────
// План: docs/superpowers/plans/2026-10-24-ivory-brass-dev-plan.md, «Администратор».
// Первая версия намеренно собрана ТОЛЬКО из существующих ручек и их правил —
// своих счётчиков и SQL нет:
//   • записи на сегодня     — GET /api/records (тот же фильтр по московской дате,
//                             что у страницы «Записи»; статус — то же правило:
//                             «пришёл» + оплачен = «оказана»);
//   • ждут человека         — GET /api/chat/dialogs, agentStatus === 'escalated'
//                             (эскалация Милы и пауза «ответил оператор»);
//   • новые заявки справок  — GET /api/medical-cert/requests?status=new.
// Блоки грузятся независимо: сбой одного не гасит остальные (своя подпись ошибки).
// Файл подключён обычным <script> — общая глобальная область, префикс имён wd.

const WD_STATUS_LABEL = {
  completed: 'Оказана', arrived: 'Пришёл', confirmed: 'Подтверждена',
  waiting: 'Ожидание', pending: 'Ожидание', cancelled: 'Отменена',
  no_show: 'Не пришёл', deleted: 'Удалена',
};
// Корзины сводки: пришли (визит идёт или оказан), ждём, отменились/не пришли.
const WD_BUCKET = {
  completed: 'came', arrived: 'came',
  confirmed: 'expected', waiting: 'expected', pending: 'expected',
  cancelled: 'lost', no_show: 'lost', deleted: 'deleted',
};

let _wdReq = 0;

// Сегодня по Москве, YYYY-MM-DD (не по часам устройства).
function wdTodayMsk(now) {
  const d = now instanceof Date ? now : new Date();
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
}

function _wdList(v) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []);
}

// Строка записи → представление. Правило статуса — как на странице «Записи».
function wdRecordView(r) {
  const raw = r.yclients_status || r.status || 'pending';
  const status = raw === 'arrived' && r.is_paid_full ? 'completed' : raw;
  let time = '', ts = Infinity;
  if (r.visit_datetime) {
    const dt = new Date(r.visit_datetime);
    if (!isNaN(dt)) {
      ts = dt.getTime();
      time = dt.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    }
  }
  const names = (arr, f) => _wdList(arr).map(f).filter(Boolean).join(', ');
  return {
    id: r.id, ts, time,
    client: r.client_name || '—', phone: r.client_phone || '',
    services: names(r.services, s => s && (s.title || s.name || (typeof s === 'string' ? s : ''))) || '—',
    staff: names(r.staff, s => s && (s.name || (typeof s === 'string' ? s : ''))) || '—',
    status, label: WD_STATUS_LABEL[status] || status,
    bucket: WD_BUCKET[status] || 'expected',
    paid: !!r.is_paid_full,
  };
}

// Сводка дня. Удалённые записи не считаются нигде (их нет в расписании).
function wdSummarize(views) {
  const out = { total: 0, came: 0, expected: 0, lost: 0 };
  for (const v of views) {
    if (v.bucket === 'deleted') continue;
    out.total++;
    out[v.bucket] = (out[v.bucket] || 0) + 1;
  }
  return out;
}

// Диалоги, которые сейчас ведёт человек: свежие сверху (порядок ручки).
function wdEscalated(dialogs) {
  return (Array.isArray(dialogs) ? dialogs : [])
    .filter(d => d && d.agentStatus === 'escalated' && !d.isGroup);
}

const WD_REASON = {
  operator_reply: 'администратор ответил сам',
  window_closed: 'окно Милы закрылось',
  low_rating: 'низкая оценка визита',
};
function wdReasonText(reason) {
  if (!reason) return 'передан администратору';
  return WD_REASON[reason] || String(reason).slice(0, 80);
}

function wdFmtAgo(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round(((now ? now.getTime() : Date.now()) - t) / 60000));
  if (min < 1) return 'только что';
  if (min < 60) return min + ' мин назад';
  const h = Math.round(min / 60);
  if (h < 24) return h + ' ч назад';
  return Math.round(h / 24) + ' дн назад';
}

// ── рендер ──
function _wdBox(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function _wdErr(e) { return `<div class="empty">Не удалось загрузить: ${esc((e && e.message) || 'ошибка')}</div>`; }

function wdCanOpenCare() {
  return typeof ME !== 'undefined' && ['owner', 'admin'].includes(ME?.role);
}
function wdGuardCare(e) {
  if (wdCanOpenCare() || !e.target?.closest?.('#wdCareCard')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

async function loadWorkday() {
  const care = document.getElementById('wdCareCard');
  if (care) care.style.display = wdCanOpenCare() ? '' : 'none';
  const req = ++_wdReq;
  const today = wdTodayMsk();
  wdEnsureFolders();
  const foldersP = wdLoadFolders();
  const dateEl = document.getElementById('wdDate');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('ru', { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long' });
  ['wdDialogs', 'wdCerts'].forEach(id => _wdBox(id, '<div class="empty">Загрузка…</div>'));
  ['wdTotal', 'wdCame', 'wdExpected', 'wdLost', 'wdEscN', 'wdCertN'].forEach(id => _wdBox(id, '—'));

  const recP = api('GET', '/api/records?' + new URLSearchParams({ dateFrom: today, dateTo: today, limit: 200 }))
    .then(d => {
      if (req !== _wdReq) return;
      const views = (d.records || []).map(wdRecordView).filter(v => v.bucket !== 'deleted').sort((a, b) => a.ts - b.ts);
      const s = wdSummarize(views);
      _wdBox('wdTotal', String(s.total)); _wdBox('wdCame', String(s.came));
      _wdBox('wdExpected', String(s.expected)); _wdBox('wdLost', String(s.lost));
    }).catch(() => {
      if (req === _wdReq) ['wdTotal', 'wdCame', 'wdExpected', 'wdLost'].forEach(id => _wdBox(id, '—'));
    });

  const dlgP = api('GET', '/api/chat/dialogs')
    .then(d => {
      if (req !== _wdReq) return;
      const list = wdEscalated(d.dialogs);
      _wdBox('wdEscN', String(list.length));
      _wdBox('wdDialogs', list.length ? list.slice(0, 12).map(x => `
        <div class="wd-row wd-click" tabindex="0" role="link" data-key="${esc(x.key)}">
          <div class="wd-main"><div class="wd-name">${esc((x.client && x.client.name) || x.senderName || x.phone || x.key)}</div>
            <div class="wd-sub">${esc(wdReasonText(x.escalatedReason))} · ${esc(wdFmtAgo(x.lastTs))}</div></div>
          <span class="wd-go">Открыть ›</span>
        </div>`).join('') : '<div class="empty">Все диалоги ведёт Мила — передач нет</div>');
    }).catch(e => { if (req === _wdReq) { _wdBox('wdEscN', '—'); _wdBox('wdDialogs', _wdErr(e)); } });

  const certP = api('GET', '/api/medical-cert/requests?status=new')
    .then(d => {
      if (req !== _wdReq) return;
      const items = d.items || [];
      _wdBox('wdCertN', String(items.length));
      _wdBox('wdCerts', items.length ? items.slice(0, 8).map(x => `
        <div class="wd-row wd-click" tabindex="0" role="link" data-cert="1">
          <div class="wd-main"><div class="wd-name">${esc([x.payer_last, x.payer_first].filter(Boolean).join(' ') || 'Заявка')}</div>
            <div class="wd-sub">справка за ${esc(x.report_year || '')} · ${esc(wdFmtAgo(x.created_at))}</div></div>
          <span class="wd-go">Открыть ›</span>
        </div>`).join('') : '<div class="empty">Новых заявок нет</div>');
    }).catch(e => { if (req === _wdReq) { _wdBox('wdCertN', '—'); _wdBox('wdCerts', _wdErr(e)); } });

  await Promise.all([recP, dlgP, certP, foldersP]);
}

// Клики по строкам: диалог → чат (тот же путь, что «Забота» → чат), заявка → «Справки».
if (typeof document !== 'undefined') {
  document.addEventListener('click', wdGuardCare, true);
  document.addEventListener('click', e => wdOnActivate(e));
  document.addEventListener('keydown', e => { if (e.key === 'Enter') wdOnActivate(e); });
}
function wdOnActivate(e) {
  const row = e.target && e.target.closest && e.target.closest('#page-workday .wd-click');
  if (!row) return;
  if (row.dataset.key) {
    window._deepLinkArg = row.dataset.key;
    location.hash = '#chat/' + encodeURIComponent(row.dataset.key);
    navTo('chat');
  } else if (row.dataset.cert) {
    navTo('cert-requests', { reset: true });
  }
}

if (typeof module !== 'undefined') module.exports = { wdTodayMsk, wdRecordView, wdSummarize, wdEscalated, wdReasonText, wdFmtAgo, wdTomorrowMsk, wdFolderItems, wdFolderListHtml };


// Folder preparation is independent of the records summary, including errors.
let _wdFolderReq = 0;
function wdTomorrowMsk(now) {
  const day = wdTodayMsk(now);
  return new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
}
function wdFolderItems(items) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const clientId = Number(item.clientId);
    const outboxId = Number(item.outboxId);
    const key = Number.isSafeInteger(clientId) && clientId > 0 ? 'client:' + clientId
      : (typeof item.key === 'string' && item.key ? item.key
        : (Number.isSafeInteger(outboxId) && outboxId > 0 ? 'outbox:' + outboxId : null));
    if (key && !unique.has(key)) unique.set(key, item);
  }
  const number = item => Number(item.number) > 0 ? Number(item.number) : Infinity;
  return [...unique.values()].sort((a, b) => (number(a) - number(b)) || String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
}
function wdEnsureFolders() {
  const page = document.getElementById('page-workday');
  if (!page || document.getElementById('wdFolders')) return;
  const panel = document.createElement('section');
  panel.className = 'card mb pf-day';
  panel.id = 'wdFolders';
  panel.innerHTML = `<div class="ct">Номер папки пациента</div>
    <div class="pf-toolbar"><label for="wdFolderDate">Дата приёма</label> <input type="date" id="wdFolderDate" value="${wdTomorrowMsk()}">
    <button type="button" class="btn btn-sec btn-sm" id="wdFolderReload">Обновить</button></div>
    <div class="wd-sub">По умолчанию — завтра. Отметка «Пакет создан» означает, что бумажные документы уже находятся в папке.</div>
    <div id="wdFolderCounts" class="wd-sub"></div><div id="wdFolderList"></div>`;
  const slot = document.getElementById('wdFolderSlot') || document.getElementById('wdRecords')?.closest('.card');
  if (slot) slot.replaceWith(panel);
  else page.appendChild(panel);
  document.getElementById('wdFolderDate').addEventListener('change', wdLoadFolders);
  document.getElementById('wdFolderReload').addEventListener('click', wdLoadFolders);
  panel.addEventListener('change', e => {
    const checkbox = e.target.closest('[data-folder-prepared], [data-folder-outbox]');
    if (checkbox) wdSetFolderPrepared(checkbox);
  });
}
function wdFolderListHtml(items) {
  return items.length ? items.map(item => {
    const id = Number(item.clientId);
    const outboxId = Number(item.outboxId);
    const binding = id > 0 ? 'data-folder-prepared="' + id + '"' : 'data-folder-outbox="' + outboxId + '"';
    const number = Number(item.number) > 0 ? '№ ' + Number(item.number) : 'Номер не назначен';
    return `<div class="wd-row pf-row"><div class="wd-time pf-number">${esc(number)}</div>
      <div class="wd-main"><div class="wd-name">${esc(item.name || 'Пациент')}${item.archived ? ' · Архив' : ''}</div>
      <div class="wd-sub">${esc(item.time || '')} · ${esc(item.task || (item.archived ? 'Новый договор и пакет документов' : (!item.prepared ? 'Создать пакет документов' : 'Взять папку к приёму')))}</div></div>
      <label class="pf-prepared"><input type="checkbox" ${binding} ${item.prepared ? 'checked' : ''} ${!item.number ? 'disabled' : ''}> Пакет создан</label></div>`;
  }).join('') : '<div class="empty">На выбранную дату пациентов нет</div>';
}
async function wdLoadFolders() {
  const dateEl = document.getElementById('wdFolderDate');
  if (!dateEl) return;
  const date = dateEl.value;
  const req = ++_wdFolderReq;
  _wdBox('wdFolderCounts', '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { _wdBox('wdFolderList', '<div class="empty">Выберите дату приёма</div>'); return; }
  _wdBox('wdFolderList', '<div class="empty">Загрузка…</div>');
  try {
    const data = await api('GET', '/api/paper-folders/day?date=' + encodeURIComponent(date));
    if (req !== _wdFolderReq) return;
    const items = wdFolderItems(data.items);
    const needsNumber = items.filter(item => item.needsNumber).length;
    const refreshed = data.updatedAt && Number.isFinite(Date.parse(data.updatedAt))
      ? ' · Обновлено: ' + new Date(data.updatedAt).toLocaleString('ru', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) + ' МСК' : '';
    _wdBox('wdFolderCounts', `Пациентов: ${items.length} · Пакет создан: ${items.filter(item => item.prepared).length} · Без номера: ${needsNumber} · Занято: ${Number(data.occupied) || 0} из 2000 · Свободно: ${Number(data.free) || 0}${esc(refreshed)}`);
    _wdBox('wdFolderList', wdFolderListHtml(items));
  } catch (e) { if (req === _wdFolderReq) _wdBox('wdFolderList', _wdErr(e)); }
}
async function wdSetFolderPrepared(checkbox) {
  const prepared = checkbox.checked;
  if (!prepared && !confirm('Документы вынуты из папки? Снять отметку «Пакет создан»?')) { checkbox.checked = true; return; }
  checkbox.disabled = true;
  try {
    const url = checkbox.dataset.folderOutbox
      ? '/api/paper-folders/outbox/' + Number(checkbox.dataset.folderOutbox)
      : '/api/clients/' + Number(checkbox.dataset.folderPrepared) + '/paper-folder';
    await api('PATCH', url, { prepared });
    await wdLoadFolders();
  } catch (e) { checkbox.checked = !prepared; notify(e.message, 'err'); }
  finally { checkbox.disabled = false; }
}
