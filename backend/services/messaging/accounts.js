'use strict';
// ============================================================
// Messaging accounts — аккаунты мессенджеров по салонам (messenger_accounts).
// ------------------------------------------------------------
// credentialsFor(salonId, channel) → {id, provider, channel, apiBase, token}
//   Куда и с каким токеном слать в ЭТОМ канале ЭТОГО салона. У провайдера
//   'gateway' apiBase всегда из config.MESSAGING_GATEWAY.url (адрес шлюза —
//   настройка процесса, а не салона; не задан → null). Фолбэк на env — только
//   у салона без единой строки в таблице и только для CHATPUSH_SALON_ID (чужому
//   салону чужой токен не подставляем). Строки не удаляются, а выключаются
//   (status='disabled'), поэтому выключенный канал = null, а не env.
// resolveSalon(provider, externalId, {strict}) → salon_id | null
//   strict=true: сбой БД ПРОБРАСЫВАЕТСЯ (вебхук шлюза отвечает 503 → повтор).
//   Обратная задача для вебхука: от кого пришло событие.
//   Порядок: активная строка, затем самая свежая.
// credentialsById(salonId, id) → креды конкретной строки салона (ЛЮБОЙ статус, без кэша):
//   проверка судьбы уже отправленного сообщения должна идти через тот аккаунт,
//   которым оно ушло, даже если канал с тех пор переключили или выключили.
// Кэш 60 с по ключу salon:channel — функция зовётся на каждую отправку.
// Сбой БД НЕ кэшируется: отдаём прежнее (протухшее) значение, если оно есть,
// иначе env-фолбэк без записи в кэш — иначе минута «чужих» кредов после сбоя.
// ============================================================
const { db } = require('../../db');
const config = require('../../config');
const { createLogger } = require('../../logger');
const logger = createLogger('MessagingAccounts');

const TTL_MS = 60 * 1000;
const cache = new Map();   // `${salonId}:${channel}` → { at, value }
let gatewayUrlWarned = false;

function envCreds(salonId, channel) {
  const cp = config.CHATPUSH || {};
  if (!cp.instanceToken || !cp.salonId || Number(cp.salonId) !== Number(salonId)) return null;
  return { id: 'env', provider: 'chatpush', channel, apiBase: cp.apiBase, token: cp.instanceToken };
}

function rowToCreds(row, salonId) {
  const gw = config.MESSAGING_GATEWAY || {};
  if (row.provider === 'gateway' && !gw.url) {
    if (!gatewayUrlWarned) {
      gatewayUrlWarned = true;
      logger.warn(`gateway-аккаунт #${row.id} у салона ${salonId}, но MESSAGING_GATEWAY_URL не задан`);
    }
    return null;
  }
  return {
    id: row.id,
    provider: row.provider,
    channel: row.channel,
    apiBase: row.provider === 'gateway' ? gw.url : (row.api_base || (config.CHATPUSH || {}).apiBase || ''),
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
    if (row) {
      value = rowToCreds(row, salonId);
    } else {
      const any = await db.oneOrNone(
        `SELECT 1 FROM messenger_accounts WHERE salon_id = $1 LIMIT 1`, [salonId]);
      value = any ? null : envCreds(salonId, channel);
    }
  } catch (e) {
    logger.warn(`credentialsFor(${salonId},${channel}): ошибка БД — ${e.message}`);
    if (hit) return hit.value;
    return envCreds(salonId, channel);
  }
  if (value) Object.freeze(value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function credentialsById(salonId, id) {
  // env-фолбэк отдаёт accountId 'env' — в integer-колонку его не пускаем.
  if (!Number.isInteger(Number(id))) return null;
  if (salonId === undefined || salonId === null) return null;
  try {
    // Скоуп по salon_id обязателен (правило проекта): чужой accountId не отдаём.
    const row = await db.oneOrNone(
      `SELECT id, provider, channel, api_base, token FROM messenger_accounts WHERE id = $1 AND salon_id = $2`, [id, salonId]);
    if (!row) return null;
    const value = rowToCreds(row, salonId);
    return value ? Object.freeze(value) : null;
  } catch (e) {
    logger.warn(`credentialsById(${id}): ошибка БД — ${e.message}`);
    return null;
  }
}

async function resolveSalon(provider, externalId, opts = {}) {
  if (externalId === undefined || externalId === null) return provider === 'chatpush' ? envSalon(null) : null;
  try {
    const row = await db.oneOrNone(
      `SELECT salon_id FROM messenger_accounts WHERE provider = $1 AND external_id = $2
        ORDER BY (status = 'active') DESC, id DESC LIMIT 1`,
      [provider, String(externalId)]);
    if (row) return row.salon_id;
  } catch (e) {
    // strict: вызывающий умеет повторить (вебхук шлюза отвечает 503) — сбой БД
    // не должен превращаться в «неизвестный аккаунт».
    if (opts.strict) throw e;
    logger.warn(`resolveSalon(${provider},${externalId}): ошибка БД — ${e.message}`);
  }
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

module.exports = { credentialsFor, credentialsById, resolveSalon, listForSalon, invalidate, TTL_MS };
