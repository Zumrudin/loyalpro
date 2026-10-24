'use strict';
// Образцы DOCX-шаблонов «Документов» со ВСЕМИ тегами словаря — для демо-стенда F.Doc и
// как отправная точка для клиники (откройте в Word и замените текст своим).
// node scripts/edocs-sample-templates.js [папка]   (по умолчанию /tmp/edocs-samples)
const fs = require('fs');
const path = require('path');
const { makeDocx, p, table } = require('../services/edocs/__fixtures__/docx');
const { inspect } = require('../services/edocs/docx');
const { validateTags } = require('../services/edocs/placeholders');

const dir = process.argv[2] || '/tmp/edocs-samples';
fs.mkdirSync(dir, { recursive: true });

const samples = {
  'Договор на оказание медицинских услуг.docx': ['contract', makeDocx({
    header: p('{org_name} · Договор № {contract_no} от {contract_date}'),
    body: p('ДОГОВОР № {contract_no} на оказание платных медицинских услуг')
      + p('г. {doc_city}, {doc_date}')
      + p('{org_name} (ИНН {org_inn}, КПП {org_kpp}, ОГРН {org_ogrn}, лицензия {org_license}, адрес: {org_address}, тел. {org_phone}), '
        + 'в лице {org_signer_position} {org_signer_name}, и {fio}, {birth_date} г. р., пол {gender}, паспорт {passport_series} {passport_number}, '
        + 'выдан {passport_issued_by} {passport_issue_date}, код подразделения {passport_authority_code}, место рождения {birth_place}, '
        + 'адрес регистрации: {address}, телефон {phone}, e-mail {email}, заключили настоящий договор.')
      + p('Реквизиты исполнителя: {org_bank}')
      + p('Пациент: {last_name} {first_name} {middle_name} / {fio_short}'),
  })],
  'Согласие на обработку персональных данных.docx': ['consent_pd', makeDocx({
    body: p('СОГЛАСИЕ на обработку персональных данных')
      + p('Я, {fio}, паспорт {passport}, выдан {passport_issued_by} {passport_issue_date}, даю согласие {org_name} (ИНН {org_inn}) на обработку моих персональных данных.')
      + p('Дата: {doc_date}'),
  })],
  'Акт оказанных услуг.docx': ['act', makeDocx({
    body: p('АКТ № {act_no} от {doc_date} об оказании медицинских услуг')
      + p('Исполнитель: {org_name}. Пациент: {fio}. Визит: {visit_date}. Врач: {doctor_name}, {doctor_position}.')
      + table([['№', 'Услуга', 'Кол-во', 'Цена', 'Скидка', 'Сумма'], ['{#services}{n}', '{title}', '{qty}', '{price}', '{discount}', '{sum}{/services}']])
      + p('Итого: {total_sum} руб. ({total_sum_words}). Услуги оказаны полностью, претензий нет.'),
  })],
};

for (const [name, [kind, buf]] of Object.entries(samples)) {
  const v = validateTags(inspect(buf), kind);
  if (!v.ok) throw new Error(`${name}: ${v.errors.join('; ')}`);
  fs.writeFileSync(path.join(dir, name), buf);
  console.log(`${path.join(dir, name)} — вид ${kind}, тегов ${v.placeholders.length}`);
}
