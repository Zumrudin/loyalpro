// ── «📄 Документы»: страница пациента (спека 2026-10-25 §5) ─────────────────────────
// Шапка с четырьмя шагами, свёрнутый блок данных (красный и пульсирует, пока не хватает полей для
// неподписанных документов), карточки документов с выбором на подпись и ручной правкой, панель
// отправки, визиты с актами и история. Состояния документов и полноту данных считает сервер
// (GET /clients/:id/page → services/edocs/board.js). Паспорт расшифровывается только при раскрытии
// блока данных (GET /clients/:id/identity — каждый показ в журнал). Глобальные имена — edc*/ed*.
let _edc = { clientId: null, recordId: null, page: null, form: null, formLoaded: false, unsaved: false, source: 'manual', notes: [],
  selected: new Set(), act: null, actEdited: false, docDate: '', missingSel: null, checking: false };
let _edcOpenData = false;   // «Заполнить данные» с дашборда: раскрыть блок данных сразу
let _edForm = null;         // открытое окно анкеты: { clientId, formId, url, qr, expiresAt }
const ED_CLIENT_POLL_MS = 10000;
// [ключ, подпись, тип, заголовок группы (с этого поля), класс ширины]
const EDC_FIELDS = [
  ['last_name', 'Фамилия', 'text', 'Личные данные'], ['first_name', 'Имя', 'text'], ['middle_name', 'Отчество', 'text'],
  ['birth_date', 'Дата рождения', 'date'], ['gender', 'Пол', 'gender'], ['phone', 'Телефон', 'tel'], ['email', 'E-mail', 'email'],
  ['passport_series', 'Серия паспорта', 'digits', 'Паспорт РФ'], ['passport_number', 'Номер паспорта', 'digits'], ['issue_date', 'Дата выдачи', 'date'],
  ['authority_code', 'Код подразделения', 'text'], ['issued_by', 'Кем выдан', 'text', null, 'wide'], ['birth_place', 'Место рождения', 'text'],
  ['address', 'Адрес регистрации', 'text', 'Адрес', 'full'],
  ['contract_no', 'Номер договора', 'text', 'Договор'], ['contract_date', 'Дата договора', 'date'],
];
const EDC_STEP_LABELS = { data: 'Данные', contract: 'Договор', consent_pd: 'Согласие', act: 'Акт' };

function edcEl(id) { return document.getElementById(id); }

async function edcRender(route, seq) {
  const box = edcEl('edView-client');
  if (!box) return;
  if (_edc.clientId !== route.clientId) {
    _edc = { clientId: route.clientId, recordId: route.recordId, page: null, form: null, formLoaded: false, unsaved: false, source: 'manual', notes: [],
      selected: new Set(), act: null, actEdited: false, docDate: '', missingSel: null, checking: false };
  }
  _edc.recordId = route.recordId;
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  await edcLoad(seq, false);
  if (seq === _ed.loadSeq) edcSchedule();
}

function edcNeedsPolling() {
  const p = _edc.page;
  if (!p) return false;
  return p.docs.contract.state === 'pending' || p.docs.consent_pd.state === 'pending' || p.visits.some((v) => v.act.state === 'pending')
    || !!(p.form && p.form.status === 'active');
}
function edcSchedule() {
  edClearTimer();
  if (edcNeedsPolling()) _ed.timer = setInterval(() => edcRefresh(false), ED_CLIENT_POLL_MS);
}
function edcRefresh(force) {
  if (_ed.route.view !== 'client') return;
  if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  edcLoad(_ed.loadSeq, true).then(() => edcSchedule());
}

async function edcLoad(seq, quiet) {
  let p;
  try { p = await api('GET', '/api/edocs/clients/' + _edc.clientId + '/page' + (_edc.recordId ? '?record=' + _edc.recordId : '')); } catch (e) {
    const box = edcEl('edView-client');
    if (!quiet && seq === _ed.loadSeq && box) box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    return;
  }
  if (seq !== _ed.loadSeq || _ed.route.view !== 'client' || _ed.route.clientId !== p.client.id) return;
  const first = !_edc.page;
  _edc.page = p;
  if (p.focusRecordId && (!_edc.act || _edc.act.recordId !== p.focusRecordId)) await edcLoadAct(p.focusRecordId);
  if (first) edcDefaultSelection();
  edcPaint(first);
  edcCheck();
}

/** Строки акта выбранного визита по умолчанию (из записи YClients). */
async function edcLoadAct(recordId) {
  try {
    const d = await api('GET', '/api/edocs/records/' + recordId + '/act-draft');
    _edc.act = { recordId, visitDate: d.record.visitDate, actNo: d.record.actNo, doctor: d.doctor, defaultTotal: d.totals.total_sum,
      rows: d.lines.map((l) => Object.assign({ include: true }, l)) };
  } catch (e) { _edc.act = { recordId, error: e.message, rows: [] }; }
  _edc.actEdited = false;
}

const EDC_BAD = ['missing', 'lapsed', 'problem'];
/** Выбор по умолчанию: всё, чего не хватает (договор, согласие, акт выбранного визита). */
function edcDefaultSelection() {
  const p = _edc.page;
  _edc.selected = new Set();
  for (const k of ['contract', 'consent_pd']) if (p.kinds[k] && EDC_BAD.indexOf(p.docs[k].state) >= 0) _edc.selected.add(p.kinds[k].id);
  const focus = edcFocus();
  if (p.kinds.act && focus && EDC_BAD.indexOf(focus.act.state) >= 0) _edc.selected.add(p.kinds.act.id);
}
function edcFocus() { const p = _edc.page; return (p && p.visits.find((v) => v.recordId === p.focusRecordId)) || null; }

function edcPaint(first) {
  const box = edcEl('edView-client');
  if (!box) return;
  if (first || !edcEl('edcHead')) {
    box.innerHTML = '<button class="edc-back" onclick="edcBack()">← Документы</button><div id="edcHead"></div>'
      + '<details id="edcData" class="edc-data" ontoggle="edcDataToggle(this)"><summary id="edcDataSum"></summary><div class="edc-body" id="edcDataBody"></div></details>'
      + '<div class="edc-docs-head"><div><div class="ed-sub">Комплект на подпись</div><div class="ed-h" style="margin:0">Документы</div></div>'
      + '<span class="ed-sub">Нажмите на карточку, чтобы добавить документ в отправку</span></div>'
      + '<div id="edcDocs" class="edc-docs"></div><div id="edcSend" class="edc-send"></div>'
      + '<div class="edc-two"><div class="card"><div class="ed-h2" style="margin-top:0">Визиты и акты</div><ul class="edc-tl" id="edcVisits"></ul></div>'
      + '<div class="card"><div class="ed-h2" style="margin-top:0">История</div><ul class="edc-tl" id="edcHistory"></ul></div></div>';
  }
  edcHeadRender();
  edcDataSumRender();
  edcDocsRender();
  edcSendRender();
  edcVisitsRender();
  edcHistoryRender();
  if (first && _edcOpenData) { _edcOpenData = false; const d = edcEl('edcData'); if (d) d.open = true; }
  else if (_edc.formLoaded && !_edc.unsaved) edcMarkMissing();
}

function edcBack() { if (window.history && window.history.length > 1) window.history.back(); else edGo(''); }

function edcHeadRender() {
  const p = _edc.page;
  const h = p.header;
  const el = edcEl('edcHead');
  if (!el) return;
  const meta = [];
  if (h.day) meta.push('📅 ' + edDayLabel(h.day, p.today) + (h.time ? ', ' + h.time : ''));
  if (h.services && h.services.length) meta.push(h.services.join(', '));
  if (h.staffName) meta.push(h.staffName);
  if (p.client.phone) meta.push('📞 ' + edPhone(p.client.phone));
  el.innerHTML = '<div class="edc-head ed-c-' + h.color + '"><div class="edb-av">' + esc(p.client.initials) + '</div>'
    + '<div style="min-width:0"><div class="ed-sub">' + (h.firstVisit ? 'Первичный пациент' : 'Пациент') + '</div><div class="edc-name">' + esc(p.client.name) + '</div>'
    + '<div class="edc-meta">' + meta.map((m) => '<span>' + esc(m) + '</span>').join('') + '</div></div>'
    + '<div class="edc-overall"><span class="edb-st">' + esc(h.label) + '</span><div class="edc-steps">'
    + h.steps.map((s) => '<span class="' + s.tone + '" title="' + escAttr(EDC_STEP_LABELS[s.key]) + '"></span>').join('')
    + '</div><div class="edc-steps-l">Данные · Договор · Согласие · Акт</div></div></div>'
    + (p.warnings.length ? '<div class="ed-sub" style="margin:-4px 0 10px">' + p.warnings.map(esc).join(' · ') + '</div>' : '');
}

function edcDataSumRender() {
  const p = _edc.page;
  const d = p.data;
  const det = edcEl('edcData');
  const sum = edcEl('edcDataSum');
  if (!det || !sum) return;
  const n = d.missing.length;
  det.className = 'edc-data ed-c-' + (n ? 'red' : 'green');
  sum.innerHTML = '<span class="edc-ico">' + (n ? '!' : '✓') + '</span><div><b>'
    + (n ? 'Данные пациента: не хватает ' + n + ' ' + edPlural(n, 'поля', 'полей', 'полей') : 'Данные пациента заполнены') + '</b><small>'
    + esc(n ? d.missing.map((x) => x.label.toLowerCase()).join(', ') + ' — без них документы не отправить. Заполните сами или отправьте пациенту анкету.'
      : 'Всё, что нужно для документов, есть. Нажмите, чтобы посмотреть или поправить.') + '</small></div><span class="edc-chev">▾</span>';
}

function edcDataToggle(det) {
  if (!det.open) return;
  if (!_edc.formLoaded) edcLoadIdentity(); else edcDataBodyRender();
}

async function edcLoadIdentity() {
  const body = edcEl('edcDataBody');
  if (body) body.innerHTML = '<div class="empty">Загрузка…</div>';
  const id = _edc.clientId;
  try {
    const ident = await api('GET', '/api/edocs/clients/' + id + '/identity');
    if (ident.exists) {
      _edc.form = Object.assign({}, ident.plain, ident.secure);
      _edc.unsaved = false;
      _edc.notes = [];
    } else {
      const pre = await api('GET', '/api/edocs/clients/' + id + '/identity/prefill');
      _edc.form = Object.assign({}, pre.plain, pre.secure);
      _edc.notes = (pre.notes || []).slice();
      _edc.unsaved = true;
    }
    if (_edc.clientId !== id) return;
    _edc.formLoaded = true;
  } catch (e) { if (body) body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  edcDataBodyRender();
}

function edcFieldHtml(f) {
  const key = f[0], label = f[1], type = f[2], cls = f[4] || '';
  const p = _edc.page;
  const val = _edc.form[key] === null || _edc.form[key] === undefined ? '' : String(_edc.form[key]);
  const required = p.data.required.indexOf(key) >= 0;
  const lbl = '<label class="fl" for="edcF-' + key + '">' + esc(label) + (required ? ' · обязательно' : '') + '</label>';
  let input;
  if (type === 'gender') {
    input = '<select id="edcF-gender" onchange="edcFormChanged()"><option value=""></option><option value="F"' + (val === 'F' ? ' selected' : '') + '>женский</option>'
      + '<option value="M"' + (val === 'M' ? ' selected' : '') + '>мужской</option></select>';
  } else {
    const t = type === 'date' ? 'date' : type === 'tel' ? 'tel' : type === 'email' ? 'email' : 'text';
    input = '<input type="' + t + '" id="edcF-' + key + '" value="' + escAttr(val) + '"' + (type === 'digits' ? ' inputmode="numeric"' : '') + ' oninput="edcFormChanged()">';
  }
  let hint = '';
  if (key === 'contract_no') {
    const nb = p.numbering || {};
    if (!val && nb.yclientsNo) hint = 'В YClients: № ' + nb.yclientsNo + ' — он и пойдёт в договор';
    else if (!val && nb.auto && nb.next) hint = 'Пусто — номер присвоится при отправке: ' + nb.next;
  }
  return '<div class="fg edc-f ' + cls + '" id="edcW-' + key + '">' + lbl + input + (hint ? '<div class="ed-sub">' + esc(hint) + '</div>' : '') + '</div>';
}

function edcDataBodyRender() {
  const body = edcEl('edcDataBody');
  if (!body || !_edc.formLoaded) return;
  const id = _edc.clientId;
  let fields = '';
  for (const f of EDC_FIELDS) {
    if (f[3]) fields += '<div class="edc-sect">' + esc(f[3]) + '</div>';
    fields += edcFieldHtml(f);
  }
  body.innerHTML = '<div class="edc-tools"><label class="btn btn-sec btn-sm ed-file">📷 Распознать паспорт по фото<input type="file" accept="image/*" onchange="edcRecognize(this)"></label>'
    + '<button class="btn btn-sec btn-sm" onclick="edcPrefill()">↻ Подставить из YClients</button>'
    + '<button class="btn btn-sec btn-sm" onclick="edFormOpen(' + id + ')">✉ Анкета пациенту</button></div>'
    + (_edc.notes.length ? '<div class="ed-note">' + _edc.notes.map(esc).join('<br>') + '</div>' : '')
    + '<div class="edc-fields">' + fields + '</div>'
    + '<div class="ed-actions"><button class="btn btn-pri" id="edcSaveBtn" onclick="edcSaveIdentity()">Сохранить данные</button>'
    + '<span class="ed-sub" id="edcIdentityState">' + (_edc.unsaved ? 'Данные ещё не сохранены' : 'Сохранено') + '</span></div>';
  edcMarkMissing();
}

/** Подсветить недостающие обязательные поля по ТЕКУЩИМ значениям формы. */
function edcMarkMissing() {
  const p = _edc.page;
  if (!p || !_edc.formLoaded) return;
  const miss = new Set(p.data.missing.map((x) => x.key));
  for (const f of EDC_FIELDS) {
    const w = edcEl('edcW-' + f[0]);
    if (w) w.classList.toggle('miss', miss.has(f[0]) && !String(_edc.form[f[0]] || '').trim());
  }
}

function edcCaptureForm() {
  if (!_edc.form) return;
  for (const f of EDC_FIELDS) {
    const el = edcEl('edcF-' + f[0]);
    if (el) _edc.form[f[0]] = el.value;
  }
}
function edcFormChanged() {
  edcCaptureForm();
  _edc.unsaved = true;
  const s = edcEl('edcIdentityState');
  if (s) s.textContent = 'Есть несохранённые изменения';
  edcMarkMissing();
  edcSendRender();
}

async function edcSaveIdentity() {
  edcCaptureForm();
  const btn = edcEl('edcSaveBtn');
  if (btn) btn.disabled = true;
  try {
    await api('PUT', '/api/edocs/clients/' + _edc.clientId + '/identity', edIdentityBody((k) => _edc.form[k], _edc.source));
    _edc.unsaved = false;
    _edc.source = 'manual';
    _edc.notes = [];
    notify('Данные пациента сохранены');
    await edcLoad(_ed.loadSeq, true);
    edcDataBodyRender();
  } catch (e) { notify(e.message, 'err'); } finally { if (btn) btn.disabled = false; }
}

async function edcPrefill() {
  try {
    const pre = await api('GET', '/api/edocs/clients/' + _edc.clientId + '/identity/prefill');
    edcCaptureForm();
    let n = 0;
    for (const [k, v] of Object.entries(Object.assign({}, pre.plain, pre.secure))) {
      if (v && !String(_edc.form[k] || '').trim()) { _edc.form[k] = v; n++; }
    }
    _edc.notes = (pre.notes || []).slice();
    if (n) _edc.unsaved = true;
    edcDataBodyRender();
    notify(n ? 'Подставлено полей: ' + n + ' — проверьте и сохраните' : 'Пустых полей, которые знает YClients, нет');
  } catch (e) { notify(e.message, 'err'); }
}

async function edcRecognize(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const id = _edc.clientId;
  const fd = new FormData();
  fd.append('photo', file);
  notify('Распознаём паспорт…');
  const r = await edFetch('POST', '/api/edocs/clients/' + id + '/identity/recognize', { form: fd });
  if (!r.ok) { notify(r.body.error || 'Не удалось распознать', 'err'); if (r.body.code === 'fdoc_no_credentials' || r.body.code === 'fdoc_credentials_invalid') edOpenMe(); return; }
  if (_edc.clientId !== id) return;
  edcCaptureForm();
  Object.assign(_edc.form, r.body.plain || {}, r.body.secure || {});
  _edc.source = 'recognize';
  _edc.unsaved = true;
  _edc.notes = [r.body.confidence ? 'Поля заполнены по фото — проверьте их и нажмите «Сохранить данные»' : 'Распознано неуверенно — внимательно проверьте каждое поле'];
  if (r.body.spoofing && r.body.spoofing.length) _edc.notes.push('F.Doc сомневается в подлинности снимка (' + r.body.spoofing.join(', ') + ') — сверьте с оригиналом паспорта');
  edcDataBodyRender();
}

// ── карточки документов ──
function edcTone(st) {
  if (st.state === 'signed') return 'green';
  if (st.state === 'pending') return 'blue';
  if (EDC_BAD.indexOf(st.state) >= 0) return _edc.page.header.color === 'amber' ? 'amber' : 'red';
  return 'grey';
}
function edcDocCard(kind, tpl, st, visit) {
  const sel = _edc.selected.has(tpl.id);
  const icon = { contract: '📜', consent_pd: '🔒', act: '🧾', other: '📄' }[kind] || '📄';
  const title = kind === 'act' && visit ? tpl.title + ' · визит ' + edFmtDate(visit.day) : tpl.title;
  const neuter = kind === 'consent_pd';
  let cls = 'ed-c-' + edcTone(st), sub = '', status = '', acts = '', badge = '', selectable = false;
  const icons = (withEdit) => '<button class="edc-ib" title="Посмотреть документ (DOCX)" onclick="event.stopPropagation();edcPreview(' + tpl.id + ')">👁</button>'
    + (withEdit ? '<button class="edc-ib" title="Ручная правка" onclick="event.stopPropagation();edcEdit(\'' + kind + '\',' + tpl.id + ')">✎</button>' : '')
    + '<button class="edc-ib" title="Подписано на бумаге" onclick="event.stopPropagation();edcPaperOpen(' + tpl.id + ')">📎</button>';
  if (st.state === 'signed') {
    cls += ' done';
    badge = neuter ? 'Подписано' : 'Подписан';
    sub = badge + ' ' + edFmtDateTime(st.at).slice(0, 10) + (st.paper ? ' на бумаге' : ' по SMS');
    status = '✓ ' + badge;
    acts = st.packageId ? '<button class="edc-ib" title="Комплект" onclick="event.stopPropagation();edGo(\'p/' + st.packageId + '\')">📂</button>' : '';
  } else if (st.state === 'pending') {
    cls += ' done';
    badge = 'Ждём подпись';
    sub = 'Отправлен ' + edFmtDateTime(st.at) + ' — пациент подписывает по SMS-ссылке';
    status = '● Ждём подпись';
    acts = '<button class="edc-ib" title="Отправить ссылку ещё раз" onclick="event.stopPropagation();edcRemind(\'' + st.packageId + '\')">↻</button>'
      + '<button class="edc-ib" title="Комплект" onclick="event.stopPropagation();edGo(\'p/' + st.packageId + '\')">📂</button>';
  } else if (EDC_BAD.indexOf(st.state) >= 0) {
    selectable = true;
    sub = kind === 'act' ? (st.state === 'missing' ? 'Визит оплачен в YClients — нужен акт' : '')
      : (st.state === 'missing' ? 'Обязателен до визита' : '');
    if (st.state === 'lapsed') sub = 'Прошлая ссылка: ' + ({ expired: 'срок истёк', declined: 'пациент отказался', annulled: 'аннулирована' }[st.reason] || 'не действует');
    if (st.state === 'problem') sub = 'Прошлая отправка не ушла' + (st.error ? ': ' + st.error : '');
    status = '● ' + (neuter ? 'Не подписано' : 'Не подписан');
    acts = icons(true);
  } else if (kind === 'act' && (st.state === 'later' || st.state === 'unpaid')) {
    cls += ' na';
    sub = st.state === 'later' ? 'Визит ещё не состоялся — акт после оплаты' : 'Визит не оплачен в YClients — акт после оплаты';
    status = '○ После визита';
  } else if (kind === 'act' && st.state === 'off' && st.reason === 'before_start') {
    selectable = true;
    sub = 'Визит до ' + edFmtDate(_edc.page.actsRequiredFrom) + ' — акт не обязателен, но его можно отправить';
    status = '○ Не обязателен';
    acts = icons(true);
  } else {
    cls += ' na';
    sub = 'Нет шаблона';
  }
  if (selectable && sel) cls += ' sel';
  return '<article class="edc-doc ' + cls + '"' + (selectable ? ' onclick="edcToggle(' + tpl.id + ')"' : '') + '>'
    + (selectable ? '<span class="edc-chk">' + (sel ? '✓' : '') + '</span>' : (badge ? '<span class="edc-badge">' + esc(badge) + '</span>' : ''))
    + '<div class="edc-sheet">' + icon + '</div><h3>' + esc(title) + '</h3><div class="edc-dsub">' + esc(sub) + '</div>'
    + '<div class="edc-dst">' + esc(status) + '<span class="edc-dact">' + acts + '</span></div></article>';
}

function edcDocsRender() {
  const p = _edc.page;
  const el = edcEl('edcDocs');
  if (!el) return;
  const cards = [];
  const missingTpl = (label) => '<article class="edc-doc na"><div class="edc-sheet">📄</div><h3>' + esc(label) + '</h3><div class="edc-dsub">Шаблон не загружен'
    + (edIsAdmin() ? ' — <a href="#edocs/settings">загрузить в настройках</a>' : ' — обратитесь к администратору') + '</div></article>';
  for (const k of ['contract', 'consent_pd']) cards.push(p.kinds[k] ? edcDocCard(k, p.kinds[k], p.docs[k]) : missingTpl(ED_KIND_LABELS[k]));
  const focus = edcFocus();
  if (p.kinds.act) {
    if (focus) cards.push(edcDocCard('act', p.kinds.act, focus.act, focus));
    else cards.push('<article class="edc-doc na"><div class="edc-sheet">🧾</div><h3>' + esc(p.kinds.act.title) + '</h3><div class="edc-dsub">Появится после оплаченного визита</div></article>');
  }
  for (const t of p.templates.filter((x) => x.kind === 'other')) {
    const sel = _edc.selected.has(t.id);
    cards.push('<article class="edc-doc ed-c-grey' + (sel ? ' sel' : '') + '" onclick="edcToggle(' + t.id + ')"><span class="edc-chk">' + (sel ? '✓' : '') + '</span>'
      + '<div class="edc-sheet">📄</div><h3>' + esc(t.title) + '</h3><div class="edc-dsub">Дополнительный документ — по необходимости</div>'
      + '<div class="edc-dst">○ По необходимости<span class="edc-dact"><button class="edc-ib" title="Посмотреть документ (DOCX)" onclick="event.stopPropagation();edcPreview(' + t.id + ')">👁</button>'
      + '<button class="edc-ib" title="Подписано на бумаге" onclick="event.stopPropagation();edcPaperOpen(' + t.id + ')">📎</button></span></div></article>');
  }
  el.innerHTML = cards.join('');
}

function edcTemplate(id) { return (_edc.page && _edc.page.templates.find((t) => t.id === id)) || null; }
function edcSelectedTemplates() { return [..._edc.selected].map(edcTemplate).filter(Boolean); }
function edcToggle(id) {
  const t = edcTemplate(id);
  if (!t) return;
  if (_edc.selected.has(id)) _edc.selected.delete(id); else _edc.selected.add(id);
  _edc.missingSel = null;
  edcDocsRender();
  edcSendRender();
  edcCheck();
}

/** Проверка выбранного набора на сервере: каких данных не хватает именно ему. */
async function edcCheck() {
  const ids = [..._edc.selected];
  if (!ids.length || !_edc.page) { _edc.missingSel = null; edcSendRender(); return; }
  _edc.checking = true;
  try {
    const r = await api('POST', '/api/edocs/packages/check', { clientId: _edc.clientId, templateIds: ids });
    if (String([..._edc.selected]) !== String(ids)) return;   // выбор сменился, пока проверяли
    _edc.missingSel = r.missing;
  } catch (e) { _edc.missingSel = null; } finally { _edc.checking = false; }
  edcSendRender();
}

function edcBlockReason() {
  if (!_edc.selected.size) return 'Нажмите на карточку документа, чтобы добавить его в отправку';
  if (_edc.unsaved) return 'Сохраните данные пациента: документы заполняются из сохранённых данных';
  const t = edMissingText(_edc.missingSel);
  if (t) return t;
  return edSendBlockReason();
}

function edcSendRender() {
  const el = edcEl('edcSend');
  if (!el || !_edc.page) return;
  const sel = edcSelectedTemplates();
  const reason = edcBlockReason();
  const phone = _edc.page.client.phone ? edPhone(_edc.page.client.phone) : 'номер не указан';
  el.innerHTML = '<div class="grow">' + esc(sel.length ? 'Выбрано: ' + sel.map((t) => t.title).join(', ') : 'Ничего не выбрано')
    + '<small>' + esc(reason || ('SMS-ссылка F.Doc на ' + phone + ' · пациент подпишет кодом из SMS')) + '</small></div>'
    + '<button class="btn btn-sec btn-sm" onclick="edcPaperOpen()">Подписано на бумаге</button>'
    + '<button class="btn btn-sec btn-sm" onclick="edcPreviewSelected()">Предпросмотр</button>'
    + '<button class="btn btn-pri" id="edcSendBtn" onclick="edcSend()"' + (reason || _ed.sending ? ' disabled' : '') + '>' + (_ed.sending ? 'Отправляем…' : 'Отправить на подпись →') + '</button>';
}

/** Тело запроса к /packages и /packages/preview: визит и правленые строки, если в наборе акт. */
function edcActFields(body, templateIds) {
  const act = _edc.page.kinds.act;
  if (!act || templateIds.indexOf(act.id) < 0) return null;
  const focus = edcFocus();
  if (!focus) return 'Выберите визит для акта';
  body.recordId = focus.recordId;
  if (_edc.actEdited && _edc.act && _edc.act.recordId === focus.recordId) {
    const lines = edCollectActLines(_edc.act.rows);
    if (lines.error) return lines.error;
    body.actLines = lines.value;
  }
  return null;
}

async function edcSend() {
  if (_ed.sending || edcBlockReason()) return;
  const ids = [..._edc.selected];
  const body = { clientId: _edc.clientId, templateIds: ids, docDate: _edc.docDate || null };
  const err = edcActFields(body, ids);
  if (err) return notify(err, 'err');
  const titles = edcSelectedTemplates().map((t) => '<li>' + esc(t.title) + '</li>').join('');
  const actNote = body.recordId && _edc.act && _edc.act.rows ? '<div class="ed-sub" style="margin-top:6px">Акт: итого '
    + esc(edMoney(edActTotals(_edc.act.rows.filter((r) => r.include)).total)) + (_edc.actEdited ? ' (строки поправлены вручную)' : '') + '</div>' : '';
  const ok = await edConfirm({ title: 'Отправить на подпись?', ok: 'Отправить',
    html: '<b>' + esc(_edc.page.client.name) + '</b> получит SMS со ссылкой и подпишет документы кодом из SMS.<ul style="margin:8px 0 0 18px">' + titles + '</ul>' + actNote });
  if (!ok) return;
  _ed.sending = true;
  edcSendRender();
  let r;
  try { r = await edFetch('POST', '/api/edocs/packages', { json: body }); } finally { _ed.sending = false; }
  const out = edSendOutcome(r);
  if (out === 'package') return;
  if (out === 'rejected') {
    if (r.body && r.body.code === 'missing_fields') _edc.missingSel = r.body.missing;
    edcSendRender();
    return;
  }
  _edc.selected = new Set();
  _edc.actEdited = false;
  await edcLoad(_ed.loadSeq, true);
  edcSchedule();
}

async function edcPreview(templateId) {
  const body = { clientId: _edc.clientId, templateId: templateId, docDate: _edc.docDate || null };
  const err = edcActFields(body, [templateId]);
  if (err) return notify(err, 'err');
  try {
    const r = await api('POST', '/api/edocs/packages/preview', body);
    edDownloadBase64(r.base64, r.fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    if (_edc.unsaved) notify('Документ собран по СОХРАНЁННЫМ данным — сохраните изменения, чтобы они попали в документ');
  } catch (e) { notify(e.message, 'err'); }
}
function edcPreviewSelected() {
  const ids = [..._edc.selected];
  if (!ids.length) return notify('Выберите документ', 'err');
  ids.slice(0, 3).forEach((id) => edcPreview(id));
}

async function edcRemind(packageId) {
  const ok = await edConfirm({ title: 'Отправить ссылку ещё раз?', ok: 'Отправить', html: 'Пациент получит SMS со ссылкой на подписание ещё раз.' });
  if (!ok) return;
  try { await api('POST', '/api/edocs/packages/' + packageId + '/permalink'); notify('Ссылка отправлена пациенту ещё раз'); }
  catch (e) { notify(e.message, 'err'); if (/Мой F\.Doc/.test(e.message)) edOpenMe(); }
}

// ── ручная правка ──
function edcEdit(kind, templateId) {
  if (kind === 'act') return edcActEdit();
  return edcDocEdit(kind, templateId);
}

function edcActEdit() {
  const a = _edc.act;
  const box = edcEl('edActBody');
  if (!box) return;
  if (!a || a.error) { notify((a && a.error) || 'Выберите визит для акта', 'err'); return; }
  const cell = (i, key, val, mode) => '<td><input type="text"' + (mode ? ' inputmode="decimal"' : '') + ' value="' + escAttr(String(val === null || val === undefined ? '' : val))
    + '" oninput="edcActCell(' + i + ',\'' + key + '\',this.value)"></td>';
  box.innerHTML = '<div class="ed-sub">Врач: ' + esc(a.doctor.name || '—') + (a.doctor.position ? ', ' + esc(a.doctor.position) : '') + ' · визит ' + esc(edFmtDate(a.visitDate))
    + ' · номер акта ' + esc(a.actNo) + '. Правка действует только для этого акта.</div>'
    + '<div class="tw mtbl-wrap"><table class="ed-act-edit mtbl"><thead><tr><th></th><th>Услуга</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>'
    + a.rows.map((r, i) => '<tr class="' + (r.include ? '' : 'off') + '"><td><input type="checkbox"' + (r.include ? ' checked' : '') + ' onchange="edcActCell(' + i + ',\'include\',this.checked)"></td>'
      + cell(i, 'title', r.title) + cell(i, 'qty', r.qty, true) + cell(i, 'price', r.price, true) + cell(i, 'sum', r.sum, true) + '</tr>').join('')
    + '</tbody></table></div><div class="ed-actions"><button class="btn btn-sec btn-sm" onclick="edcActAdd()">＋ Строка</button>'
    + '<button class="btn btn-sec btn-sm" onclick="edcActReset()">↺ Как в YClients</button><span class="ed-total" id="edcActTotal"></span></div>'
    + '<div id="edcActDiff"></div><div class="ed-actions"><button class="btn btn-pri" onclick="edcActSave()">Сохранить</button>'
    + '<button class="btn btn-sec" onclick="edcPreviewAct()">Предпросмотр</button></div>';
  openModal('edActModal');
  edcActTotal();
}
function edcActCell(i, key, val) {
  _edc.act.rows[i][key] = val;
  if (key === 'include') edcActEdit(); else edcActTotal();
}
function edcActAdd() { _edc.act.rows.push({ include: true, title: '', qty: 1, price: 0, sum: 0, service_id: null }); edcActEdit(); }
async function edcActReset() { const id = _edc.act.recordId; await edcLoadAct(id); edcActEdit(); edcSendRender(); }
function edcActTotal() {
  const a = _edc.act;
  const total = edActTotals(a.rows.filter((r) => r.include)).total;
  const el = edcEl('edcActTotal');
  if (el) el.textContent = 'Итого: ' + edMoney(total);
  const diff = edcEl('edcActDiff');
  if (diff) diff.innerHTML = Math.abs(total - Number(a.defaultTotal || 0)) > 0.004
    ? '<div class="ed-diff">Итог отличается от записи YClients (' + esc(edMoney(a.defaultTotal)) + '). Проверьте строки перед отправкой.</div>' : '';
}
function edcActSave() {
  const lines = edCollectActLines(_edc.act.rows);
  if (lines.error) return notify(lines.error, 'err');
  _edc.actEdited = true;
  closeModal('edActModal');
  notify('Строки акта сохранены — они уйдут в документ при отправке');
  edcSendRender();
}
function edcPreviewAct() {
  const lines = edCollectActLines(_edc.act.rows);
  if (lines.error) return notify(lines.error, 'err');
  _edc.actEdited = true;
  edcPreview(_edc.page.kinds.act.id);
}

async function edcDocEdit(kind, templateId) {
  const box = edcEl('edDocBody');
  const t = edcTemplate(templateId);
  if (!box || !t) return;
  edcEl('edDocTitle').textContent = 'Правка: ' + t.title;
  let html = '<div class="ed-sub" style="margin-bottom:10px">Значения, которые подставятся в документ. Шаблон клиники не меняется.</div>';
  if (kind === 'contract') {
    if (!_edc.formLoaded) { box.innerHTML = '<div class="empty">Загрузка…</div>'; openModal('edDocModal'); await edcLoadIdentity(); }
    const nb = _edc.page.numbering || {};
    const ph = nb.yclientsNo ? 'из YClients: ' + nb.yclientsNo : nb.auto && nb.next ? 'присвоится при отправке: ' + nb.next : '';
    html += '<div class="fg"><label class="fl" for="edcE-no">Номер договора</label><input id="edcE-no" value="' + escAttr(_edc.form.contract_no || '') + '" placeholder="' + escAttr(ph) + '"></div>'
      + '<div class="fg"><label class="fl" for="edcE-date">Дата договора</label><input type="date" id="edcE-date" value="' + escAttr(_edc.form.contract_date || '') + '"></div>';
  }
  html += '<div class="fg"><label class="fl" for="edcE-doc">Дата документа (пусто — сегодня)</label><input type="date" id="edcE-doc" value="' + escAttr(_edc.docDate) + '"></div>'
    + '<div class="ed-actions"><button class="btn btn-pri" onclick="edcDocSave(\'' + kind + '\',' + templateId + ')">Сохранить</button>'
    + '<button class="btn btn-sec" onclick="edcDocSave(\'' + kind + '\',' + templateId + ',true)">Предпросмотр</button></div>';
  box.innerHTML = html;
  openModal('edDocModal');
}
async function edcDocSave(kind, templateId, preview) {
  _edc.docDate = edVal('edcE-doc');
  if (kind === 'contract') {
    const no = edVal('edcE-no').trim(), date = edVal('edcE-date');
    if (no !== String(_edc.form.contract_no || '') || date !== String(_edc.form.contract_date || '')) {
      _edc.form.contract_no = no;
      _edc.form.contract_date = date;
      try {
        await api('PUT', '/api/edocs/clients/' + _edc.clientId + '/identity', edIdentityBody((k) => _edc.form[k], 'manual'));
        _edc.unsaved = false;
      } catch (e) { return notify(e.message, 'err'); }
      await edcLoad(_ed.loadSeq, true);
      if (edcEl('edcData') && edcEl('edcData').open) edcDataBodyRender();
    }
  }
  if (preview) return edcPreview(templateId);
  closeModal('edDocModal');
  notify('Сохранено');
}

// ── «Подписано на бумаге» ──
function edcPaperOpen(templateId) {
  const p = _edc.page;
  const box = edcEl('edPaperBody');
  if (!box || !p) return;
  const focus = edcFocus();
  const pre = templateId ? new Set([templateId]) : new Set(_edc.selected);
  const opts = [];
  for (const k of ['contract', 'consent_pd']) if (p.kinds[k]) opts.push({ t: p.kinds[k], label: p.kinds[k].title });
  if (p.kinds.act && focus && focus.arrived) opts.push({ t: p.kinds.act, label: p.kinds.act.title + ' · визит ' + edFmtDate(focus.day) });
  for (const t of p.templates.filter((x) => x.kind === 'other')) opts.push({ t, label: t.title });
  box.innerHTML = '<div class="ed-sub" style="margin-bottom:8px">Документ будет считаться подписанным. Приложите фото или скан — он сохранится у пациента.</div>'
    + opts.map((o) => '<label class="ed-switch"><input type="checkbox" class="edcP-t" value="' + o.t.id + '"' + (pre.has(o.t.id) ? ' checked' : '') + '> ' + esc(o.label) + '</label>').join('')
    + '<div class="fg" style="margin-top:10px"><label class="fl" for="edcP-date">Дата подписания</label><input type="date" id="edcP-date" value="' + escAttr(p.today) + '"></div>'
    + '<div class="fg"><label class="fl" for="edcP-note">Комментарий</label><input id="edcP-note" placeholder="необязательно"></div>'
    + '<div class="fg"><label class="fl" for="edcP-file">Скан или фото (JPG, PNG, WEBP, PDF до 10 МБ)</label><input type="file" id="edcP-file" accept="image/jpeg,image/png,image/webp,application/pdf"></div>'
    + '<div class="ed-actions"><button class="btn btn-pri" id="edcP-btn" onclick="edcPaperSave()">Отметить подписанным</button><button class="btn btn-sec" onclick="closeModal(\'edPaperModal\')">Отмена</button></div>';
  openModal('edPaperModal');
}
async function edcPaperSave() {
  const ids = Array.from(document.querySelectorAll('.edcP-t')).filter((c) => c.checked).map((c) => Number(c.value));
  if (!ids.length) return notify('Отметьте документы', 'err');
  const fd = new FormData();
  fd.append('templateIds', ids.join(','));
  const act = _edc.page.kinds.act;
  const focus = edcFocus();
  if (act && ids.indexOf(act.id) >= 0 && focus) fd.append('recordId', String(focus.recordId));
  fd.append('signedDate', edVal('edcP-date'));
  fd.append('note', edVal('edcP-note'));
  const file = edcEl('edcP-file').files[0];
  if (file) fd.append('scan', file);
  const btn = edcEl('edcP-btn');
  if (btn) btn.disabled = true;
  const r = await edFetch('POST', '/api/edocs/clients/' + _edc.clientId + '/paper', { form: fd });
  if (btn) btn.disabled = false;
  if (!r.ok) return notify(r.body.error || ('Ошибка ' + r.status), 'err');
  closeModal('edPaperModal');
  notify('Отмечено: подписано на бумаге');
  for (const id of ids) _edc.selected.delete(id);
  await edcLoad(_ed.loadSeq, true);
}

// ── визиты и история ──
function edcVisitsRender() {
  const p = _edc.page;
  const el = edcEl('edcVisits');
  if (!el) return;
  if (!p.visits.length) { el.innerHTML = '<li class="ed-sub">Визитов за последние 90 дней и ближайший месяц нет</li>'; return; }
  const dot = { ok: 'green', wait: 'blue', no: 'red', soon: 'amber', na: 'grey' };
  el.innerHTML = p.visits.map((v) => '<li class="click' + (v.recordId === p.focusRecordId ? ' focus' : '') + '" onclick="edcSetFocus(' + v.recordId + ')">'
    + '<span class="edc-tdot ed-c-' + (dot[v.tile.tone] || 'grey') + '" style="background:var(--c)"></span><time>' + esc(edFmtDate(v.day).slice(0, 5) + (v.time ? ' · ' + v.time : '')) + '</time>'
    + '<span class="grow">' + esc(v.services.join(', ') || '—') + (v.staffName ? ' · ' + esc(v.staffName) : '') + ' — акт: ' + esc(v.tile.text) + '</span></li>').join('');
}
async function edcSetFocus(recordId) {
  if (!_edc.page || recordId === _edc.page.focusRecordId) return;
  _edc.recordId = recordId;
  _ed.route = { view: 'client', clientId: _edc.clientId, recordId };
  history.replaceState(null, '', '#edocs/' + edTailOf(_ed.route));
  const act = _edc.page.kinds.act;
  if (act) _edc.selected.delete(act.id);
  await edcLoad(_ed.loadSeq, true);
  const focus = edcFocus();
  if (act && focus && EDC_BAD.indexOf(focus.act.state) >= 0) { _edc.selected.add(act.id); edcDocsRender(); edcSendRender(); edcCheck(); }
}

function edcHistoryRender() {
  const p = _edc.page;
  const el = edcEl('edcHistory');
  if (!el) return;
  if (!p.events.length) { el.innerHTML = '<li class="ed-sub">Событий пока нет</li>'; return; }
  const color = (k) => (/error|revoke|expired/.test(k) ? 'red' : /sent|send|permalink|form_created|form_opened/.test(k) ? 'blue' : /paper|submitted|pdf|docs_sent/.test(k) ? 'green' : 'grey');
  el.innerHTML = p.events.map((e) => '<li' + (e.packageId ? ' class="click" onclick="edGo(\'p/' + e.packageId + '\')"' : '') + '>'
    + '<span class="edc-tdot ed-c-' + color(e.kind) + '" style="background:var(--c)"></span><time>' + esc(edFmtDateTime(e.createdAt)) + '</time><span class="grow">'
    + esc(ED_EVENT_LABELS[e.kind] || e.kind) + (e.kind === 'status' && e.payload && e.payload.to ? ': ' + esc(edStatusInfo(e.payload.to).label) : '')
    + (e.kind === 'contract_no' && e.payload && e.payload.contractNo ? ' № ' + esc(e.payload.contractNo) : '')
    + (e.payload && e.payload.channel ? ' (' + esc(ED_VIA[e.payload.channel] || e.payload.channel) + ')' : '')
    + (e.userName ? ' · ' + esc(e.userName) : '') + '</span></li>').join('');
}

// ── анкета пациента: окно с QR и ссылкой (страница пациента и дашборд) ──
async function edFormOpen(clientId, opts) {
  opts = opts || {};
  const box = edcEl('edFormBody');
  if (!box) return;
  box.innerHTML = '<div class="empty">Готовим ссылку…</div>';
  openModal('edFormModal');
  const page = _edc.page && _edc.page.client.id === clientId ? _edc.page : null;
  const active = opts.formId || (page && page.form && page.form.status === 'active' ? page.form.id : null);
  let f;
  try {
    f = active ? await api('GET', '/api/edocs/forms/' + active + '/link')
      : await api('POST', '/api/edocs/clients/' + clientId + '/forms', { deliver: 'none', sendDocs: edCanSend(), recordId: opts.recordId || null });
  } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  _edForm = Object.assign({ clientId: clientId }, f);
  edFormRender('');
  if (!active) edRefreshView();
}
function edFormRender(note) {
  const f = _edForm;
  const box = edcEl('edFormBody');
  if (!box || !f) return;
  box.innerHTML = '<div class="ed-qr"><img src="' + escAttr(f.qr) + '" alt="QR-код анкеты"><div class="grow"><div style="font-size:13px;line-height:1.5">'
    + 'Пациент сканирует код своим телефоном и сам вносит паспорт — вводить ничего не нужно.' + (edCanSend() ? ' Сразу после заполнения документы уйдут на подпись.' : '')
    + '</div><div class="ed-urlbox">' + esc(f.url) + '</div><div class="ed-sub">Ссылка действует до ' + esc(edFmtDateTime(f.expiresAt)) + '</div></div></div>'
    + (note ? '<div class="ed-note" style="margin-top:10px">' + esc(note) + '</div>' : '')
    + '<div class="ed-actions"><button class="btn btn-pri" id="edFormSendBtn" onclick="edFormSend()">✉ Отправить в мессенджер</button>'
    + '<button class="btn btn-sec" onclick="edFormCopy()">Скопировать ссылку</button><button class="btn btn-sec btn-dng" onclick="edFormRevoke()">Отозвать</button>'
    + '<button class="btn btn-sec" onclick="closeModal(\'edFormModal\')">Готово</button></div>';
}
async function edFormSend() {
  const f = _edForm;
  if (!f) return;
  const btn = edcEl('edFormSendBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/api/edocs/forms/' + f.formId + '/send');
    edFormRender(r.ok ? 'Отправлено в ' + (ED_VIA[r.channel] || r.channel) + '. Как только пациент заполнит анкету, страница обновится сама.'
      : 'Не доставлено: ' + (r.error || 'нет ответа') + ' — покажите пациенту QR-код.');
  } catch (e) { edFormRender(e.message); }
  edRefreshView();
}
function edFormCopy() {
  const f = _edForm;
  if (!f) return;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(f.url).then(() => notify('Ссылка скопирована'), () => notify('Не удалось скопировать — выделите ссылку вручную', 'err'));
  else notify('Выделите ссылку и скопируйте вручную', 'err');
}
async function edFormRevoke() {
  const f = _edForm;
  if (!f || !confirm('Отозвать анкету? Ссылка перестанет работать.')) return;
  try { await api('POST', '/api/edocs/forms/' + f.formId + '/revoke'); notify('Анкета отозвана'); closeModal('edFormModal'); _edForm = null; }
  catch (e) { notify(e.message, 'err'); }
  edRefreshView();
}
