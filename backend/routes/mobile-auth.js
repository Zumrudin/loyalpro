const router = require('express').Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { db, withTransaction } = require('../db');
const { mobileAuth } = require('../middleware/mobile-auth');
const { getBotLink } = require('../services/telegram');
const { tryDeliverOtp } = require('../services/telegram-otp');
const {
  mobileAuthConfig,
  normalizePhone,
  issueOtp,
  consumeOtp,
} = require('../services/mobile-otp');
const config = require('../config');
const { createLogger } = require('../logger');
const logger = createLogger('MobileAuth');

const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов кода. Повторите через 15 минут.' },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Повторите через 15 минут.' },
});

function loginResponse(phone) {
  return {
    success: true,
    message: 'Если номер зарегистрирован, код будет доступен в Telegram.',
    phone,
    telegramLink: getBotLink(),
    delivered: false,
  };
}

router.post('/login', otpRequestLimiter, async (req, res) => {
  let phone;
  try {
    const salonId = mobileAuthConfig().salonId;
    phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'Укажите корректный номер телефона' });

    const issued = await issueOtp({ phone, salonId });
    if (issued.reason === 'rate_limited') {
      return res.status(429).json({ error: 'Слишком много запросов кода. Повторите позже.' });
    }
    if (issued.reason === 'ambiguous') {
      return res.status(409).json({ error: 'Номер требует проверки администратором клиники.' });
    }
    if (issued.issued) await tryDeliverOtp(phone, issued.otp, salonId);
    return res.json(loginResponse(phone));
  } catch (e) {
    if (e.code === 'MOBILE_AUTH_NOT_CONFIGURED') {
      logger.error('Mobile OTP login is not configured');
      return res.status(503).json({ error: 'Вход через мобильное приложение временно недоступен' });
    }
    logger.error('Mobile OTP login failed');
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.post('/verify-otp', otpVerifyLimiter, async (req, res) => {
  try {
    const salonId = mobileAuthConfig().salonId;
    const phone = normalizePhone(req.body?.phone);
    const otp = typeof req.body?.otp === 'string' ? req.body.otp : '';
    if (!phone || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: 'Укажите корректный номер телефона и код' });
    }

    const verified = await withTransaction(async executor => {
      const clientId = await consumeOtp({ phone, otp, salonId }, executor);
      if (!clientId) return null;
      const result = await executor.query(
        `SELECT id,yclients_client_id,phone,name,email FROM clients
         WHERE id=$1 AND salon_id=$2`,
        [clientId, salonId]
      );
      const client = result.rows[0];
      if (!client) return null;
      const token = jwt.sign(
        {
          clientId: client.id,
          yclientsClientId: client.yclients_client_id,
          salonId,
          phone,
          type: 'client',
        },
        config.JWT_SECRET,
        { expiresIn: '30d' }
      );
      await executor.query(
        `INSERT INTO mobile_sessions (client_id,token,phone,salon_id,created_at,expires_at)
         VALUES ($1,$2,$3,$4,NOW(),NOW()+INTERVAL '30 days')`,
        [client.id, token, phone, salonId]
      );
      return { token, client };
    });

    if (!verified) return res.status(401).json({ error: 'Неверный или истекший код' });
    return res.json({
      success: true,
      token: verified.token,
      user: {
        id: verified.client.id,
        name: verified.client.name,
        phone,
        email: verified.client.email,
      },
    });
  } catch (e) {
    if (e.code === 'MOBILE_AUTH_NOT_CONFIGURED') {
      logger.error('Mobile OTP verification is not configured');
      return res.status(503).json({ error: 'Вход через мобильное приложение временно недоступен' });
    }
    logger.error('Mobile OTP verification failed');
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.get('/me', mobileAuth, async (req, res) => {
  try {
    const client = await db.one(
      `SELECT id,name,phone,email,bonus_balance,yclients_card_balance,loyalty_level
       FROM clients WHERE id=$1 AND salon_id=$2`,
      [req.client.clientId, req.client.salonId]
    );
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    return res.json({ success: true, user: client });
  } catch (e) {
    logger.error('Get mobile profile failed');
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.post('/logout', mobileAuth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM mobile_sessions WHERE token=$1 AND client_id=$2 AND salon_id=$3',
      [req.token, req.client.clientId, req.client.salonId]
    );
    return res.json({ success: true });
  } catch (e) {
    logger.error('Mobile logout failed');
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
