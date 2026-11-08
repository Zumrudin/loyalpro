// ── «📄 ДОКУМЕНТЫ»: чистые помощники без DOM ─────────────────────────────────────
// Тесты: node --test frontend/js/pages/edocs.test.js (грузит этот файл вместе со всеми
// скриптами index.html в один vm-контекст — общая глобальная область браузера).
// Имена — с префиксом ed/ED_: верхнеуровневый const с занятым именем гасит весь файл.

const ED_STATUS = {
  draft:    { label: 'Не отправлен',       cls: 'bgr' },
  sent:     { label: 'Ждёт подписи',       cls: 'bb' },
  signed:   { label: 'Подписан',           cls: 'bg' },
  paper:    { label: 'Подписан на бумаге', cls: 'bg' },
  error:    { label: 'Ошибка F.Doc',       cls: 'bo' },
  declined: { label: 'Пациент отказался',  cls: 'br' },
  annulled: { label: 'Аннулирован',        cls: 'br' },
  expired:  { label: 'Срок истёк',         cls: 'br' },
};
const ED_FINAL = ['declined', 'annulled', 'expired', 'paper'];
const ED_KIND_LABELS = { contract: 'Договор', consent_pd: 'Согласие на обработку ПДн', act: 'Акт оказанных услуг', other: 'Другой документ' };
const ED_PLAIN_FIELDS = [
  ['last_name', 'Фамилия'], ['first_name', 'Имя'], ['middle_name', 'Отчество'], ['birth_date', 'Дата рождения'],
  ['gender', 'Пол'], ['phone', 'Телефон'], ['email', 'E-mail'], ['contract_no', 'Номер договора'], ['contract_date', 'Дата договора'],
];
const ED_SECURE_FIELDS = [
  ['passport_series', 'Серия'], ['passport_number', 'Номер'], ['issue_date', 'Дата выдачи'], ['authority_code', 'Код подразделения'],
  ['issued_by', 'Кем выдан'], ['birth_place', 'Место рождения'], ['address', 'Адрес регистрации'],
];
const ED_EVENT_LABELS = {
  send: 'Отправлен в F.Doc', send_error: 'F.Doc не принял комплект', send_recovered: 'Найден в F.Doc после сбоя связи',
  status: 'Статус изменился', webhook: 'Уведомление F.Doc', pdf: 'Подписанные PDF получены', permalink: 'Ссылка отправлена пациенту ещё раз',
  annul: 'Аннулирован', paper: 'Отмечено: подписано на бумаге', paper_revoke: 'Отметка «на бумаге» снята',
  form_created: 'Создана анкета пациента', form_sent: 'Анкета отправлена пациенту', form_send_error: 'Анкета не доставлена',
  form_opened: 'Пациент открыл анкету', form_photo: 'Пациент распознал паспорт по фото', form_submitted: 'Пациент заполнил анкету',
  form_revoked: 'Анкета отозвана', form_expired: 'Срок анкеты истёк', form_docs_sent: 'Документы ушли после анкеты',
  form_docs_error: 'Документы после анкеты не ушли', contract_no: 'Присвоен номер договора', identity_edit: 'Данные пациента изменены',
  identity_view: 'Данные пациента просмотрены', identity_prefill: 'Данные подставлены из YClients', recognize: 'Паспорт распознан по фото',
  preview: 'Документ скачан для проверки', credentials: 'Учётная запись F.Doc',
};
// Дашборд и страница пациента (спека 2026-10-25): подписи видов, периодов, фильтров, мессенджеров.
const ED_KIND_SHORT = { contract: 'Договор', consent_pd: 'Согласие ПД', act: 'Акт' };
const ED_RANGES = [['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['week', 'Неделя'], ['open', 'Незакрытые'], ['all', 'Вся база']];
const ED_CHIPS = [['', 'Все', 'all'], ['no_contract', 'Нет договора', 'no_contract'], ['no_consent', 'Нет согласия ПД', 'no_consent'],
  ['act', 'Акт не подписан', 'act'], ['waiting', 'Ждём подпись', 'waiting'], ['ready', 'Готово', 'ready']];
const ED_BASE_FILTERS = [['all', 'Все'], ['no_contract', 'Без договора'], ['no_consent', 'Без согласия'], ['open_acts', 'Незакрытые акты'], ['pending', 'Ждут подписи'], ['ready', 'Всё есть']];
const ED_COLOR_TITLE = { red: 'Срочно', amber: 'До визита', blue: 'Ждём подпись', green: 'Готово' };
const ED_VIA = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };
const ED_ORG_FIELDS = [
  ['name', 'Полное наименование'], ['inn', 'ИНН'], ['kpp', 'КПП'], ['ogrn', 'ОГРН'], ['address', 'Адрес'], ['license', 'Лицензия'],
  ['phone', 'Телефон'], ['bank', 'Банковские реквизиты'], ['signer_position', 'Должность подписанта'], ['signer_name', 'ФИО подписанта'], ['city', 'Город'],
];

function edStatusInfo(status) { return ED_STATUS[status] || { label: status || '—', cls: 'bgr' }; }
function edIsFinal(status) { return ED_FINAL.indexOf(status) >= 0; }

/**
 * Хвост адреса после «#edocs/» → что показать:
 *   '' — дашборд «Сегодня»; r/<tomorrow|week|open|all> — другой период; c/<пациент>[/<запись>] — страница
 *   пациента; packages — все комплекты; p/<uuid> — комплект; settings — настройки. Старые адреса мастера
 *   new/<пациент>[/<запись>] ведут на страницу пациента (legacy — переписать адрес), new — к поиску по базе.
 */
function edParseTail(tail) {
  const parts = String(tail || '').split('/').filter(Boolean);
  const board = (range) => ({ view: 'board', range });
  if (!parts.length) return board('today');
  if (parts[0] === 'r') return board(['tomorrow', 'week', 'open', 'all'].indexOf(parts[1]) >= 0 ? parts[1] : 'today');
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'packages') return { view: 'list' };
  if (parts[0] === 'p' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1] || '')) {
    return { view: 'package', packageId: parts[1].toLowerCase() };
  }
  if (parts[0] === 'c' || parts[0] === 'new') {
    const clientId = /^\d{1,9}$/.test(parts[1] || '') ? Number(parts[1]) : null;
    const recordId = clientId && /^\d{1,9}$/.test(parts[2] || '') ? Number(parts[2]) : null;
    if (!clientId) return board(parts[0] === 'new' ? 'all' : 'today');
    const r = { view: 'client', clientId, recordId };
    if (parts[0] === 'new') r.legacy = true;
    return r;
  }
  return board('today');
}
/** Адрес (хвост) маршрута — обратная операция к edParseTail. */
function edTailOf(route) {
  if (!route) return '';
  if (route.view === 'board') return route.range && route.range !== 'today' ? 'r/' + route.range : '';
  if (route.view === 'client') return 'c/' + route.clientId + (route.recordId ? '/' + route.recordId : '');
  if (route.view === 'package') return 'p/' + route.packageId;
  if (route.view === 'list') return 'packages';
  if (route.view === 'settings') return 'settings';
  return '';
}

function edFmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? m[3] + '.' + m[2] + '.' + m[1] : '—';
}
function edFmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}
function edMoney(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}
function edPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!/^7\d{10}$/.test(d)) return String(p || '');
  return '+7 (' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9);
}
/** Число из поля ввода: «3 500,50» → 3500.5; пусто или мусор → NaN. */
function edNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v === undefined || v === null ? '' : v).replace(/[\s ]/g, '').replace(',', '.');
  return s === '' ? NaN : Number(s);
}

/** Ответ сервера { identity: [{key,label}], org: [...] } → строка для формы. */
function edMissingText(missing) {
  if (!missing) return '';
  const parts = [];
  if (missing.identity && missing.identity.length) parts.push('Не хватает данных пациента: ' + missing.identity.map((x) => x.label).join(', '));
  if (missing.org && missing.org.length) parts.push('Не заполнены реквизиты клиники: ' + missing.org.map((x) => x.label).join(', '));
  return parts.join('. ');
}

/** Итоги акта как на сервере (act-lines.actTotals): скидка строки = qty × price − sum, не меньше 0. */
function edActTotals(lines) {
  let total = 0, discount = 0;
  for (const l of lines || []) {
    const qty = edNum(l.qty), price = edNum(l.price), sum = edNum(l.sum);
    if (!(qty > 0) || !(price >= 0) || !(sum >= 0)) continue;
    total += sum;
    discount += Math.max(0, qty * price - sum);
  }
  return { total: Math.round(total * 100) / 100, discount: Math.round(discount * 100) / 100 };
}

/** Строки акта из формы → тело запроса; ошибка — с номером строки (сервер проверит ещё раз). */
function edCollectActLines(rows) {
  const out = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i];
    if (!r.include) continue;
    const title = String(r.title || '').replace(/\s+/g, ' ').trim();
    const qty = edNum(r.qty), price = edNum(r.price), sum = edNum(r.sum);
    if (!title) return { error: 'Строка ' + (i + 1) + ': пустое название' };
    if (!(qty > 0)) return { error: 'Строка ' + (i + 1) + ': количество больше 0' };
    if (!(price >= 0) || !(sum >= 0)) return { error: 'Строка ' + (i + 1) + ': цена и сумма — числа от 0' };
    out.push({ service_id: r.service_id || null, title: title, qty: qty, price: price, sum: sum });
  }
  if (!out.length) return { error: 'Отметьте хотя бы одну услугу' };
  return { value: out };
}

/** Тело PUT /clients/:id/identity из значений формы; get(key) возвращает значение поля. */
function edIdentityBody(get, source) {
  const body = { secure: {} };
  for (const f of ED_PLAIN_FIELDS) body[f[0]] = String(get(f[0]) || '').trim();
  for (const f of ED_SECURE_FIELDS) body.secure[f[0]] = String(get(f[0]) || '').trim();
  if (source) body.source = source;
  return body;
}

// ── дашборд и страница пациента ──
/** Карточки по фильтру-чипу (теги считает сервер), цвету плитки сводки и поиску по имени/телефону. */
function edFilterCards(cards, chip, color, search) {
  const q = String(search || '').trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  return (cards || []).filter((c) => {
    if (chip && (c.tags || []).indexOf(chip) < 0) return false;
    if (color && c.color !== color) return false;
    if (!q) return true;
    if (digits.length >= 3 && String(c.phone || '').replace(/\D/g, '').indexOf(digits) >= 0) return true;
    return String(c.name || '').toLowerCase().indexOf(q) >= 0;
  });
}
/** Снимок для сравнения между опросами: ключ карточки → цвет и состояния документов. */
function edBoardSnapshot(cards) {
  const m = {};
  for (const c of cards || []) m[c.key] = { color: c.color, contract: c.docs.contract.state, consent_pd: c.docs.consent_pd.state, act: c.docs.act.state, name: c.name };
  return m;
}
/**
 * Что изменилось с прошлого опроса — для всплывающего сообщения: подписанные документы и карточки,
 * ставшие зелёными. Первый опрос (prev = null) ничего не сообщает. @returns [{ key, text }]
 */
function edBoardChanges(prev, cards) {
  if (!prev) return [];
  const out = [];
  for (const c of cards || []) {
    const was = prev[c.key];
    if (!was) continue;
    const signed = ['contract', 'consent_pd', 'act'].filter((k) => c.docs[k].state === 'signed' && was[k] !== 'signed');
    if (signed.length) out.push({ key: c.key, text: c.name + ': подписан' + (signed.length > 1 ? 'ы ' : ' ') + signed.map((k) => ED_KIND_SHORT[k].toLowerCase()).join(', ') });
    else if (c.color === 'green' && was.color !== 'green') out.push({ key: c.key, text: c.name + ': документы готовы' });
  }
  return out;
}
/** «Сегодня» / «Завтра» / «Вчера» / «пн, 27.10» по дате 'YYYY-MM-DD' относительно today. */
function edDayLabel(day, today) {
  const d = Date.parse(String(day) + 'T00:00:00Z'), t = Date.parse(String(today) + 'T00:00:00Z');
  if (!isFinite(d) || !isFinite(t)) return '';
  const diff = Math.round((d - t) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === -1) return 'Вчера';
  const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][new Date(d).getUTCDay()];
  return wd + ', ' + String(day).slice(8, 10) + '.' + String(day).slice(5, 7);
}
/** «Повторить ссылку» доступна (сервер прислал availableAt — не раньше 15 минут после отправки). */
function edRemindReady(action, nowMs) {
  if (!action || !action.availableAt) return true;
  const t = Date.parse(action.availableAt);
  return !isFinite(t) || (nowMs === undefined ? Date.now() : nowMs) >= t;
}
/** 1 поле / 2 поля / 5 полей. */
function edPlural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}
