'use strict';
const pf = require('./services/agent/price-followthrough');
const replyGuard = require('./services/agent/reply-guard');

const FACT = { title: 'Чистка лица', text: 'Ультразвук и механика, уход после процедуры.\nВторой абзац.' };
const ASK = 'Здравствуйте! Сколько стоит чистка лица?';
const BARE = 'Комбинированная чистка лица стоит 6 500 ₽.';

describe('applyPriceFollowthrough', () => {
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

  test('шаг уже есть (любой «?») → только факт', () => {
    const r = pf.applyPriceFollowthrough([`${BARE} Хотите записаться?`], { patientLastText: ASK, serviceFact: FACT });
    expect(r.addedStep).toBe(false);
    expect(r.addedFact).toBe(true);
    expect(r.replies[0]).toBe(`${BARE} Хотите записаться? Ультразвук и механика, уход после процедуры.`);
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
    // Две суммы (диапазон) — ещё ответ про одну услугу.
    expect(pf.distinctSums('от 15 500 ₽ до 26 000 ₽')).toBe(2);
  });

  test('пустая серия → без изменений', () => {
    expect(pf.applyPriceFollowthrough([], { patientLastText: ASK }).reason).toBe('no_reply');
  });
});
