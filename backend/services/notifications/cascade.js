'use strict';
// ============================================================
// Каскад мессенджеров для уведомлений — чистая часть, без БД и сети.
// Порядок задаётся в настройках салона; флаг «сначала мессенджер последней
// переписки» переставляет его первым. Каждый шаг — один мессенджер; адресат
// шага строит recipientFor (null = в этом мессенджере писать некому, шаг
// пропускается). Решение «идти ли к следующему шагу» принимает воркер по
// transport.isDefiniteRejection — здесь только порядок и адресаты.
// ============================================================
const { normalizePhoneKey } = require('../agent-gate');

const CASCADE_CHANNELS = ['tdlib', 'whatsapp', 'max'];

function buildCascade(order, { preferLast = false, lastChannel = null } = {}) {
  const base = [];
  for (const ch of Array.isArray(order) ? order : []) {
    if (CASCADE_CHANNELS.includes(ch) && !base.includes(ch)) base.push(ch);
  }
  if (preferLast && lastChannel && base.includes(lastChannel)) {
    return [lastChannel, ...base.filter((c) => c !== lastChannel)];
  }
  return base;
}

/**
 * Телефон клиента — только канон 7XXXXXXXXXX, иначе null. Тот же разбор, что у
 * events.canonPhone (общий normalizePhoneKey: РФ 8→7, 10-значное ядро → 7…):
 * два правила канонизации в одном модуле разъехались бы.
 */
function canonPhone(phone) {
  const p = normalizePhoneKey(phone);
  return /^7\d{10}$/.test(p) ? p : null;
}

/**
 * id личного чата собеседника из переписки — только ЧИСЛО (после trim), иначе null
 * («id неизвестен»). Отрицательный id шлюз считает группой, и карточка записи
 * пациента ушла бы в группу; «g:…» — ключ диалога админки; «e2e-chat» и прочее
 * нечисловое — мусор. Это последний рубеж: lastConversation группы уже отсекает,
 * но адресат строится из любого объекта chats, и доверять его содержимому нельзя.
 */
function peerId(chats, channel) {
  const raw = chats && chats[channel] != null ? String(chats[channel]).trim() : '';
  return /^\d+$/.test(raw) ? raw : null;
}

/**
 * chats — { tdlib?: '<id собеседника>', max?: '<id собеседника>' } из переписки
 * (rules.lastConversation). Негодный (нечисловой) id считается неизвестным: для
 * Telegram откат на номер, для MAX — без max_user_id.
 */
function recipientFor(channel, phone, chats = {}) {
  const p = canonPhone(phone);
  const chat = peerId(chats, channel);
  if (channel === 'whatsapp') return p ? { dispatchRouting: ['whatsapp'], phone: p } : null;
  if (channel === 'tdlib') {
    // Известный id чата доходит и до собеседника со скрытым номером; по номеру
    // TDLib находит только тех, кто номер не прячет (иначе шлюз отвечает 422).
    if (chat) return { dispatchRouting: ['tdlib'], tdlib_user_id: chat };
    return p ? { dispatchRouting: ['tdlib'], phone: p } : null;
  }
  if (channel === 'max') {
    if (!p && !chat) return null;
    const out = { dispatchRouting: ['max'] };
    if (p) out.phone = p;
    if (chat) out.max_user_id = chat;   // шлюз сверяет видимый номер контакта с номером
    return out;
  }
  return null;
}

module.exports = { buildCascade, recipientFor, canonPhone, CASCADE_CHANNELS };
