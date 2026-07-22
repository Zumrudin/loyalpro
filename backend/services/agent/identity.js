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

module.exports = { resolveClient };
