'use strict';
const { makeDocx, docText, p, table } = require('./services/edocs/__fixtures__/docx');
const { inspect, render, TemplateError } = require('./services/edocs/docx');
const { validateTags, missingFor, dictionary } = require('./services/edocs/placeholders');

const actTemplate = () => makeDocx({
  body: p('Акт № {act_no} от {doc_date}. Пациент: {fio}')
    + table([['№', 'Услуга', 'Сумма'], ['{#services}{n}', '{title}', '{sum}{/services}']])
    + p('Итого: {total_sum} ({total_sum_words})'),
  header: p('Договор № {contract_no}'),
});

describe('docx.inspect', () => {
  test('теги документа, цикла и колонтитула', () => {
    expect(inspect(actTemplate())).toEqual({
      act_no: {}, doc_date: {}, fio: {}, services: { n: {}, title: {}, sum: {} }, total_sum: {}, total_sum_words: {}, contract_no: {},
    });
  });
  test('тег, разбитый Word на несколько фрагментов текста, собирается целиком', () => {
    const buf = makeDocx({ body: '<w:p><w:r><w:t>Пациент: {fi</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>o}</w:t></w:r></w:p>' });
    expect(inspect(buf)).toEqual({ fio: {} });
  });
  test('незакрытый тег — TemplateError с пояснением', () => {
    expect(() => inspect(makeDocx({ body: p('Пациент: {fio') }))).toThrow(/unclosed/i);
    try { inspect(makeDocx({ body: p('{fio') })); } catch (e) { expect(e).toBeInstanceOf(TemplateError); expect(e.details.length).toBe(1); }
  });
  test('не DOCX, битый ZIP, ZIP без документа', () => {
    expect(() => inspect(Buffer.from('просто текст'))).toThrow(/не DOCX/);
    expect(() => inspect(Buffer.from([0x50, 0x4B, 0x03, 0x04, 1, 2, 3]))).toThrow(/повреждён/);
    const PizZip = require('pizzip'); const z = new PizZip(); z.file('a.txt', 'x');
    expect(() => inspect(z.generate({ type: 'nodebuffer' }))).toThrow(/word\/document.xml/);
    expect(() => inspect(null)).toThrow(/пустой/);
  });
});

describe('docx.render', () => {
  test('подставляет значения, размножает строки таблицы, экранирует XML', () => {
    const out = render(actTemplate(), {
      act_no: '2056697734', doc_date: '24.10.2026', fio: 'Иванова Анна Сергеевна', contract_no: 'Д-17 «А&Б»',
      services: [{ n: 1, title: 'Чистка <лица>', sum: '1 000,00' }, { n: 2, title: 'Пилинг', sum: '2 500,00' }],
      total_sum: '3 500,00', total_sum_words: 'Три тысячи пятьсот рублей 00 копеек',
    });
    const text = docText(out);
    expect(text).toContain('Акт № 2056697734 от 24.10.2026. Пациент: Иванова Анна Сергеевна');
    expect(text).toContain('1Чистка <лица>1 000,00');
    expect(text).toContain('2Пилинг2 500,00');
    expect(docText(out, 'word/header1.xml')).toBe('Договор № Д-17 «А&Б»');
  });
  test('нет значения у простого тега — видимый пропуск; нет строк цикла — пусто', () => {
    const out = render(makeDocx({ body: p('Паспорт: {passport}') + table([['{#services}{title}{/services}']]) }), {});
    expect(docText(out)).toBe('Паспорт: ________');
  });
  test('перенос строки в значении становится переносом в Word', () => {
    const out = render(makeDocx({ body: p('{address}') }), { address: 'г. Москва\nул. Ленина, 1' });
    expect(docText(out)).toBe('г. Москва\nул. Ленина, 1');
  });
});

describe('placeholders.validateTags', () => {
  test('акт с циклом — ок; список тегов отсортирован', () => {
    const r = validateTags(inspect(actTemplate()), 'act');
    expect(r.ok).toBe(true);
    expect(r.placeholders).toEqual(['act_no', 'contract_no', 'doc_date', 'fio', 'services', 'total_sum', 'total_sum_words']);
  });
  test('теги акта в договоре, неизвестный тег, чужой тег в цикле, вложенность не в цикле', () => {
    const r = validateTags({ fio: {}, total_sum: {}, passprt: {}, services: { cost: {} }, phone: { x: {} } }, 'contract');
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      'Неизвестный тег {passprt}',
      'Тег {total_sum} разрешён только в шаблоне акта',
      'Тег {services} разрешён только в шаблоне акта',
      'Неизвестный тег {cost} внутри цикла {#services}',
      'Тег {phone} — не цикл: внутри {#phone}…{/phone} тегов быть не может',
    ]));
  });
  test('шаблон без тегов законен (документ «на подпись», без подстановок)', () => {
    expect(validateTags({}, 'other')).toEqual({ ok: true, errors: [], placeholders: [] });
  });
  test('неизвестный вид документа', () => {
    expect(validateTags({}, 'ids').errors).toEqual(['Неизвестный вид документа: ids']);
  });
});

describe('placeholders.missingFor', () => {
  const contract = { placeholders: ['fio', 'passport', 'passport_issued_by', 'org_inn', 'doc_city'] };
  test('ФИО и телефон нужны всегда, паспорт — по тегам, проверка без расшифровки', () => {
    const identity = { last_name: 'Иванова', first_name: '', phone: '79001234567', secure_fields: ['passport_series'] };
    expect(missingFor(identity, [contract], { inn: '9724060392' })).toEqual({
      identity: [{ key: 'first_name', label: 'Имя' }, { key: 'issued_by', label: 'Кем выдан паспорт' }, { key: 'passport_number', label: 'Номер паспорта' }],
      org: [{ key: 'city', label: 'Город' }],
    });
  });
  test('нет данных пациента вовсе', () => {
    expect(missingFor(null, [], {}).identity.map((x) => x.key)).toEqual(['first_name', 'last_name', 'phone']);
  });
  test('словарь для подсказки содержит все теги и поля строки акта', () => {
    const d = dictionary();
    expect(d.fields.find((f) => f.tag === 'services')).toEqual({ tag: 'services', label: expect.any(String), actOnly: true, loop: true });
    expect(d.serviceFields.map((f) => f.tag)).toEqual(['n', 'title', 'qty', 'price', 'discount', 'sum']);
    expect(d.kinds.map((k) => k.kind)).toEqual(['contract', 'consent_pd', 'act', 'other']);
  });
});
