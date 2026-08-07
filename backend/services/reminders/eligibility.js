'use strict';
// «Клиент уже записан на аналогичную услугу?» Чистый модуль.
//
// «Аналогичная» = попадает под ТЕ ЖЕ условия правила, что и визит-якорь
// (утверждено при обсуждении): правило на категорию «Лазерная эпиляция» считает
// аналогичной запись на любую услугу этой категории, а не только на ту же самую.
// Отсюда переиспользование evaluateRule — второй копии критерия быть не должно.
//
// Форма записи повторяет care/context.hasMatchingRepeatVisit: YClients отдаёт
// мастера то как staff.id, то как staff_id.

const { evaluateRule } = require('../notifications');
const { isVisitCompleted, classifyRecordEvent } = require('../care/enroll');

function recordContext(r, catMap) {
  const serviceIds = (Array.isArray(r.services) ? r.services : [])
    .map(s => s && s.id).filter(v => v != null);
  return {
    staffId: r.staff_id || (r.staff && r.staff.id) || null,
    serviceIds,
    categoryIds: [...new Set(serviceIds
      .map(id => (catMap || new Map()).get(String(id)))
      .filter(Boolean))],
  };
}

/** Есть ли среди будущих записей хоть одна под условия правила. */
function hasFutureMatchingBooking(future, conditions, catMap) {
  return (future || []).some(r => {
    if (!r) return false;
    try { return evaluateRule(conditions, recordContext(r, catMap)); }
    catch { return false; }
  });
}

/**
 * Визит ДЕЙСТВИТЕЛЬНО состоялся? Голого isVisitCompleted() тут мало:
 *   — у предоплаченной неявки paid_full=1 стоит ОДНОВРЕМЕННО с attendance=-1
 *     (депозит удержан, клиент не пришёл) — isVisitCompleted() наивно
 *     вернула бы true;
 *   — у удалённой записи (deleted=true) attendance может остаться 1 (запись
 *     отменили ПОСЛЕ визита или задним числом) — isVisitCompleted() снова
 *     не увидит отмены.
 * classifyRecordEvent проверяет оба признака ПЕРВЫМ (тот же приоритет, что
 * в handleRecordEvent и в «Заботе», care/enroll.js). Общий экспорт — чтобы
 * планировщик (reminders/enroll.js) и догон по базе (reminders/backfill.js)
 * не разъезжались: без композиции неявка/удалённая запись выглядели бы
 * состоявшимся визитом и реально ушли бы клиенту как «пора повторить».
 */
function visitReallyHappened(record, payloadStatus = null) {
  return isVisitCompleted(record) && classifyRecordEvent(record, payloadStatus) !== 'unenroll';
}

module.exports = { hasFutureMatchingBooking, recordContext, visitReallyHappened };
