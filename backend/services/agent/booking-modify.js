'use strict';

const { pool } = require('../../db');
const config = require('../../config');
const { ycGetRecord, ycUpdateRecord } = require('../yclients-records');

// ── Исполнитель отмены и переноса записи агентом. ──
// Отмена — НЕ удаление: помечаем «клиент не пришёл» (attendance=-1), режем
// длительность до 5 минут (освобождаем место в графике мастера) и добавляем
// услугу «Запрет на отправку» (глушит уведомления YClients по записи). Перенос —
// PUT нового datetime с сохранением услуг/мастера. record_id всегда приходит из
// list_client_bookings; принадлежность клиенту проверяем по rec.client.id.
// Спека: docs/superpowers/specs/2026-07-22-agent-cancel-reschedule-design.md.

const CANCEL_SEANCE_LENGTH = 300;   // 5 минут в секундах

// Автор изменения в YClients = владелец User-токена. Если задан отдельный
// YCLIENTS_INTEGRATION_USER_TOKEN (УЗ приложения LoyalPRO) — пишем под ним, как
// и при создании записи (ycCreateRecord), чтобы автор был «LoyalPRO».
function authSalonFor(salon) {
  return config.YCLIENTS_INTEGRATION_USER_TOKEN
    ? { ...salon, yclients_user_token: config.YCLIENTS_INTEGRATION_USER_TOKEN }
    : salon;
}

async function loadSalon(salonId) {
  const salon = (await pool.query(`SELECT * FROM salons WHERE id=$1`, [salonId])).rows[0];
  return salon && salon.yclients_company_id ? salon : null;
}

// Best-effort лог действия. Не должен ломать ответ агенту.
async function logEvent(salonId, dialogKey, kind, toolName, payload) {
  try {
    await pool.query(
      `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload)
       VALUES ($1,$2,$3,$4,$5)`,
      [salonId, dialogKey, kind, toolName, JSON.stringify(payload)]);
  } catch (_) { /* лог не должен ломать ответ агенту */ }
}

// Услуги записи → формат для PUT [{id}].
function serviceIds(rec) {
  return (Array.isArray(rec.services) ? rec.services : []).map(s => ({ id: s.id }));
}

// Проверка принадлежности записи клиенту. Возвращает строку-ошибку или null.
function ownershipError(rec, expectedYcClientId) {
  if (expectedYcClientId && rec.client && Number(rec.client.id) !== Number(expectedYcClientId)) {
    return 'Запись принадлежит другому клиенту.';
  }
  return null;
}

async function cancelBookingRecord(salonId, { dialogKey, recordId, expectedYcClientId, noNotifyServiceId }) {
  const salon = await loadSalon(salonId);
  if (!salon) return { ok: false, error: 'YClients не подключён для салона.' };

  let rec;
  try { rec = await ycGetRecord(salon, recordId); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!rec || !rec.id) return { ok: false, error: 'Запись не найдена.' };
  if (ownershipError(rec, expectedYcClientId)) return { ok: false, foreign: true, error: ownershipError(rec, expectedYcClientId) };

  // Идемпотентность: уже отменена — второй дубль-вебхук не должен падать.
  if (Number(rec.attendance) === -1) return { ok: true, already: true, record_id: rec.id };

  const services = serviceIds(rec);
  let noNotifyApplied = false;
  if (noNotifyServiceId && !services.some(s => Number(s.id) === Number(noNotifyServiceId))) {
    services.push({ id: noNotifyServiceId });
    noNotifyApplied = true;
  }

  try {
    await ycUpdateRecord(authSalonFor(salon), recordId, {
      staff_id: rec.staff_id,
      services,
      datetime: rec.datetime,
      seance_length: CANCEL_SEANCE_LENGTH,
      attendance: -1,
      comment: rec.comment || '',
    });
  } catch (e) { return { ok: false, error: e.message }; }

  await logEvent(salonId, dialogKey, 'booking_cancelled', 'cancel_booking',
    { record_id: recordId, no_notify_applied: noNotifyApplied });
  return { ok: true, record_id: recordId, no_notify_applied: noNotifyApplied };
}

async function rescheduleBookingRecord(salonId, { dialogKey, recordId, expectedYcClientId, datetime, staffYcId, seanceLength }) {
  const salon = await loadSalon(salonId);
  if (!salon) return { ok: false, error: 'YClients не подключён для салона.' };

  let rec;
  try { rec = await ycGetRecord(salon, recordId); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!rec || !rec.id) return { ok: false, error: 'Запись не найдена.' };
  if (ownershipError(rec, expectedYcClientId)) return { ok: false, foreign: true, error: ownershipError(rec, expectedYcClientId) };

  try {
    await ycUpdateRecord(authSalonFor(salon), recordId, {
      staff_id: staffYcId || rec.staff_id,
      services: serviceIds(rec),
      datetime,
      seance_length: seanceLength || rec.seance_length,
      comment: rec.comment || '',
    });
  } catch (e) { return { ok: false, error: e.message }; }

  await logEvent(salonId, dialogKey, 'booking_rescheduled', 'reschedule_booking',
    { record_id: recordId, datetime });
  return { ok: true, record_id: recordId, datetime };
}

module.exports = { cancelBookingRecord, rescheduleBookingRecord, CANCEL_SEANCE_LENGTH };
