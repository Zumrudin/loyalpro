'use strict';

const { isPromoInterest } = require('./services/agent/promo-interest');

describe('isPromoInterest', () => {
  const userMsg = (content) => [{ role: 'user', content }];

  test('голый «+» и «плюс» — триггер', () => {
    expect(isPromoInterest(userMsg('+'))).toBe(true);
    expect(isPromoInterest(userMsg('++'))).toBe(true);
    expect(isPromoInterest(userMsg('Плюс'))).toBe(true);
    expect(isPromoInterest(userMsg('[10.08 09:09] +'))).toBe(true);
    expect(isPromoInterest(userMsg('+ 🙏'))).toBe(true);
  });

  test('НЕ триггер: содержательный текст, «да», пусто, не-user', () => {
    expect(isPromoInterest(userMsg('да'))).toBe(false);          // «да» — согласие на что угодно
    expect(isPromoInterest(userMsg('расскажите'))).toBe(false);  // узкий триггер намеренно
    expect(isPromoInterest(userMsg('+ запишите меня'))).toBe(false);
    expect(isPromoInterest(userMsg('79001112233'))).toBe(false);
    expect(isPromoInterest([{ role: 'assistant', content: '+' }])).toBe(false);
    expect(isPromoInterest([])).toBe(false);
    expect(isPromoInterest(null)).toBe(false);
  });

  // Type-guard как в visit-rating.parseRating: String(['+']) === '+', и массив от
  // провайдера/БД молча прошёл бы за короткое согласие.
  test('не-строковый content отвергается без коэрсии', () => {
    expect(isPromoInterest(userMsg(['+']))).toBe(false);
    expect(isPromoInterest(userMsg(null))).toBe(false);
    expect(isPromoInterest(userMsg(undefined))).toBe(false);
    expect(isPromoInterest(userMsg(5))).toBe(false);
    expect(isPromoInterest([{ role: 'user' }])).toBe(false);
  });

  // Чистка эмодзи — та же константа, что в visit-rating (одна копия на оба
  // модуля): keycap, ZWJ, VS16 и модификаторы тона.
  test('эмодзи вокруг «+» не мешают, keycap-цифра триггером не становится', () => {
    expect(isPromoInterest(userMsg('👍+'))).toBe(true);
    expect(isPromoInterest(userMsg('+ 👩🏻‍⚕️'))).toBe(true);
    expect(isPromoInterest(userMsg('5️⃣'))).toBe(false);
  });

  test('пунктуация и переносы вокруг «+» не мешают', () => {
    expect(isPromoInterest(userMsg('+!'))).toBe(true);
    expect(isPromoInterest(userMsg('  +  '))).toBe(true);
    expect(isPromoInterest(userMsg('плюс.'))).toBe(true);
    expect(isPromoInterest(userMsg('+\n+'))).toBe(false);   // серия склеена через \n → два блока текста
  });
});
