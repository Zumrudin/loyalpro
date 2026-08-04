'use strict';

const { db } = require('../../db');
const { normalizePhoneKey } = require('../agent-gate');
const { resolveGivenName } = require('../../utils/person-name');
const salonNames = require('../../utils/salon-names');

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
  // Короткий ключ в суффиксном LIKE совпал бы с хвостом чужого номера —
  // идентифицируем только по полному номеру (10+ цифр).
  if (!salonId || !phone || phone.length < 10) return null;
  const row = await db.oneOrNone(
    `SELECT id, name, phone, yclients_data FROM clients
      WHERE salon_id = $1 AND phone LIKE '%' || $2
      LIMIT 1`,
    [salonId, phone]);
  if (!row) return null;
  // name — ФИО целиком («Вихарева Мария Андреевна»), для обращения не годится:
  // инцидент 2026-08-04, Мила написала пациентке «Мария Андреевна, …». В чат
  // уходит только givenName (одно личное имя) либо ничего — см. utils/person-name.
  // Разбор не имеет права уронить ход: без имени бот просто спросит, как обращаться.
  let givenName = null;
  try {
    givenName = resolveGivenName(nameSource(row), { dictionary: await salonNames.load(salonId) });
  } catch (e) { givenName = null; }
  return { id: row.id, name: row.name, givenName, phone: row.phone };
}

// Раздельные поля YClients точнее склеенного ФИО (в них видно, где имя, а где
// фамилия), но заполнены меньше чем у 11% карточек — иначе разбираем строку.
function nameSource(row) {
  const yc = row.yclients_data && typeof row.yclients_data === 'object' ? row.yclients_data : {};
  if (yc.name || yc.surname || yc.patronymic || yc.display_name) {
    return {
      name: yc.name, surname: yc.surname, patronymic: yc.patronymic,
      display_name: yc.display_name || row.name,
    };
  }
  return row.name;
}

// YClients client_id пациента по номеру. Основной источник — clients.yclients_client_id
// (loyalty-синк); здесь запасной путь по последней синхронизированной записи
// (records.yclients_client_id стабилен для клиента). Нужен для живого запроса записей
// и проверки принадлежности при отмене/переносе. null, если у клиента нет ни одной
// синхронизированной записи.
// ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: только что созданную запись (клиент без прошлой истории
// в records) агент не увидит до ближайшего 3-часового синка → list_client_bookings
// вернёт client_not_found, а cancel/reschedule — fail-closed (эскалация на
// администратора). Приемлемо для whitelist-пилота (клиенты уже с историей).
// TODO(follow-up): при промахе резолвить client_id живьём через YClients
// clients/search по телефону, чтобы покрыть свежесозданные записи.
async function resolveYclientsClientId(salonId, rawPhone) {
  const phone = normalizePhoneKey(String(rawPhone || ''));
  // Та же защита от суффиксного совпадения, что и в resolveClient: fail-closed —
  // по неполному номеру нельзя отменять/переносить чужие записи.
  if (!salonId || !phone || phone.length < 10) return null;
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
