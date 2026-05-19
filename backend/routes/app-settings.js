const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { imageFileFilter, validateImageBuffer } = require('../utils/upload-validator');

const uploadsDir = path.join(__dirname, '../../frontend/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// memoryStorage so we can validate content before writing.
// SVG removed — SVG can carry <script> and execute in same-origin → stored XSS.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

function shape(row) {
  if (!row) return {};
  return {
    clinicName: row.clinic_name,
    logoUrl:    row.logo_url,
    phone:      row.phone,
    whatsapp:   row.whatsapp,
    telegram:   row.telegram,
    max:        row.max,
    instagram:  row.instagram,
    mapsUrl:    row.maps_url,
    email:      row.email,
  };
}

// Resolve which salon a public/anonymous request is for.
// Priority: ?salon=N (validated int) → lowest salon_id row (single-tenant default).
async function resolvePublicSalonId(req) {
  const q = parseInt(req.query.salon, 10);
  if (Number.isFinite(q) && q > 0) return q;
  const fallback = await db.oneOrNone('SELECT id FROM salons ORDER BY id LIMIT 1');
  return fallback?.id || null;
}

// Public — mobile app calls this at startup without auth.
// Accepts optional ?salon=N to disambiguate in multi-tenant deployments.
router.get('/', async (req, res) => {
  try {
    const salonId = await resolvePublicSalonId(req);
    if (!salonId) return res.json({});
    const row = await db.oneOrNone(
      'SELECT * FROM app_settings WHERE salon_id=$1 LIMIT 1',
      [salonId]
    );
    res.json(shape(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin only — update text fields, scoped to caller's salon
router.put('/', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { clinicName, phone, whatsapp, telegram, max, instagram, mapsUrl, email } = req.body;
    const salonId = req.user.salonId;
    await db.query(
      `INSERT INTO app_settings (salon_id, clinic_name, phone, whatsapp, telegram, max, instagram, maps_url, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (salon_id) DO UPDATE SET
         clinic_name=$2, phone=$3, whatsapp=$4, telegram=$5,
         max=$6, instagram=$7, maps_url=$8, email=$9, updated_at=NOW()`,
      [salonId, clinicName || '', phone || null, whatsapp || null, telegram || null,
       max || null, instagram || null, mapsUrl || null, email || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin only — upload logo, scoped to caller's salon
router.post('/logo', auth, requireRole('owner', 'admin'), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const v = validateImageBuffer(req.file.buffer, req.file.originalname);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const salonId = req.user.salonId;
    let absPath = null;
    try {
      // Per-salon filename so admins of different salons can't collide.
      const filename = `app_logo_${salonId}_${Date.now()}${v.ext}`;
      absPath = path.join(uploadsDir, filename);
      fs.writeFileSync(absPath, req.file.buffer);
      const logoUrl = `/uploads/${filename}`;

      const existing = await db.oneOrNone(
        'SELECT logo_url FROM app_settings WHERE salon_id=$1',
        [salonId]
      );
      if (existing) {
        await db.query(
          'UPDATE app_settings SET logo_url=$1, updated_at=NOW() WHERE salon_id=$2',
          [logoUrl, salonId]
        );
        if (existing.logo_url && existing.logo_url.startsWith('/uploads/')) {
          const old = path.join(uploadsDir, path.basename(existing.logo_url));
          fs.unlink(old, () => {});
        }
      } else {
        await db.query(
          'INSERT INTO app_settings (salon_id, clinic_name, logo_url) VALUES ($1, $2, $3)',
          [salonId, '', logoUrl]
        );
      }
      res.json({ ok: true, logoUrl });
    } catch (e) {
      if (absPath) { try { fs.unlinkSync(absPath); } catch (_) {} }
      res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;
