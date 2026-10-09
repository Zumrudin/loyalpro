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
  return db.any(`SELECT * FROM messenger_accounts WHERE provider='gateway' AND channel='tdlib' AND status IN ('active','pending') ORDER BY id`);
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

module.exports = { get, listActive, byToken, setAuth, contactUserId, rememberContact };
