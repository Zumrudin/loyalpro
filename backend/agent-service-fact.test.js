'use strict';

const { wantsServiceFact, kbQuery, pickServiceFact, MAX_FACT_CHARS } = require('./services/agent/service-fact');

const CTX = [
  'Пилинги, чистки и карбокситерапия',
  'Комбинированная чистка лица: ультразвук + механическая чистка, 60 минут.',
  'В стоимость входит уход после чистки. Работаем с 10:00 до 21:00.',
  'Лазерная эпиляция — Pacer One Pro',
  'Диодный лазер, подходит для загорелой кожи.',
].join('\n');

describe('wantsServiceFact', () => {
  test('вопрос о цене и нерешительность — да', () => {
    expect(wantsServiceFact('Сколько стоит чистка лица?')).toBe(true);
    expect(wantsServiceFact('Не знаю, что выбрать для лица')).toBe(true);
  });
  test('запись, перенос, приветствие — нет', () => {
    expect(wantsServiceFact('Запишите на пятницу к Татьяне')).toBe(false);
    expect(wantsServiceFact('Перенесите запись')).toBe(false);
    expect(wantsServiceFact('Здравствуйте')).toBe(false);
    expect(wantsServiceFact(null)).toBe(false);
  });
});

describe('kbQuery', () => {
  test('срезает метку времени и кап 200 символов', () => {
    expect(kbQuery('[10.08 09:09] Сколько стоит чистка?')).toBe('Сколько стоит чистка?');
    expect(kbQuery('а'.repeat(500)).length).toBe(200);
  });
});

describe('pickServiceFact', () => {
  test('берёт ТОП-чанк, если его заголовок связан со словом пациента', () => {
    const f = pickServiceFact(CTX, 'Сколько стоит чистка лица?');
    expect(f.title).toBe('Пилинги, чистки и карбокситерапия');
    expect(f.text).toContain('Комбинированная чистка лица');
  });

  test('строки с временем ЧЧ:ММ выбрасываются (allowedTimes)', () => {
    const f = pickServiceFact(CTX, 'чистка');
    expect(f.text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(f.text).toContain('В стоимость входит уход после чистки.');
  });

  test('точечная форма времени «10.00» тоже выбрасывается, дата «11.08» — нет', () => {
    const ctx = 'Чистка лица\nУльтразвук. Приём с 10.00 до 21.00. Акция до 11.08 включительно.';
    const f = pickServiceFact(ctx, 'чистка');
    expect(f.text).toContain('Ультразвук.');
    expect(f.text).not.toMatch(/10\.00|21\.00/);
    expect(f.text).toContain('11.08');
  });

  test('заголовок с временем → null', () => {
    expect(pickServiceFact('Чистка с 10.00\nУльтразвук.', 'чистка')).toBeNull();
  });

  test('короткий топ-чанк: текст второй статьи (после пустой строки) не протекает', () => {
    const ctx = 'Чистка лица\nУльтразвуковая чистка.\n\nЛазерная эпиляция\nДиодный лазер, подходит для загорелой кожи.';
    const f = pickServiceFact(ctx, 'чистка');
    expect(f.text).toBe('Ультразвуковая чистка.');
    expect(f.text).not.toContain('Диодный');
  });

  test('заголовок топ-чанка не про запрос → null (fail-closed)', () => {
    expect(pickServiceFact(CTX, 'Сколько стоит ботокс?')).toBeNull();
  });

  test('слова вопроса о цене сами по себе заголовок не легализуют', () => {
    const ctx = 'Стоимость консультации\nКонсультация врача бесплатна при записи.';
    expect(pickServiceFact(ctx, 'Сколько стоит ботокс?')).toBeNull();
  });

  test('блок «АКТУАЛЬНЫЕ УСЛУГИ И ЦЕНЫ» в справку не попадает', () => {
    const ctx = 'Чистка лица\nУльтразвуковая чистка.\n\nАКТУАЛЬНЫЕ УСЛУГИ И ЦЕНЫ:\nЧистка — 5000 ₽';
    const f = pickServiceFact(ctx, 'чистка');
    expect(f.text).toBe('Ультразвуковая чистка.');
  });

  test('алиасы: «лазерку», «гиалуронка», «ботокс»', () => {
    const ctx = 'Ботулинотерапия\nПроводится по зонам.\n';
    expect(pickServiceFact(ctx, 'сколько стоит ботокс').title).toBe('Ботулинотерапия');
    const lz = 'Лазерная эпиляция — Pacer One Pro\nДиодный лазер.';
    expect(pickServiceFact(lz, 'прайс на лазерку').title).toMatch(/Лазерная/);
    const ct = 'Контурная пластика\nФиллеры на основе гиалуроновой кислоты.';
    expect(pickServiceFact(ct, 'почём гиалуронка?').title).toBe('Контурная пластика');
  });

  test('кап длины и мусор на входе', () => {
    const long = `Чистка\n${'слово '.repeat(400)}`;
    expect(pickServiceFact(long, 'чистка').text.length).toBeLessThanOrEqual(MAX_FACT_CHARS);
    expect(pickServiceFact('', 'чистка')).toBeNull();
    expect(pickServiceFact(null, 'чистка')).toBeNull();
    expect(pickServiceFact(CTX, '')).toBeNull();
  });
});
