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
let _careConds = [];        // [{ type, ids:Set<string>, filter:'' }]
let _careLogic = 'and';
let _careTouches = [];      // [{ id?, title, delayDays, sendTime, intentText }]

// ── вкладки ────────────────────────────────────────────────────

function loadCarePage() {
  careSwitchTab('programs');
  careLoadPrograms();
  careLoadEnrollments();
}

function careSwitchTab(tab) {
  document.getElementById('careTab-programs').style.display = tab === 'programs' ? '' : 'none';
  document.getElementById('careTab-clients').style.display  = tab === 'clients'  ? '' : 'none';
  document.getElementById('careTabBtn-programs').classList.toggle('active', tab === 'programs');
  document.getElementById('careTabBtn-clients').classList.toggle('active', tab === 'clients');
}

// ── словарь условий (общий эндпоинт с автоуведомлениями) ───────

async function careEnsureDicts() {
  if (_careDicts) return;
  _careDicts = await api('GET', '/api/notification-rules/dictionaries');
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

  _careLogic = (p && p.conditions && p.conditions.logic === 'or') ? 'or' : 'and';
  _careConds = ((p && p.conditions && p.conditions.items) || [])
    .map(it => ({ type: it.type, ids: new Set((it.ids || []).map(String)), filter: '' }));
  _careTouches = p
    ? (p.touches || []).map(t => ({
        id: t.id, title: t.title || '', delayDays: t.delayDays,
        sendTime: t.sendTime || '10:30', intentText: t.intentText || '',
      }))
    : [{ title: '', delayDays: 1, sendTime: '10:30', intentText: '' }];

  careRenderConds();
  careSetLogic(_careLogic);
  careRenderTouches();
  document.getElementById('careSaveBtn').disabled = false;
  document.getElementById('careEditorOv').classList.add('open');
}

function careCloseEditor() {
  document.getElementById('careEditorOv').classList.remove('open');
}

// — конструктор условий (паттерн broadcast-rules.js) —

function careSetLogic(logic) {
  _careLogic = logic === 'or' ? 'or' : 'and';
  document.getElementById('careLogic-and').classList.toggle('on', _careLogic === 'and');
  document.getElementById('careLogic-or').classList.toggle('on', _careLogic === 'or');
}

function careAddCond() {
  _careConds.push({ type: 'service', ids: new Set(), filter: '' });
  careRenderConds();
}

function careRemoveCond(i) {
  _careConds.splice(i, 1);
  careRenderConds();
}

function careCondType(i, type) {
  _careConds[i].type = type;
  _careConds[i].ids = new Set();
  _careConds[i].filter = '';
  careRenderConds();
}

function careCondFilter(i, value) {
  _careConds[i].filter = value;
  careRenderCondList(i);
}

function careCondToggleId(i, id, checked) {
  if (checked) _careConds[i].ids.add(String(id));
  else _careConds[i].ids.delete(String(id));
  const cnt = document.getElementById(`careCondCount-${i}`);
  if (cnt) cnt.textContent = `выбрано: ${_careConds[i].ids.size}`;
}

function careCondOptions(type) {
  if (!_careDicts) return [];
  if (type === 'staff') {
    return (_careDicts.staff || []).map(s => ({
      id: s.id, label: s.name + (s.specialization ? ` — ${s.specialization}` : ''),
    }));
  }
  if (type === 'category') {
    return (_careDicts.categories || []).map(c => ({ id: c.id, label: c.title }));
  }
  const catById = {};
  (_careDicts.categories || []).forEach(c => { catById[String(c.id)] = c.title; });
  return (_careDicts.services || []).map(s => ({
    id: s.id, label: s.title + (catById[String(s.category_id)] ? ` · ${catById[String(s.category_id)]}` : ''),
  }));
}

function careRenderConds() {
  const wrap = document.getElementById('careConds');
  wrap.innerHTML = _careConds.map((c, i) => `
    <div class="nr-cond">
      <div class="nr-cond-head">
        <select onchange="careCondType(${i}, this.value)">
          ${Object.entries(CARE_COND_LABELS).map(([k, v]) =>
            `<option value="${k}" ${c.type === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <span class="nr-cond-count" id="careCondCount-${i}">выбрано: ${c.ids.size}</span>
        <button class="mc" onclick="careRemoveCond(${i})" title="Убрать условие">✕</button>
      </div>
      <input type="search" autocomplete="off" placeholder="🔎 Поиск…" value="${escAttr(esc(c.filter))}"
             oninput="careCondFilter(${i}, this.value)">
      <div class="nr-cond-list" id="careCondList-${i}"></div>
    </div>`).join('');
  document.getElementById('careLogicWrap').style.display = _careConds.length > 1 ? 'flex' : 'none';
  _careConds.forEach((_, i) => careRenderCondList(i));
}

function careRenderCondList(i) {
  const box = document.getElementById(`careCondList-${i}`);
  if (!box) return;
  const c = _careConds[i];
  const q = (c.filter || '').trim().toLowerCase();
  let opts = careCondOptions(c.type);
  if (q) opts = opts.filter(o => o.label.toLowerCase().includes(q));
  const total = opts.length;
  // Выбранные — всегда сверху, чтобы не терялись за фильтром/лимитом.
  opts.sort((a, b) => (c.ids.has(String(b.id)) ? 1 : 0) - (c.ids.has(String(a.id)) ? 1 : 0));
  opts = opts.slice(0, 150);
  box.innerHTML = opts.map(o => `
    <label class="nr-cond-opt">
      <input type="checkbox" ${c.ids.has(String(o.id)) ? 'checked' : ''}
             onchange="careCondToggleId(${i}, '${o.id}', this.checked)">
      <span>${esc(o.label)}</span>
    </label>`).join('') || '<div class="empty" style="padding:12px 0">Ничего не найдено</div>';
  if (total > 150) {
    box.innerHTML += `<div style="font-size:11px;color:var(--t3);padding:6px 2px">Показаны первые 150 из ${total} — уточните поиск</div>`;
  }
}

// — конструктор цепочки касаний —

function careAddTouch() {
  const last = _careTouches[_careTouches.length - 1];
  _careTouches.push({
    title: '', delayDays: last ? Math.min(730, (+last.delayDays || 0) + 1) : 1,
    sendTime: '10:30', intentText: '',
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

function careRenderTouches() {
  const wrap = document.getElementById('careTouches');
  if (!_careTouches.length) {
    wrap.innerHTML = '<div class="empty" style="padding:14px 0">Нет касаний — добавьте хотя бы одно.</div>';
    return;
  }
  wrap.innerHTML = _careTouches.map((t, i) => `
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
      <textarea class="bc-textarea" rows="3" maxlength="2000"
        placeholder="Заготовка для Милы: что узнать/предложить в этом касании…"
        oninput="careTouchField(${i}, 'intentText', this.value)">${esc(t.intentText)}</textarea>
    </div>`).join('');
}

async function careSaveProgram() {
  const title = document.getElementById('careTitle').value.trim();
  if (!title) { notify('Введите название программы', 'err'); return; }
  const emptyCond = _careConds.find(c => !c.ids.size);
  if (emptyCond) { notify('В одном из условий ничего не выбрано — выберите значения или уберите условие', 'err'); return; }
  if (!_careTouches.length) { notify('Добавьте хотя бы одно касание', 'err'); return; }
  for (const [i, t] of _careTouches.entries()) {
    if (!String(t.intentText || '').trim()) { notify(`Касание ${i + 1}: заполните текст-заготовку`, 'err'); return; }
    const d = Number(t.delayDays);
    if (!Number.isInteger(d) || d < 0 || d > 730) { notify(`Касание ${i + 1}: задержка 0–730 дней`, 'err'); return; }
  }

  const body = {
    title,
    conditions: {
      logic: _careLogic,
      items: _careConds.map(c => ({ type: c.type, ids: Array.from(c.ids).map(Number) })),
    },
    touches: _careTouches.map(t => ({
      ...(t.id ? { id: t.id } : {}),
      title: String(t.title || '').trim(),
      delayDays: Number(t.delayDays),
      sendTime: t.sendTime || '10:30',
      intentText: String(t.intentText || '').trim(),
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
            <span class="bc-row-status" style="background:${st.color}22;color:${st.color}">${st.lbl}</span>
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
        ${e.phone ? `<button class="btn btn-sec btn-sm" onclick="event.stopPropagation();careOpenChat('${esc(e.phone)}')">💬 Открыть чат</button>` : ''}
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
