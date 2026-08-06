'use strict';

// Инцидент 2026-08-06 (79165370505): первое в истории обращение пациентки, а
// Мила ответила по делу — без приветствия и без представления. Промпт-блок
// «ПЕРВОЕ ОБРАЩЕНИЕ» помог не везде: на живом пробнике ветка известного
// пациента с отказом по времени дала 1 приветствие из 3 попыток. Отсюда
// детерминированный слой — тот же приём, что с блоком актуальных записей:
// факт бьёт правило.
const g = require('./services/agent/greeting');

describe('hasGreeting', () => {
  test('узнаёт приветствие в любом регистре и форме', () => {
    expect(g.hasGreeting('Здравствуйте, Юлия!')).toBe(true);
    expect(g.hasGreeting('доброе утро!')).toBe(true);
    expect(g.hasGreeting('Добрый вечер')).toBe(true);
  });
  test('деловой ответ без приветствия', () => {
    expect(g.hasGreeting('Да, на 12 августа в 16:00 есть свободное время.')).toBe(false);
  });
});

describe('ensureGreeting', () => {
  const opts = { givenName: 'Юлия', salonName: 'PERI CLINIC' };

  test('приветствие дописывается В НАЧАЛО первой реплики', () => {
    const out = g.ensureGreeting(['Да, на 12 августа в 16:00 есть свободное время.'], opts);
    expect(out[0]).toBe(
      'Здравствуйте, Юлия! Я Мила, виртуальный администратор PERI CLINIC.\n\n'
      + 'Да, на 12 августа в 16:00 есть свободное время.');
  });

  test('приветствие уже есть → реплики не трогаем', () => {
    const replies = ['Здравствуйте, Юлия! Свободно 16:00'];
    expect(g.ensureGreeting(replies, opts)).toEqual(replies);
  });

  // Серия уходит отдельными сообщениями: приветствие во ВТОРОЙ реплике —
  // тоже приветствие, дублировать его нельзя.
  test('приветствие во второй реплике серии не дублируется', () => {
    const replies = ['Секунду, уточню', 'Здравствуйте! Свободно 16:00'];
    expect(g.ensureGreeting(replies, opts)).toEqual(replies);
  });

  test('имени не знаем → приветствие без имени', () => {
    expect(g.ensureGreeting(['Есть 16:00'], { salonName: 'PERI CLINIC' })[0])
      .toBe('Здравствуйте! Я Мила, виртуальный администратор PERI CLINIC.\n\nЕсть 16:00');
  });

  // Имя клиент-контролируемо (карточка YClients): на боевой базе в поле имени
  // лежат телефоны и «Тест 2». Тот же фильтр, что у промпта.
  test('мусор вместо имени → обращение без имени', () => {
    expect(g.ensureGreeting(['Есть 16:00'], { givenName: '79001112233', salonName: 'PERI CLINIC' })[0])
      .toMatch(/^Здравствуйте! Я Мила/);
  });

  // Салон в runDialog никто не передаёт (ни диспетчер, ни вебхук), и промпт
  // живёт на своём дефолте — значит дописка ОБЯЗАНА брать тот же самый, иначе
  // пациент слышит от модели одно название клиники, а от кода другое.
  test('салон не передан → тот же дефолт, что у промпта', () => {
    const { resolveSalonName } = require('./services/agent/system-prompt');
    expect(g.ensureGreeting(['Есть 16:00'], {})[0])
      .toBe(`Здравствуйте! Я Мила, виртуальный администратор ${resolveSalonName()}.\n\nЕсть 16:00`);
    expect(resolveSalonName()).toBe('PERI CLINIC');
  });

  test('пустой список реплик не трогаем', () => {
    expect(g.ensureGreeting([], opts)).toEqual([]);
  });
});

// Детерминированное приветствие обязано звучать так же, как образец первого
// сообщения в промпте: иначе пациент получит одну формулировку от модели и
// другую от кода. Связку держим тестом, как с OPERATOR_MARK и formatStamp.
describe('связь с образцом первого сообщения в промпте', () => {
  test('представление дословно совпадает с формулировкой промпта', () => {
    const { buildSystemPrompt } = require('./services/agent/system-prompt');
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC', clientName: 'Юлия', phoneKnown: true });
    expect(p).toContain('Я Мила, виртуальный администратор PERI CLINIC');
    expect(g.buildGreeting({ givenName: 'Юлия', salonName: 'PERI CLINIC' }))
      .toContain('Я Мила, виртуальный администратор PERI CLINIC');
  });
});
