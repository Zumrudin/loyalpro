// backend/services/medical-cert-layout.js
'use strict';

// Сумму храним/принимаем как число рублей с копейками (например 82203.50)
function splitAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const cents = Math.round(num * 100);
  const rubles = Math.trunc(cents / 100);
  const kopecks = Math.abs(cents % 100);
  return { rubles: String(rubles), kopecks: String(kopecks).padStart(2, '0') };
}

// Принимает 'YYYY-MM-DD' или Date → массив из 8 символов ДДММГГГГ
function splitDate(value) {
  if (!value) return null;
  const d = (value instanceof Date) ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  return [...dd, ...mm, ...yyyy];
}

function sanitizeUpper(s) {
  return (s == null ? '' : String(s)).trim().toUpperCase();
}

// Дату → составные блоки {dd, mm, yyyy} (строки). Для раздельного позиционирования
// числа/месяца/года в группах клеток с разделителями-точками на бланке.
function splitDateParts(value) {
  const a = splitDate(value);
  if (!a) return null;
  return { dd: a[0] + a[1], mm: a[2] + a[3], yyyy: a[4] + a[5] + a[6] + a[7] };
}

// «Серия и номер» (паспорт РФ) → блоки: серия 2+2, номер 3+3.
// На вводе одно поле; первые 4 цифры — серия, следующие 6 — номер.
// Возвращает только непустые блоки; null если цифр нет.
function splitDoc(value) {
  const digits = (value == null ? '' : String(value)).replace(/\D/g, '');
  if (!digits) return null;
  const serie = digits.slice(0, 4);
  const num = digits.slice(4, 10);
  const out = {};
  if (serie.length) { out.serie1 = serie.slice(0, 2); if (serie.length > 2) out.serie2 = serie.slice(2, 4); }
  if (num.length)   { out.number1 = num.slice(0, 3); if (num.length > 3) out.number2 = num.slice(3, 6); }
  return out;
}

// Единое поле name → {last, first, middle}
function splitFullName(name) {
  const parts = sanitizeUpper(name).split(/\s+/).filter(Boolean);
  return {
    last: parts[0] || '',
    first: parts[1] || '',
    middle: parts.slice(2).join(' ') || '',
  };
}

module.exports = { splitAmount, splitDate, splitDateParts, splitDoc, splitFullName, sanitizeUpper };
