'use strict';

const g = require('./services/agent/reply-guard');

describe('extractTimes', () => {
  test('вытаскивает HH:MM и HH.MM, нормализует к HH:MM', () => {
    expect(g.extractTimes('могу предложить 14:00 или 16.30')).toEqual(['14:00', '16:30']);
  });
  test('однозначный час нормализуется с ведущим нулём', () => {
    expect(g.extractTimes('в 9:30 утра')).toEqual(['09:30']);
  });
  test('без времени — пустой массив', () => {
    expect(g.extractTimes('запишу вас на чистку')).toEqual([]);
  });
  test('время внутри ISO datetime (book_chain.records[].datetime) извлекается', () => {
    expect(g.extractTimes('{"datetime":"2026-07-30T10:30:00+03:00"}')).toEqual(['10:30']);
  });
  test('часовой пояс ISO datetime (+03:00) НЕ считается временем', () => {
    expect(g.extractTimes('2026-07-30T10:30:00+03:00')).toEqual(['10:30']);
  });
  test('часовой пояс со знаком минус и Z-форма тоже не считаются временем', () => {
    expect(g.extractTimes('2026-07-30T22:15:00-05:30')).toEqual(['22:15']);
    expect(g.extractTimes('2026-07-30T22:15:00Z')).toEqual(['22:15']);
  });
  test('дата DD.MM (месяц 01-12) не читается как время', () => {
    expect(g.extractTimes('запись 12.07')).toEqual([]);
  });
  test('точечное время с минутами вне диапазона месяца остаётся временем (сохранённое поведение)', () => {
    expect(g.extractTimes('в 14.30')).toEqual(['14:30']);
  });
});

describe('checkOfferedTimes', () => {
  test('все времена реплики есть в allowed — нет нарушений', () => {
    const v = g.checkOfferedTimes('окошки в 14:00 или 16:30', new Set(['14:00', '16:30']));
    expect(v).toEqual([]);
  });
  test('время не из allowed — нарушение unknown_time', () => {
    const v = g.checkOfferedTimes('могу в 15:00', new Set(['14:00']));
    expect(v).toEqual([{ type: 'unknown_time', value: '15:00' }]);
  });
  test('пустой allowed — проверка отключена (за ход время не всплывало)', () => {
    expect(g.checkOfferedTimes('в 15:00', new Set())).toEqual([]);
  });
});

describe('lintReply', () => {
  test('слова-табу — нарушение taboo_word (value = слово как в тексте, в нижнем регистре)', () => {
    const v = g.lintReply('посмотрела в нашем Каталоге и прайсе');
    expect(v).toEqual(expect.arrayContaining([
      { type: 'taboo_word', value: 'каталоге' },
      { type: 'taboo_word', value: 'прайсе' },
    ]));
  });
  test('«база знаний» в любом падеже', () => {
    expect(g.lintReply('в базе знаний нет статьи')).toEqual(
      expect.arrayContaining([{ type: 'taboo_word', value: 'базе знаний' }]));
  });
  test('«базой знаний» (творительный падеж) тоже табу', () => {
    expect(g.lintReply('я сверилась с базой знаний')).toEqual(
      expect.arrayContaining([{ type: 'taboo_word', value: 'базой знаний' }]));
  });
  test('утечка внутреннего id (6+ цифр подряд)', () => {
    expect(g.lintReply('ваша запись 15234567 создана')).toEqual(
      expect.arrayContaining([{ type: 'id_leak', value: '15234567' }]));
  });
  test('телефон в формате +7…/8… НЕ считается утечкой id', () => {
    expect(g.lintReply('наберите нас: +79200255591')).toEqual([]);
    expect(g.lintReply('наберите нас: 89200255591')).toEqual([]);
  });
  test('цена с пробелом-разделителем не триггерит id_leak', () => {
    expect(g.lintReply('стоимость 6 500 ₽')).toEqual([]);
  });
  test('цена ≥100000 без разделителей с маркером валюты не триггерит id_leak', () => {
    expect(g.lintReply('курс стоит 150000 ₽')).toEqual([]);
    expect(g.lintReply('курс 150000 руб')).toEqual([]);
    expect(g.lintReply('ваша запись 15234567 создана')).toEqual(
      expect.arrayContaining([{ type: 'id_leak', value: '15234567' }]));
  });
  test('повторное приветствие при hasPriorAssistant', () => {
    expect(g.lintReply('Здравствуйте! Записать вас?', { hasPriorAssistant: true }))
      .toEqual(expect.arrayContaining([{ type: 'repeat_greeting', value: 'Здравствуйте' }]));
  });
  test('приветствие в ПЕРВОМ ответе — норма', () => {
    expect(g.lintReply('Здравствуйте! Я Мила', { hasPriorAssistant: false })).toEqual([]);
  });
  // Инцидент 2026-08-06 (79165370505): первое в истории обращение, а Мила
  // ответила «Да, на 12 августа в 16:00 есть свободное время…». Обратная
  // сторона repeat_greeting: пропущенное приветствие guard не видел вовсе.
  test('первое обращение без приветствия — missing_greeting', () => {
    expect(g.lintReply('Да, на 12 августа в 16:00 есть свободное время.', { firstContact: true }))
      .toEqual(expect.arrayContaining([{ type: 'missing_greeting', value: '' }]));
  });
  test('первое обращение С приветствием — нарушения нет', () => {
    expect(g.lintReply('Здравствуйте, Юлия! Я Мила, виртуальный администратор.', { firstContact: true }))
      .toEqual([]);
  });
  test('без firstContact пропущенное приветствие не проверяется', () => {
    expect(g.lintReply('Да, на 12 августа есть свободное время.')).toEqual([]);
  });
  // Переписывать реплику из-за стилистики нельзя: довызов стоит денег и
  // рискует сломать уже корректный ответ. Как unknown_time — сначала лог.
  test('missing_greeting — мягкое нарушение, переписывания не требует', () => {
    expect(g.hardViolations([{ type: 'missing_greeting', value: '' }])).toEqual([]);
  });
  test('больше одного эмодзи — emoji_excess', () => {
    expect(g.lintReply('Готово! ✅ Ждём вас 🤍🌸')).toEqual(
      expect.arrayContaining([{ type: 'emoji_excess', value: '3' }]));
    expect(g.lintReply('Ждём вас 🤍')).toEqual([]);
  });
  test('чистая реплика — пусто', () => {
    expect(g.lintReply('Записала вас на чистку лица, будем ждать')).toEqual([]);
  });
});

// Плотная запись (§8 docs/superpowers/specs/2026-08-06-agent-slot-density-design.md):
// модель называет время МИМО подобранного offer_slots — только лог, никакого
// переписывания (offer_bypass не входит в HARD_TYPES).
describe('checkOfferDeviation', () => {
  test('offer_slots за ход не было (offerTimes пуст) — проверка выключена целиком', () => {
    const v = g.checkOfferDeviation('окошко в 15:00', {
      toolTimes: new Set(['14:00', '15:00']),
      offerTimes: new Set(),
      patientTimes: new Set(),
    });
    expect(v).toEqual([]);
  });
  test('время из offer_slots — не нарушение', () => {
    const v = g.checkOfferDeviation('окошко в 14:00', {
      toolTimes: new Set(['14:00', '15:00']),
      offerTimes: new Set(['14:00']),
      patientTimes: new Set(),
    });
    expect(v).toEqual([]);
  });
  test('время вне offer_slots, но НАЗВАННОЕ ПАЦИЕНТОМ САМИМ — не нарушение', () => {
    const v = g.checkOfferDeviation('хорошо, подтверждаю 15:00', {
      toolTimes: new Set(['14:00', '15:00']),
      offerTimes: new Set(['14:00']),
      patientTimes: new Set(['15:00']),
    });
    expect(v).toEqual([]);
  });
  test('время, которого нет в выдаче инструментов вовсе — не дело этой проверки (ловит unknown_time)', () => {
    const v = g.checkOfferDeviation('окошко в 16:00', {
      toolTimes: new Set(['14:00', '15:00']),
      offerTimes: new Set(['14:00']),
      patientTimes: new Set(),
    });
    expect(v).toEqual([]);
  });
  test('время И в выдаче инструментов, И не в offer_slots, И пациент его не называл — offer_bypass', () => {
    const v = g.checkOfferDeviation('окошко в 15:00', {
      toolTimes: new Set(['14:00', '15:00']),
      offerTimes: new Set(['14:00']),
      patientTimes: new Set(),
    });
    expect(v).toEqual([{ type: 'offer_bypass', value: '15:00' }]);
  });
  test('offer_bypass — мягкое нарушение, переписывания не требует', () => {
    expect(g.hardViolations([{ type: 'offer_bypass', value: '15:00' }])).toEqual([]);
  });
  test('отсутствие opts (undefined) не роняет функцию — трактуется как выключенная проверка', () => {
    expect(g.checkOfferDeviation('окошко в 15:00')).toEqual([]);
  });

  // Второе разрешение правила «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ»: пациент попросил
  // другое время СЛОВАМИ, без цифр («а есть пораньше?»). extractTimes цифр в
  // такой фразе не найдёт, и без patientAskedOtherTime легальный ответ писался
  // бы как offer_bypass.
  test('пациент попросил пораньше словами → offer_bypass не пишется, даже если время не совпадает', () => {
    const v = g.checkOfferDeviation('хорошо, тогда 11:00', {
      toolTimes: new Set(['11:00', '14:00']),
      offerTimes: new Set(['14:00']),
      patientTimes: new Set(),
      patientAskedOtherTime: true,
    });
    expect(v).toEqual([]);
  });
  // Симметрично: без просьбы о другом времени словами проверка не выключается
  // сама по себе — иначе она была бы выключена всегда.
  test('обычное сообщение (patientAskedOtherTime=false) — нарушение по-прежнему фиксируется', () => {
    const v = g.checkOfferDeviation('хорошо, тогда 11:00', {
      toolTimes: new Set(['11:00', '14:00']),
      offerTimes: new Set(['14:00']),
      patientTimes: new Set(),
      patientAskedOtherTime: false,
    });
    expect(v).toEqual([{ type: 'offer_bypass', value: '11:00' }]);
  });
});

// Свободный день (правка 07.08): промпт велит вместо времени спросить половину дня.
// Метрика нужна потому, что правило держится на промпте, а промпт-правила в этом
// проекте уже дважды проигрывали живым пробникам (приветствие, плотная запись).
describe('checkFreeDayTime: день свободен, а модель назвала время', () => {
  test('время в реплике при free_day → free_day_time', () => {
    expect(g.checkFreeDayTime('Могу записать на 11:00', { freeDay: true, patientTimes: new Set() }))
      .toEqual([{ type: 'free_day_time', value: '11:00' }]);
  });

  test('вопрос о половине дня без времени → чисто', () => {
    expect(g.checkFreeDayTime('Свободно в течение дня. В какой половине дня удобнее?',
      { freeDay: true, patientTimes: new Set() })).toEqual([]);
  });

  // Пациент назвал время сам — подтверждать его модель ОБЯЗАНА (правило «просьба
  // пациента важнее подобранного времени»), и метрика на этом шуметь не должна.
  test('время назвал пациент → не нарушение', () => {
    expect(g.checkFreeDayTime('Записываю на 16:00', { freeDay: true, patientTimes: new Set(['16:00']) }))
      .toEqual([]);
  });

  test('без free_day проверка выключена', () => {
    expect(g.checkFreeDayTime('Могу в 11:00', { freeDay: false, patientTimes: new Set() })).toEqual([]);
    expect(g.checkFreeDayTime('Могу в 11:00', {})).toEqual([]);
  });

  test('free_day_time — мягкое нарушение, переписывания не требует', () => {
    expect(g.hardViolations([{ type: 'free_day_time', value: '11:00' }])).toEqual([]);
  });
});

describe('OTHER_TIME_REQUEST_RE', () => {
  test('ловит все слова из формулировки промпт-правила «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ»', () => {
    for (const w of ['пораньше', 'попозже', 'утром', 'вечером', 'в другой половине дня']) {
      expect(g.OTHER_TIME_REQUEST_RE.test(w)).toBe(true);
    }
  });
  test('ловит очевидные словоформы того же смысла', () => {
    for (const w of ['раньше', 'позже', 'днём', 'днем', 'до обеда', 'после обеда']) {
      expect(g.OTHER_TIME_REQUEST_RE.test(w)).toBe(true);
    }
  });
  test('не срабатывает на обычном сообщении без просьбы о другом времени', () => {
    expect(g.OTHER_TIME_REQUEST_RE.test('хорошо, записывайте')).toBe(false);
  });
  test('регистр и словоформы: «Пораньше?», «А ПОПОЗЖЕ можно?»', () => {
    expect(g.OTHER_TIME_REQUEST_RE.test('Пораньше?')).toBe(true);
    expect(g.OTHER_TIME_REQUEST_RE.test('А ПОПОЗЖЕ можно?')).toBe(true);
  });
  // Связь с формулировкой промпт-правила (как OPERATOR_MARK/formatStamp):
  // слова регулярки обязаны реально встречаться в тексте самого правила —
  // иначе правило и код измерения тихо разойдутся при правке одного без другого.
  test('слова правила реально есть в самом тексте правила system-prompt.js', () => {
    const { buildSystemPrompt } = require('./services/agent/system-prompt');
    const p = buildSystemPrompt({});
    const idx = p.indexOf('КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ');
    expect(idx).toBeGreaterThan(-1);
    const ruleEnd = p.indexOf('Если offer_slots в ответе нет или он пуст', idx);
    const rule = ruleEnd > -1 ? p.slice(idx, ruleEnd) : p.slice(idx, idx + 800);
    for (const w of ['пораньше', 'попозже', 'утром', 'вечером', 'в другой половине дня']) {
      expect(rule).toContain(w);
      expect(g.OTHER_TIME_REQUEST_RE.test(w)).toBe(true);
    }
  });
});

describe('hardViolations', () => {
  test('taboo_word и id_leak — жёсткие (требуют переписывания)', () => {
    expect(g.hardViolations([
      { type: 'taboo_word', value: 'прайс' },
      { type: 'id_leak', value: '15234567' },
      { type: 'emoji_excess', value: '2' },
    ])).toEqual([
      { type: 'taboo_word', value: 'прайс' },
      { type: 'id_leak', value: '15234567' },
    ]);
  });
});
