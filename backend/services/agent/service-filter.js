'use strict';
// ============================================================
// Чистая логика видимости услуг агента. Без БД/HTTP — юнит-тестируемо.
// Данные готовит services/agent-settings.loadServiceFilter(Safe).
//   filter = { mode:'all'|'allowlist', denyServices:Set, allowServices:Set, denyPairs:Set }
//   denyServices/allowServices — Set строковых yc_service_id
//   denyPairs — Set ключей `${serviceId}:${staffId}` (строки)
// ============================================================

const pairKey = (serviceId, staffId) => `${String(serviceId)}:${String(staffId)}`;

// Видна ли услуга целиком с учётом режима.
// Используется гардом брони/слотов, который НЕ знает флаг active YClients →
// в all-режиме остаётся пермиссивным (блокирует только явные deny).
function decideServiceVisible(filter, ycServiceId) {
  const id = String(ycServiceId);
  if (filter.mode === 'allowlist') return filter.allowServices.has(id);
  return !filter.denyServices.has(id);
}

// Видна ли услуга для ПРЕДЛОЖЕНИЯ агентом / на экране админки, с учётом флага
// active YClients (доступность в онлайн-записи). В отличие от decideServiceVisible
// требует знания active — вызывается там, где живой список услуг уже загружен.
//   all-режим: активная услуга видна по умолчанию (если нет deny); неактивную
//     можно показать только явным allow (галочка «включить из каталога»).
//   allowlist-режим: видна только при явном allow (active игнорируется).
function decideOfferVisible(filter, ycServiceId, isActive) {
  const id = String(ycServiceId);
  if (filter.mode === 'allowlist') return filter.allowServices.has(id);
  if (filter.allowServices.has(id)) return true;
  return !!isActive && !filter.denyServices.has(id);
}

// Убрать из списка id мастеров те пары услуга×мастер, что помечены deny.
function filterServiceStaff(filter, ycServiceId, staffIds) {
  return (staffIds || []).filter(sid => !filter.denyPairs.has(pairKey(ycServiceId, sid)));
}

// Можно ли предлагать/бронировать конкретную пару услуга×мастер.
function isBookable(filter, ycServiceId, ycStaffId) {
  if (!decideServiceVisible(filter, ycServiceId)) return false;
  return !filter.denyPairs.has(pairKey(ycServiceId, ycStaffId));
}

module.exports = { pairKey, decideServiceVisible, decideOfferVisible, filterServiceStaff, isBookable };
