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

/**
 * Отправить файл: POST /api/v1/send_file — параметры в query, сам файл
 * multipart-полем `file`. Каналы файлов: whatsapp | tdlib | max.
 * Фото <10 МБ уходит нативной картинкой (type=image), иначе документом;
 * `caption` — подпись (whatsapp). Node 20: FormData/Blob глобальные,
 * axios 1.x их понимает без пакета form-data.
 * @returns объект `delivery` из ответа.
 */
async function sendFile(instanceToken, { fileName, caption, type, phone, dispatchRouting, ...extra }, buffer, mimeType) {
  const query = qs({
    file_name: fileName,
    caption,
    type,
    phone,
    dispatch_routing: dispatchRouting,
    ...extra,
  });
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName);
  const { data } = await axios.post(`${apiBase}/api/v1/send_file?${query}`, form, {
    headers: { Authorization: `Bearer ${instanceToken}` },
    timeout: 120000,
    maxBodyLength: Infinity,
  });
  if (data.meta?.status !== 'success') {
    throw new Error(data.meta?.message || `Chatpush send_file failed (code ${data.meta?.code})`);
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
      // Идентификатор ДОСТАВКИ Chatpush: есть у всего, что ушло через API
      // (наша отправка, автоуведомление YClients), и его нет у текста, который
      // человек набрал руками в приложении. См. parseMessageEvent.deliveryId.
      // В WhatsApp-форме лежит на уровне payload, рядом с new_message.
      deliveryId: str(p.delivery_id ?? nm.delivery_id),
      chatId: str(nm.chat_id),
      // 'person' | 'group' | … — явный признак группы (шлют tdlib и MAX; WhatsApp
      // не шлёт, там группу видно по jid «@g.us»). Нужен агенту: в группе он молчит.
      chatType: str(nm.chat_type),
      // номер партнёра по чату (клиента). У ИСХОДЯЩЕГО отправитель — МЫ, поэтому
      // фолбэк на sender_phone_number там запрещён (см. плоскую ветку ниже).
      phone: str(nm.chat_phone || (nm.direction === 'outgoing' ? null : nm.sender_phone_number)),
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
    deliveryId: str(p.delivery_id),
    chatId: str(p.chat_id),
    chatType: str(p.chat_type),
    // номер КЛИЕНТА (не салона): для outgoing клиент — получатель, для incoming — отправитель.
    // Так вся переписка с одним клиентом группируется по одному phone независимо от направления.
    // У ИСХОДЯЩЕГО фолбэка на sender_phone_number быть НЕ МОЖЕТ: отправитель — это
    // всегда наш инстанс, и его номер клиентом не бывает. Инцидент 2026-08-10
    // (диалог 298342940, tdlib): у собеседника в Telegram номер скрыт
    // (recipient_phone_number:null) → в phone ложился номер клиники 79250177778,
    // ключ диалога у ответов администратора расходился с ключом входящих
    // (phone против chat_id), и «Чат» показывал переписку без ответов админа,
    // а сами ответы 31 разного чата сваливались в один фантомный диалог.
    // Побочно тем же промахивалась пауза «ответил оператор» (pauseKey в
    // routes/chatpush-webhook.js) — Мила оставалась активной в диалоге,
    // который уже вёл человек.
    phone: str(dir === 'outgoing'
      ? p.recipient_phone_number
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
    chatType: e.chatType,                                    // person | group | … | null
    phone: e.phone,
    senderName: e.senderName,
    // Ушло через API Chatpush (наша отправка ИЛИ чужая интеграция — например
    // автоуведомления YClients) ⟺ deliveryId не null. Живой набор в приложении
    // мессенджера доставки не создаёт — поле приходит пустым. По этому признаку
    // вебхук решает, ставить ли паузу «отвечает оператор» (инцидент 2026-08-04:
    // «Вы записаны на прием…» от YClients глушило Милу после её же записи).
    // Запасной путь для WhatsApp: там id эха API-отправки несёт `_d<id>THISISBOT`.
    deliveryId: e.deliveryId || deliveryIdFromWhatsappEchoId(str(m.id)),
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

// ── Персист исходящих WhatsApp (обход отсутствующего эха) ───────────
//
// С ~2026-07-26 Chatpush перестал слать эхо наших API-отправок в WhatsApp
// как whatsapp_incoming_msg (приходит только message_status без текста) —
// проверено на живых данных. Поэтому исходящие в WhatsApp сохраняем СРАЗУ при
// отправке (routes/chat.js), а не ждём эхо, иначе сообщение живёт лишь
// оптимистичным пузырём и исчезает после перезагрузки страницы.
//
// Чтобы не задвоить, если эхо когда-нибудь вернётся: id такого эха содержит
// `_d<delivery_id>THISISBOT` — извлекаем delivery_id и по нему находим строку,
// уже сохранённую при отправке (её external_message_id = ownOutgoingExternalId).

/** delivery_id из id WhatsApp-эха нашей API-отправки (`_d<id>THISISBOT`) или null. */
function deliveryIdFromWhatsappEchoId(id) {
  if (typeof id !== 'string') return null;
  const m = id.match(/_d(\d+)THISISBOT/);
  return m ? m[1] : null;
}

/** external_message_id для строки, сохранённой при отправке (по delivery_id). */
function ownOutgoingExternalId(deliveryId) {
  return `api:${deliveryId}`;
}

module.exports = {
  sendMessage,
  sendFile,
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
  deliveryIdFromWhatsappEchoId,
  ownOutgoingExternalId,
  qs,
};
