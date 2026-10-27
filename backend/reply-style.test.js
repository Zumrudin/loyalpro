'use strict';

// Стилевой слой исходящих реплик Милы (спека 2026-10-27-mila-human-tone-design.md,
// раздел 4.1). Замер прода 27.10: markdown в 28 % реплик, «Вы» с заглавной в 55 %,
// «вы» со строчной в 13 % — TDLib-шлюз и MAX показывают звёздочки буквально.
const s = require('./services/agent/reply-style');

describe('stripMarkdown', () => {
  test('жирный и подчёркивание двойными маркерами', () => {
    expect(s.stripMarkdown('Есть **15:30** или __17:00__.')).toBe('Есть 15:30 или 17:00.');
  });
  test('одиночные маркеры курсива только вплотную к тексту', () => {
    expect(s.stripMarkdown('это *важно* и _срочно_')).toBe('это важно и срочно');
    expect(s.stripMarkdown('5*3=15, цена 2*500 ₽')).toBe('5*3=15, цена 2*500 ₽');
    expect(s.stripMarkdown('peri_clinic_promo')).toBe('peri_clinic_promo');
  });
  test('списки со звёздочкой и дефисом → «•», нумерованные не трогаем', () => {
    expect(s.stripMarkdown('Рекомендации:\n*   не загорать\n- не пить\n1. вода')).toBe('Рекомендации:\n• не загорать\n• не пить\n1. вода');
  });
  test('заголовки, обратные кавычки, ссылки', () => {
    expect(s.stripMarkdown('## Подготовка\nПриходите с `чистой кожей`')).toBe('Подготовка\nПриходите с чистой кожей');
    expect(s.stripMarkdown('Прайс: [на сайте](https://peri-clinic.ru/price)')).toBe('Прайс: на сайте: https://peri-clinic.ru/price');
  });
  test('пустые строки схлопываются до одной, хвостовые пробелы убираются', () => {
    expect(s.stripMarkdown('Да.  \n\n\n\nЗаписать?')).toBe('Да.\n\nЗаписать?');
  });
  test('не-строка → пустая строка', () => {
    expect(s.stripMarkdown(null)).toBe('');
    expect(s.stripMarkdown(undefined)).toBe('');
  });
});

describe('capitalizeAddress', () => {
  test('все формы обращения как отдельные слова', () => {
    expect(s.capitalizeAddress('у вас, к вам, с вами, ваш номер, ваша запись, в вашем случае'))
      .toBe('у Вас, к Вам, с Вами, Ваш номер, Ваша запись, в Вашем случае');
  });
  test('внутри слов не трогает', () => {
    expect(s.capitalizeAddress('выбрать время, вышлю, вашингтон')).toBe('выбрать время, вышлю, вашингтон');
  });
  test('уже заглавные не меняются', () => {
    expect(s.capitalizeAddress('Вы записаны, Ваш визит')).toBe('Вы записаны, Ваш визит');
  });
});

describe('applyReplyStyle', () => {
  test('markdown + обращение за один вызов, эмодзи и времена сохраняются', () => {
    expect(s.applyReplyStyle('Да, **15:30** свободно, записать вас? 🤍')).toBe('Да, 15:30 свободно, записать Вас? 🤍');
  });
  test('идемпотентна', () => {
    const once = s.applyReplyStyle('*   пункт с **жирным** и вашим временем 14:00');
    expect(s.applyReplyStyle(once)).toBe(once);
    expect(once).toBe('• пункт с жирным и Вашим временем 14:00');
  });
  test('рычаг AGENT_REPLY_STYLE=false выключает преобразования', () => {
    expect(s.applyReplyStyle('**x** вас', { env: { AGENT_REPLY_STYLE: 'false' } })).toBe('**x** вас');
    expect(s.isEnabled({ AGENT_REPLY_STYLE: 'false' })).toBe(false);
    expect(s.isEnabled({})).toBe(true);
  });
});
