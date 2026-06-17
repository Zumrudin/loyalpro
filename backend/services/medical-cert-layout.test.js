// backend/services/medical-cert-layout.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { splitAmount, splitDate, splitDateParts, splitDoc, splitFullName, sanitizeUpper } = require('./medical-cert-layout');

test('splitAmount: рубли и копейки раздельно', () => {
  assert.deepStrictEqual(splitAmount(82203), { rubles: '82203', kopecks: '00' });
  assert.deepStrictEqual(splitAmount(82203.5), { rubles: '82203', kopecks: '50' });
  assert.deepStrictEqual(splitAmount(0), { rubles: '0', kopecks: '00' });
  assert.deepStrictEqual(splitAmount('1234.07'), { rubles: '1234', kopecks: '07' });
});

test('splitAmount: null/пусто → null', () => {
  assert.strictEqual(splitAmount(null), null);
  assert.strictEqual(splitAmount(''), null);
});

test('splitDate: ISO/Date → массив [Д,Д,М,М,Г,Г,Г,Г]', () => {
  assert.deepStrictEqual(splitDate('2009-06-02'), ['0','2','0','6','2','0','0','9']);
  assert.deepStrictEqual(splitDate('1989-05-08'), ['0','8','0','5','1','9','8','9']);
});

test('splitDate: пусто → null', () => {
  assert.strictEqual(splitDate(''), null);
  assert.strictEqual(splitDate(null), null);
});

test('splitDateParts: дата → блоки дд/мм/гггг', () => {
  assert.deepStrictEqual(splitDateParts('2009-06-02'), { dd: '02', mm: '06', yyyy: '2009' });
  assert.deepStrictEqual(splitDateParts('1989-05-08'), { dd: '08', mm: '05', yyyy: '1989' });
  assert.strictEqual(splitDateParts(''), null);
  assert.strictEqual(splitDateParts(null), null);
});

test('splitDoc: серия 2+2, номер 3+3', () => {
  assert.deepStrictEqual(splitDoc('1234567890'), { serie1: '12', serie2: '34', number1: '567', number2: '890' });
  assert.deepStrictEqual(splitDoc('1234 567890'), { serie1: '12', serie2: '34', number1: '567', number2: '890' });
  // только серия
  assert.deepStrictEqual(splitDoc('1234'), { serie1: '12', serie2: '34' });
  // короткая серия
  assert.deepStrictEqual(splitDoc('12'), { serie1: '12' });
  assert.strictEqual(splitDoc(''), null);
  assert.strictEqual(splitDoc(null), null);
});

test('splitFullName: ФИО из одного поля', () => {
  assert.deepStrictEqual(
    splitFullName('Агафонов Артем Эдуардович'),
    { last: 'АГАФОНОВ', first: 'АРТЕМ', middle: 'ЭДУАРДОВИЧ' }
  );
  assert.deepStrictEqual(
    splitFullName('Иванов Иван'),
    { last: 'ИВАНОВ', first: 'ИВАН', middle: '' }
  );
  assert.deepStrictEqual(
    splitFullName('  Петров  '),
    { last: 'ПЕТРОВ', first: '', middle: '' }
  );
});

test('sanitizeUpper: верхний регистр, ё→е не трогаем', () => {
  assert.strictEqual(sanitizeUpper('агафонов'), 'АГАФОНОВ');
  assert.strictEqual(sanitizeUpper(null), '');
});
