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

module.exports = { hasFutureMatchingBooking, recordContext };
