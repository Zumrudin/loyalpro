const router = require('express').Router();
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { ycAuth, ycWebSessions } = require('../services/yclients');
const { getLoyaltySettings } = require('../services/loyalty');
const { imageFileFilter, validateImageBuffer } = require('../utils/upload-validator');
const { createLogger } = require('../logger');
const logger = createLogger('Salon');

const SALON_SETTINGS_FIELDS = Object.freeze([
  'id', 'name', 'city', 'timezone', 'logo_url',
  'yclients_company_id', 'yclients_card_type_id', 'yclients_card_type_name', 'yclients_chain_id',
  'yclients_partner_configured', 'yclients_user_configured',
  'yclients_web_session_configured', 'yclients_webhook_configured',
  'plan', 'max_users',
]);
const SALON_SETTINGS_SELECT = `
  SELECT id,name,city,timezone,logo_url,
    yclients_company_id,yclients_card_type_id,yclients_card_type_name,yclients_chain_id,
    (yclients_partner_token IS NOT NULL AND yclients_partner_token<>'') AS yclients_partner_configured,
    (yclients_user_token IS NOT NULL AND yclients_user_token<>'') AS yclients_user_configured,
    (yclients_web_cookie IS NOT NULL AND yclients_web_cookie<>'') AS yclients_web_session_configured,
    (yclients_webhook_secret IS NOT NULL AND yclients_webhook_secret<>'') AS yclients_webhook_configured,
    plan,max_users
  FROM salons WHERE id=$1`;
const OWNER_INTEGRATION_FIELDS = [
  'yclients_company_id', 'yclients_card_type_id', 'yclients_card_type_name', 'yclients_web_cookie',
];

function salonSettingsDto(row) {
  if (!row) return null;
  return Object.fromEntries(SALON_SETTINGS_FIELDS.map(field => [field, row[field]]));
}

const uploadsDir = path.join(__dirname, '../../frontend/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// memoryStorage — валидируем содержимое до записи на диск (см. app-settings.js)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

router.get('/', auth, async (req, res) => {
  try {
    const salon = await db.one(SALON_SETTINGS_SELECT, [req.user.salonId]);
    if (!salon) return res.status(404).json({ error: 'Салон не найден' });
    return res.json(salonSettingsDto(salon));
  } catch (e) {
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.put('/', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    if (req.user.role !== 'owner' && OWNER_INTEGRATION_FIELDS.some(field => Object.hasOwn(req.body, field))) {
      return res.status(403).json({ error: 'Настройки интеграции изменяет только владелец' });
    }
    const { name, city, timezone, yclients_company_id,
            yclients_card_type_id, yclients_card_type_name, yclients_web_cookie } = req.body;
    await db.query(
      `UPDATE salons SET name=$1,city=$2,timezone=$3,yclients_company_id=$4,
       yclients_card_type_id=$5,yclients_card_type_name=$6,
       yclients_web_cookie=COALESCE($7,yclients_web_cookie),
       updated_at=NOW() WHERE id=$8`,
      [name, city, timezone, yclients_company_id,
       yclients_card_type_id || null, yclients_card_type_name || null,
       yclients_web_cookie || null, req.user.salonId]
    );
    if (yclients_web_cookie) delete ycWebSessions[req.user.salonId];
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505' && e.constraint === 'salons_yclients_company_id_key')
      return res.status(409).json({ error: 'Салон с таким ID филиала YClients уже зарегистрирован в системе. Обратитесь в поддержку.' });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ── Логотип филиала (используется как favicon веб-интерфейса) ──
// GET — публичный (в config.API_PUBLIC): favicon нужен до логина.
// Салон определяется как в app-settings: ?salon=N → минимальный id (single-tenant default).
router.get('/logo', async (req, res) => {
  try {
    const q = parseInt(req.query.salon, 10);
    let salonId = Number.isFinite(q) && q > 0 ? q : null;
    if (!salonId) {
      const fallback = await db.oneOrNone('SELECT id FROM salons ORDER BY id LIMIT 1');
      salonId = fallback?.id || null;
    }
    if (!salonId) return res.json({ logoUrl: null });
    const row = await db.oneOrNone('SELECT logo_url FROM salons WHERE id=$1', [salonId]);
    res.json({ logoUrl: row?.logo_url || null });
  } catch (e) { res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

router.post('/logo', auth, requireRole('owner', 'admin'), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const v = validateImageBuffer(req.file.buffer, req.file.originalname);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const salonId = req.user.salonId;
    let absPath = null;
    try {
      const filename = `salon_logo_${salonId}_${Date.now()}${v.ext}`;
      absPath = path.join(uploadsDir, filename);
      fs.writeFileSync(absPath, req.file.buffer);
      const logoUrl = `/uploads/${filename}`;

      const old = await db.oneOrNone('SELECT logo_url FROM salons WHERE id=$1', [salonId]);
      await db.query(
        'UPDATE salons SET logo_url=$1, updated_at=NOW() WHERE id=$2',
        [logoUrl, salonId]
      );
      if (old?.logo_url && old.logo_url.startsWith('/uploads/')) {
        fs.unlink(path.join(uploadsDir, path.basename(old.logo_url)), () => {});
      }
      res.json({ ok: true, logoUrl });
    } catch (e) {
      if (absPath) { try { fs.unlinkSync(absPath); } catch (_) {} }
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
  });
});

router.delete('/logo', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const old = await db.oneOrNone('SELECT logo_url FROM salons WHERE id=$1', [salonId]);
    await db.query('UPDATE salons SET logo_url=NULL, updated_at=NOW() WHERE id=$1', [salonId]);
    if (old?.logo_url && old.logo_url.startsWith('/uploads/')) {
      fs.unlink(path.join(uploadsDir, path.basename(old.logo_url)), () => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

// ── Webhook shared-secret management ────────────────────────────
// GET returns only configuration state. POST rotates the URL secret once;
// YClients does not provide body HMAC signatures.
router.get('/webhook-secret', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const row = await db.oneOrNone(
      'SELECT yclients_webhook_secret FROM salons WHERE id=$1',
      [req.user.salonId]
    );
    res.json({ configured: !!row?.yclients_webhook_secret });
  } catch (e) { res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

router.post('/webhook-secret', auth, requireRole('owner'), async (req, res) => {
  try {
    const secret = crypto.randomBytes(32).toString('hex'); // 64 hex chars
    await db.query(
      'UPDATE salons SET yclients_webhook_secret=$1, updated_at=NOW() WHERE id=$2',
      [secret, req.user.salonId]
    );
    logger.info(`webhook secret rotated salon=${req.user.salonId} by user=${req.user.userId}`);
    // Returned once. After this admin acknowledges the value we don't expose it again.
    res.json({ secret });
  } catch (e) { res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

router.post('/yclients-auth', auth, requireRole('owner'), async (req, res) => {
  try {
    const { partnerToken, login, password, chainId, yclients_company_id } = req.body;
    const d = await ycAuth(partnerToken, login, password);
    const result = await db.query(
      `UPDATE salons SET
         yclients_partner_token=$1, yclients_user_token=$2,
         yclients_login=$3, yclients_password=$4,
         yclients_company_id=COALESCE($5,yclients_company_id),
         yclients_chain_id=$6, updated_at=NOW()
       WHERE id=$7
       RETURNING yclients_company_id`,
      [partnerToken, d.user_token, login, password, yclients_company_id || null,
       chainId || null, req.user.salonId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Салон не найден' });
    delete ycWebSessions[req.user.salonId];
    return res.json({ ok: true, configured: true, companyId: result.rows[0].yclients_company_id });
  } catch (e) {
    logger.error('YClients credential authentication failed');
    return res.status(400).json({ error: 'Не удалось подтвердить учётные данные YClients' });
  }
});

module.exports = router;
