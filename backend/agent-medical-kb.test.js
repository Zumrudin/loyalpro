'use strict';
const mk = require('./services/agent/medical-kb');
const { HANDOVER_ANNOUNCED_RE } = require('./services/agent/admin-hours');

describe('detectRedFlag — всегда', () => {
  test.each([
    ['После филлера побелела кожа на губе', 'skin_blanching'],
    ['кожа посинела вокруг укола', 'skin_blanching'],
    ['Кожа какая-то мраморная стала', 'skin_blanching'],
    ['Мне трудно дышать', 'breathing'],
    ['задыхаюсь', 'breathing'],
    ['отекает горло', 'breathing'],
    ['язык опух', 'breathing'],
    ['ухудшилось зрение', 'vision'],
    ['двоится в глазах', 'vision'],
    ['пелена перед глазами', 'vision'],
  ])('«%s» → %s', (text, kind) => {
    expect(mk.detectRedFlag(text)).toEqual({ kind });
  });

  test.each([
    'После Lumecca потемнели пятна',
    'синяк побледнел',
    'После губ синяк',
    'хочу больше объёма губ',
    'Добрый вечер',
  ])('«%s» → нет', (text) => {
    expect(mk.detectRedFlag(text)).toBeNull();
  });

  test('метка времени и не-строка не ломают детектор', () => {
    expect(mk.detectRedFlag('[13.10 22:01] задыхаюсь')).toEqual({ kind: 'breathing' });
    expect(mk.detectRedFlag(null)).toBeNull();
    expect(mk.detectRedFlag(['задыхаюсь'])).toBeNull();
  });
});

describe('detectRedFlag — только при контексте процедуры', () => {
  test.each([
    ['После губ поднялась температура', 'fever'],
    ['сделала ботокс, температура 38,5', 'fever'],
    ['вчера делали биоревитализацию, озноб', 'fever'],
    ['После чистки гноится', 'pus'],
    ['после укола нагноение', 'pus'],
    ['после процедуры резкая боль', 'severe_pain'],
    ['После филлера боль нарастает', 'severe_pain'],
  ])('«%s» → %s', (text, kind) => {
    expect(mk.detectRedFlag(text)).toEqual({ kind });
  });

  test.each([
    'температура 38, можно ли прийти на чистку?',
    'Можно ли после процедуры в баню, там высокие температуры?',
    'гной на подбородке, поможет ли чистка?',
  ])('«%s» → нет', (text) => {
    expect(mk.detectRedFlag(text)).toBeNull();
  });
});

describe('buildRedFlagReply', () => {
  test.each([false, true])('adminOff=%s: объявляет перевод (диспетчер не дошлёт вторую фразу)', (adminOff) => {
    expect(mk.buildRedFlagReply({ adminOff })).toMatch(HANDOVER_ANNOUNCED_RE);
  });
  test('нерабочее время — неотложная помощь 103/112', () => {
    expect(mk.buildRedFlagReply({ adminOff: true })).toMatch(/103 или 112/);
    expect(mk.buildRedFlagReply({ adminOff: false })).not.toMatch(/103/);
  });
});

describe('wantsMedicalKb', () => {
  test.each([
    'Есть ли вообще смысл делать био, если после второй процедуры прошло больше месяца?',
    'Кормлю грудью, можно мне био?',
    'У меня диабет, можно био?',
    'Как проходит лазерная эпиляция, больно?',
    'После Lumecca покраснение 2 дня, это нормально?',
    'После губ бугорок',
    'какие противопоказания у ботокса',
    'на ГВ можно?',
    'болит место укола',
    'боль после чистки',
    'Сколько стоит био при беременности?',   // сильный маркер — всегда
  ])('«%s» → да', (text) => {
    expect(mk.wantsMedicalKb(text)).toBe(true);
  });

  test.each([
    'хочу больше объёма губ',
    'Можно ли записаться на био в пятницу?',      // слабый маркер + запись
    'Можно ли перенести запись на субботу?',      // слабый маркер + перенос
    'Сколько стоит курс биоревитализации?',       // слабый маркер + цена
    'Здравствуйте!',
    '',
  ])('«%s» → нет', (text) => {
    expect(mk.wantsMedicalKb(text)).toBe(false);
  });

  test('не-строка → false', () => {
    expect(mk.wantsMedicalKb(null)).toBe(false);
    expect(mk.wantsMedicalKb(['болит'])).toBe(false);
  });
});

const { PROD_TITLES } = require('./services/agent/__fixtures__/kb-medical-chunks');

describe('matchTitles', () => {
  test.each([
    ['Есть ли вообще смысл делать био, если после второй процедуры прошло больше месяца?', ['Биоревитализация и Мезотерапия']],
    ['Кормлю грудью, можно мне био?', ['Биоревитализация и Мезотерапия']],
    ['После Lumecca покраснение 2 дня', ['LUMECCA — IPL фотоомоложение (InMode)']],
    ['после люмекки красное лицо', ['LUMECCA — IPL фотоомоложение (InMode)']],
    ['Как проходит лазерная эпиляция, больно?', ['Лазерная эпиляция — Pacer One Pro (755/808/1064 нм)']],
    ['После губ бугорок', ['Контурная пластика и увеличение губ', 'STYLAGE Special Lips Lidocaine — филлер для губ']],
  ])('«%s»', (text, expected) => {
    expect(mk.matchTitles(text, PROD_TITLES)).toEqual(expected);
  });

  test('медицинские стоп-слова не притягивают заголовки («терапия», «уход после», «консультация»)', () => {
    expect(mk.matchTitles('какая терапия после консультации и уход после', PROD_TITLES)).toEqual([]);
  });

  test('процедура не названа → []', () => {
    expect(mk.matchTitles('у меня бугорок', PROD_TITLES)).toEqual([]);
  });

  test('битые входы → []', () => {
    expect(mk.matchTitles('био', null)).toEqual([]);
    expect(mk.matchTitles(null, PROD_TITLES)).toEqual([]);
  });
});

describe('buildMedicalQuery', () => {
  const BIO = 'Биоревитализация и Мезотерапия';

  test('процедура в последнем сообщении → запрос = оно (тот же kbQuery, что у справки)', () => {
    const sf = require('./services/agent/service-fact');
    const last = '[13.10 22:01] Кормлю грудью, можно мне   био?';
    expect(mk.buildMedicalQuery([last], PROD_TITLES))
      .toEqual({ query: sf.kbQuery(last), titles: [BIO] });
  });

  test('процедура в предыдущем сообщении → «то + последнее»', () => {
    const r = mk.buildMedicalQuery(['А при диабете можно?', 'Хочу на биоревитализацию'], PROD_TITLES);
    expect(r).toEqual({ query: 'Хочу на биоревитализацию А при диабете можно?', titles: [BIO] });
  });

  test('берётся БЛИЖАЙШЕЕ предыдущее с процедурой, не дальше трёх блоков', () => {
    const r = mk.buildMedicalQuery(['А больно?', 'ок', 'Как проходит лазерная эпиляция?', 'хочу био'], PROD_TITLES);
    expect(r.titles).toEqual(['Лазерная эпиляция — Pacer One Pro (755/808/1064 нм)']);
    expect(mk.buildMedicalQuery(['А больно?', 'ок', 'да', 'хочу био'], PROD_TITLES)).toBeNull();
  });

  test('склейка не длиннее 300 символов, последнее сообщение целиком', () => {
    const last = 'А при диабете можно?';
    const r = mk.buildMedicalQuery([last, `биоревитализация ${'очень '.repeat(80)}`], PROD_TITLES);
    expect(r.query.length).toBeLessThanOrEqual(300);
    expect(r.query.endsWith(last)).toBe(true);
  });

  test('процедуры нигде нет / пусто → null', () => {
    expect(mk.buildMedicalQuery(['у меня бугорок'], PROD_TITLES)).toBeNull();
    expect(mk.buildMedicalQuery([], PROD_TITLES)).toBeNull();
    expect(mk.buildMedicalQuery(['био'], [])).toBeNull();
  });
});

const { medicalSearchResult } = require('./services/agent/__fixtures__/kb-medical-chunks');

describe('pickMedicalFragments', () => {
  const BIO = 'Биоревитализация и Мезотерапия';
  const LASER = 'Лазерная эпиляция — Pacer One Pro (755/808/1064 нм)';

  test('оставляет фрагменты нужной статьи, режет чужую, цены и хвост каталога', () => {
    const kb = medicalSearchResult(['bio0', 'laser', 'bio1'], { servicesTail: true });
    const r = mk.pickMedicalFragments(kb, [BIO]);
    expect(r.titles).toEqual([BIO]);
    expect(r.raw).toBe(kb.context);
    const text = r.lines.join('\n');
    expect(text).toContain('Рекомендуется курс из 3–5 процедур с интервалом в 2–4 недели');
    expect(text).toContain('* Беременность и лактация');
    expect(text).not.toContain('Pacer');           // чужая статья
    expect(text).not.toMatch(/₽|REVI/);           // цены — только из каталога
    expect(text).not.toContain('АКТУАЛЬНЫЕ УСЛУГИ');
    expect(text).not.toContain('**');             // разметка жирного снята
    expect(r.lines[0]).toBe(`«${BIO}»:`);         // заголовок фрагмента — строкой-меткой
    expect(r.lines.filter(l => l === `«${BIO}»:`)).toHaveLength(2);
    expect(r.lines).not.toContain(`# ${BIO}`);    // дубль заголовка markdown снят
  });

  test('строки со временем ЧЧ:ММ выбрасываются (засевали бы allowedTimes)', () => {
    const r = mk.pickMedicalFragments(medicalSearchResult(['laser']), [LASER]);
    expect(r.lines.join('\n')).not.toMatch(/10:00/);
    expect(r.lines.join('\n')).toContain('без боли и ожогов');
  });

  test('кап 6000 символов; строка — не длиннее 400; метка без строк не остаётся', () => {
    const body = Array.from({ length: 400 }, (_, i) => `Описание процедуры подробно, пункт ${i}.`).join('\n');
    const context = `${BIO}\n${body}\n${'х'.repeat(900)}`;
    const r = mk.pickMedicalFragments({ context, fragments: [{ start: 0, end: context.length }] }, [BIO]);
    expect(r.lines.join('\n').length).toBeLessThanOrEqual(6000);
    expect(r.lines.every(l => l.length <= 400)).toBe(true);
    // второй фрагмент, не влезший целиком, не оставляет висячую метку «Заголовок»:
    const two = medicalSearchResult(['bio0']);
    const ctx2 = `${context}\n\n${two.context}`;
    const r2 = mk.pickMedicalFragments({ context: ctx2, fragments: [{ start: 0, end: context.length },
      { start: context.length + 2, end: ctx2.length }] }, [BIO]);
    expect(r2.lines[r2.lines.length - 1]).not.toMatch(/^«.*»:$/);
  });

  test('нет fragments / битые границы / ничего нужного → null', () => {
    const kb = medicalSearchResult(['laser']);
    expect(mk.pickMedicalFragments({ context: kb.context }, [LASER])).toBeNull();
    expect(mk.pickMedicalFragments({ context: kb.context, fragments: [{ start: 5, end: 1 }] }, [LASER])).toBeNull();
    expect(mk.pickMedicalFragments(kb, [BIO])).toBeNull();
    expect(mk.pickMedicalFragments(kb, [])).toBeNull();
    expect(mk.pickMedicalFragments(null, [BIO])).toBeNull();
  });
});
