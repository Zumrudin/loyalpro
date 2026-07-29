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
  test('повторное приветствие при hasPriorAssistant', () => {
    expect(g.lintReply('Здравствуйте! Записать вас?', { hasPriorAssistant: true }))
      .toEqual(expect.arrayContaining([{ type: 'repeat_greeting', value: 'Здравствуйте' }]));
  });
  test('приветствие в ПЕРВОМ ответе — норма', () => {
    expect(g.lintReply('Здравствуйте! Я Мила', { hasPriorAssistant: false })).toEqual([]);
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

describe('hardViolations', () => {
  test('taboo_word и id_leak — жёсткие (требуют переписывания)', () => {
    expect(g.hardViolations([
      { type: 'taboo_word', value: 'прайс' },
      { type: 'emoji_excess', value: '2' },
    ])).toEqual([{ type: 'taboo_word', value: 'прайс' }]);
  });
});
