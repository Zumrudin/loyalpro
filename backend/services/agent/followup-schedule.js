'use strict';
// ============================================================
// Ожидание ответа клиента — ЧИСТЫЙ расчёт сроков. Ни БД, ни сети.
//
// Лестница: t0 (доставка реплики Милы) + delay1 → напоминание,
// t0 + delay2 → финальное сообщение. ОБА срока меряются от ЯКОРЯ, а не
// «плюс N к предыдущему касанию»: администратор в форме задаёт «через
// сколько после нашего ответа», и цепочка «+15, потом ещё +60» дала бы
// финал на 75-й минуте вместо 60-й.
//
// Юнит-тесты: agent-followup-schedule.test.js
// ============================================================

const { parseHhMm, nowMskMinutes } = require('../agent-gate');

// Рекомендованные значения формы. В БД дефолт delay1 = 0 (выключено): выкат
// не должен сам начать писать живым пациентам.
const DEFAULT_DELAY1_MIN = 15;
const DEFAULT_DELAY2_MIN = 60;

// Верхняя граница интервала: сутки. Больше — это уже не «напомнить о себе»,
// а плановое напоминание (services/reminders) с его собственными правилами.
const MAX_DELAY_MIN = 1440;

function toPositiveInt(raw, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

/**
 * Нормализовать интервалы салона.
 * @param {object} settings настройки агента (camelCase, services/agent-settings)
 * @returns {{enabled:boolean, delay1:number, delay2:number}}
 *   enabled=false означает «в этом салоне не напоминаем» — либо явный 0,
 *   либо мусор в колонке (рассинхрон схемы с кодом: молча слать нельзя).
 */
function resolveDelays(settings = {}) {
  const d1 = toPositiveInt(settings.followupDelay1Min, MAX_DELAY_MIN);
  if (!d1) return { enabled: false, delay1: 0, delay2: 0 };
  const d2raw = toPositiveInt(settings.followupDelay2Min, MAX_DELAY_MIN);
  // Финал обязан быть ПОЗЖЕ напоминания: иначе два сообщения ушли бы подряд.
  const d2 = d2raw && d2raw > d1 ? d2raw : DEFAULT_DELAY2_MIN;
  return { enabled: true, delay1: d1, delay2: d2 > d1 ? d2 : d1 + DEFAULT_DELAY2_MIN };
}

/**
 * Срок следующего касания.
 * @param {object} o
 * @param {Date|string|number} o.anchorAt момент доставки реплики Милы
 * @param {number} o.stage 0 — ждём напоминания, 1 — ждём финала, 2 — всё сказано
 * @returns {Date|null} null — срока больше нет либо якорь битый
 */
function nextAtFor({ anchorAt, stage, delay1Min, delay2Min } = {}) {
  const base = new Date(anchorAt).getTime();
  if (!Number.isFinite(base)) return null;
  const minutes = stage === 0 ? delay1Min : stage === 1 ? delay2Min : null;
  if (!Number.isFinite(minutes) || minutes === null) return null;
  return new Date(base + minutes * 60000);
}

/**
 * Позже ли момент верхней границы суток. Граница ВКЛЮЧАЮЩАЯ (21:00 при
 * границе '21:00' — ещё можно): круглое значение в форме читается как «до
 * девяти вечера», а не «до 20:59».
 * Битая или пустая граница → false (fail-open): выдуманный запрет молча
 * лишил бы пациента ответа — тот же принцип, что у расписания в agent-gate.
 */
function isTooLate(at, latestTime) {
  const limit = parseHhMm(latestTime);
  if (limit === null) return false;
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return false;
  return nowMskMinutes(when) > limit;
}

module.exports = {
  resolveDelays, nextAtFor, isTooLate,
  DEFAULT_DELAY1_MIN, DEFAULT_DELAY2_MIN, MAX_DELAY_MIN,
};
