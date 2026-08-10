'use strict';

const { detectRating, parseRating, isRatingSurvey, buildApology } =
  require('./services/agent/visit-rating');
const { HANDOVER_ANNOUNCED_RE, handoverText } = require('./services/agent/admin-hours');

describe('parseRating', () => {
  test('чистая цифра 2–5', () => {
    expect(parseRating('5')).toBe(5);
    expect(parseRating('2')).toBe(2);
    expect(parseRating(' 4 ')).toBe(4);
  });
  test('цифра с пунктуацией и эмодзи', () => {
    expect(parseRating('5!')).toBe(5);
    expect(parseRating('5)')).toBe(5);
    expect(parseRating('5 ❤️')).toBe(5);
    expect(parseRating('⭐ 5')).toBe(5);
  });
  test('метка времени транскрипта срезается', () => {
    expect(parseRating('[10.08 09:09] 5')).toBe(5);
  });
  test('НЕ оценка: цифра вне 2–5, слова рядом, несколько цифр', () => {
    expect(parseRating('1')).toBe(null);
    expect(parseRating('6')).toBe(null);
    expect(parseRating('5 отлично')).toBe(null);
    expect(parseRating('5 из 5')).toBe(null);
    expect(parseRating('запишите на 5')).toBe(null);
    expect(parseRating('55')).toBe(null);
    expect(parseRating('')).toBe(null);
  });
  // String([5]) === '5' — массив от провайдера/БД молча прошёл бы за оценку.
  test('не-строка отвергается без коэрсии', () => {
    expect(parseRating(['5'])).toBe(null);
    expect(parseRating(5)).toBe(null);
    expect(parseRating(null)).toBe(null);
    expect(parseRating(undefined)).toBe(null);
    expect(parseRating({ toString: () => '5' })).toBe(null);
  });
  test('эмодзи-клавиша, ZWJ-семья и модификатор тона не мешают', () => {
    expect(parseRating('5️⃣')).toBe(5);
    expect(parseRating('4 👍🏿')).toBe(4);
    expect(parseRating('5 👨‍👩‍👧')).toBe(5);
  });
});

// Автор 'system' один ничего не доказывает: под ним идут и «Вы записаны на
// прием…», и «Напоминаем о записи…», и касания «Заботы». Голая «2» после
// напоминания не должна получать «нам очень жаль, что визит вас расстроил».
describe('isRatingSurvey', () => {
  test('тексты опроса распознаются', () => {
    expect(isRatingSurvey('Просим оценить обслуживание цифрой от 2 до 5')).toBe(true);
    expect(isRatingSurvey('ОЦЕНИТЕ, ПОЖАЛУЙСТА, ВИЗИТ')).toBe(true);
    expect(isRatingSurvey('Ответьте цифрой от 2 до 5')).toBe(true);
  });
  test('прочие автоуведомления — не опрос', () => {
    expect(isRatingSurvey('Вы записаны на прием 09.08.2026 19:30.')).toBe(false);
    expect(isRatingSurvey('Напоминаем о записи завтра в 12:00')).toBe(false);
    expect(isRatingSurvey('Ваша запись перенесена')).toBe(false);
    expect(isRatingSurvey('Как ваше самочувствие после процедуры?')).toBe(false);
  });
  // «балл» и «звёзд» в словаре этой клиники значат совсем другое — маркерами
  // они были бы источником ложных срабатываний, а не распознавания опроса.
  test('«баллы» и «звёздочки» клиники за опрос не считаются', () => {
    expect(isRatingSurvey('Вам начислено 500 баллов за отзыв')).toBe(false);
    expect(isRatingSurvey('Лазерное удаление сосудистых звёздочек')).toBe(false);
    expect(isRatingSurvey('Сосудистые звездочки — консультация врача')).toBe(false);
  });
  test('пусто / не строка → false (fail-open в LLM)', () => {
    expect(isRatingSurvey('')).toBe(false);
    expect(isRatingSurvey('   ')).toBe(false);
    expect(isRatingSurvey(null)).toBe(false);
    expect(isRatingSurvey(['оцените'])).toBe(false);
  });
});

describe('detectRating', () => {
  test('последний блок — user с чистой цифрой → рейтинг', () => {
    const messages = [
      { role: 'assistant', content: '[09.08 12:00] Записала вас' },
      { role: 'user', content: '[10.08 09:09] 5' },
    ];
    expect(detectRating(messages)).toBe(5);
  });
  test('серия из нескольких строк с цифрой И словами → null (пусть решает LLM)', () => {
    expect(detectRating([{ role: 'user', content: '[10.08 09:09] 5\n[10.08 09:10] и запишите ещё' }])).toBe(null);
  });
  test('последний блок не user → null', () => {
    expect(detectRating([{ role: 'user', content: '5' }, { role: 'assistant', content: 'ок' }])).toBe(null);
    expect(detectRating([])).toBe(null);
    expect(detectRating(null)).toBe(null);
  });
});

describe('тексты ответов', () => {
  // Своей благодарности за 4–5 модуль не строит вовсе: на неё клиника отвечает
  // сама («Спасибо за отличную оценку… дарим 500 бонусов»), и вторая ушла бы
  // раньше, съев повод для просьбы об отзыве. Ветка оркестратора молчит.
  test('благодарности за высокую оценку в модуле нет', () => {
    expect(require('./services/agent/visit-rating').buildThanks).toBeUndefined();
  });
  // Сцепка с диспетчером: он по ЭТОМУ признаку решает, дошлать ли handoverText.
  // Сверяемся с общей константой, а не со своей копией регулярки — копия
  // разъехалась бы молча, и пациент получил бы объявление о переводе дважды.
  test('извинение объявляет перевод по общему признаку admin-hours', () => {
    expect(buildApology({ adminOff: false })).toMatch(HANDOVER_ANNOUNCED_RE);
    expect(buildApology({ adminOff: true })).toMatch(HANDOVER_ANNOUNCED_RE);
    // Тот же признак обязан ловить и штатную фразу диспетчера — иначе константа
    // описывает не «перевод объявлен», а случайное слово из нашего текста.
    expect(handoverText(false)).toMatch(HANDOVER_ANNOUNCED_RE);
    expect(handoverText(true)).toMatch(HANDOVER_ANNOUNCED_RE);
  });
  test('ночью не обещаем скорый ответ — как handoverText в admin-hours', () => {
    expect(buildApology({ adminOff: true })).toMatch(/рабочего дня/i);
    expect(buildApology({ adminOff: false })).not.toMatch(/рабочего дня/i);
  });
});
