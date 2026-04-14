const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = 'sms_activator_peri_clinic_bot';

let bot = null;

function initBot(db) {
  if (!BOT_TOKEN) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN не установлен');
    return;
  }

  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const phone = match[1].replace(/\D/g, '');
    const normalizedPhone = phone.length === 10 ? '7' + phone : phone;

    try {
      const record = await db.one(
        'SELECT otp FROM mobile_otp_sessions WHERE phone=$1 AND expires_at > NOW()',
        [normalizedPhone]
      );

      if (!record) {
        await bot.sendMessage(chatId, 'Код не найден или истёк. Запросите новый код в приложении.');
        return;
      }

      await bot.sendMessage(chatId, `Ваш код подтверждения: *${record.otp}*\n\nДействителен 5 минут. Никому не сообщайте код.`, {
        parse_mode: 'Markdown'
      });

    } catch (e) {
      console.error('[Telegram] Ошибка:', e.message);
      await bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте позже.');
    }
  });

  bot.onText(/\/start$/, async (msg) => {
    await bot.sendMessage(msg.chat.id, 'Для получения кода откройте приложение и запросите код входа.');
  });

  bot.on('polling_error', (err) => {
    console.error('[Telegram] Polling error:', err.message);
  });

  console.log('[Telegram] Бот запущен:', BOT_USERNAME);
}

function getBotLink(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return `https://t.me/${BOT_USERNAME}?start=${digits}`;
}

module.exports = { initBot, getBotLink };
