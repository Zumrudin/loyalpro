'use strict';
// ============================================================
// Agent gate — чистые хелперы допуска ИИ-агента к диалогу (без БД/HTTP).
// Юнит-тесты в backend/agent-gate.test.js.
// ============================================================

// Канонический ключ номера: только цифры, РФ-формат 8→7, 10-значное ядро → 7XXXXXXXXXX.
// '89200255591' → '79200255591', '+7 (920) 025-55-91' → '79200255591'.
function normalizePhoneKey(raw) {
  const digits = raw ? String(raw).replace(/\D/g, '') : '';
  if (!digits) return '';
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return '7' + digits.slice(1);
  if (digits.length === 10) return '7' + digits;
  return digits;
}

// Решение допуска. Чистая функция. Порядок: enabled → чёрный список → режим/белый.
// @param {boolean} enabled
// @param {'all'|'whitelist'} mode
// @param {string[]} allow  нормализованные номера белого списка
// @param {string[]} block  нормализованные номера чёрного списка
// @param {string}   phone  сырой номер входящего (нормализуем внутри)
// @returns {{allow: boolean, reason: string}}
function decideGate({ enabled, mode, allow, block, phone }) {
  if (!enabled) return { allow: false, reason: 'disabled' };
  const key = normalizePhoneKey(phone);
  if (key && (block || []).includes(key)) return { allow: false, reason: 'blacklisted' };
  if (mode === 'whitelist') {
    if (!key || !(allow || []).includes(key)) return { allow: false, reason: 'not-whitelisted' };
  }
  return { allow: true, reason: 'ok' };
}

module.exports = { normalizePhoneKey, decideGate };
