const axios = require('axios');
const { createLogger } = require('../logger');
const logger = createLogger('SMS');

const SMSC_URL = 'https://smsc.ru/sys/send.php';

function normalizePhoneForSms(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '7' + digits;
  if (digits.length === 11 && digits[0] === '8') return '7' + digits.slice(1);
  if (digits.length === 11 && digits[0] === '7') return digits;
  return digits;
}

async function sendOtpSms(phone, otp) {
  const login = process.env.SMSC_LOGIN;
  const password = process.env.SMSC_PASSWORD;

  if (!login || !password) {
    logger.warn(`SMSC_LOGIN/SMSC_PASSWORD не установлены. OTP для ${phone}: ${otp}`);
    return true;
  }

  const normalizedPhone = normalizePhoneForSms(phone);

  try {
    const response = await axios.get(SMSC_URL, {
      params: {
        login,
        psw: password,
        phones: normalizedPhone,
        mes: `Ваш код подтверждения: ${otp}. Действителен 5 минут. Никому не сообщайте код.`,
        fmt: 3, // JSON ответ
        charset: 'utf-8',
      },
      timeout: 10000,
    });

    const data = response.data;

    if (data.error_code) {
      logger.error(`Ошибка SMSC: ${data.error} (код ${data.error_code})`);
      return false;
    }

    logger.info(`OTP отправлена на ${normalizedPhone}, id: ${data.id}, cost: ${data.cost}`);
    return true;
  } catch (e) {
    logger.error(`Ошибка запроса: ${e.message}`);
    return false;
  }
}

async function getBalance() {
  const login = process.env.SMSC_LOGIN;
  const password = process.env.SMSC_PASSWORD;
  if (!login || !password) return null;

  try {
    const response = await axios.get('https://smsc.ru/sys/balance.php', {
      params: { login, psw: password, fmt: 3 },
      timeout: 10000,
    });
    if (response.data.balance !== undefined) return response.data.balance;
    return null;
  } catch (e) {
    logger.error(`Ошибка получения баланса: ${e.message}`);
    return null;
  }
}

module.exports = { sendOtpSms, getBalance, normalizePhoneForSms };
