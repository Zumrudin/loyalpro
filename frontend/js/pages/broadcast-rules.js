// ── АВТОУВЕДОМЛЕНИЯ (вкладка на странице «Рассылки») ───────────
// Правила: событие «создание записи» + условия (специалист/категория/услуга,
// И/ИЛИ) → текст в Chatpush-каналы каскадом. Зависимости: api(), esc(), notify()

const NR_CH_LABELS = {
  telegram: 'Telegram (бот)',
  whatsapp: 'WhatsApp',
  tdlib:    'Telegram (номер)',
  max:      'MAX',
  max_bot:  'MAX (бот)',
  notify:   'ВК/ОК',
};
const NR_COND_LABELS = { staff: 'Специалист', category: 'Категория', service: 'Услуга' };
const NR_STATUS_LBL = {
  pending: { lbl: 'В очереди',  color: '#9ca3af' },
  sent:    { lbl: 'Отправлено', color: '#10b981' },
  failed:  { lbl: 'Ошибка',     color: '#ef4444' },
  skipped: { lbl: 'Пропущено',  color: '#f59e0b' },
};

let _nrDicts = null;        // { staff, categories, services, channels }
let _nrRules = [];
let _nrLoaded = false;
let _nrEditId = null;
let _nrConds = [];          // [{ type, ids:Set<string>, filter:'' }]
let _nrLogic = 'and';
let _nrChannels = [];       // порядок каскада

// ── вкладки ────────────────────────────────────────────────────

function bcSwitchTab(tab) {
  document.getElementById('bcTab-once').style.display  = tab === 'once'  ? '' : 'none';
  document.getElementById('bcTab-rules').style.display = tab === 'rules' ? '' : 'none';
  document.getElementById('bcTabBtn-once').classList.toggle('active', tab === 'once');
  document.getElementById('bcTabBtn-rules').classList.toggle('active', tab === 'rules');
  if (tab === 'rules' && !_nrLoaded) nrLoad();
}

// ── список правил ──────────────────────────────────────────────

async function nrLoad() {
  _nrLoaded = true;
  const wrap = document.getElementById('nrList');
  wrap.className = 'empty';
  wrap.innerHTML = 'Загрузка…';
  try {
    const [rules, dicts] = await Promise.all([
      api('GET', '/api/notification-rules'),
      _nrDicts ? Promise.resolve(_nrDicts) : api('GET', '/api/notification-rules/dictionaries'),
    ]);
    _nrDicts = dicts;
    _nrRules = rules.items || [];
    nrRenderList();
  } catch (e) {
    wrap.innerHTML = `<span style="color:var(--danger)">Ошибка: ${esc(e.message)}</span>`;
  }
}

function nrDictName(type, id) {
  if (!_nrDicts) return String(id);
  const list = type === 'staff' ? _nrDicts.staff : type === 'category' ? _nrDicts.categories : _nrDicts.services;
  const hit = (list || []).find(x => String(x.id) === String(id));
  return hit ? (hit.title || hit.name || String(id)) : String(id);
}

function nrCondSummary(conditions) {
  const items = (conditions && conditions.items) || [];
  if (!items.length) return 'Любая новая запись';
  const logic = conditions.logic === 'or' ? ' ИЛИ ' : ' И ';
  return items.map(it => {
    const names = (it.ids || []).slice(0, 3).map(id => nrDictName(it.type, id));
    const more = it.ids.length > 3 ? ` +${it.ids.length - 3}` : '';
    return `${NR_COND_LABELS[it.type] || it.type}: ${names.join(', ')}${more}`;
  }).join(logic);
}

function nrRenderList() {
  const wrap = document.getElementById('nrList');
  if (!_nrRules.length) {
    wrap.className = 'empty';
    wrap.innerHTML = 'Пока нет правил. Нажмите «+ Новое правило», чтобы создать первое автоуведомление.';
    return;
  }
  wrap.className = '';
  wrap.innerHTML = _nrRules.map(r => {
    const channels = (r.channels || []).map(c => NR_CH_LABELS[c] || c).join(' → ');
    const stats = [];
    if (+r.sent_count)    stats.push(`<span style="color:#10b981">✓ ${r.sent_count}</span>`);
    if (+r.failed_count)  stats.push(`<span style="color:var(--danger)">✕ ${r.failed_count}</span>`);
    if (+r.skipped_count) stats.push(`<span style="color:#f59e0b">⤼ ${r.skipped_count}</span>`);
    if (+r.pending_count) stats.push(`<span style="color:var(--t3)">⏳ ${r.pending_count}</span>`);
    return `
      <div class="bc-row" data-id="${r.id}">
        <div class="bc-row-grid">
          <div class="bc-row-left">
            <div class="bc-row-meta" style="display:flex;align-items:center;gap:10px">
              <label class="tgl"><input type="checkbox" ${r.is_enabled ? 'checked' : ''}
                onchange="nrToggle(${r.id})"><span class="ts"></span></label>
              <b style="font-size:13.5px;color:var(--t1)">${esc(r.title)}</b>
            </div>
            <div class="bc-row-filters" style="margin-top:6px">${esc(nrCondSummary(r.conditions))}</div>
            <div class="bc-row-filters">Каналы: ${esc(channels)}${r.prefer_last_channel ? ' · сначала последний канал клиента' : ''}</div>
            <div class="bc-row-preview">${esc((r.message_template || '').slice(0, 140))}${(r.message_template || '').length > 140 ? '…' : ''}</div>
          </div>
          <div class="bc-row-right">
            <div class="bc-progress-lbl">Отправки</div>
            <div class="bc-progress-val">${stats.length ? stats.join(' · ') : '—'}</div>
            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;justify-content:flex-end">
              <button class="btn btn-sec btn-sm" onclick="nrShowLog(${r.id})">Журнал</button>
              <button class="btn btn-sec btn-sm" onclick="nrOpenEditor(${r.id})">Изменить</button>
              <button class="btn btn-sec btn-sm" onclick="nrDelete(${r.id})">🗑</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function nrToggle(id) {
  try {
    const d = await api('POST', `/api/notification-rules/${id}/toggle`);
    const i = _nrRules.findIndex(r => r.id === id);
    if (i >= 0) _nrRules[i] = { ..._nrRules[i], ...d.rule };
    notify(d.rule.is_enabled ? 'Правило включено' : 'Правило выключено', 'ok');
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
    nrRenderList();
  }
}

async function nrDelete(id) {
  if (!confirm('Удалить правило вместе с журналом отправок?')) return;
  try {
    await api('DELETE', `/api/notification-rules/${id}`);
    notify('Правило удалено', 'ok');
    await nrLoad();
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
  }
}

// ── редактор правила ───────────────────────────────────────────

async function nrOpenEditor(id) {
  if (!_nrDicts) {
    try { _nrDicts = await api('GET', '/api/notification-rules/dictionaries'); }
    catch (e) { notify('Ошибка справочников: ' + e.message, 'err'); return; }
  }
  _nrEditId = id || null;
  const rule = id ? _nrRules.find(r => r.id === id) : null;
  document.getElementById('nrEditorTitle').textContent = rule ? 'Правило: ' + rule.title : 'Новое правило';
  document.getElementById('nrTitle').value = rule ? rule.title : '';
  document.getElementById('nrText').value = rule ? rule.message_template : '';
  document.getElementById('nrCharCount').textContent = String((rule ? rule.message_template : '').length);
  document.getElementById('nrPreferLast').checked = rule ? !!rule.prefer_last_channel : true;

  _nrLogic = (rule && rule.conditions && rule.conditions.logic === 'or') ? 'or' : 'and';
  _nrConds = ((rule && rule.conditions && rule.conditions.items) || [])
    .map(it => ({ type: it.type, ids: new Set((it.ids || []).map(String)), filter: '' }));
  _nrChannels = rule ? (rule.channels || []).slice() : ['telegram', 'whatsapp'];

  nrRenderConds();
  nrRenderChannels();
  nrSetLogic(_nrLogic);
  const ta = document.getElementById('nrText');
  ta.oninput = () => { document.getElementById('nrCharCount').textContent = String(ta.value.length); };
  document.getElementById('nrSaveBtn').disabled = false;
  document.getElementById('nrEditorOv').classList.add('open');
}

function nrCloseEditor() {
  document.getElementById('nrEditorOv').classList.remove('open');
}

function nrInsertVar(token) {
  const ta = document.getElementById('nrText');
  const start = ta.selectionStart || 0, end = ta.selectionEnd || 0;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + token.length;
  ta.focus();
  document.getElementById('nrCharCount').textContent = String(ta.value.length);
}

function nrSetLogic(logic) {
  _nrLogic = logic === 'or' ? 'or' : 'and';
  document.getElementById('nrLogic-and').classList.toggle('on', _nrLogic === 'and');
  document.getElementById('nrLogic-or').classList.toggle('on', _nrLogic === 'or');
}

function nrAddCond() {
  _nrConds.push({ type: 'staff', ids: new Set(), filter: '' });
  nrRenderConds();
}

function nrRemoveCond(i) {
  _nrConds.splice(i, 1);
  nrRenderConds();
}

function nrCondType(i, type) {
  _nrConds[i].type = type;
  _nrConds[i].ids = new Set();
  _nrConds[i].filter = '';
  nrRenderConds();
}

function nrCondFilter(i, value) {
  _nrConds[i].filter = value;
  nrRenderCondList(i);
}

function nrCondToggleId(i, id, checked) {
  if (checked) _nrConds[i].ids.add(String(id));
  else _nrConds[i].ids.delete(String(id));
  const cnt = document.getElementById(`nrCondCount-${i}`);
  if (cnt) cnt.textContent = `выбрано: ${_nrConds[i].ids.size}`;
}

function nrCondOptions(type) {
  if (!_nrDicts) return [];
  if (type === 'staff') {
    return (_nrDicts.staff || []).map(s => ({
      id: s.id, label: s.name + (s.specialization ? ` — ${s.specialization}` : ''),
    }));
  }
  if (type === 'category') {
    return (_nrDicts.categories || []).map(c => ({ id: c.id, label: c.title }));
  }
  const catById = {};
  (_nrDicts.categories || []).forEach(c => { catById[String(c.id)] = c.title; });
  return (_nrDicts.services || []).map(s => ({
    id: s.id, label: s.title + (catById[String(s.category_id)] ? ` · ${catById[String(s.category_id)]}` : ''),
  }));
}

function nrRenderConds() {
  const wrap = document.getElementById('nrConds');
  wrap.innerHTML = _nrConds.map((c, i) => `
    <div class="nr-cond">
      <div class="nr-cond-head">
        <select onchange="nrCondType(${i}, this.value)">
          ${Object.entries(NR_COND_LABELS).map(([k, v]) =>
            `<option value="${k}" ${c.type === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <span class="nr-cond-count" id="nrCondCount-${i}">выбрано: ${c.ids.size}</span>
        <button class="mc" onclick="nrRemoveCond(${i})" title="Убрать условие">✕</button>
      </div>
      <input type="search" autocomplete="off" placeholder="🔎 Поиск…" value="${esc(c.filter)}"
             oninput="nrCondFilter(${i}, this.value)">
      <div class="nr-cond-list" id="nrCondList-${i}"></div>
    </div>`).join('');
  document.getElementById('nrLogicWrap').style.display = _nrConds.length > 1 ? 'flex' : 'none';
  _nrConds.forEach((_, i) => nrRenderCondList(i));
}

function nrRenderCondList(i) {
  const box = document.getElementById(`nrCondList-${i}`);
  if (!box) return;
  const c = _nrConds[i];
  const q = (c.filter || '').trim().toLowerCase();
  let opts = nrCondOptions(c.type);
  if (q) opts = opts.filter(o => o.label.toLowerCase().includes(q));
  const total = opts.length;
  // Выбранные — всегда сверху, чтобы не терялись за фильтром/лимитом.
  opts.sort((a, b) => (c.ids.has(String(b.id)) ? 1 : 0) - (c.ids.has(String(a.id)) ? 1 : 0));
  opts = opts.slice(0, 150);
  box.innerHTML = opts.map(o => `
    <label class="nr-cond-opt">
      <input type="checkbox" ${c.ids.has(String(o.id)) ? 'checked' : ''}
             onchange="nrCondToggleId(${i}, '${o.id}', this.checked)">
      <span>${esc(o.label)}</span>
    </label>`).join('') || '<div class="empty" style="padding:12px 0">Ничего не найдено</div>';
  if (total > 150) {
    box.innerHTML += `<div style="font-size:11px;color:var(--t3);padding:6px 2px">Показаны первые 150 из ${total} — уточните поиск</div>`;
  }
}

// ── каналы ─────────────────────────────────────────────────────

function nrRenderChannels() {
  const wrap = document.getElementById('nrChannels');
  const all = (_nrDicts && _nrDicts.channels) || Object.keys(NR_CH_LABELS);
  wrap.innerHTML = all.map(ch => {
    const pos = _nrChannels.indexOf(ch);
    return `<span class="bc-chip ${pos >= 0 ? 'on' : ''}" onclick="nrToggleChannel('${ch}')">
      ${pos >= 0 ? (pos + 1) + ' · ' : ''}${esc(NR_CH_LABELS[ch] || ch)}</span>`;
  }).join('');
}

function nrToggleChannel(ch) {
  const i = _nrChannels.indexOf(ch);
  if (i >= 0) _nrChannels.splice(i, 1);
  else _nrChannels.push(ch);
  nrRenderChannels();
}

// ── сохранение ─────────────────────────────────────────────────

async function nrSave() {
  const title = document.getElementById('nrTitle').value.trim();
  const text = document.getElementById('nrText').value.trim();
  if (!title) { notify('Введите название правила', 'err'); return; }
  if (!text)  { notify('Введите текст сообщения', 'err'); return; }
  if (!_nrChannels.length) { notify('Выберите хотя бы один канал', 'err'); return; }
  const emptyCond = _nrConds.find(c => !c.ids.size);
  if (emptyCond) { notify('В одном из условий ничего не выбрано — выберите значения или уберите условие', 'err'); return; }

  const body = {
    title,
    messageTemplate: text,
    conditions: {
      logic: _nrLogic,
      items: _nrConds.map(c => ({ type: c.type, ids: Array.from(c.ids).map(Number) })),
    },
    channels: _nrChannels,
    preferLastChannel: document.getElementById('nrPreferLast').checked,
  };

  const btn = document.getElementById('nrSaveBtn');
  btn.disabled = true;
  try {
    if (_nrEditId) await api('PUT', `/api/notification-rules/${_nrEditId}`, body);
    else           await api('POST', '/api/notification-rules', body);
    notify('Правило сохранено', 'ok');
    nrCloseEditor();
    await nrLoad();
  } catch (e) {
    notify('Ошибка: ' + e.message, 'err');
    btn.disabled = false;
  }
}

// ── журнал отправок ────────────────────────────────────────────

async function nrShowLog(id) {
  const rule = _nrRules.find(r => r.id === id);
  document.getElementById('nrLogTitle').textContent = 'Журнал: ' + (rule ? rule.title : '#' + id);
  const body = document.getElementById('nrLogBody');
  body.innerHTML = '<div class="empty">Загрузка…</div>';
  document.getElementById('nrLogOv').classList.add('open');
  try {
    const d = await api('GET', `/api/notification-rules/${id}/sends?limit=100`);
    if (!d.items || !d.items.length) {
      body.innerHTML = '<div class="empty">Пока нет отправок по этому правилу.</div>';
      return;
    }
    body.innerHTML = d.items.map(s => {
      const st = NR_STATUS_LBL[s.status] || { lbl: s.status, color: '#9ca3af' };
      const when = new Date(s.created_at).toLocaleString('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const who = s.client_name || s.phone || '—';
      const route = s.channel_used ? (NR_CH_LABELS[s.channel_used] || s.channel_used)
        : (Array.isArray(s.routing) ? s.routing.map(c => NR_CH_LABELS[c] || c).join(' → ') : '');
      return `
        <div class="nr-log-row">
          <div class="nr-log-top">
            <span class="bc-row-status" style="background:${st.color}22;color:${st.color}">${st.lbl}</span>
            <b>${esc(who)}</b>
            <span style="color:var(--t3)">${esc(when)}${route ? ' · ' + esc(route) : ''}</span>
          </div>
          ${s.error ? `<div style="color:var(--danger);font-size:11.5px;margin-top:3px">${esc(s.error)}</div>` : ''}
          <div class="nr-log-text">${esc((s.rendered_text || '').slice(0, 200))}</div>
        </div>`;
    }).join('');
  } catch (e) {
    body.innerHTML = `<div class="empty" style="color:var(--danger)">Ошибка: ${esc(e.message)}</div>`;
  }
}

function nrCloseLog() {
  document.getElementById('nrLogOv').classList.remove('open');
}
