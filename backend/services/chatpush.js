// ============================================================
// Chatpush API Service
// ------------------------------------------------------------
// Мессенджер-платформа (WhatsApp / номерной Telegram (tdlib) / Telegram Bot /
// MAX / MAX Bot / ВК-ОК (notify) / Avito / SMS). Используется для ДВУСТОРОННЕГО
// диалога: приём входящих через webhooks + отправка ответов.
//
// Две авторизации (НЕ путать):
//   • apiKey        — девелоперский мастер-токен, header `Authorization: <api_key>`.
//                     Управление инстансами и webhooks (developer/v1/*).
//   • instanceToken — Bearer token конкретного инстанса/клиента,
//                     header `Authorization: Bearer <token>`. Отправка/приём.
//
// Док: https://dev.docs2.chatpush.ru/ (dev), https://docs2.chatpush.ru/ (клиентский).
// ============================================================
const axios = require('axios');
const config = require('../config');
const { createLogger } = require('../logger');
const logger = createLogger('Chatpush');

const { apiBase, apiKey, instanceToken } = config.CHATPUSH;

/**
 * Собрать query-string. Массивы кодируются повторяющимся ключом `k[]=v` —
 * именно этого ждёт Chatpush для `types[]` / `dispatch_routing[]` / `phones_numbers[]`
 * (в curl-примерах доки для этого стоит флаг `-g`, отключающий globbing скобок).
 */
function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach(item => sp.append(`${k}[]`, item));
    else sp.append(k, v);
  }
  return sp.toString();
}

// ── Отправка сообщений (Bearer token инстанса) ─────────────────────

/**
 * Отправить одно сообщение. Каналы и порядок — в `dispatchRouting`
 * (whatsapp | tdlib | telegram | notify | max | max_bot). Прочие поля доки
 * (sender_name, scheduled_at, external_id, avito_chat_id, …) — через `extra`.
 * @returns объект `delivery` из ответа.
 */
async function sendMessage(instanceToken, { text, phone, dispatchRouting, replyToMessageId, ...extra }) {
  const query = qs({
    text,
    phone,
    dispatch_routing: dispatchRouting,
    reply_to_message_id: replyToMessageId,
    ...extra,
  });
  const { data } = await axios.post(`${apiBase}/api/v1/delivery?${query}`, null, {
    headers: { Authorization: `Bearer ${instanceToken}` },
    timeout: 30000,
  });
  if (data.meta?.status !== 'success') {
    throw new Error(data.meta?.message || `Chatpush delivery failed (code ${data.meta?.code})`);
  }
  return data.delivery;
}

/** Статус ранее отправленного сообщения. */
async function getDeliveryStatus(instanceToken, id) {
  const { data } = await axios.get(`${apiBase}/api/v1/delivery/${id}`, {
    headers: { Authorization: `Bearer ${instanceToken}` },
    timeout: 15000,
  });
  return data.delivery;
}

// ── Управление webhooks (Bearer token инстанса) ────────────────────
//
// Для ОДНОГО аккаунта девелоперский api_key НЕ нужен (подтверждено поддержкой):
// webhooks регистрируются под Bearer-токеном инстанса на КЛИЕНТСКОМ эндпоинте
//   POST/GET/PUT/DELETE  /api/v1/webhooks[/:id]
// (api_key + /developer/v1/webhooks нужен лишь при управлении НЕСКОЛЬКИМИ
// аккаунтами из одного мастер-токена).
//
// Параметры create/update — в query-string (доки: `.../webhooks[/:id]?url=<URL>&types[]=<event>`).
// События: whatsapp_incoming_msg, tdlib_incoming_msg, telegram_bot_incoming_msg,
// max_incoming_msg, max_bot_incoming_msg, whatsapp_status_msg,
// whatsapp_log_in, whatsapp_log_out, whatsapp_call.

/** Bearer-заголовок инстанса (по умолчанию — токен из config). */
function whHeaders(token) {
  return { Authorization: `Bearer ${token || instanceToken}` };
}

/** Зарегистрировать webhook. @returns объект `webhook` {id, url, types}. */
async function createWebhook(url, types, token) {
  const { data } = await axios.post(`${apiBase}/api/v1/webhooks?${qs({ url, types })}`, null, {
    headers: whHeaders(token),
    timeout: 15000,
  });
  return data.webhook;
}

/** Список всех webhooks аккаунта. */
async function listWebhooks(token) {
  const { data } = await axios.get(`${apiBase}/api/v1/webhooks`, {
    headers: whHeaders(token),
    timeout: 15000,
  });
  return data.webhooks || [];
}

/** Одна запись по id. */
async function getWebhook(id, token) {
  const { data } = await axios.get(`${apiBase}/api/v1/webhooks/${id}`, {
    headers: whHeaders(token),
    timeout: 15000,
  });
  return data.webhook;
}

/** Изменить url и/или список событий. */
async function updateWebhook(id, { url, types }, token) {
  const { data } = await axios.put(`${apiBase}/api/v1/webhooks/${id}?${qs({ url, types })}`, null, {
    headers: whHeaders(token),
    timeout: 15000,
  });
  return data.webhook;
}

/** Удалить запись. */
async function deleteWebhook(id, token) {
  const { data } = await axios.delete(`${apiBase}/api/v1/webhooks/${id}`, {
    headers: whHeaders(token),
    timeout: 15000,
  });
  return data.meta;
}

// ── Проверка своего аккаунта (Bearer token инстанса) ───────────────

/**
 * Статусы авторизации мессенджеров, доступные каналы, тариф — для СВОЕГО
 * инстанса (single-account). GET /api/v1/account под Bearer-токеном.
 */
async function getAccount(token) {
  const { data } = await axios.get(`${apiBase}/api/v1/account`, {
    headers: whHeaders(token),
    timeout: 15000,
  });
  return data.account;
}

// ── Developer: инстансы (api_key, только для мультиаккаунта) ────────

/** Инфо об инстансе по customer_id. Требует девелоперский api_key. */
async function getInstanceByCustomerId(customerId) {
  const { data } = await axios.get(`${apiBase}/developer/v1/instances/${customerId}`, {
    headers: { Authorization: apiKey },
    timeout: 15000,
  });
  return data.instance;
}

// ── Разбор входящего webhook ───────────────────────────────────────
//
// Chatpush шлёт события `*_incoming_msg` в ДВУХ формах (проверено на живых данных):
//   • вложенная (в доках, WhatsApp):
//       payload.new_message.{direction, message, chat_id, chat_phone, sender_phone_number, …}
//       payload.instance.{id, customer_id}
//   • плоская (tdlib и др.):
//       payload.{direction, message, chat_id, sender_phone_number, recipient_phone_number,
//                customer_id, sender_name, recipient_username, …}   — без new_message/instance
// `envelope()` приводит обе к единому виду.

const str = v => (v === undefined || v === null ? null : String(v));

function envelope(body) {
  const p = body.payload || {};
  const nm = p.new_message;
  if (nm) {
    return {
      direction: nm.direction || null,
      // WhatsApp (вложенная форма) кладёт customer_id прямо в payload и НЕ шлёт
      // объект instance — проверено на живых данных. Раньше брали только
      // payload.instance.customer_id → для WhatsApp был null → сообщение
      // сохранялось без salon_id и не попадало в чат.
      customerId: p.instance?.customer_id ?? p.customer_id ?? null,
      instanceId: p.instance?.id ?? p.instance_id ?? null,
      m: nm.message || {},
      chatId: str(nm.chat_id),
      // номер партнёра по чату (клиента)
      phone: str(nm.chat_phone || nm.sender_phone_number),
      senderName: nm.sender_name || nm.pushname || null,
      // timestamp может лежать в message ИЛИ на уровне события — берём любой.
      ts: nm.message?.timestamp ?? nm.timestamp ?? p.timestamp ?? null,
    };
  }
  const dir = p.direction || null;
  return {
    direction: dir,
    customerId: p.customer_id ?? null,
    instanceId: p.instance_id ?? null,
    m: p.message || {},
    chatId: str(p.chat_id),
    // номер КЛИЕНТА (не салона): для outgoing клиент — получатель, для incoming — отправитель.
    // Так вся переписка с одним клиентом группируется по одному phone независимо от направления.
    phone: str(dir === 'outgoing'
      ? (p.recipient_phone_number || p.sender_phone_number)
      : (p.sender_phone_number || p.recipient_phone_number)),
    senderName: p.sender_name || p.recipient_username || null,
    // MAX кладёт timestamp на уровень payload, а не в message — берём любой.
    ts: p.message?.timestamp ?? p.timestamp ?? null,
  };
}

/**
 * Разобрать ЛЮБОЕ событие-сообщение (`*_incoming_msg`) в обе стороны —
 * incoming И outgoing (наши эхо-копии). Для ХРАНЕНИЯ всей переписки (Фаза 1).
 * Возвращает null, если это не сообщение (статусы/звонки/log_in-out).
 * Для триггера авто-ответа используй parseIncomingMessage (только incoming).
 */
function parseMessageEvent(body) {
  if (!body || typeof body.type !== 'string' || !body.type.endsWith('_incoming_msg')) return null;
  const e = envelope(body);
  const m = e.m;
  if (m.id === undefined || m.id === null) return null;      // не сообщение
  return {
    channel: body.type.replace(/_incoming_msg$/, ''),        // whatsapp | tdlib | max | max_bot | telegram_bot
    direction: e.direction,                                  // incoming | outgoing
    customerId: e.customerId,
    instanceId: e.instanceId,
    messageId: str(m.id),
    replyToMessageId: str(m.reply_to_message_id),
    type: m.type,                                            // text | formattedText | document | ...
    text: m.text || m.file_data?.caption || '',
    fileUrl: m.file_data?.download_url || null,              // Chatpush сам заливает медиа и даёт ссылку
    mimeType: m.file_data?.mime_type || null,
    timestamp: m.timestamp || e.ts || null,
    chatId: e.chatId,
    phone: e.phone,
    senderName: e.senderName,
  };
}

/**
 * Привести событие `*_incoming_msg` к плоской форме — ИЛИ вернуть null, если это
 * не ВХОДЯЩЕЕ клиентское сообщение, на которое надо реагировать.
 *
 * ВАЖНО: события `*_incoming_msg` содержат и исходящие (`direction: "outgoing"`) —
 * это копии наших же отправок; их нужно игнорировать, иначе агент ответит сам себе.
 */
function parseIncomingMessage(body) {
  const msg = parseMessageEvent(body);
  if (!msg || msg.direction !== 'incoming') return null;
  return { ...msg, raw: body };
}

/**
 * Канал входящего → значение `dispatch_routing` для ответа.
 * `telegram_bot` в событиях соответствует routing-каналу `telegram`.
 */
function replyRoutingFor(channel) {
  return channel === 'telegram_bot' ? 'telegram' : channel;
}

module.exports = {
  sendMessage,
  getDeliveryStatus,
  createWebhook,
  listWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  getAccount,
  getInstanceByCustomerId,
  parseIncomingMessage,
  parseMessageEvent,
  replyRoutingFor,
  qs,
};
