const router = require('express').Router();
const { db } = require('../db');
const { mobileAuth } = require('../middleware/mobile-auth');
const { ycGet, ycGetClientCards, ycGetCardTransactions } = require('../services/yclients');

// Get client profile
router.get('/profile', mobileAuth, async (req, res) => {
  try {
    const client = await db.one(
      `SELECT
        id, name, phone, email, birthday, gender,
        bonus_balance, yclients_card_balance, loyalty_level,
        visits_count, total_spent, created_at,
        yclients_client_id
       FROM clients WHERE id=$1`,
      [req.client.clientId]
    );

    if (!client) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }

    // Get clinic info
    const clinic = await db.one(
      `SELECT id, name, city, template_contact_phone, template_contact_web
       FROM salons WHERE id=(SELECT salon_id FROM clients WHERE id=$1)`,
      [client.id]
    );

    res.json({
      success: true,
      profile: {
        ...client,
        clinicName: clinic?.name,
        clinicPhone: clinic?.template_contact_phone,
        clinicEmail: clinic?.template_contact_web,
        clinicAddress: clinic?.city,
        clinicHours: null,
        registeredAt: client.created_at,
      }
    });

  } catch (e) {
    console.error('[Get profile error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get client bookings
router.get('/bookings', mobileAuth, async (req, res) => {
  try {
    const { type = 'all' } = req.query; // 'upcoming' | 'past' | 'all'

    let whereSql = "client_id=$1 AND status != 'deleted'";

    if (type === 'upcoming') {
      whereSql += ' AND visit_date > NOW()';
    } else if (type === 'past') {
      whereSql += ' AND visit_date <= NOW()';
    }

    const bookings = await db.any(
      `SELECT
        id,
        visit_datetime as "dateTime",
        services->0->>'title'  as "serviceName",
        staff->0->>'name'      as "specialistName",
        status,
        amount as price
       FROM records
       WHERE ${whereSql}
       ORDER BY visit_datetime DESC
       LIMIT 50`,
      [req.client.clientId]
    );

    res.json({
      success: true,
      bookings: bookings
    });

  } catch (e) {
    console.error('[Get bookings error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get single booking
router.get('/bookings/:bookingId', mobileAuth, async (req, res) => {
  try {
    const booking = await db.oneOrNone(
      `SELECT
        id,
        visit_datetime as "dateTime",
        COALESCE(raw_payload->'services', services)->0->>'title' as "serviceName",
        staff->0->>'name'      as "specialistName",
        status,
        amount as price,
        COALESCE(raw_payload->'services', services) as services,
        staff,
        client_id,
        bonus_accrued as "bonusAccrued"
       FROM records
       WHERE id=$1 AND client_id=$2`,
      [req.params.bookingId, req.client.clientId]
    );

    if (!booking) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    res.json({
      success: true,
      booking
    });

  } catch (e) {
    console.error('[Get booking error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Cancel booking
router.post('/bookings/:bookingId/cancel', mobileAuth, async (req, res) => {
  try {
    const { reason = '' } = req.body;

    const booking = await db.one(
      'SELECT * FROM records WHERE id=$1 AND client_id=$2',
      [req.params.bookingId, req.client.clientId]
    );

    if (!booking) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    // Cancel in our DB
    await db.query(
      'UPDATE records SET status=$1, updated_at=NOW() WHERE id=$2',
      ['cancelled', booking.id]
    );

    res.json({
      success: true,
      message: 'Запись отменена'
    });

  } catch (e) {
    console.error('[Cancel booking error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Reschedule booking
router.post('/bookings/:bookingId/reschedule', mobileAuth, async (req, res) => {
  try {
    const { newDateTime } = req.body;

    if (!newDateTime) {
      return res.status(400).json({ error: 'Укажите новую дату и время' });
    }

    const booking = await db.one(
      'SELECT * FROM records WHERE id=$1 AND client_id=$2',
      [req.params.bookingId, req.client.clientId]
    );

    if (!booking) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    // Update booking date
    await db.query(
      'UPDATE records SET visit_date=$1, updated_at=NOW() WHERE id=$2',
      [newDateTime, booking.id]
    );

    res.json({
      success: true,
      message: 'Запись перенесена'
    });

  } catch (e) {
    console.error('[Reschedule booking error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get bonuses
router.get('/bonuses', mobileAuth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT bonus_balance, loyalty_level, total_spent, salon_id FROM clients WHERE id=$1',
      [req.client.clientId]
    );

    if (!client) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }

    // Load loyalty levels from settings
    let levels = [];
    try {
      const settings = await db.oneOrNone(
        'SELECT levels FROM loyalty_settings WHERE salon_id=$1',
        [client.salon_id]
      );
      if (settings?.levels) {
        levels = typeof settings.levels === 'string'
          ? JSON.parse(settings.levels)
          : settings.levels;
        levels = levels
          .filter(l => l && typeof l.minSpent === 'number')
          .sort((a, b) => a.minSpent - b.minSpent);
      }
    } catch (_) { /* non-critical: levels stays [] */ }

    const totalSpent = parseFloat(client.total_spent || 0);

    // Find current level object and next level object
    let currentLevel = levels.length > 0 ? levels[0] : null;
    let nextLevel = null;
    for (let i = 0; i < levels.length; i++) {
      if (totalSpent >= levels[i].minSpent) {
        currentLevel = levels[i];
        nextLevel = levels[i + 1] || null;
      }
    }

    const amountToNext = nextLevel
      ? Math.max(0, nextLevel.minSpent - totalSpent)
      : 0;

    res.json({
      success: true,
      balance: client.bonus_balance || 0,
      level: client.loyalty_level || 'Новичок',
      totalSpent,
      levels,
      currentLevel,
      nextLevel: nextLevel || null,
      amountToNext,
    });

  } catch (e) {
    console.error('[Get bonuses error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get bonus history
router.get('/bonus-history', mobileAuth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT yclients_client_id, phone, salon_id FROM clients WHERE id=$1',
      [req.client.clientId]
    );
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [client.salon_id]);

    const txns = await ycGetCardTransactions(salon, client.yclients_client_id, client.phone);

    const transactions = txns.map((t) => ({
      id: t.id,
      createdAt: t.txn_date || t.date,
      amount: Math.abs(t.amount),
      description: t.title,
      type: t.type, // 'accrual' or 'redemption'
    }));

    res.json({ success: true, transactions });

  } catch (e) {
    console.error('[Get bonus history error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get notifications
router.get('/notifications', mobileAuth, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const notifications = await db.many(
      `SELECT
        id,
        title,
        message,
        type,
        read,
        created_at as createdAt
       FROM mobile_notifications
       WHERE client_id=$1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.client.clientId, parseInt(limit), parseInt(offset)]
    );

    res.json({
      success: true,
      notifications: notifications || []
    });

  } catch (e) {
    console.error('[Get notifications error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Mark notification as read
router.post('/notifications/:notificationId/read', mobileAuth, async (req, res) => {
  try {
    const notification = await db.one(
      'SELECT * FROM mobile_notifications WHERE id=$1 AND client_id=$2',
      [req.params.notificationId, req.client.clientId]
    );

    if (!notification) {
      return res.status(404).json({ error: 'Уведомление не найдено' });
    }

    await db.query(
      'UPDATE mobile_notifications SET read=TRUE WHERE id=$1',
      [req.params.notificationId]
    );

    res.json({ success: true });

  } catch (e) {
    console.error('[Mark notification read error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Register FCM token for push notifications
router.post('/fcm-token', mobileAuth, async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ error: 'Укажите FCM token' });
    }

    await db.query(
      `INSERT INTO mobile_fcm_tokens (client_id, token, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (client_id) DO UPDATE SET token=$2`,
      [req.client.clientId, fcmToken]
    );

    res.json({ success: true });

  } catch (e) {
    console.error('[Register FCM token error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
