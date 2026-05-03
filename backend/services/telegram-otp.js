const axios = require('axios');
const { db } = require('../db');
const { createLogger } = require('../logger');

const log = createLogger('TelegramOtp');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

async function sendMessage(chatId, text) {
  if (!API) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const { data } = await axios.post(
    `${API}/sendMessage`,
    { chat_id: chatId, text },
    { timeout: 10000 }
  );
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

async function getChatIdByPhone(phone) {
  const row = await db.oneOrNone(
    'SELECT chat_id FROM mobile_telegram_links WHERE phone=$1',
    [phone]
  );
  return row ? row.chat_id : null;
}

async function linkPhoneToChat(phone, chatId) {
  await db.query(
    `INSERT INTO mobile_telegram_links (phone, chat_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (phone) DO UPDATE SET chat_id=$2, updated_at=NOW()`,
    [phone, chatId]
  );
}

async function sendOtpToChat(chatId, otp) {
  return sendMessage(
    chatId,
    `Ваш код для входа в PERI CLINIC: ${otp}\n\n(действует 5 минут)`
  );
}

async function tryDeliverOtp(phone, otp) {
  const chatId = await getChatIdByPhone(phone);
  if (!chatId) return { delivered: false, reason: 'no_link' };
  try {
    await sendOtpToChat(chatId, otp);
    return { delivered: true, chatId };
  } catch (e) {
    log.warn(`Failed to deliver OTP to chat_id=${chatId}: ${e.message}`);
    return { delivered: false, reason: e.message, chatId };
  }
}

module.exports = {
  sendMessage,
  sendOtpToChat,
  getChatIdByPhone,
  linkPhoneToChat,
  tryDeliverOtp,
};
