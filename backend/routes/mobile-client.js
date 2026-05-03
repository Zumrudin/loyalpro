const router = require('express').Router();
const { db } = require('../db');
const { mobileAuth } = require('../middleware/mobile-auth');
const { absolutizeUrl } = require('../services/portfolio');
const { ycGet, ycGetClientCards, ycGetCardTransactions } = require('../services/yclients');
const { createLogger } = require('../logger');
const logger = createLogger('Mobile');

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
    logger.error(`Get profile error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Get client bookings
router.get('/bookings', mobileAuth, async (req, res) => {
  try {
    const { type = 'all' } = req.query; // 'upcoming' | 'past' | 'all'

    let whereSql = "r.client_id=$1 AND r.status != 'deleted'";

    if (type === 'upcoming') {
      whereSql += ' AND r.visit_datetime > NOW()';
    } else if (type === 'past') {
      whereSql += ' AND r.visit_datetime <= NOW()';
    }

    const bookings = await db.any(
      `SELECT
        r.id,
        r.visit_datetime as "dateTime",
        r.services->0->>'title'  as "serviceName",
        r.staff->0->>'name'      as "specialistName",
        r.status,
        r.amount as price,
        CASE WHEN p.id IS NOT NULL THEN true ELSE false END as "hasPrescription",
        p.id as "prescriptionId"
       FROM records r
       LEFT JOIN LATERAL (
         SELECT id FROM home_care_prescriptions
         WHERE client_id = $1
           AND (record_id = r.id
                OR (record_id IS NULL
                    AND DATE(created_at) = DATE(r.visit_datetime)))
         ORDER BY record_id DESC NULLS LAST, created_at DESC
         LIMIT 1
       ) p ON true
       WHERE ${whereSql}
       ORDER BY r.visit_datetime ${type === 'upcoming' ? 'ASC' : 'DESC'}
       LIMIT 50`,
      [req.client.clientId]
    );

    res.json({
      success: true,
      bookings: bookings
    });

  } catch (e) {
    logger.error(`Get bookings error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Get single booking
router.get('/bookings/:bookingId', mobileAuth, async (req, res) => {
  try {
    const booking = await db.oneOrNone(
      `SELECT
        r.id,
        r.visit_datetime as "dateTime",
        COALESCE(r.raw_payload->'services', r.services)->0->>'title' as "serviceName",
        r.staff->0->>'name'      as "specialistName",
        r.status,
        r.amount as price,
        COALESCE(r.raw_payload->'services', r.services) as services,
        r.staff,
        r.client_id,
        r.bonus_accrued as "bonusAccrued",
        p.id as "prescriptionId"
       FROM records r
       LEFT JOIN LATERAL (
         SELECT id FROM home_care_prescriptions
         WHERE client_id = $2
           AND (record_id = r.id
                OR (record_id IS NULL
                    AND DATE(created_at) = DATE(r.visit_datetime)))
         ORDER BY record_id DESC NULLS LAST, created_at DESC
         LIMIT 1
       ) p ON true
       WHERE r.id=$1 AND r.client_id=$2`,
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
    logger.error(`Get booking error: ${e.message}`);
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
    logger.error(`Cancel booking error: ${e.message}`);
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
    logger.error(`Reschedule booking error: ${e.message}`);
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
    logger.error(`Get bonuses error: ${e.message}`);
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
    logger.error(`Get bonus history error: ${e.message}`);
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
    logger.error(`Get notifications error: ${e.message}`);
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
    logger.error(`Mark notification read error: ${e.message}`);
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
    logger.error(`Register FCM token error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Get client prescriptions list
router.get('/prescriptions', mobileAuth, async (req, res) => {
  try {
    const rows = await db.any(
      `SELECT
        p.id,
        p.created_at as "createdAt",
        p.notes,
        u.name as "specialistName",
        u.position as "specialistPosition",
        COUNT(i.id)::int as "itemsCount"
       FROM home_care_prescriptions p
       LEFT JOIN users u ON u.id = p.specialist_id
       LEFT JOIN home_care_items i ON i.prescription_id = p.id
       WHERE p.client_id = $1
         AND p.salon_id = (SELECT salon_id FROM clients WHERE id = $1)
       GROUP BY p.id, u.name, u.position
       ORDER BY p.created_at DESC`,
      [req.client.clientId]
    );
    res.json({ success: true, prescriptions: rows });
  } catch (e) {
    logger.error(`Get prescriptions error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Get single prescription detail
router.get('/prescriptions/:id', mobileAuth, async (req, res) => {
  try {
    const prescriptionId = parseInt(req.params.id, 10);
    if (isNaN(prescriptionId)) return res.status(400).json({ error: 'Invalid id' });

    const p = await db.oneOrNone(
      `SELECT
        p.id,
        p.created_at as "createdAt",
        p.notes,
        u.name as "specialistName",
        u.position as "specialistPosition"
       FROM home_care_prescriptions p
       LEFT JOIN users u ON u.id = p.specialist_id
       WHERE p.id = $1 AND p.client_id = $2
         AND p.salon_id = (SELECT salon_id FROM clients WHERE id = $2)`,
      [prescriptionId, req.client.clientId]
    );
    if (!p) return res.status(404).json({ error: 'Назначение не найдено' });

    const items = await db.any(
      `SELECT time_of_day as "timeOfDay", category, product_name as "productName",
              instructions, sort_order as "sortOrder"
       FROM home_care_items
       WHERE prescription_id = $1
       ORDER BY sort_order`,
      [prescriptionId]
    );
    res.json({ success: true, prescription: { ...p, items } });
  } catch (e) {
    logger.error(`Get prescription detail error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Get price list
const PRICE_LIST_URL = 'https://raw.githubusercontent.com/Zumrudin/peri-clinic/main/price-list.json';
let priceListCache = null;
let priceListCachedAt = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

router.get('/price-list', mobileAuth, async (req, res) => {
  try {
    const now = Date.now();
    if (priceListCache && priceListCachedAt && (now - priceListCachedAt) < CACHE_TTL_MS) {
      return res.json({ success: true, ...priceListCache });
    }

    const response = await fetch(PRICE_LIST_URL);
    if (!response.ok) throw new Error(`GitHub fetch failed: ${response.status}`);

    const data = await response.json();
    priceListCache = data;
    priceListCachedAt = now;

    res.json({ success: true, ...data });
  } catch (e) {
    logger.error(`Get price list error: ${e.message}`);
    if (priceListCache) return res.json({ success: true, ...priceListCache });
    res.status(500).json({ error: 'Не удалось загрузить прайс-лист' });
  }
});

// Get specialists (staff_members with show_in_app=TRUE and is_active=TRUE)
router.get('/specialists', mobileAuth, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const rows = await db.any(
      `SELECT id, name, specialization, bio,
              custom_photo_url, avatar_url, display_order
       FROM staff_members
       WHERE salon_id = (SELECT salon_id FROM clients WHERE id=$1)
         AND show_in_app = TRUE
         AND is_active   = TRUE
       ORDER BY display_order ASC NULLS LAST, name ASC`,
      [req.client.clientId]
    );

    const specialists = rows.map((r) => {
      let photoUrl = null;
      if (r.custom_photo_url && r.custom_photo_url.trim()) {
        photoUrl = r.custom_photo_url.startsWith('http')
          ? r.custom_photo_url
          : `${baseUrl}${r.custom_photo_url}`;
      } else if (r.avatar_url && r.avatar_url.trim()) {
        photoUrl = r.avatar_url;
      }
      return {
        id: r.id,
        name: r.name,
        specialization: r.specialization,
        bio: r.bio,
        photoUrl,
        displayOrder: r.display_order,
      };
    });

    res.json({ success: true, specialists });

  } catch (e) {
    logger.error(`Get specialists error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mobile/client/portfolio/categories
// Returns published, non-empty categories scoped to client's salon
router.get('/portfolio/categories', mobileAuth, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const rows = await db.any(
      `SELECT c.id, c.title, c.cover_photo_url,
              (SELECT COUNT(*)::int FROM portfolio_items i
               WHERE i.salon_id=c.salon_id AND i.category_id=c.id) AS items_count
       FROM portfolio_categories c
       WHERE c.salon_id = (SELECT salon_id FROM clients WHERE id=$1)
         AND c.is_published = TRUE
         AND c.cover_photo_url <> ''
       ORDER BY c.display_order ASC, c.id ASC`,
      [req.client.clientId]
    );
    const categories = rows
      .filter(r => r.items_count > 0)
      .map(r => ({
        id: r.id,
        title: r.title,
        coverPhotoUrl: absolutizeUrl(baseUrl, r.cover_photo_url),
        itemsCount: r.items_count,
      }));
    res.json({ success: true, categories });
  } catch (e) {
    logger.error(`Get portfolio categories error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mobile/client/portfolio/categories/:id
router.get('/portfolio/categories/:id', mobileAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const cat = await db.oneOrNone(
      `SELECT id, title FROM portfolio_categories
       WHERE id=$1
         AND salon_id = (SELECT salon_id FROM clients WHERE id=$2)
         AND is_published = TRUE`,
      [id, req.client.clientId]
    );
    if (!cat) return res.status(404).json({ error: 'Категория не найдена' });

    const rows = await db.any(
      `SELECT i.id, i.title, i.description,
              i.photo_after_url, i.photo_before_url,
              s.id AS staff_id, s.name AS staff_name,
              s.custom_photo_url, s.avatar_url
       FROM portfolio_items i
       LEFT JOIN staff_members s ON s.id=i.staff_id
       WHERE i.salon_id = (SELECT salon_id FROM clients WHERE id=$1)
         AND i.category_id = $2
       ORDER BY i.display_order ASC, i.id ASC`,
      [req.client.clientId, id]
    );

    const items = rows.map(r => {
      let staffPhoto = null;
      if (r.staff_id) {
        const raw = (r.custom_photo_url && r.custom_photo_url.trim()) || r.avatar_url || null;
        staffPhoto = absolutizeUrl(baseUrl, raw);
      }
      return {
        id: r.id,
        title: r.title,
        description: r.description,
        photoAfterUrl:  absolutizeUrl(baseUrl, r.photo_after_url),
        photoBeforeUrl: absolutizeUrl(baseUrl, r.photo_before_url),
        specialist: r.staff_id ? {
          id: r.staff_id, name: r.staff_name, photoUrl: staffPhoto,
        } : null,
      };
    });

    res.json({ success: true, category: { id: cat.id, title: cat.title }, items });
  } catch (e) {
    logger.error(`Get portfolio category error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
