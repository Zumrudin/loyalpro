'use strict';
// ============================================================
// Отправка ОДНОМУ получателю разовой рассылки через мессенджеры клиники (спека 2026-11-01 §5.3).
// Один шаг каскада = один мессенджер; какой шаг следующий и что делать с рассылкой, решает воркер
// по виду отказа, поэтому здесь только отправка и честная классификация исхода:
//   • unreachable — сбой соединения ДО отправки запроса (CONNECT_FAIL_CODES): шлюз лежит, рассылку надо
//     ставить на паузу, а не катить всех получателей в другие мессенджеры. Проверяется ПЕРВЫМ: у таких
//     ошибок есть code, и isDefiniteRejection их отказом не считает, но порядок держим явно;
//   • rejected — однозначный отказ (transport.isDefiniteRejection: 4xx, нет аккаунта; плюс локальные —
//     нет адресата, нет/не читается файл картинки): следующий шаг каскада;
//   • ambiguous — таймаут, 5xx, ECONNRESET: сообщение могло уйти, дубль хуже пропуска.
// Функция НИКОГДА не бросает: воркер захватил строку (sending) и после реальной отправки строка не должна
// вернуться в pending (at-most-once, как в notifications/worker.js).
//
// Журнал авторства пишется ДО отправки: эхо шлюза может прийти раньше, чем мы вернёмся из sendMessage, и
// без отметки читается ответом администратора — Мила встаёт на паузу (инцидент 04.08). У автоуведомлений
// (notifications/worker.afterSend) отметка ставится после отправки — здесь сознательно раньше, по спеке.
// ============================================================
const fs = require('fs');
const path = require('path');
const transport = require('../messaging/transport');
const { lastConversation } = require('../notifications/rules');
const { recipientFor } = require('../notifications/cascade');
const { splitCaption } = require('./render');
const pendingReplies = require('../agent/pending-replies');
const authorship = require('../outgoing-authorship');
const { persistWhatsappOutgoing } = require('../chat-persist');
const { createLogger } = require('../../logger');

const log = createLogger('BroadcastSender');
const uploadsDir = path.join(__dirname, '../../../frontend/uploads');
// Тот же набор, что у автоуведомлений, без PDF: картинка рассылки — только изображение (загрузка
// проверяет сигнатуру jpg/png/webp).
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
// Копия правила notifications/worker.js (там константа не экспортируется): ECONNRESET/ETIMEDOUT сюда НЕ
// входят — запрос мог уже уйти.
const CONNECT_FAIL_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const ERR_MAX = 300;
const EMPTY_CONV = Object.freeze({ lastChannel: null, chats: {} });

const errText = (e) => String((e && e.message) || e).slice(0, ERR_MAX);

function classify(e) {
  if (e && CONNECT_FAIL_CODES.has(e.code)) return 'unreachable';
  if (transport.isDefiniteRejection(e)) return 'rejected';
  return 'ambiguous';
}

/** Картинка рассылки: только basename внутри frontend/uploads — imageUrl не уведёт чтение за каталог. */
function imageOf(url) {
  const fileName = path.basename(String(url));
  if (!fileName || fileName === '.' || fileName === '..') return null;
  const ext = path.extname(fileName).toLowerCase();
  return { fileName, abs: path.join(uploadsDir, fileName), mime: MIME[ext] || 'application/octet-stream' };
}

async function conversationOf(salonId, phone) {
  try {
    return (await lastConversation(salonId, phone)) || EMPTY_CONV;
  } catch (e) {
    log.warn(`salon ${salonId}: переписка клиента не прочиталась (${e.message}) — адресат по номеру`);
    return EMPTY_CONV;
  }
}

/** После реальной отправки: Мила должна видеть сообщение в транскрипте. Ничего не бросает. */
async function afterSend(salonId, phone, channel, text, imageUrl, img, delivery) {
  try { pendingReplies.remember(salonId, phone, text); }
  catch (e) { log.error(`pending ${channel}: ${e.message}`); }
  if (channel === 'whatsapp' && delivery) {
    try {
      await persistWhatsappOutgoing(salonId, {
        delivery, phone, chatId: null, text,
        msgType: img ? 'image' : 'text', fileUrl: imageUrl || null, mimeType: img ? img.mime : null,
        authoredBy: 'system',
      });
    } catch (e) { log.error(`persist wa: ${e.message}`); }
  }
}

/**
 * sendToRecipient({ salonId, phone, channel, text, imageUrl })
 *   → { ok:true, delivery_id: string|null, account_id: string|null }
 *   | { ok:false, kind:'rejected'|'unreachable'|'ambiguous', error: string }
 * delivery_id/account_id — для сверки доставки (transport.getDeliveryStatus(..., { accountId })).
 * При картинке с длинным текстом это id КАРТИНКИ (первого сообщения).
 */
async function sendToRecipient(args) {
  try {
    const { salonId, phone, channel, text, imageUrl } = args || {};
    const conv = await conversationOf(salonId, phone);
    const target = recipientFor(channel, phone, conv.chats || {});
    if (!target) return { ok: false, kind: 'rejected', error: 'нет адресата' };

    let img = null;
    let buf = null;
    if (imageUrl) {
      img = imageOf(imageUrl);
      if (!img) return { ok: false, kind: 'rejected', error: 'некорректный путь картинки' };
      // Локальный отказ: до сети дело не дошло. Сырая fs-ошибка несёт code и иначе читалась бы как
      // неоднозначная.
      if (!fs.existsSync(img.abs)) return { ok: false, kind: 'rejected', error: `файл картинки не найден: ${img.fileName}` };
      try { buf = fs.readFileSync(img.abs); }
      catch (e) { return { ok: false, kind: 'rejected', error: errText(`файл картинки не читается: ${img.fileName} (${e.code || e.message})`) }; }
    }

    try { await authorship.remember(salonId, phone, text, 'system'); }
    catch (e) { log.error(`authorship ${channel}: ${e.message}`); }

    const { caption, followText } = splitCaption(text, !!img);
    let delivery;
    try {
      delivery = img
        ? await transport.sendFile(salonId, { ...target, fileName: img.fileName, caption, type: 'image' }, buf, img.mime)
        : await transport.sendMessage(salonId, { ...target, text: followText });
    } catch (e) {
      const kind = classify(e);
      const error = errText(e);
      const line = `salon ${salonId} ${channel}: ${kind} — ${error}`;
      if (kind === 'rejected') log.info(line); else log.warn(line);
      return { ok: false, kind, error };
    }

    // Отправлено. Дальше ничего не меняет исход: второе сообщение и журналы — best-effort.
    if (img && followText) {
      try { await transport.sendMessage(salonId, { ...target, text: followText }); }
      catch (e) { log.warn(`salon ${salonId} ${channel}: картинка ушла, текст вторым сообщением — нет: ${errText(e)}`); }
    }
    await afterSend(salonId, phone, channel, text, imageUrl, img, delivery);

    return {
      ok: true,
      delivery_id: delivery && delivery.id != null ? String(delivery.id) : null,
      account_id: delivery && delivery.accountId != null ? String(delivery.accountId) : null,
    };
  } catch (e) {
    // Сюда попадает только непредвиденное ДО отправки (отправка и всё после неё в своих catch).
    log.error(`sendToRecipient: ${e.message}`);
    return { ok: false, kind: 'ambiguous', error: errText(e) };
  }
}

module.exports = { sendToRecipient, CONNECT_FAIL_CODES };
