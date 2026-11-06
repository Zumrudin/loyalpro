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

async function loadWorkday() {
  const req = ++_wdReq;
  const today = wdTodayMsk();
  const dateEl = document.getElementById('wdDate');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('ru', { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long' });
  ['wdRecords', 'wdDialogs', 'wdCerts'].forEach(id => _wdBox(id, '<div class="empty">Загрузка…</div>'));
  ['wdTotal', 'wdCame', 'wdExpected', 'wdLost', 'wdEscN', 'wdCertN'].forEach(id => _wdBox(id, '—'));

  const recP = api('GET', '/api/records?' + new URLSearchParams({ dateFrom: today, dateTo: today, limit: 200 }))
    .then(d => {
      if (req !== _wdReq) return;
      const views = (d.records || []).map(wdRecordView).filter(v => v.bucket !== 'deleted').sort((a, b) => a.ts - b.ts);
      const s = wdSummarize(views);
      _wdBox('wdTotal', String(s.total)); _wdBox('wdCame', String(s.came));
      _wdBox('wdExpected', String(s.expected)); _wdBox('wdLost', String(s.lost));
      _wdBox('wdRecords', views.length ? views.map(v => `
        <div class="wd-row wd-${v.bucket}">
          <div class="wd-time">${esc(v.time || '—')}</div>
          <div class="wd-main"><div class="wd-name">${esc(v.client)}</div><div class="wd-sub">${esc(v.services)} · ${esc(v.staff)}</div></div>
          <span class="badge wd-badge wd-badge-${v.bucket}">${esc(v.label)}${v.paid ? ' ✓' : ''}</span>
        </div>`).join('') : '<div class="empty">На сегодня записей нет</div>');
    }).catch(e => { if (req === _wdReq) _wdBox('wdRecords', _wdErr(e)); });

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

  await Promise.all([recP, dlgP, certP]);
}

// Клики по строкам: диалог → чат (тот же путь, что «Забота» → чат), заявка → «Справки».
if (typeof document !== 'undefined') {
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

if (typeof module !== 'undefined') module.exports = { wdTodayMsk, wdRecordView, wdSummarize, wdEscalated, wdReasonText, wdFmtAgo };
