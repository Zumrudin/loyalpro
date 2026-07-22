'use strict';

const { db } = require('../../db');
const { normalizePhoneKey } = require('../agent-gate');

// ── Идентификация клиента по номеру из вебхука. ──
// Для каналов, которые присылают телефон (WhatsApp, номерной Telegram/tdlib),
// номер известен ещё до модели. Резолвим карточку клиента, чтобы Мила:
//   • не переспрашивала номер, который уже есть;
//   • обращалась к постоянному пациенту по имени;
//   • у нового пациента (карточки нет) мягко уточнила, как обращаться.
// Каналы без телефона (Telegram Bot / MAX) сюда приходят с пустым phone →
// возвращаем null, и агент собирает контакты в диалоге как раньше.
async function resolveClient(salonId, rawPhone) {
  const phone = normalizePhoneKey(String(rawPhone || ''));
  if (!salonId || !phone) return null;
  const row = await db.oneOrNone(
    `SELECT id, name, phone FROM clients
      WHERE salon_id = $1 AND phone LIKE '%' || $2
      LIMIT 1`,
    [salonId, phone]);
  return row ? { id: row.id, name: row.name, phone: row.phone } : null;
}

// YClients client_id пациента по номеру. В таблице clients его нет — берём из
// последней синхронизированной записи (records.yclients_client_id стабилен для
// клиента). Нужен для живого запроса записей и проверки принадлежности при
// отмене/переносе. null, если у клиента нет ни одной синхронизированной записи.
// ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: только что созданную запись (клиент без прошлой истории
// в records) агент не увидит до ближайшего 3-часового синка → list_client_bookings
// вернёт client_not_found, а cancel/reschedule — fail-closed (эскалация на
// администратора). Приемлемо для whitelist-пилота (клиенты уже с историей).
// TODO(follow-up): при промахе резолвить client_id живьём через YClients
// clients/search по телефону, чтобы покрыть свежесозданные записи.
async function resolveYclientsClientId(salonId, rawPhone) {
  const phone = normalizePhoneKey(String(rawPhone || ''));
  if (!salonId || !phone) return null;
  const row = await db.oneOrNone(
    `SELECT r.yclients_client_id AS yc_client_id
       FROM records r
       JOIN clients c ON c.id = r.client_id
      WHERE c.salon_id = $1 AND c.phone LIKE '%' || $2
        AND r.yclients_client_id IS NOT NULL
      ORDER BY r.visit_datetime DESC NULLS LAST
      LIMIT 1`,
    [salonId, phone]);
  return row && row.yc_client_id ? Number(row.yc_client_id) : null;
}

module.exports = { resolveClient, resolveYclientsClientId };
