'use strict';

const { ycGet, ycPost } = require('./yclients');

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

// Создание записи через management API (partner+user токен, без SMS-кода).
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
  return ycPost(salon, `/records/${salon.yclients_company_id}`, body);
}

module.exports = { ycGetBookTimes, ycGetBookDates, ycGetStaffSchedule, ycCreateRecord };
