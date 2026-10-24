'use strict';
// Словарь тегов DOCX-шаблонов «Документов» — ЕДИНСТВЕННЫЙ источник истины: по нему
// проверяется загруженный шаблон, строится подсказка в настройках и считается,
// каких данных не хватает перед отправкой. Новый тег — сюда и в fill.js.
//   requires — ключи данных пациента (client_identity), без которых тег не заполнить;
//   org      — ключ реквизитов клиники (edoc_settings.requisites);
//   actOnly  — тег разрешён только в шаблоне вида «акт»; loop — цикл строк акта.
const KINDS = ['contract', 'consent_pd', 'act', 'other'];
const KIND_LABELS = {
  contract: 'Договор', consent_pd: 'Согласие на обработку ПДн', act: 'Акт оказанных услуг', other: 'Другой документ',
};

const FIELDS = {
  fio:                     { label: 'ФИО пациента полностью', requires: ['last_name', 'first_name'] },
  fio_short:               { label: 'Фамилия и инициалы', requires: ['last_name', 'first_name'] },
  last_name:               { label: 'Фамилия', requires: ['last_name'] },
  first_name:              { label: 'Имя', requires: ['first_name'] },
  middle_name:             { label: 'Отчество (может отсутствовать)', requires: [] },
  birth_date:              { label: 'Дата рождения', requires: ['birth_date'] },
  gender:                  { label: 'Пол: «женский» / «мужской»', requires: ['gender'] },
  phone:                   { label: 'Телефон', requires: ['phone'] },
  email:                   { label: 'E-mail', requires: ['email'] },
  passport:                { label: 'Паспорт: серия и номер', requires: ['passport_series', 'passport_number'] },
  passport_series:         { label: 'Паспорт: серия', requires: ['passport_series'] },
  passport_number:         { label: 'Паспорт: номер', requires: ['passport_number'] },
  passport_issued_by:      { label: 'Паспорт: кем выдан', requires: ['issued_by'] },
  passport_issue_date:     { label: 'Паспорт: дата выдачи', requires: ['issue_date'] },
  passport_authority_code: { label: 'Паспорт: код подразделения', requires: ['authority_code'] },
  birth_place:             { label: 'Место рождения', requires: ['birth_place'] },
  address:                 { label: 'Адрес регистрации', requires: ['address'] },
  contract_no:             { label: 'Номер договора', requires: ['contract_no'] },
  contract_date:           { label: 'Дата договора (пусто — дата документа)', requires: [] },
  doc_date:                { label: 'Дата документа', requires: [] },
  doc_city:                { label: 'Город', requires: [], org: 'city' },
  org_name:                { label: 'Клиника: полное наименование', requires: [], org: 'name' },
  org_inn:                 { label: 'Клиника: ИНН', requires: [], org: 'inn' },
  org_kpp:                 { label: 'Клиника: КПП', requires: [], org: 'kpp' },
  org_ogrn:                { label: 'Клиника: ОГРН', requires: [], org: 'ogrn' },
  org_address:             { label: 'Клиника: адрес', requires: [], org: 'address' },
  org_license:             { label: 'Клиника: лицензия', requires: [], org: 'license' },
  org_phone:               { label: 'Клиника: телефон', requires: [], org: 'phone' },
  org_bank:                { label: 'Клиника: банковские реквизиты', requires: [], org: 'bank' },
  org_signer_position:     { label: 'Клиника: должность подписанта', requires: [], org: 'signer_position' },
  org_signer_name:         { label: 'Клиника: ФИО подписанта', requires: [], org: 'signer_name' },
  act_no:                  { label: 'Номер акта', requires: [], actOnly: true },
  visit_date:              { label: 'Дата визита', requires: [], actOnly: true },
  doctor_name:             { label: 'Врач', requires: [], actOnly: true },
  doctor_position:         { label: 'Должность врача', requires: [], actOnly: true },
  total_sum:               { label: 'Итого, ₽', requires: [], actOnly: true },
  total_sum_words:         { label: 'Итого прописью', requires: [], actOnly: true },
  services:                { label: 'Строки акта: {#services}…{/services}', requires: [], actOnly: true, loop: true },
};
const SERVICE_FIELDS = {
  n: '№ строки', title: 'Услуга', qty: 'Количество', price: 'Цена за единицу', discount: 'Скидка, ₽', sum: 'Сумма',
};

const ORG_KEYS = ['name', 'inn', 'kpp', 'ogrn', 'address', 'license', 'phone', 'bank', 'signer_position', 'signer_name', 'city'];
const ORG_LABELS = {
  name: 'Полное наименование', inn: 'ИНН', kpp: 'КПП', ogrn: 'ОГРН', address: 'Адрес', license: 'Лицензия',
  phone: 'Телефон', bank: 'Банковские реквизиты', signer_position: 'Должность подписанта',
  signer_name: 'ФИО подписанта', city: 'Город',
};
const IDENTITY_LABELS = {
  last_name: 'Фамилия', first_name: 'Имя', middle_name: 'Отчество', birth_date: 'Дата рождения', gender: 'Пол',
  phone: 'Телефон', email: 'E-mail', contract_no: 'Номер договора', contract_date: 'Дата договора',
  passport_series: 'Серия паспорта', passport_number: 'Номер паспорта', issued_by: 'Кем выдан паспорт',
  issue_date: 'Дата выдачи паспорта', authority_code: 'Код подразделения', birth_place: 'Место рождения',
  address: 'Адрес регистрации',
};
// Без этого подписант не уйдёт в F.Doc вовсе (ФИО и телефон клиента обязательны).
const ALWAYS_REQUIRED = ['last_name', 'first_name', 'phone'];

/**
 * Проверка тегов шаблона. tags — теги всего документа одним объектом
 * (docx.inspect): { fio: {}, services: { n: {}, title: {} } }.
 * @returns {{ ok: boolean, errors: string[], placeholders: string[] }}
 */
function validateTags(tags, kind) {
  const errors = [];
  if (!KINDS.includes(kind)) errors.push(`Неизвестный вид документа: ${kind}`);
  const names = Object.keys(tags || {});
  for (const name of names) {
    const f = FIELDS[name];
    if (!f) { errors.push(`Неизвестный тег {${name}}`); continue; }
    if (f.actOnly && kind !== 'act') errors.push(`Тег {${name}} разрешён только в шаблоне акта`);
    const inner = Object.keys(tags[name] || {});
    if (f.loop) {
      for (const s of inner) if (!SERVICE_FIELDS[s]) errors.push(`Неизвестный тег {${s}} внутри цикла {#services}`);
    } else if (inner.length) {
      errors.push(`Тег {${name}} — не цикл: внутри {#${name}}…{/${name}} тегов быть не может`);
    }
  }
  return { ok: errors.length === 0, errors, placeholders: names.filter((n) => FIELDS[n]).sort() };
}

/**
 * Каких данных не хватает для набора шаблонов. Работает БЕЗ расшифровки паспорта:
 * заполненность секретных полей — по identity.secure_fields.
 * identity — строка client_identity (или null), templates — [{ placeholders }].
 * @returns {{ identity: Array<{key,label}>, org: Array<{key,label}> }}
 */
function missingFor(identity, templates, requisites) {
  const have = new Set();
  for (const [k, v] of Object.entries(identity || {})) {
    if (k !== 'secure_fields' && v !== null && v !== undefined && String(v).trim() !== '') have.add(k);
  }
  for (const k of (identity && identity.secure_fields) || []) have.add(k);
  const needIdentity = new Set(ALWAYS_REQUIRED);
  const needOrg = new Set();
  for (const t of templates || []) {
    for (const name of t.placeholders || []) {
      const f = FIELDS[name];
      if (!f) continue;
      for (const r of f.requires) needIdentity.add(r);
      if (f.org) needOrg.add(f.org);
    }
  }
  const req = requisites || {};
  return {
    identity: [...needIdentity].filter((k) => !have.has(k)).sort().map((key) => ({ key, label: IDENTITY_LABELS[key] || key })),
    org: [...needOrg].filter((k) => !String(req[k] || '').trim()).sort().map((key) => ({ key, label: ORG_LABELS[key] || key })),
  };
}

/** Словарь для подсказки в настройках: [{ tag, label, actOnly, loop }] + поля строки акта. */
function dictionary() {
  return {
    fields: Object.entries(FIELDS).map(([tag, f]) => ({ tag, label: f.label, actOnly: !!f.actOnly, loop: !!f.loop })),
    serviceFields: Object.entries(SERVICE_FIELDS).map(([tag, label]) => ({ tag, label })),
    kinds: KINDS.map((k) => ({ kind: k, label: KIND_LABELS[k] })),
  };
}

module.exports = {
  KINDS, KIND_LABELS, FIELDS, SERVICE_FIELDS, ORG_KEYS, ORG_LABELS, IDENTITY_LABELS, ALWAYS_REQUIRED,
  validateTags, missingFor, dictionary,
};
