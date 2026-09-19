'use strict';

const g = require('./services/agent/reply-guard');
const { checkGiftRepeat, GIFT_RE, hardViolations } = g;

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

// ── Приписывание чужого времени мастеру (инцидент 2026-08-10, 79166524647) ────
// У Гаджиевой Пери отпуск: все 12 вызовов get_available_slots по ней вернули
// пустые slots, а рядом в alternative_staff лежали окна Астемира Боташева.
// Мила написала пациентке «у главного врача Пери Исамудиновны … есть окошки в
// 11:00 и 15:30» — это времена АСТЕМИРА. Прежние проверки этого не видели: в
// allowedTimes у оркестратора лежат голые «HH:MM» из JSON всей выдачи, без
// привязки к мастеру и дате, поэтому чужое 11:00 делало «11:00 у Пери» законным.
describe('checkStaffAttribution: время чужого мастера выдано за время запрошенного', () => {
  const INCIDENT = 'К сожалению, у главного врача Пери Исамудиновны на пятницу всё расписано.\n\n' +
    'Посмотрела на следующий понедельник, 17 августа. Есть окошки в **11:00** и **15:30**.';
  const OPTS = { emptyStaff: ['Гаджиева Пери'], availableStaff: ['Астемир Боташев'] };

  test('мастер без окон назван, время названо, владелец времени — нет → нарушение', () => {
    const v = g.checkStaffAttribution(INCIDENT, OPTS);
    expect(v).toEqual([{ type: 'alien_time_attribution', value: 'Гаджиева Пери' }]);
  });

  test('назван и владелец окон — легально (штатная работа alternative_staff)', () => {
    const ok = 'У Пери на этот день всё занято, но эту же процедуру ведёт Астемир Боташев — ' +
      'у него свободно в 17:30.';
    expect(g.checkStaffAttribution(ok, OPTS)).toEqual([]);
  });

  test('время не названо вовсе → нарушения нет', () => {
    expect(g.checkStaffAttribution('У Пери Исамудиновны на эту неделю всё занято.', OPTS)).toEqual([]);
  });

  test('время назвал сам пациент — модель обязана его подтверждать', () => {
    const opts = { ...OPTS, patientTimes: new Set(['11:00']) };
    expect(g.checkStaffAttribution('Пери на 11:00 записать не получится.', opts)).toEqual([]);
  });

  test('мастера без окон в реплике нет → нарушения нет', () => {
    expect(g.checkStaffAttribution('Свободно в 11:00 и 15:30.', OPTS)).toEqual([]);
  });

  test('пустого списка мастеров достаточно, чтобы проверка молчала', () => {
    expect(g.checkStaffAttribution(INCIDENT, {})).toEqual([]);
  });

  // Имена в переписке склоняются: «к Пери Исамудиновне», «у Астемира».
  test('склонённое имя считается упоминанием', () => {
    const v = g.checkStaffAttribution('Записать к Гаджиевой Пери можно в 11:00.', OPTS);
    expect(v).toEqual([{ type: 'alien_time_attribution', value: 'Гаджиева Пери' }]);
  });
  test('склонённое имя владельца окон тоже считается', () => {
    const ok = 'У Пери занято, но у Астемира есть 17:30.';
    expect(g.checkStaffAttribution(ok, OPTS)).toEqual([]);
  });

  // «Пери» — 4 буквы, и без защиты стем ловил бы «период». Бренд PERI CLINIC
  // пишется латиницей и под кириллический стем не попадает по построению
  // (см. agent_peri_name_collision: врач «Пери» ≠ клиника «PERI»).
  test('строчное слово с тем же корнем именем не считается', () => {
    expect(g.checkStaffAttribution('Свободный период с 11:00.', OPTS)).toEqual([]);
  });
  test('латинский бренд PERI CLINIC под кириллическое имя не подпадает', () => {
    expect(g.checkStaffAttribution('PERI CLINIC ждёт вас в 11:00.', OPTS)).toEqual([]);
  });
});

// ── Заявление о свободном времени, ничем не подтверждённое в этом ходе ──────
// Инцидент 2026-09-15 (79775546186): Мила сказала «у главного врача… есть
// свободное окошко на 12:15» БЕЗ единого вызова get_available_slots — просто
// повторила число из трёхдневной давности переписки (у оператора и у самой
// пациентки). Через 2 минуты create_booking на это же время упал.
describe('checkUnverifiedOffer', () => {
  test('предложение времени, которого нет в verifiedTimes → unverified_offer', () => {
    const v = g.checkUnverifiedOffer(
      'У главного врача Пери Исамудиновны как раз есть свободное окошко на 12:15. Давайте я запишу вас?',
      { verifiedTimes: new Set() });
    expect(v).toEqual([{ type: 'unverified_offer', value: '12:15' }]);
  });

  test('время подтверждено результатом инструмента этого хода — нарушения нет', () => {
    const v = g.checkUnverifiedOffer('Могу предложить 12:15, записать вас?',
      { verifiedTimes: new Set(['12:15']) });
    expect(v).toEqual([]);
  });

  // Пациент сам назвал время — это НЕ освобождает от проверки (в отличие от
  // checkStaffAttribution/checkOfferDeviation): там «пациент назвал» защищает
  // честное ПОДТВЕРЖДЕНИЕ, а здесь модель заявляет НОВЫЙ факт «это свободно» —
  // ровно инцидент 2026-09-15, где пациентка сама спросила про 12:15.
  test('время, названное самим пациентом, всё равно требует подтверждения', () => {
    const v = g.checkUnverifiedOffer('Да, у нас как раз есть свободное окошко на 12:15!',
      { verifiedTimes: new Set() });
    expect(v).toEqual([{ type: 'unverified_offer', value: '12:15' }]);
  });

  test('реплика без предложения времени (нет offer-фразы) — проверка молчит', () => {
    expect(g.checkUnverifiedOffer('Хорошо, буду ждать вас в 12:15!', { verifiedTimes: new Set() }))
      .toEqual([]);
  });

  test('подтверждение уже оформленной записи («записала вас») не считается предложением', () => {
    expect(g.checkUnverifiedOffer('Готово! Записала вас на 12:15 ✅', { verifiedTimes: new Set() }))
      .toEqual([]);
  });

  test('без verifiedTimes (undefined) — трактуется как «ничего не подтверждено»', () => {
    const v = g.checkUnverifiedOffer('Могу записать вас на 15:00');
    expect(v).toEqual([{ type: 'unverified_offer', value: '15:00' }]);
  });

  // Проверка КЛАУЗАМИ, а не по всему тексту разом: время из клаузы про
  // НЕДОСТУПНОСТЬ («то окошко на 12:15 уже занято») не должно ловиться как
  // unverified_offer только потому, что где-то дальше в том же ответе есть
  // офер-фраза с другим, уже подтверждённым временем.
  test('время в клаузе «уже занято» не путается с офером в соседней клаузе', () => {
    const v = g.checkUnverifiedOffer(
      'К сожалению, то окошко на 12:15 уже занято. Но у Пери Исамудиновны есть время на 13:30 или 17:30.',
      { verifiedTimes: new Set(['13:30', '17:30']) });
    expect(v).toEqual([]);
  });

  test('unverified_offer — жёсткое нарушение (требует переписывания)', () => {
    expect(g.hardViolations([{ type: 'unverified_offer', value: '12:15' }]))
      .toEqual([{ type: 'unverified_offer', value: '12:15' }]);
  });
});

// ── Придуманная причина отказа в записи ─────────────────────────────────────
// Тот же инцидент: create_booking упал с «время недоступно, причина
// неизвестна», хендлер явно запретил утверждать «слот только что заняли», а
// Мила через 4 минуты (без повторного вызова инструмента) написала «пока мы
// вели переписку, окошко на 12:15 уже заняли».
describe('checkFabricatedUnavailabilityReason', () => {
  test('«пока мы вели переписку… заняли» — фабрикация причины', () => {
    const v = g.checkFabricatedUnavailabilityReason(
      'Елена, я понимаю ваше желание попасть именно в это время. К сожалению, ' +
      'пока мы вели переписку, окошко на 12:15 уже заняли.');
    expect(v).toEqual([{
      type: 'fabricated_unavailability_reason',
      value: 'пока мы вели переписку, окошко на 12:15 уже заняли',
    }]);
  });

  test('«только что заняли» без «пока мы…» тоже фабрикация', () => {
    expect(g.checkFabricatedUnavailabilityReason('К сожалению, это время только что заняли.'))
      .toEqual([{ type: 'fabricated_unavailability_reason', value: 'только что заняли' }]);
  });

  test('«успели занять» — фабрикация', () => {
    expect(g.checkFabricatedUnavailabilityReason('Кажется, успели занять это окошко.'))
      .toEqual([{ type: 'fabricated_unavailability_reason', value: 'успели занять' }]);
  });

  test('нейтральный отказ БЕЗ версии о причине — норма', () => {
    expect(g.checkFabricatedUnavailabilityReason(
      'К сожалению, то окошко на 12:15 уже занято. Но есть время на 13:30 или 17:30.'))
      .toEqual([]);
  });

  test('fabricated_unavailability_reason — жёсткое нарушение', () => {
    expect(g.hardViolations([{ type: 'fabricated_unavailability_reason', value: 'только что заняли' }]))
      .toEqual([{ type: 'fabricated_unavailability_reason', value: 'только что заняли' }]);
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

  // 10.08.2026: unknown_time переведён из лога в жёсткие. Основание — замер по
  // ПРОДУ: за весь доступный лог (91 ход агента) он сработал РОВНО ДВА раза, и
  // оба — этот инцидент («18 августа 12:00 и 14:30» на дату, которую тул в тот
  // ход вообще не спрашивали). Ложных срабатываний в проде не было ни одного,
  // а цена пропуска — выдуманное время, согласованное с пациентом.
  test('unknown_time — жёсткое: выдуманное время дороже лишнего довызова', () => {
    expect(g.hardViolations([{ type: 'unknown_time', value: '14:30' }]))
      .toEqual([{ type: 'unknown_time', value: '14:30' }]);
  });

  test('alien_time_attribution — жёсткое', () => {
    expect(g.hardViolations([{ type: 'alien_time_attribution', value: 'Гаджиева Пери' }]))
      .toEqual([{ type: 'alien_time_attribution', value: 'Гаджиева Пери' }]);
  });

  // Стилистика по-прежнему только лог: переписывание стоит денег и рискует
  // сломать по сути верный ответ.
  test('offer_bypass и free_day_time остаются мягкими', () => {
    expect(g.hardViolations([
      { type: 'offer_bypass', value: '15:00' },
      { type: 'free_day_time', value: '11:00' },
    ])).toEqual([]);
  });
});

// ── gift_repeat: «консультация в подарок» второй раз за диалог (лог-only) ──
describe('checkGiftRepeat', () => {
  // value — ФАКТИЧЕСКАЯ клауза, а не константа: сигнал существует ради
  // измерения, и по логу нужно понимать, ЧТО именно подарено второй раз.
  test('повтор при уже звучавшем «в подарок» → нарушение с текстом клаузы', () => {
    expect(checkGiftRepeat('Плюс консультация в подарок!', { priorHasGift: true }))
      .toEqual([{ type: 'gift_repeat', value: 'Плюс консультация в подарок!' }]);
  });
  test('из многофразной реплики в value идёт только клауза с подарком', () => {
    expect(checkGiftRepeat('Записала вас на 12:00. Консультация врача — в подарок. Ждём!',
      { priorHasGift: true }))
      .toEqual([{ type: 'gift_repeat', value: 'Консультация врача — в подарок.' }]);
  });
  test('первое упоминание → чисто', () => {
    expect(checkGiftRepeat('Консультация в подарок при процедуре в тот же день', { priorHasGift: false })).toEqual([]);
  });
  test('нет фразы в реплике → чисто', () => {
    expect(checkGiftRepeat('Записала вас на чистку', { priorHasGift: true })).toEqual([]);
  });
  test('gift_repeat — НЕ жёсткое нарушение (только лог)', () => {
    expect(hardViolations([{ type: 'gift_repeat', value: 'в подарок' }])).toEqual([]);
  });
});

// ── Время объявлено занятым, хотя инструмент в этом ходе вернул его свободным ──
// Инцидент 2026-09-16 (79774224184): «окошко на 21:30 уже занято» при 21:30 в
// slots той же выдачи. Зеркало checkUnverifiedOffer: там ложное «свободно»,
// тут ложное «занято». freeTimes собирает оркестратор (см. его тесты).
describe('checkFalseUnavailability', () => {
  const { checkFalseUnavailability } = g;
  const free = new Set(['21:30']);

  test('боевая реплика: «21:30 уже занято» при свободном 21:30 → false_unavailability', () => {
    const v = checkFalseUnavailability(
      'Виктория, к сожалению, окошко на 21:30 уже занято. Могу предложить на четверг в 18:00 к Юлии.',
      { freeTimes: free });
    expect(v).toEqual([{ type: 'false_unavailability', value: '21:30' }]);
  });

  test('другие формулировки отказа: «недоступно», «нет свободного», «уже нет», «не получится»', () => {
    for (const t of [
      'На 21:30, к сожалению, недоступно.',
      'В 21:30 нет свободного времени.',
      'На 21:30 уже нет окошка.',
      'На 21:30 записать не получится.',
    ]) {
      expect(checkFalseUnavailability(t, { freeTimes: free })).toEqual([{ type: 'false_unavailability', value: '21:30' }]);
    }
  });

  test('честное подтверждение свободного времени — чисто', () => {
    expect(checkFalseUnavailability('Да, 21:30 свободно! Перенести вашу запись?', { freeTimes: free })).toEqual([]);
  });

  test('«занято» про ДРУГОЕ время, свободное названо в другой клаузе — чисто', () => {
    expect(checkFalseUnavailability('На 19:00 занято. Но есть 21:30 — подойдёт?', { freeTimes: free })).toEqual([]);
  });

  test('без freeTimes или с пустым множеством — проверка выключена', () => {
    expect(checkFalseUnavailability('На 21:30 занято.')).toEqual([]);
    expect(checkFalseUnavailability('На 21:30 занято.', { freeTimes: new Set() })).toEqual([]);
  });

  test('false_unavailability — жёсткое нарушение (корректирующий довызов)', () => {
    expect(hardViolations([{ type: 'false_unavailability', value: '21:30' }]))
      .toEqual([{ type: 'false_unavailability', value: '21:30' }]);
  });
});

// ── Инцидент 2026-09-19 (79651442032) ─────────────────────────────────────────
// Ход 1: «Посмотрела расписание Татьяны, на утро понедельника у неё уже всё
// расписано» — ни одного слот-вызова за ход. unknown_time срезал цифры из
// черновика, а СЛОВЕСНОЕ утверждение о занятости не ловил никто.
describe('checkUnbackedUnavailability', () => {
  const { checkUnbackedUnavailability } = g;

  test('боевая реплика без слот-вызова → unbacked_unavailability с клаузой', () => {
    const v = checkUnbackedUnavailability(
      'Посмотрела расписание Татьяны, к сожалению, на утро понедельника у неё уже всё расписано.\n\n' +
      'Могу предложить перенести ваши визиты на вторник.',
      { slotToolCalled: false, writeErrored: false });
    expect(v).toHaveLength(1);
    expect(v[0].type).toBe('unbacked_unavailability');
    expect(v[0].value).toMatch(/всё расписано/);
  });

  test('ход 5: «вечерних окошек нет» без слот-вызова → нарушение', () => {
    const v = checkUnbackedUnavailability(
      'Утром в среду, к сожалению, у Татьяны уже всё занято, а вечерних окошек, к сожалению, нет.',
      { slotToolCalled: false });
    expect(v.map(x => x.type)).toEqual(['unbacked_unavailability']);
  });

  test('слот-инструмент вызывался → утверждение подкреплено, чисто', () => {
    expect(checkUnbackedUnavailability('На утро понедельника всё расписано.', { slotToolCalled: true })).toEqual([]);
  });

  test('write упал (YClients отказал) → «занято» — факт, чисто', () => {
    expect(checkUnbackedUnavailability('Это время, к сожалению, уже занято.', { slotToolCalled: false, writeErrored: true })).toEqual([]);
  });

  test('реплика без утверждений о занятости — чисто', () => {
    expect(checkUnbackedUnavailability('Подскажите, в какой день и половину дня вам удобнее?', { slotToolCalled: false })).toEqual([]);
    expect(checkUnbackedUnavailability('Клиника работает ежедневно с 10:00 до 22:00.', { slotToolCalled: false })).toEqual([]);
  });

  test('«не работает / выходной» — не занятость (это про график, ловится отдельно)', () => {
    expect(checkUnbackedUnavailability('В понедельник у Татьяны выходной.', { slotToolCalled: false })).toEqual([]);
  });

  test('по клаузам: две клаузы о занятости — два нарушения', () => {
    const v = checkUnbackedUnavailability('Утром всё занято. Вечером тоже нет окошек.', { slotToolCalled: false });
    expect(v).toHaveLength(2);
  });

  test('жёсткий тип', () => {
    expect(hardViolations([{ type: 'unbacked_unavailability', value: 'x' }])).toHaveLength(1);
  });
});

// Ход 6: «Нет. Днём не могу» → ноль вызовов и повтор тех же 13:30/14:00/14:30.
describe('checkRejectedRepeat', () => {
  const { checkRejectedRepeat, isRefusal } = g;
  const prev = new Set(['13:30', '14:00', '14:30']);

  test('боевая реплика: отказ без цифр + те же времена без нового слот-вызова → rejected_repeat', () => {
    const v = checkRejectedRepeat(
      'Понимаю вас. Я могу предложить вам записаться к Татьяне на среду на 13:30, 14:00 или 14:30.',
      { patientLastText: 'Нет\nДнем не могу', prevOfferTimes: prev, slotToolCalled: false });
    expect(v).toEqual([{ type: 'rejected_repeat', value: '13:30, 14:00, 14:30' }]);
  });

  test('слоты перезапрошены → другой день/выдача, чисто', () => {
    expect(checkRejectedRepeat('Есть 13:30 в четверг.',
      { patientLastText: 'Нет', prevOfferTimes: prev, slotToolCalled: true })).toEqual([]);
  });

  test('пациент назвал время цифрами — это не отказ, а выбор', () => {
    expect(checkRejectedRepeat('Записываю на 14:00.',
      { patientLastText: 'нет, давайте 14:00', prevOfferTimes: prev, slotToolCalled: false })).toEqual([]);
  });

  test('реплика без прежних времён — чисто', () => {
    expect(checkRejectedRepeat('Поняла. Посмотрим другой день — какой удобен?',
      { patientLastText: 'Не могу', prevOfferTimes: prev, slotToolCalled: false })).toEqual([]);
  });

  test('без отказа в последнем сообщении — чисто', () => {
    expect(checkRejectedRepeat('Есть 13:30.',
      { patientLastText: 'а сколько стоит?', prevOfferTimes: prev, slotToolCalled: false })).toEqual([]);
  });

  test('isRefusal: формы отказа', () => {
    for (const t of ['Нет', 'нет.', 'Не могу', 'Днём не могу', 'не подходит', 'Неудобно', 'Не получится', 'никак']) {
      expect(isRefusal(t)).toBe(true);
    }
    for (const t of ['да', 'нет, давайте 14:00', 'а можно утром?', 'Нет, спасибо, запишите на 15.00']) {
      expect(isRefusal(t)).toBe(false);
    }
  });

  test('жёсткий тип', () => {
    expect(hardViolations([{ type: 'rejected_repeat', value: 'x' }])).toHaveLength(1);
  });
});
