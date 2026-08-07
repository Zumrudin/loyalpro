// ── «ЗАБОТА» (отдел заботы: программы касаний + дашборд клиентов) ──
// Вкладка «Программы»: CRUD care_programs (условия по мастеру/категории/услуге,
// цепочка касаний Т+N). Вкладка «Клиенты»: прохождения (care_enrollments) с
// журналом касаний. Зависимости: api(), esc(), notify(), navTo().

const CARE_COND_LABELS = { staff: 'Специалист', category: 'Категория', service: 'Услуга' };

// Статусы прохождений (enrollments)
const CARE_ENR_ST = {
  active:     { lbl: 'Активно',     cls: 'care-st-active' },
  completed:  { lbl: 'Завершено',   cls: 'care-st-completed' },
  escalated:  { lbl: 'Эскалация',   cls: 'care-st-escalated' },
  declined:   { lbl: 'Отказался',   cls: 'care-st-declined' },
  stopped:    { lbl: 'Остановлено', cls: 'care-st-stopped' },
  superseded: { lbl: 'Перекрыто',   cls: 'care-st-superseded' },
};

// Статусы отправок в журнале касаний
const CARE_SEND_ST = {
  scheduled: { lbl: 'Запланировано', color: '#9ca3af' },
  sent:      { lbl: 'Отправлено',    color: '#10b981' },
  skipped:   { lbl: 'Пропущено',     color: '#f59e0b' },
  cancelled: { lbl: 'Отменено',      color: '#9ca3af' },
  failed:    { lbl: 'Ошибка',        color: '#ef4444' },
};

let _careDicts = null;      // { staff, categories, services } — словарь как у автоуведомлений
let _carePrograms = [];
let _careEnr = [];
let _careEnrOpenId = null;  // раскрытая строка дашборда

// состояние редактора программы
let _careEditId = null;
// условия зачисления живут в общем модуле conditions-editor.js (ns 'care')
let _careTouches = [];      // [{ id?, title, delayDays, sendTime, intentText, textMode }]

// состояние превью («сухой прогон»)
let _carePreviewFor = null; // { programId } | { draft: true } — что именно проверяем

// ── вкладки ────────────────────────────────────────────────────

const CARE_TABS = ['programs', 'clients', 'reminders', 'reminders-history'];

function loadCarePage() {
  careSwitchTab('programs');
  careLoadPrograms();
  careLoadEnrollments();
}

function careSwitchTab(tab) {
  for (const t of CARE_TABS) {
    const pane = document.getElementById(`careTab-${t}`);
    const btn = document.getElementById(`careTabBtn-${t}`);
    if (pane) pane.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  }
  // Вкладки напоминаний грузятся лениво: их данные не нужны тому, кто зашёл
  // за программами заботы, а история может быть большой.
  if (tab === 'reminders') remLoadRules();
  if (tab === 'reminders-history') remLoadHistory();
}

// ── словарь условий (общий эндпоинт с автоуведомлениями) ───────

async function careEnsureDicts() {
  if (_careDicts) return;
  _careDicts = await api('GET', '/api/notification-rules/dictionaries');
  condInit('care', _careDicts);
}

function careDictName(type, id) {
  if (!_careDicts) return String(id);
  const list = type === 'staff' ? _careDicts.staff : type === 'category' ? _careDicts.categories : _careDicts.services;
  const hit = (list || []).find(x => String(x.id) === String(id));
  return hit ? (hit.title || hit.name || String(id)) : String(id);
}

function careCondSummary(conditions) {
  const items = (conditions && conditions.items) || [];
  if (!items.length) return 'Любой состоявшийся визит';
  const logic = conditions.logic === 'or' ? ' ИЛИ ' : ' И ';
  return items.map(it => {
    const names = (it.ids || []).slice(0, 3).map(id => careDictName(it.type, id));
    const more = it.ids.length > 3 ? ` +${it.ids.length - 3}` : '';
    return `${CARE_COND_LABELS[it.type] || it.type}: ${names.join(', ')}${more}`;
  }).join(logic);
}

// ── вкладка «Программы» ────────────────────────────────────────

async function careLoadPrograms() {
  const wrap = document.getElementById('carePrograms');
  wrap.className = 'empty';
  wrap.innerHTML = 'Загрузка…';
  try {
    const [d] = await Promise.all([api('GET', '/api/care/programs'), careEnsureDicts()]);
    _carePrograms = d.programs || [];
    careRenderPrograms();
  } catch (e) {
    wrap.innerHTML = `<span style="color:var(--danger)">Ошибка: ${esc(e.message)}</span>`;
  }
}

function careRenderPrograms() {
  const wrap = document.getElementById('carePrograms');
  if (!_carePrograms.length) {
    wrap.className = 'empty';
    wrap.innerHTML = 'Пока нет программ. Нажмите «+ Новая программа», чтобы настроить первую цепочку заботы.';
    return;
  }
  wrap.className = '';
  wrap.innerHTML = _carePrograms.map(p => {
    const touches = (p.touches || []).map(t =>
      `<span class="care-tbadge" title="${esc(t.title || '')} · в ${esc(t.sendTime || '')}">Т+${t.delayDays}</span>`).join('');
    const stats = [];
    stats.push(`<span style="color:var(--a)">в работе: ${+p.active_count || 0}</span>`);
    stats.push(`<span style="color:#10b981">✓ ${+p.sent_count || 0}</span>`);
    return `
      <div class="bc-row" data-id="${p.id}">
        <div class="bc-row-grid">
          <div class="bc-row-left">
            <div class="bc-row-meta" style="display:flex;align-items:center;gap:10px">
              <label class="tgl"><input type="checkbox" ${p.is_enabled ? 'checked' : ''}
                onchange="careToggleProgram(${p.id})"><span class="ts"></span></label>
              <b style="font-size:13.5px;color:var(--t1)">${esc(p.title)}</b>
            </div>
            <div class="bc-row-filters" style="margin-top:6px">${esc(careCondSummary(p.conditions))}</div>
            <div class="care-tbadge-row">${touches || '<span style="font-size:11.5px;color:var(--t3)">нет касаний</span>'}</div>
          </div>
          <div class="bc-row-right">
            <div class="bc-progress-lbl">Клиенты / отправки</div>
            <div class="bc-progress-val" style="font-size:12.5px">${stats.join(' · ')}</div>
            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;justify-content:flex-end">
              <button class="btn btn-sec btn-sm" onclick="careOpenPreview(${p.id})" title="Кто попал бы в программу за последние N дней">👁 Выборка</button>
              <button class="btn btn-sec btn-sm" onclick="careOpenProgramModal(${p.id})">Изменить</button>
              <button class="btn btn-sec btn-sm" onclick="careDeleteProgram(${p.id})">🗑</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function careToggleProgram(id) {
  try {
    const d = await api('POST', `/api/care/programs/${id}/toggle`);
    const i = _carePrograms.findIndex(p => p.id === id);
    if (i >= 0) _carePrograms[i].is_enabled = d.isEnabled;
    notify(d.isEnabled ? 'Программа включена' : 'Программа выключена', 'ok');
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
    careRenderPrograms();
  }
}

async function careDeleteProgram(id) {
  if (!confirm('Удалить программу? Удалит и историю прохождений клиентов.')) return;
  try {
    await api('DELETE', `/api/care/programs/${id}`);
    notify('Программа удалена', 'ok');
    await careLoadPrograms();
    careLoadEnrollments();
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
  }
}

// ── редактор программы ─────────────────────────────────────────

async function careOpenProgramModal(id) {
  try { await careEnsureDicts(); }
  catch (e) { notify('Ошибка справочников: ' + e.message, 'err'); return; }
  _careEditId = id || null;
  const p = id ? _carePrograms.find(x => x.id === id) : null;
  document.getElementById('careEditorTitle').textContent = p ? 'Программа: ' + p.title : 'Новая программа';
  document.getElementById('careTitle').value = p ? p.title : '';

  condSet('care', (p && p.conditions) || { logic: 'and', items: [] });
  _careTouches = p
    ? (p.touches || []).map(t => ({
        id: t.id, title: t.title || '', delayDays: t.delayDays,
        sendTime: t.sendTime || '10:30', intentText: t.intentText || '',
        textMode: t.textMode === 'strict' ? 'strict' : 'free',
      }))
    : [{ title: '', delayDays: 1, sendTime: '10:30', intentText: '', textMode: 'free' }];

  careRenderTouches();
  document.getElementById('careSaveBtn').disabled = false;
  document.getElementById('careEditorOv').classList.add('open');
}

function careCloseEditor() {
  document.getElementById('careEditorOv').classList.remove('open');
}

// — конструктор условий: общий модуль conditions-editor.js —
// Остались ТОЛЬКО те careXxx, которые реально зовёт статичная разметка
// index.html. Остальные обёртки (careRemoveCond/careCondType/careCondFilter/
// careCondToggleId/careRenderConds/careRenderCondList) удалены как мёртвые:
// разметку строк условий генерирует сам модуль и зовёт в ней обобщённые
// cond*('care', …), а не care-обёртки. Держать пустые обёртки «на всякий
// случай» вреднее, чем не держать: они создают ложное впечатление, что имена
// откуда-то вызываются, и переживают следующую правку разметки незамеченными.

function careSetLogic(logic) { condSetLogic('care', logic); }
function careAddCond()       { condAdd('care'); }

// — конструктор цепочки касаний —

function careAddTouch() {
  const last = _careTouches[_careTouches.length - 1];
  _careTouches.push({
    title: '', delayDays: last ? Math.min(730, (+last.delayDays || 0) + 1) : 1,
    sendTime: '10:30', intentText: '', textMode: 'free',
  });
  careRenderTouches();
}

function careRemoveTouch(i) {
  _careTouches.splice(i, 1);
  careRenderTouches();
}

function careMoveTouch(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= _careTouches.length) return;
  const [t] = _careTouches.splice(i, 1);
  _careTouches.splice(j, 0, t);
  careRenderTouches();
}

// oninput пишет в модель без перерисовки — чтобы не терять фокус ввода.
function careTouchField(i, field, value) {
  if (!_careTouches[i]) return;
  _careTouches[i][field] = value;
}

// Режим текста касания: 'free' — Мила пишет сама по смыслу заготовки;
// 'strict' — отправляет написанное дословно (см. care-prompt.js на бэке).
// Перерисовка нужна: меняются подпись, подсказка и placeholder поля.
function careTouchMode(i, mode) {
  if (!_careTouches[i]) return;
  _careTouches[i].textMode = mode === 'strict' ? 'strict' : 'free';
  careRenderTouches();
}

function careRenderTouches() {
  const wrap = document.getElementById('careTouches');
  if (!_careTouches.length) {
    wrap.innerHTML = '<div class="empty" style="padding:14px 0">Нет касаний — добавьте хотя бы одно.</div>';
    return;
  }
  wrap.innerHTML = _careTouches.map((t, i) => {
    const strict = t.textMode === 'strict';
    return `
    <div class="care-touch">
      <div class="care-touch-head">
        <span class="care-touch-num">${i + 1}</span>
        <input type="text" maxlength="255" placeholder="Название (напр. Контроль Т+1)"
               value="${escAttr(esc(t.title))}" oninput="careTouchField(${i}, 'title', this.value)"
               style="flex:1;min-width:120px">
        <label class="care-touch-lbl">через
          <input type="number" min="0" max="730" inputmode="numeric" value="${esc(String(t.delayDays))}"
                 oninput="careTouchField(${i}, 'delayDays', this.value)" style="width:64px"> дн.</label>
        <label class="care-touch-lbl">в
          <input type="time" value="${esc(t.sendTime)}"
                 oninput="careTouchField(${i}, 'sendTime', this.value)"></label>
        <span class="care-touch-btns">
          <button class="mc" onclick="careMoveTouch(${i}, -1)" title="Выше" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="mc" onclick="careMoveTouch(${i}, 1)" title="Ниже" ${i === _careTouches.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="mc" onclick="careRemoveTouch(${i})" title="Удалить касание">✕</button>
        </span>
      </div>
      <div class="care-touch-mode">
        <div class="bc-chip-row">
          <span class="bc-chip ${strict ? '' : 'on'}" onclick="careTouchMode(${i}, 'free')">✍️ Мила пишет сама</span>
          <span class="bc-chip ${strict ? 'on' : ''}" onclick="careTouchMode(${i}, 'strict')">📋 Готовый текст</span>
        </div>
        <span class="care-touch-modehint">${strict
          ? 'Уйдёт дословно; Мила подставит имя и решит, уместно ли касание.'
          : 'Мила напишет текст сама по смыслу заготовки.'}</span>
      </div>
      <textarea class="bc-textarea" rows="3" maxlength="2000"
        placeholder="${strict
          ? 'Готовый текст сообщения — уйдёт пациенту как написано…'
          : 'Заготовка для Милы: что узнать/предложить в этом касании…'}"
        oninput="careTouchField(${i}, 'intentText', this.value)">${esc(t.intentText)}</textarea>
    </div>`;
  }).join('');
}

async function careSaveProgram() {
  const title = document.getElementById('careTitle').value.trim();
  if (!title) { notify('Введите название программы', 'err'); return; }
  if (condHasEmpty('care')) { notify('В одном из условий ничего не выбрано — выберите значения или уберите условие', 'err'); return; }
  if (!_careTouches.length) { notify('Добавьте хотя бы одно касание', 'err'); return; }
  for (const [i, t] of _careTouches.entries()) {
    if (!String(t.intentText || '').trim()) { notify(`Касание ${i + 1}: заполните текст-заготовку`, 'err'); return; }
    const d = Number(t.delayDays);
    if (!Number.isInteger(d) || d < 0 || d > 730) { notify(`Касание ${i + 1}: задержка 0–730 дней`, 'err'); return; }
  }

  const body = {
    title,
    conditions: condGet('care'),
    touches: _careTouches.map(t => ({
      ...(t.id ? { id: t.id } : {}),
      title: String(t.title || '').trim(),
      delayDays: Number(t.delayDays),
      sendTime: t.sendTime || '10:30',
      intentText: String(t.intentText || '').trim(),
      textMode: t.textMode === 'strict' ? 'strict' : 'free',
    })),
  };

  const btn = document.getElementById('careSaveBtn');
  btn.disabled = true;
  try {
    if (_careEditId) await api('PUT', `/api/care/programs/${_careEditId}`, body);
    else             await api('POST', '/api/care/programs', body);
    notify('Программа сохранена', 'ok');
    careCloseEditor();
    await careLoadPrograms();
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
    btn.disabled = false;
  }
}

// ── превью выборки: «кто попал бы, если бы программа работала» ──
// Зачисление в заботу событийное (вебхук в момент состоявшегося визита),
// бэкфилла нет — у новой программы дашборд пуст. Превью прогоняет ТЕ ЖЕ
// условия по прошлым визитам из YClients, ничего не сохраняя и не отправляя.

const CARE_SKIP_LBL = {
  no_phone:   { lbl: 'нет телефона',  hint: 'у клиента не заполнен номер — касание отправить некуда' },
  blacklist:  { lbl: 'чёрный список', hint: 'клиент в ЧС — Мила ему не пишет' },
  superseded: { lbl: 'перекрыт',      hint: 'более поздний подходящий визит перезапустил бы программу' },
};

// Компактная дата для бейджей касаний: в узкой колонке модалки полный формат
// (с годом) не помещался и обрезался многоточием.
function careFmtShort(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return '—';
  return d.toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .replace(',', '');
}

function careOpenPreview(programId) {
  if (programId) {
    const p = _carePrograms.find(x => x.id === programId);
    _carePreviewFor = { programId };
    document.getElementById('carePreviewTitle').textContent =
      'Выборка: ' + (p ? p.title : `программа #${programId}`);
  } else {
    _carePreviewFor = { draft: true };
    document.getElementById('carePreviewTitle').textContent = 'Выборка по текущим условиям';
  }
  document.getElementById('carePreviewOv').classList.add('open');
  careRunPreview();
}

function careClosePreview() {
  document.getElementById('carePreviewOv').classList.remove('open');
}

async function careRunPreview() {
  if (!_carePreviewFor) return;
  const box = document.getElementById('carePreviewBody');
  box.className = 'empty';
  box.innerHTML = 'Считаю выборку по записям YClients…';
  const days = Number(document.getElementById('carePreviewDays').value) || 30;

  // Превью ЧЕРНОВИКА: condGet выбрасывает условия, в которых ничего не выбрано.
  // Это осознанное отличие от прежнего кода, который слал их как есть: пустое
  // условие бэкенд (evaluateRule) считает «всегда истина», и при логике ИЛИ
  // одна незаполненная строка показывала в превью ВСЕХ клиентов подряд.
  // Сохранить программу в таком виде всё равно нельзя (careSaveProgram
  // отбивает по condHasEmpty), так что превью теперь честнее, а не мягче.
  const body = _carePreviewFor.programId
    ? { programId: _carePreviewFor.programId, days }
    : {
        days,
        conditions: condGet('care'),
        touches: _careTouches.map(t => ({
          title: String(t.title || '').trim(),
          delayDays: Number(t.delayDays),
          sendTime: t.sendTime || '10:30',
        })),
      };
  try {
    careRenderPreview(await api('POST', '/api/care/preview', body));
  } catch (e) {
    box.className = 'empty';
    box.innerHTML = `<span style="color:var(--danger)">Ошибка: ${esc(e.message)}</span>`;
  }
}

function careRenderPreview(d) {
  const box = document.getElementById('carePreviewBody');
  const t = d.totals || {};
  const head = `
    <div class="care-pv-stats">
      <div class="care-pv-stat"><b>${t.willEnroll || 0}</b><span>цепочек стартовало бы</span></div>
      <div class="care-pv-stat"><b>${t.matched || 0}</b><span>визитов подошло</span></div>
      <div class="care-pv-stat"><b>${t.completed || 0}</b><span>состоявшихся визитов</span></div>
      <div class="care-pv-stat"><b>${t.records || 0}</b><span>записей за период</span></div>
    </div>
    <div style="font-size:11.5px;color:var(--t3);margin:2px 0 10px">
      Период: ${esc(d.from || '')} — ${esc(d.to || '')} (мск).
      ${d.catMapFailed ? '<span style="color:var(--danger)">Каталог услуг недоступен — условия ПО КАТЕГОРИИ не учтены.</span>' : ''}
      ${d.truncated ? 'Показаны первые 200 строк.' : ''}
    </div>`;

  if (!(d.rows || []).length) {
    box.className = '';
    box.innerHTML = head +
      '<div class="empty" style="padding:16px 0">Под условия не подошёл ни один состоявшийся визит за период. ' +
      'Проверьте условия или увеличьте период.</div>';
    return;
  }

  const rows = d.rows.map(r => {
    const skip = r.skipReason ? CARE_SKIP_LBL[r.skipReason] || { lbl: r.skipReason, hint: '' } : null;
    const touches = (r.touches || []).map(x =>
      `<span class="care-tbadge ${x.past ? 'care-tbadge-past' : ''}" title="${escAttr(esc((x.title || '') + (x.past ? ' — дата уже прошла' : '')))}">Т+${x.delayDays}: ${esc(careFmtShort(x.scheduledAt))}</span>`
    ).join('') || '<span style="font-size:11.5px;color:var(--t3)">—</span>';
    return `
      <tr class="${skip ? 'care-pv-skip' : ''}">
        <td>
          <b>${esc(r.clientName || 'Без имени')}</b>
          <div style="font-size:11.5px;color:var(--t3)">${esc(r.phone || 'нет номера')}</div>
        </td>
        <td>${esc(careFmtDt(r.visitAt))}
          ${r.services && r.services.length ? `<div style="font-size:11.5px;color:var(--t3)">${esc(r.services.join(', '))}</div>` : ''}
        </td>
        <td>${esc(r.staffName || '—')}</td>
        <td>${skip
          ? `<span class="care-badge care-st-stopped" title="${escAttr(esc(skip.hint))}">${esc(skip.lbl)}</span>`
          : '<span class="care-badge care-st-active">зачислен</span>'}</td>
        <td><div class="care-pv-touches">${touches}</div></td>
      </tr>`;
  }).join('');

  box.className = '';
  box.innerHTML = head + `
    <div class="tw"><table class="care-pv-table">
      <thead><tr><th>Клиент</th><th>Визит</th><th>Врач</th><th>Итог</th><th>Касания</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// ── вкладка «Клиенты» (дашборд прохождений) ────────────────────

function careFmtDt(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return '—';
  return d.toLocaleString('ru', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function careEnrBadge(status) {
  const st = CARE_ENR_ST[status] || { lbl: status, cls: 'care-st-stopped' };
  return `<span class="care-badge ${st.cls}">${esc(st.lbl)}</span>`;
}

async function careLoadEnrollments() {
  _careEnrOpenId = null;
  const body = document.getElementById('careEnrBody');
  body.innerHTML = '<tr><td colspan="7" class="empty">Загрузка…</td></tr>';
  const status = document.getElementById('careEnrStatus').value;
  try {
    const d = await api('GET', '/api/care/enrollments' + (status ? `?status=${encodeURIComponent(status)}` : ''));
    _careEnr = d.enrollments || [];
    careRenderEnrollments();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" class="empty" style="color:var(--danger)">Ошибка: ${esc(e.message)}</td></tr>`;
  }
}

function careRenderEnrollments() {
  const body = document.getElementById('careEnrBody');
  if (!_careEnr.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Пока никого: клиенты попадают сюда после состоявшегося визита, подходящего под условия программы.</td></tr>';
    return;
  }
  body.innerHTML = _careEnr.map(e => {
    const services = (Array.isArray(e.services) ? e.services : [])
      .map(s => s && s.title).filter(Boolean).join(', ');
    const client = `<b>${esc(e.client_name || 'Без имени')}</b><div style="font-size:11.5px;color:var(--t3)">${esc(e.phone || '')}</div>`;
    const visit = `${careFmtDt(e.visit_at)}${services ? `<div style="font-size:11.5px;color:var(--t3)">${esc(services)}</div>` : ''}`;
    return `
      <tr class="care-enr-row ${_careEnrOpenId === e.id ? 'open' : ''}" onclick="careToggleEnr(${e.id})">
        <td>${client}</td>
        <td>${esc(e.program_title || '')}</td>
        <td>${visit}</td>
        <td>${esc(e.staff_name || '—')}</td>
        <td>${careEnrBadge(e.status)}${e.status_reason ? `<div style="font-size:11px;color:var(--t3);margin-top:2px">${esc(e.status_reason)}</div>` : ''}</td>
        <td>${careFmtDt(e.next_touch_at)}</td>
        <td>${careFmtDt(e.last_sent_at)}</td>
      </tr>
      ${_careEnrOpenId === e.id ? `
      <tr class="care-enr-detail"><td colspan="7">
        <div id="careEnrDetail-${e.id}"><div class="empty" style="padding:14px 0">Загрузка журнала…</div></div>
      </td></tr>` : ''}`;
  }).join('');
}

async function careToggleEnr(id) {
  _careEnrOpenId = _careEnrOpenId === id ? null : id;
  careRenderEnrollments();
  if (_careEnrOpenId !== id) return;
  const e = _careEnr.find(x => x.id === id);
  const box = document.getElementById(`careEnrDetail-${id}`);
  if (!box || !e) return;
  try {
    const d = await api('GET', `/api/care/enrollments/${id}/sends`);
    const sends = d.sends || [];
    const rows = sends.map(s => {
      const st = CARE_SEND_ST[s.status] || { lbl: s.status, color: '#9ca3af' };
      const name = s.touch_title || (s.delay_days != null ? `Т+${s.delay_days}` : 'касание удалено');
      const when = s.sent_at ? careFmtDt(s.sent_at) : careFmtDt(s.scheduled_at);
      return `
        <div class="nr-log-row">
          <div class="nr-log-top">
            <span class="bc-row-status" style="background:${st.color}22;color:${st.color}">${esc(st.lbl)}</span>
            <b>${esc(name)}</b>${s.delay_days != null && s.touch_title ? ` <span style="color:var(--t3)">· Т+${s.delay_days}</span>` : ''}
            <span style="color:var(--t3)">${esc(when)}${s.channel_used ? ' · ' + esc(s.channel_used) : ''}</span>
          </div>
          ${s.decision_reason ? `<div style="font-size:11.5px;color:var(--t3);margin-top:3px">${esc(s.decision_reason)}</div>` : ''}
          ${s.error ? `<div style="color:var(--danger);font-size:11.5px;margin-top:3px">${esc(s.error)}</div>` : ''}
          ${s.rendered_text ? `<div class="nr-log-text">${esc(s.rendered_text.slice(0, 300))}</div>` : ''}
        </div>`;
    }).join('') || '<div class="empty" style="padding:14px 0">Журнал пуст.</div>';

    const canStop = ['active', 'escalated'].includes(e.status);
    box.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${canStop ? `<button class="btn btn-sec btn-sm" onclick="event.stopPropagation();careStopEnr(${id})">⏹ Остановить</button>` : ''}
        ${e.phone ? `<button class="btn btn-sec btn-sm" onclick="event.stopPropagation();careOpenChat('${escJs(e.phone)}')">💬 Открыть чат</button>` : ''}
      </div>
      ${rows}`;
  } catch (err) {
    box.innerHTML = `<div class="empty" style="color:var(--danger);padding:14px 0">Ошибка: ${esc(err.message)}</div>`;
  }
}

async function careStopEnr(id) {
  if (!confirm('Остановить прохождение? Запланированные касания будут отменены.')) return;
  try {
    await api('POST', `/api/care/enrollments/${id}/stop`);
    notify('Прохождение остановлено', 'ok');
    await careLoadEnrollments();
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
  }
}

function careOpenChat(phone) {
  // Тот же механизм, что deep-link /#chat/<ключ>: loadChat() прочитает
  // window._deepLinkArg и откроет диалог после загрузки списка.
  window._deepLinkArg = phone;
  location.hash = '#chat/' + phone;
  navTo('chat');
}
