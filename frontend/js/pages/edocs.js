// ── «📄 ДОКУМЕНТЫ»: электронное подписание с пациентами через F.Doc ─────────────
// Адрес (хвост #edocs/…): '' и r/<период> — дашборд подписей (edocs-board.js); c/<пациент>[/<запись>] —
// страница пациента (edocs-client.js); packages — все комплекты; p/<комплект> — карточка; settings —
// настройки. Старые адреса мастера new/<пациент>[/<запись>] переписываются на c/… (на них ссылались
// карточка клиента, «Записи» и закладки). Состояние — в hash: F5 и «Назад» возвращают туда же (хук
// edocsOnHashArg в nav.js). Зависимости: api(), esc(), escAttr(), notify(), showLbar(), openModal()/
// closeModal(), помощники edocs-helpers.js. Глобальные имена — с префиксом ed/ED_ (общая область скриптов).
// loadSeq — номер загрузки: его увеличивают каждый маршрут, уход со страницы и выход; загрузка с
// устаревшим номером не рисует и не заводит опрос (иначе второй setInterval затирал handle первого и опрос
// жил до перезагрузки). Опрос у всех видов один — _ed.timer. sending — идёт отправка комплекта: кнопку
// «Отправить» до её итога не включает никто, иначе второй клик создал бы второй комплект тому же пациенту.
let _ed = { state: null, route: { view: 'board', range: 'today' }, timer: null, loadSeq: 0, sending: false, listStatus: '', listFrom: '', listTo: '', pkg: null };
const ED_POLL_MS = 30000;
const ED_VIEWS = ['board', 'client', 'list', 'package', 'settings'];

function edTail() { return (location.hash || '').slice(1).split('/').slice(1).map(decodeURIComponent).join('/'); }
function loadEdocs() { edRoute(edTail()); }
// Клик по меню: navTo пишет hash и сам зовёт loadEdocs, следом hashchange приносит тот же хвост —
// тот же маршрут второй раз не грузим (двойные запросы и второй опрос).
function edocsOnHashArg(arg) {
  const tail = arg || '';
  if (edSameRoute(edParseTail(tail), _ed.route)) return;
  edRoute(tail);
}
function edSameRoute(a, b) {
  return !!a && !!b && !a.legacy && a.view === b.view && (a.range || null) === (b.range || null) && (a.clientId || null) === (b.clientId || null)
    && (a.recordId || null) === (b.recordId || null) && (a.packageId || null) === (b.packageId || null);
}
function edGo(tail) {
  const h = tail ? 'edocs/' + tail : 'edocs';
  if ((location.hash || '').slice(1) === h) edRoute(tail || ''); else location.hash = h;
}
function edClearTimer() { if (_ed.timer) { clearInterval(_ed.timer); _ed.timer = null; } }
// Уход со страницы и выход (nav.js), новый маршрут: опрос гаснет, идущие загрузки устаревают.
function edStopPolling() { _ed.loadSeq++; edClearTimer(); }
function edIsAdmin() { return typeof ME !== 'undefined' && !!ME && (ME.role === 'owner' || ME.role === 'admin'); }
/** Отправлять в F.Doc сейчас можно: модуль включён и проверен, своя учётка подключена и не заперта. */
function edCanSend() { const s = _ed.state; return !!(s && s.enabled && s.configured && s.me && s.me.connected && !s.me.broken); }
/** Почему нельзя отправить (или ''). */
function edSendBlockReason() {
  const s = _ed.state;
  if (!s) return 'Нет связи с сервером';
  if (!s.enabled || !s.configured) return 'Модуль выключен: документы можно проверить, отправка — после подключения F.Doc';
  if (!s.me || !s.me.connected) return 'Подключите свою учётную запись F.Doc: кнопка «Мой F.Doc»';
  if (s.me.broken) return 'F.Doc не принимает ваш пароль — обновите его в «Мой F.Doc»';
  return '';
}

// fetch, который сохраняет всё тело ответа (api() оставляет только error): нужны
// packageId, missing, details. Файлы — FormData, JSON — opts.json. Сбой сети — не исключение,
// а status 0: вызывающий обязан показать ошибку (необработанный reject оставлял кнопки «в загрузке»).
async function edFetch(method, path, opts) {
  opts = opts || {};
  const headers = { Authorization: 'Bearer ' + localStorage.getItem('lp_tk') };
  let body;
  if (opts.form) body = opts.form;
  else if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  showLbar(true);
  try {
    let r;
    try { r = await fetch(path, { method: method, headers: headers, body: body }); } catch (e) {
      return { ok: false, status: 0, body: { error: 'Нет связи с сервером' } };
    }
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
  const seq = ++_ed.loadSeq;
  let route = edParseTail(tail);
  if (route.legacy) {
    route = { view: 'client', clientId: route.clientId, recordId: route.recordId };
    history.replaceState(null, '', '#edocs/' + edTailOf(route));
  }
  if (route.view === 'settings' && !edIsAdmin()) { history.replaceState(null, '', '#edocs'); route = { view: 'board', range: 'today' }; }
  _ed.route = route;
  for (const v of ED_VIEWS) {
    const el = document.getElementById('edView-' + v);
    if (el) el.style.display = v === route.view ? '' : 'none';
  }
  const tabOf = { board: 'board', client: 'board', list: 'list', package: 'list', settings: 'settings' };
  for (const t of ['board', 'list', 'settings']) {
    const b = document.getElementById('edTabBtn-' + t);
    if (b) b.classList.toggle('active', tabOf[route.view] === t);
  }
  const sb = document.getElementById('edTabBtn-settings');
  if (sb) sb.style.display = edIsAdmin() ? '' : 'none';
  await edLoadState();
  if (seq !== _ed.loadSeq) return;   // пока грузили, ушли: другой маршрут, другая страница, выход
  if (route.view === 'board') return edbRender(route, seq);
  if (route.view === 'client') return edcRender(route, seq);
  if (route.view === 'package') return edRenderPackage(route.packageId, seq);
  if (route.view === 'settings') return edRenderSettings();
  return edRenderList(seq);
}

/** Перерисовать текущий вид после смены состояния (подключили F.Doc, сменили настройки). */
function edRefreshView() {
  if (_ed.route.view === 'board' && typeof edbRefresh === 'function') edbRefresh(true);
  else if (_ed.route.view === 'client' && typeof edcRefresh === 'function') edcRefresh(true);
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
  if (s && !s.enabled) msgs.push(edIsAdmin()
    ? 'F.Doc не подключён: дашборд, данные пациентов, отметки «на бумаге» и анкеты работают, электронная отправка — после подключения (вкладка «Настройки»).'
    : 'F.Doc ещё не подключён: отметки «на бумаге» и анкеты работают, электронная отправка — после подключения (обратитесь к администратору).');
  else if (s && !s.me.connected) msgs.push('Чтобы отправлять документы, подключите свою учётную запись F.Doc: кнопка «Мой F.Doc».');
  note.innerHTML = msgs.map((m) => '<div class="ed-note">' + esc(m) + '</div>').join('');
}

// ── общее окно подтверждения (дашборд и страница пациента) ──
let _edConfirmResolve = null;
/** Окно с HTML-содержимым и кнопкой ok; Promise<boolean>. html собирает вызывающий (через esc). */
function edConfirm(opts) {
  if (_edConfirmResolve) _edConfirmResolve(false);
  document.getElementById('edConfirmTitle').textContent = opts.title || 'Подтвердите';
  document.getElementById('edConfirmBody').innerHTML = opts.html || '';
  document.getElementById('edConfirmOk').textContent = opts.ok || 'Отправить';
  openModal('edConfirmModal');
  return new Promise((resolve) => { _edConfirmResolve = resolve; });
}
function edConfirmDone(v) {
  closeModal('edConfirmModal');
  const r = _edConfirmResolve;
  _edConfirmResolve = null;
  if (r) r(!!v);
}

// Итог POST /packages (edFetch) — один на дашборд и страницу пациента. Комплект создан, но сбой уже после
// черновика — его карточка: «Повторить» там сначала спросит F.Doc, а повторная отправка отсюда создала бы
// второй комплект. Ответа нет (сеть, 5xx прокси) — комплект мог уйти. @returns 'sent'|'package'|'unknown'|'rejected'
const ED_SEND_UNKNOWN = 'Ответ сервера не получен — комплект мог уйти. Проверьте документы пациента, прежде чем отправлять снова';
function edSendOutcome(r) {
  const b = r.body || {};
  const credentials = b.code === 'fdoc_no_credentials' || b.code === 'fdoc_credentials_invalid';
  if (r.ok) { notify('Документы отправлены пациенту — он получит SMS со ссылкой'); return 'sent'; }
  if (b.packageId) {
    notify(b.error || ('Ошибка ' + r.status), 'err');
    edGo('p/' + b.packageId);
    if (credentials) edOpenMe();   // поверх карточки: после смены пароля — «Повторить отправку»
    return 'package';
  }
  if (!r.status || r.status >= 500) { notify(ED_SEND_UNKNOWN, 'err'); return 'unknown'; }
  notify(b.error || ('Ошибка ' + r.status), 'err');
  if (credentials) edOpenMe();
  return 'rejected';
}

// ── список комплектов ──
async function edRenderList(seq) {
  const box = document.getElementById('edView-list');
  if (!box) return;
  box.innerHTML = '<div class="ed-toolbar"><select id="edListStatus" onchange="edSetListStatus(this.value)"><option value="">Все статусы</option>'
    + Object.keys(ED_STATUS).map((k) => '<option value="' + k + '"' + (_ed.listStatus === k ? ' selected' : '') + '>' + esc(ED_STATUS[k].label) + '</option>').join('')
    + '</select><input type="date" id="edListFrom" value="' + escAttr(_ed.listFrom) + '" onchange="edSetListPeriod()" title="Создан с">'
    + '<input type="date" id="edListTo" value="' + escAttr(_ed.listTo) + '" onchange="edSetListPeriod()" title="Создан по"></div><div class="card ed-tbl-card"><div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Создан</th><th>Пациент</th><th>Комплект</th><th>Статус</th><th>Отправил</th></tr></thead>'
    + '<tbody id="edListBody"><tr><td colspan="5" class="empty">Загрузка…</td></tr></tbody></table></div></div>';
  await edLoadList();
  if (seq !== _ed.loadSeq) return;   // ушли, пока грузили, — опрос не заводим
  edClearTimer();
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

// ── карточка комплекта ──
async function edRenderPackage(id, seq) {
  const box = document.getElementById('edView-package');
  if (!box) return;
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  _ed.pkg = null;
  await edLoadPackage(id, false);
  if (seq !== _ed.loadSeq) return;   // ушли, пока грузили, — опрос не заводим
  edClearTimer();
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
    + (p.paper ? '<div class="card mb"><div class="ed-h2">Подписано на бумаге</div><div class="ed-sub">Дата подписания: ' + esc(edFmtDate(p.paper.signedDate))
      + (p.paper.note ? ' · ' + esc(p.paper.note) : '') + (p.paper.hasScan ? '' : ' · скан не приложен') + '</div></div>' : '')
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
  const btn = (action, label, cls) => '<button class="btn ' + (cls || 'btn-sec') + ' btn-sm" onclick="edPkgAction(\'' + p.id + '\',\'' + action + '\',this)">' + label + '</button>';
  b.push('<button class="btn btn-sec btn-sm" onclick="edGo(\'c/' + p.clientId + '\')">Пациент</button>');
  if (p.source === 'paper') {
    if (p.paper && p.paper.hasScan) b.push('<button class="btn btn-sec btn-sm" onclick="edOpenScan(\'' + p.id + '\')">Скан</button>');
    if (p.status === 'paper' && edIsAdmin()) b.push('<button class="btn btn-sec btn-sm btn-dng" onclick="edRevokePaper(\'' + p.id + '\')">Снять отметку</button>');
    return b.join('');
  }
  if (p.status === 'draft') b.push(btn('resend', 'Повторить отправку', 'btn-pri'));
  if (p.status !== 'draft') b.push('<button class="btn btn-sec btn-sm" onclick="edOpenInFdoc(\'' + p.id + '\')">Открыть в F.Doc</button>');
  if (p.status === 'sent') b.push(btn('permalink', 'Отправить ссылку ещё раз'));
  if (p.status !== 'draft' && !edIsFinal(p.status)) b.push(btn('refresh', 'Обновить статус'));
  if (p.status === 'sent' || p.status === 'error') b.push(btn('annul', 'Аннулировать', 'btn-sec btn-dng'));
  // Отказ, аннулирование, истёкший срок — новый комплект на странице пациента (по тому же визиту для акта).
  if (['declined', 'annulled', 'expired'].indexOf(p.status) >= 0) {
    b.push('<button class="btn btn-pri btn-sm" onclick="edGo(\'c/' + p.clientId + (p.recordId ? '/' + p.recordId : '') + '\')">Оформить заново</button>');
  }
  return b.join('');
}

// btn — нажатая кнопка: заблокирована до ответа (двойной клик «Отправить ссылку ещё раз» = два SMS пациенту).
async function edPkgAction(id, action, btn) {
  if (btn && btn.disabled) return;   // запрос по этой кнопке уже идёт
  if (action === 'annul' && !confirm('Аннулировать комплект? Пациент больше не сможет его подписать.')) return;
  if (action === 'permalink' && !confirm('Отправить пациенту ссылку на подписание ещё раз? Он получит SMS.')) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/api/edocs/packages/' + id + '/' + action);
    const msg = { resend: r && r.recovered ? 'Комплект уже был в F.Doc — отмечен отправленным' : 'Комплект отправлен', permalink: 'Ссылка отправлена пациенту', refresh: 'Статус обновлён', annul: 'Комплект аннулирован' };
    notify(msg[action] || 'Готово');
    await edLoadPackage(id, true);   // карточка перерисуется с новыми кнопками
  } catch (e) { notify(e.message, 'err'); if (/Мой F\.Doc/.test(e.message)) edOpenMe(); }
  finally { if (btn) btn.disabled = false; }
}
function edOpenInFdoc(id) { edOpenAsync(async () => (await api('POST', '/api/edocs/packages/' + id + '/employee-url')).url); }
function edOpenPdf(docId) { edOpenAsync(async () => (await api('GET', '/api/edocs/documents/' + docId + '/pdf')).url); }

function edOpenScan(id) { edOpenAsync(async () => (await api('GET', '/api/edocs/packages/' + id + '/scan')).url); }
async function edRevokePaper(id) {
  const reason = prompt('Почему снимаете отметку «Подписано на бумаге»? Причина попадёт в журнал.');
  if (reason === null) return;
  try {
    await api('POST', '/api/edocs/packages/' + id + '/paper-revoke', { reason: reason });
    notify('Отметка снята');
    await edLoadPackage(id, true);
  } catch (e) { notify(e.message, 'err'); }
}

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
    edRefreshView();
  } catch (e) { notify(e.message, 'err'); }
}
async function edDeleteMe() {
  if (!confirm('Отключить вашу учётную запись F.Doc?')) return;
  try {
    await api('DELETE', '/api/edocs/me/credentials');
    notify('Учётная запись F.Doc отключена');
    closeModal('edMeModal');
    await edLoadState();
    edRefreshView();
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
    + '<div class="card mb"><div class="ed-h">Автоматизация, анкета и номера договоров</div>'
    + '<div class="ed-sub">Что отправлять без участия администратора, текст сообщения с анкетой, нумерация договоров, с какой даты нужны акты. По умолчанию автоматика выключена.</div>'
    + '<div class="ed-actions"><button class="btn btn-pri" onclick="edOpenAutomation()">⚙ Настроить</button></div></div>'
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
  if (!r.ok) {
    notify((r.body.error || 'Ошибка') + ((r.body.details || []).length ? ': ' + r.body.details.join('; ') : ''), 'err');
    // Отказ сервера (шаблон занят, вид не подходит): в строке не должно остаться несохранённого.
    // Без связи (status 0) перечитать нечего — только текст ошибки, форма остаётся.
    if (r.status) edRenderSettings();
    return;
  }
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

// ── автоматизация, анкета, номера договоров (окно — с дашборда и из настроек) ──
let _edAuto = null;
async function edOpenAutomation() {
  const box = document.getElementById('edAutoBody');
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  openModal('edAutoModal');
  try { _edAuto = await api('GET', '/api/edocs/admin/automation'); } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  edAutoRender();
}
function edTgl(btn) { btn.classList.toggle('on'); }
function edAutoRender() {
  const d = _edAuto;
  const box = document.getElementById('edAutoBody');
  if (!d || !box) return;
  const tgl = (id, on) => '<button type="button" class="ed-tgl' + (on ? ' on' : '') + '" id="' + id + '" onclick="edTgl(this)"></button>';
  const num = (id, v, min, max) => '<input type="number" id="' + id + '" value="' + escAttr(String(v)) + '" min="' + min + '" max="' + max + '" style="width:80px">';
  const opt = (v, label, cur) => '<option value="' + escAttr(String(v)) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(String(label)) + '</option>';
  const senders = d.senders.filter((u) => u.connected && !u.broken);
  box.innerHTML = (d.testPhones && d.testPhones.length ? '<div class="ed-note">Тестовый режим: пациентам уходят только отправки на ' + esc(d.testPhones.join(', ')) + ' (EDOCS_TEST_PHONES).</div>' : '')
    + (d.publicUrlConfigured ? '' : '<div class="ed-note ed-note-bad">Не задан адрес для ссылок анкеты (EDOCS_PUBLIC_URL) — автоматика не сможет отправлять анкеты.</div>')
    + '<div class="ed-sub" style="margin-bottom:6px">По умолчанию всё выключено. Ручная отправка со страницы пациента работает всегда. Ночью (тихие часы из настроек автоуведомлений) автоматика ждёт утра.</div>'
    + '<div class="fg"><label class="fl" for="edAu-sender">Отправлять от имени</label><select id="edAu-sender"><option value="">— выберите сотрудника с подключённым F.Doc —</option>'
    + senders.map((u) => opt(u.id, u.name, d.senderUserId)).join('') + '</select>'
    + (d.senders.length > senders.length ? '<div class="ed-sub">В списке только сотрудники, подключившие свою учётную запись F.Doc.</div>' : '') + '</div>'
    + '<div class="ed-au-row">' + tgl('edAu-previsit', d.previsit.on) + '<div class="grow"><h4>Договор и согласие перед визитом</h4>'
    + '<p>Если документа нет, пациент получит его заранее и подпишет дома. Не хватает паспорта — уйдёт анкета, а документы — сразу после её заполнения.</p>'
    + 'за ' + num('edAu-previsitHours', d.previsit.hours, 2, 168) + ' ч до визита · <select id="edAu-scope">' + opt('first', 'только первичным', d.previsit.scope) + opt('all', 'всем, у кого нет документов', d.previsit.scope) + '</select>'
    + '<label class="ed-switch"><input type="checkbox" id="edAu-form"' + (d.previsit.form ? ' checked' : '') + '> Если данных не хватает — отправить анкету</label></div></div>'
    + '<div class="ed-au-row">' + tgl('edAu-act', d.act.on) + '<div class="grow"><h4>Акт после оплаты визита</h4>'
    + '<p>Когда в YClients визит отмечен «пришёл» и оплачен, акт собирается из услуг записи и уходит пациенту.</p>'
    + 'через ' + num('edAu-actDelay', d.act.delayMin, 5, 240) + ' мин после оплаты</div></div>'
    + '<div class="ed-au-row">' + tgl('edAu-remind', d.remind.on) + '<div class="grow"><h4>Повтор, если не подписано</h4>'
    + '<p>Один раз: ссылка на подпись — SMS от F.Doc, анкета — повторно в мессенджер.</p>'
    + 'через ' + num('edAu-remindHours', d.remind.hours, 1, 48) + ' ч</div></div>'
    + '<div class="ed-au-row"><div class="grow"><h4>Сообщение с анкетой</h4><p>Подставляются {имя}, {клиника}, {дата}, {ссылка}. Пусто — текст по умолчанию.</p>'
    + '<textarea id="edAu-msg" placeholder="' + escAttr(d.formMessageDefault) + '">' + esc(d.formMessage || '') + '</textarea>'
    + 'Ссылка действует ' + num('edAu-ttl', d.formTtlDays, 1, 30) + ' дн.</div></div>'
    + '<div class="ed-au-row">' + tgl('edAu-autonum', d.contractAutonumber) + '<div class="grow"><h4>Номера договоров автоматически</h4>'
    + '<p>Свой номер пациента (в данных или в YClients) сохраняется; остальным — следующий по счёту. Уже выдан максимум: ' + esc(String(d.contractNext.maxUsed)) + '.</p>'
    + 'Следующий номер: ' + num('edAu-next', d.contractNext.next, 1, 999999999999) + '</div></div>'
    + '<div class="ed-au-row"><div class="grow"><h4>Акты нужны для визитов с</h4><p>Более ранние визиты дашборд не считает незакрытыми.</p>'
    + '<input type="date" id="edAu-actsFrom" value="' + escAttr(d.actsRequiredFrom || '') + '" style="width:auto"></div></div>'
    + '<div class="ed-actions"><button class="btn btn-pri" onclick="edSaveAutomation()">Сохранить</button><button class="btn btn-sec" onclick="closeModal(\'edAutoModal\')">Отмена</button></div>';
}
async function edSaveAutomation() {
  const on = (id) => document.getElementById(id).classList.contains('on');
  const d = _edAuto;
  const next = edVal('edAu-next');
  const body = {
    senderUserId: edVal('edAu-sender') || null,
    previsit: { on: on('edAu-previsit'), hours: edVal('edAu-previsitHours'), scope: edVal('edAu-scope'), form: document.getElementById('edAu-form').checked },
    act: { on: on('edAu-act'), delayMin: edVal('edAu-actDelay') },
    remind: { on: on('edAu-remind'), hours: edVal('edAu-remindHours') },
    formMessage: edVal('edAu-msg'), formTtlDays: edVal('edAu-ttl'), contractAutonumber: on('edAu-autonum'),
    actsRequiredFrom: edVal('edAu-actsFrom') || null,
  };
  if (d && String(next) !== String(d.contractNext.next)) body.contractNextNo = next;
  try {
    await api('PUT', '/api/edocs/admin/automation', body);
    notify('Настройки автоматизации сохранены');
    closeModal('edAutoModal');
    edRefreshView();
  } catch (e) { notify(e.message, 'err'); }
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
    + '<button class="btn btn-pri btn-sm" onclick="edOpenClient(' + clientId + ')">Документы пациента</button></div>'
    + '<div class="ed-sub">' + (id.exists ? 'Данные для документов: ' + esc(id.fio || '—') + (id.passportMask ? ' · паспорт ' + esc(id.passportMask) : ' · паспорт не заполнен') : 'Данные для документов не заполнены') + '</div>'
    + (s.packages || []).map((p) => {
      const st = edStatusInfo(p.status);
      return '<div class="ed-crow" onclick="edOpenPackage(\'' + p.id + '\')"><span>' + esc(p.title) + '</span><span class="badge ' + st.cls + '">' + esc(st.label) + '</span></div>';
    }).join('');
}
function edOpenClient(clientId, recordId) {
  if (typeof closeModal === 'function') closeModal('clientModal');
  location.hash = 'edocs/c/' + clientId + (recordId ? '/' + recordId : '');
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
      : '<button class="btn btn-sec btn-sm" onclick="edOpenClient(' + cid + ',' + rid + ')">📄 Акт</button>';
  });
}
