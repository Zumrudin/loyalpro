'use strict';
const lp = require('./services/broadcast-messengers/list-parse');

describe('parseText', () => {
  test('разные формы номера и порядок имя/номер', () => {
    const r = lp.parseText('Анна 89161234567\n+7 (916) 765-43-21;Ольга Петрова\n9031112233, Ирина');
    expect(r.rows).toEqual([
      { name: 'Анна', phone: '79161234567', line: 1 },
      { name: 'Ольга Петрова', phone: '79167654321', line: 2 },
      { name: 'Ирина', phone: '79031112233', line: 3 },
    ]);
    expect(r.invalid).toEqual([]);
  });
  test('табы из Excel и пустые строки', () => {
    const r = lp.parseText('Имя\tТелефон\nАнна\t8 916 123 45 67\n\n');
    expect(r.rows).toEqual([{ name: 'Анна', phone: '79161234567', line: 2 }]);
  });
  test('битый номер и номер без имени', () => {
    const r = lp.parseText('Анна 12345\n89161234567');
    expect(r.invalid).toEqual([{ line: 1, raw: 'Анна 12345' }]);
    expect(r.rows).toEqual([{ name: '', phone: '79161234567', line: 2 }]);
  });
  test('дубли по номеру: остаётся первый, считаются', () => {
    const r = lp.parseText('Анна 89161234567\nАня +79161234567');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name).toBe('Анна');
    expect(r.duplicates).toBe(1);
  });
});

describe('parseRows / parseCsv', () => {
  test('заголовок определяет колонки', () => {
    const r = lp.parseRows([['Телефон', 'ФИО'], ['89161234567', 'Анна Иванова']]);
    expect(r.rows).toEqual([{ name: 'Анна Иванова', phone: '79161234567', line: 2 }]);
  });
  test('без заголовка — колонка с телефоном находится сама', () => {
    const r = lp.parseRows([['Анна', '89161234567', 'VIP']]);
    expect(r.rows).toEqual([{ name: 'Анна', phone: '79161234567', line: 1 }]);
  });
  test('CSV с кавычками и ; ', () => {
    expect(lp.parseCsv('"Петрова; Анна";89161234567\nОля;89167654321'))
      .toEqual([['Петрова; Анна', '89161234567'], ['Оля', '89167654321']]);
  });
  test('числа из XLSX', () => {
    const r = lp.parseRows([['Анна', 79161234567]]);
    expect(r.rows[0].phone).toBe('79161234567');
  });
  test('кап строк', () => {
    const rows = Array.from({ length: 5002 }, (_, i) => ['x', String(79000000000 + i)]);
    const r = lp.parseRows(rows);
    expect(r.rows).toHaveLength(5000);
    expect(r.invalid.some(x => /лимит/.test(x.raw))).toBe(true);
  });
});
