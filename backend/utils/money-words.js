'use strict';
// Сумма прописью для актов: 93500 → «Девяносто три тысячи пятьсот рублей 00 копеек».
// Тысячи — женского рода («одна тысяча», «две тысячи»), рубли и миллионы — мужского.
const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
  'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const SCALES = [
  { forms: null, fem: false },
  { forms: ['тысяча', 'тысячи', 'тысяч'], fem: true },
  { forms: ['миллион', 'миллиона', 'миллионов'], fem: false },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], fem: false },
];

/** Форма слова по числу: forms = [для 1, для 2–4, для 5–20]. */
function plural(n, forms) {
  const n100 = n % 100, n10 = n % 10;
  if (n100 >= 11 && n100 <= 19) return forms[2];
  if (n10 === 1) return forms[0];
  if (n10 >= 2 && n10 <= 4) return forms[1];
  return forms[2];
}

function triad(n, fem) {
  const out = [];
  const h = Math.floor(n / 100), t = Math.floor(n / 10) % 10, o = n % 10;
  if (h) out.push(HUNDREDS[h]);
  if (t === 1) out.push(TEENS[o]);
  else {
    if (t) out.push(TENS[t]);
    if (o) out.push((fem ? ONES_F : ONES_M)[o]);
  }
  return out;
}

/** Целое неотрицательное число словами (мужской род единиц). */
function integerWords(n) {
  if (n === 0) return 'ноль';
  const parts = [];
  let scale = 0;
  while (n > 0) {
    const tri = n % 1000;
    if (tri) {
      const words = triad(tri, SCALES[scale].fem);
      if (SCALES[scale].forms) words.push(plural(tri, SCALES[scale].forms));
      parts.unshift(words.join(' '));
    }
    n = Math.floor(n / 1000);
    scale++;
  }
  return parts.join(' ');
}

/** «Одна тысяча один рубль 50 копеек». Копейки — цифрами, как принято в актах. */
function rublesInWords(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num) || num < 0 || num >= 1e12) throw new RangeError('Сумма вне диапазона 0 … 999 999 999 999,99');
  const kop = Math.round(num * 100);
  const rub = Math.floor(kop / 100), k = kop % 100;
  const s = `${integerWords(rub)} ${plural(rub, ['рубль', 'рубля', 'рублей'])} `
    + `${String(k).padStart(2, '0')} ${plural(k, ['копейка', 'копейки', 'копеек'])}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { rublesInWords, integerWords, plural };
