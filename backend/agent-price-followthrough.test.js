'use strict';
const pf = require('./services/agent/price-followthrough');
const replyGuard = require('./services/agent/reply-guard');

const FACT = { title: 'Чистка лица', text: 'Ультразвук и механика, уход после процедуры.\nВторой абзац.' };
const ASK = 'Здравствуйте! Сколько стоит чистка лица?';
const BARE = 'Комбинированная чистка лица стоит 6 500 ₽.';

describe('applyPriceFollowthrough', () => {
  test('разговорный вопрос включает дописку, описание не подменяет приглашение', () => {
    const reply = `${BARE} В процедуру входит уход, она длится около часа.`;
    const r = pf.applyPriceFollowthrough([reply], { patientLastText: 'Сколько у вас будет стоить чистка?' });
    expect(r.replies).toEqual([`${reply} ${pf.STEP_QUESTION}`]);
  });

  test('история запрещает повтор шага, проверенный факт по-прежнему доступен', () => {
    const r = pf.applyPriceFollowthrough([BARE], { patientLastText: ASK, serviceFact: FACT, allowStep: false });
    expect(r.addedStep).toBe(false);
    expect(r.addedFact).toBe(true);
    expect(r.replies.join(' ')).not.toContain(pf.STEP_QUESTION);
  });
  test('голая цена + справка → факт и шаг в конце последней реплики', () => {
    const r = pf.applyPriceFollowthrough(['Анна, здравствуйте!', BARE], { patientLastText: ASK, serviceFact: FACT });
    expect(r.addedFact).toBe(true);
    expect(r.addedStep).toBe(true);
    expect(r.replies[0]).toBe('Анна, здравствуйте!');
    expect(r.replies[1]).toBe(`${BARE} Ультразвук и механика, уход после процедуры. ${pf.STEP_QUESTION}`);
    // Дописанное не тянет время и не делает телеметрию «цена без шага».
    expect(replyGuard.extractTimes(r.replies.join('\n'))).toEqual([]);
    expect(replyGuard.checkPriceWithoutNextStep(r.replies.join('\n'))).toEqual([]);
  });

  test('без справки → только шаг', () => {
    const r = pf.applyPriceFollowthrough([BARE], { patientLastText: ASK, serviceFact: null });
    expect(r.addedFact).toBe(false);
    expect(r.replies[0]).toBe(`${BARE} ${pf.STEP_QUESTION}`);
  });

  test('шаг уже есть (любой «?») → факт ПЕРЕД первым вопросом', () => {
    const r = pf.applyPriceFollowthrough([`${BARE} Хотите записаться? Есть и утро, и вечер.`], { patientLastText: ASK, serviceFact: FACT });
    expect(r.addedStep).toBe(false);
    expect(r.addedFact).toBe(true);
    expect(r.replies[0]).toBe(`${BARE} Ультразвук и механика, уход после процедуры. Хотите записаться? Есть и утро, и вечер.`);
  });

  test('вопрос первым предложением → чистого места нет, факт не добавляется', () => {
    const reply = 'Хотите записаться? Чистка стоит 6 500 ₽.';
    const r = pf.applyPriceFollowthrough([reply], { patientLastText: ASK, serviceFact: FACT });
    expect(r.addedFact).toBe(false);
    expect(r.replies).toEqual([reply]);
    expect(pf.insertFact(reply, 'Факт.')).toBeNull();
  });

  test('вопрос в более ранней реплике серии → факт не добавляется', () => {
    const r = pf.applyPriceFollowthrough(['Анна, вам для себя?', BARE], { patientLastText: ASK, serviceFact: FACT });
    expect(r.addedFact).toBe(false);
    expect(r.addedStep).toBe(false);
  });

  test('факт уже передан своими словами → без факта', () => {
    const reply = `${BARE} В процедуру входит ультразвуковая чистка. Подобрать время?`;
    const r = pf.applyPriceFollowthrough([reply], { patientLastText: ASK, serviceFact: FACT });
    expect(r.addedFact).toBe(false);
    expect(r.addedStep).toBe(false);
    expect(r.replies[0]).toBe(reply);
  });

  test('общее название услуги фактом не считается', () => {
    const fact = { title: 'Чистка лица', text: 'Комбинированная чистка лица включает ультразвук и механику.' };
    // «комбинированная» есть и в реплике — сходство, но не из заголовка/вопроса
    expect(pf.factAlreadyConveyed(BARE, fact.text, { title: fact.title, patientText: ASK })).toBe(true);
    const fact2 = { title: 'Чистка лица', text: 'Чистка лица включает ультразвук и механику.' };
    expect(pf.factAlreadyConveyed(BARE, fact2.text, { title: fact2.title, patientText: ASK })).toBe(false);
  });

  test('факт со временем / суммой / незаконченный / вопрос — не берётся', () => {
    expect(pf.factSentence('Приём ведётся с 10:00 до 21:00 ежедневно.')).toBeNull();
    expect(pf.factSentence('Приём ведётся с 10.00 до 21.00 ежедневно.')).toBeNull();
    expect(pf.factSentence('Курс из пяти процедур стоит 20 000 ₽ всего.')).toBeNull();
    expect(pf.factSentence('Ультразвук и механика, уход после проце')).toBeNull();
    expect(pf.factSentence('Хотите узнать подробнее о процедуре?')).toBeNull();
    expect(pf.factSentence('Коротко.')).toBeNull();
    expect(pf.factSentence('а'.repeat(200) + '.')).toBeNull();
    const r = pf.applyPriceFollowthrough([BARE], { patientLastText: ASK,
      serviceFact: { title: 'Чистка лица', text: 'Приём с 10:00 до 21:00 ежедневно в клинике.' } });
    expect(r.addedFact).toBe(false);
    expect(r.addedStep).toBe(true);
  });

  test('сокращения не рвут предложение и не дают огрызка', () => {
    expect(pf.factSentence('Курс занимает ок. 6–8 сеансов.')).toBe('Курс занимает ок. 6–8 сеансов.');
    expect(pf.factSentence('Процедура проводится с 18 лет, т.е. только для взрослых.'))
      .toBe('Процедура проводится с 18 лет, т.е. только для взрослых.');
    expect(pf.factSentence('Эффект заметен после первого сеанса, длится ок.')).toBeNull();
    expect(pf.factSentence('Сеанс длится в среднем сорок мин.')).toBeNull();
    expect(pf.factSentence('Подходит для всех типов кожи, т.е.')).toBeNull();
    // Обычные короткие окончания — не сокращения.
    expect(pf.factSentence('Включает ультразвук и уход для лица.')).toBe('Включает ультразвук и уход для лица.');
    expect(pf.factSentence('Эффект сохраняется до года.')).toBe('Эффект сохраняется до года.');
  });

  test('медицинское содержание не дописывается', () => {
    expect(pf.factSentence('Противопоказания: острые воспаления кожи.')).toBeNull();
    expect(pf.factSentence('Во время беременности процедура не проводится.')).toBeNull();
    expect(pf.factSentence('Побочные эффекты встречаются крайне редко.')).toBeNull();
    expect(pf.factSentence('После процедуры нельзя загорать неделю.')).toBeNull();
  });

  test('пациент назвал день/дату/половину дня → без шага', () => {
    for (const t of ['Сколько стоит чистка? Хочу в пятницу', 'Сколько стоит чистка на 12.10?',
      'Сколько стоит чистка, если вечером?', 'Сколько стоит чистка завтра?']) {
      const r = pf.applyPriceFollowthrough([BARE], { patientLastText: t, serviceFact: null, nowMs: Date.parse('2026-10-08T10:00:00+03:00') });
      expect(r.addedStep).toBe(false);
    }
  });

  test('цена «определит врач / индивидуально» → без шага', () => {
    for (const reply of ['От 15 500 ₽, точную стоимость определит врач.', 'От 15 500 ₽, препарат подбирается индивидуально.']) {
      const r = pf.applyPriceFollowthrough([reply], { patientLastText: ASK, serviceFact: null });
      expect(r.addedStep).toBe(false);
    }
  });

  test('«скидки» без вопроса о цене → не триггер', () => {
    const r = pf.applyPriceFollowthrough([BARE], { patientLastText: 'А скидки на чистку есть?', serviceFact: FACT });
    expect(r.reason).toBe('not_price');
  });

  test('берётся только первое предложение первой строки', () => {
    expect(pf.factSentence('Длится около часа и подходит для всех. Второе предложение.'))
      .toBe('Длится около часа и подходит для всех.');
  });

  test('факт и шаг уже есть → без изменений', () => {
    const reply = `${BARE} Это ультразвук и механика. Подобрать время?`;
    const r = pf.applyPriceFollowthrough([reply], { patientLastText: ASK, serviceFact: FACT });
    expect(r.reason).toBe('complete');
    expect(r.replies).toEqual([reply]);
  });

  test('вопрос не о цене → без изменений', () => {
    const r = pf.applyPriceFollowthrough([BARE], { patientLastText: 'Что входит в чистку?', serviceFact: FACT });
    expect(r.reason).toBe('not_price');
  });

  test('в реплике нет суммы → без изменений', () => {
    const r = pf.applyPriceFollowthrough(['Цена зависит от зоны, её определит врач.'], { patientLastText: ASK, serviceFact: FACT });
    expect(r.reason).toBe('no_sum');
  });

  test('пациент одновременно просит записать → без изменений', () => {
    const r = pf.applyPriceFollowthrough([BARE], { patientLastText: 'Сколько стоит чистка? Запишите на пятницу', serviceFact: FACT });
    expect(r.reason).toBe('booking');
  });

  test('перечень из ≥3 разных цен → без изменений', () => {
    const list = 'Чистка — 6 500 ₽, пилинг — 4 000 ₽, массаж — 3 000 ₽.';
    const r = pf.applyPriceFollowthrough([list], { patientLastText: 'Какие цены на уход?', serviceFact: FACT });
    expect(r.reason).toBe('price_list');
    // Две суммы в одной строке (диапазон) — ещё ответ про одну услугу.
    expect(pf.isPriceList('от 15 500 ₽ до 26 000 ₽')).toBe(false);
    // Две разные суммы столбиком — уже прайс.
    expect(pf.isPriceList('Чистка — 6 500 ₽\nПилинг — 4 000 ₽')).toBe(true);
    const r2 = pf.applyPriceFollowthrough(['Чистка — 6 500 ₽', 'Пилинг — 4 000 ₽'], { patientLastText: 'Какие цены?', serviceFact: FACT });
    expect(r2.reason).toBe('price_list');
  });

  test('пустая серия → без изменений', () => {
    expect(pf.applyPriceFollowthrough([], { patientLastText: ASK }).reason).toBe('no_reply');
  });

  test('пометка статьи / строка прайса / markdown в справке — не дописываются', () => {
    expect(pf.factSentence('Цены в статье обновлены в строгом соответствии с представленным прайс-листом.')).toBeNull();
    expect(pf.factSentence('* **Подбородок** — 4 000 ₽ (врач) / 5 000 ₽ (гл. врач) · 15 мин')).toBeNull();
    expect(pf.factSentence('Стоимость указана в рублях за одну зону обработки.')).toBeNull();
    expect(pf.factSentence('Сглаживает рубцы постакне и растяжки на коже.')).toBe('Сглаживает рубцы постакне и растяжки на коже.');
    expect(pf.factSentence('Гибридный лазер **Pacer One Pro** для эпиляции любых волос.'))
      .toBe('Гибридный лазер Pacer One Pro для эпиляции любых волос.');
  });
});

// Офлайн-повтор ценового кейса живого прогона 08.10.2026 на РЕАЛЬНЫХ чанках КБ:
// справка (pickServiceFact) → дописка (applyPriceFollowthrough).
describe('реальные чанки КБ → итоговая реплика', () => {
  const { REAL } = require('./services/agent/__fixtures__/kb-real-chunks');
  const { pickServiceFact } = require('./services/agent/service-fact');

  test('Volnewmer: факт — описание аппарата, не пометка о ценах', () => {
    const ask = 'Здравствуйте! Сколько стоит Volnewmer?';
    const fact = pickServiceFact(REAL.volnewmer, ask);
    const r = pf.applyPriceFollowthrough(['Volnewmer — от 81 000 ₽ за 400 линий.'], { patientLastText: ask, serviceFact: fact });
    expect(r.replies).toEqual(['Volnewmer — от 81 000 ₽ за 400 линий. '
      + 'Инновационный монополярный радиочастотный аппарат нового поколения от создателей Ultraformer. '
      + 'Подобрать Вам удобное время для записи?']);
  });

  test('чистка лица: факт — описание процедуры', () => {
    const ask = 'Сколько стоит чистка лица?';
    const fact = pickServiceFact(REAL.cleaning, ask);
    const r = pf.applyPriceFollowthrough(['Комбинированная чистка лица стоит 6 500 ₽.'], { patientLastText: ask, serviceFact: fact });
    expect(r.replies).toEqual(['Комбинированная чистка лица стоит 6 500 ₽. '
      + 'Профессиональное очищение кожи с индивидуальным сочетанием атравматических, ультразвуковых и механических этапов. '
      + 'Подобрать Вам удобное время для записи?']);
  });
});
