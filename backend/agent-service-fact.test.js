'use strict';

const { wantsServiceFact, kbQuery, pickServiceFact, MAX_FACT_CHARS } = require('./services/agent/service-fact');

const CTX = [
  'Комбинированная чистка лица',
  'Комбинированная чистка лица: ультразвук + механическая чистка, 60 минут.',
  'После чистки наносится успокаивающая маска по типу кожи. Работаем с 10:00 до 21:00.',
  '',
  'Лазерная эпиляция — Pacer One Pro',
  'Диодный лазер, подходит для загорелой кожи и любых волос.',
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
    expect(f.title).toBe('Комбинированная чистка лица');
    expect(f.text).toContain('Комбинированная чистка лица');
  });

  test('строки с временем ЧЧ:ММ выбрасываются (allowedTimes)', () => {
    const f = pickServiceFact(CTX, 'чистка');
    expect(f.text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(f.text).toContain('После чистки наносится успокаивающая маска по типу кожи.');
  });

  test('точечная форма времени «10.00» тоже выбрасывается, дата «11.08» — нет', () => {
    const ctx = 'Чистка лица\nУльтразвуковая чистка лица с маской. Приём с 10.00 до 21.00. Маска подбирается по типу кожи до 11.08 включительно.';
    const f = pickServiceFact(ctx, 'чистка');
    expect(f.text).toContain('Ультразвуковая чистка лица с маской.');
    expect(f.text).not.toMatch(/10\.00|21\.00/);
    expect(f.text).toContain('11.08');
  });

  test('заголовок с временем → null', () => {
    expect(pickServiceFact('Чистка с 10.00\nУльтразвук.', 'чистка')).toBeNull();
  });

  test('короткий топ-чанк: текст второй статьи (после пустой строки) не протекает', () => {
    const ctx = 'Чистка лица\nУльтразвуковая чистка с маской по типу кожи.\n\nЛазерная эпиляция\nДиодный лазер, подходит для загорелой кожи и любых волос.';
    const f = pickServiceFact(ctx, 'чистка');
    expect(f.text).toBe('Ультразвуковая чистка с маской по типу кожи.');
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
    const ctx = 'Чистка лица\nУльтразвуковая чистка с маской по типу кожи.\n\nАКТУАЛЬНЫЕ УСЛУГИ И ЦЕНЫ:\nЧистка — 5000 ₽';
    const f = pickServiceFact(ctx, 'чистка');
    expect(f.text).toBe('Ультразвуковая чистка с маской по типу кожи.');
  });

  test('алиасы: «лазерку», «гиалуронка», «ботокс»', () => {
    const ctx = 'Ботулинотерапия\nПроводится по зонам, препарат вводится тончайшими иглами.\n';
    expect(pickServiceFact(ctx, 'сколько стоит ботокс').title).toBe('Ботулинотерапия');
    const lz = 'Лазерная эпиляция — Pacer One Pro\nДиодный лазер, подходит для любых типов волос.';
    expect(pickServiceFact(lz, 'прайс на лазерку').title).toMatch(/Лазерная/);
    const ct = 'Контурная пластика\nФиллеры на основе гиалуроновой кислоты восполняют объём.';
    expect(pickServiceFact(ct, 'почём гиалуронка?').title).toBe('Контурная пластика');
  });

  test('кап длины и мусор на входе', () => {
    const long = `Чистка\n${'слово '.repeat(400)}конец.`;
    expect(pickServiceFact(long, 'чистка').text.length).toBeLessThanOrEqual(MAX_FACT_CHARS);
    expect(pickServiceFact('', 'чистка')).toBeNull();
    expect(pickServiceFact(null, 'чистка')).toBeNull();
    expect(pickServiceFact(CTX, '')).toBeNull();
  });
});

// ── Реальные чанки дев-КБ (см. __fixtures__/kb-real-chunks.js) ─────────────
const { REAL } = require('./services/agent/__fixtures__/kb-real-chunks');
const JUNK_RE = /стать[еяи]|прайс|обновлены|₽|\*\*|^[*\-•#]|Гаджиева|Гатауллина/u;

describe('pickServiceFact на реальных чанках КБ', () => {
  test.each([
    ['lumecca', 'Сколько стоит фотоомоложение Lumecca?', /^Инновационная IPL-технология израильско-американской компании InMode\.$/],
    ['volnewmer', 'Сколько стоит Volnewmer?', /^Инновационный монополярный радиочастотный аппарат нового поколения/],
    ['cleaning', 'Сколько стоит чистка лица?', /^Профессиональное очищение кожи с индивидуальным сочетанием/],
    ['laser', 'Сколько стоит лазерная эпиляция?', /^Гибридный лазер Pacer One Pro, генерирующий три длины волны — 755, 808 и 1064 нм/],
    ['botox', 'Сколько стоит ботокс?', /^Введение препаратов ботулотоксина типа А/],
  ])('%s → описательный абзац, не пометка и не прайс', (key, ask, re) => {
    const f = pickServiceFact(REAL[key], ask);
    expect(f).not.toBeNull();
    expect(f.text).toMatch(re);
    expect(f.text).not.toMatch(JUNK_RE);
  });

  test.each([
    ['lumeccaPrices', 'Сколько стоит Lumecca?'],
    ['laserPrices', 'Сколько стоит лазерная эпиляция?'],
    ['botoxPrices', 'Сколько стоит ботокс?'],
  ])('%s: в топ-чанке только списки/цены/противопоказания → null', (key, ask) => {
    expect(pickServiceFact(REAL[key], ask)).toBeNull();
  });

  test('только редакторская пометка → null', () => {
    const ctx = 'VOLNEWMER — монополярный RF-лифтинг\nЦены в статье обновлены в строгом соответствии с представленным прайс-листом.';
    expect(pickServiceFact(ctx, 'Volnewmer')).toBeNull();
  });

  test('описание чужой статьи после топ-чанка не берётся', () => {
    const ctx = `${REAL.botoxPrices}\n\n${REAL.bio}`;
    expect(pickServiceFact(ctx, 'Сколько стоит ботокс?')).toBeNull();
  });
});


describe('справка относится к одной процедуре', () => {
  test.each([
    ['peels', 'Сколько стоит чистка лица?'],
    ['bio', 'Сколько стоит биоревитализация?'],
  ])('%s: обзор нескольких процедур не становится фактом об одной', (key, ask) => {
    expect(pickServiceFact(REAL[key], ask)).toBeNull();
  });

  test('совпадение только зоны лица не связывает разные процедуры', () => {
    expect(pickServiceFact(REAL.cleaning, 'Сколько стоит массаж лица?')).toBeNull();
  });

  test('конкретный вид чистки не подменяется другим', () => {
    expect(pickServiceFact(REAL.cleaning, 'Сколько стоит ультразвуковая чистка?')).toBeNull();
  });

  test('название одной процедуры с двумя зонами сохраняет полезное описание', () => {
    expect(pickServiceFact(REAL.cleaning, 'Сколько стоит чистка лица?').text)
      .toContain('Профессиональное очищение кожи');
  });
});

describe('все найденные фрагменты с явными границами', () => {
  function result(contents) {
    let context = '';
    const fragments = contents.map((content, i) => {
      const start = context.length;
      context += `${content}\n\n`;
      return { article_id: i + 1, start, end: start + content.length };
    });
    return { context: context.trimEnd(), fragments };
  }
  const priceOnly = 'Комбинированная чистка лица и спины\n## Стоимость\nЧистка — 6500 ₽.';
  test('обзор первым, прайс вторым, полезное описание третьим → факт о чистке', () => {
    const { context, fragments } = result([REAL.peels, priceOnly, REAL.cleaning, REAL.laser]);
    expect(pickServiceFact(context, 'Сколько стоит чистка лица?', fragments))
      .toEqual(pickServiceFact(REAL.cleaning, 'Сколько стоит чистка лица?'));
  });
  test('после неполного фрагмента нельзя взять описание чужой процедуры', () => {
    const { context, fragments } = result([priceOnly, REAL.laser, REAL.peels]);
    expect(pickServiceFact(context, 'Сколько стоит чистка лица?', fragments)).toBeNull();
  });
  test('первый подходящий фрагмент сохраняет приоритет поиска', () => {
    const { context, fragments } = result([REAL.cleaning, 'Чистка лица\nДругой достаточно длинный описательный абзац о чистке лица.']);
    expect(pickServiceFact(context, 'Сколько стоит чистка лица?', fragments)?.text)
      .toContain('Профессиональное очищение кожи');
  });
  test('повтор заголовка и заголовок со скобками не склеивают чужие статьи', () => {
    const { context, fragments } = result([priceOnly, 'Другая процедура (аппарат)\nОписание другой процедуры не относится к чистке лица.', REAL.cleaning]);
    expect(pickServiceFact(context, 'Сколько стоит чистка лица?', fragments)?.title)
      .toBe('Комбинированная чистка лица и спины');
  });
  test('пустые и повреждённые границы не приводят к выбору текста всего контекста', () => {
    for (const fragments of [[], [null], [{ start: -1, end: 99999 }], [{ start: 0, end: 99999 }]]) {
      expect(pickServiceFact(REAL.cleaning, 'Сколько стоит чистка лица?', fragments)).toBeNull();
    }
  });
});
