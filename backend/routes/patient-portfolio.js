'use strict';
const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const config = require('../config');
const svc = require('../services/patient-portfolio');
const s3 = require('../services/s3');
const { createLogger } = require('../logger');
const logger = createLogger('PatientPortfolio');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Unsupported file type'), ok);
  },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sid = (req) => req.user.salonId;
const uid = (req) => req.user.userId;

async function loadVisit(visitId, salonId) {
  const v = await db.oneOrNone(
    `SELECT * FROM case_visits WHERE id=$1 AND salon_id=$2`, [visitId, salonId]);
  if (!v) { const e = new Error('Not found'); e.statusCode = 404; throw e; }
  return v;
}
async function loadPhoto(photoId, salonId) {
  const p = await db.oneOrNone(
    `SELECT * FROM case_photos WHERE id=$1 AND salon_id=$2`, [photoId, salonId]);
  if (!p) { const e = new Error('Not found'); e.statusCode = 404; throw e; }
  return p;
}

// ─── COURSES ──────────────────────────────────────────────────────
router.get('/clients/:clientId/courses', wrap(async (req, res) => {
  const rows = await db.any(`
    SELECT c.*,
           COALESCE(json_agg(
             json_build_object('id', v.id, 'visit_date', v.visit_date)
             ORDER BY v.visit_date DESC
           ) FILTER (WHERE v.id IS NOT NULL), '[]'::json) AS visits
    FROM case_courses c
    LEFT JOIN case_visits v ON v.course_id = c.id
    WHERE c.salon_id=$1 AND c.client_id=$2
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `, [sid(req), req.params.clientId]);
  res.json(rows);
}));

router.post('/courses', wrap(async (req, res) => {
  const { client_id, title, description } = req.body;
  if (!client_id || !title) { res.status(400).json({ error: 'client_id and title required' }); return; }
  const row = await db.one(`
    INSERT INTO case_courses (salon_id, client_id, title, description, created_by)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [sid(req), client_id, title, description || null, uid(req)]);
  res.status(201).json(row);
}));

router.put('/courses/:id', wrap(async (req, res) => {
  const c = await db.oneOrNone(`SELECT * FROM case_courses WHERE id=$1 AND salon_id=$2`, [req.params.id, sid(req)]);
  if (!c) { res.status(404).end(); return; }
  svc.assertCanMutate(req.user, c.created_by);
  const { title, description } = req.body;
  const row = await db.one(`
    UPDATE case_courses SET title=COALESCE($1,title), description=COALESCE($2,description), updated_at=NOW()
    WHERE id=$3 RETURNING *
  `, [title, description, req.params.id]);
  res.json(row);
}));

router.delete('/courses/:id', wrap(async (req, res) => {
  const c = await db.oneOrNone(`SELECT * FROM case_courses WHERE id=$1 AND salon_id=$2`, [req.params.id, sid(req)]);
  if (!c) { res.status(404).end(); return; }
  svc.assertCanMutate(req.user, c.created_by);
  await db.query(`DELETE FROM case_courses WHERE id=$1`, [req.params.id]);
  res.status(204).end();
}));

// ─── VISITS (cases) ───────────────────────────────────────────────
router.get('/clients/:clientId/cases', wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const before = req.query.before;
  const params = [sid(req), req.params.clientId];
  // case_courses тоже имеет salon_id/client_id — без префикса v. PG ругается ambiguous.
  let where = `v.salon_id=$1 AND v.client_id=$2`;
  if (before && /^\d{4}-\d{2}-\d{2}$/.test(before)) {
    params.push(before); where += ` AND v.visit_date < $3::date`;
  }
  params.push(limit);
  const rows = await db.any(`
    SELECT v.*, u.name AS specialist_name,
           c.title AS course_title,
           (SELECT COUNT(*)::int FROM case_photos p WHERE p.case_visit_id = v.id) AS photos_count,
           (SELECT COUNT(*)::int FROM case_comments cm WHERE cm.case_visit_id = v.id) AS comments_count
    FROM case_visits v
    LEFT JOIN users u ON u.id = v.specialist_user_id
    LEFT JOIN case_courses c ON c.id = v.course_id
    WHERE ${where}
    ORDER BY v.visit_date DESC, v.id DESC
    LIMIT $${params.length}
  `, params);

  for (const v of rows) {
    const photos = await db.any(
      `SELECT id, stage, s3_key_thumb FROM case_photos WHERE case_visit_id=$1`, [v.id]);
    const pick = svc.pickThumbForCard(photos);
    v.preview_url = pick ? await s3.presignGet(pick.s3_key_thumb) : null;
  }
  res.json(rows);
}));

router.get('/visits/:id', wrap(async (req, res) => {
  const v = await loadVisit(req.params.id, sid(req));
  const photos = await db.any(`
    SELECT id, stage, s3_key_thumb, s3_key_medium, width, height, sort_order, uploaded_by, uploaded_at
    FROM case_photos WHERE case_visit_id=$1
    ORDER BY stage, sort_order, id
  `, [v.id]);
  for (const p of photos) {
    p.url_thumb  = await s3.presignGet(p.s3_key_thumb);
    p.url_medium = await s3.presignGet(p.s3_key_medium);
  }
  const comments = await db.any(`
    SELECT cm.*, u.name AS author_name
    FROM case_comments cm LEFT JOIN users u ON u.id = cm.author_user_id
    WHERE cm.case_visit_id=$1 ORDER BY cm.created_at
  `, [v.id]);
  res.json({ ...v, photos, comments });
}));

router.post('/visits', wrap(async (req, res) => {
  const { client_id, record_id, course_id, notes } = req.body;
  if (!client_id) { res.status(400).json({ error: 'client_id required' }); return; }
  // Идемпотентность: если record_id уже занят этим салоном — вернуть существующий
  if (record_id) {
    const ex = await db.oneOrNone(
      `SELECT * FROM case_visits WHERE salon_id=$1 AND record_id=$2`, [sid(req), record_id]);
    if (ex) { res.json(ex); return; }
  }
  // Дата визита: из records (с салон-скоупом, чтобы не утянуть чужой record) либо сегодня
  let visitDate;
  if (record_id) {
    const r = await db.oneOrNone(
      `SELECT COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date) AS d
       FROM records WHERE id=$1 AND salon_id=$2`,
      [record_id, sid(req)]);
    visitDate = r?.d || new Date().toISOString().slice(0, 10);
  } else {
    visitDate = new Date().toISOString().slice(0, 10);
  }
  const row = await db.one(`
    INSERT INTO case_visits (salon_id, client_id, record_id, course_id, specialist_user_id, visit_date, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [sid(req), client_id, record_id || null, course_id || null, uid(req), visitDate, notes || null]);
  res.status(201).json(row);
}));

router.put('/visits/:id', wrap(async (req, res) => {
  const v = await loadVisit(req.params.id, sid(req));
  svc.assertCanMutate(req.user, v.specialist_user_id);
  const { notes, course_id } = req.body;
  const row = await db.one(`
    UPDATE case_visits SET notes=COALESCE($1,notes), course_id=$2, updated_at=NOW()
    WHERE id=$3 RETURNING *
  `, [notes, course_id || null, v.id]);
  res.json(row);
}));

router.delete('/visits/:id', wrap(async (req, res) => {
  const v = await loadVisit(req.params.id, sid(req));
  svc.assertCanMutate(req.user, v.specialist_user_id);
  const keys = await db.any(`
    SELECT s3_key_original, s3_key_medium, s3_key_thumb FROM case_photos WHERE case_visit_id=$1
  `, [v.id]);
  await db.query(`DELETE FROM case_visits WHERE id=$1`, [v.id]);
  const allKeys = keys.flatMap(k => [k.s3_key_original, k.s3_key_medium, k.s3_key_thumb]);
  if (allKeys.length) {
    try { await s3.deleteObjects(allKeys); }
    catch (e) {
      for (const k of allKeys) {
        await db.query(`INSERT INTO s3_orphans (bucket, s3_key, reason, last_error) VALUES ($1,$2,$3,$4)`,
          [config.S3_BUCKET, k, 'visit_delete', e.message]);
      }
    }
  }
  res.status(204).end();
}));

// ─── PHOTOS ───────────────────────────────────────────────────────
router.post('/visits/:id/photos', upload.array('files', 20), wrap(async (req, res) => {
  const v = await loadVisit(req.params.id, sid(req));
  const stage = svc.parseStage(req.body.stage);
  if (!req.files || req.files.length === 0) { res.status(400).json({ error: 'no files' }); return; }

  const results = [];
  for (const f of req.files) {
    const { rows: [{ id: photoId }] } = await db.query(`SELECT nextval('case_photos_id_seq') AS id`);
    let meta;
    try {
      meta = await svc.processAndUpload({
        salonId: sid(req), clientId: v.client_id, visitId: v.id, photoId,
        buffer: f.buffer, mimeType: f.mimetype,
      });
    } catch (e) {
      results.push({ ok: false, error: e.message });
      continue;
    }
    const row = await db.one(`
      INSERT INTO case_photos (id, salon_id, case_visit_id, stage,
        s3_key_original, s3_key_medium, s3_key_thumb,
        mime_type, size_bytes, width, height, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id
    `, [photoId, sid(req), v.id, stage,
        meta.s3_key_original, meta.s3_key_medium, meta.s3_key_thumb,
        meta.mime_type, meta.size_bytes, meta.width, meta.height, uid(req)]);
    const urls = {
      thumb:  await s3.presignGet(meta.s3_key_thumb),
      medium: await s3.presignGet(meta.s3_key_medium),
    };
    results.push({ ok: true, id: row.id, urls });
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length && results.every(r => !r.ok)) {
    res.status(502).json({ error: 'All uploads failed', results });
    return;
  }
  res.status(201).json({ uploaded: results });
}));

router.put('/photos/:id', wrap(async (req, res) => {
  const p = await loadPhoto(req.params.id, sid(req));
  svc.assertCanMutate(req.user, p.uploaded_by);
  const stage = req.body.stage !== undefined ? svc.parseStage(req.body.stage) : p.stage;
  const sort = req.body.sort_order !== undefined ? parseInt(req.body.sort_order, 10) : p.sort_order;
  const row = await db.one(`
    UPDATE case_photos SET stage=$1, sort_order=$2 WHERE id=$3 RETURNING *
  `, [stage, sort, p.id]);
  res.json(row);
}));

router.delete('/photos/:id', wrap(async (req, res) => {
  const p = await loadPhoto(req.params.id, sid(req));
  svc.assertCanMutate(req.user, p.uploaded_by);
  await db.query(`DELETE FROM case_photos WHERE id=$1`, [p.id]);
  const keys = [p.s3_key_original, p.s3_key_medium, p.s3_key_thumb];
  try { await s3.deleteObjects(keys); }
  catch (e) {
    for (const k of keys) {
      await db.query(`INSERT INTO s3_orphans (bucket, s3_key, reason, last_error) VALUES ($1,$2,$3,$4)`,
        [config.S3_BUCKET, k, 'photo_delete', e.message]);
    }
  }
  res.status(204).end();
}));

router.get('/photos/:id/url', wrap(async (req, res) => {
  const p = await loadPhoto(req.params.id, sid(req));
  const variant = req.query.variant || 'medium';
  const key = variant === 'original' ? p.s3_key_original
            : variant === 'medium'   ? p.s3_key_medium
            : variant === 'thumb'    ? p.s3_key_thumb
            : null;
  if (!key) { res.status(400).json({ error: 'invalid variant' }); return; }
  res.json({ url: await s3.presignGet(key), expires_in: config.S3_URL_TTL_SECONDS });
}));

// ─── COMMENTS ────────────────────────────────────────────────────
router.post('/visits/:id/comments', wrap(async (req, res) => {
  const v = await loadVisit(req.params.id, sid(req));
  const text = (req.body.text || '').trim();
  if (!text) { res.status(400).json({ error: 'text required' }); return; }
  const row = await db.one(`
    INSERT INTO case_comments (salon_id, case_visit_id, author_user_id, text)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [sid(req), v.id, uid(req), text]);
  res.status(201).json(row);
}));

router.delete('/comments/:id', wrap(async (req, res) => {
  const c = await db.oneOrNone(`SELECT * FROM case_comments WHERE id=$1 AND salon_id=$2`, [req.params.id, sid(req)]);
  if (!c) { res.status(404).end(); return; }
  svc.assertCanMutate(req.user, c.author_user_id);
  await db.query(`DELETE FROM case_comments WHERE id=$1`, [c.id]);
  res.status(204).end();
}));

// ─── SEARCH ──────────────────────────────────────────────────────
router.get('/search', wrap(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) { res.json([]); return; }
  const phone = svc.normalizePhone(q);
  const params = [sid(req), `%${q}%`];
  let where = `c.salon_id=$1 AND c.name ILIKE $2`;
  if (phone) { params.push(`%${phone}%`); where = `c.salon_id=$1 AND (c.name ILIKE $2 OR c.phone ILIKE $3)`; }
  const rows = await db.any(`
    SELECT c.id, c.name, c.phone,
           (SELECT COUNT(*)::int FROM case_visits v WHERE v.client_id=c.id AND v.salon_id=c.salon_id) AS cases_count,
           (SELECT MAX(v.visit_date) FROM case_visits v WHERE v.client_id=c.id AND v.salon_id=c.salon_id) AS last_visit
    FROM clients c
    WHERE ${where}
    ORDER BY last_visit DESC NULLS LAST, c.name
    LIMIT 50
  `, params);
  // Не фильтруем по cases_count > 0 — иначе новый пациент без кейсов не находится,
  // и тогда невозможно завести ему первый альбом через поиск.
  res.json(rows);
}));

// ─── ERROR HANDLER ───────────────────────────────────────────────
router.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  logger.error(`error: ${err.message}`);
  res.status(status).json({ error: err.message });
});

module.exports = router;
