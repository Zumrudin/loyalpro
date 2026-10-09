'use strict';
// ============================================================
// Messaging accounts — аккаунты мессенджеров по салонам (messenger_accounts).
// ------------------------------------------------------------
// credentialsFor(salonId, channel) → {id, provider, channel, apiBase, token}
//   Куда и с каким токеном слать в ЭТОМ канале ЭТОГО салона. У провайдера
//   'gateway' apiBase всегда из config.MESSAGING_GATEWAY.url (адрес шлюза —
//   настройка процесса, а не салона). Нет строки → legacy-фолбэк на env ТОЛЬКО
//   для салона CHATPUSH_SALON_ID (чужому салону чужой токен не подставляем).
// resolveSalon(provider, externalId) → salon_id | null
//   Обратная задача для вебхука: от кого пришло событие.
// Кэш 60 с по ключу salon:channel — функция зовётся на каждую отправку.
// ============================================================
const { db } = require('../../db');
const config = require('../../config');

const TTL_MS = 60 * 1000;
const cache = new Map();   // `${salonId}:${channel}` → { at, value }

function envCreds(salonId, channel) {
  const cp = config.CHATPUSH || {};
  if (!cp.instanceToken || !cp.salonId || Number(cp.salonId) !== Number(salonId)) return null;
  return { id: 'env', provider: 'chatpush', channel, apiBase: cp.apiBase, token: cp.instanceToken };
}

function rowToCreds(row) {
  const gw = config.MESSAGING_GATEWAY || {};
  return {
    id: row.id,
    provider: row.provider,
    channel: row.channel,
    apiBase: row.provider === 'gateway' ? (gw.url || '') : (row.api_base || (config.CHATPUSH || {}).apiBase || ''),
    token: row.token,
  };
}

async function credentialsFor(salonId, channel) {
  const key = `${salonId}:${channel}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const row = await db.oneOrNone(
      `SELECT id, provider, channel, api_base, token
         FROM messenger_accounts
        WHERE salon_id = $1 AND channel = $2 AND status = 'active'
        LIMIT 1`,
      [salonId, channel]);
    value = row ? rowToCreds(row) : envCreds(salonId, channel);
  } catch (_) {
    value = envCreds(salonId, channel);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function resolveSalon(provider, externalId) {
  if (externalId === undefined || externalId === null) return provider === 'chatpush' ? envSalon(null) : null;
  try {
    const row = await db.oneOrNone(
      `SELECT salon_id FROM messenger_accounts WHERE provider = $1 AND external_id = $2 LIMIT 1`,
      [provider, String(externalId)]);
    if (row) return row.salon_id;
  } catch (_) { /* fallback ниже */ }
  return provider === 'chatpush' ? envSalon(externalId) : null;
}

// Прежний single-tenant мэппинг из env (routes/chatpush-webhook.resolveSalonId).
function envSalon(customerId) {
  const cp = config.CHATPUSH || {};
  if (cp.salonId && (!cp.customerId || Number(cp.customerId) === Number(customerId))) return cp.salonId;
  return null;
}

async function listForSalon(salonId) {
  const rows = await db.any(
    `SELECT id, provider, channel, status, display_name, phone, auth_state, auth_error, created_at
       FROM messenger_accounts WHERE salon_id = $1 ORDER BY channel, id`,
    [salonId]);
  return rows.map(r => ({ ...r, token: undefined }));
}

function invalidate() { cache.clear(); }

module.exports = { credentialsFor, resolveSalon, listForSalon, invalidate, TTL_MS };
