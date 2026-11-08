'use strict';
// Форматы значений в документах: даты дд.мм.гггг, деньги «12 345,50», телефон.
const NBSP = ' ';
const EMPTY = '________';   // пропуск, видимый в документе: «undefined» в договоре хуже

/** 'YYYY-MM-DD' → 'DD.MM.YYYY'; всё прочее → ''. */
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** 12345.5 → '12 345,50' (разделитель тысяч — неразрывный пробел). */
function fmtMoney(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) + ',' + frac;
}

/** Количество: 2 → '2', 1.5 → '1,5'. */
function fmtQty(n) {
  const v = Math.round(Number(n || 0) * 1000) / 1000;
  return String(v).replace('.', ',');
}

/** '79001234567' → '+7 (900) 123-45-67'; не 11 цифр с 7 в начале — как есть. */
function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!/^7\d{10}$/.test(d)) return String(p || '');
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

module.exports = { NBSP, EMPTY, fmtDate, fmtMoney, fmtQty, fmtPhone };
