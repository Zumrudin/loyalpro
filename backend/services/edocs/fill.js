'use strict';
// Данные для рендера DOCX: данные пациента, реквизиты клиники, дата документа, акт.
// Пустое значение — видимый пропуск «________» (кроме отчества: его законно нет).
// Каждый тег словаря placeholders.FIELDS обязан получить здесь значение — на это тест.
const { EMPTY, fmtDate, fmtMoney, fmtQty, fmtPhone } = require('./format');
const { rublesInWords } = require('../../utils/money-words');
const { actTotals } = require('./act-lines');

const v = (x) => (x === null || x === undefined || String(x).trim() === '' ? EMPTY : String(x));
const has = (x) => x !== null && x !== undefined && String(x).trim() !== '';

/**
 * identity — { plain, secure } (identity.decodeRow), requisites — edoc_settings.requisites,
 * docDate — 'YYYY-MM-DD', act — { act_no, visit_date, doctor_name, doctor_position, lines } или null.
 */
function buildRenderData({ identity, requisites, docDate, act = null }) {
  const p = (identity && identity.plain) || {};
  const s = (identity && identity.secure) || {};
  const r = requisites || {};
  const fio = [p.last_name, p.first_name, p.middle_name].filter(has).map((x) => String(x).trim()).join(' ');
  const initials = [p.first_name, p.middle_name].filter(has).map((w) => `${String(w).trim()[0].toUpperCase()}.`).join(' ');
  const data = {
    fio: v(fio),
    fio_short: v(has(p.last_name) ? `${String(p.last_name).trim()} ${initials}`.trim() : ''),
    last_name: v(p.last_name),
    first_name: v(p.first_name),
    middle_name: has(p.middle_name) ? String(p.middle_name).trim() : '',
    birth_date: v(fmtDate(p.birth_date)),
    gender: v(p.gender === 'F' ? 'женский' : p.gender === 'M' ? 'мужской' : ''),
    phone: v(fmtPhone(p.phone)),
    email: v(p.email),
    passport: v(has(s.passport_series) && has(s.passport_number) ? `${s.passport_series} ${s.passport_number}` : ''),
    passport_series: v(s.passport_series),
    passport_number: v(s.passport_number),
    passport_issued_by: v(s.issued_by),
    passport_issue_date: v(fmtDate(s.issue_date)),
    passport_authority_code: v(s.authority_code),
    birth_place: v(s.birth_place),
    address: v(s.address),
    contract_no: v(p.contract_no),
    contract_date: v(fmtDate(p.contract_date || docDate)),
    doc_date: v(fmtDate(docDate)),
    doc_city: v(r.city),
    org_name: v(r.name),
    org_inn: v(r.inn),
    org_kpp: v(r.kpp),
    org_ogrn: v(r.ogrn),
    org_address: v(r.address),
    org_license: v(r.license),
    org_phone: v(r.phone),
    org_bank: v(r.bank),
    org_signer_position: v(r.signer_position),
    org_signer_name: v(r.signer_name),
  };
  if (act) {
    const t = actTotals(act.lines || []);
    Object.assign(data, {
      act_no: v(act.act_no),
      visit_date: v(fmtDate(act.visit_date)),
      doctor_name: v(act.doctor_name),
      doctor_position: v(act.doctor_position),
      total_sum: fmtMoney(t.total_sum),
      total_sum_words: rublesInWords(t.total_sum),
      services: t.lines.map((l) => ({
        n: String(l.n), title: l.title, qty: fmtQty(l.qty), price: fmtMoney(l.price), discount: fmtMoney(l.discount), sum: fmtMoney(l.sum),
      })),
    });
  }
  return data;
}

module.exports = { buildRenderData };
