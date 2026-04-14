const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { pool, db } = require('../db');
const { mobileAuth } = require('../middleware/mobile-auth');
const { getBotLink } = require('../services/telegram');
const config = require('../config');

const JWT_SECRET = config.JWT_SECRET;

// Login by phone - send OTP
router.post('/login', async (req, res) => {
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

    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    console.log(`[OTP] Phone: ${normalizedPhone}, Code: ${otp}`);

    // Store OTP with 5 min TTL
    await db.query(
      `INSERT INTO mobile_otp_sessions (phone, otp, created_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '5 minutes')
       ON CONFLICT (phone) DO UPDATE SET otp=$2, created_at=NOW(), expires_at=NOW() + INTERVAL '5 minutes'`,
      [normalizedPhone, otp]
    );

    // Return Telegram bot link for OTP delivery
    const telegramLink = getBotLink(normalizedPhone);

    res.json({
      success: true,
      message: 'Откройте Telegram бота для получения кода',
      phone: normalizedPhone,
      telegramLink,
    });

  } catch (e) {
    console.error('[Login error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Verify OTP and create session
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Укажите номер телефона и код' });
    }

    // Normalize phone
    const cleanPhone = String(phone).replace(/\D/g, '');
    const normalizedPhone = cleanPhone.length === 11 ? cleanPhone : '7' + cleanPhone.slice(-10);

    // Check OTP
    const otpRecord = await db.one(
      'SELECT * FROM mobile_otp_sessions WHERE phone=$1 AND otp=$2 AND expires_at > NOW()',
      [normalizedPhone, otp]
    );

    if (!otpRecord) {
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
    console.error('[Verify OTP error]', e.message);
    res.status(500).json({ error: e.message });
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
    console.error('[Get me error]', e.message);
    res.status(500).json({ error: e.message });
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
    console.error('[Logout error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
