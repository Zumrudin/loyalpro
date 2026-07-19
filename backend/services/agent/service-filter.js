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
function decideServiceVisible(filter, ycServiceId) {
  const id = String(ycServiceId);
  if (filter.mode === 'allowlist') return filter.allowServices.has(id);
  return !filter.denyServices.has(id);
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

module.exports = { pairKey, decideServiceVisible, filterServiceStaff, isBookable };
