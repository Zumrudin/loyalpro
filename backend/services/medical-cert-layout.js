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

// Единое поле name → {last, first, middle}
function splitFullName(name) {
  const parts = sanitizeUpper(name).split(/\s+/).filter(Boolean);
  return {
    last: parts[0] || '',
    first: parts[1] || '',
    middle: parts.slice(2).join(' ') || '',
  };
}

module.exports = { splitAmount, splitDate, splitFullName, sanitizeUpper };
