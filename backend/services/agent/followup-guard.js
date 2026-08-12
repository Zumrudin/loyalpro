'use strict';
// ============================================================
// Напоминание о себе идёт БЕЗ инструментов: модель не видит ни слотов, ни
// каталога. Оставленная без данных, она начинает время СОЧИНЯТЬ — этот класс
// дефекта у проекта уже был (инцидент 2026-08-10, alien_time_attribution).
//
// Правило: время в напоминании законно, ТОЛЬКО если оно дословно звучало в
// прошлых репликах Милы. Нарушение → напоминание НЕ отправляется вовсе.
// Вырезать подстроку нельзя: фраза рвётся и пациент получает огрызок, а
// молчание безопаснее (тот же принцип, что fail-safe в care/decision.js).
//
// Юнит-тесты: agent-followup-guard.test.js
// ============================================================

// Границы слева/справа — не \b: в JS он считает словом только ASCII, и на
// кириллице вокруг числа срабатывал бы непредсказуемо (та же готча, что в
// address-guard). Слева/справа не должно быть цифры или двоеточия — иначе
// «112:30» отдал бы «12:30», а «12:345» отдал бы «12:34».
const TIME_RE = /(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g;

// 'HH:MM' → минуты суток. Через число, а не строку: '9:00' и '09:00' — одно
// время, а строковое сравнение объявило бы второе выдумкой.
function toMinutes(h, m) {
  const hh = Number(h), mm = Number(m);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Все времена текста в исходном написании (порядок сохраняется). */
function collectTimes(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TIME_RE)) {
    if (toMinutes(m[1], m[2]) !== null) out.push(m[0]);
  }
  return out;
}

function timeMinutesSet(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(TIME_RE)) {
    const min = toMinutes(m[1], m[2]);
    if (min !== null) set.add(min);
  }
  return set;
}

/**
 * Есть ли в тексте время, которого не было в прошлых репликах Милы.
 * @param {string} text текст напоминания
 * @param {string} priorAssistantText склеенные прошлые реплики Милы
 */
function hasInventedTime(text, priorAssistantText) {
  const allowed = timeMinutesSet(priorAssistantText);
  for (const min of timeMinutesSet(text)) {
    if (!allowed.has(min)) return true;
  }
  return false;
}

module.exports = { hasInventedTime, collectTimes };
