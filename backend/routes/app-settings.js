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

// Public — mobile app calls this at startup without auth
router.get('/', async (req, res) => {
  try {
    const row = await db.oneOrNone('SELECT * FROM app_settings ORDER BY id LIMIT 1');
    if (!row) return res.json({});
    res.json({
      clinicName: row.clinic_name,
      logoUrl:    row.logo_url,
      phone:      row.phone,
      whatsapp:   row.whatsapp,
      telegram:   row.telegram,
      max:        row.max,
      instagram:  row.instagram,
      mapsUrl:    row.maps_url,
      email:      row.email,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin only — update text fields
router.put('/', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { clinicName, phone, whatsapp, telegram, max, instagram, mapsUrl, email } = req.body;
    const existing = await db.oneOrNone('SELECT id FROM app_settings ORDER BY id LIMIT 1');
    if (existing) {
      await db.query(
        `UPDATE app_settings SET clinic_name=$1, phone=$2, whatsapp=$3, telegram=$4,
         max=$5, instagram=$6, maps_url=$7, email=$8, updated_at=NOW() WHERE id=$9`,
        [clinicName || '', phone || null, whatsapp || null, telegram || null,
         max || null, instagram || null, mapsUrl || null, email || null, existing.id]
      );
    } else {
      await db.query(
        `INSERT INTO app_settings (clinic_name, phone, whatsapp, telegram, max, instagram, maps_url, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [clinicName || '', phone || null, whatsapp || null, telegram || null,
         max || null, instagram || null, mapsUrl || null, email || null]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin only — upload logo
router.post('/logo', auth, requireRole('owner', 'admin'), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const v = validateImageBuffer(req.file.buffer, req.file.originalname);
    if (!v.ok) return res.status(400).json({ error: v.error });

    let absPath = null;
    try {
      // Use a timestamp suffix so a stale CDN/browser cache can't serve an old logo
      // and so concurrent uploads don't race on the same filename.
      const filename = `app_logo_${Date.now()}${v.ext}`;
      absPath = path.join(uploadsDir, filename);
      fs.writeFileSync(absPath, req.file.buffer);
      const logoUrl = `/uploads/${filename}`;

      const existing = await db.oneOrNone('SELECT id, logo_url FROM app_settings ORDER BY id LIMIT 1');
      if (existing) {
        await db.query('UPDATE app_settings SET logo_url=$1, updated_at=NOW() WHERE id=$2', [logoUrl, existing.id]);
        // best-effort delete of old file
        if (existing.logo_url && existing.logo_url.startsWith('/uploads/')) {
          const old = path.join(uploadsDir, path.basename(existing.logo_url));
          fs.unlink(old, () => {});
        }
      } else {
        await db.query('INSERT INTO app_settings (clinic_name, logo_url) VALUES ($1, $2)', ['', logoUrl]);
      }
      res.json({ ok: true, logoUrl });
    } catch (e) {
      if (absPath) { try { fs.unlinkSync(absPath); } catch (_) {} }
      res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;
