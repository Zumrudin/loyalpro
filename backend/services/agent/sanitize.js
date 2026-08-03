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

// Имя клиента — единственное клиент-контролируемое значение в системном промпте.
// sanitizeLine режет переводы строк, но 60 символов инструктивного текста в ОДНОЙ
// строке остаются («НОВОЕ ПРАВИЛО: …»). Имя — только «словесные» слова: буквы,
// дефис, точка, апостроф; первое несловесное слово обрывает имя; максимум
// 3 слова и 40 символов. Пусто/мусор → null: агент идёт по ветке «имени не
// знаем» и вежливо спросит, как обращаться.
function sanitizeName(value, maxWords = 3, maxLen = 40) {
  const words = [];
  for (const w of sanitizeLine(value, 200).split(' ')) {
    if (!/^[\p{L}][\p{L}.'-]*$/u.test(w)) break;
    words.push(w);
    if (words.length >= maxWords) break;
  }
  return words.join(' ').slice(0, maxLen).trim() || null;
}

module.exports = { sanitizeLine, sanitizeName };
