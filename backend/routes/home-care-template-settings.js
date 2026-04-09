// Template settings routes mounted at /api/template-settings
const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { db } = require('../db');
const { auth } = require('../middleware/auth');

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `salon_${req.user?.salonId}_${req.params.type || 'file'}${ext}`);
  },
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true); else cb(new Error('Разрешены только изображения')); }
});

router.get('/', auth, async (req, res) => {
  try {
    res.json(await db.one(
      `SELECT template_logo_url, template_wm_url, template_accent_color, template_bg_color,
              template_text_color, template_logo_line1, template_logo_line2, template_subtitle,
              template_contact_phone, template_contact_web, template_contact_social
       FROM salons WHERE id=$1`, [req.user.salonId]
    ) || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/', auth, async (req, res) => {
  try {
    const { template_accent_color, template_bg_color, template_text_color,
            template_logo_line1, template_logo_line2, template_subtitle,
            template_contact_phone, template_contact_web, template_contact_social } = req.body;
    await db.query(
      `UPDATE salons SET template_accent_color=$1,template_bg_color=$2,template_text_color=$3,
       template_logo_line1=$4,template_logo_line2=$5,template_subtitle=$6,
       template_contact_phone=$7,template_contact_web=$8,template_contact_social=$9 WHERE id=$10`,
      [template_accent_color, template_bg_color, template_text_color,
       template_logo_line1, template_logo_line2, template_subtitle,
       template_contact_phone, template_contact_web, template_contact_social, req.user.salonId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/upload/:type', auth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const type = req.params.type;
    if (!['logo', 'wm'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const col = type === 'logo' ? 'template_logo_url' : 'template_wm_url';
    const url = `/uploads/${req.file.filename}`;
    try { await db.query(`UPDATE salons SET ${col}=$1 WHERE id=$2`, [url, req.user.salonId]); res.json({ ok: true, url }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
});

module.exports = router;
