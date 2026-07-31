'use strict';

const listServices = require('./tools/list-services');

// Достоверная привязка «мастер выполняет услугу» живёт в list_services (поле staff,
// собранное per-staff запросами к YClients — общий /services урезан). График/кресло
// мастера к этому слепы: в fallback-режиме (онлайн-запись выключена) слоты считаются
// из занятости кресла и вернут окна даже у мастера, который процедуру не делает.
// Клиент часто называет мастера по имени → модель берёт его yc_id из list_staff,
// минуя поле staff услуги. Поэтому и слоты, и бронь сверяем этой предпроверкой.
//
// Fail-open: если каталог недоступен/пуст или услуги нет в каталоге — возвращаем
// unknown, и вызывающий НЕ блокирует (иначе при сбое YClients не пройдёт ни один
// легитимный слот/бронь; выдуманный service_yc_id всё равно ловит create_booking).
async function checkStaffPerformsService(salonId, serviceYcId, staffYcId) {
  let catalog = null;
  try { catalog = await listServices.run(salonId); } catch (_) { catalog = null; }
  if (!catalog || !Array.isArray(catalog.services) || !catalog.services.length) {
    return { unknown: true, ok: false, performers: [], staffList: [] };
  }
  const svc = catalog.services.find(s => String(s.yc_id) === String(serviceYcId));
  if (!svc) return { unknown: true, ok: false, performers: [], staffList: [] };
  const staff = svc.staff || [];
  const ok = staff.some(m => String(m.yc_id) === String(staffYcId));
  return {
    ok, unknown: false,
    performers: staff.map(m => m.name).filter(Boolean),
    // Полный список исполнителей с id — для подбора альтернативного мастера,
    // когда у запрошенного нет свободного времени на дату.
    staffList: staff.map(m => ({ yc_id: m.yc_id, name: m.name })),
  };
}

module.exports = { checkStaffPerformsService };
