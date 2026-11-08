'use strict';
// Доставка ссылки на анкету пациенту в мессенджер (спека 2026-10-25 §6.5). Каскад — как у
// автоуведомлений: порядок мессенджеров и «сначала последняя переписка» из notification_settings
// салона, адресаты notifications/cascade.recipientFor. К следующему мессенджеру — только после
// ОДНОЗНАЧНОГО отказа (4xx/нет аккаунта или сбой соединения до запроса); неоднозначный сбой —
// стоп: сообщение могло уйти, а дубль хуже. Своё исходящее помечается ДО отправки (иначе эхо
// читается ответом администратора и ставит Милу на паузу — инцидент 04.08), после — pendingReplies
// (Мила видит, на что отвечает пациент) и запись в «Чат» для WhatsApp (его эхо не приходит).
const transport = require('../messaging/transport');
const notifSettings = require('../notifications/settings');
const { lastConversation } = require('../notifications/rules');
const { buildCascade, recipientFor, canonPhone } = require('../notifications/cascade');
const authorship = require('../outgoing-authorship');
const pendingReplies = require('../agent/pending-replies');
const { persistWhatsappOutgoing } = require('../chat-persist');
const testPhones = require('./test-phones');
const { EdocsError, shortError } = require('./errors');
const { createLogger } = require('../../logger');

const logger = createLogger('EdocsFormDelivery');
const CONNECT_FAIL_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Отправить текст пациенту. @returns {{ channel, deliveryId, steps }}
 * Бросает EdocsError: form_no_phone, test_phone_blocked, form_no_channels, form_delivery_unknown, form_not_delivered.
 */
async function deliverText({ salonId, phone, text }) {
  const p = canonPhone(phone);
  if (!p) throw new EdocsError('form_no_phone', 'У пациента нет номера телефона', 409);
  testPhones.assertAllowed(p);
  const cfg = await notifSettings.getSettings(salonId);
  let conv = { lastChannel: null, chats: {} };
  try { conv = (await lastConversation(salonId, p)) || conv; } catch (e) { logger.warn(`переписка ${salonId}: ${shortError(e)} — каскад по настройкам`); }
  const cascade = buildCascade(cfg.default_channels, { preferLast: cfg.prefer_last_channel !== false, lastChannel: conv.lastChannel });
  if (!cascade.length) throw new EdocsError('form_no_channels', 'В настройках автоуведомлений не выбран ни один мессенджер', 409);
  try { await authorship.remember(salonId, p, text, 'system'); } catch (e) { logger.warn(`authorship ${salonId}: ${shortError(e)}`); }
  const steps = [];
  for (const ch of cascade) {
    const target = recipientFor(ch, p, conv.chats || {});
    if (!target) { steps.push(`${ch}=нет адресата`); continue; }
    let delivery;
    try {
      delivery = await transport.sendMessage(salonId, { ...target, text });
    } catch (e) {
      const definite = transport.isDefiniteRejection(e) || CONNECT_FAIL_CODES.has(e && e.code);
      if (!definite) {
        logger.warn(`анкета ${salonId}: ${ch} — неоднозначный сбой, каскад остановлен: ${shortError(e)}`);
        throw new EdocsError('form_delivery_unknown', `${ch}: мессенджер не подтвердил отправку — сообщение могло уйти, проверьте переписку`, 502, { steps });
      }
      steps.push(`${ch}=отказ`);
      continue;
    }
    try { pendingReplies.remember(salonId, p, text); } catch (e) { logger.warn(`pending ${salonId}: ${shortError(e)}`); }
    if (ch === 'whatsapp' && delivery) {
      try {
        await persistWhatsappOutgoing(salonId, { delivery, phone: p, chatId: null, text, msgType: 'text', authoredBy: 'system' });
      } catch (e) { logger.warn(`persist wa ${salonId}: ${shortError(e)}`); }
    }
    return { channel: ch, deliveryId: delivery && delivery.id != null ? String(delivery.id) : null, steps };
  }
  throw new EdocsError('form_not_delivered', `Ни один мессенджер не принял сообщение (${steps.join(', ') || 'нет адресатов'}) — покажите пациенту QR-код`, 502, { steps });
}

module.exports = { deliverText };
