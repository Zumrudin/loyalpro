// ── «📄 Документы»: дашборд подписей (спека 2026-10-25 §4) ───────────────────────────
// Карточки пациентов по записям периода. Цвет, подпись, плитки документов, предупреждения и главное
// действие считает сервер (services/edocs/board.js) — здесь только отрисовка, фильтры и действия.
// Опрос — раз в 20 с, пока вкладка видима; таймер общий с остальными видами (_ed.timer): уход со
// страницы и смена маршрута гасят его в edStopPolling. Глобальные имена — edb*/ED_*.
let _edb = { range: 'today', chip: '', color: '', search: '', data: null, snap: null, base: { filter: 'all', search: '', page: 1 }, busy: new Set() };
const ED_BOARD_POLL_MS = 20000;
let _edbSearchTimer = null;

function edbEl(id) { return document.getElementById(id); }

function edbRender(route, seq) {
  const box = edbEl('edView-board');
  if (!box) return;
  if (_edb.range !== route.range) { _edb.chip = ''; _edb.color = ''; _edb.snap = null; }
  _edb.range = route.range;
  if (route.range === 'all') return edbRenderBase(seq);
  box.innerHTML = '<div id="edbHead"></div><div id="edbBar"></div><div id="edbChips" class="edb-chips"></div><div id="edbAuto"></div>'
    + '<div id="edbWarns" class="edb-warns"></div><div id="edbCards"><div class="edb-grid">' + '<div class="edb-skel"></div>'.repeat(6) + '</div></div>';
  edbBarRender(true);
  return edbLoad(seq, false).then(() => {
    if (seq !== _ed.loadSeq) return;   // ушли, пока грузили, — опрос не заводим
    edClearTimer();
    _ed.timer = setInterval(() => edbRefresh(false), ED_BOARD_POLL_MS);
  });
}

async function edbLoad(seq, quiet) {
  let d;
  try { d = await api('GET', '/api/edocs/board?range=' + encodeURIComponent(_edb.range)); } catch (e) {
    const el = edbEl('edbCards');
    if (!quiet && seq === _ed.loadSeq && el) el.innerHTML = '<div class="edb-empty">' + esc(e.message) + '</div>';
    return;
  }
  if (seq !== _ed.loadSeq || _ed.route.view !== 'board' || d.range !== _edb.range) return;
  const changes = edBoardChanges(_edb.snap, d.cards);
  _edb.snap = edBoardSnapshot(d.cards);
  _edb.data = d;
  edbPaint(changes.map((c) => c.key));
  if (changes.length) notify(changes.slice(0, 2).map((c) => c.text).join(' · ') + (changes.length > 2 ? ' и ещё ' + (changes.length - 2) : ''));
}

/** Перечитать дашборд: по таймеру — только если вкладка видима; force — после действия. */
function edbRefresh(force) {
  if (_ed.route.view !== 'board') return;
  if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (_edb.range === 'all') { if (force) edbBaseLoad(_ed.loadSeq); return; }
  edbLoad(_ed.loadSeq, true);
}

function edbPaint(flashKeys) { edbHeadRender(); edbBarRender(false); edbChipsRender(); edbAutoRender(); edbWarnsRender(); edbCardsRender(flashKeys || []); }

function edbHeadRender() {
  const d = _edb.data;
  const el = edbEl('edbHead');
  if (!el || !d) return;
  const s = d.summary;
  const pct = s.total ? Math.round(s.green * 100 / s.total) : 0;
  const titles = { today: 'Готовы на сегодня', tomorrow: 'Готовы на завтра', week: 'Готовы на неделю', open: 'Незакрытые визиты' };
  const sub = _edb.range === 'open'
    ? 'Прошлые визиты, где не хватает акта или договора'
    : 'Все обязательные документы подписаны у ' + s.green + ' из ' + s.total + ' ' + edPlural(s.total, 'пациента', 'пациентов', 'пациентов');
  const tile = (color, note) => '<button class="edb-tile ed-c-' + color + (_edb.color === color ? ' on' : '') + '" onclick="edbSetColor(\'' + color + '\')">'
    + '<span class="edb-k">' + esc(ED_COLOR_TITLE[color]) + '</span><b>' + s[color] + '</b><small>' + esc(note) + '</small></button>';
  el.innerHTML = '<div class="edb-sum"><div class="edb-tile edb-ready"><div class="edb-ring" style="--p:' + pct + '"><span>' + s.green + '/' + s.total + '</span></div>'
    + '<div><h3>' + esc(titles[_edb.range] || '') + '</h3><small>' + esc(sub) + '</small></div></div>'
    + tile('red', 'визит скоро или акт после оплаты') + tile('amber', 'успеть до визита') + tile('blue', 'ссылка или анкета у пациента') + tile('green', 'всё подписано') + '</div>';
}

/** full — перерисовать панель целиком (смена периода); иначе обновить только счётчики (поиск не теряет фокус). */
function edbBarRender(full) {
  const el = edbEl('edbBar');
  if (!el) return;
  const counts = (_edb.data && _edb.data.rangeCounts) || {};
  if (full || !edbEl('edbSeg-today')) {
    el.innerHTML = '<div class="edb-bar"><div class="edb-seg">' + ED_RANGES.map((r) => '<button id="edbSeg-' + r[0] + '" class="' + (r[0] === _edb.range ? 'on' : '') + '" onclick="edbSetRange(\'' + r[0] + '\')">'
      + esc(r[1]) + '<i>' + (counts[r[0]] !== undefined ? counts[r[0]] : '') + '</i></button>').join('') + '</div>'
      + '<input type="search" class="edb-search" id="edbSearch" placeholder="' + (_edb.range === 'all' ? 'Поиск по всей базе: имя или телефон' : 'Поиск по имени или телефону') + '" value="'
      + escAttr(_edb.range === 'all' ? _edb.base.search : _edb.search) + '" oninput="edbSearch(this.value)">'
      + (edIsAdmin() ? '<button class="btn btn-sec btn-sm" onclick="edOpenAutomation()">⚙ Автоматизация</button>' : '') + '</div>';
    return;
  }
  for (const r of ED_RANGES) {
    const b = edbEl('edbSeg-' + r[0]);
    if (b && counts[r[0]] !== undefined) b.innerHTML = esc(r[1]) + '<i>' + counts[r[0]] + '</i>';
  }
}

function edbChipsRender() {
  const d = _edb.data;
  const el = edbEl('edbChips');
  if (!el || !d) return;
  const dot = { no_contract: 'red', no_consent: 'red', act: 'red', waiting: 'blue', ready: 'green' };
  el.innerHTML = ED_CHIPS.map((c) => '<button class="edb-chip' + (_edb.chip === c[0] && !_edb.color ? ' on' : '') + '" onclick="edbSetChip(\'' + c[0] + '\')">'
    + (dot[c[0]] ? '<span class="edb-dot ed-c-' + dot[c[0]] + '" style="background:var(--c)"></span>' : '') + esc(c[1]) + ' <i>' + (d.chips[c[2]] || 0) + '</i></button>').join('');
}

function edbAutoRender() {
  const d = _edb.data;
  const el = edbEl('edbAuto');
  if (!el || !d) return;
  const a = d.automation;
  const parts = [
    'договор и согласие — ' + (a.previsit.on ? 'за ' + a.previsit.hours + ' ч до визита' + (a.previsit.scope === 'first' ? ' (первичным)' : '') : 'вручную'),
    'акт — ' + (a.act.on ? 'через ' + a.act.delayMin + ' мин после оплаты' : 'вручную'),
    'повтор неподписанного — ' + (a.remind.on ? 'через ' + a.remind.hours + ' ч' : 'выключен'),
  ];
  if ((a.previsit.on || a.act.on || a.remind.on) && a.senderName) parts.push('от имени: ' + a.senderName);
  el.innerHTML = '<div class="edb-auto">🤖 <span><b>Автоматизация:</b> ' + esc(parts.join(' · ')) + '</span>'
    + (edIsAdmin() ? '<button class="btn btn-sec btn-sm" onclick="edOpenAutomation()">Настроить</button>' : '') + '</div>';
}

function edbWarnsRender() {
  const d = _edb.data;
  const el = edbEl('edbWarns');
  if (!el || !d) return;
  const link = edIsAdmin() ? ' <button class="btn btn-sec btn-sm" onclick="edGo(\'settings\')">Настройки</button>' : '';
  el.innerHTML = (d.warnings || []).map((w) => {
    if (w.code === 'no_template') return '<div class="ed-note">Не загружен шаблон «' + esc(ED_KIND_LABELS[w.kind] || w.kind) + '» — карточки этот документ не проверяют.' + link + '</div>';
    if (w.code === 'org_missing') return '<div class="ed-note ed-note-bad">Не заполнены реквизиты клиники: ' + esc(w.fields.join(', ')) + ' — документы с ними не отправить.' + link + '</div>';
    return '';
  }).join('');
}

const EDB_EMPTY = { today: 'На сегодня записей нет', tomorrow: 'На завтра записей нет', week: 'На неделю записей нет', open: 'Незакрытых визитов нет — все документы подписаны' };

function edbCardsRender(flashKeys) {
  const d = _edb.data;
  const el = edbEl('edbCards');
  if (!el || !d) return;
  if (!d.cards.length) { el.innerHTML = '<div class="edb-empty">' + esc(EDB_EMPTY[_edb.range] || 'Пусто') + '</div>'; return; }
  const list = edFilterCards(d.cards, _edb.chip, _edb.color, _edb.search);
  if (!list.length) { el.innerHTML = '<div class="edb-empty">Под этот фильтр никто не попал</div>'; return; }
  const flash = new Set(flashKeys || []);
  const multiDay = _edb.range === 'week' || _edb.range === 'open';
  const groups = [];
  if (multiDay) {
    for (const c of list) {
      const g = groups[groups.length - 1];
      if (g && g.key === c.day) g.cards.push(c); else groups.push({ key: c.day, title: edDayLabel(c.day, d.today), cards: [c] });
    }
  } else {
    for (const [title, colors] of [['Требуют действия', ['red', 'amber']], ['Ждём пациента', ['blue']], ['Готово', ['green', 'grey']]]) {
      const cards = list.filter((c) => colors.indexOf(c.color) >= 0);
      if (cards.length) groups.push({ title, cards });
    }
  }
  el.innerHTML = groups.map((g) => '<div class="edb-group">' + esc(g.title) + ' · ' + g.cards.length + '</div><div class="edb-grid">'
    + g.cards.map((c) => edbCardHtml(c, flash.has(c.key), multiDay)).join('') + '</div>').join('');
}

function edbCardHtml(c, flash, multiDay) {
  const tiles = ['contract', 'consent_pd', 'act'].map((k) => '<div class="edb-doc ' + c.tiles[k].tone + '"><b>' + esc(ED_KIND_SHORT[k]) + '</b>' + esc(c.tiles[k].text) + '</div>').join('');
  const services = c.services.slice(0, 2).join(', ') + (c.services.length > 2 ? '…' : '');
  const visit = [multiDay ? edDayLabel(c.day, _edb.data.today) : '', c.time, services, c.staffName].filter(Boolean).join(' · ')
    + (c.visits.length > 1 ? ' · ' + c.visits.length + ' ' + edPlural(c.visits.length, 'визит', 'визита', 'визитов') : '');
  const warns = c.warnings.map((w) => '<div class="edb-warn' + (c.color === 'red' && /^⏱/.test(w) ? ' hot' : '') + '">' + esc(w) + '</div>').join('');
  const rid = c.action && c.action.recordId ? c.action.recordId : 0;
  return '<article class="edb-card ed-c-' + c.color + (flash ? ' flash' : '') + '" onclick="edbOpen(' + c.clientId + ',' + rid + ')">'
    + '<div class="edb-ch"><div class="edb-av">' + esc(c.initials) + '</div><div class="edb-who"><span class="edb-st">' + esc(c.label) + '</span>'
    + '<div class="edb-nm">' + esc(c.name) + '</div><div class="edb-vs">' + esc(visit) + '</div></div></div>'
    + '<div class="edb-docs">' + tiles + '</div>' + warns
    + '<div class="edb-cf"><span>' + esc(c.hint || '') + '</span>' + edbActionHtml(c) + '</div></article>';
}

function edbActionHtml(c) {
  const a = c.action;
  if (!a) return '';
  const k = escAttr(c.key);
  if (_edb.busy.has(c.key)) return '<button class="btn btn-pri btn-sm" disabled>Отправляем…</button>';
  if (a.type === 'fill') {
    return '<button class="edb-mini" title="Пациент заполнит данные сам по ссылке" onclick="event.stopPropagation();edbForm(\'' + k + '\')">✉ Анкета</button>'
      + '<button class="btn btn-pri btn-sm" onclick="event.stopPropagation();edbAct(\'' + k + '\')">' + esc(a.label) + '</button>';
  }
  if ((a.type === 'send' || a.type === 'remind') && !edCanSend()) {
    return '<button class="btn btn-sec btn-sm" title="' + escAttr(edSendBlockReason()) + '" onclick="event.stopPropagation();edbOpen(' + c.clientId + ',0)">Открыть</button>';
  }
  const wait = a.type === 'remind' && !edRemindReady(a);
  return '<button class="btn btn-pri btn-sm' + (a.ghost ? ' edb-ghost' : '') + '"' + (wait ? ' disabled title="Повторить можно через 15 минут после отправки"' : '')
    + ' onclick="event.stopPropagation();edbAct(\'' + k + '\')">' + esc(a.label) + '</button>';
}

function edbCard(key) { return (_edb.data && _edb.data.cards.find((c) => c.key === key)) || null; }
function edbOpen(clientId, recordId) { edGo('c/' + clientId + (recordId ? '/' + recordId : '')); }
function edbSetRange(r) { edGo(r === 'today' ? '' : 'r/' + r); }
function edbSetChip(chip) { _edb.chip = chip; _edb.color = ''; edbHeadRender(); edbChipsRender(); edbCardsRender([]); }
function edbSetColor(color) { _edb.color = _edb.color === color ? '' : color; _edb.chip = ''; edbHeadRender(); edbChipsRender(); edbCardsRender([]); }
function edbSearch(v) {
  clearTimeout(_edbSearchTimer);
  if (_edb.range === 'all') {
    _edb.base.search = v;
    _edb.base.page = 1;
    _edbSearchTimer = setTimeout(() => edbBaseLoad(_ed.loadSeq), 300);
    return;
  }
  _edb.search = v;
  _edbSearchTimer = setTimeout(() => edbCardsRender([]), 120);
}

async function edbAct(key) {
  const c = edbCard(key);
  if (!c || !c.action || _edb.busy.has(key)) return;
  const a = c.action;
  if (a.type === 'fill') { _edcOpenData = true; return edbOpen(c.clientId, a.recordId || 0); }
  if (a.type === 'send') return edbSend(c);
  if (a.type === 'remind') return edbRemind(c);
  if (a.type === 'form_remind') return edbFormRemind(c);
}
function edbForm(key) { const c = edbCard(key); if (c) edFormOpen(c.clientId, { recordId: c.action && c.action.recordId }); }

async function edbSend(c) {
  const a = c.action;
  const d = _edb.data;
  const tpl = a.kinds.map((k) => d.kinds[k]).filter(Boolean);
  if (tpl.length !== a.kinds.length) return notify('Нет шаблона одного из документов — загрузите его в настройках', 'err');
  const withAct = a.kinds.indexOf('act') >= 0;
  let actHtml = '';
  if (withAct) {
    let dr;
    try { dr = await api('GET', '/api/edocs/records/' + a.recordId + '/act-draft'); } catch (e) { return notify(e.message, 'err'); }
    actHtml = '<div class="ed-sub" style="margin-top:6px">Акт: ' + dr.lines.map((l) => esc(l.title)).join(', ') + ' — итого ' + esc(edMoney(dr.totals.total_sum))
      + '. Поправить строки можно на странице пациента.</div>';
  }
  const ok = await edConfirm({ title: 'Отправить на подпись?', ok: 'Отправить',
    html: '<b>' + esc(c.name) + '</b> получит SMS со ссылкой и подпишет документы кодом из SMS.<ul style="margin:8px 0 0 18px">'
      + tpl.map((t) => '<li>' + esc(t.title) + '</li>').join('') + '</ul>' + actHtml });
  if (!ok) return;
  _edb.busy.add(c.key);
  _ed.sending = true;
  edbCardsRender([]);
  let r;
  try { r = await edFetch('POST', '/api/edocs/packages', { json: { clientId: c.clientId, templateIds: tpl.map((t) => t.id), recordId: withAct ? a.recordId : null } }); }
  finally { _ed.sending = false; _edb.busy.delete(c.key); }
  if (edSendOutcome(r) !== 'package') edbRefresh(true); else edbCardsRender([]);
}

async function edbRemind(c) {
  if (!edRemindReady(c.action)) return notify('Повторить ссылку можно через 15 минут после отправки', 'err');
  const ok = await edConfirm({ title: 'Отправить ссылку ещё раз?', ok: 'Отправить', html: '<b>' + esc(c.name) + '</b> получит SMS со ссылкой на подписание ещё раз.' });
  if (!ok) return;
  _edb.busy.add(c.key);
  edbCardsRender([]);
  try {
    await api('POST', '/api/edocs/packages/' + c.action.packageId + '/permalink');
    notify('Ссылка отправлена пациенту ещё раз');
  } catch (e) { notify(e.message, 'err'); if (/Мой F\.Doc/.test(e.message)) edOpenMe(); }
  finally { _edb.busy.delete(c.key); }
  edbRefresh(true);
}

async function edbFormRemind(c) {
  _edb.busy.add(c.key);
  edbCardsRender([]);
  try {
    const r = await api('POST', '/api/edocs/forms/' + c.action.formId + '/send');
    if (r.ok) notify('Анкета отправлена повторно в ' + (ED_VIA[r.channel] || r.channel));
    else notify('Анкета не доставлена: ' + (r.error || 'нет ответа') + ' — покажите пациенту QR-код', 'err');
  } catch (e) { notify(e.message, 'err'); }
  finally { _edb.busy.delete(c.key); }
  edbRefresh(true);
}

// ── «Вся база»: все пациенты с флагами документов, серверный поиск и фильтр ──
function edbRenderBase(seq) {
  const box = edbEl('edView-board');
  box.innerHTML = '<div id="edbBar"></div><div class="edb-chips" id="edbBaseFilters"></div><div class="card" id="edbBaseList" style="padding:0"><div class="empty">Загрузка…</div></div>';
  edbBarRender(true);
  edbBaseFiltersRender();
  return edbBaseLoad(seq);
}
function edbBaseFiltersRender() {
  const el = edbEl('edbBaseFilters');
  if (el) el.innerHTML = ED_BASE_FILTERS.map((f) => '<button class="edb-chip' + (_edb.base.filter === f[0] ? ' on' : '') + '" onclick="edbBaseFilter(\'' + f[0] + '\')">' + esc(f[1]) + '</button>').join('');
}
function edbBaseFilter(f) { _edb.base.filter = f; _edb.base.page = 1; edbBaseFiltersRender(); edbBaseLoad(_ed.loadSeq); }
function edbBasePage(n) { _edb.base.page = Math.max(1, n); edbBaseLoad(_ed.loadSeq); }
async function edbBaseLoad(seq) {
  const el = edbEl('edbBaseList');
  if (!el) return;
  const b = _edb.base;
  let d;
  try { d = await api('GET', '/api/edocs/board/clients?filter=' + encodeURIComponent(b.filter) + '&page=' + b.page + '&search=' + encodeURIComponent(b.search || '')); }
  catch (e) { if (seq === _ed.loadSeq) el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  if (seq !== _ed.loadSeq || _edb.range !== 'all') return;
  const yes = (v) => (v ? '<span class="edb-yes">✓ есть</span>' : '<span class="edb-no">нет</span>');
  const pages = Math.max(1, Math.ceil(d.total / 50));
  el.innerHTML = '<div class="edb-base-row edb-base-head"><span>Пациент</span><span>Договор</span><span>Согласие ПД</span><span class="edb-col-hide">Незакрытые акты</span><span class="edb-col-hide">Последний визит</span></div>'
    + (d.rows.length ? d.rows.map((r) => '<div class="edb-base-row" onclick="edbOpen(' + r.id + ',0)"><span><b>' + esc(r.name || '—') + '</b><br><span class="ed-sub">' + esc(edPhone(r.phone)) + '</span></span>'
      + '<span>' + yes(r.contract) + '</span><span>' + yes(r.consent) + (r.pending ? ' <span class="badge bb">ждёт</span>' : '') + '</span>'
      + '<span class="edb-col-hide">' + (r.openActs ? '<span class="edb-no">' + r.openActs + '</span>' : '—') + '</span>'
      + '<span class="edb-col-hide">' + esc(r.lastVisitAt ? edFmtDate(String(r.lastVisitAt).slice(0, 10)) : '—') + '</span></div>').join('')
      : '<div class="empty">Никого не нашли</div>')
    + '<div class="edb-pager" style="padding:8px 12px">Всего: ' + d.total + (pages > 1 ? ' · стр. ' + d.page + ' из ' + pages
      + ' <button class="btn btn-sec btn-sm" onclick="edbBasePage(' + (d.page - 1) + ')"' + (d.page <= 1 ? ' disabled' : '') + '>‹</button>'
      + '<button class="btn btn-sec btn-sm" onclick="edbBasePage(' + (d.page + 1) + ')"' + (d.page >= pages ? ' disabled' : '') + '>›</button>' : '') + '</div>';
}
