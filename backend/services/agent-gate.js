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

// 'HH:MM' → минуты от полуночи. Любой мусор → null (вызывающий решает, что делать).
function parseHhMm(raw) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Попадает ли момент в окно. Начало включительно, конец исключительно.
// start > end — окно через полночь (22:00–09:30). start === end — окно нулевой
// длины (НЕ круглые сутки: молчаливое превращение в 24/7 — опасный сюрприз).
function isWithinWindow(nowMinutes, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMinutes >= startMin && nowMinutes < endMin;
  return nowMinutes >= startMin || nowMinutes < endMin;
}

// Текущее московское время в минутах от полуночи. TZ задан явно: процесс сейчас
// живёт на Europe/Moscow, но опираться на это — скрытая зависимость.
function nowMskMinutes(date = new Date()) {
  const s = date.toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow', hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
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

module.exports = {
  normalizePhoneKey, decideGate, parseHhMm, isWithinWindow, nowMskMinutes,
};
