'use strict';
// Атрибуция конверсии: клиент создал новую запись — какому напоминанию её
// засчитать. Чистый модуль.
//
// Условия отбора те же, что у правила (переиспользуем recordContext из
// eligibility.js — второй копии разбора записи YClients быть не должно).
// Окно атрибуции берётся из самой строки (attribution_days правила), граница
// ВКЛЮЧАЮЩАЯ. Из нескольких подходящих строк побеждает самая свежая: именно
// последнее напоминание вероятнее всего и привело клиента.
//
// Строки с удалённым правилом (rule_id IS NULL) пропускаются: сверять новую
// запись не с чем, а угадывать условия по тексту нельзя.

const { evaluateRule } = require('../notifications');
const { recordContext } = require('./eligibility');

const DAY_MS = 86400000;

// `sent_at` приходит из pg объектом Date (TIMESTAMPTZ, см. care/schedule.js
// для той же идиомы), а тесты/превью могут подать ISO-строку. Date.parse на
// объекте Date работает только через неявный ToString → Date.prototype.toString()
// и молча округляет до секунды (миллисекунды теряются), плюс опирается на
// round-trip, который спецификацией не гарантирован. Читаем миллисекунды
// напрямую с объекта, строку разбираем как раньше.
function sentMsOf(value) {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * @param {object[]} rows    строки reminder_queue со status='sent', с полями
 *                           id, rule_id, conditions, attribution_days, sent_at,
 *                           conversion_record_id
 * @param {object}   booking сырая запись YClients
 * @param {Map}      catMap  serviceId(str) → categoryId(str)
 * @param {number}   nowMs
 * @returns {object|null} строка-победитель
 */
function pickAttributionRow(rows, booking, catMap, nowMs = Date.now()) {
  if (!booking) return null;
  const ctx = recordContext(booking, catMap);

  const candidates = (rows || []).filter(r => {
    if (!r || r.conversion_record_id != null) return false;
    if (r.rule_id == null || !r.conditions) return false;
    const sentMs = sentMsOf(r.sent_at);
    if (!Number.isFinite(sentMs)) return false;
    const windowDays = Number(r.attribution_days);
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
    if (nowMs - sentMs > days * DAY_MS) return false;
    try { return evaluateRule(r.conditions, ctx); } catch { return false; }
  });
  if (!candidates.length) return null;

  candidates.sort((a, b) => sentMsOf(b.sent_at) - sentMsOf(a.sent_at));
  return candidates[0];
}

module.exports = { pickAttributionRow };
