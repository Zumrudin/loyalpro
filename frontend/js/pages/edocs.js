// ── «📄 ДОКУМЕНТЫ»: электронное подписание с пациентами через F.Doc ─────────────
// Адрес: #edocs — комплекты; #edocs/new[/<клиент>[/<запись>]] — оформление (с записью — акт);
// #edocs/p/<комплект> — карточка; #edocs/settings — настройки (владелец, администратор).
// Состояние — в hash: F5 и «Назад» возвращают туда же (хук edocsOnHashArg в nav.js).
// Зависимости: api(), esc(), escAttr(), notify(), showLbar(), openModal()/closeModal(),
// помощники edocs-helpers.js. Глобальные имена — с префиксом ed/ED_ (общая область скриптов).
let _ed = { state: null, route: { view: 'list' }, timer: null, listStatus: '', listFrom: '', listTo: '', w: null, pkg: null };
const ED_POLL_MS = 30000;
let _edSearchTimer = null;
let _edSearchSeq = 0;

function edTail() { return (location.hash || '').slice(1).split('/').slice(1).map(decodeURIComponent).join('/'); }
function loadEdocs() { edRoute(edTail()); }
function edocsOnHashArg(arg) { edRoute(arg || ''); }
function edGo(tail) {
  const h = tail ? 'edocs/' + tail : 'edocs';
  if ((location.hash || '').slice(1) === h) edRoute(tail || ''); else location.hash = h;
}
function edStopPolling() { if (_ed.timer) { clearInterval(_ed.timer); _ed.timer = null; } }
function edIsAdmin() { return typeof ME !== 'undefined' && !!ME && (ME.role === 'owner' || ME.role === 'admin'); }

// fetch, который сохраняет всё тело ответа (api() оставляет только error): нужны
// packageId, missing, details. Файлы — FormData, JSON — opts.json.
async function edFetch(method, path, opts) {
  opts = opts || {};
  const headers = { Authorization: 'Bearer ' + localStorage.getItem('lp_tk') };
  let body;
  if (opts.form) body = opts.form;
  else if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  showLbar(true);
  try {
    const r = await fetch(path, { method: method, headers: headers, body: body });
    let j = {};
    try { j = (await r.json()) || {}; } catch (_) { /* пустое тело или HTML */ }
    return { ok: r.ok, status: r.status, body: j };
  } finally { showLbar(false); }
}

// Окно открываем ДО await: иначе блокировщик всплывающих окон съест window.open.
async function edOpenAsync(getUrl) {
  const win = window.open('about:blank', '_blank');
  try {
    const url = await getUrl();
    if (win) { win.opener = null; win.location.href = url; } else { window.location.href = url; }
  } catch (e) { if (win) win.close(); notify(e.message, 'err'); }
}

function edDownloadBase64(b64, name, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function edRoute(tail) {
  edStopPolling();
  let route = edParseTail(tail);
  if (route.view === 'settings' && !edIsAdmin()) { history.replaceState(null, '', '#edocs'); route = { view: 'list' }; }
  _ed.route = route;
  for (const v of ['list', 'new', 'package', 'settings']) {
    const el = document.getElementById('edView-' + v);
    if (el) el.style.display = v === route.view ? '' : 'none';
  }
  for (const t of ['list', 'new', 'settings']) {
    const b = document.getElementById('edTabBtn-' + t);
    if (b) b.classList.toggle('active', t === route.view || (t === 'list' && route.view === 'package'));
  }
  const sb = document.getElementById('edTabBtn-settings');
  if (sb) sb.style.display = edIsAdmin() ? '' : 'none';
  await edLoadState();
  if (route.view === 'new') return edRenderNew(route);
  if (route.view === 'package') return edRenderPackage(route.packageId);
  if (route.view === 'settings') return edRenderSettings();
  return edRenderList();
}

async function edLoadState() {
  try { _ed.state = await api('GET', '/api/edocs/state'); } catch (e) { _ed.state = null; }
  const s = _ed.state;
  const me = document.getElementById('edMeStatus');
  if (me) me.textContent = !s ? '' : s.me.connected ? (s.me.broken ? '⚠ F.Doc: обновите пароль' : 'F.Doc: ' + s.me.login) : 'F.Doc не подключён';
  const note = document.getElementById('edNotice');
  if (!note) return;
  const msgs = [];
  if (s && !s.encReady) msgs.push('На сервере не задан ключ шифрования EDOCS_ENC_KEY — данные пациентов сохранять нельзя.');
  if (s && !s.enabled) msgs.push(edIsAdmin() ? 'Модуль выключен. Подключите F.Doc во вкладке «Настройки».' : 'Модуль ещё не настроен — обратитесь к администратору.');
  else if (s && !s.me.connected) msgs.push('Чтобы отправлять документы, подключите свою учётную запись F.Doc: кнопка «Мой F.Doc».');
  note.innerHTML = msgs.map((m) => '<div class="ed-note">' + esc(m) + '</div>').join('');
}

// ── список комплектов ──
async function edRenderList() {
  const box = document.getElementById('edView-list');
  if (!box) return;
  box.innerHTML = '<div class="ed-toolbar"><select id="edListStatus" onchange="edSetListStatus(this.value)"><option value="">Все статусы</option>'
    + Object.keys(ED_STATUS).map((k) => '<option value="' + k + '"' + (_ed.listStatus === k ? ' selected' : '') + '>' + esc(ED_STATUS[k].label) + '</option>').join('')
    + '</select><input type="date" id="edListFrom" value="' + escAttr(_ed.listFrom) + '" onchange="edSetListPeriod()" title="Создан с">'
    + '<input type="date" id="edListTo" value="' + escAttr(_ed.listTo) + '" onchange="edSetListPeriod()" title="Создан по"></div><div class="card ed-tbl-card"><div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Создан</th><th>Пациент</th><th>Комплект</th><th>Статус</th><th>Отправил</th></tr></thead>'
    + '<tbody id="edListBody"><tr><td colspan="5" class="empty">Загрузка…</td></tr></tbody></table></div></div>';
  await edLoadList();
  _ed.timer = setInterval(edLoadList, ED_POLL_MS);
}
function edSetListStatus(v) { _ed.listStatus = v; edLoadList(); }
function edSetListPeriod() { _ed.listFrom = edVal('edListFrom'); _ed.listTo = edVal('edListTo'); edLoadList(); }
function edListQuery() {
  const q = [];
  if (_ed.listStatus) q.push('status=' + encodeURIComponent(_ed.listStatus));
  if (_ed.listFrom) q.push('from=' + encodeURIComponent(_ed.listFrom));
  if (_ed.listTo) q.push('to=' + encodeURIComponent(_ed.listTo));
  return q.length ? '?' + q.join('&') : '';
}
async function edLoadList() {
  const tb = document.getElementById('edListBody');
  if (!tb) return;
  try {
    const d = await api('GET', '/api/edocs/packages' + edListQuery());
    if (!d.rows.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Комплектов пока нет</td></tr>'; return; }
    tb.innerHTML = d.rows.map((p) => {
      const st = edStatusInfo(p.status);
      return '<tr class="ed-row" onclick="edGo(\'p/' + p.id + '\')">'
        + '<td data-label="Создан">' + esc(edFmtDateTime(p.createdAt)) + '</td>'
        + '<td class="mtbl-title"><strong>' + esc(p.clientName || '—') + '</strong> <span class="ed-sub">' + esc(edPhone(p.clientPhone)) + '</span></td>'
        + '<td data-label="Комплект">' + esc(p.title) + '</td>'
        + '<td data-label="Статус"><span class="badge ' + st.cls + '">' + esc(st.label) + '</span>'
        + (p.lastError && p.status === 'draft' ? '<div class="ed-err">' + esc(p.lastError) + '</div>' : '') + '</td>'
        + '<td data-label="Отправил">' + esc(p.sentByName || '—') + '</td></tr>';
    }).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="5" class="empty">' + esc(e.message) + '</td></tr>'; }
}

// ── оформление: пациент → данные → документы → отправка ──
function edSearchClients(q) {
  clearTimeout(_edSearchTimer);
  _edSearchTimer = setTimeout(() => edDoSearch(q), 300);
}
async function edDoSearch(q) {
  const box = document.getElementById('edClientResults');
  if (!box) return;
  const seq = ++_edSearchSeq;
  const query = String(q || '').trim();
  if (query.length < 2) { box.innerHTML = ''; return; }
  try {
    const d = await api('GET', '/api/edocs/clients?search=' + encodeURIComponent(query));
    if (seq !== _edSearchSeq) return;   // запоздалый ответ на прежний ввод
    box.innerHTML = d.clients.length ? d.clients.map((c) => '<div class="ed-result" onclick="edGo(\'new/' + c.id + '\')"><span><strong>' + esc(c.name)
      + '</strong> <span class="ed-sub">' + esc(edPhone(c.phone)) + '</span></span>' + (c.hasIdentity ? '<span class="badge bg">данные есть</span>' : '') + '</div>').join('')
      : '<div class="ed-sub">Никого не нашли</div>';
  } catch (e) { box.innerHTML = '<div class="ed-err">' + esc(e.message) + '</div>'; }
}

async function edRenderNew(route) {
  const box = document.getElementById('edView-new');
  if (!box) return;
  if (!route.clientId) {
    _ed.w = null;
    box.innerHTML = '<div class="card"><div class="ed-h">Пациент</div><input type="text" id="edClientSearch" placeholder="Фамилия, имя или телефон" autocomplete="off" oninput="edSearchClients(this.value)">'
      + '<div id="edClientResults" class="ed-results"></div></div>';
    const inp = document.getElementById('edClientSearch');
    if (inp) inp.focus();
    return;
  }
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  const w = { clientId: route.clientId, recordId: route.recordId, selected: new Set(), source: 'manual', docDate: '', notes: [], unsaved: false, act: null, visits: [] };
  _ed.w = w;
  try {
    const res = await Promise.all([
      api('GET', '/api/edocs/clients/' + w.clientId + '/summary'),
      api('GET', '/api/edocs/clients/' + w.clientId + '/identity'),
      api('GET', '/api/edocs/templates'),
    ]);
    const summary = res[0], ident = res[1];
    w.client = summary.client;
    w.templates = res[2].templates;
    if (ident.exists) {
      w.form = Object.assign({}, ident.plain, ident.secure);
    } else {
      const pre = await api('GET', '/api/edocs/clients/' + w.clientId + '/identity/prefill');
      w.form = Object.assign({}, pre.plain, pre.secure);
      w.notes = (pre.notes || []).slice();
      w.unsaved = true;
    }
    if (w.recordId) {
      const d = await api('GET', '/api/edocs/records/' + w.recordId + '/act-draft');
      if (d.record.clientId !== w.clientId) throw new Error('Визит не принадлежит этому пациенту');
      w.act = { visitDate: d.record.visitDate, actNo: d.record.actNo, doctor: d.doctor, rows: d.lines.map((l) => Object.assign({ include: true }, l)) };
      const actTpl = w.templates.find((t) => t.kind === 'act');
      if (actTpl) w.selected.add(actTpl.id);
    } else {
      w.visits = (await api('GET', '/api/edocs/clients/' + w.clientId + '/records')).records;
    }
  } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  if (_ed.w !== w) return;   // пока грузили, ушли в другой раздел
  edRenderWizard();
}

function edField(key, label, type, extra) {
  const w = _ed.w;
  const val = w.form[key] === null || w.form[key] === undefined ? '' : String(w.form[key]);
  return '<div class="fg ed-f-' + key + '"><label class="fl" for="edF-' + key + '">' + esc(label) + '</label><input type="' + (type || 'text') + '" id="edF-' + key
    + '" value="' + escAttr(val) + '" ' + (extra || '') + ' oninput="edFormChanged()"></div>';
}

function edRenderWizard() {
  const w = _ed.w;
  const box = document.getElementById('edView-new');
  if (!w || !box) return;
  const tpls = w.templates.filter((t) => (w.act ? true : t.kind !== 'act'));
  box.innerHTML = '<div class="card mb ed-patient"><div><div class="ed-h">' + esc(w.client.name) + '</div><div class="ed-sub">' + esc(edPhone(w.client.phone)) + '</div></div>'
    + '<button class="btn btn-sec btn-sm" onclick="edGo(\'new\')">Другой пациент</button></div>'
    + '<div class="card mb"><div class="ed-h">1. Данные пациента для документов</div>'
    + (w.notes.length ? '<div class="ed-note">' + w.notes.map(esc).join('<br>') + '</div>' : '')
    + '<div class="ed-grid">' + edField('last_name', 'Фамилия') + edField('first_name', 'Имя') + edField('middle_name', 'Отчество')
    + edField('birth_date', 'Дата рождения', 'date')
    + '<div class="fg"><label class="fl" for="edF-gender">Пол</label><select id="edF-gender" onchange="edFormChanged()"><option value=""></option>'
    + '<option value="F"' + (w.form.gender === 'F' ? ' selected' : '') + '>женский</option><option value="M"' + (w.form.gender === 'M' ? ' selected' : '') + '>мужской</option></select></div>'
    + edField('phone', 'Телефон', 'tel') + edField('email', 'E-mail', 'email') + edField('contract_no', 'Номер договора') + edField('contract_date', 'Дата договора', 'date') + '</div>'
    + '<div class="ed-h2">Паспорт РФ</div><div class="ed-grid">'
    + edField('passport_series', 'Серия', 'text', 'inputmode="numeric" maxlength="5"') + edField('passport_number', 'Номер', 'text', 'inputmode="numeric" maxlength="7"')
    + edField('issue_date', 'Дата выдачи', 'date') + edField('authority_code', 'Код подразделения', 'text', 'maxlength="7"') + '</div>'
    + edField('issued_by', 'Кем выдан') + edField('birth_place', 'Место рождения') + edField('address', 'Адрес регистрации')
    + '<div class="ed-actions"><button class="btn btn-pri" id="edSaveIdentity" onclick="edSaveIdentity()">Сохранить данные</button>'
    + '<label class="btn btn-sec ed-file">📷 Распознать по фото паспорта<input type="file" accept="image/*" onchange="edRecognize(this)"></label>'
    + '<span id="edIdentityState" class="ed-sub">' + (w.unsaved ? 'Данные ещё не сохранены' : 'Сохранено') + '</span></div></div>'
    + '<div class="card mb"><div class="ed-h">2. ' + (w.act ? 'Акт по визиту ' + esc(edFmtDate(w.act.visitDate)) : 'Документы') + '</div>'
    + (w.act ? edActTableHtml() : edVisitsHtml())
    + '<div class="ed-tpls">' + (tpls.length ? tpls.map((t) => '<label class="ed-tpl"><input type="checkbox"' + (w.selected.has(t.id) ? ' checked' : '')
      + ' onchange="edToggleTpl(' + t.id + ',this.checked)"><span class="ed-tpl-name">' + esc(t.title) + ' <span class="ed-sub">' + esc(ED_KIND_LABELS[t.kind] || t.kind) + '</span></span>'
      + '<button class="btn btn-sec btn-sm" onclick="event.preventDefault();edPreview(' + t.id + ')">Проверить</button></label>').join('')
      : '<div class="empty">Нет активных шаблонов — загрузите их во вкладке «Настройки»</div>') + '</div>'
    + '<div class="fg ed-date"><label class="fl" for="edDocDate">Дата документа (пусто — сегодня)</label><input type="date" id="edDocDate" value="' + escAttr(w.docDate) + '" onchange="edSetDocDate(this.value)"></div>'
    + '<div id="edMissing" class="ed-missing"></div>'
    + '<div class="ed-actions"><button class="btn btn-pri" id="edSendBtn" onclick="edSend()" disabled>Отправить на подписание</button>'
    + '<span class="ed-sub">Пациент получит SMS со ссылкой и подпишет документы кодом из SMS</span></div></div>';
  if (w.act) edActTotalRender();
  edCheckMissing();
}

function edActTableHtml() {
  const a = _ed.w.act;
  const cell = (i, key, val, label, mode) => '<td data-label="' + label + '"><input type="text"' + (mode ? ' inputmode="decimal"' : '') + ' value="' + escAttr(String(val === null || val === undefined ? '' : val))
    + '" oninput="edActEdit(' + i + ',\'' + key + '\',this.value)"></td>';
  return '<div class="ed-sub">Врач: ' + esc(a.doctor.name || '—') + (a.doctor.position ? ', ' + esc(a.doctor.position) : '') + ' · номер акта ' + esc(a.actNo) + '</div>'
    + '<div class="tw mtbl-wrap"><table class="ed-act mtbl"><thead><tr><th></th><th>Услуга</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>'
    + a.rows.map((r, i) => '<tr><td data-label="В акте"><input type="checkbox"' + (r.include ? ' checked' : '') + ' onchange="edActEdit(' + i + ',\'include\',this.checked)"></td>'
      + cell(i, 'title', r.title, 'Услуга') + cell(i, 'qty', r.qty, 'Кол-во', true) + cell(i, 'price', r.price, 'Цена', true) + cell(i, 'sum', r.sum, 'Сумма', true) + '</tr>').join('')
    + '</tbody></table></div><div class="ed-actions"><button class="btn btn-sec btn-sm" onclick="edActAdd()">+ Строка</button><span class="ed-total" id="edActTotal"></span></div>';
}
function edActEdit(i, key, val) { _ed.w.act.rows[i][key] = val; edActTotalRender(); }
function edActAdd() { edCaptureForm(); _ed.w.act.rows.push({ include: true, title: '', qty: 1, price: 0, sum: 0, service_id: null }); edRenderWizard(); }
function edActTotalRender() {
  const el = document.getElementById('edActTotal');
  if (el) el.textContent = 'Итого: ' + edMoney(edActTotals(_ed.w.act.rows.filter((r) => r.include)).total);
}

function edVisitsHtml() {
  const v = _ed.w.visits || [];
  if (!v.length) return '';
  return '<details class="ed-visits"><summary>Оформить акт по визиту (' + v.length + ')</summary>' + v.map((r) => {
    const act = r.act ? edStatusInfo(r.act.status) : null;
    return '<div class="ed-visit"><span>' + esc(edFmtDate(r.visitDate)) + ' · ' + esc(r.services.join(', ') || '—') + (r.staffName ? ' · ' + esc(r.staffName) : '') + '</span>'
      + (act ? '<span class="badge ' + act.cls + '">Акт: ' + esc(act.label) + '</span>' : '')
      + '<button class="btn btn-sec btn-sm" onclick="edGo(\'new/' + _ed.w.clientId + '/' + r.id + '\')">Оформить акт</button></div>';
  }).join('') + '</details>';
}

function edToggleTpl(id, on) { if (on) _ed.w.selected.add(id); else _ed.w.selected.delete(id); edCheckMissing(); }
function edSetDocDate(v) { _ed.w.docDate = v; }

function edCaptureForm() {
  const w = _ed.w;
  if (!w) return;
  for (const f of ED_PLAIN_FIELDS.concat(ED_SECURE_FIELDS)) {
    const el = document.getElementById('edF-' + f[0]);
    if (el) w.form[f[0]] = el.value;
  }
}
function edFormChanged() {
  edCaptureForm();
  _ed.w.unsaved = true;
  const s = document.getElementById('edIdentityState');
  if (s) s.textContent = 'Есть несохранённые изменения';
  edCheckMissing();
}

async function edSaveIdentity() {
  const w = _ed.w;
  edCaptureForm();
  const btn = document.getElementById('edSaveIdentity');
  if (btn) btn.disabled = true;
  try {
    await api('PUT', '/api/edocs/clients/' + w.clientId + '/identity', edIdentityBody((k) => w.form[k], w.source));
    w.unsaved = false;
    w.source = 'manual';
    const s = document.getElementById('edIdentityState');
    if (s) s.textContent = 'Сохранено';
    notify('Данные пациента сохранены');
    edCheckMissing();
  } catch (e) { notify(e.message, 'err'); } finally { if (btn) btn.disabled = false; }
}

async function edRecognize(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const w = _ed.w;
  const fd = new FormData();
  fd.append('photo', file);
  notify('Распознаём паспорт…');
  const r = await edFetch('POST', '/api/edocs/clients/' + w.clientId + '/identity/recognize', { form: fd });
  if (!r.ok) { notify(r.body.error || 'Не удалось распознать', 'err'); if (r.body.code === 'fdoc_no_credentials' || r.body.code === 'fdoc_credentials_invalid') edOpenMe(); return; }
  if (_ed.w !== w) return;
  edCaptureForm();
  Object.assign(w.form, r.body.plain || {}, r.body.secure || {});
  w.source = 'recognize';
  w.unsaved = true;
  w.notes = [r.body.confidence ? 'Поля заполнены по фото — проверьте их и нажмите «Сохранить данные»' : 'Распознано неуверенно — внимательно проверьте каждое поле'];
  if (r.body.spoofing && r.body.spoofing.length) w.notes.push('F.Doc сомневается в подлинности снимка (' + r.body.spoofing.join(', ') + ') — сверьте с оригиналом паспорта');
  edRenderWizard();
}

async function edCheckMissing() {
  const w = _ed.w;
  const el = document.getElementById('edMissing');
  const btn = document.getElementById('edSendBtn');
  if (!w || !el || !btn) return;
  btn.disabled = true;
  if (w.unsaved) { el.textContent = 'Сохраните данные пациента: документы заполняются из сохранённых данных'; return; }
  if (!w.selected.size) { el.textContent = 'Отметьте документы для подписания'; return; }
  try {
    const r = await api('POST', '/api/edocs/packages/check', { clientId: w.clientId, templateIds: Array.from(w.selected) });
    if (_ed.w !== w) return;
    const text = edMissingText(r.missing);
    const st = _ed.state;
    const ready = st && st.enabled && st.me && st.me.connected && !st.me.broken;
    el.textContent = text || (ready ? '' : st && !st.enabled
      ? 'Модуль выключен: документы можно проверить кнопкой «Проверить», отправка — после подключения F.Doc'
      : 'Подключите свою учётную запись F.Doc: кнопка «Мой F.Doc»');
    btn.disabled = !!text || !ready;
  } catch (e) { el.textContent = e.message; }
}

function edActBody(body) {
  const w = _ed.w;
  if (!w.act) return null;
  const lines = edCollectActLines(w.act.rows);
  if (lines.error) return lines.error;
  body.recordId = w.recordId;
  body.actLines = lines.value;
  return null;
}

async function edPreview(templateId) {
  const w = _ed.w;
  const body = { clientId: w.clientId, templateId: templateId, docDate: w.docDate || null };
  const err = edActBody(body);
  if (err) return notify(err, 'err');
  try {
    const r = await api('POST', '/api/edocs/packages/preview', body);
    edDownloadBase64(r.base64, r.fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    if (w.unsaved) notify('Документ собран по СОХРАНЁННЫМ данным — сохраните изменения, чтобы они попали в документ');
  } catch (e) { notify(e.message, 'err'); }
}

async function edSend() {
  const w = _ed.w;
  const btn = document.getElementById('edSendBtn');
  const body = { clientId: w.clientId, templateIds: Array.from(w.selected), docDate: w.docDate || null };
  const err = edActBody(body);
  if (err) return notify(err, 'err');
  if (!confirm('Отправить документы пациенту на подписание? Он получит SMS со ссылкой.')) return;
  btn.disabled = true;
  btn.textContent = 'Отправляем…';
  const r = await edFetch('POST', '/api/edocs/packages', { json: body });
  btn.textContent = 'Отправить на подписание';
  if (r.ok) { notify('Документы отправлены пациенту'); edGo('p/' + r.body.packageId); return; }
  btn.disabled = false;
  const b = r.body || {};
  if (b.code === 'missing_fields') { const el = document.getElementById('edMissing'); if (el) el.textContent = edMissingText(b.missing); }
  notify(b.error || ('Ошибка ' + r.status), 'err');
  if (b.code === 'fdoc_no_credentials' || b.code === 'fdoc_credentials_invalid') edOpenMe();
  else if (b.packageId) edGo('p/' + b.packageId);   // черновик создан — повтор из карточки
}

// ── карточка комплекта ──
async function edRenderPackage(id) {
  const box = document.getElementById('edView-package');
  if (!box) return;
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  _ed.pkg = null;
  await edLoadPackage(id, false);
  _ed.timer = setInterval(() => { if (_ed.pkg && !edIsFinal(_ed.pkg.status)) edLoadPackage(id, true); }, ED_POLL_MS);
}

async function edLoadPackage(id, quiet) {
  const box = document.getElementById('edView-package');
  let p;
  try { p = await api('GET', '/api/edocs/packages/' + id); } catch (e) { if (!quiet && box) box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  if (!box || _ed.route.view !== 'package' || _ed.route.packageId !== id) return;
  _ed.pkg = p;
  const st = edStatusInfo(p.status);
  box.innerHTML = '<div class="card mb"><div class="ed-pkg-head"><div><div class="ed-h">' + esc(p.title) + '</div>'
    + '<div class="ed-sub">' + esc(p.clientName || (p.patient && p.patient.fio) || '—') + ' · ' + esc(edPhone(p.clientPhone)) + '</div>'
    + '<div class="ed-sub">Отправил: ' + esc(p.sentByName || '—') + ' · ' + esc(edFmtDateTime(p.sentAt || p.createdAt))
    + (p.signedAt ? ' · подписан ' + esc(edFmtDateTime(p.signedAt)) : '') + '</div></div>'
    + '<span class="badge ' + st.cls + ' ed-badge-lg">' + esc(st.label) + '</span></div>'
    + (p.lastError && p.status === 'draft' ? '<div class="ed-err">' + esc(p.lastError) + '</div>' : '')
    + '<div class="ed-actions">' + edPackageActions(p) + '</div></div>'
    + '<div class="card mb"><div class="ed-h2">Документы</div><div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Документ</th><th>Подпись клиники</th><th>Подпись пациента</th><th></th></tr></thead><tbody>'
    + p.documents.map((d) => '<tr><td class="mtbl-title">' + esc(d.title) + '</td><td data-label="Клиника">' + esc(edFmtDateTime(d.corpSignedAt)) + '</td>'
      + '<td data-label="Пациент">' + esc(edFmtDateTime(d.clientSignedAt)) + '</td><td>' + (d.hasPdf ? '<button class="btn btn-sec btn-sm" onclick="edOpenPdf(\'' + d.id + '\')">PDF</button>' : '') + '</td></tr>').join('')
    + '</tbody></table></div></div>'
    + (p.act ? edActSummaryHtml(p.act) : '')
    + '<div class="card"><div class="ed-h2">Журнал</div>' + ((p.events || []).map((e) => '<div class="ed-event"><span class="ed-sub">' + esc(edFmtDateTime(e.createdAt)) + '</span> '
      + esc(ED_EVENT_LABELS[e.kind] || e.kind) + (e.kind === 'status' && e.payload ? ': ' + esc(edStatusInfo(e.payload.to).label) : '')
      + (e.userName ? ' · ' + esc(e.userName) : '') + '</div>').join('') || '<div class="ed-sub">Пусто</div>') + '</div>';
}

function edActSummaryHtml(act) {
  const t = edActTotals(act.lines || []);
  return '<div class="card mb"><div class="ed-h2">Строки акта · визит ' + esc(edFmtDate(act.visit_date)) + ' · ' + esc(act.doctor_name || '') + '</div><div class="tw"><table><thead><tr><th>Услуга</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>'
    + (act.lines || []).map((l) => '<tr><td>' + esc(l.title) + '</td><td>' + esc(String(l.qty)) + '</td><td>' + esc(edMoney(l.price)) + '</td><td>' + esc(edMoney(l.sum)) + '</td></tr>').join('')
    + '</tbody></table></div><div class="ed-total">Итого: ' + esc(edMoney(t.total)) + '</div></div>';
}

function edPackageActions(p) {
  const b = [];
  const btn = (action, label, cls) => '<button class="btn ' + (cls || 'btn-sec') + ' btn-sm" onclick="edPkgAction(\'' + p.id + '\',\'' + action + '\')">' + label + '</button>';
  if (p.status === 'draft') b.push(btn('resend', 'Повторить отправку', 'btn-pri'));
  if (p.status !== 'draft') b.push('<button class="btn btn-sec btn-sm" onclick="edOpenInFdoc(\'' + p.id + '\')">Открыть в F.Doc</button>');
  if (p.status === 'sent') b.push(btn('permalink', 'Отправить ссылку ещё раз'));
  if (p.status !== 'draft' && !edIsFinal(p.status)) b.push(btn('refresh', 'Обновить статус'));
  if (p.status === 'sent' || p.status === 'error') b.push(btn('annul', 'Аннулировать', 'btn-sec btn-dng'));
  // Отказ, аннулирование, истёкший срок — новый комплект тому же пациенту (и по тому же визиту для акта).
  if (['declined', 'annulled', 'expired'].indexOf(p.status) >= 0) {
    b.push('<button class="btn btn-pri btn-sm" onclick="edGo(\'new/' + p.clientId + (p.recordId ? '/' + p.recordId : '') + '\')">Оформить заново</button>');
  }
  return b.join('');
}

async function edPkgAction(id, action) {
  if (action === 'annul' && !confirm('Аннулировать комплект? Пациент больше не сможет его подписать.')) return;
  try {
    const r = await api('POST', '/api/edocs/packages/' + id + '/' + action);
    const msg = { resend: r && r.recovered ? 'Комплект уже был в F.Doc — отмечен отправленным' : 'Комплект отправлен', permalink: 'Ссылка отправлена пациенту', refresh: 'Статус обновлён', annul: 'Комплект аннулирован' };
    notify(msg[action] || 'Готово');
    edLoadPackage(id, true);
  } catch (e) { notify(e.message, 'err'); if (/Мой F\.Doc/.test(e.message)) edOpenMe(); }
}
function edOpenInFdoc(id) { edOpenAsync(async () => (await api('POST', '/api/edocs/packages/' + id + '/employee-url')).url); }
function edOpenPdf(docId) { edOpenAsync(async () => (await api('GET', '/api/edocs/documents/' + docId + '/pdf')).url); }

// ── «Мой F.Doc»: учётная запись текущего пользователя ──
function edOpenMe() {
  const me = _ed.state && _ed.state.me;
  const info = document.getElementById('edMeInfo');
  if (info) info.textContent = !me ? '' : me.connected
    ? (me.broken ? 'F.Doc не принимает сохранённый пароль — введите новый' : 'Подключено: ' + me.login)
    : 'Логин и пароль выдаёт F.Doc при регистрации сотрудника. Документы будут уходить от вашего имени.';
  document.getElementById('edMeLogin').value = (me && me.login) || '';
  document.getElementById('edMePassword').value = '';
  openModal('edMeModal');
}
async function edSaveMe() {
  const login = document.getElementById('edMeLogin').value.trim();
  const password = document.getElementById('edMePassword').value;
  if (!login || !password) return notify('Введите логин и пароль F.Doc', 'err');
  try {
    await api('PUT', '/api/edocs/me/credentials', { login: login, password: password });
    notify('Учётная запись F.Doc подключена');
    closeModal('edMeModal');
    await edLoadState();
    edCheckMissing();
  } catch (e) { notify(e.message, 'err'); }
}
async function edDeleteMe() {
  if (!confirm('Отключить вашу учётную запись F.Doc?')) return;
  try {
    await api('DELETE', '/api/edocs/me/credentials');
    notify('Учётная запись F.Doc отключена');
    closeModal('edMeModal');
    await edLoadState();
    edCheckMissing();
  } catch (e) { notify(e.message, 'err'); }
}

// ── настройки (владелец, администратор) ──
async function edRenderSettings() {
  const box = document.getElementById('edView-settings');
  if (!box) return;
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  let s, t, u, dict;
  try {
    [s, t, u, dict] = await Promise.all([
      api('GET', '/api/edocs/admin/settings'), api('GET', '/api/edocs/admin/templates'),
      api('GET', '/api/edocs/admin/users'), api('GET', '/api/edocs/admin/templates/dictionary'),
    ]);
  } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  const v = (x) => escAttr(x === null || x === undefined ? '' : String(x));
  const f = (id, label, val, extra) => '<div class="fg"><label class="fl" for="' + id + '">' + esc(label) + '</label><input id="' + id + '" value="' + v(val) + '" ' + (extra || '') + '></div>';
  box.innerHTML = (s.encReady ? '' : '<div class="ed-note ed-note-bad">На сервере не задан ключ шифрования EDOCS_ENC_KEY: модуль не сможет сохранять пароли и паспортные данные.</div>')
    + '<div class="card mb"><div class="ed-h">Подключение к F.Doc</div><div class="ed-grid">'
    + f('edS-baseUrl', 'Адрес стенда', s.baseUrl, 'placeholder="https://demo.fdoc.ru"')
    + f('edS-apiKey', 'Ключ API организации', '', 'type="password" autocomplete="new-password" placeholder="' + (s.hasApiKey ? 'сохранён — введите, чтобы заменить' : '') + '"')
    + f('edS-appLogin', 'Логин приложения', s.appLogin)
    + f('edS-appPassword', 'Пароль приложения', '', 'type="password" autocomplete="new-password" placeholder="' + (s.hasAppPassword ? 'сохранён — введите, чтобы заменить' : '') + '"')
    + f('edS-appCode', 'Код приложения (app)', s.appCode)
    + f('edS-qesCertAlias', 'Алиас сертификата КЭП клиники', s.qesCertAlias, 'placeholder="пусто — штамп сотрудника"')
    + f('edS-employeePosition', 'Должность подписанта от клиники', s.employeePosition)
    + f('edS-unsignDays', 'Срок подписания, дней', s.unsignDays, 'type="number" min="1" max="90"')
    + '</div><label class="ed-switch"><input type="checkbox" id="edS-enabled"' + (s.enabled ? ' checked' : '') + '> Модуль включён</label>'
    + '<div class="ed-sub">Организация в F.Doc: ' + (s.corpId ? esc(s.corpId) : 'подключение не проверено') + '</div></div>'
    + '<div class="card mb"><div class="ed-h">Реквизиты клиники для документов</div><div class="ed-grid">'
    + ED_ORG_FIELDS.map((x) => f('edR-' + x[0], x[1], (s.requisites || {})[x[0]])).join('') + '</div>'
    + '<div class="ed-actions"><button class="btn btn-pri" onclick="edSaveSettings()">Сохранить настройки</button>'
    + '<button class="btn btn-sec" onclick="edVerify()">Проверить подключение</button><button class="btn btn-sec" onclick="edTariff()">Тариф</button>'
    + '<span id="edTariff" class="ed-sub"></span></div></div>'
    + '<div class="card mb"><div class="ed-h">Уведомления F.Doc о статусах</div><div class="ed-sub">'
    + (s.webhookUrl ? 'Адрес: ' + esc(s.webhookUrl) : 'Не подключены — статусы проверяются опросом раз в 5 минут')
    + (s.lastWebhookAt ? ' · последнее уведомление ' + esc(edFmtDateTime(s.lastWebhookAt)) : '') + '</div>'
    + '<div class="ed-sub">Перед подпиской передайте менеджеру F.Doc IP-адрес сервера.</div>'
    + '<div class="ed-actions"><button class="btn btn-sec" onclick="edSubscribe()">' + (s.webhookUrl ? 'Подписаться заново' : 'Подписаться') + '</button></div></div>'
    + '<div class="card mb"><div class="ed-h">Шаблоны документов</div><div class="ed-upload">'
    + '<input id="edT-title" placeholder="Название документа"><select id="edT-kind">' + dict.kinds.map((k) => '<option value="' + k.kind + '">' + esc(k.label) + '</option>').join('') + '</select>'
    + '<input type="file" id="edT-file" accept=".docx"><button class="btn btn-pri btn-sm" onclick="edUploadTemplate()">Загрузить</button></div>'
    + '<div id="edTplErrors" class="ed-err"></div>'
    + '<div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Документ</th><th>Вид</th><th>Теги</th><th>Активен</th><th></th></tr></thead><tbody>'
    + (t.templates.length ? t.templates.map(edTemplateRow).join('') : '<tr><td colspan="5" class="empty">Шаблонов пока нет</td></tr>') + '</tbody></table></div>'
    + '<details class="ed-dict"><summary>Какие теги можно использовать в шаблоне</summary>'
    + '<div class="ed-sub">Тег пишется прямо в тексте Word в фигурных скобках: {fio}. Строки акта — внутри одной строки таблицы: {#services}{n} … {title} … {sum}{/services}.</div>'
    + '<table><tbody>' + dict.fields.map((x) => '<tr><td><code>{' + esc(x.loop ? '#' + x.tag : x.tag) + '}</code></td><td>' + esc(x.label) + (x.actOnly ? ' <span class="badge bgr">акт</span>' : '') + '</td></tr>').join('')
    + dict.serviceFields.map((x) => '<tr><td><code>{' + esc(x.tag) + '}</code></td><td>' + esc(x.label) + ' <span class="badge bgr">строка акта</span></td></tr>').join('')
    + '</tbody></table></details></div>'
    + '<div class="card"><div class="ed-h">Сотрудники и F.Doc</div><div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Сотрудник</th><th>Роль</th><th>Учётная запись F.Doc</th></tr></thead><tbody>'
    + u.users.map((x) => '<tr><td class="mtbl-title">' + esc(x.name || x.email) + '</td><td data-label="Роль">' + esc(x.role) + '</td><td data-label="F.Doc">' + (x.connected ? (x.broken ? '⚠ ' : '✓ ') + esc(x.login) : '<span class="ed-sub">не подключена</span>') + '</td></tr>').join('')
    + '</tbody></table></div></div>';
}

function edTemplateRow(x) {
  return '<tr><td data-label="Документ"><input class="ed-inline" id="edTt-' + x.id + '" value="' + escAttr(x.title) + '"></td>'
    + '<td data-label="Вид"><select id="edTk-' + x.id + '">' + Object.keys(ED_KIND_LABELS).map((k) => '<option value="' + k + '"' + (x.kind === k ? ' selected' : '') + '>' + esc(ED_KIND_LABELS[k]) + '</option>').join('') + '</select></td>'
    + '<td data-label="Теги" class="ed-sub">' + esc((x.placeholders || []).join(', ') || '—') + '</td>'
    + '<td data-label="Активен"><input type="checkbox" id="edTa-' + x.id + '"' + (x.is_active ? ' checked' : '') + '></td>'
    + '<td class="ed-row-actions"><button class="btn btn-sec btn-sm" onclick="edSaveTemplate(' + x.id + ')">Сохранить</button>'
    + '<button class="btn btn-sec btn-sm" onclick="edTemplateFile(' + x.id + ')">Скачать</button>'
    + '<label class="btn btn-sec btn-sm ed-file">Заменить файл<input type="file" accept=".docx" onchange="edReplaceTemplate(' + x.id + ',this)"></label>'
    + '<button class="btn btn-sec btn-sm btn-dng" onclick="edDeleteTemplate(' + x.id + ')">Удалить</button></td></tr>';
}

function edVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }

async function edSaveSettings() {
  const body = {
    enabled: document.getElementById('edS-enabled').checked, baseUrl: edVal('edS-baseUrl').trim(), appLogin: edVal('edS-appLogin'),
    appCode: edVal('edS-appCode'), qesCertAlias: edVal('edS-qesCertAlias'), employeePosition: edVal('edS-employeePosition'),
    unsignDays: edVal('edS-unsignDays'), requisites: {},
  };
  // Пустое поле секрета — «не менять»: сервер трактует отсутствие поля как сохранение прежнего.
  if (edVal('edS-apiKey')) body.apiKey = edVal('edS-apiKey');
  if (edVal('edS-appPassword')) body.appPassword = edVal('edS-appPassword');
  for (const x of ED_ORG_FIELDS) body.requisites[x[0]] = edVal('edR-' + x[0]);
  try {
    const r = await api('PUT', '/api/edocs/admin/settings', body);
    notify(r.needVerify ? 'Сохранено. Данные F.Doc изменились — нажмите «Проверить подключение»' : 'Настройки сохранены');
    await edRenderSettings();
    edLoadState();
  } catch (e) { notify(e.message, 'err'); }
}
async function edVerify() {
  try { const r = await api('POST', '/api/edocs/admin/settings/verify'); notify('Подключение работает, организация ' + r.corpId); edRenderSettings(); }
  catch (e) { notify(e.message, 'err'); }
}
async function edTariff() {
  try {
    const r = await api('GET', '/api/edocs/admin/settings/tariff');
    const t = (r.tariffs || [])[0];
    const el = document.getElementById('edTariff');
    if (el) el.textContent = t ? (t.tariffName || 'Тариф') + ': осталось ' + (t.remainPages === undefined ? '—' : t.remainPages) + ' из ' + (t.count === undefined ? '—' : t.count) + ', до ' + edFmtDate(t.expiryDate) : 'Активного тарифа нет';
  } catch (e) { notify(e.message, 'err'); }
}
async function edSubscribe() {
  try { await api('POST', '/api/edocs/admin/settings/webhook'); notify('Подписка на уведомления оформлена'); edRenderSettings(); }
  catch (e) { notify(e.message, 'err'); }
}
async function edUploadTemplate() {
  const file = document.getElementById('edT-file').files[0];
  const title = edVal('edT-title').trim();
  const errs = document.getElementById('edTplErrors');
  errs.textContent = '';
  if (!title) return notify('Укажите название документа', 'err');
  if (!file) return notify('Выберите файл .docx', 'err');
  const fd = new FormData();
  fd.append('title', title); fd.append('kind', edVal('edT-kind')); fd.append('file', file);
  const r = await edFetch('POST', '/api/edocs/admin/templates', { form: fd });
  if (!r.ok) { errs.innerHTML = esc(r.body.error || 'Ошибка ' + r.status) + ((r.body.details || []).length ? '<br>' + r.body.details.map(esc).join('<br>') : ''); return; }
  notify('Шаблон загружен');
  edRenderSettings();
}
async function edSaveTemplate(id) {
  const body = { title: edVal('edTt-' + id), kind: edVal('edTk-' + id), isActive: document.getElementById('edTa-' + id).checked };
  const r = await edFetch('PUT', '/api/edocs/admin/templates/' + id, { json: body });
  if (!r.ok) return notify((r.body.error || 'Ошибка') + ((r.body.details || []).length ? ': ' + r.body.details.join('; ') : ''), 'err');
  notify('Шаблон сохранён');
}
function edTemplateFile(id) { edOpenAsync(async () => (await api('GET', '/api/edocs/admin/templates/' + id + '/file')).url); }
async function edReplaceTemplate(id, input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  const r = await edFetch('POST', '/api/edocs/admin/templates/' + id + '/file', { form: fd });
  if (!r.ok) return notify((r.body.error || 'Ошибка') + ((r.body.details || []).length ? ': ' + r.body.details.join('; ') : ''), 'err');
  notify('Файл шаблона заменён');
  edRenderSettings();
}
async function edDeleteTemplate(id) {
  if (!confirm('Удалить шаблон?')) return;
  try { await api('DELETE', '/api/edocs/admin/templates/' + id); notify('Шаблон удалён'); edRenderSettings(); }
  catch (e) { notify(e.message, 'err'); }
}

// ── встройки в другие страницы ──
// Карточка клиента (clients.js → openCD): блок «Документы», если модуль включён.
async function edRenderClientBlock(clientId) {
  const el = document.getElementById('edClientBlock_' + clientId);
  if (!el) return;
  let s;
  try { s = await api('GET', '/api/edocs/clients/' + clientId + '/summary'); } catch (e) { el.innerHTML = ''; return; }
  if (!s || !s.enabled) { el.innerHTML = ''; return; }
  const id = s.identity;
  el.innerHTML = '<div class="div"></div><div class="ed-cblock-head"><div style="font-size:13px;font-weight:700">Документы</div>'
    + '<button class="btn btn-pri btn-sm" onclick="edOpenWizard(' + clientId + ')">Оформить документы</button></div>'
    + '<div class="ed-sub">' + (id.exists ? 'Данные для документов: ' + esc(id.fio || '—') + (id.passportMask ? ' · паспорт ' + esc(id.passportMask) : ' · паспорт не заполнен') : 'Данные для документов не заполнены') + '</div>'
    + (s.packages || []).map((p) => {
      const st = edStatusInfo(p.status);
      return '<div class="ed-crow" onclick="edOpenPackage(\'' + p.id + '\')"><span>' + esc(p.title) + '</span><span class="badge ' + st.cls + '">' + esc(st.label) + '</span></div>';
    }).join('');
}
function edOpenWizard(clientId, recordId) {
  if (typeof closeModal === 'function') closeModal('clientModal');
  location.hash = 'edocs/new/' + clientId + (recordId ? '/' + recordId : '');
}
function edOpenPackage(id) {
  if (typeof closeModal === 'function') closeModal('clientModal');
  location.hash = 'edocs/p/' + id;
}
// Страница «Записи» (records.js): кнопка «Акт» у состоявшихся визитов или статус акта.
async function edDecorateRecords(records) {
  const ids = (records || []).filter((r) => r.status === 'arrived').map((r) => r.id);
  if (!ids.length) return;
  let res;
  try { res = await api('GET', '/api/edocs/records/act-status?ids=' + ids.join(',')); } catch (e) { return; }
  if (!res || !res.enabled) return;
  document.querySelectorAll('#rBody td.r-act').forEach((td) => {
    const rid = Number(td.dataset.rid), cid = Number(td.dataset.cid);
    if (ids.indexOf(rid) < 0 || !cid) return;
    const a = res.statuses[rid];
    td.innerHTML = a
      ? '<span class="badge ' + edStatusInfo(a.status).cls + ' ed-link" onclick="edOpenPackage(\'' + a.packageId + '\')">Акт: ' + esc(edStatusInfo(a.status).label) + '</span>'
      : '<button class="btn btn-sec btn-sm" onclick="edOpenWizard(' + cid + ',' + rid + ')">📄 Акт</button>';
  });
}
