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
  annul: 'Аннулирован',
};
const ED_ORG_FIELDS = [
  ['name', 'Полное наименование'], ['inn', 'ИНН'], ['kpp', 'КПП'], ['ogrn', 'ОГРН'], ['address', 'Адрес'], ['license', 'Лицензия'],
  ['phone', 'Телефон'], ['bank', 'Банковские реквизиты'], ['signer_position', 'Должность подписанта'], ['signer_name', 'ФИО подписанта'], ['city', 'Город'],
];

function edStatusInfo(status) { return ED_STATUS[status] || { label: status || '—', cls: 'bgr' }; }
function edIsFinal(status) { return ED_FINAL.indexOf(status) >= 0; }

/** Хвост адреса после «#edocs/» → что показать. */
function edParseTail(tail) {
  const parts = String(tail || '').split('/').filter(Boolean);
  if (!parts.length) return { view: 'list' };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'p' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1] || '')) {
    return { view: 'package', packageId: parts[1].toLowerCase() };
  }
  if (parts[0] === 'new') {
    const clientId = /^\d{1,9}$/.test(parts[1] || '') ? Number(parts[1]) : null;
    const recordId = clientId && /^\d{1,9}$/.test(parts[2] || '') ? Number(parts[2]) : null;
    return { view: 'new', clientId, recordId };
  }
  return { view: 'list' };
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
