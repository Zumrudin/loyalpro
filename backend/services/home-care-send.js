'use strict';
// ============================================================
// «Лист назначения» в мессенджер клиента (страница «Домашний уход»).
// Чистые правила выбора мессенджера и адресата — без БД и сети
// (тесты home-care-send.test.js); отправку делает routes/home-care.js.
//
// Правила те же, что у ручной отправки из «Чата» (routes/chat.js):
// - WhatsApp и MAX адресуются по номеру всегда;
// - Telegram (tdlib) — только если клиент сам писал туда (у «холодного»
//   номера без переписки Telegram-аккаунт клиники чат не начнёт);
// - адресат канала — последнее ЛИЧНОЕ входящее этого канала (chat_id),
//   по умолчанию предлагаем мессенджер, куда клиент писал последним.
// ============================================================
const { recipientParams } = require('./chat');
const { normalizePhoneKey } = require('./agent-gate');

const CHANNEL_LABELS = { whatsapp: 'WhatsApp', tdlib: 'Telegram', max: 'MAX' };
const CHANNEL_ORDER = ['whatsapp', 'tdlib', 'max'];

// Имя файла — ASCII: Chatpush требует расширение и плохо переносит кириллицу
// в имени (то же правило, что send-file в «Чате»). Человеческое название
// «Лист назначения» едет подписью к файлу и заголовком PDF.
const FILE_NAME = 'List_naznacheniya.pdf';
const CAPTION = 'Лист назначения';

// Формы номера, в которых он может лежать в chatpush_messages.phone.
function phoneVariants(phone) {
  const key = normalizePhoneKey(phone);
  if (!/^7\d{10}$/.test(key)) return [];
  return [key, '+' + key, '8' + key.slice(1)];
}

// lastIncoming: [{channel, phone, chat_id, msg_ts}] — последнее личное
// входящее по каждому каналу (порядок любой).
function channelOptions(phone, lastIncoming) {
  const key = normalizePhoneKey(phone);
  const hasPhone = /^7\d{10}$/.test(key);
  const byChannel = {};
  for (const r of lastIncoming || []) {
    if (r && CHANNEL_LABELS[r.channel]) byChannel[r.channel] = r;
  }
  const channels = CHANNEL_ORDER.map(ch => {
    const row = byChannel[ch];
    let params = null;
    if (ch === 'tdlib') {
      params = row ? recipientParams('tdlib', { phone: row.phone, chat_id: row.chat_id }) : null;
    } else if (hasPhone) {
      params = recipientParams(ch, { phone: key, chat_id: ch === 'max' && row ? row.chat_id : null });
    } else if (ch === 'max' && row) {
      params = recipientParams('max', { phone: row.phone, chat_id: row.chat_id });
    }
    let reason = null;
    if (!params) reason = ch === 'tdlib' ? 'Клиент не писал в Telegram' : 'У клиента нет номера телефона';
    return { channel: ch, label: CHANNEL_LABELS[ch], available: !!params, reason, params, lastAt: row ? Number(row.msg_ts) || 0 : 0 };
  });
  const avail = channels.filter(c => c.available);
  const recent = [...avail].sort((a, b) => b.lastAt - a.lastAt)[0];
  const def = recent && recent.lastAt ? recent.channel : (avail[0] ? avail[0].channel : null);
  return { dialogKey: hasPhone ? key : null, channels, defaultChannel: def };
}

module.exports = { channelOptions, phoneVariants, FILE_NAME, CAPTION, CHANNEL_LABELS };
