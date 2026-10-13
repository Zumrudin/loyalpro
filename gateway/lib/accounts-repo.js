'use strict';
// ============================================================
// Accounts repo — строки messenger_accounts (provider='gateway') и кэш
// «номер → user_id» (gateway_contacts). Таблицы общие с бэкендом, создаёт их
// backend/migrations.js; шлюз только читает/обновляет СВОИ строки.
// Телефоны в gateway_contacts — канонические (7XXXXXXXXXX, mapper.normalizePhone),
// нормализацию делает вызывающий; иначе кэш дублировал бы записи.
// ============================================================
const { db } = require('../db');

async function get(id) {
  return db.oneOrNone(`SELECT * FROM messenger_accounts WHERE id=$1 AND provider='gateway'`, [id]);
}

// 'pending' — аккаунт заведён из админки, но канал на него ещё не переключён
// (переключается бэкендом по auth_state='ready'): клиент поднимать надо, иначе
// авторизацию нечем вести. Отправки идут только через 'active' (byToken).
async function listActive() {
  return db.any(`SELECT * FROM messenger_accounts WHERE provider='gateway' AND channel IN ('tdlib','whatsapp','max') AND status IN ('active','pending') ORDER BY id`);
}

async function byToken(token) {
  return db.oneOrNone(`SELECT * FROM messenger_accounts WHERE provider='gateway' AND token=$1 AND status='active'`, [token]);
}

async function setAuth(id, authState, { error = null, phone, displayName } = {}) {
  await db.query(
    `UPDATE messenger_accounts
        SET auth_state=$2, auth_error=$3,
            phone=COALESCE($4, phone), display_name=COALESCE($5, display_name), updated_at=NOW()
      WHERE id=$1 AND provider='gateway'`,
    [id, authState, error, phone || null, displayName || null]);
}

async function contactUserId(accountId, phone) {
  const r = await db.oneOrNone(`SELECT user_id FROM gateway_contacts WHERE account_id=$1 AND phone=$2`, [accountId, phone]);
  return r ? Number(r.user_id) : null;
}

async function rememberContact(accountId, phone, userId) {
  await db.query(
    `INSERT INTO gateway_contacts (account_id, phone, user_id) VALUES ($1,$2,$3)
     ON CONFLICT (account_id, phone) DO UPDATE SET user_id=EXCLUDED.user_id`,
    [accountId, phone, userId]);
}

// Пачка пар «номер → user_id» одним запросом: контакты WhatsApp при первичной
// синхронизации приходят сотнями. Дубль номера в одном INSERT … ON CONFLICT DO
// UPDATE Postgres отвергает («cannot affect row a second time») — схлопываем,
// побеждает последняя пара.
const CONTACTS_BATCH = 500;
async function rememberContacts(accountId, pairs) {
  const byPhone = new Map();
  for (const p of pairs || []) if (p && p.phone && p.userId != null && p.userId !== '') byPhone.set(p.phone, p.userId);
  const list = [...byPhone];
  for (let i = 0; i < list.length; i += CONTACTS_BATCH) {
    const chunk = list.slice(i, i + CONTACTS_BATCH);
    const params = [accountId];
    const values = chunk.map(([phone, userId]) => { params.push(phone, userId); return `($1,$${params.length - 1},$${params.length})`; });
    await db.query(
      `INSERT INTO gateway_contacts (account_id, phone, user_id) VALUES ${values.join(',')}
       ON CONFLICT (account_id, phone) DO UPDATE SET user_id=EXCLUDED.user_id`,
      params);
  }
}

// WhatsApp: LID → телефон (user_id хранит числовую часть LID, см. миграцию).
async function phoneByLid(accountId, lid) {
  if (!lid) return null;
  const r = await db.oneOrNone(`SELECT phone FROM gateway_contacts WHERE account_id=$1 AND user_id=$2`, [accountId, lid]);
  return r ? r.phone : null;
}

// MAX: user_id = id пользователя MAX (тот же столбец, что LID у WhatsApp).
const phoneByUserId = phoneByLid;

module.exports = { get, listActive, byToken, setAuth, contactUserId, rememberContact, rememberContacts, phoneByLid, phoneByUserId, CONTACTS_BATCH };
