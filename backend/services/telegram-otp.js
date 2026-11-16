const axios = require('axios');
const config = require('../config');
const { db, withTransaction } = require('../db');
const { createLogger } = require('../logger');
const { invalidateOtp } = require('./mobile-otp');

const log = createLogger('TelegramOtp');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = TOKEN ? `${config.TELEGRAM_API_BASE}/bot${TOKEN}` : null;

async function sendMessage(chatId, text, options = {}) {
  if (!API) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const { data } = await axios.post(
    `${API}/sendMessage`,
    { chat_id: chatId, text, ...options },
    { timeout: 10000 }
  );
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

async function getChatIdByPhone(phone, salonId) {
  const row = await db.oneOrNone(
    `SELECT chat_id FROM mobile_telegram_links
     WHERE phone=$1 AND salon_id=$2 AND telegram_user_id IS NOT NULL AND verified_at IS NOT NULL`,
    [phone, salonId]
  );
  return row ? row.chat_id : null;
}

async function linkVerifiedContact({ salonId, clientId, phone, chatId, telegramUserId }) {
  return withTransaction(async executor => {
    await executor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${salonId}:${phone}`]);
    const existingResult = await executor.query(
      'SELECT salon_id,client_id,chat_id,telegram_user_id,verified_at FROM mobile_telegram_links WHERE phone=$1',
      [phone]
    );
    const existing = existingResult.rows[0];
    if (existing?.salon_id && Number(existing.salon_id) !== Number(salonId)) {
      const error = new Error('Telegram link tenant conflict');
      error.code = 'MOBILE_LINK_TENANT_CONFLICT';
      throw error;
    }

    const unchanged = existing && existing.verified_at &&
      Number(existing.salon_id) === Number(salonId) &&
      Number(existing.client_id) === Number(clientId) &&
      String(existing.chat_id) === String(chatId) &&
      String(existing.telegram_user_id) === String(telegramUserId);
    if (unchanged) return { status: 'unchanged' };

    const clientIds = [...new Set([existing?.client_id, clientId].filter(Boolean))];
    await executor.query(
      `DELETE FROM mobile_sessions ms USING clients c
       WHERE ms.client_id=c.id AND c.salon_id=$1 AND ms.client_id=ANY($2)`,
      [salonId, clientIds]
    );
    await invalidateOtp(executor, salonId, phone);
    await executor.query(
      `INSERT INTO mobile_telegram_links
         (phone,salon_id,client_id,chat_id,telegram_user_id,verified_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
       ON CONFLICT (phone) DO UPDATE SET
         salon_id=EXCLUDED.salon_id,
         client_id=EXCLUDED.client_id,
         chat_id=EXCLUDED.chat_id,
         telegram_user_id=EXCLUDED.telegram_user_id,
         verified_at=NOW(),
         updated_at=NOW()`,
      [phone, salonId, clientId, chatId, telegramUserId]
    );
    return { status: 'changed' };
  });
}

async function sendOtpToChat(chatId, otp) {
  return sendMessage(
    chatId,
    `Ваш код для входа в PERI CLINIC: ${otp}\n\n(действует 5 минут)`
  );
}

async function tryDeliverOtp(phone, otp, salonId) {
  const chatId = await getChatIdByPhone(phone, salonId);
  if (!chatId) return { delivered: false, reason: 'no_verified_link' };
  try {
    await sendOtpToChat(chatId, otp);
    return { delivered: true };
  } catch (e) {
    log.warn('Failed to deliver OTP');
    return { delivered: false, reason: 'delivery_failed' };
  }
}

module.exports = {
  sendMessage,
  sendOtpToChat,
  getChatIdByPhone,
  linkVerifiedContact,
  tryDeliverOtp,
};
