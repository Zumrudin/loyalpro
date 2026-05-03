// ============================================================
// OTP Bot Listener — Telegram long-polling for mobile app OTP
// ============================================================
//
// Listens for /start <phone> commands on the @sms_activator_peri_clinic_bot
// bot, validates the phone exists in `clients`, persists the
// (phone ↔ chat_id) link in `mobile_telegram_links`, and immediately
// delivers a still-valid OTP from `mobile_otp_sessions` if one exists.
//
// Subsequent /login requests (see routes/mobile-auth.js) will then push
// codes directly into the chat without the user opening the bot again.
// ============================================================

require('./config'); // ensures dotenv is loaded
const axios = require('axios');
const { db } = require('./db');
const { createLogger } = require('./logger');
const {
  linkPhoneToChat,
  sendMessage,
  sendOtpToChat,
} = require('./services/telegram-otp');

const log = createLogger('OtpBot');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  log.error('TELEGRAM_BOT_TOKEN is not set — exiting');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const POLL_TIMEOUT_S = 25;
const ERROR_BACKOFF_MS = 5000;

let offset = 0;
let stopping = false;

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.length === 11 ? digits : '7' + digits.slice(-10);
}

async function findClientByPhone(phone) {
  return db.oneOrNone(
    'SELECT id, name FROM clients WHERE phone=$1 OR phone LIKE $2 LIMIT 1',
    [phone, '%' + phone.slice(-10)]
  );
}

async function getActiveOtp(phone) {
  return db.oneOrNone(
    'SELECT otp FROM mobile_otp_sessions WHERE phone=$1 AND expires_at > NOW()',
    [phone]
  );
}

async function handleStart(chatId, arg) {
  if (!arg) {
    await sendMessage(
      chatId,
      'Чтобы получить код входа, откройте приложение PERI CLINIC и нажмите «Получить код». Код придёт сюда автоматически.'
    );
    return;
  }

  const phone = normalizePhone(arg);
  if (!phone) {
    await sendMessage(chatId, 'Неверный формат телефона.');
    return;
  }

  const client = await findClientByPhone(phone);
  if (!client) {
    await sendMessage(
      chatId,
      'Клиент с таким телефоном не найден в системе клиники. Обратитесь к администратору.'
    );
    return;
  }

  await linkPhoneToChat(phone, chatId);
  log.info(`Linked phone=${phone} → chat_id=${chatId} (client_id=${client.id})`);

  const active = await getActiveOtp(phone);
  if (active) {
    await sendOtpToChat(chatId, active.otp);
    log.info(`Delivered active OTP to chat_id=${chatId} for phone=${phone}`);
  } else {
    await sendMessage(
      chatId,
      'Привязка выполнена. Запросите код в приложении PERI CLINIC — он придёт сюда автоматически.'
    );
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text.startsWith('/start')) {
    const arg = text.slice('/start'.length).trim();
    return handleStart(chatId, arg);
  }

  // Any other input — gentle hint
  await sendMessage(
    chatId,
    'Я отправляю коды для входа в приложение PERI CLINIC. Откройте приложение и нажмите «Получить код».'
  );
}

async function poll() {
  while (!stopping) {
    try {
      const { data } = await axios.get(`${API}/getUpdates`, {
        params: {
          offset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ['message'],
        },
        timeout: (POLL_TIMEOUT_S + 5) * 1000,
      });

      if (!data.ok) {
        log.error(`Telegram getUpdates error: ${data.description}`);
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (e) {
          log.error(`handleUpdate failed for update_id=${update.update_id}: ${e.message}`);
        }
      }
    } catch (e) {
      if (stopping) break;
      log.error(`Polling loop error: ${e.message}`);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  stopping = true;
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log.info('OTP bot starting long-polling…');
poll().catch((e) => {
  log.error(`Fatal poll() error: ${e.message}`);
  process.exit(1);
});
