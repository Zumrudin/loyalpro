'use strict';
const { rublesInWords, integerWords, plural } = require('./utils/money-words');
const { fmtDate, fmtMoney, fmtQty, fmtPhone, NBSP } = require('./services/edocs/format');

describe('rublesInWords', () => {
  test.each([
    [0, 'Ноль рублей 00 копеек'],
    [1, 'Один рубль 00 копеек'],
    [2, 'Два рубля 00 копеек'],
    [5, 'Пять рублей 00 копеек'],
    [11, 'Одиннадцать рублей 00 копеек'],
    [21, 'Двадцать один рубль 00 копеек'],
    [112, 'Сто двенадцать рублей 00 копеек'],
    [1000, 'Одна тысяча рублей 00 копеек'],
    [2000, 'Две тысячи рублей 00 копеек'],
    [5000, 'Пять тысяч рублей 00 копеек'],
    [11000, 'Одиннадцать тысяч рублей 00 копеек'],
    [21000, 'Двадцать одна тысяча рублей 00 копеек'],
    [93500, 'Девяносто три тысячи пятьсот рублей 00 копеек'],
    [1001.5, 'Одна тысяча один рубль 50 копеек'],
    [1000000, 'Один миллион рублей 00 копеек'],
    [2003004, 'Два миллиона три тысячи четыре рубля 00 копеек'],
    [0.01, 'Ноль рублей 01 копейка'],
    [0.02, 'Ноль рублей 02 копейки'],
    [7737.61, 'Семь тысяч семьсот тридцать семь рублей 61 копейка'],
  ])('%p → %s', (n, s) => expect(rublesInWords(n)).toBe(s));

  test('копейки округляются', () => expect(rublesInWords(10.005)).toBe('Десять рублей 01 копейка'));
  test('отрицательное, NaN и триллион — RangeError', () => {
    for (const bad of [-1, NaN, 'abc', 1e12]) expect(() => rublesInWords(bad)).toThrow(RangeError);
  });
  test('integerWords и plural', () => {
    expect(integerWords(40)).toBe('сорок');
    expect(plural(14, ['a', 'b', 'c'])).toBe('c');
    expect(plural(22, ['a', 'b', 'c'])).toBe('b');
  });
});

describe('форматы', () => {
  test('fmtDate', () => {
    expect(fmtDate('2026-10-24')).toBe('24.10.2026');
    expect(fmtDate('')).toBe('');
    expect(fmtDate(null)).toBe('');
    expect(fmtDate('24.10.2026')).toBe('');
  });
  test('fmtMoney', () => {
    expect(fmtMoney(12345.5)).toBe(`12${NBSP}345,50`);
    expect(fmtMoney(0)).toBe('0,00');
    expect(fmtMoney(1234567)).toBe(`1${NBSP}234${NBSP}567,00`);
    expect(fmtMoney(-5)).toBe('-5,00');
  });
  test('fmtQty', () => {
    expect(fmtQty(2)).toBe('2');
    expect(fmtQty(1.5)).toBe('1,5');
  });
  test('fmtPhone', () => {
    expect(fmtPhone('79001234567')).toBe('+7 (900) 123-45-67');
    expect(fmtPhone('+7 900 123-45-67')).toBe('+7 (900) 123-45-67');
    expect(fmtPhone('12345')).toBe('12345');
  });
});
