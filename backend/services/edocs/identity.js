'use strict';
// Данные пациента для документов: проверка формы, шифрование паспортной части,
// маска для экранов и предзаполнение из карточки YClients и заявки на справку.
// Чистый модуль: БД — в store.js, ключ шифрования — снаружи (box).
const { isCalendarDate, todayMsk } = require('../../utils/period');
const { normalizePhoneKey } = require('../agent-gate');
const { splitFullName, cap } = require('./fio');

const PLAIN_KEYS = ['last_name', 'first_name', 'middle_name', 'birth_date', 'gender', 'phone', 'email', 'contract_no', 'contract_date'];
const SECURE_KEYS = ['passport_series', 'passport_number', 'issued_by', 'issue_date', 'authority_code', 'birth_place', 'address'];

// Управляющие символы недопустимы в XML документа, bidi — подмена порядка текста.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;
const NAME_RE = /^[\p{L}][\p{L}' .-]*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Проверка тела PUT /clients/:id/identity. Пустые поля законны: полноту под конкретные
 * шаблоны проверяет placeholders.missingFor перед отправкой.
 * @returns {{ value: { plain: object, secure: object } } | { error: string }}
 */
function validateIdentity(body, today = todayMsk()) {
  const b = body || {};
  const plain = {};
  for (const [key, label] of [['last_name', 'Фамилия'], ['first_name', 'Имя'], ['middle_name', 'Отчество']]) {
    const v = clean(b[key], 100);
    if (v && !NAME_RE.test(v)) return { error: `${label}: только буквы, пробел, дефис и апостроф` };
    plain[key] = v;
  }
  const date = (key, label, { past = true } = {}) => {
    const v = clean(b[key], 10);
    if (!v) return { v: null };
    if (!isCalendarDate(v) || v < '1900-01-01' || (past && v > today)) return { error: `${label}: неверная дата` };
    return { v };
  };
  for (const [key, label, past] of [['birth_date', 'Дата рождения', true], ['contract_date', 'Дата договора', false]]) {
    const r = date(key, label, { past }); if (r.error) return r; plain[key] = r.v;
  }
  const g = clean(b.gender, 1).toUpperCase();
  if (g && g !== 'F' && g !== 'M') return { error: 'Пол: F или M' };
  plain.gender = g || null;
  const phoneRaw = clean(b.phone, 30);
  const phone = phoneRaw ? normalizePhoneKey(phoneRaw) : '';
  if (phone && !/^7\d{10}$/.test(phone)) return { error: 'Телефон: 11 цифр, начиная с 7 или 8' };
  plain.phone = phone || null;
  const email = clean(b.email, 200);
  if (email && !EMAIL_RE.test(email)) return { error: 'E-mail: неверный формат' };
  plain.email = email || null;
  plain.contract_no = clean(b.contract_no, 50) || null;

  const s = b.secure || {};
  const secure = {};
  const digits = (v) => clean(v, 20).replace(/\D/g, '');
  const series = digits(s.passport_series);
  if (series && series.length !== 4) return { error: 'Серия паспорта: 4 цифры' };
  if (series) secure.passport_series = series;
  const number = digits(s.passport_number);
  if (number && number.length !== 6) return { error: 'Номер паспорта: 6 цифр' };
  if (number) secure.passport_number = number;
  const issuedBy = clean(s.issued_by, 300); if (issuedBy) secure.issued_by = issuedBy;
  const issue = clean(s.issue_date, 10);
  if (issue) {
    if (!isCalendarDate(issue) || issue < '1900-01-01' || issue > today) return { error: 'Дата выдачи паспорта: неверная дата' };
    secure.issue_date = issue;
  }
  const code = digits(s.authority_code);
  if (code && code.length !== 6) return { error: 'Код подразделения: 6 цифр' };
  if (code) secure.authority_code = `${code.slice(0, 3)}-${code.slice(3)}`;
  const place = clean(s.birth_place, 300); if (place) secure.birth_place = place;
  const address = clean(s.address, 500); if (address) secure.address = address;
  return { value: { plain, secure } };
}

/** Колонки для UPSERT client_identity: паспортная часть одним шифротекстом. */
function encodeSecure(secure, box) {
  const keys = SECURE_KEYS.filter((k) => secure && secure[k]);
  if (!keys.length) return { secure_enc: null, secure_fields: [] };
  const obj = {}; for (const k of keys) obj[k] = secure[k];
  return { secure_enc: box.encryptJson(obj), secure_fields: keys };
}

/** Строка client_identity → { plain, secure } (secure расшифровывается). */
function decodeRow(row, box) {
  if (!row) return null;
  const plain = {};
  for (const k of PLAIN_KEYS) plain[k] = row[k] === undefined ? null : row[k];
  const secure = row.secure_enc ? box.decryptJson(row.secure_enc) : {};
  return { plain, secure, secure_fields: row.secure_fields || [] };
}

/** «45** ****56» — серия и номер для экранов, где полный паспорт не нужен. */
function maskPassport(secure) {
  const s = (secure && secure.passport_series) || '', n = (secure && secure.passport_number) || '';
  const parts = [];
  if (s) parts.push(`${s.slice(0, 2)}**`);
  if (n) parts.push(`****${n.slice(-2)}`);
  return parts.join(' ');
}

/**
 * Кандидаты для пустой формы — ничего не сохраняет.
 * client — строка clients с birthday_iso ('YYYY-MM-DD' через to_char: DATE из pg в
 * TZ Москвы, toISOString дал бы вчерашний день) и yclients_data.
 * cert — последняя заявка на справку этого пациента (даты тоже через to_char) или null.
 */
function prefillFrom(client, cert) {
  const c = client || {};
  const yc = c.yclients_data || {};
  const notes = [];
  let fio;
  if (String(yc.surname || '').trim()) {
    fio = { last_name: cap(yc.surname), first_name: cap(yc.name), middle_name: cap(yc.patronymic || ''), confident: true };
  } else {
    fio = splitFullName(c.name);
    if (!fio.confident && (fio.last_name || fio.first_name)) {
      notes.push(`ФИО разложено по карточке «${clean(c.name, 120)}» без уверенности — проверьте фамилию и имя`);
    }
  }
  const sex = Number(yc.sex_id);
  const custom = yc.custom_fields && typeof yc.custom_fields === 'object' ? yc.custom_fields : {};
  const contract = custom['nomer-dogovra'];
  const plain = {
    last_name: fio.last_name || '', first_name: fio.first_name || '', middle_name: fio.middle_name || '',
    birth_date: c.birthday_iso || null,
    gender: sex === 2 ? 'F' : sex === 1 ? 'M' : null,
    phone: normalizePhoneKey(c.phone) || null,
    email: clean(c.email || yc.email, 200) || null,
    contract_no: contract !== undefined && contract !== null && String(contract).trim() ? clean(contract, 50) : null,
    contract_date: null,
  };
  const secure = {};
  if (cert) {
    const payer = !!cert.payer_is_patient;
    const type = payer ? cert.payer_doc_type_code : cert.patient_doc_type_code;
    const sn = String((payer ? cert.payer_doc_serie_number : cert.patient_doc_serie_number) || '').replace(/\D/g, '');
    if (type === '21' && sn.length === 10) {
      secure.passport_series = sn.slice(0, 4);
      secure.passport_number = sn.slice(4);
      const issue = payer ? cert.payer_doc_issue_date_iso : cert.patient_doc_issue_date_iso;
      if (issue) secure.issue_date = issue;
      notes.push(`Серия и номер паспорта${issue ? ' и дата выдачи' : ''} — из заявки на справку от ${cert.created_date || '—'}`);
    }
    if (!plain.birth_date) plain.birth_date = (payer ? cert.payer_birthdate_iso : cert.patient_birthdate_iso) || null;
  }
  return { plain, secure, notes, confident: !!fio.confident };
}

/**
 * Ответ распознавания паспорта F.Doc (RecognizedDocumentResult) → поля формы.
 * Ничего не сохраняет: администратор проверяет поля глазами и жмёт «Сохранить».
 */
function fromRecognized(r) {
  const f = (r && r.fields) || {};
  const val = (k) => (f[k] && typeof f[k].value === 'string' ? clean(f[k].value, 300) : '');
  const iso = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(val(k)) ? val(k) : '');
  const plain = {};
  const secure = {};
  if (val('surname_nat')) plain.last_name = cap(val('surname_nat'));
  if (val('given_name_nat')) plain.first_name = cap(val('given_name_nat'));
  if (val('patronymic_nat')) plain.middle_name = cap(val('patronymic_nat'));
  if (iso('birth_date')) plain.birth_date = iso('birth_date');
  const sex = val('sex').toUpperCase();
  if (sex.startsWith('F') || sex.startsWith('Ж')) plain.gender = 'F';
  else if (sex.startsWith('M') || sex.startsWith('М')) plain.gender = 'M';
  const series = val('document_series').replace(/\D/g, '');
  if (series.length === 4) secure.passport_series = series;
  const number = val('document_number').replace(/\D/g, '');
  if (number.length === 6) secure.passport_number = number;
  if (iso('issue_date')) secure.issue_date = iso('issue_date');
  if (val('authority_nat')) secure.issued_by = val('authority_nat');
  const code = val('authority_code').replace(/\D/g, '');
  if (code.length === 6) secure.authority_code = `${code.slice(0, 3)}-${code.slice(3)}`;
  if (val('birth_place_nat')) secure.birth_place = val('birth_place_nat');
  const a = f.address && typeof f.address === 'object' ? f.address : null;
  if (a) {
    const parts = [a.area, a.region, a.locality, a.street, a.house && `д. ${a.house}`, a.housing && `корп. ${a.housing}`,
      a.building && `стр. ${a.building}`, a.apartment && `кв. ${a.apartment}`].filter((x) => x && String(x).trim());
    if (parts.length) secure.address = clean(parts.join(', '), 500);
  }
  return {
    plain, secure,
    confidence: !!(r && r.confidence),
    spoofing: ((r && r.spoofing_reasons) || []).map((x) => x && x.kind).filter(Boolean),
  };
}

module.exports = { PLAIN_KEYS, SECURE_KEYS, validateIdentity, encodeSecure, decodeRow, maskPassport, prefillFrom, fromRecognized };
