'use strict';
const PizZip = require('pizzip');
const { makeDocx, docText, p, table } = require('./services/edocs/__fixtures__/docx');
const { inspect, render, TemplateError, MAX_UNPACKED_BYTES } = require('./services/edocs/docx');
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

describe('лимит распаковки (zip-бомба)', () => {
  const MB = 1024 * 1024;
  const HEAVY = 30000;   // сборка архивов на десятки МБ в pizzip занимает секунды
  /** Сумма заявленных в оглавлении несжатых размеров — то, что видит проверка. */
  const unpacked = (buf) => Object.values(new PizZip(buf).files).reduce((n, f) => n + f._data.uncompressedSize, 0);
  const small = (opts = {}) => makeDocx({ body: p('Договор с {fio}'), ...opts });
  /** Подменяет в оглавлении ZIP заявленный несжатый размер записи — как делает автор «бомбы». */
  function forgeSize(buf, name, size) {
    const out = Buffer.from(buf);
    for (let off = out.indexOf('PK\x01\x02', 0, 'latin1'); off !== -1; off = out.indexOf('PK\x01\x02', off + 4, 'latin1')) {
      const len = out.readUInt16LE(off + 28);
      if (out.toString('utf8', off + 46, off + 46 + len) === name) { out.writeUInt32LE(size, off + 24); return out; }
    }
    throw new Error(`в оглавлении нет записи ${name}`);
  }
  // ~30 МБ пробелов в одном абзаце: валидный XML, а в архиве с DEFLATE — несколько десятков КБ.
  let bomb;
  beforeAll(() => { bomb = makeDocx({ body: p(' '.repeat(30 * MB)), compress: true }); }, HEAVY);

  test('несколько десятков КБ в файле, 30 МБ после распаковки: inspect и render отклоняют той же TemplateError, что и битый DOCX', () => {
    expect(bomb.length).toBeLessThan(200 * 1024);   // это именно «бомба»: лимит загрузки по сжатому размеру её пропускает
    expect(unpacked(bomb)).toBeGreaterThan(30 * MB);
    for (const fn of [() => inspect(bomb), () => render(bomb, {})]) {
      expect(fn).toThrow(TemplateError);
      expect(fn).toThrow(/слишком велик после распаковки \(больше 25 МБ\)/);
    }
  });
  test('считается сумма по всем записям архива, а не размер одной', () => {
    // каждая запись по 9 МБ (меньше лимита), вместе 27 МБ
    const buf = small({ compress: true, extra: { 'word/media/a.bin': Buffer.alloc(9 * MB), 'word/media/b.bin': Buffer.alloc(9 * MB), 'word/media/c.bin': Buffer.alloc(9 * MB) } });
    expect(unpacked(buf)).toBeGreaterThan(MAX_UNPACKED_BYTES);
    expect(() => inspect(buf)).toThrow(/слишком велик/);
  }, HEAVY);
  test('граница: ровно MAX_UNPACKED_BYTES проходит, на байт больше — нет', () => {
    const base = unpacked(small({ extra: { 'word/media/pad.bin': Buffer.alloc(0) } }));   // размер без добавки (сжатие на сумму не влияет)
    const exact = small({ compress: true, extra: { 'word/media/pad.bin': Buffer.alloc(MAX_UNPACKED_BYTES - base) } });
    const over = small({ compress: true, extra: { 'word/media/pad.bin': Buffer.alloc(MAX_UNPACKED_BYTES - base + 1) } });
    expect(unpacked(exact)).toBe(MAX_UNPACKED_BYTES);
    expect(inspect(exact)).toEqual({ fio: {} });
    expect(() => inspect(over)).toThrow(/слишком велик/);
  }, HEAVY);
  test('обычный DOCX проходит и без сжатия, и с DEFLATE; увесистый, но в пределах лимита — тоже', () => {
    expect(inspect(small())).toEqual({ fio: {} });
    expect(inspect(small({ compress: true }))).toEqual({ fio: {} });
    expect(docText(render(small({ compress: true }), { fio: 'Иванова Анна' }))).toBe('Договор с Иванова Анна');
    const heavy = makeDocx({ body: p('Акт {fio}') + p('x'.repeat(10 * MB)), compress: true });
    expect(unpacked(heavy)).toBeGreaterThan(10 * MB);
    expect(inspect(heavy)).toEqual({ fio: {} });
  }, HEAVY);
  test('оглавление архива занижает размер — отклоняется до полной распаковки, а не на «size mismatch» после неё', () => {
    const forged = forgeSize(bomb, 'word/document.xml', 1000);
    expect(unpacked(forged)).toBeLessThan(MB);   // заявленная сумма проверку проходит
    for (const fn of [() => inspect(forged), () => render(forged, {})]) {
      expect(fn).toThrow(TemplateError);
      expect(fn).toThrow(/слишком велик после распаковки/);
    }
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
