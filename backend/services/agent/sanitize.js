'use strict';

// ── Однострочная санитизация значений, попадающих в системный промпт извне ──
// (карточка клиента, настройки в БД, названия услуг и имена мастеров из YClients,
// вебхук). Перенос строки или управляющий символ внутри значения — это
// возможность дописать агенту «новые правила» (prompt injection через системный
// промпт): режем до одной строки и разумной длины.
// Общая для system-prompt.js и sequential-offers.js — правило одно, копий быть не должно.
function sanitizeLine(value, maxLen) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

module.exports = { sanitizeLine };
