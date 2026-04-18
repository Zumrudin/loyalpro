const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `app_logo${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения'));
  },
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
      instagram:  row.instagram,
      mapsUrl:    row.maps_url,
      email:      row.email,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin only — update text fields
router.put('/', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { clinicName, phone, whatsapp, telegram, instagram, mapsUrl, email } = req.body;
    const existing = await db.oneOrNone('SELECT id FROM app_settings ORDER BY id LIMIT 1');
    if (existing) {
      await db.query(
        `UPDATE app_settings SET clinic_name=$1, phone=$2, whatsapp=$3, telegram=$4,
         instagram=$5, maps_url=$6, email=$7, updated_at=NOW() WHERE id=$8`,
        [clinicName || '', phone || null, whatsapp || null, telegram || null,
         instagram || null, mapsUrl || null, email || null, existing.id]
      );
    } else {
      await db.query(
        `INSERT INTO app_settings (clinic_name, phone, whatsapp, telegram, instagram, maps_url, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [clinicName || '', phone || null, whatsapp || null, telegram || null,
         instagram || null, mapsUrl || null, email || null]
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
    const logoUrl = `/uploads/${req.file.filename}`;
    try {
      const existing = await db.oneOrNone('SELECT id FROM app_settings ORDER BY id LIMIT 1');
      if (existing) {
        await db.query('UPDATE app_settings SET logo_url=$1, updated_at=NOW() WHERE id=$2', [logoUrl, existing.id]);
      } else {
        await db.query('INSERT INTO app_settings (clinic_name, logo_url) VALUES ($1, $2)', ['', logoUrl]);
      }
      res.json({ ok: true, logoUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

module.exports = router;
