'use strict';
const r = require('./services/broadcast-messengers/render');

test('подстановки', () => {
  expect(r.renderText('{first_name}, у вас {bonuses} бонусов в {salon}', { name: 'Иванова Анна Сергеевна', bonus_balance: 512.6, salon_name: 'PERI CLINIC' }))
    .toBe('Анна, у вас 513 бонусов в PERI CLINIC');
});
test('имени нет — без осиротевшей запятой', () => {
  expect(r.renderText('{first_name}, здравствуйте!', { name: '' })).toBe('Здравствуйте!');
});
test('splitCaption', () => {
  expect(r.splitCaption('abc', false)).toEqual({ caption: null, followText: 'abc' });
  expect(r.splitCaption('abc', true)).toEqual({ caption: 'abc', followText: null });
  const long = 'x'.repeat(1025);
  expect(r.splitCaption(long, true)).toEqual({ caption: '', followText: long });
});
