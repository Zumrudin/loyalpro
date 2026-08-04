'use strict';

// ── Жива ли запись в YClients ───────────────────────────────────────────────
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Предикат нужен в двух далёких друг от друга местах —
// в выдаче будущих записей пациенту (list_client_bookings) и в решении, оживлять
// ли идемпотентный ключ брони (booking.createBookingRecord). Разъехавшиеся копии
// означали бы, что одна часть системы считает запись мёртвой, а другая — живой.
//
// ГОТЧА. Удалённую запись YClients НЕ отдаёт как 404: GET /record/{cid}/{id}
// возвращает обычное тело с deleted:true (проверено на боевой записи 1886730339,
// удалённой из интерфейса 2026-08-04). Отмена агентом — это не удаление, а
// attendance=-1 плюс урезанная длительность (см. booking-modify.cancelBookingRecord).
// Оба случая одинаково означают «визита не будет».

/**
 * @param {object|null} rec запись YClients (тело /record/{cid}/{id} или элемент /records).
 * @returns {boolean} true — визит существует и состоится.
 */
function isRecordAlive(rec) {
  if (!rec || !rec.id) return false;
  if (rec.deleted === true) return false;
  if (Number(rec.attendance) === -1) return false;
  return true;
}

module.exports = { isRecordAlive };
