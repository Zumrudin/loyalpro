'use strict';
const crypto = require('crypto');
const config = require('../config');
const { withTransaction } = require('../db');
const journal = require('./journal');
const model = require('./journal/model');
const yc = require('./journal/yclients');
const mirror = require('./journal/mirror');
const logger = require('../logger').createLogger('MobileBooking');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::00(?:\.0{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

function operationId(sessionToken, salonId, clientId, bookingId, newDateTime, requested) {
  if (requested != null) {
    if (!UUID.test(String(requested))) model.fail('Некорректный ключ операции.');
    return String(requested).toLowerCase();
  }
  const digest = crypto.createHmac('sha256', config.JWT_SECRET)
    .update(JSON.stringify(['mobile-reschedule', sessionToken, salonId, clientId, String(bookingId), newDateTime]))
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function assertOwner(record, expectedClientId, recordId) {
  if (!record || Number(record.id) !== Number(recordId)
      || !expectedClientId || !record.client || Number(record.client.id) !== Number(expectedClientId)) {
    model.fail('Запись не найдена.', 404);
  }
}

async function reschedule(client, bookingId, newDateTime, requestedOperationId, now = Date.now()) {
  if (typeof newDateTime !== 'string' || !DATETIME.test(newDateTime)) model.fail('Укажите новую дату и время.');
  const at = model.moscowParts(newDateTime);
  if (!at || at.ms <= now) model.fail('Новое время визита должно быть в будущем.');
  const key = operationId(client.sessionToken, client.salonId, client.clientId, bookingId, newDateTime, requestedOperationId);
  const booking = await withTransaction(async conn => {
    const result = await conn.query(
      `SELECT r.id, r.salon_id, r.yclients_record_id, r.status, r.visit_datetime,
              c.yclients_client_id
       FROM records r
       JOIN clients c ON c.id=r.client_id AND c.salon_id=r.salon_id
       JOIN salons s ON s.id=r.salon_id AND s.is_active=TRUE
       WHERE r.id=$1 AND r.client_id=$2 AND r.salon_id=$3 AND c.yclients_client_id=$4
       FOR UPDATE OF r, c`,
      [bookingId, client.clientId, client.salonId, client.yclientsClientId]);
    const row = result.rows[0];
    if (!row) model.fail('Запись не найдена.', 404);
    if (!['waiting', 'confirmed'].includes(row.status)) model.fail('Запись нельзя перенести в текущем статусе.', 409);
    if (!row.yclients_record_id || !row.yclients_client_id) model.fail('Запись не синхронизирована с YClients.', 409);
    const current = model.moscowParts(row.visit_datetime);
    if (!current || current.ms <= now) model.fail('Время визита уже наступило.', 409);
    return row;
  });

  const salon = await journal.salonFor(booking.salon_id);
  let live = await yc.getRecord(salon, booking.yclients_record_id);
  assertOwner(live, booking.yclients_client_id, booking.yclients_record_id);
  let result = { duplicate: false };
  if (model.moscowParts(live.datetime)?.ms !== at.ms) {
    const draft = model.parseDraft({
      operationId: key, recordId: booking.yclients_record_id, version: model.revision(live),
      date: at.date, time: at.time, staffId: live.staff_id,
    }, 'move');
    result = await journal.mutate(booking.salon_id, null, draft, { expectedClientId: booking.yclients_client_id });
    live = await yc.getRecord(salon, booking.yclients_record_id);
    assertOwner(live, booking.yclients_client_id, booking.yclients_record_id);
    if (model.moscowParts(live.datetime)?.ms !== at.ms) {
      model.fail('Результат переноса не подтверждён. Проверьте запись перед повтором.', 409, 'uncertain');
    }
  }
  try {
    await mirror.storeLive(salon, live);
  } catch (_) {
    logger.warn(`mirror refresh failed salon=${booking.salon_id} record=${booking.yclients_record_id}`);
  }
  return { recordId: booking.id, dateTime: live.datetime, duplicate: result.duplicate === true };
}

module.exports = { reschedule, operationId, assertOwner };
