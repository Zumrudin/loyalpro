const router = require('express').Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool, db } = require('../db');
const { mobileAuth } = require('../middleware/mobile-auth');
const { getBotLink } = require('../services/telegram');
const { tryDeliverOtp } = require('../services/telegram-otp');
const config = require('../config');

const JWT_SECRET = config.JWT_SECRET;
const { createLogger } = require('../logger');
const logger = createLogger('MobileAuth');

// Max failed guesses per issued OTP before it is burned. With a 6-digit code
// (10^6 space) and 5 guesses, brute force is infeasible.
const MAX_OTP_ATTEMPTS = 5;

// Throttle OTP issuance — stops Telegram/SMS spam and code-reset flooding.
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов кода. Повторите через 15 минут.' },
});

// Throttle verification attempts as a second layer on top of the per-OTP counter.
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Повторите через 15 минут.' },
});

// Login by phone - send OTP
router.post('/login', otpRequestLimiter, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Укажите номер телефона' });
    }

    // Normalize phone (remove all non-digits, ensure it starts with 7 or 8)
    const cleanPhone = String(phone).replace(/\D/g, '');
    const normalizedPhone = cleanPhone.length === 11 ? cleanPhone : '7' + cleanPhone.slice(-10);

    // Check if client exists in database by phone
    let client = await db.one(
      'SELECT id, yclients_client_id, phone, name FROM clients WHERE phone=$1 OR phone LIKE $2 LIMIT 1',
      [normalizedPhone, '%' + cleanPhone.slice(-10)]
    );

    if (!client) {
      // Client doesn't exist - create placeholder or return error
      // For now, we'll return error - client must be registered in Yclients first
      return res.status(404).json({
        error: 'Клиент не найден в системе. Обратитесь к администратору клиники.'
      });
    }

    // Generate 6-digit OTP using cryptographically secure RNG.
    // Never log the code itself — OTP is the sole auth factor for mobile clients.
    const otp = crypto.randomInt(100000, 1000000).toString();
    logger.info(`OTP issued for phone=${normalizedPhone}`);

    // Store OTP with 5 min TTL. Reset the attempt counter on every reissue.
    await db.query(
      `INSERT INTO mobile_otp_sessions (phone, otp, attempts, created_at, expires_at)
       VALUES ($1, $2, 0, NOW(), NOW() + INTERVAL '5 minutes')
       ON CONFLICT (phone) DO UPDATE SET otp=$2, attempts=0, created_at=NOW(), expires_at=NOW() + INTERVAL '5 minutes'`,
      [normalizedPhone, otp]
    );

    // Try to push the OTP straight into the user's Telegram chat
    // if they've previously linked their phone via the bot (/start <phone>).
    const delivery = await tryDeliverOtp(normalizedPhone, otp);
    if (delivery.delivered) {
      logger.info(`OTP pushed directly to chat_id=${delivery.chatId} for ${normalizedPhone}`);
    }

    // Always return the bot deep-link as a fallback (first-time users
    // and users who deleted the chat still need a way to link).
    const telegramLink = getBotLink(normalizedPhone);

    res.json({
      success: true,
      message: delivery.delivered
        ? 'Код отправлен в Telegram'
        : 'Откройте Telegram бота для получения кода',
      phone: normalizedPhone,
      telegramLink,
      delivered: delivery.delivered,
    });

  } catch (e) {
    logger.error('Login error', e.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Verify OTP and create session
router.post('/verify-otp', otpVerifyLimiter, async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Укажите номер телефона и код' });
    }

    // Normalize phone
    const cleanPhone = String(phone).replace(/\D/g, '');
    const normalizedPhone = cleanPhone.length === 11 ? cleanPhone : '7' + cleanPhone.slice(-10);

    // Fetch the active OTP for this phone (do NOT match the code in SQL — we
    // need the row to enforce a per-code attempt cap regardless of the guess).
    const otpRecord = await db.oneOrNone(
      'SELECT * FROM mobile_otp_sessions WHERE phone=$1 AND expires_at > NOW()',
      [normalizedPhone]
    );

    if (!otpRecord) {
      return res.status(401).json({ error: 'Неверный или истекший код' });
    }

    // Burn the code once too many wrong guesses have been made — forces the
    // client to request a fresh OTP and resets the brute-force search space.
    if (otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
      await db.query('DELETE FROM mobile_otp_sessions WHERE phone=$1', [normalizedPhone]);
      return res.status(429).json({ error: 'Слишком много попыток. Запросите новый код.' });
    }

    if (String(otpRecord.otp) !== String(otp)) {
      await db.query('UPDATE mobile_otp_sessions SET attempts=attempts+1 WHERE phone=$1', [normalizedPhone]);
      return res.status(401).json({ error: 'Неверный или истекший код' });
    }

    // Get client
    const client = await db.one(
      'SELECT id, yclients_client_id, phone, name, email FROM clients WHERE phone=$1 OR phone LIKE $2 LIMIT 1',
      [normalizedPhone, '%' + cleanPhone.slice(-10)]
    );

    if (!client) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }

    // Create JWT token
    const token = jwt.sign(
      {
        clientId: client.id,
        yclientsClientId: client.yclients_client_id,
        phone: normalizedPhone,
        type: 'client'
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Store session
    await db.query(
      `INSERT INTO mobile_sessions (client_id, token, phone, created_at, expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 days')`,
      [client.id, token, normalizedPhone]
    );

    // Delete used OTP
    await db.query('DELETE FROM mobile_otp_sessions WHERE phone=$1', [normalizedPhone]);

    res.json({
      success: true,
      token,
      user: {
        id: client.id,
        name: client.name,
        phone: normalizedPhone,
        email: client.email
      }
    });

  } catch (e) {
    logger.error('Verify OTP error', e.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Get current user
router.get('/me', mobileAuth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT id, name, phone, email, bonus_balance, yclients_card_balance, loyalty_level FROM clients WHERE id=$1',
      [req.client.clientId]
    );

    if (!client) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }

    res.json({
      success: true,
      user: client
    });

  } catch (e) {
    logger.error('Get me error', e.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Logout
router.post('/logout', mobileAuth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM mobile_sessions WHERE token=$1',
      [req.token]
    );

    res.json({ success: true });

  } catch (e) {
    logger.error('Logout error', e.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
