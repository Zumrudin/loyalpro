'use strict';

const { ycGet, ycPost } = require('./yclients');
const config = require('../config');

// ── YClients booking-flow: свободные слоты + создание записи. ──────────
// Слоты берём через book_times (уже вычитает занятость), не через /schedule.
// Спека: docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md ([5]).

// service_ids передаём как service_ids[0], service_ids[1], … (ycGet кладёт как есть).
function serviceIdsParams(serviceYcIds) {
  const p = {};
  (serviceYcIds || []).forEach((id, i) => { p[`service_ids[${i}]`] = id; });
  return p;
}

// Свободное время у мастера на дату. Возвращает [{time, seance_length, datetime}].
async function ycGetBookTimes(salon, staffYcId, date, serviceYcIds) {
  return ycGet(
    salon,
    `/book_times/${salon.yclients_company_id}/${staffYcId}/${date}`,
    serviceIdsParams(serviceYcIds));
}

// Доступные даты записи у мастера под услугу(и). Возвращает {booking_dates:[…]}.
async function ycGetBookDates(salon, staffYcId, serviceYcIds) {
  return ycGet(
    salon,
    `/book_dates/${salon.yclients_company_id}`,
    { staff_id: staffYcId, ...serviceIdsParams(serviceYcIds) });
}

// Реальный график мастера через management API — НЕ зависит от онлайн-записи
// (bookable-флага), в отличие от book_dates/book_times. Возвращает по дню
// [{date, is_working, slots:[{from,to}]}] за диапазон дат.
async function ycGetStaffSchedule(salon, staffYcId, dateFrom, dateTo) {
  return ycGet(
    salon,
    `/schedule/${salon.yclients_company_id}/${staffYcId}/${dateFrom}/${dateTo}`,
    {});
}

// Реальная свободность мастера на дату через management API (не зависит от
// онлайн-записи). Возвращает 5-мин грид [{time, is_free}] за рабочий день.
async function ycGetStaffSeances(salon, staffYcId, date) {
  return ycGet(
    salon,
    `/timetable/seances/${salon.yclients_company_id}/${staffYcId}/${date}`,
    {});
}

// Аппараты салона: [{id, title, instances:[{id, title, resource_id}]}].
// Экземпляров у аппарата обычно ровно один — поэтому две услуги на одном
// аппарате параллельно невозможны. Кэш: список меняется крайне редко.
const _resourcesCache = {};                    // salonId → { ts, data }
const RESOURCES_TTL = 30 * 60 * 1000;

async function ycGetResources(salon) {
  const key = salon && salon.id;
  const cached = _resourcesCache[key];
  if (cached && (Date.now() - cached.ts) < RESOURCES_TTL) return cached.data;
  const data = await ycGet(salon, `/resources/${salon.yclients_company_id}`, {});
  const list = Array.isArray(data) ? data : [];
  _resourcesCache[key] = { ts: Date.now(), data: list };
  return list;
}

// Записи салона за один день. Нужны, чтобы увидеть занятость аппаратов: в
// записи лежит resource_instance_ids, и это единственный способ узнать, что
// аппарат занят чужим визитом (management-график мастера про это не знает).
async function ycGetDayRecords(salon, date) {
  const data = await ycGet(salon, `/records/${salon.yclients_company_id}`,
    { start_date: date, end_date: date, count: 300 });
  return Array.isArray(data) ? data : [];
}

// Создание записи через management API (partner+user токен, без SMS-кода).
// Автор записи в YClients = владелец User-токена. Если задан отдельный
// YCLIENTS_INTEGRATION_USER_TOKEN (УЗ приложения LoyalPRO) — создаём запись под
// ним, чтобы автор был «LoyalPRO», а не личная УЗ владельца. Иначе — как раньше,
// под salons.yclients_user_token. Заголовки собирает ycHeaders по этому полю.
async function ycCreateRecord(salon, {
  staffYcId, serviceYcIds, datetime, seanceLength, clientPhone, clientName, comment,
}) {
  const body = {
    staff_id: staffYcId,
    services: (serviceYcIds || []).map(id => ({ id })),
    client: { phone: clientPhone, name: clientName || '' },
    datetime,
    seance_length: seanceLength,
    save_if_busy: false,
    send_sms: false,
    comment: comment || 'Запись через ИИ-агента',
  };
  const authSalon = config.YCLIENTS_INTEGRATION_USER_TOKEN
    ? { ...salon, yclients_user_token: config.YCLIENTS_INTEGRATION_USER_TOKEN }
    : salon;
  return ycPost(authSalon, `/records/${salon.yclients_company_id}`, body);
}

module.exports = {
  ycGetBookTimes, ycGetBookDates, ycGetStaffSchedule, ycGetStaffSeances, ycCreateRecord,
  ycGetResources, ycGetDayRecords,
};
