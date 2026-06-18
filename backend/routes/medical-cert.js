// backend/routes/medical-cert.js
'use strict';

const router = require('express').Router();
const multer = require('multer');
const cfg = require('../config');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { createLogger } = require('../logger');
const { buildDefaults } = require('../services/medical-cert-defaults');
const { fillCertificate } = require('../services/medical-cert-pdf');
const tpl = require('../services/medical-cert-template');
const { splitAmount, splitDateParts, splitDoc, sanitizeUpper } = require('../services/medical-cert-layout');

const logger = createLogger('MedicalCert');
const adminOnly = [auth, requireRole('owner', 'admin')];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// salon_id текущего пользователя (JWT-пейлоад использует camelCase salonId)
function salonOf(req) { return req.user.salonId; }

// GET defaults — автозаполняемые поля
router.get('/defaults', adminOnly, async (req, res) => {
  try {
    const clientId = req.query.clientId ? Number(req.query.clientId) : null;
    const year = Number(req.query.year) || new Date().getFullYear();
    const d = await buildDefaults({ db, clinic: cfg.MEDICAL_CERT_CLINIC, salonId: salonOf(req), clientId, year });
    res.json(d);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'defaults_failed' }); }
});

// Преобразование плоских значений формы в значения полей координат
function mapValues(body) {
  const v = {};
  const set = (k, val) => { if (val !== undefined && val !== null && val !== '') v[k] = val; };
  // Дата → отдельные блоки <prefix>_dd / _mm / _yyyy (каждый позиционируется отдельно).
  const setDate = (prefix, raw) => {
    const p = splitDateParts(raw);
    if (p) { v[prefix + '_dd'] = p.dd; v[prefix + '_mm'] = p.mm; v[prefix + '_yyyy'] = p.yyyy; }
  };
  // Серия и номер → блоки <serie>1/2 (серия 2+2) и <num>1/2 (номер 3+3).
  const setDoc = (serieKey, numKey, raw) => {
    const d = splitDoc(raw);
    if (!d) return;
    if (d.serie1) v[serieKey + '1'] = d.serie1;
    if (d.serie2) v[serieKey + '2'] = d.serie2;
    if (d.number1) v[numKey + '1'] = d.number1;
    if (d.number2) v[numKey + '2'] = d.number2;
  };

  set('cert_number', body.cert_number);
  set('correction_number', body.correction_number);
  set('report_year', body.report_year);
  set('org_name', body.org_name);
  if (body.org_inn) set('org_inn', String(body.org_inn));
  if (body.org_kpp) set('org_kpp', String(body.org_kpp));

  set('payer_last', sanitizeUpper(body.payer_last));
  set('payer_first', sanitizeUpper(body.payer_first));
  set('payer_middle', sanitizeUpper(body.payer_middle));
  if (body.payer_inn) set('payer_inn', String(body.payer_inn));
  setDate('payer_birthdate', body.payer_birthdate);
  if (body.doc_type_code) set('doc_type_code', String(body.doc_type_code));
  setDoc('doc_serie', 'doc_number', body.doc_serie_number);
  setDate('doc_issue_date', body.doc_issue_date);
  set('payer_is_patient', body.payer_is_patient === '1' || body.payer_is_patient === true ? '1' : '0');

  const a1 = splitAmount(body.amount1); if (a1) { v.amount1_rub = a1.rubles; v.amount1_kop = a1.kopecks; }
  const a2 = splitAmount(body.amount2); if (a2) { v.amount2_rub = a2.rubles; v.amount2_kop = a2.kopecks; }

  set('signer_last', sanitizeUpper(body.signer_last));
  set('signer_first', sanitizeUpper(body.signer_first));
  set('signer_middle', sanitizeUpper(body.signer_middle));
  setDate('sign_date', body.sign_date);
  set('pages_count', body.payer_is_patient === '1' ? '1' : '2');

  // Страница 2 — только если плательщик ≠ пациент
  if (body.payer_is_patient !== '1') {
    set('patient_last', sanitizeUpper(body.patient_last));
    set('patient_first', sanitizeUpper(body.patient_first));
    set('patient_middle', sanitizeUpper(body.patient_middle));
    if (body.patient_inn) set('patient_inn', String(body.patient_inn));
    setDate('patient_birthdate', body.patient_birthdate);
    if (body.patient_doc_type) set('patient_doc_type', String(body.patient_doc_type));
    setDoc('patient_serie', 'patient_number', body.patient_doc_serie);
    setDate('patient_doc_date', body.patient_doc_date);
  }
  return v;
}

// POST generate — вернуть PDF
router.post('/generate', adminOnly, async (req, res) => {
  try {
    const active = await tpl.getActiveTemplateForFill(salonOf(req));
    if (!active) return res.status(409).json({ error: 'no_active_template' });
    const values = mapValues(req.body || {});
    const pdf = await fillCertificate({ blank: active.blank, coords: active.coords, values });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="medical-cert.pdf"`);
    res.send(pdf);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'generate_failed' }); }
});

// GET активный шаблон (метаданные + URL)
router.get('/template', adminOnly, async (req, res) => {
  try { res.json((await tpl.getActiveTemplateMeta(salonOf(req))) || {}); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'template_meta_failed' }); }
});

// POST загрузка нового бланка
router.post('/template', adminOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'pdf_only' });
    const r = await tpl.uploadTemplate(salonOf(req), req.file.buffer, req.file.originalname);
    res.json(r);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'upload_failed' }); }
});

// GET сырой PDF активного бланка — same-origin прокси для pdf.js.
// Браузерный CSP (connect-src 'self') и отсутствие CORS у S3 не дают тянуть
// presigned-URL напрямую из браузера; отдаём байты с того же origin.
router.get('/template/blank', adminOnly, async (req, res) => {
  try {
    const active = await tpl.getActiveTemplateForFill(salonOf(req));
    if (!active) return res.status(409).json({ error: 'no_active_template' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.send(active.blank);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'blank_failed' }); }
});

// GET/PUT координаты
router.get('/template/coords', adminOnly, async (req, res) => {
  try { res.json(await tpl.getCoords(salonOf(req))); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'coords_get_failed' }); }
});

router.put('/template/coords', adminOnly, async (req, res) => {
  try { await tpl.saveCoords(salonOf(req), req.body); res.json({ ok: true }); }
  catch (e) { logger.error(e.message); res.status(e.message === 'NO_ACTIVE_TEMPLATE' ? 409 : 500).json({ error: 'coords_save_failed' }); }
});

// ── Заявки на справки (самозаявка с сайта) ──────────────────────
const { computeYearAmount } = require('../services/cert-request');

const ALLOWED_STATUS = ['new', 'in_progress', 'done', 'rejected'];

// Список заявок салона (+ счётчик новых).
router.get('/requests', adminOnly, async (req, res) => {
  try {
    const status = ALLOWED_STATUS.includes(req.query.status) ? req.query.status : null;
    const rows = await db.any(
      `SELECT id, status, report_year, payer_is_patient,
              payer_last, payer_first, payer_middle, payer_phone,
              patient_last, patient_first, patient_phone,
              matched_client_id, computed_amount, created_at
         FROM cert_requests
        WHERE salon_id=$1 ${status ? 'AND status=$2' : ''}
        ORDER BY created_at DESC`,
      status ? [salonOf(req), status] : [salonOf(req)]);
    const newCount = await db.one(
      `SELECT COUNT(*)::int AS n FROM cert_requests WHERE salon_id=$1 AND status='new'`, [salonOf(req)]);
    res.json({ items: rows, newCount: newCount.n });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'requests_list_failed' }); }
});

// Полная заявка.
router.get('/requests/:id', adminOnly, async (req, res) => {
  try {
    const r = await db.oneOrNone('SELECT * FROM cert_requests WHERE id=$1 AND salon_id=$2', [Number(req.params.id), salonOf(req)]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json(r);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'request_get_failed' }); }
});

// Смена статуса.
router.put('/requests/:id/status', adminOnly, async (req, res) => {
  try {
    const status = req.body && req.body.status;
    if (!ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: 'bad_status' });
    const r = await db.oneOrNone(
      `UPDATE cert_requests SET status=$1, updated_at=now() WHERE id=$2 AND salon_id=$3 RETURNING id`,
      [status, Number(req.params.id), salonOf(req)]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'status_failed' }); }
});

// Ручная привязка клиента + пересчёт суммы.
router.put('/requests/:id/match', adminOnly, async (req, res) => {
  try {
    const clientId = req.body && req.body.clientId ? Number(req.body.clientId) : null;
    const r = await db.oneOrNone('SELECT id, report_year FROM cert_requests WHERE id=$1 AND salon_id=$2', [Number(req.params.id), salonOf(req)]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (clientId) {
      const c = await db.oneOrNone('SELECT 1 FROM clients WHERE id=$1 AND salon_id=$2', [clientId, salonOf(req)]);
      if (!c) return res.status(400).json({ error: 'bad_client' });
    }
    const amount = await computeYearAmount({ db, salonId: salonOf(req), clientId, year: r.report_year });
    await db.query(`UPDATE cert_requests SET matched_client_id=$1, computed_amount=$2, updated_at=now() WHERE id=$3`,
      [clientId, amount, r.id]);
    res.json({ ok: true, computed_amount: amount });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'match_failed' }); }
});

// Предзаполнение генератора справки из заявки (значения в ключах формы генератора).
router.get('/requests/:id/prefill', adminOnly, async (req, res) => {
  try {
    const r = await db.oneOrNone('SELECT * FROM cert_requests WHERE id=$1 AND salon_id=$2', [Number(req.params.id), salonOf(req)]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    const d = (x) => { if (!x) return ''; const y=x.getFullYear(), m=String(x.getMonth()+1).padStart(2,'0'), day=String(x.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; };
    let clientName = '';
    if (r.matched_client_id) {
      const c = await db.oneOrNone('SELECT name FROM clients WHERE id=$1 AND salon_id=$2', [r.matched_client_id, salonOf(req)]);
      clientName = c ? c.name : '';
    }
    res.json({
      clientId: r.matched_client_id || null,
      clientName,
      report_year: String(r.report_year),
      payer_is_patient: r.payer_is_patient ? '1' : '0',
      payer_last: r.payer_last || '', payer_first: r.payer_first || '', payer_middle: r.payer_middle || '',
      payer_inn: r.payer_inn || '', payer_birthdate: d(r.payer_birthdate),
      doc_type_code: r.payer_doc_type_code || '', doc_serie_number: r.payer_doc_serie_number || '', doc_issue_date: d(r.payer_doc_issue_date),
      patient_last: r.patient_last || '', patient_first: r.patient_first || '', patient_middle: r.patient_middle || '',
      patient_inn: r.patient_inn || '', patient_birthdate: d(r.patient_birthdate),
      patient_doc_type: r.patient_doc_type_code || '', patient_doc_serie: r.patient_doc_serie_number || '', patient_doc_date: d(r.patient_doc_issue_date),
      amount1: r.computed_amount != null ? String(r.computed_amount) : '',
    });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'prefill_failed' }); }
});

module.exports = router;
