'use strict';

// Read-through only: local edits must take effect on the next tool call even
// when the upstream catalog is cached. External identifiers never become local IDs.
async function load(salonId) {
  const catalog = require('./service-catalog');
  const data = await catalog.list(salonId);
  const rows = new Map();
  for (const row of data.services) {
    if (row.assignments_initialized && row.linked && row.yclients_id) {
      rows.set(String(row.yclients_id), { ...catalog.journalService(row), active: row.active });
    }
  }
  return rows;
}
function pair(rows, serviceId, staffId) {
  const service = rows.get(String(serviceId));
  if (!service) return null; // explicit compatibility boundary for unmigrated services
  const staff = service.active && service.staffDetails.find(s => Number(s.id) === Number(staffId));
  if (!staff) require('./journal/model').fail('Услуга не назначена активному специалисту в LoyalPro.', 409, 'service_assignment');
  return { duration: staff.duration ?? service.duration, priceMin: staff.priceMin ?? service.priceMin,
    priceMax: staff.priceMax ?? service.priceMax };
}
function overlay(services, rows) {
  return services.flatMap(service => {
    const local = rows.get(String(service.yc_id));
    if (!local) return [service];
    if (!local.active) return [];
    const staff = service.staff.flatMap(s => {
      if (!local.staffIds.includes(Number(s.yc_id))) return [];
      const effective = pair(rows, service.yc_id, s.yc_id);
      return [{ ...s, price_min: effective.priceMin, price_max: effective.priceMax, duration_min: effective.duration }];
    });
    if (!staff.length) return [];
    const mins = staff.map(s => s.price_min).filter(v => v != null);
    const maxs = staff.map(s => s.price_max ?? s.price_min).filter(v => v != null);
    return [{ ...service, title: local.title, duration_min: local.duration, staff,
      price_min: mins.length ? Math.min(...mins) : null, price_max: maxs.length ? Math.max(...maxs) : null }];
  });
}
// Fresh per-staff API read, not the TTL catalog: local assignment is insufficient
// authorization to create a pair that does not exist in the connected company.
async function verifyExternal(salon, staffId, serviceIds, rows) {
  const managed = serviceIds.filter(id => rows.has(String(id)));
  if (!managed.length) return;
  managed.forEach(id => pair(rows, id, staffId));
  const { ycGet } = require('./yclients');
  let response;
  try { response = await ycGet(salon, `/services/${salon.yclients_company_id}`, { staff_id: staffId }); }
  catch (_) { throw new Error('Не удалось подтвердить назначения в YClients. Повторите проверку.'); }
  const services = Array.isArray(response) ? response : response?.services;
  if (!Array.isArray(services) || managed.some(id => !services.some(s => Number(s.id) === Number(id) && !s.deleted && !s.is_deleted && !s.archive))) {
    throw new Error('Назначение услуги специалисту не подтверждено в YClients. Проверьте настройки интеграции.');
  }
}
module.exports = { load, pair, overlay, verifyExternal };
