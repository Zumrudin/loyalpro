const config = require('./config');
const axios = require('axios');
const { createLogger } = require('./logger');
const {
  normalizePhone,
  configuredSalonId,
  findClientByPhone,
  issueOtp,
} = require('./services/mobile-otp');
const {
  linkVerifiedContact,
  sendMessage,
  sendOtpToChat,
} = require('./services/telegram-otp');

const log = createLogger('OtpBot');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = TOKEN ? `${config.TELEGRAM_API_BASE}/bot${TOKEN}` : null;
const POLL_TIMEOUT_S = 25;
const ERROR_BACKOFF_MS = 5000;

let offset = 0;
let stopping = false;

function contactKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: 'Подтвердить мой номер', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

function isPrivateMessage(msg) {
  return msg.chat?.type === 'private' && msg.from && !msg.from.is_bot &&
    String(msg.chat.id) === String(msg.from.id) && !msg.sender_chat;
}

async function requestContact(chatId) {
  await sendMessage(
    chatId,
    'Подтвердите собственный номер кнопкой ниже. Номер из команды или чужой контакт не принимается.',
    contactKeyboard()
  );
}

async function handleStart(msg) {
  if (!isPrivateMessage(msg)) return;
  await requestContact(msg.chat.id);
}

async function handleContact(msg) {
  if (!isPrivateMessage(msg) || msg.forward_date || msg.forward_origin) return;
  const contact = msg.contact;
  if (!contact || String(contact.user_id) !== String(msg.from.id)) return;

  const phone = normalizePhone(contact.phone_number);
  if (!phone) {
    await sendMessage(msg.chat.id, 'Не удалось подтвердить формат номера. Обратитесь к администратору клиники.');
    return;
  }

  const salonId = configuredSalonId();
  const match = await findClientByPhone(phone, salonId);
  if (match.status !== 'ok') {
    await sendMessage(msg.chat.id, 'Номер не удалось привязать. Обратитесь к администратору клиники.');
    return;
  }

  const link = await linkVerifiedContact({
    salonId,
    clientId: match.client.id,
    phone,
    chatId: msg.chat.id,
    telegramUserId: msg.from.id,
  });
  if (link.status === 'unchanged') {
    await sendMessage(msg.chat.id, 'Номер уже подтверждён. Запросите новый код в приложении PERI CLINIC.');
    return;
  }

  const issued = await issueOtp({ phone, salonId });
  if (issued.issued) {
    await sendOtpToChat(msg.chat.id, issued.otp);
    return;
  }
  await sendMessage(
    msg.chat.id,
    issued.reason === 'rate_limited'
      ? 'Слишком много запросов кода. Повторите позже.'
      : 'Код не удалось выпустить. Обратитесь к администратору клиники.'
  );
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !isPrivateMessage(msg)) return;
  if (msg.contact) return handleContact(msg);
  const text = (msg.text || '').trim();
  if (text === '/start' || text.startsWith('/start ')) return handleStart(msg);
  await sendMessage(
    msg.chat.id,
    'Откройте приложение PERI CLINIC и нажмите «Получить код».',
    contactKeyboard()
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function poll() {
  while (!stopping) {
    try {
      const { data } = await axios.get(`${API}/getUpdates`, {
        params: { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
        timeout: (POLL_TIMEOUT_S + 5) * 1000,
      });
      if (!data.ok) {
        log.error('Telegram getUpdates rejected');
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (e) {
          log.error(`handleUpdate failed for update_id=${update.update_id}`);
        }
      }
    } catch (e) {
      if (stopping) break;
      log.error('Telegram polling loop failed');
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  stopping = true;
  setTimeout(() => process.exit(0), 1000);
}

function start() {
  if (!TOKEN) {
    log.error('TELEGRAM_BOT_TOKEN is not set — exiting');
    process.exitCode = 1;
    return;
  }
  try {
    configuredSalonId();
  } catch {
    log.error('Mobile OTP configuration is missing or invalid — exiting');
    process.exitCode = 1;
    return;
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  log.info('OTP bot starting long-polling…');
  poll().catch(() => {
    log.error('Fatal poll() error');
    process.exitCode = 1;
  });
}

if (require.main === module) start();

module.exports = { handleUpdate, handleStart, handleContact, requestContact, start };
