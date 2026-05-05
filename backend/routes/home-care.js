const router    = require('express').Router();
const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const puppeteer = require('puppeteer');
const axios     = require('axios');
const { db }    = require('../db');
const { auth }  = require('../middleware/auth');
const { ycGet } = require('../services/yclients');
const { getTreeCache, setTreeCache } = require('../services/yclients');
const { syncGoodsCategories }        = require('../services/home-care');
const { buildHomeCareHtml, BRAND_CONFIG } = require('../homecare-template');
const config = require('../config');
const { createLogger } = require('../logger');
const logger = createLogger('HomeCare');

async function sendPrescriptionPush(clientId, prescriptionId) {
  try {
    const row = await db.oneOrNone(
      'SELECT token FROM mobile_fcm_tokens WHERE client_id=$1',
      [clientId]
    );
    if (!row?.token) return;
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: row.token,
      title: 'Новое назначение',
      body: 'Врач добавил назначения по вашему визиту. Нажмите, чтобы открыть.',
      data: { prescriptionId },
      sound: 'default',
    }, { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    logger.error('Failed to send prescription push:', e.message);
  }
}

// ── Multer upload (for template images) ──────────────────────
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
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения'));
  },
});

// ── Helpers ───────────────────────────────────────────────────
function toAbsUrl(relUrl) {
  if (!relUrl) return null;
  if (/^https?:\/\//.test(relUrl)) return relUrl;
  try {
    const filePath = path.join(__dirname, '../../frontend', relUrl);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      const ext  = path.extname(filePath).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return `data:${mime};base64,${data.toString('base64')}`;
    }
  } catch (_) {}
  return `http://localhost:${config.PORT}${relUrl}`;
}

async function loadTemplateConfig(salonId, salonName) {
  const row = await db.one(
    `SELECT template_logo_url, template_wm_url, template_accent_color, template_bg_color,
            template_text_color, template_logo_line1, template_logo_line2, template_subtitle,
            template_contact_phone, template_contact_web, template_contact_social
     FROM salons WHERE id=$1`, [salonId]
  ).catch(() => null);
  const parts = (salonName || '').trim().split(/\s+/);
  const base = { ...BRAND_CONFIG, logoLine1: parts[0] || 'PERI', logoLine2: parts.slice(1).join(' ') || 'CLINIC' };
  if (!row) return base;
  return {
    ...base,
    ...(row.template_logo_line1 && { logoLine1: row.template_logo_line1 }),
    ...(row.template_logo_line2 != null && { logoLine2: row.template_logo_line2 }),
    ...(row.template_subtitle   && { subtitle: row.template_subtitle }),
    ...(row.template_accent_color && { accentColor: row.template_accent_color }),
    ...(row.template_bg_color   && { bgColor: row.template_bg_color }),
    ...(row.template_text_color && { textColor: row.template_text_color }),
    ...(row.template_logo_url   && { logoImageUrl: toAbsUrl(row.template_logo_url) }),
    ...(row.template_wm_url     && { wmImageUrl:   toAbsUrl(row.template_wm_url) }),
    ...(row.template_contact_phone  && { contactPhone: row.template_contact_phone }),
    ...(row.template_contact_web    && { contactWeb: row.template_contact_web }),
    ...(row.template_contact_social && { contactSocial: row.template_contact_social }),
  };
}

// ── Catalog ───────────────────────────────────────────────────
router.get('/products', auth, async (req, res) => {
  try {
    const { search = '', limit = 10 } = req.query;
    res.json(await db.any(
      `SELECT DISTINCT ON (lower(trim(title))) title, yclients_goods_id as id
       FROM goods_sale_items gsi JOIN goods_sales gs ON gs.id=gsi.sale_id
       WHERE gs.salon_id=$1 AND ($2='' OR title ILIKE '%'||$2||'%')
         AND title IS NOT NULL AND trim(title)!=''
       ORDER BY lower(trim(title)), title LIMIT $3`,
      [req.user.salonId, search, parseInt(limit)]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/services', auth, async (req, res) => {
  try {
    const { search = '', limit = 10 } = req.query;
    res.json(await db.any(
      `SELECT DISTINCT ON (lower(trim(svc->>'title'))) svc->>'title' AS title, (svc->>'id')::text AS id
       FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
       WHERE r.salon_id=$1 AND svc->>'title' IS NOT NULL AND trim(svc->>'title')!=''
         AND ($2='' OR svc->>'title' ILIKE '%'||$2||'%')
       ORDER BY lower(trim(svc->>'title')), svc->>'title' LIMIT $3`,
      [req.user.salonId, search, parseInt(limit)]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/service-tree', auth, async (req, res) => {
  try {
    const { search = '' } = req.query;
    const salonId = req.user.salonId;
    if (!search) {
      const cached = getTreeCache(salonId);
      if (cached?.services) return res.json(cached.services);
    }
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [salonId]);
    let grouped = {};
    if (salon.yclients_company_id && salon.yclients_user_token) {
      const cats = await ycGet(salon, `/service_categories/${salon.yclients_company_id}`);
      const catMap = {};
      for (const c of (cats || [])) catMap[c.id] = c.title;
      const services = await ycGet(salon, `/services/${salon.yclients_company_id}`);
      for (const s of (services || [])) {
        if (!s.title) continue;
        if (search && !s.title.toLowerCase().includes(search.toLowerCase())) continue;
        const cat = catMap[s.category_id] || 'Без категории';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(s.title);
      }
    } else {
      const { rows } = await db.query(
        `SELECT DISTINCT ON (lower(trim(svc->>'title'))) svc->>'title' AS title
         FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
         WHERE r.salon_id=$1 AND svc->>'title' IS NOT NULL AND trim(svc->>'title')!=''
           AND ($2='' OR svc->>'title' ILIKE '%'||$2||'%')
         ORDER BY lower(trim(svc->>'title'))`,
        [salonId, search]
      );
      grouped['Услуги'] = rows.map(r => r.title);
    }
    const result = Object.entries(grouped).sort(([a],[b])=>a.localeCompare(b,'ru')).map(([cat,items])=>({cat,items}));
    if (!search) setTreeCache(salonId, 'services', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sync-goods-categories', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id || !salon.yclients_user_token)
      return res.status(400).json({ error: 'YClients не подключён' });
    res.json(await syncGoodsCategories(salon));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/product-tree', auth, async (req, res) => {
  try {
    const { search = '' } = req.query;
    const salonId = req.user.salonId;
    if (!search) {
      const cached = getTreeCache(salonId);
      if (cached?.products) return res.json(cached.products);
    }
    const { rows } = await db.query(
      `SELECT DISTINCT ON (lower(trim(title))) title, yclients_category
       FROM goods_sale_items gsi JOIN goods_sales gs ON gs.id=gsi.sale_id
       WHERE gs.salon_id=$1 AND title IS NOT NULL AND trim(title)!=''
         AND ($2='' OR lower(title) LIKE '%'||lower($2)||'%')
       ORDER BY lower(trim(title)) LIMIT 600`,
      [salonId, search]
    );
    const grouped = {};
    for (const r of rows) {
      const cat = (r.yclients_category || '').trim() || 'Без категории';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(r.title);
    }
    const result = Object.entries(grouped).sort(([a],[b])=>a.localeCompare(b,'ru')).map(([cat,items])=>({cat,items}));
    if (!search) setTreeCache(salonId, 'products', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Prescriptions CRUD ────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { search = '', page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const rows = await db.any(
      `SELECT p.id, p.created_at, p.updated_at, p.notes,
              p.start_date, p.end_date,
              c.id as client_id, c.name as client_name, c.phone as client_phone,
              u.name as specialist_name, u.position as specialist_position,
              (
                WITH days AS (
                  SELECT generate_series(
                    p.start_date,
                    LEAST(COALESCE(p.end_date, CURRENT_DATE), CURRENT_DATE),
                    '1 day'::interval
                  )::date AS d
                ),
                expected AS (
                  SELECT COUNT(*) AS n
                    FROM days d
                    JOIN home_care_items i ON i.prescription_id = p.id
                                          AND i.time_of_day IN ('morning','evening','additional')
                   WHERE i.days_of_week IS NULL
                      OR cardinality(i.days_of_week) = 0
                      OR (EXTRACT(ISODOW FROM d.d)::int - 1) = ANY(i.days_of_week)
                ),
                done AS (
                  SELECT COUNT(*) AS n
                    FROM home_care_completions c2
                    JOIN home_care_items i ON i.id = c2.item_id
                   WHERE i.prescription_id = p.id
                     AND i.time_of_day IN ('morning','evening','additional')
                     AND c2.client_id = p.client_id
                     AND c2.completion_date BETWEEN
                           p.start_date AND
                           LEAST(COALESCE(p.end_date, CURRENT_DATE), CURRENT_DATE)
                )
                SELECT CASE
                         WHEN (SELECT n FROM expected) = 0 THEN NULL
                         ELSE ROUND(100.0 * (SELECT n FROM done) / (SELECT n FROM expected))::int
                       END
              ) AS adherence_pct
       FROM home_care_prescriptions p
       LEFT JOIN clients c ON c.id=p.client_id
       LEFT JOIN users u ON u.id=p.specialist_id
       WHERE p.salon_id=$1 AND ($2='' OR c.name ILIKE '%'||$2||'%' OR c.phone ILIKE '%'||$2||'%')
       ORDER BY p.created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.salonId, search, parseInt(limit), offset]
    );
    const total = await db.one(
      `SELECT COUNT(*) FROM home_care_prescriptions p LEFT JOIN clients c ON c.id=p.client_id
       WHERE p.salon_id=$1 AND ($2='' OR c.name ILIKE '%'||$2||'%' OR c.phone ILIKE '%'||$2||'%')`,
      [req.user.salonId, search]
    );
    res.json({ rows, total: parseInt(total.count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/preview', auth, async (req, res) => {
  try {
    const p = await db.oneOrNone(
      `SELECT p.*, c.name as client_name, c.phone as client_phone, u.name as specialist_name, u.position as specialist_position, s.name as salon_name
       FROM home_care_prescriptions p LEFT JOIN clients c ON c.id=p.client_id
       LEFT JOIN users u ON u.id=p.specialist_id LEFT JOIN salons s ON s.id=p.salon_id
       WHERE p.id=$1 AND p.salon_id=$2`, [req.params.id, req.user.salonId]
    );
    if (!p) return res.status(404).json({ error: 'Not found' });
    const items = await db.any('SELECT * FROM home_care_items WHERE prescription_id=$1 ORDER BY time_of_day, sort_order', [req.params.id]);
    const tmpl = await loadTemplateConfig(req.user.salonId, p.salon_name);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildHomeCareHtml({ ...p, items }, tmpl));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/pdf', auth, async (req, res) => {
  let browser;
  try {
    const p = await db.oneOrNone(
      `SELECT p.*, c.name as client_name, c.phone as client_phone, u.name as specialist_name, u.position as specialist_position, s.name as salon_name
       FROM home_care_prescriptions p LEFT JOIN clients c ON c.id=p.client_id
       LEFT JOIN users u ON u.id=p.specialist_id LEFT JOIN salons s ON s.id=p.salon_id
       WHERE p.id=$1 AND p.salon_id=$2`, [req.params.id, req.user.salonId]
    );
    if (!p) return res.status(404).json({ error: 'Not found' });
    const items = await db.any('SELECT * FROM home_care_items WHERE prescription_id=$1 ORDER BY time_of_day, sort_order', [req.params.id]);
    const prescription = { ...p, items };
    const tmpl = await loadTemplateConfig(req.user.salonId, prescription.salon_name);
    const html = buildHomeCareHtml(prescription, tmpl);
    browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'], headless: true });
    const pg = await browser.newPage();
    await pg.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await pg.evaluate(() => new Promise(r => setTimeout(r, 1200)));
    const pdfData = await pg.pdf({ format: 'A4', printBackground: true, margin: { top:'10mm', bottom:'12mm', left:'13mm', right:'13mm' } });
    await browser.close();
    const pdf = Buffer.isBuffer(pdfData) ? pdfData : Buffer.from(pdfData);
    const clientName = (prescription.client_name || 'назначение').replace(/[^а-яёa-z0-9_\- ]/gi,'').slice(0,30);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Домашний уход — ' + clientName)}.pdf`);
    res.send(pdf);
  } catch (e) {
    if (browser) await browser.close().catch(()=>{});
    logger.error('PDF generation failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const p = await db.oneOrNone(
      `SELECT p.*, c.name as client_name, c.phone as client_phone, u.name as specialist_name, u.position as specialist_position, s.name as salon_name
       FROM home_care_prescriptions p LEFT JOIN clients c ON c.id=p.client_id
       LEFT JOIN users u ON u.id=p.specialist_id LEFT JOIN salons s ON s.id=p.salon_id
       WHERE p.id=$1 AND p.salon_id=$2`, [req.params.id, req.user.salonId]
    );
    if (!p) return res.status(404).json({ error: 'Not found' });
    const items = await db.any('SELECT * FROM home_care_items WHERE prescription_id=$1 ORDER BY time_of_day, sort_order', [req.params.id]);
    res.json({ ...p, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const { client_id, face_procedures, body_procedures, hair_procedures, vitamins, notes, items = [], record_id, start_date, end_date } = req.body;
    const startDateValue = start_date || new Date().toISOString().slice(0, 10);
    const endDateValue   = end_date || null;
    function normalizeDays(raw) {
      if (!Array.isArray(raw)) return null;
      const cleaned = [...new Set(raw
        .map(n => parseInt(n, 10))
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 6))]
        .sort((a, b) => a - b);
      // Empty or all 7 days = daily (NULL in DB)
      if (cleaned.length === 0 || cleaned.length === 7) return null;
      return cleaned;
    }
    const p = await db.one(
      `INSERT INTO home_care_prescriptions
         (salon_id, client_id, specialist_id, face_procedures, body_procedures,
          hair_procedures, vitamins, notes, record_id, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        req.user.salonId, client_id || null, req.user.userId,
        face_procedures || null, body_procedures || null,
        hair_procedures || null, vitamins || null, notes || null,
        record_id || null, startDateValue, endDateValue,
      ]
    );
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.query(
        `INSERT INTO home_care_items
           (prescription_id, time_of_day, category, product_name, instructions, sort_order, days_of_week)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, it.time_of_day, it.category, it.product_name, it.instructions || null, i, normalizeDays(it.days_of_week)]
      );
    }
    if (client_id) sendPrescriptionPush(client_id, p.id);
    res.json({ id: p.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { client_id, face_procedures, body_procedures, hair_procedures, vitamins, notes, items = [], record_id, start_date, end_date } = req.body;
    const startDateValue = start_date || new Date().toISOString().slice(0, 10);
    const endDateValue   = end_date || null;
    function normalizeDays(raw) {
      if (!Array.isArray(raw)) return null;
      const cleaned = [...new Set(raw
        .map(n => parseInt(n, 10))
        .filter(n => Number.isInteger(n) && n >= 0 && n <= 6))]
        .sort((a, b) => a - b);
      // Empty or all 7 days = daily (NULL in DB)
      if (cleaned.length === 0 || cleaned.length === 7) return null;
      return cleaned;
    }
    const existing = await db.oneOrNone('SELECT id FROM home_care_prescriptions WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await db.query(
      `UPDATE home_care_prescriptions
          SET client_id=$1, face_procedures=$2, body_procedures=$3,
              hair_procedures=$4, vitamins=$5, notes=$6, record_id=$7,
              start_date=$8, end_date=$9, updated_at=NOW()
        WHERE id=$10`,
      [
        client_id || null, face_procedures || null, body_procedures || null,
        hair_procedures || null, vitamins || null, notes || null,
        record_id || null, startDateValue, endDateValue, req.params.id,
      ]
    );
    await db.query('DELETE FROM home_care_items WHERE prescription_id=$1', [req.params.id]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.query(
        `INSERT INTO home_care_items
           (prescription_id, time_of_day, category, product_name, instructions, sort_order, days_of_week)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.id, it.time_of_day, it.category, it.product_name, it.instructions || null, i, normalizeDays(it.days_of_week)]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM home_care_prescriptions WHERE id=$1 AND salon_id=$2', [req.params.id, req.user.salonId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Template Settings ─────────────────────────────────────────
router.get('/template-settings', auth, async (req, res) => {
  try {
    res.json(await db.oneOrNone(
      `SELECT template_logo_url, template_wm_url, template_accent_color, template_bg_color,
              template_text_color, template_logo_line1, template_logo_line2, template_subtitle,
              template_contact_phone, template_contact_web, template_contact_social
       FROM salons WHERE id=$1`, [req.user.salonId]
    ) || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/template-settings', auth, async (req, res) => {
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

router.post('/template-settings/upload/:type', auth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const type = req.params.type;
    if (!['logo', 'wm'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const col = type === 'logo' ? 'template_logo_url' : 'template_wm_url';
    const url = `/uploads/${req.file.filename}`;
    try {
      await db.query(`UPDATE salons SET ${col}=$1 WHERE id=$2`, [url, req.user.salonId]);
      res.json({ ok: true, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

module.exports = router;
